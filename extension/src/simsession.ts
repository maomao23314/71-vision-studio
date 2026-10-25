/**
 * simsession.ts —— 仿真进程会话。
 *
 * 设计理念对照：
 *   · 代码松耦合   → 呈现层只依赖 types.ts 的 SimSession 接口，
 *                    完全不知道进程是怎么起的、协议长什么样
 *   · 模拟单片机   → 帧节奏由 IDE 驱动（--step），与批量跑（--frames N）
 *                    走的是同一套核心调度
 *
 * ★ 本文件有三个「写错就静默出错」的地方，都标了原因：
 *   1) spawn 的 env 是【替换】语义，必须展开 process.env
 *   2) stdout 的 data 事件【不按行边界】到达，必须缓冲
 *   3) postMessage 的返回值不代表 webview 收到，背压必须靠显式 ACK
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { LineSplitter, parseFrameLine, parsePpm, parseVariablesLine } from './protocol';
import type { FramePacket, SimSession, TimingInfo, VariableSnapshot } from './types';
import { defaultConfig, readConfig } from './projectconfig';
import { picArgsFromConfig, picArgsToArgv } from './simargs';

export interface SimSessionOptions {
    exePath: string;
    /** 工具链 bin 目录（会前置进子进程 PATH） */
    toolchainBin?: string;
    /** 测试图集目录（透传给 --pic） */
    picDir?: string;
    /** 帧图像（PPM/P6）输出目录（透传给 --out，默认放系统临时目录） */
    frameOutDir?: string;
    /* ★ 这里【曾经】有一个 selected?: string[]，注释写着"透传给 --select"。
     *   实际上它从未被拼进 argv（picArgsToArgv 只产 --frame/--repeat/--ext/--pic），
     *   是一处「注释承诺了代码没做的事」。已删除。
     *
     *   ★ 为什么是"删选项"而不是"把 --select 接上"：
     *     后端确实实现了 --select 过滤（scut_headless_main.c 的 var_selected），
     *     但它是【命令行参数】—— 一旦真的传了，用户在面板里改勾选就必须
     *     重启进程才生效。而 README 承诺的是「勾选后不需要重新编译」。
     *     现在的做法（快照每帧全量发 + 宿主侧按勾选过滤）才是对的设计：
     *     勾选只影响显示，与进程无关。所以修的是插件侧的假承诺，
     *     后端的 --select 作为通用能力保留（CI / 命令行仍可用）。 */
    /**
     * 工程根目录。
     *
     * ★ 用它读 scut_project.json 的 run / pic 段（每帧重复次数、
     *   起始帧、图集后缀）。这些是【运行期】参数，改完立即生效。
     *
     *   0.9.4 前它们存在 VS Code 设置里，而设置项根本没注册成功，
     *   于是"用户填了、插件读不到"。现在只有一个真值，就是工程 JSON。
     */
    projectRoot?: string;
}

/**
 * 帧图像的存放目录。
 *
 * ★ 不放工作区：帧是高频覆写的临时产物，放工作区会污染 git status，
 *   也会被文件监视器反复触发。放进系统临时目录最干净。
 */
function defaultFrameOutDir(): string {
    return path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'scut71_frames');
}

export class SimSessionImpl implements SimSession {
    readonly exePath: string;
    private readonly opts: SimSessionOptions;
    private child: ChildProcessWithoutNullStreams | undefined;
    private readonly splitter = new LineSplitter();
    private readonly stderrSplitter = new LineSplitter();

    private readonly frameCbs: Array<(f: FramePacket) => void> = [];
    private readonly varCbs: Array<(v: VariableSnapshot[]) => void> = [];
    private readonly logCbs: Array<(line: string) => void> = [];
    private readonly exitCbs: Array<(code: number | null) => void> = [];

    /* ★ 这里原先有一行孤立的注释："选中的变量名。变了要重启进程才能让
     *   --select 生效（见 setSelectedVariables）。" —— 它描述的是一个
     *   不存在的机制（既没有这个字段，setSelectedVariables 也是空函数）。
     *   已删除，避免读代码的人去找一个不存在的东西。 */

    /** 背压：只允许一帧在途。 */
    private inFlightFrame = -1;
    private pendingFrame: FramePacket | undefined;
    private ackWaiters: Array<() => void> = [];
    private ackTimer: NodeJS.Timeout | undefined;

