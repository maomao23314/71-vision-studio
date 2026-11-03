/**
 * buildcmd.ts —— 拼出「调用 tools/scut_build.py」的完整命令行。
 *
 * ★★ 为什么单独一个文件（本文件存在的唯一理由）★★
 *
 *   0.14.1 发布时犯过一个错：把 argv 拆成 buildArgs() 与 clean 的两段拼装时，
 *   漏掉了排在第一位的【脚本路径本身】。于是真正执行的命令是
 *
 *       python clean --project <工程> --json
 *
 *   python 把 `clean` 当成文件名去打开，报
 *       can't open file '...\clean': [Errno 2] No such file or directory
 *   —— 编译与清理【两条路一起坏】，而报错看起来像工程路径有问题。
 *
 *   漏掉的根因不是"打错一个字"，而是这段拼装【无法被测】：
 *   它在 build.ts 里，而 build.ts import 了 vscode，普通 Node 进程加载不了。
 *   所以既有的一整套测试（全部直接调用 python 脚本）没有一条覆盖
 *   "插件实际拼出来的 argv 长什么样"。
 *
 *   把拼装搬到这里之后：
 *     · 本文件【不 import 'vscode'】，可在普通 Node 进程里直接加载；
 *     · tests/test_buildcmd.js 对每条子命令断言 argv 的第 0 项是脚本路径，
 *       并且子命令排在脚本【之后】—— 那个错误会被当场抓住。
 *
 *   ★ 与 simargs.ts / storagedir.ts 是同一个思路：把"错了会静默/难归因"
 *     的纯逻辑挪到能被真实执行的地方。
 *
 * ★ 本文件不读磁盘、不碰全局状态：工程目录与选项由调用方传进来。
 */

/** 工具链里与拼装相关的字段（只取这些，避免把整个 Toolchain 类型拖进来）。 */
export interface CommandOptions {
    /** 工程根目录 */
    projectRoot: string;
    /** 工具链根目录；空串 = 不传（让脚本自己探测） */
    toolchainRoot?: string;
    /** 是否启用自动符号发现（false → 加 --no-watch） */
    autoWatch: boolean;
    /** 变量名黑名单（逗号分隔）；空/undefined = 不传 */
    watchExclude?: string;
    /** 变量元素数上限；0/undefined = 不传 */
    watchMaxElems?: number;
}

/**
 * 构建脚本支持的子命令。
 *
 * ★ 与 tools/scut_build.py 的 argparse `choices` 一一对应。
 *   加子命令时两边都要改 —— 这里列全是为了让"拼了一个脚本不认识的
 *   子命令"在类型层面就被发现（argparse 会退出码 2，但那是运行时）。
 */
export type ScriptCommand = 'build' | 'doctor' | 'clean';

/**
 * 拼出调用构建脚本的完整 argv（不含 python 解释器本身）。
 *
 * 返回值的形状是固定的三段：
 *
 *     [ <脚本路径>, <子命令?>, ...子命令自己的选项 ]
 *
 * ★ 三个必须写对的约定：
 *   1) `script` 恒为第 0 项。python 的第一个位置参数是【要执行的脚本】，
 *      不是子命令 —— 把它漏掉就会得到"去打开一个叫 clean 的文件"。
 *   2) `build` 是脚本的默认子命令，因此**不写出来**（写成显式 `build`
 *      也能工作，但日志里会多一个与默认值相同的参数，误导排查）。
 *      `doctor` / `clean` 必须显式写，而且必须在脚本【之后】。
 *   3) `--json` 恒传：插件只走 JSON 契约这条路，人类可读输出走 stderr，
 *      由 runScript 转发进输出面板。不传的话 stdout 会混进进度文字，
 *      parseScriptJson 只能靠"找第一段能解析的 {...}"去猜。
 */
export function buildScriptArgs(
    script: string,
    command: ScriptCommand,
    opts: CommandOptions,
): string[] {
    const args: string[] = [script];
    // ★ 只有非默认子命令才写出来（见上面第 2 条）。
    if (command !== 'build') {
        args.push(command);
    }
    args.push('--project', opts.projectRoot, '--json');

    // ★★ 清理不需要任何编译器相关的选项 —— 它只删目录。★★
    //   这里【必须提前返回，而且必须在 --toolchain 之前】。
    //   踩过一次：提前返回写在 --toolchain 之后，于是 clean 的 argv 里
    //   照样带着 --toolchain，和注释里"clean 不带无关选项"正好相反。
    //   "无意义的参数出现在日志里"是排查时最容易误导人的东西：
    //   用户会以为清理的行为受工具链影响。
    if (command === 'clean') {
        return args;
    }

    // ★ 只有非空才传 --toolchain：空串传给脚本等于"没指定"，
    //   但显式传一个空的 --toolchain 会让日志里出现一个误导性的参数。
    if (opts.toolchainRoot) {
        args.push('--toolchain', opts.toolchainRoot);
    }
    if (!opts.autoWatch) {
        args.push('--no-watch');
    }
    // 变量发现的两个过滤器（可选）。
    if (opts.watchExclude && opts.watchExclude.trim().length > 0) {
        args.push('--exclude', opts.watchExclude.trim());
    }
    if (opts.watchMaxElems && opts.watchMaxElems > 0) {
        args.push('--max-elems', String(opts.watchMaxElems));
    }
    return args;
}
