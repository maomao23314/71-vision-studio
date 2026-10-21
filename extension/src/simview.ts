/**
 * simview.ts —— 侧边栏仿真视图（WebviewViewProvider）。
 *
 * 设计理念对照：
 *   · 模拟单片机   → 这里是「屏幕」：核心把一帧灰度图交出来，我们只负责画
 *   · 上手即用     → 图像 + 计时 + 变量勾选都在一个面板里，不用来回切
 *   · 适应任意代码 → 变量列表【完全】来自自动发现的结果，插件不硬编码任何符号名
 *
 * ★ 本文件严格遵守 VS Code Webview 的三条实测约束：
 *   1) registerWebviewViewProvider 的选项【只】接受 retainContextWhenHidden，
 *      enableScripts / localResourceRoots 必须写在 resolveWebviewView 里。
 *      我们干脆不传第三个参数，改用 getState/setState 做持久化。
 *   2) 帧数据以 Uint8Array 直接 postMessage，不走 base64。
 *   3) postMessage 的返回值不代表 webview 收到了，所以背压靠 webview 显式 ACK。
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { SimSessionImpl } from './simsession';
import { getSimLogChannel } from './extension';
import type { FramePacket, VariableManifest, VariableSnapshot, WatchedVariable } from './types';
import { defaultConfig, readConfig } from './projectconfig';

/** 视图 id（必须与 package.json 的 contributes.views 一致）。 */
export const SIM_VIEW_ID = 'scut71.simview';

/* ★ 这里原先有一个 `type ViewKind = 'sim' | 'vars'`（用于"两个视图共用
 *   一份脚本，靠 kind 分辨收不收帧"）。现在【只注册了一个视图】，
 *   于是 'vars' 那条分支永远不可能命中 —— 已整条删除：
 *     · AttachedView.kind 字段、resolveWebviewView 里的三元判断、
 *     · html() 的 kind 形参与 <body data-kind>、onFrame 的 v.kind !== 'sim' 判据、
 *     · 以及 media/simview.js 里读 data-kind 的那行（那个 KIND 变量零引用）。
 *   留着的代价是让读代码的人去找"第二个视图在哪"。
 *   将来若真加第二个视图，请一并把"谁收帧"这件事重新设计，
 *   而不是靠恢复这个字段。 */

interface AttachedView {
    /** 把消息写进这个 webview */
    post: (msg: unknown) => void;
    /** webview 当前是否可见（隐藏时不产帧） */
    visible: () => boolean;
}

export interface SimViewDeps {
    /** 当前可执行文件路径（构建产物）。未构建时返回 undefined。 */
    getExePath(): string | undefined;
    /** 工具链 bin 目录（子进程 PATH 前置用）。未就绪时返回 undefined。 */
    getToolchainBin(): string | undefined;
    /** 用户勾选的图集目录（工程配置的 pic.dir）。未设置时返回 undefined。 */
    getPicDir(): string | undefined;
    /** 工程根目录。仿真进程靠它读 scut_project.json 的运行期参数。 */
    projectRoot(): string | undefined;
    /** 环境日志（写进侧边栏日志折叠区）。 */
    log(line: string): void;
}
export class SimViewProvider implements vscode.WebviewViewProvider {
    extensionUri: vscode.Uri;
    deps: SimViewDeps;
    private views = new Set<AttachedView>();
    private session: SimSessionImpl | undefined;
    private manifest: VariableManifest | undefined;
    private selected = new Set<string>();
    private lastExePath: string | undefined;
    /** 变量快照缓存：webview 重建（切走再切回）时立刻把面板填上，不用等下一帧。 */
    private lastSnapshot: VariableSnapshot[] = [];
    private lastTiming: FramePacket['timing'] | undefined;
    private lastFrameIndex = 0;
    /** 上一条加载失败的原因（通知去重用）。 */
    private lastLoadError: string | undefined;
    /** 上次弹加载失败通知的时间戳（节流用，毫秒）。 */
    private lastLoadErrorAt = 0;
    private disposables: vscode.Disposable[] = [];

    constructor(extensionUri: vscode.Uri, deps: SimViewDeps) {
        this.extensionUri = extensionUri;
        this.deps = deps;
    }

    dispose(): void {
        for (const d of this.disposables.splice(0)) {
            d.dispose();
        }
        this.views.clear();
        void this.stop();
    }

    /* --------------------------------------------------------- 视图注册 */