    /**
     * 等待「下一帧抵达」的等待者。
     *
     * ★ 控制类命令（b<N> 测速、n/p/g 翻页）只往 stdin 写一行就返回，
     *   效果要等后端跑完那帧回传才可见。调用方若紧接着读缓存的计时，
     *   拿到的是【上一帧】的数字 —— 不报错，只是数字是错的。
     *   这里给一条"等一帧"的正规通道，免得调用方用 setTimeout 猜时间
     *   （猜时间等于把机器快慢变成正确性问题）。
     */
    private frameWaiters: Array<(f: FramePacket) => void> = [];

    private stopping = false;
    /** 上一次记日志时的可见性（只用于日志去重，不参与任何控制流）。 */
    private lastVisible = true;

    constructor(opts: SimSessionOptions) {
        this.opts = opts;
        this.exePath = opts.exePath;

    }

    get frameInFlight(): boolean {
        return this.inFlightFrame >= 0;
    }

    get running(): boolean {
        return this.child !== undefined && !this.stopping;
    }

    /* ---------------------------------------------------------------- 事件 */

    onFrame(cb: (f: FramePacket) => void): void {
        this.frameCbs.push(cb);
    }

    onVariables(cb: (v: VariableSnapshot[]) => void): void {
        this.varCbs.push(cb);
    }

    onLog(cb: (line: string) => void): void {
        this.logCbs.push(cb);
    }

    onExit(cb: (code: number | null) => void): void {
        this.exitCbs.push(cb);
    }

    private emitLog(line: string): void {
        for (const cb of this.logCbs) {
            cb(line);
        }
    }

    /* ------------------------------------------------------- 启动 / 停止 */

