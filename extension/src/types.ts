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
    /** 语言服务 clangd（缺省时补全降级，不影响仿真） */
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
    /** 编译期契约头文件（默认 <root>/config.h） */
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
     * 是不是「主动暴露」的变量（代码里显式 SCUT_Watch 注册的）。
     *
     * ★ 判据：运行期注册表里有、编译期 DWARF 清单里没有 → 主动暴露。
     *   见 extension/src/build.ts 的 augmentManifestFromRuntime。
     *
     * ★ 为什么要区分：主动注册的通常是"作者认为最关键的量"
     *   （例如结构体里的 cam_err），理应排在前面、并且视觉上更醒目；
     *   自动捕获的是编译器看到的一切，属于"顺带发现"，排后面即可。
     */
    manual?: boolean;
}

export interface VariableManifest {
    source: string;
    count: number;
    variables: WatchedVariable[];
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
     * 灰度像素（长度 = width * height，每像素 1 字节）。
     *
     * ★ 契约变更记录（0.2.0）：原字段是 `grayBase64: string`，现改为 `Uint8Array`。
     *   理由（见 docs/插件技术要点.md 坑 2，已在本机发行版源码核实）：
     *     · `engines.vscode >= 1.57` 时，`Webview.postMessage` 对 ArrayBuffer/
     *       TypedArray 走「结构化克隆」快路径。VS Code 维护者给的实测数字是
     *       扩展宿主 → webview 约 10 s → 500 ms（10–20 倍）。
     *     · 真正的成本不是带宽而是【每条消息的序列化】，序列化跑在扩展宿主线程上；
     *       base64 会把序列化开销放大 33%，正好加在最贵的地方。
     *     · 188x120 灰度 = 22560 B，base64 后 30080 B。
     *   连带约束：Node 的 `Buffer` 是 `Uint8Array` 的【子类】，克隆时可能被当成
     *   Buffer 处理而丢掉快路径，因此生产端必须显式 `new Uint8Array(...)` 拷一层。
     */
    gray: Uint8Array;
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
    /** 测速：当前图重复 N 次（协议 b<N>，只跑计时段，后处理不参与） */
    bench(n: number): Promise<void>;
    /** 运行 n 帧（连续发空行） */
    runFrames(n: number): Promise<void>;
    /** 用户勾选的变量发生变化时通知核心 */
    setSelectedVariables(names: string[]): void;
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