    /**
     * 侧边栏视图被打开时由 VS Code 调用。
     *
     * ★ 坑 1：enableScripts / localResourceRoots 只能在这里设。
     *   写在 registerWebviewViewProvider 的第三个参数上是类型错误
     *   （那里的内联类型只有 retainContextWhenHidden 一个字段）。
     * ★ 坑 2：不用 retainContextWhenHidden（默认 false）—— webview 文档
     *   隐藏时销毁、重现时重建，所以状态用 getState/setState 持久化。
     */
    public resolveWebviewView(
        view: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        view.webview.html = this.html(view.webview);
        const attached: AttachedView = {
            post: (msg: unknown) => {
                void view.webview.postMessage(msg);
            },
            visible: () => view.visible,
        };
        this.views.add(attached);
        // 不可见即停止产帧（停在我们这侧：不放行下一帧），可见即恢复。
        const visSub = view.onDidChangeVisibility(() => {
            this.deps.log(`[视图] 可见性变化：${view.visible ? '可见' : '隐藏'}`);
            this.updateProduction();
            if (view.visible) {
                // webview 文档是新建的，什么都不记得 → 补齐上下文
                this.sendCatalog(attached);
                this.sendSnapshot();
                this.sendStatus();
            }
        });
        // 被用户彻底隐藏（右键取消勾选）会 dispose，摘掉集合避免推给死 webview
        const dispoSub = view.onDidDispose(() => {
            this.views.delete(attached);
            visSub.dispose();
            dispoSub.dispose();
            this.updateProduction();
        });
        const msgSub = view.webview.onDidReceiveMessage((raw: unknown) => {
            this.handleMessage(raw);
        });
        this.disposables.push(visSub, dispoSub, msgSub);
        // 恢复 webview 持久化的状态（勾选）
        const st = context.state as { selected?: unknown } | undefined;
        if (st && Array.isArray(st.selected)) {
            for (const n of st.selected) {
                if (typeof n === 'string') {
                    this.selected.add(n);
                }
            }
            this.deps.log(`[视图] 从持久化状态恢复 ${this.selected.size} 个勾选变量。`);
        }
        this.updateProduction();
    }

    /** 宿主收到每帧快照时调用：缓存 + 推给 webview。 */
    public pushSnapshot(snap: VariableSnapshot[]): void {
        this.lastSnapshot = snap;
        this.sendSnapshot();
    }

    /* ----------------------------------------------------------- 对外 API */

    /** 构建成功后调用：更新可执行文件路径与变量清单。 */
    public setBuildOutput(exePath: string | undefined, manifest: VariableManifest | undefined): void {
        if (exePath && exePath !== this.lastExePath) {
            this.lastExePath = exePath;
            // 换了二进制 → 旧会话必须结束（旧进程占着旧文件）
            void this.stop();
        }
        if (manifest) {
            this.manifest = manifest;
            // 首次拿到清单时，按生成器给的 defaultSelected 预勾选
            if (this.selected.size === 0) {
                for (const v of manifest.variables) {
                    if (v.defaultSelected) {
                        this.selected.add(v.name);
                    }
                }
            }
            this.deps.log(`[视图] 变量清单已更新：${manifest.count} 个变量。`);
        }
        for (const v of this.views) {
            this.sendCatalog(v);
        }
    }

    public getManifest(): VariableManifest | undefined {
        return this.manifest;
    }

    public getSelected(): string[] {
        return [...this.selected];
    }

    /**
     * 用户勾选变化。
     *
     * ★ 这里【只做宿主侧的显示过滤】，不通知仿真进程。
     *   真实机制：变量快照每帧【全量】发（后端只在显式传了 --select 时
     *   才过滤），所以勾选变化只影响"给 webview 看哪些"，
     *   与仿真进程无关 —— 这正是 README 承诺的「勾选后不需要重新编译」。
     *
     * ★ 更正（原注释写错过）：这条注释原先写"并记下供下次启动传给 --select"，
     *   但那个机制并不存在：既没有字段保存它，SimSession 侧也没有对应的
     *   管线（setSelectedVariables 曾是空函数，已删除）。
     *   如果哪天真要传 --select，代价是【改勾选必须重启进程】，
     *   与上面那条承诺直接冲突 —— 所以那不是"补上就好"的事。
     */
    public async selectVariables(names: string[]): Promise<void> {
        this.selected = new Set(names);
        this.deps.log(
            `[视图] 变量勾选已更新（${this.selected.size} 个）：${[...this.selected].join(', ') || '(无)'}`,
        );
        this.sendCatalogToAll();
        this.sendSnapshot();
    }


