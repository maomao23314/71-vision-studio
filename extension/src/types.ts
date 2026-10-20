/**
 * SCUT-71 Vision Studio —— 插件内部共享类型与接口契约。
 *
 * 设计理念对照：
 *   · 代码松耦合   → 各模块只依赖本文件的接口，不互相 import 实现
 *   · 适应任意代码 → 变量类型走【动态发现】的结果，插件不硬编码任何用户符号
 *
 * ★ 本文件是各模块之间的唯一契约。改这里必须同步全部实现方。
 */

/* ==========================================================================
 *  工具链
 * ========================================================================== */

export interface ToolInfo {
    /** 工具名，如 'clang' / 'objdump' / 'lldb-dap' / 'python' */
    name: string;
    /** 绝对路径 */
    path: string;
    /** 版本字符串（探测失败为 undefined，不阻断流程） */
    version?: string;
}

export interface Toolchain {
    /** 工具链根目录 */
    root: string;
    /** 编译器（C） */
    cc: string;
    /** 编译器（C++），可能等于 cc */
    cxx: string;
    /** 链接器 */
    ld: string;
    /**
     * binutils 的 objdump。
     *
     * ★ 必须来自 binutils，【不能】用 LLVM 的 llvm-objdump：
     *   实测 LLVM 21 已移除 --dwarf=info（只支持 =frames），
     *   自动符号发现会直接失败。
     */
    objdump: string;
    /** 调试适配器 lldb-dap（缺省时调试功能降级） */
    lldbDap?: string;
    /** 语言服务 clangd（可选：只做发现与建议，插件自己不起语言服务） */
    clangd?: string;
    /** Python 解释器（跑自动符号发现脚本） */
    python?: string;
    /** 探测过程中产生的、需要告知用户的事项（用于「说人话」的提示） */
    warnings: string[];
}

export interface DoctorResult {
    ok: boolean;
    /** 面向用户的中文诊断行 */
    lines: string[];
    /** 致命问题（阻止仿真运行） */
    errors: string[];
    toolchain?: Toolchain;
}

/* ==========================================================================
 *  工程模型
 * ========================================================================== */

export interface ScutProject {
    /** 工程根目录（绝对路径） */
    root: string;
    /** 用户算法目录（默认 <root>/code） */
    codeDir: string;
    /** 老工程的编译期契约头文件（<root>/config.h）；新工程的契约在 .scut/gen/ 下 */
    configHeader: string;
    /** 测试图集目录 */
    picDir: string;
    /** 生成物目录（默认 <root>/.scut） */
    outDir: string;
}

/** 自动符号发现产出的单个变量描述（与 tools/scut_symbols.py 的 JSON 对应） */
export interface WatchedVariable {
    name: string;
    /** SCUT_T_I32 / SCUT_T_U8 / ... */
    kind: string;
    dims: number[];
    total: number;
    elemBytes: number;
    isStruct: boolean;
    isPtr: boolean;
    isStatic: boolean;
    declLine?: string;
    /** 由生成器给出的默认勾选建议（大缓冲默认不勾，避免卡 UI） */
    defaultSelected: boolean;
    /**
     * 是不是「主动暴露」的变量（用户自己在代码里写了 SCUT_Watch /
     * SCUT_WATCH_SCALAR 显式注册的）。
     *
     * ★ 判据：tools/scut_symbols.py **扫源码**，看用户亲手写了哪些注册调用。
     *   见该文件的 scan_manual_watches。
     *
     * ★ 为什么不用"运行期注册表减编译期 DWARF"（曾经的判据）：那个差集实测
     *   恒为空 —— 自动发现生成的包装单元调用的也是 SCUT_Watch，与手写的
     *   进同一张注册表，到这一步已经分不出谁写的了。只有源码还分得清。
     *
     * ★ 为什么要区分：主动注册的通常是"作者认为最关键的量"
     *   （例如结构体里的 cam_err），理应排在前面、视觉上更醒目，
     *   而且【恒显示】——用户写过它就等于已经勾选过了。
     */
    manual?: boolean;
}