    /**
     * 启动仿真进程。
     *
     * 参数说明（与 scut_headless_main.c 的 parse_args 一一对应）：
     *   --json     机器可读协议
     *   --step     每帧后等 stdin 一行 —— 这是「单步」与「运行 N 帧」的实现基础
     *   --frames 0 表示不设上限；此时进程只在收到 EOF 或被杀时结束。
     *   --advance  每帧换下一张测试图（否则 120 帧跑的都是同一张图）
     *   --out      帧图像（PPM/P6）的落盘目录
     */
    async start(): Promise<void> {
        if (this.child) {
            this.emitLog('[会话] 进程已在运行，忽略重复的启动请求。');
            return;
        }
        if (!fs.existsSync(this.exePath)) {
            throw new Error(
                `找不到仿真程序：${this.exePath}\n`
                + '    下一步：先执行「SCUT-71: 编译仿真程序」，编译成功后再运行。',
            );
        }

        const outDir = this.opts.frameOutDir ?? defaultFrameOutDir();
        try {
            fs.mkdirSync(outDir, { recursive: true });
        } catch {
            /* 建不出来就让内核侧 mkdir 去处理，失败会有中文提示 */
        }

        // ------------------------------------------------------------------
        // 运行参数
        //
        // ★ 哪些来自【工程配置】而不是编译期契约（用户的诉求：
        //   "这种配置不应该丢进仿真环境里面吗？包括图像大小、图片格式、
        //     图集位置不应该都用UI吗？"）：
        //
        //       → 图集与重复次数是【运行期行为】：改完立即生效，不需要重新编译，
        //         因此不占用编译期契约头（.scut/gen/scut_config.h）。
        //
        //     图像宽高 SCUT_IMAGE_W/H
        //       → 这个【必须】留在编译期契约里。C 语言里数组大小是编译期常量，
        //         用户算法里到处是 `int left_line[SCUT_IMAGE_H]`，
        //         运行期改不了。硬把它做成设置项只会制造"改了没生效"的困惑。
        //         这是语言的硬约束，不是设计偷懒。
        // ------------------------------------------------------------------
        // ★ 0.9.4 起这些值都来自工程配置 scut_project.json，不再读 VS Code 设置。
        //   读不到工程配置时用默认值，让"没有 scut_project.json"也能跑起来。
        //
        // ★★ 图集参数的拼装已抽到 simargs.ts —— 因为「调试」入口需要同一组参数。
        //    这里只负责"会话侧独有的"运行模式参数（--json/--step/--frames/--out），
        //    图集与重复次数交给共享函数，两处不可能再拼出不同的值。
        const cfg = (() => {
            const root = this.opts.projectRoot;
            if (!root) {
                return defaultConfig();
            }
            const { config } = readConfig(root);
            return config ?? defaultConfig();
        })();

        const args = ['--json', '--step', '--frames', '0', '--out', outDir];
        // ★★ 不加 --advance（0.7.1 起）：图集推进完全走运行期协议。
        //   早期版本把"每帧换图"绑死在启动参数上，导致「运行」「下一张」
        //   「上一张」全是同一个动作，翻页还得重启进程。现在进程启动后
        //   永远停在当前图上，换图只通过 stdin 的 n/p/g 命令（见 writeLine）。
        args.push(...picArgsToArgv(picArgsFromConfig(cfg, this.opts.picDir)));

        this.splitter.push('');     // 复位缓冲（其实无需，但保证语义清晰）
        this.stopping = false;
        this.inFlightFrame = -1;
        this.pendingFrame = undefined;

        // ★ PATH 前置：让 scut_sim.exe 在同目录找不到 DLL 时，
        //   仍能从工具链 bin 里解析到 libc++/libunwind 之类的运行库。
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (this.opts.toolchainBin) {
            env.PATH = this.opts.toolchainBin + path.delimiter + (process.env.PATH ?? '');
        }

        this.emitLog(`[会话] 启动：${this.exePath} ${args.join(' ')}`);
        const child = spawn(this.exePath, args, {
            cwd: path.dirname(this.exePath),
            windowsHide: true,
            // ★★ env 是【替换】语义而不是合并。不展开 process.env 的话，
            //    子进程会拿不到 SystemRoot/PATH 等，Windows 上表现为
            //    启动即失败或行为诡异。这里必须展开。
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.child = child;

        child.stdout.on('data', (d: Buffer) => this.onStdout(d));
        child.stderr.on('data', (d: Buffer) => this.onStderr(d));

        child.on('error', (e: Error) => {
            this.emitLog(`[会话] 进程启动失败：${e.message}`);
        });

        child.on('close', (code: number | null) => {
            for (const line of this.splitter.flush()) {
                this.handleLine(line);
            }
            for (const line of this.stderrSplitter.flush()) {
                if (line.trim().length > 0) {
                    // 与 onStderr 同一规则：用户日志行不能加前缀（否则上层认不出）
                    this.emitLog(line.startsWith('[LOG] ') ? line : `[stderr] ${line}`);
                }
            }
            this.child = undefined;
            this.stopping = false;
            this.inFlightFrame = -1;
            this.pendingFrame = undefined;
            clearTimeout(this.ackTimer);
            this.ackTimer = undefined;
            for (const w of this.ackWaiters.splice(0)) {
                w();
            }
            this.emitLog(`[会话] 进程已退出（退出码 ${code ?? 'null'}）`);
            for (const cb of this.exitCbs) {
                cb(code);
            }
        });

        // 等待一小会儿确认进程没有立刻挂掉，好让上层给出准确提示。
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
    }

    /** 停止：先关 stdin（脚本侧 getchar 读 EOF 会自行退出），再兜底 kill。 */
    async stop(): Promise<void> {
        const child = this.child;
        if (!child) {
            return;
        }
        this.stopping = true;
        this.emitLog('[会话] 正在停止…');
        try {
            child.stdin.end();
        } catch {
            /* stdin 可能已关 */
        }
        // 给它 400 ms 优雅退出；核心读到 EOF 会 scut_request_quit()。
        const exited = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(false), 400);
            child.once('close', () => {
                clearTimeout(t);
                resolve(true);
            });
        });
        if (!exited) {
            this.emitLog('[会话] 进程未响应 EOF，强制结束。');
            try {
                child.kill();
            } catch {
                /* 已退出 */
            }
        }
        // 等 close 事件把状态清干净，避免上层立刻 start() 时看到残留。
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }

    /* ------------------------------------------------------------ 控制 */

    /**
     * 单步一帧：进程正卡在 stdin 等待这一行。
     *
     * ★ 协议语义（与后端 0.7.1 的 step 协议对应）：
     *     空行  = 重跑当前这张图（不加 --advance 时图集位置不变）
     *     "n"   = 下一张图
     *     "p"   = 上一张图
     *     "gN"  = 跳到第 N 张
     */
    step(): Promise<void> {
        this.writeLine('');
        return Promise.resolve();
    }

    /** 下一张图（进程不重启，算法状态保留）。 */
    nextPic(): Promise<void> {
        this.writeLine('n');
        return Promise.resolve();
    }

    /** 上一张图（进程不重启，算法状态保留）。 */
    prevPic(): Promise<void> {
        this.writeLine('p');
        return Promise.resolve();
    }

    /**
     * 跳到第 n 张图（协议 "g<N>"，进程不重启，算法状态保留）。
     *
     * ★ 与 step()/nextPic() 走同一条 stdin 通道，所以：
     *   · 进程不重启 → 算法的内部状态（环形缓冲、状态机、丢线计数）保留。
     *     这对"前后帧关联"的巡线算法是硬需求，也是当初把翻页从
     *     "重启进程"改成"发协议命令"的原因（见 nudgePic 的说明）。
     *   · 不需要仿真程序支持运行期改图集 —— 它只是换一张输入图。
     *
     * ★ 编号语义：n 是【图集里的编号】（0 起图集就是 0..count-1）。
     *   越界不用在这里钳：后端 scut_pic_load 自己会夹到合法区间，
     *   并把实际用的那张记进 s_pic_index（随后随帧 JSON 的 "pic" 字段报回来）。
     *   在插件侧再钳一次等于把同一套边界规则实现两遍 ——
     *   两边一旦有差别，就会出现"报的号与实际用的图不一致"。
     *
     * ★ 为什么要有钳位下限：
     *   负数对后端是无意义的（strtol 会得到负值，后端会夹成第一张），
     *   但发一个明显非法的值过去不如在这里就挡住 —— 它一定是调用方写错了。
     */
    gotoPic(n: number): Promise<void> {
        const idx = Math.max(0, Math.floor(n));
        this.writeLine('g' + idx);
        return Promise.resolve();
    }

    /**
     * 测速：当前这张图重复 N 次（协议 "b<N>"）。
     *
     * ★ 只跑【计时段】：后端收到 b<N> 后把 repeat 临时设为 N、
     *   跑一帧、再还原 —— 后处理（DRAW）与图集推进都不参与。
     *   进程不重启，算法状态保留。
     *
     * ★ 返回【测速那一帧】的数据，不是上一帧（一条真实缺陷的修复）：
     *   原先写完 stdin 就返回，调用方立刻读缓存 → 拿到测速【之前】那帧的
     *   数字，而用户正拿它做性能决策。现在内部等那帧回来再交出去；
     *   超时/进程退出返回 undefined。
     */
    async bench(n: number): Promise<FramePacket | undefined> {
        const waited = this.waitFrame();
        this.writeLine('b' + Math.max(1, Math.floor(n)));
        return waited;
    }

    /**
     * 向仿真进程的 stdin 写一行。
     *
     * ★ 为什么带参数而不是写死 '\n'（历史教训）：
     *   早期所有控制（单步/翻页/播放）都发 '\n'，而进程又带着 --advance，
     *   结果就是"点运行会自己跳页"—— 三个按钮一个动作，全是堆出来的重复。
     *   现在图集推进完全走协议：空行=重跑当前图，n/p/g=换图，各司其职。
     */
    private writeLine(line: string = ''): void {
        const child = this.child;
        if (!child || !child.stdin.writable) {
            return;
        }
        try {
            child.stdin.write(line + '\n');
        } catch (e) {
            this.emitLog(`[会话] 无法向仿真进程写入：${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /* ★ 这里原先有一个 setSelectedVariables(_names) 空函数，
     *   注释说"快照每帧全量发，宿主侧按勾选过滤 —— 这里无事可做"，
     *   但又声称"如果启动时带了 --select，则记录「需要重启才生效」"。
     *   后者是不存在的功能（既不记录、也没有 UI 提示），已删除。
     *
     *   现在勾选变化的真实路径是：
     *     simview.selectVariables()  → 更新 this.selected
     *                                → sendCatalogToAll() + sendSnapshot()
     *   也就是【纯宿主侧的显示过滤】，完全不碰仿真进程 —— 这正是
     *   README 承诺的"勾选后不需要重新编译"。
     *   SimSession 接口里的同名成员也一并删掉了（接口不该声明空实现）。 */



    /* --------------------------------------------------------- 数据处理 */

    private onStdout(chunk: Buffer): void {
        // ★ 必须用 splitter：data 事件按「字节到达」切，不按行切。
        const text = chunk.toString('utf8');
        for (const line of this.splitter.push(text)) {
            this.handleLine(line);
        }
    }

    private onStderr(chunk: Buffer): void {
        // 仿真进程的 stderr 上有两类内容：
        //   · 用户算法的 SCUT_Log 输出：行首是后端加的 `[LOG] ` 标记
        //   · 环境自身的中文提示（找不到图集等）
        // ★ 用户日志行必须【原样透传】：此前这里统一加 `[仿真] ` 前缀，
        //   把 `[LOG] ` 标记埋进了行中间，上层再也认不出它是不是用户日志
        //   （结果就是侧边栏日志区永远是空的，见 simview.pushLog 的说明）。
        const text = chunk.toString('utf8');
        for (const line of this.stderrSplitter.push(text)) {
            if (line.trim().length === 0) {
                continue;
            }
            this.emitLog(line.startsWith('[LOG] ') ? line : `[仿真] ${line}`);
        }
    }

    private handleLine(rawLine: string): void {
        const line = rawLine.trim();
        if (line.length === 0) {
            return;
        }

        // ★★ 帧行【必须】先于变量行判断（顺序是契约，0.8.0 的黑屏回归就栽在这）：
        //   0.8.0 起每帧 JSON 行内嵌了 "vars" 字段（变量随帧更新），
        //   于是帧行同时满足两种解析器。此前的顺序是"先 vars 后 frame"，
        //   结果帧行被 parseVariablesLine 抢走 → 走变量分支 return →
        //   【永远画不了帧】，用户看到的就是"图片全没了"。
        //   判据用字段区分：帧行有 "frame" 字段；独立变量行只有 "vars"。
        const frame = parseFrameLine(line);
        if (frame) {
            void this.handleFrame(frame);
            return;
        }

        // 独立变量行（--list-vars 的输出；会话内快照随帧走，不单独发）
        const vars = parseVariablesLine(line);
        if (vars) {
            const snap: VariableSnapshot[] = vars.map((v) => ({
                name: v.name,
                values: v.values.split(/\s+/).filter((s) => s.length > 0),
                truncated: v.truncated,
                total: v.total,
            }));
            for (const cb of this.varCbs) {
                cb(snap);
            }
            return;
        }

        // 都不是 → 当作人类可读输出
        this.emitLog(`[仿真] ${line}`);
    }

    private async handleFrame(frame: ReturnType<typeof parseFrameLine> & object): Promise<void> {
        const timing: TimingInfo = {
            processUs: frame.timing.processUs,
            drawUs: frame.timing.drawUs,
            frameUs: frame.timing.frameUs,
            processCycles: frame.timing.processCycles,
            cyclesValid: frame.timing.cyclesValid,
        };

        let rgb: Uint8Array | undefined;
        try {
            // ★ readFileSync 返回 Buffer（Uint8Array 的子类，可能共享 64KB 池 slab）。
            //   parsePpm 内部会 new Uint8Array(...) 拷成独立缓冲，
            //   这样 postMessage 才能走结构化克隆快路径。
            const buf = await fs.promises.readFile(frame.img);
            const img = parsePpm(new Uint8Array(buf));
            if (!img) {
                this.emitLog(`[会话] 第 ${frame.frame} 帧的 PPM 解析失败（文件：${frame.img}），已跳过。`);
            } else {
                rgb = img.rgb;
            }
        } catch (e) {
            this.emitLog(
                `[会话] 读不到第 ${frame.frame} 帧的图像：${frame.img}\n`
                + `    ${e instanceof Error ? e.message : String(e)}\n`
                + '    提示：帧是写到系统临时目录的，杀毒软件或清理工具可能删掉了它；'
                + '若反复出现，请检查 --out 目录是否可写。',
            );
        }

        let rgb2: Uint8Array | undefined;
        if (frame.img2) {
            try {
                const buf2 = await fs.promises.readFile(frame.img2);
                const img2 = parsePpm(new Uint8Array(buf2));
                if (img2) {
                    rgb2 = img2.rgb;
                } else {
                    this.emitLog(`[会话] 第 ${frame.frame} 帧的图片2 PPM 解析失败（文件：${frame.img2}），已跳过。`);
                }
            } catch (e) {
                // ★ 图片2 是附加信息：读不到就只当没有它，不打断这一帧，
                //   更不卡住 ACK —— 否则"少了一张附加图"会变成"整个面板停住"。
                this.emitLog(
                    `[会话] 读不到第 ${frame.frame} 帧的图片2：${frame.img2}\n`
                    + `    ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }

                // ★★ 每帧变量快照（后端 0.7.1 起内嵌在帧 JSON 里）：
        //   以前快照只在进程退出时发一次 → 面板数值永远停在会话启动那一刻，
        //   "只有点测速（重启进程）变量才更新"就是这个时序 bug。
        //   现在每收一帧就喂一次面板，数值与画面同步。
        if (frame.vars && frame.vars.length > 0) {
            const snap: VariableSnapshot[] = frame.vars.map((v) => ({
                name: v.name,
                values: v.values.split(/\s+/).filter((s) => s.length > 0),
                truncated: v.truncated,
                total: v.total,
            }));
            for (const cb of this.varCbs) {
                cb(snap);
            }
        }
if (!rgb) {
            // 解析失败也要继续推进协议，否则会话会卡死在等待 ACK 上
            this.pushOrDrop({
                index: frame.frame,
                width: frame.w,
                height: frame.h,
                rgb: new Uint8Array(frame.w * frame.h * 3),
                rgb2,
                timing,
                pic: frame.pic,
                loadError: frame.loadError,
            });
            return;
        }

        this.pushOrDrop({
            index: frame.frame,
            width: frame.w || (rgb.length > 0 ? rgb.length / 3 : 0),
            height: frame.h,
            rgb,
            rgb2,
            timing,
            pic: frame.pic,
            loadError: frame.loadError,
        });
    }

    /**
     * 背压核心。
     *
     * ★ 规则（背压 / 帧生命周期）：
     *   · 同一时刻只允许一帧在途；
     *   · 宁可【丢帧】也不要排队 —— 排队就是无界内存增长，
     *     而且仿真帧是派生状态，丢掉的下一帧会覆盖它。
     */
    private pushOrDrop(packet: FramePacket): void {
        if (this.inFlightFrame >= 0) {
            // 已有帧在途 → 丢掉【旧的】待发帧，保留最新的。
            // 为什么丢旧不丢新：旧帧的信息已经被新帧覆盖，留着没有意义。
            this.pendingFrame = packet;
            return;
        }
        this.sendFrame(packet);
    }

    private sendFrame(packet: FramePacket): void {
        this.inFlightFrame = packet.index;
        for (const cb of this.frameCbs) {
            cb(packet);
        }
        // 通知等待者：一帧已抵达（见 frameWaiters 的说明）。
        // ★ 放在帧回调【之后】：等待者要看到的是"这一帧已经完整处理过"，
        //   包括 pushSnapshot 一类由帧回调触发的状态更新。
        for (const w of this.frameWaiters.splice(0)) {
            w(packet);
        }
        // 保险丝：webview 万一没回 ACK（崩了/被禁用），2 秒后自动放行，
        // 否则整个会话会永久卡住。这是「宁可丢帧也不要卡死」的落实。
        clearTimeout(this.ackTimer);
        this.ackTimer = setTimeout(() => {
            if (this.inFlightFrame >= 0) {
                this.emitLog(`[会话] 第 ${this.inFlightFrame} 帧未收到显示确认，超时放行（丢弃该帧的画面）。`);
                this.completeAck();
            }
        }, 2000);
    }

    /**
     * 等下一帧抵达（供控制类命令读"命令生效后"的结果）。
     *
     * 顺序不能反：先写命令、再等帧 —— bench() 内部已经是这个顺序。
     * 超时返回 undefined（不抛异常）：这是诊断路径，拿不到数据显示
     * 一条中文说明即可，不该让整个命令失败。
     */
    waitFrame(timeoutMs = 8000): Promise<FramePacket | undefined> {
        return new Promise<FramePacket | undefined>((resolve) => {
            let done = false;
            const finish = (f: FramePacket | undefined): void => {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timer);
                resolve(f);
            };
            const timer = setTimeout(() => {
                const i = this.frameWaiters.indexOf(waiter);
                if (i >= 0) {
                    this.frameWaiters.splice(i, 1);
                }
                finish(undefined);
            }, timeoutMs);
            const waiter = (f: FramePacket): void => { finish(f); };
            this.frameWaiters.push(waiter);
        });
    }

    /** 呈现层确认收到并已显示第 index 帧。 */
    ack(index: number): void {
        if (index !== this.inFlightFrame) {
            // 迟到的 ACK（比如超时后才到）直接忽略，不要去动当前在途帧。
            return;
        }
        this.completeAck();
    }

    private completeAck(): void {
        clearTimeout(this.ackTimer);
        this.ackTimer = undefined;
        this.inFlightFrame = -1;

        for (const w of this.ackWaiters.splice(0)) {
            w();
        }

        if (this.pendingFrame) {
            const next = this.pendingFrame;
            this.pendingFrame = undefined;
            this.sendFrame(next);
            return;
        }

        // ★ 视图隐藏时不放行下一帧：
        //   仿真进程会停在 getchar() 上等我们写那一行。这正是「暂停产帧」
        //   的落地方式 —— 不是我们在宿主侧丢帧，而是根本不让进程往下跑，
        //   这样切回来时看到的一定是【最新】状态，而不是一堆过期帧。
        //
        // ★ 这里原先还有一段"连续运行：放行下一帧"（读 pendingSteps）。
        //   那是「运行 N 帧」用的，0.10.6 已随该功能一起删除：
        //   现在一帧就是一帧，只由用户点「下一张 / 上一张 / 测速」驱动。
        //   "隐藏时不放行"这件事不需要额外语句 —— 不写 stdin 就是不跑，
        //   所以这里只是收尾（没有 else 分支要写）。
    }

    /**
     * 视图可见性变化时调用 —— 只记一条日志，【不控制任何东西】。
     *
     * ★★ 这个函数原来叫 setProductionPaused(bool)，并且存了一个
     *    productionPaused 字段。那个名字和字段都是骗人的：
     *    全文件没有任何地方读它，真正"暂停产帧"的机制在别处 ——
     *    视图不可见时宿主不 ACK，completeAck 就不会往下走，
     *    仿真进程停在 getchar() 上。也就是说：删掉这个字段，行为一模一样。
     *
     *    留着它最坏的地方不是多几行代码，而是它让读代码的人以为
     *    "暂停是靠这个布尔量实现的"，于是去改它、去信它。
     *    这正是本项目反复删的那类"配了没用"的开关。
     *
     *    现在只保留它唯一真实的产出：一条诊断日志（切走切回时能对上时间点）。
     *    ★ 去重状态仍要留一个，但它只服务于"别把同一行日志刷屏"，
     *      不参与任何控制流 —— 所以名字就叫 lastVisible，不叫 paused。
     */
    noteVisibility(anyVisible: boolean): void {
        if (this.lastVisible === anyVisible) {
            return;
        }
        this.lastVisible = anyVisible;
        this.emitLog(anyVisible
            ? '[会话] 视图恢复可见，继续产帧。'
            : '[会话] 视图不可见，已暂停产帧（进程停在等待输入上）。');
    }

    /* ★ 这里原先有一个 static async listVariables()，注释写着"供变量面板
     *   初始化"，但它是【真的死代码】，已删除。判据：
     *     · 全树零调用点；也无人依赖它的返回值。
     *     · 它声称的职责已有人做、且更完整：build.ts 的
     *       augmentManifestFromRuntime() 用 spawnSync 起同一个
     *       `--list-vars --json`，还额外做了"运行期注册表补全编译期清单"。
     *     · 无任何测试覆盖。
     *   留着就是"同一件事两份实现"：将来协议一改，build.ts 那份会报错，
     *   这份没人调用、没测试，属于静默腐烂。 */
}

/* ★ 这里原先还有一个 export prettyProtocolLine(line) —— 它是
 *   repairLooseJson 的一行包装，注释写着"供输出面板显示"。
 *   已删除：全树零调用点，输出面板从来没有调用过它。
 *   要显示修复后的协议行，直接用 protocol.ts 的 repairLooseJson 即可 ——
 *   多这一层包装只会让人以为"显示"走了一条专门的路径。 */