    /**
     * 测速：在【同一张图】上重复调用图像处理 N 次，取平均 cycles。
     *
     * ★★ 绝不重启进程（用户反复强调："人家代码要依靠前后帧的！"）：
     *   通过 step 协议的 "b<N>" 命令让【正在跑的进程】把当前这张图
     *   重复跑 N 次（只跑计时段，后处理不参与），结果就是平均值。
     *   算法状态、图集位置、进程全部保持不变。
     */
    public async bench(): Promise<void> {
        const cfg = this.runConfig();
        const n = Math.max(1, cfg.benchRepeat || 1000);

        const s = await this.ensureSession();
        if (!s) {
            void vscode.window.showWarningMessage(
                'SCUT-71：还没有可运行的仿真程序。请先点「编译」。');
            return;
        }
        this.updateProduction();
        this.sendStatus();
        // ★ 用 bench() 返回的那一帧，而不是 this.lastTiming 缓存：
        //   命令是异步生效的，缓存里此刻还是【测速之前】那一帧的数字。
        //   详见 SimSession.bench 的说明。
        const frame = await s.bench(n);

        // ★ 文案以【周期数】为主（用户要求三遍）：µs 是墙钟时间，
        //   每台电脑主频不同，没有横向可比性；周期数才是"做了多少工作"。
        const t = frame?.timing;
        const cyc = t && t.cyclesValid ? t.processCycles : 0;
        const msg = t
            ? `测速完成：同一张图重复 ${n} 次 → 平均 ${cyc.toLocaleString()} 周期/次`
              + (cyc ? '' : '（周期数不可用，本机耗时仅供参考）')
            : '测速未得到计时数据（可能没编译或没跑起来，也可能是那帧超时未返回）。';
        this.deps.log('[测速] ' + msg);
        void vscode.window.showInformationMessage('SCUT-71 ' + msg);
    }

    /**
     * 上一张图。
     *
     * ★ 这里原来还有一个「运行（连续跑 N 帧）」。
     *   它真正的功能被「测速」覆盖了（同一张图重复 N 次，取平均周期数），
     *   而"按顺序连跑 60 帧"既不给结论、又得等半天 —— 用户原话是"没意义"。
     *   连带的 runFrames / 「运行」连跑帧数配置 / F8 键位 / 命令，
     *   在 0.10.6 一并删除，原来占着的播放键图标改给了「编译」。
     */
    public async prevPic(): Promise<void> {
        await this.nudgePic(-1);
    }

    /** 下一张图。 */
    public async nextPic(): Promise<void> {
        await this.nudgePic(+1);
    }

    /**
     * 跳到指定编号的图（供「跳到第 N 张」用）。
     *
     * ★ 与 prevPic/nextPic 同样的语义：只换输入图，不重启进程、
     *   不清算法状态（理由见 nudgePic 的长注释）。
     * ★ 编号越界的处理交给后端（scut_pic_load 会夹到合法区间并把
     *   实际用的那张随帧报回来）—— 插件侧不重复实现同一套边界规则。
     * ★ 返回 undefined 表示会话起不来（与 nudgePic 一致），
     *   调用方据此给出提示。
     */
    public async gotoPic(n: number): Promise<void> {
        const s = await this.ensureSession();
        if (!s) {
            return;
        }
        this.deps.log(`[跳图] 跳到第 ${n} 张。`);
        this.updateProduction();
        this.sendStatus();
        await s.gotoPic(n);
    }

    /**
     * 翻页：上一张 / 下一张。
     *
     * ★★ 为什么【绝不重启进程】（用户原话："为什么我点上一张下一张
     *   测试会他妈重启仿真进程？这不有病吗？有的程序就是要前后图关联
     *   你没事重启干嘛？"）：
     *
     *   翻页的语义是"换一张输入图"，不是"从头再来"。
     *   真实巡线算法都有状态（环形缓冲、状态机、丢线计数、环岛冷却）——
     *   重启进程 = 状态清零 = 看到的不是"上一帧的真实延续"，
     *   这对"前后图关联"的算法是破坏性的，也和车上的行为完全不符。
     *
     *   现在通过 step 协议（后端 0.7.1）直接发 'n' / 'p' 命令：
     *   进程保持活着，算法状态保留，只是输入图换了。
     *   只有【会话还没启动】时才会先起进程。
     */
    private async nudgePic(delta: number): Promise<void> {
        const s = await this.ensureSession();
        if (!s) {
            return;
        }
        this.deps.log(delta > 0 ? '[翻页] 下一张图。' : '[翻页] 上一张图。');
        this.updateProduction();
        this.sendStatus();
        if (delta > 0) {
            await s.nextPic();
        } else {
            await s.prevPic();
        }
    }

    /** 停止会话。 */
    public async stop(): Promise<void> {
        const s = this.session;
        if (!s) {
            return;
        }
        this.session = undefined;
        await s.stop();
        for (const v of this.views) {
            v.post({ type: 'status', running: false, exePath: this.lastExePath ?? null });
        }
    }

    public isRunning(): boolean {
        return this.session !== undefined && this.session.running;
    }