export interface VariableManifest {
    source: string;
    count: number;
    variables: WatchedVariable[];
    /**
     * 用户【亲手】写了 SCUT_Watch / SCUT_WATCH_SCALAR 的变量名（跨文件汇总）。
     *
     * ★ 为什么要单独存一份，而不是只看每个变量上的 manual 标记：
     *   手写注册最常见的形式就是【结构体成员】
     *   （SCUT_WATCH_SCALAR("cam_err", &m7_0_data.cam_err, ...)），
     *   而结构体成员在 DWARF 里【没有独立变量条目】——
     *   实测真实工程里 7 个手写变量一个都不在自动发现的清单中。
     *   名字必须单独存，宿主才能去【运行期注册表】里把它们认出来。
     *   否则"用户主动注册的变量看不见"就成了必然。
     */
    manualWatches?: string[];
}

/* ==========================================================================
 *  构建
 * ========================================================================== */

export interface BuildOptions {
    /**
     * 是否启用自动符号发现（关闭则变量面板为空但构建更快）。
     *
     * ★ 优化等级刻意【不在这里】——它不该由用户选：
     *     用户算法恒为 `-g -O0`（保证断点不漂移、变量看得见）；
     *     环境自身（核心库 / bind / 后端 / 接线单元）恒为 `-O2`。
     *   两者的选择是工程约定，不是"模式"。
     */
    autoWatch: boolean;
    /**
     * 变量名黑名单（逗号分隔，透传成 `--exclude`）。留空 = 不排除。
     *
     * ★ 为什么由插件传而不是让脚本自己读配置：
     *   scut_build.py 确实也会读工程配置（命令行优先），
     *   但插件是多进程并行构建场景下的唯一调度者 ——
     *   把值显式放进 argv，日志里就能看到"这一次用的到底是什么"，
     *   排查时不必再去翻工程 JSON。
     */
    watchExclude?: string;
    /** 变量元素数上限（透传成 `--max-elems`，0 = 不限制）。 */
    watchMaxElems?: number;
}

export interface BuildResult {
    ok: boolean;
    /** 生成的仿真可执行文件绝对路径 */
    exePath?: string;
    /** 编译/链接的原始输出（用于「输出」面板） */
    output: string;
    /** 自动发现的变量清单（若启用） */
    manifest?: VariableManifest;
    /** 结构化错误，便于 UI 定位 */
    errors: BuildDiagnostic[];
    /** 耗时（毫秒） */
    elapsedMs: number;
}

export interface BuildDiagnostic {
    file?: string;
    line?: number;
    column?: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
}

/* ==========================================================================
 *  仿真运行与呈现
 * ========================================================================== */

/** 一帧的输出（核心 → 呈现后端） */
export interface FramePacket {
    /** 帧序号 */
    index: number;
    width: number;
    height: number;
    /**
     * RGB 像素（长度 = width * height * 3，每像素 R/G/B 三字节）。
     *
     * ★ 契约变更记录（0.10.0）：原字段 `gray: Uint8Array`（每像素 1 字节灰度），
     *   现改为 `rgb: Uint8Array`（每像素 3 字节）。
     *   理由：核心的合成阶段曾把彩色标注按亮度折算成单通道灰度，
     *   红/绿/青在暗色底图上落进同一个低区间，肉眼无法分辨，
     *   表现为「绘制明明是彩色的，画面却变成灰度了」。
     *   现在颜色原样透传到 canvas，标注一眼可辨。
     *
     * ★ 历史契约变更记录（0.2.0）：更早的字段是 `grayBase64: string`，
     *   后改为 `Uint8Array`。理由是 Webview.postMessage 的传输特性：
     *     · `engines.vscode >= 1.57` 时，`Webview.postMessage` 对 ArrayBuffer/
     *       TypedArray 走「结构化克隆」快路径。VS Code 维护者给的实测数字是
     *       扩展宿主 → webview 约 10 s → 500 ms（10–20 倍）。
     *     · 真正的成本不是带宽而是【每条消息的序列化】，序列化跑在扩展宿主线程上；
     *       base64 会把序列化开销放大 33%，正好加在最贵的地方。
     *   连带约束：Node 的 `Buffer` 是 `Uint8Array` 的【子类】，克隆时可能被当成
     *   Buffer 处理而丢掉快路径，因此生产端必须显式 `new Uint8Array(...)` 拷一层。
     */
    rgb: Uint8Array;
    timing: TimingInfo;
    /** 本帧实际使用的【输入图】路径。 */
    pic?: string;
    /** 本帧图像加载失败的原因（成功时为空串）。 */
    loadError?: string;
}

