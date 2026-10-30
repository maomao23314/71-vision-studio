/**
 * protocol.ts —— 仿真进程 stdout 协议 + PPM 图像的【纯逻辑】解析层。
 *
 * ★ 为什么单独拆一个文件：
 *   本文件不 import 'vscode'，因此可以在普通 Node 进程里被单元测试直接加载
 *   （见验证脚本：逐行切分器与 PPM 解析器都靠这个文件做无 UI 校验）。
 *   其余模块（simsession/simview/...）都必须依赖 vscode 运行时，测不了。
 *
 * 协议来源：backends/headless/scut_headless_main.c（权威，勿凭记忆）。
 *   · 每帧一行 JSON：{"frame":..,"w":..,"h":..,"img":"<ppm path>",
 *                     "pic":"<输入图>",["loadError":"..",]["img2":"<ppm path>",]
 *                     "bench":bool,"vars":[{..}],"timing":{..}}
 *     ★ 变量快照是【内嵌在帧行里】的 "vars" 字段（0.7.1 起），
 *       不再单独发一行。parseFrameLine 与 parseVariablesLine 的判定顺序
 *       因此是契约（帧行同时长得像变量行），改动前先看 simsession 的注释。
 *   · 独立变量行只有 "vars" 没有 "frame"：那是 `--list-vars` 的输出，
 *     会话里用不到（保留解析是为了那个入口）。
 *   · 帧图像是 PPM(P6)：ASCII 头 "P6\n<w> <h>\n255\n" + w*h*3 字节 RGB。
 *
 *  ★ 为什么输出改成彩色：覆盖层里 SCUT_DrawPoint 写的是真彩色，
 *    而合成阶段曾经把颜色按亮度折算成单通道灰度写进输出 —— 于是
 *    红/绿/青在暗色底图上落进同一个低区间，肉眼无法分辨，
 *    表现为「绘制明明是彩色的，画面却变成灰度了」。现在 RGB 原样透传。
 */

import type { BuildDiagnostic } from './types';

/* ==========================================================================
 *  逐行切分
 * ========================================================================== */

/**
 * 把任意 chunk 序列重组成完整行。
 *
 * ★ 这是最经典的 bug 源：`data` 事件不保证按行边界到达。
 *   188x120 的 JSON 行约 200 字节，而管道一次可能只给 20 字节，
 *   也可能一次给 3 行。直接把 chunk 当一行解析会【随机】丢帧，
 *   且只在机器慢/输出快时复现。所以必须缓冲 + 按 \n 切。
 */
export class LineSplitter {
    private buf = '';
    /**
     * 单行长度上限。仿真进程若因 bug 狂吐无换行数据，
     * 这里必须兜住，否则扩展宿主内存无界增长。
     */
    private static readonly MAX_LINE = 4 * 1024 * 1024;

    /** 追加一段文本，返回其中【完整】的行（不含换行符）。 */
    push(chunk: string): string[] {
        this.buf += chunk;
        const out: string[] = [];
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
            let line = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 1);
            // Windows 下 C 的 stdout 可能被翻译成 \r\n
            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }
            out.push(line);
        }
        if (this.buf.length > LineSplitter.MAX_LINE) {
            out.push(this.buf.slice(0, LineSplitter.MAX_LINE));
            this.buf = '';
        }
        return out;
    }

    /** 进程结束时把残留的、没有换行符的最后一行吐出来。 */
    flush(): string[] {
        if (this.buf.length === 0) {
            return [];
        }
        const rest = this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf;
        this.buf = '';
        return [rest];
    }

    /** 尚未成行的残留长度（供诊断用）。 */
    get pending(): number {
        return this.buf.length;
    }
}

/* ==========================================================================
 *  JSON 解析（含容错）
 * ========================================================================== */