    /**
     * 把一行日志分流到正确的地方。
     *
     * ★★ 曾经的真实 bug（用户原话："我程序输出的LOG还是没有单独的窗口啊，
     *    输出的内容看不到"）★★
     *
     *   后端把用户日志写成 stderr 上的 `[LOG] 正文`，
     *   而本类收到 stderr 后【又加了一层前缀】变成 `[仿真] [LOG] 正文`，
     *   于是下面 `startsWith('[LOG] ')` 永远为假 —— 用户的日志被当成
     *   "环境日志"塞进了「构建」输出通道，而侧边栏「日志」折叠区
     *   （HTML 里早就画好了、脚本也支持）从来收不到任何消息，永远是空的。
     *   现在两层一起修：stderr 那侧不再叠前缀（见 simsession.onStderr），
     *   这里则把用户日志真正 post 给 webview。
     *
     * ★ 分流规则：
     *     [LOG] 前缀 = 用户算法 SCUT_Log 的输出 → 侧边栏「运行日志」折叠区（主）
     *                                            +「SCUT-71 运行日志」输出通道（附带）
     *     其余       = 环境自身的会话日志 → 「SCUT-71 构建」输出通道
     */
    public pushLog(line: string): void {
        if (line.startsWith('[LOG] ')) {
            const text = line.slice(6);
            // ① 主入口：侧边栏里的「运行日志」折叠区（与变量/计时同一种组件）。
            //    用户要的就是这个 —— "像选择变量、变量查看、计时那样的可展开菜单"。
            for (const v of this.views) {
                v.post({ type: 'log', line: text });
            }
            // ② 附带：底部的「SCUT-71 运行日志」输出通道。
            //    侧边栏窄、不能搜索；这里可以搜索/复制/拖高。两处同源，不冲突。
            getSimLogChannel().appendLine(text);
            return;
        }
        this.deps.log(line);
    }

    /* --------------------------------------------------------- 会话管理 */

    /**
     * 读工程配置里的运行期参数（测速次数、连跑帧数等）。
     *
     * ★ 0.9.4：不再读 VS Code 设置。
     *   以前读 scut71.runtime.*，而那些键【从未注册成功】 ——
     *   用户在设置页改了数字，这里拿到的一直是默认值。
     *   现在只认 scut_project.json，读不到就用默认值，
     *   保证"没有配置文件也能跑"。
     */
    private runConfig() {
        const root = this.deps.projectRoot();
        if (!root) {
            return defaultConfig().run;
        }
        const { config } = readConfig(root);
        return (config ?? defaultConfig()).run;
    }

    private async ensureSession(): Promise<SimSessionImpl | undefined> {
        if (this.session && this.session.running) {
            return this.session;
        }
        const exe = this.deps.getExePath();
        if (!exe) {
            void vscode.window.showWarningMessage(
                'SCUT-71：还没有可运行的仿真程序。请先执行「SCUT-71: 编译仿真程序」。',
            );
            return undefined;
        }
        const toolchainBin = this.deps.getToolchainBin();
        const s = new SimSessionImpl({
            exePath: exe,
            toolchainBin,
            picDir: this.deps.getPicDir(),
            /* ★ 这里原先传 selected: [...this.selected]（注释说是给 --select 用）。
             *   那个选项从未被拼进 argv，已随 SimSessionOptions 一并删除。
             *   勾选只影响宿主侧的显示过滤，不需要传给子进程。 */
            projectRoot: this.deps.projectRoot(),
        });
        // ★ 只交给 pushLog 一处分流：它内部决定去 webview / 输出通道 /
        //   环境日志通道。此前这里先 deps.log 再 pushLog，非用户日志会被记两遍。
        s.onLog((line) => this.pushLog(line));
        s.onFrame((f) => this.onFrame(f));
        s.onVariables((v) => this.pushSnapshot(v));
        s.onExit(() => {
            for (const v of this.views) {
                v.post({ type: 'status', running: false, exePath: this.lastExePath ?? null });
            }
        });
        try {
            await s.start();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            void vscode.window.showErrorMessage(`SCUT-71：无法启动仿真程序。\n${msg}`);
            this.deps.log(`[视图] 启动失败：${msg}`);
            return undefined;
        }
        this.session = s;
        this.sendStatus();
        return s;
    }