export interface TimingInfo {
    /** ★ 算法耗时：只有 PROCESS 阶段被计入（环境的核心指标） */
    processUs: number;
    /** 绘制 + 搬运结果图 + 打日志的耗时（不计入 processUs） */
    drawUs: number;
    /** 整帧跨度，不含呈现后端自身的开销 */
    frameUs: number;
    /** 处理器周期数（跨机器可比，比微秒更有意义） */
    processCycles: number;
    /** 周期数是否可信（TSC 是否可用） */
    cyclesValid: boolean;
}

/** 变量在一帧后的快照值 */
export interface VariableSnapshot {
    name: string;
    /** 已格式化为可显示的字符串（由核心按类型渲染） */
    values: string[];
    /** 是否被截断（大数组只传前 N 个） */
    truncated: boolean;
    total: number;
    /**
     * 是不是「主动暴露」的（用户自己在源码里写了 SCUT_Watch）。
     *
     * ★ 为什么要把它随快照一起传，而不让前端去查清单：
     *   变量可能【不在清单里】（DWARF 解析不出独立条目的结构体成员），
     *   但它确实注册过。清单是"编译期能看到什么"，注册表是"实际注册了什么"，
     *   两者本就不等价。以注册结果为准更贴近"用户到底能不能看见它"。
     */
    manual?: boolean;
}

/* ==========================================================================
 *  仿真会话接口 —— 呈现层只依赖这个，不关心进程怎么起
 * ========================================================================== */

export interface SimSession {
    readonly exePath: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** 单步一帧（协议空行：重跑当前图） */
    step(): Promise<void>;
    /** 下一张图（协议 n，进程不重启，算法状态保留） */
    nextPic(): Promise<void>;
    /** 上一张图（协议 p，进程不重启，算法状态保留） */
    prevPic(): Promise<void>;
    /**
     * 测速：当前图重复 N 次（协议 b<N>，只跑计时段，后处理不参与）。
     *
     * ★ 返回【测速那一帧】的数据。命令只是往 stdin 写一行，效果要等后端
     *   跑完那一帧才可见；若不等就返回，调用方只能读到上一帧的计时 ——
     *   那正是"测速结果是错的"这类静默缺陷的成因。
     *   超时或进程已退出时返回 undefined。
     */
    bench(n: number): Promise<FramePacket | undefined>;
    /** 运行 n 帧（连续发空行） */
    runFrames(n: number): Promise<void>;
    /**
     * 跳到第 n 张测试图（协议 g<N>，进程不重启，算法状态保留）。
     *
     * ★ 为什么需要它：后端一直实现了 `g<N>` 命令（含边界钳位），
     *   协议注释里也写着，但【插件从不发送它】—— 用户在 60 多张图的
     *   工程里只能一张张点「下一张」，无法跳转。
     *   跳图与翻页共用同一条 stdin 通道，所以不重启进程、状态保留。
     */
    gotoPic(n: number): Promise<void>;
    /* ★ 这里原先有 setSelectedVariables(names: string[])。
     *   它在实现侧是空函数，且没有任何真实用途 —— 勾选变化走的是
     *   宿主侧的显示过滤（simview.selectVariables），完全不碰仿真进程。
     *   接口不该声明空实现：那会让人以为"调用它就能改变变量收集"。
     *   已连同实现一起删除。 */
    onFrame(cb: (f: FramePacket) => void): void;
    onVariables(cb: (v: VariableSnapshot[]) => void): void;
    onLog(cb: (line: string) => void): void;
    onExit(cb: (code: number | null) => void): void;
    /**
     * 呈现层确认「第 index 帧已收到并已显示」。
     *
     * ★ 为什么必须有这个：`Webview.postMessage` 返回 `true` 只代表消息进了队列，
     *   不代表 webview 处理完了（vscode.d.ts:10016-10018 明确警告）。所以背压
     *   不能依赖返回值，必须由 webview 显式 ACK 回一条消息，扩展宿主再放行下一帧。
     */
    ack(index: number): void;
    /** 当前是否已有帧在途（无 ACK 则不再产帧）。 */
    readonly frameInFlight: boolean;
}