/**
 * 修复「反斜杠路径」造成的非法 JSON 转义。
 *
 * ★ 为什么需要这一步（实测）：
 *   scut_headless_main.c 用 snprintf 拼 `"%s/frame_%04d.ppm"`，
 *   而 out_dir 来自命令行。于是当 --out 是 `C:\Users\...` 时，
 *   stdout 上的 JSON 里出现【未转义的单个反斜杠】：
 *       "img":"C:\Users\SQY\...\probe_frames/frame_0001.ppm"
 *   JSON 规范只允许 \" \\ \/ \b \f \n \r \t \uXXXX，
 *   实测 JSON.parse 直接抛 "Bad escaped character in JSON"。
 *   也就是说：**按原样根本无法解析**，必须容错。
 *
 * ★ 为什么「只保留规范里的合法转义」这个做法不够（实测发现的坑）：
 *   单字母转义 `\b \f \n \r \t` 在规范里是合法的，于是：
 *       `C:\users\sqy\frames` 里的 `\f` 会被 JSON 老老实实当成
 *       【换页符 0x0C】吃掉，解析【成功】但路径被静默改成了
 *       `C:\users\sqy<0x0C>rames` —— 比报错更难查。
 *       （`\u` 更麻烦：`C:\users` 会被当成 Unicode 转义引导符，
 *        而 `sers` 不是合法十六进制，抛 "Bad Unicode escape"。）
 *
 *   所以这里的规则是：**只把 `\"`、`\\`、`\/` 和「后面跟满 4 位十六进制」的
 *   `\u` 当成转义，其余一律补成 `\\`。**
 *
 * ★ 这样做会不会破坏合法 JSON？不会，因为 `parseJsonLoose` 是两段式的：
 *   先 `JSON.parse` 走严格解析，**只有严格解析失败时**才调本函数。
 *   能严格解析的行永远不经过这里。而会走到这里的行，本来就已经是
 *   非法 JSON 了（多半就是路径里的裸反斜杠）。
 */
export function repairLooseJson(text: string): string {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (!inString) {
            if (c === '"') {
                inString = true;
            }
            out += c;
            continue;
        }
        if (escaped) {
            out += c;
            escaped = false;
            continue;
        }
        if (c === '\\') {
            const n = text[i + 1];
            let legal: boolean;
            if (n === 'u') {
                // 只有后面跟满 4 位十六进制才算真的 Unicode 转义
                legal = /^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4));
            } else {
                legal = n === '"' || n === '\\' || n === '/';
            }
            if (legal) {
                out += c;
                escaped = true;
            } else {
                // 非法（或在本协议里只可能是路径分隔符）→ 补一个反斜杠
                out += '\\\\';
            }
            continue;
        }
        if (c === '"') {
            inString = false;
        }
        out += c;
    }
    return out;
}

/**
 * 宽松 JSON 解析：先严格解析；失败才容错重试。两步都失败返回 undefined。
 *
 * ★ 顺序不能反：严格优先保证了「凡是本来就合法的 JSON 都走标准路径」，
 *   于是 repairLooseJson 的启发式规则不会有任何机会影响合法输入。
 */
export function parseJsonLoose(text: string): unknown {
    const s = text.trim();
    if (s.length === 0) {
        return undefined;
    }
    try {
        return JSON.parse(s) as unknown;
    } catch {
        try {
            return JSON.parse(repairLooseJson(s)) as unknown;
        } catch {
            return undefined;
        }
    }
}

/* ==========================================================================
 *  帧行 / 变量行
 * ========================================================================== */

/**
 * 一帧的计时。
 *
 * ★ 字段集与后端的 JSON 严格对应（见 scut_headless_main.c 的 printf）。
 *   后端曾经还发一个 reportUs，但「REPORT 阶段」已经从核心的调度模型里删掉
 *   （绘制与日志现在同在 DRAW 阶段、一起计入 drawUs），
 *   所以这里不再有 reportUs —— 留着它只会是一个恒为 0 的假字段。
 */
export interface FrameTiming {
    processUs: number;
    drawUs: number;
    frameUs: number;
    /** JSON 字段名是 cycles，对应 scut_timing_t.process_cycles */
    processCycles: number;
    cyclesValid: boolean;
}

export interface FrameLine {
    frame: number;
    w: number;
    h: number;
    /** PPM 文件路径（可能是反斜杠与正斜杠混用的形式） */
    img: string;
    /**
     * 第二张图的 PPM 路径（算法写过才有；没写过是空串）。
     *
     * ★ 后端从没见人写过第二张图时【连这个字段都不发】，
     *   所以空串也等价于"没有" —— 这里统一成空串，
     *   调用方只需要判断真假，不用区分"缺字段"和"空字符串"。
     */
    img2: string;
    /** 本帧实际使用的【输入图】路径（仿真进程的 "pic" 字段）。 */
    pic: string;
    /** 本帧图像加载失败的原因（成功时为空串）。 */
    loadError: string;
    /** 每帧变量快照（随帧 JSON 内嵌，面板数值与画面同步）。 */
    vars: VarLineEntry[];
    timing: FrameTiming;
}