    /**
     * 一帧到手 → 推给【sim】类视图。
     *
     * ★ 没有可见的 sim 视图时【立刻 ACK】而不是干等：
     *   干等会让仿真进程卡在 getchar 上，用户切回面板时看到的是几秒前的状态。
     *   立刻 ACK 让进程继续，但下面的 updateProduction 已经把产帧闸门关掉了，
     *   所以实际上不会继续产帧 —— 两者配合才是正确的「隐藏时暂停」。
     */
    private onFrame(f: FramePacket): void {
        this.lastTiming = f.timing;
        this.lastFrameIndex = f.index;

        // ★ 加载失败弹通知（用户原话："是否可以在图片加载失败后弹出一个
        //   VS Code 右下角那种窗口"）。
        //
        //   之前失败只在【终端 stderr】上解释，扩展收不到 —— 用户在 IDE 里
        //   只看到黑图，没有任何线索。现在后端随帧带上 loadError，这里转发。
        //
        //   ★ 为什么要去重 + 节流：
        //     同一张图每一帧都会失败（例如整个图集都是 PNG 而后端不认），
        //     连续运行时一秒弹几十个通知等于把 IDE 炸掉。
        //     所以：同一条原因只弹一次；且两条通知之间至少隔 3 秒。
        //     重置时机：失败原因变化（换了另一种错），或会话重启。
        if (f.loadError) {
            const now = Date.now();
            const changed = f.loadError !== this.lastLoadError;
            const cooled = now - this.lastLoadErrorAt > 3000;
            if (changed || cooled) {
                this.lastLoadError = f.loadError;
                this.lastLoadErrorAt = now;
                void vscode.window.showWarningMessage(
                    'SCUT-71：' + f.loadError,
                    { modal: false },
                    '查看说明',
                ).then((pick) => {
                    if (pick === '查看说明') {
                        // 引导到日志区 —— 详细的中文解释（含每个尝试过的路径）在那里
                        this.pushLog('[图像加载失败] ' + f.loadError
                            + '（详细原因与尝试过的位置见「输出」面板）');
                    }
                });
            }
            this.deps.log('[帧 ' + f.index + '] ' + f.loadError);
        } else {
            // 加载成功 → 清空去重状态，下次失败要重新弹
            this.lastLoadError = undefined;
        }

        let delivered = false;
        for (const v of this.views) {
            if (!v.visible()) {
                continue;
            }
            // ★ 直接 post Uint8Array。engines.vscode >= 1.57 时走结构化克隆快路径，
            //   比 base64 快 10–20 倍（VS Code 维护者给的实测数字）。
            const msg: Record<string, unknown> = {
                type: 'frame',
                index: f.index,
                width: f.width,
                height: f.height,
                rgb: f.rgb,
                timing: f.timing,
                // 把"本帧用的是哪张输入图"一并送给前端显示
                pic: f.pic ?? '',
            };
            /* ★ 第二张图：有才带这个字段。
             *   "没有这个字段"与"图没画"是同一件事，前端据此显示空态提示 ——
             *   比推一张全黑图更诚实（全黑也可能是算法画了黑）。 */
            if (f.rgb2) {
                msg.rgb2 = f.rgb2;
            }
            v.post(msg);
            delivered = true;
        }

        if (!delivered) {
            // 没人看 → 立即放行。真正的「暂停」由 updateProduction() 把闸门关掉
            // （进程不会再被放行下一帧），这里的 ACK 只是不让它卡在半路上。
            this.session?.ack(f.index);
            return;
        }
        // 有 ACK 才放行下一帧；webview 那边处理完会发 ack 回来。
    }

    /**
     * 是否应该产帧（至少有一个可见视图）。
     *
     * ★ 这里只放行、不产帧：真正的暂停发生在 SimSession 内部 ——
     *   不可见时它【不写 stdin 那一行】，仿真进程就停在 getchar() 上。
     *   所以切回来看到的一定是最新状态，而不是一堆过期帧。
     */
    private updateProduction(): void {
        const anyVisible = [...this.views].some((v) => v.visible());
        this.session?.setProductionPaused(!anyVisible);
    }

    /* --------------------------------------------------------- 消息处理 */

