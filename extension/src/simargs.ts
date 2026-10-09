/**
 * simargs.ts —— 由工程配置推导 scut_sim.exe 的【图集相关】命令行参数。
 *
 * ★★ 为什么单独一个文件（本文件存在的唯一理由）★★
 *
 *   「运行」与「调试」是两个入口，但它们喂给仿真程序的图集必须是同一组 ——
 *   否则用户在界面上翻到第 7 张、按 F5 调试，看到的却是第 1 张（甚至全黑），
 *   而两个入口看起来"是同一件事"。这类不一致不报错、不崩溃，极难归因。
 *
 *   历史上这两个入口各写了一遍：
 *     · simsession.ts 启动会话时自己拼（`--frame` / `--ext` / `--pic`）
 *     · debug.ts   只补 `program/args/cwd/env`，**完全不补图集参数**
 *   于是配了 `pic.dir = "pic/3"` 的工程，运行用 pic/3、调试用编译期默认值。
 *
 *   现在两边都调本文件 —— 一处实现、两处使用，"两个入口拼出不同参数"
 *   在结构上就无从发生（与 scut_composite_overlay 显式传缓冲是同一个思路：
 *   消灭"两处各自知道同一件事"）。
 *
 * ★ 本文件【不 import 'vscode'】，且不碰任何全局状态：
 *   因此它可以在普通 Node 进程里被单元测试直接加载（见 tests/）。
 *   其余模块（simsession/debug/...）都必须依赖 vscode 运行时，测不了。
 *
 * ★ 本文件【不读磁盘】：配置由调用方读好后传进来。
 *   这样"谁是配置的真值来源"仍然只有一个答案（projectconfig.readConfig），
 *   本文件只是把配置翻译成参数，不引入第二个真值。
 */

import type { ProjectConfig } from './projectconfig';

/**
 * 图集相关的运行参数。
 *
 * ★ 刻意只包含【图集与重复次数】这几项，不包含 `--json` / `--step` /
 *   `--frames` / `--out` —— 后者是「会话」与「调试」各自的运行模式，
 *   不属于两边必须一致的东西：
 *     · 会话：`--json --step --frames 0 --out <临时目录>`（常驻、逐帧喂）
 *     · 调试：`--frames 1`（跑一帧就停，方便下断点）
 *   把它们也塞进来会逼迫调用方"传一堆参数再来覆盖"，反而更难读。
 */
export interface PicArgs {
    /**
     * 传给 `--frame` 的起始图编号；`undefined` = 不传（让后端按图集约定取第一张）。
     *
     * ★ 为什么"默认值就不传"而不是"总是传 1"：
     *   图集既可能从 0 起编号（存在 `0.<ext>`），也可能维持旧约定从 1 起，
     *   起始编号的【默认值】必须由后端按磁盘实际情况探测（见
     *   `scut_headless_main.c` 的 `pic_detect_first_index`）。
     *   插件在这里拍一个 1 传过去，会把后端的探测结果覆盖掉 ——
     *   0 起图集的第 0 张就永远轮不到。
     */
    frame?: number;
    /** 传给 `--ext` 的扩展名列表（可逗号分隔多个）；空则传 undefined。 */
    ext?: string;
    /** 传给 `--repeat` 的每帧重复次数；`<= 1` 时传 undefined（默认就是 1）。 */
    repeat?: number;
    /**
     * 传给 `--pic` 的图集目录。
     *
     * ★ 这里【不】判断它是否绝对路径、也不做任何拼接：
     *   后端（`resolve_pic_set`）已经完整处理了"绝对路径直接用 / 相对路径
     *   依次在 exe 上一级、上两级、CWD 下查找"三种情况。
     *   插件侧再判一次，就等于把同一套规则实现两遍 ——
     *   两边一旦有细微差别，就会出现"探测说有、加载却找不到"。
     */
    picDir?: string;
}

/**
 * 从工程配置推导图集运行参数。
 *
 * ★ 这个函数是**纯函数**：同样的输入必然得到同样的输出，不读磁盘、不看环境。
 *   便于单测，也便于"调试"与"运行"两条路径共用而不互相影响。
 *
 * @param cfg 工程配置（由调用方从 scut_project.json 读出；读不到请传 defaultConfig()）
 * @param picDir 图集目录的【已解析绝对路径】；为空表示不传 `--pic`，
 *               让后端按 `SCUT_PIC_DIR` / 默认约定去找。
 *               ★ 为什么不从 cfg.pic.dir 自己解析：
 *                 解析需要工程根（相对路径要拼 `root/pic/1`），
 *                 而"工程根在哪"是 detectProject() 的职责。
 *                 本文件不 import vscode，所以拿不到它 —— 由调用方传进来，
 *                 这恰好也保证了两条路径用的是【同一个】工程根。
 */
export function picArgsFromConfig(cfg: ProjectConfig, picDir?: string): PicArgs {
    const out: PicArgs = {};

    // 图集起始编号。允许 0：后端支持 0 起的图集（pic/0.png、pic/1.png…），
    // 早期版本在这里钳到 >=1，导致 0 起图集的第 0 张【永远看不到】。
    // ★ 只在用户明确设了非默认值（1）时才传，理由见 PicArgs.frame 的说明。
    const start = Math.max(0, Math.floor(cfg.pic.start || 0));
    if (start !== 1) {
        out.frame = start;
    }

    const ext = cfg.pic.ext.trim();
    if (ext.length > 0) {
        out.ext = ext;
    }

    // 每帧重复次数：>1 才有意义（后端默认就是 1）。
    const repeat = Math.max(1, Math.floor(cfg.run.processRepeat || 1));
    if (repeat > 1) {
        out.repeat = repeat;
    }

    if (picDir && picDir.length > 0) {
        out.picDir = picDir;
    }

    return out;
}

/**
 * 把 PicArgs 展开成命令行片段（顺序稳定，便于日志比对与测试断言）。
 *
 * ★ 为什么顺序要稳定：启动日志里会打印完整参数（`simsession.ts` 的
 *   `[会话] 启动：…`），顺序飘忽会让"两次启动参数是否相同"这件事
 *   只能靠肉眼逐项比对。固定顺序后，日志可直接对比。
 */
export function picArgsToArgv(a: PicArgs): string[] {
    const argv: string[] = [];
    if (a.frame !== undefined) {
        argv.push('--frame', String(a.frame));
    }
    if (a.repeat !== undefined) {
        argv.push('--repeat', String(a.repeat));
    }
    if (a.ext !== undefined) {
        argv.push('--ext', a.ext);
    }
    if (a.picDir !== undefined) {
        argv.push('--pic', a.picDir);
    }
    return argv;
}