export interface VarLineEntry {
    name: string;
    /** scut_watch_type_t 的数值（scut_watch.h 里的枚举） */
    kind: number;
    dim: number;
    total: number;
    values: string;
    truncated: boolean;
    /**
     * true = 构建时自动发现的；false = 用户在代码里手写 SCUT_Watch 注册的。
     * 缺省（老后端不发这个字段）按 true 处理，免得把自动变量误标成主动暴露。
     */
    autoTag: boolean;
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
    return (typeof v === 'object' && v !== null) ? v as Record<string, unknown> : undefined;
}

/** 解析一行帧 JSON。不是帧行则返回 undefined。 */
export function parseFrameLine(line: string): FrameLine | undefined {
    const root = asRecord(parseJsonLoose(line));
    if (!root) {
        return undefined;
    }
    if (typeof root.frame !== 'number' || typeof root.w !== 'number'
        || typeof root.h !== 'number' || typeof root.img !== 'string') {
        return undefined;
    }
    const t = asRecord(root.timing) ?? {};
    return {
        frame: root.frame,
        w: root.w,
        h: root.h,
        img: root.img,
        img2: typeof root.img2 === 'string' ? root.img2 : '',
        pic: typeof root.pic === 'string' ? root.pic : '',
        loadError: typeof root.loadError === 'string' ? root.loadError : '',
        vars: parseVariablesLine(JSON.stringify(root)) ?? [],
        timing: {
            processUs: num(t.processUs),
            drawUs: num(t.drawUs),
            frameUs: num(t.frameUs),
            processCycles: num(t.cycles),
            cyclesValid: t.cyclesValid === true,
        },
    };
}

/** 解析一行变量 JSON。不是变量行则返回 undefined（空数组是合法的变量行）。 */
export function parseVariablesLine(line: string): VarLineEntry[] | undefined {
    const root = asRecord(parseJsonLoose(line));
    if (!root || !Array.isArray(root.vars)) {
        return undefined;
    }
    const out: VarLineEntry[] = [];
    for (const raw of root.vars) {
        const v = asRecord(raw);
        if (!v || typeof v.name !== 'string') {
            continue;
        }
        out.push({
            name: v.name,
            kind: num(v.kind),
            dim: num(v.dim),
            total: num(v.total),
            values: typeof v.values === 'string' ? v.values : '',
            truncated: v.truncated === true,
            autoTag: v.autoTag !== false,
        });
    }
    return out;
}

/* ★ 这里原先有一个 export parseNumericValues(values) ——【真的死代码】，已删除。
 *
 *   它的注释写着两件事，现在【两句都不成立】：
 *     · "供曲线板使用" —— 查看变量下面的折线图已按用户要求删除
 *       （见 docs/改动流水账.md 第 2 轮"删掉折线图"），
 *       删除清单里覆盖了 simview.js / simview.css / 空态文案，
 *       【唯独漏了这个函数】—— 所以它是被遗忘的，不是有意保留的。
 *     · "simview.js 里有一份等价实现，两边必须同步改" ——
 *       那份实现随折线图一起删了，simview.js 里已无任何 Number()/parseFloat。
 *
 *   它当时只靠 tests/extension_smoke.js 的 6 条断言活着 ——
 *   "测试维持着一个没有生产消费者的函数存活"，是死代码最容易被忽视的形态。
 *   测试里的那一段已一并删除。
 *
 *   ★ 将来若真要做曲线：重新实现时请一并决定"谁来消费"，
 *     而不是先写一个解析函数放着。
 */

/* ==========================================================================
 *  PPM (P6) 解析
 * ========================================================================== */

export interface FrameImage {
    width: number;
    height: number;
    /** 长度 = width * height * 3，每像素 R/G/B 三字节（紧凑排列） */
    rgb: Uint8Array;
}

function isWs(b: number): boolean {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
}

function skipWsAndComments(buf: Uint8Array, pos: number): number {
    while (pos < buf.length) {
        const b = buf[pos];
        if (isWs(b)) {
            pos++;
            continue;
        }
        if (b === 0x23) {           // '#'
            while (pos < buf.length && buf[pos] !== 0x0a) {
                pos++;
            }
            continue;
        }
        break;
    }
    return pos;
}

function readToken(buf: Uint8Array, pos: number): { token: string; next: number } | undefined {
    pos = skipWsAndComments(buf, pos);
    let s = '';
    while (pos < buf.length && !isWs(buf[pos]) && buf[pos] !== 0x23) {
        s += String.fromCharCode(buf[pos]);
        pos++;
    }
    return s.length === 0 ? undefined : { token: s, next: pos };
}