    private handleMessage(raw: unknown): void {
        if (typeof raw !== 'object' || raw === null) {
            return;
        }
        const msg = raw as Record<string, unknown>;
        const type = msg.type;
        switch (type) {
            case 'ack': {
                if (typeof msg.index === 'number') {
                    this.session?.ack(msg.index);
                }
                break;
            }
            case 'ready': {
                // webview 脚本就位，把当前上下文补上
                for (const v of this.views) {
                    this.sendCatalog(v);
                }
                this.sendSnapshot();
                this.sendStatus();
                break;
            }
            case 'select': {
                const names = Array.isArray(msg.names)
                    ? msg.names.filter((n): n is string => typeof n === 'string')
                    : [];
                void this.selectVariables(names);
                break;
            }
            case 'persist': {
                // ★ webview 通过自己的 acquireVsCodeApi().setState() 做持久化，
                //   这里不用再存一份；收到消息只是为了让用户日志里留痕。
                break;
            }
            case 'cmd': {
                const cmd = msg.cmd;
                if (cmd === 'stop') {
                    void this.stop();
                } else if (cmd === 'build') {
                    /* 交给扩展主命令执行 —— 这样"编译"只有一条实现路径，
                     * 视图里的按钮和命令面板里的命令走的是同一段代码。 */
                    void vscode.commands.executeCommand('scut71.build');
                } else if (cmd === 'debug') {
                    /* 走扩展主命令 —— 与视图标题栏的「调试」图标是同一条实现路径。 */
                    void vscode.commands.executeCommand('scut71.debug');
                } else if (cmd === 'bench') {
                    /* 测速 = 同一张图重复 N 次取平均（旧环境 R 键的做法）。
                     * 与「运行」的分工：运行回答"多路况下表现如何"，
                     * 测速回答"这段代码到底多快"。 */
                    void this.bench();
                } else if (cmd === 'prevPic') {
                    void this.prevPic();
                } else if (cmd === 'nextPic') {
                    void this.nextPic();
                } else if (cmd === 'gotoPic') {
                    /* 跳到指定编号。走扩展主命令 —— 这样 webview 按钮、
                     * 视图标题栏图标、命令面板三条路共用同一份实现
                     * （含输入框与校验），不会各自漂移。 */
                    void vscode.commands.executeCommand('scut71.gotoPic');
                } else if (cmd === 'settings') {
                    /* 设置入口。与「编译」一样走命令 —— 这样 webview 按钮、
                     * 命令面板、快捷键三条路共用同一份实现，不会各自漂移。 */
                    void vscode.commands.executeCommand('scut71.openSettings');
                }
                break;
            }
            default:
                break;
        }
    }

    /* ----------------------------------------------------------- 推送 */

    private sendStatus(): void {
        const running = this.isRunning();
        for (const v of this.views) {
            v.post({ type: 'status', running, exePath: this.lastExePath ?? null });
        }
    }

        private sendCatalog(v: AttachedView): void {
        v.post({
            type: 'catalog',
            variables: (this.manifest?.variables ?? []).map((x) => ({ ...x })),
            // isManual 随条目自带（augmentManifestFromRuntime 打的标），无需额外处理
            selected: [...this.selected],
            hasManifest: this.manifest !== undefined,
        });
    }

    private sendCatalogToAll(): void {
        for (const v of this.views) {
            this.sendCatalog(v);
        }
    }

    private sendSnapshot(): void {
        // ★ 显示规则（用户诉求）：主动暴露的恒显示，自动捕获的看勾选。
        //
        //   主动暴露 = 用户自己在代码里写了 SCUT_Watch/SCUT_WATCH_SCALAR，
        //   语义上已经等于"我想让你看见它"，不该再要求他去列表里勾一遍。
        //   自动捕获 = 环境自己发现的一堆全局量，多达几十个，绝大多数用户
        //   并不关心，所以由「选择变量」按钮控制，显式勾选才进面板。
        //
        //   宿主侧过滤（而不是等仿真进程的 --select 生效）：
        //   否则会出现"刚勾上却要等下一次启动才出现"的割裂感。
        const catalog = this.manifest?.variables ?? [];
        // ★ 判据用 manualWatches（源码扫描得到的名字表），而不是逐条目的
        //   manual 标记：手写注册最常见的是结构体成员，它们在 DWARF 里
        //   没有独立条目，只看条目标记会全部漏掉。
        const manualNames = new Set(this.manifest?.manualWatches ?? []);
        for (const v of catalog) {
            if (v.manual === true) {
                manualNames.add(v.name);
            }
        }
        const filtered = this.lastSnapshot.filter(
            (s) => manualNames.has(s.name) || this.selected.has(s.name));
        const kindOf = new Map<string, WatchedVariable>();
        for (const v of catalog) {
            kindOf.set(v.name, v);
        }
        for (const v of this.views) {
            v.post({
                type: 'vars',
                snapshots: filtered.map((s) => ({
                    ...s,
                    dims: kindOf.get(s.name)?.dims ?? [],
                    kind: kindOf.get(s.name)?.kind ?? '',
                    manual: manualNames.has(s.name),
                })),
                frame: this.lastFrameIndex,
                timing: this.lastTiming ?? null,
            });
        }
    }

    /* ------------------------------------------------------------ HTML */

    private html(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('base64');
        const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'simview.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'simview.css'));

        // ★ 严格 CSP：只允许自己的 media 资源 + 带 nonce 的脚本。
        //   不写 'unsafe-eval'；样式用媒体资源，不给 'unsafe-inline'。
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `style-src ${webview.cspSource} 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>SCUT-71 仿真视图</title>
</head>
<body>
  <div id="app">
    <section id="pane-0" class="image-pane collapsible">
      <header id="pane-0-head">
        <span class="chevron">▸</span>
        <span class="title">图片1</span>
        <span id="pane-0-sum" class="dim"></span>
      </header>
      <div id="pane-0-body" class="collapsed">
        <div class="pane-view">
          <div id="pane-0-wrap" class="screen-wrap">
            <canvas id="pane-0-canvas" class="screen" width="188" height="120"></canvas>
            <div id="pane-0-placeholder" class="placeholder">尚未收到帧<br><span class="dim">点「编译」后「下一张」开始；变量在下方勾选后自动显示</span></div>
          </div>
          <!--
            ★ 画面浮层：只在鼠标移入画面区时出现，平时不占空间。
            为什么要有"适应"：侧边栏宽度是用户随时会拖的，画面必须跟着自适应，
            否则一拖窄就出现横向滚动条、一拖宽就留一大片黑边。
            ★ 浮层是 .screen-wrap 的兄弟节点而不是子节点：
              子节点会跟着画面一起滚动，放大后按钮就跑到看不见的地方了。
          -->
          <div class="pane-actions">
            <button id="pane-0-fit" title="适应窗口（默认行为：拖动边框后自动重新适应）">适应</button>
            <button id="pane-0-zout" title="缩小 (Ctrl+-)">−</button>
            <button id="pane-0-zin"  title="放大 (Ctrl+=)">+</button>
            <button id="pane-0-one" title="回到 1:1">1:1</button>
          </div>
        </div>
        <div id="pic-info" class="pic-info dim"></div>
      </div>
    </section>

    <!--
      ★★ 图片2：与图片1【同一套组件】 ★★

      用户的原话："加完了之后我想这两个图片也可以展开/收起（放大什么的功能不变）"。
      所以这里不是"再画一块 canvas"，而是用同一个组件（createPane）再声明一份：
        · 折叠：与「变量查看 / 计时 / 日志」同一个 collapsible 组件，
          开合状态各自记住（persist 在 panes.p0 / panes.p1 里）；
        · 缩放：两块各自独立（各有一套 zoom/pan）——共用一个缩放会让
          "看图片1的细节"顺手把另一张也放大，两张图尺寸相同、用途不同，
          独立更符合直觉；
        · 键盘 Ctrl+= / Ctrl+- 作用于【鼠标最后停留的那一块】。
      ★ 结构照抄一份，逻辑只有一份 —— 复制结构不会漂移，复制逻辑才会。

      ★ 这一栏【恒显示】，和图片1一样默认【收起】：
        两栏都是"点一下才展开"，面板打开时先看到的是工具栏和变量。
        没有"要不要显示图片2"的开关 —— 没写过图片2的工程，
        它自己就是一条"还没有内容"的提示，不需要用户先去配什么。
    -->
    <section id="pane-1" class="image-pane collapsible">
      <header id="pane-1-head">
        <span class="chevron">▸</span>
        <span class="title">图片2</span>
        <span id="pane-1-sum" class="dim"></span>
      </header>
      <div id="pane-1-body" class="collapsed">
        <div class="pane-view">
          <div id="pane-1-wrap" class="screen-wrap">
            <canvas id="pane-1-canvas" class="screen" width="188" height="120"></canvas>
            <div id="pane-1-placeholder" class="placeholder">图片2 还没有内容<br><span class="dim">在算法里用 SCUT_EnvCopyOutput(2, …)<br>或 SCUT_OutImageSet(2, …) 画它<br>（每帧重画；这一帧不画就是黑的）</span></div>
          </div>
          <div class="pane-actions">
            <button id="pane-1-fit" title="适应窗口（默认行为：拖动边框后自动重新适应）">适应</button>
            <button id="pane-1-zout" title="缩小 (Ctrl+-)">−</button>
            <button id="pane-1-zin"  title="放大 (Ctrl+=)">+</button>
            <button id="pane-1-one" title="回到 1:1">1:1</button>
          </div>
        </div>
      </div>
    </section>

    <section id="toolbar">
      <button id="btn-build" title="编译仿真程序 (Ctrl+Shift+B)">▶ 编译</button>
      <button id="btn-debug" class="primary" title="启动调试（F5）：下断点、单步、看调用栈">调试</button>
      <span class="toolbar-sep"></span>
      <button id="btn-prev" class="primary" title="上一张图 (←)">◀ 上一张</button>
      <button id="btn-next" class="primary" title="下一张图 (→)">下一张 ▶</button>
      <button id="btn-goto" title="跳到指定编号的图（图集很大时比一张张点快）">跳到…</button>
      <span class="toolbar-sep"></span>
      <button id="btn-bench" title="测速：同一张图重复 N 次取平均 cycles (F9)">测速</button>
      <button id="btn-stop" class="danger" title="停止仿真进程 (Shift+F5)">■ 停止</button>
      <!--
        ★ 设置入口：刻意放在工具栏【最右端】，且用 ghost 样式（低对比、无边框）★★
        理由：
          · 设置是【偶尔才用】的操作，不该和「编译/调试/停止」抢注意力；
          · 但它必须【随时可达】—— 用户改工具链、改图像尺寸时找不到入口，
            就会去改 scut_project.json 手改，既慢又容易写错键名。
        所以：不放视图标题栏（那里是高频动作区），也不塞进日志区，
        而是工具行末尾的一个不显眼的按钮，鼠标移上去才看得清。
        点它打开本插件的配置面板（工具链在最后一组）。
      -->
      <button id="btn-settings" class="ghost" title="打开设置（图像尺寸 / 数组 / 钩子 / 图集 / 运行期 / 工具链）">⚙</button>
    </section>

    <section id="status-section">
      <div id="status" class="status">未运行</div>
    </section>

    <!--
      ★★ 变量：勾选与查看【分成两块】★★
      勾选区只放"自动发现"的变量；主动暴露（代码里显式注册）的恒显示，不给勾选框。

      用户的原话点出了要害："勾选的可以在查看页面被查看"。

        勾选区 = 决定"环境要观察哪些变量"，是配置，改一次就放着不动
        查看区 = 看"当前这一帧这些变量的值"，是读数，每帧都在变

      两者混在一起的后果：
        · 44 个变量的勾选列表把读数挤到屏幕外面
        · 想快速扫一眼几个关键值，得先滚过一大片复选框
        · 而且"勾选"这个动作本身没有反馈 —— 用户不知道勾了有什么用

      所以拆开：
        · 勾选区默认折叠、可搜索，勾完就走
        · 查看区默认展开，只显示勾中的变量，且支持展开结构体看字段
    -->
    <section id="pick-section" class="collapsible">
      <header id="pick-header">
        <span class="chevron">▸</span>
        <span class="title">选择要观察的变量</span>
        <span id="pick-count" class="dim"></span>
      </header>
      <div id="pick-body" class="collapsed">
        <div class="pick-hint dim">
          这里只列自动发现的变量。勾选只决定「查看」区显示哪些，不影响仿真进程，也不需要重新编译。<br>
          代码里显式 <code>SCUT_Watch</code> 注册的变量恒显示，不在这里出现。
        </div>
        <input id="pick-filter" type="search" placeholder="输入名字过滤…" />
        <div class="pick-tools">
          <button id="btn-all" class="ghost" title="全选">全选</button>
          <button id="btn-none" class="ghost" title="全不选">全不选</button>
          </div>
        <ul id="pick-list"></ul>
      </div>
    </section>

    <section id="vars-section" class="collapsible">
      <header id="vars-header">
        <span class="chevron">▾</span>
        <span class="title">变量查看</span>
        <span id="vars-count" class="dim"></span>
      </header>
      <div id="vars-body">
        <div id="vars-hint" class="hint"></div>
        <ul id="vars-list"></ul>
      </div>
    </section>

    <!-- 计时：与变量查看同一种可折叠组件（用户要求样式统一） -->
    <section id="timing-section" class="collapsible">
      <header id="timing-header">
        <span class="chevron">▸</span>
        <span class="title">计时</span>
        <span id="timing-summary" class="dim"></span>
      </header>
      <div id="timing-body" class="collapsed">
        <div class="timing">
          <span title="用户算法在当前图上的平均耗时">处理 <b id="t-process">–</b></span>
          <span title="处理器周期数（跨机器可比）">周期 <b id="t-cycles">–</b></span>
          <span title="当前帧号">帧 <b id="t-index">–</b></span>
        </div>
      </div>
    </section>

    <!--
      ★ 日志：默认折叠，不常驻（用户原话："谁家好人没事看日志呀"）。
      它只在出错、或者想确认 SCUT_Log 输出时才需要看，所以做成折叠块。
      折叠标题上保留行数，这样"有没有新日志"一眼可见，不用展开。
    -->
    <section id="log-section" class="collapsible">
      <header id="log-header">
        <span class="chevron">▸</span>
        <span class="title">运行日志</span>
        <span id="log-count" class="dim"></span>
        <span class="spacer"></span>
        <button id="btn-clear" class="ghost" title="清空日志">清空</button>
      </header>
      <div id="log-body" class="collapsed">
        <div class="log-hint dim">你代码里 <code>SCUT_Log(...)</code> 的输出会出现在这里。折叠状态下标题上的行数就是提示。</div>
        <pre id="log"></pre>
      </div>
    </section>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