/**
 * 解析 PPM(P6) 真彩色图。
 *
 * ★ 为什么手写而不是找库：
 *   格式只有「P6 / 宽 / 高 / 255 / 原始字节」五段，核心侧
 *   （scut_headless_main.c 的 `fprintf(f, "P6\n%d %d\n255\n", w, h)`）
 *   就是按这个写法输出的，引入依赖不划算。
 *
 * ★ 关键难点（写错就会整帧花屏或越界）：
 *   1) 像素数据里【允许出现任意字节】，包括 0x20 / 0x0A / '#'。
 *      所以不能一路「跳过空白」再取数据 —— 只能在读完 maxval 记号后
 *      【恰好】跨过一个分隔空白，此后的字节全部算像素。
 *   2) 注释 `#...` 只允许出现在头部记号之间。
 *   3) 头部反斜杠无关，但 \r\n 存在时要跨两个字节。
 *
 * 返回 undefined 表示：不是 P6、头损坏、或像素数据不完整。
 */
export function parsePpm(buf: Uint8Array): FrameImage | undefined {
    const magic = readToken(buf, 0);
    if (!magic || magic.token !== 'P6') {
        return undefined;
    }
    const wTok = readToken(buf, magic.next);
    const hTok = wTok ? readToken(buf, wTok.next) : undefined;
    const mTok = hTok ? readToken(buf, hTok.next) : undefined;
    if (!wTok || !hTok || !mTok) {
        return undefined;
    }
    const width = Number(wTok.token);
    const height = Number(hTok.token);
    const maxval = Number(mTok.token);
    if (!Number.isInteger(width) || !Number.isInteger(height)
        || width <= 0 || height <= 0 || maxval !== 255) {
        // 只支持 8 位通道：核心固定写 255，其它值说明不是我们的产物。
        return undefined;
    }
    // maxval 记号之后恰好一个分隔空白；\r\n 要跨两个
    let dataStart = mTok.next;
    if (buf[dataStart] === 0x0d && buf[dataStart + 1] === 0x0a) {
        dataStart += 2;
    } else if (dataStart < buf.length && isWs(buf[dataStart])) {
        dataStart += 1;
    }
    const need = width * height * 3;   // ★ RGB：每像素 3 字节
    if (buf.length - dataStart < need) {
        return undefined;           // 文件被截断（仿真进程正在写？）
    }
    // ★ 必须 new Uint8Array(...) 拷一层：
    //   fs.readFile 给的是 Node Buffer，它是 Uint8Array 的子类，
    //   直接 subarray 会共享底层（可能是 64 KB 的池 slab）。
    //   而 postMessage 的结构化克隆快路径要求真正的 ArrayBuffer 视图，
    //   共享 slab 会把整个池都传过去（实测过这类事故）。
    const rgb = new Uint8Array(buf.subarray(dataStart, dataStart + need));
    return { width, height, rgb };
}

/* ==========================================================================
 *  编译诊断解析
 * ========================================================================== */

/* ★ 工具侧（tools/scut_build.py）用的是 Python 的 (?P<name>...) 命名组；
 *   JS 不支持这种写法（JS 是 (?<name>...)），所以这里用编号组等价表达，
 *   组顺序必须与工具侧保持一致，否则字段会错位。 */
const RE_FULL = /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|note|remark)\s*:\s*(.*)$/;
const RE_NOCOL = /^(.*?):(\d+):\s*(fatal error|error|warning|note|remark)\s*:\s*(.*)$/;
const RE_NOLOC = /^(.*?):\s*(fatal error|error|warning)\s*:\s*(.*)$/;

function sevOf(raw: string): BuildDiagnostic['severity'] {
    if (raw === 'error' || raw === 'fatal error') {
        return 'error';
    }
    if (raw === 'warning') {
        return 'warning';
    }
    return 'info';
}

/** 把 gcc/clang/ld 的原始输出解析成结构化诊断。 */
export function parseDiagnostics(output: string): BuildDiagnostic[] {
    const out: BuildDiagnostic[] = [];
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (line.length === 0) {
            continue;
        }
        let m = RE_FULL.exec(line);
        if (m) {
            out.push({
                file: m[1] || undefined,
                line: Number(m[2]),
                column: Number(m[3]),
                severity: sevOf(m[4]),
                message: m[5],
            });
            continue;
        }
        m = RE_NOCOL.exec(line);
        if (m) {
            out.push({
                file: m[1] || undefined,
                line: Number(m[2]),
                severity: sevOf(m[3]),
                message: m[4],
            });
            continue;
        }
        m = RE_NOLOC.exec(line);
        if (m) {
            out.push({
                file: m[1] || undefined,
                severity: sevOf(m[2]),
                message: m[3],
            });
        }
    }
    return out;
}
