/**
 * toolchain.ts —— 工具链探测。
 *
 * 设计理念对照：
 *   · 上手即用     → 探测顺序里把「本机已知可用的位置」放在前面，
 *                    学生装完 LLVM-MinGW 就什么都不用配。
 *   · 代码松耦合   → 只产出 types.ts 里的 Toolchain/DoctorResult，
 *                    不 import 任何其它实现模块。
 *   · 模拟单片机   → 目标不是某个固定芯片，全部走可配置路径。
 *
 * ★ 全部面向用户的字符串都用中文，且必须是【可执行的下一步】，
 *   不是「找不到 X」这种把问题丢回给用户的说法。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import type { DoctorResult, Toolchain, ToolInfo } from './types';
import { ensureToolchain, findInstalledToolchain, currentReleaseApi, toolchainApiOverrideRejected } from './toolchainfetch';
import { pickStorageDir } from './storagedir';
import { detectProject } from './project';
import { defaultConfig, readConfig, writeConfig } from './projectconfig';

/** 探测结果缓存：activate 不能因为探测慢而卡住，所以探测是异步 + 惰性 + 只做一次。 */
let cached: Toolchain | undefined = undefined;
let inflight: Promise<Toolchain> | undefined = undefined;

/**
 * 由 activate() 注入的、VS Code 官方给的存储目录（context.globalStorageUri）。
 * 未注入时为 undefined —— 此时回落到下面的路径推导，行为与旧版一致。
 */
let injectedStorageDir: string | undefined;

/**
 * 注入插件存储目录。由 extension.ts 的 activate() 调一次。
 *
 * ★★ 为什么不直接用 context.globalStorageUri 而要走一层注入 ★★
 *   本模块的探测函数是模块级的，签名里没有 context；而调用点散在
 *   build.ts / debug.ts / extension.ts 多处。把 context 一路透传进来
 *   会改十几个签名（这正是上一版注释里说的"污染调用点"）。
 *   但那个理由不足以支撑"手拼路径"—— 因为手拼的代价更大（见下）。
 *   注入只在 activate 里做一次，调用点一个都不用改。
 *
 * ★★ 手拼 APPDATA/Code/... 的三个真实问题（本函数修的就是它们）★★
 *   ① 硬编码 'Code'：Insiders / VSCodium / Code - OSS 这些变体的
 *      globalStorage 不在 <APPDATA>\Code\ 下 —— 落到错目录或不存在的目录。
 *      而这些恰恰是学生常用的变体。
 *   ② 硬编码扩展 ID：改 publisher 或改扩展名之后，路径随之变化，
 *      用户【已下载的 165MB 工具链全部失联】，被迫重下。
 *   ③ context.globalStorageUri 本来就是干这个的，且 VS Code 保证
 *      "按扩展隔离、升级时保留"这两条性质 —— 与我们要的语义完全一致。
 */
export function setGlobalStorageDir(dir: string | undefined): void {
    injectedStorageDir = (dir && dir.length > 0) ? dir : undefined;
}

/**
 * 旧版的路径推导（手拼 APPDATA）。**只在激活时没拿到 context 时**才用。
 *
 * ★ 保留它而不是删掉：它是"注入失败"时的兜底 ——
 *   宁可下到一个可能不理想但可用的目录，也不要因为拿不到路径就
 *   放弃"到手即用"（与 detectToolchain 一贯的降级取向一致）。
 */
function legacyGlobalStorageDir(): string {
    const appData = process.env.APPDATA;
    if (appData) {
        return path.join(appData, 'Code', 'User', 'globalStorage',
                         'scut-racing.scut-71-vision-studio');
    }
    return path.join(os.tmpdir(), 'scut71-toolchain');
}

/**
 * 实际使用的工具链存储目录。
 *
 * ★ 决策逻辑（三选一）抽在 storagedir.ts 的 pickStorageDir 里 ——
 *   那个文件不 import 任何模块，所以三条分支能被普通 Node 测试覆盖
 *   （见 tests/extension_smoke.js）。这里只负责把参数凑齐。
 *
 * ★★ 向后兼容（这条很重要，不然老用户要重下 165MB）★★
 *   从"手拼路径"切到"官方目录"时，老用户已经下好的工具链在【旧】目录里，
 *   所以 pickStorageDir 里有"旧目录里有就继续用"这一条。
 */
function effectiveStorageDir(): string {
    return pickStorageDir({
        injected: injectedStorageDir,
        legacy: legacyGlobalStorageDir(),
        hasToolchain: (dir) => findInstalledToolchain(dir) !== undefined,
    });
}

/** 版本探测的超时。★ 必须有超时：任何一次 getWindowsDirectory 之类的系统调用
 *  卡住都会让整个扩展宿主挂起，学生只会看到「插件没反应」。 */
const PROBE_TIMEOUT_MS = 6000;

/**
 * 找不到工具链时问用户怎么办 —— 而不是替他决定。
 *
 * ★ 为什么必须问 ★
 *   每个人把工具链装在哪都不一样，插件猜不出来。
 *   而且"下载 182MB"是一个【有代价的决定】：
 *   占用磁盘、耗流量、可能要等几分钟，还会让已有的那份闲置。
 *   插件擅自做这个决定，就是把用户的机器当成自己的。
 *
 * ★ 为什么弹窗而不是发通知 ★
 *   通知可以被忽略，而忽略之后用户会一直卡在"编译不了"却不知道为什么。
 *   这里正好是"第一次真的要编译"的时刻，用户一定在看窗口。
 */
async function promptToolchainMissing(): Promise<'pick' | 'download' | undefined> {
    const pick = '指定已有的工具链';
    const dl = '帮我下载一份（约 165MB，只需一次）';

    /* ★★ 下载源必须【如实写出来】（诚实性要求，不是装饰）★★
     *
     *   这个动作会从网络取回一个二进制包并解压，其中的 clang.exe
     *   随后会被用来编译用户代码 —— 等价于"执行从网上拿来的程序"。
     *
     *   而 llvm-mingw 官方 release **不发布校验和**，所以插件做不到
     *   "下载后校验完整性"。既然无法用校验来保证，就必须让用户
     *   【知道自己在信任谁】—— 至少他能看出源是不是被改过、
     *   或者自己先去核对一次。
     *
     *   静默从某个 URL 下载几百 MB 并执行，是不可接受的默认行为。 */
    let source = `下载源：${currentReleaseApi()}\n`;
    if (toolchainApiOverrideRejected()) {
        source = '★ 你设置了 SCUT71_TOOLCHAIN_API，但它不是 https 地址，'
               + '出于安全已忽略（会从这里下载可执行文件）。\n'
               + `实际下载源：${currentReleaseApi()}\n`;
    }

    const choice = await vscode.window.showWarningMessage(
        '没有找到编译工具链（需要 LLVM-MinGW 的 clang）。',
        { modal: true, detail:
            '已经装过了？直接指定它的目录即可，不用重新下载。\n\n'
            + '指定时选【里面含有 bin 子目录的那一层】，'
            + '也就是能直接看到 bin\\clang.exe 的上一级目录。\n\n'
            + '还没有？那可以帮你下载一份到插件目录，'
            + '解压开就能用，全程只需要一次。\n\n'
            + source
            + '（上游 llvm-mingw 不发布校验和，插件无法校验下载内容；'
            + '如需自定义源，设环境变量 SCUT71_TOOLCHAIN_API 为一个 https 地址。）' },
        pick,
        dl,
    );
    if (choice === pick) { return 'pick'; }
    if (choice === dl) { return 'download'; }
    return undefined;
}

/** 让用户挑一个工具链根目录。返回 '' 表示取消。 */
async function pickToolchainFolder(): Promise<string> {
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '选择工具链根目录',
        title: '选择 LLVM-MinGW 目录（里面应有 bin\\clang.exe）',
    });
    return picked && picked.length > 0 ? picked[0].fsPath : '';
}

/**
 * 工具链根目录兜底候选。
 *
 * ★★★ 这里曾经是一条开发机的绝对路径，2026-10-11 被我删掉，2026-10-11 又被要求加回来 ★★★
 *   两次都是错的。反复的真实情况是：
 *
 *     ① 只留开发机路径   → 换个机器就必然落空，开始下载 182MB（用户实测）
 *     ② 只留"通用位置"  → 开发机自己反而开始下载（用户实测）
 *
 *   两种写法都在赌"我知道别人把工具链装在哪"。而这个信息【本来就不该猜】——
 *   每个人的安装位置都不一样，装在哪是用户自己的决定。
 *
 * ★ 所以这里【不猜任何盘符目录】 ★
 *   探测链条只保留三种可信来源：
 *     ① 用户在插件配置面板里显式指定（工具链 › 工具链根目录，
 *     ② SCUT71_TOOLCHAIN 环境变量
 *     ③ PATH 上真的有 clang —— 用户自己装好并确认能用的证据
 *   三者都没有 → 弹窗让用户【手动指定 or 下载】，而不是替他决定。
 *
 *   下面这个数组保留为空不是"忘了填"，是刻意的：
 *   它标出"探测链的最后一环在这里收口"，将来若要加通用位置
 *   （如 Scoop / MSYS2）也只在这一处加，不会散落到别处。
 */
const ROOT_CANDIDATES: string[] = [];

/**
 * binutils 版 objdump 的显式候选路径。
 *
 * ★ 为什么不能只信 PATH：
 *   llvm-mingw 的 bin 目录里同时有 `llvm-objdump.exe` 和一个叫 `objdump` 的
 *   【shell 脚本包装】。shutil.which('objdump') / where.exe 都可能先命中那个包装，
 *   于是拿到 LLVM 版本 —— 而 LLVM 21 已经删掉了 `--dwarf=info`
 *   （实测：`llvm-objdump: --dwarf=<value>: The only supported value is 'frames'`），
 *   自动符号发现会【静默失效】（退出码非 0，没有任何提示）。
 *   所以这里先按已知位置找真·binutils，最后才退回 PATH。
 *
 * ★ Git for Windows 自带的 MinGW-w64 是最稳的一个来源：装 Git 的人基本都有，
 *   且它带的确实是 GNU binutils。
 */
const BINUTILS_OBJDUMP_CANDIDATES = [
    'C:\\Program Files\\Git\\mingw64\\bin\\objdump.exe',
    'C:\\Program Files\\Git\\usr\\bin\\objdump.exe',
    'C:\\mingw64\\bin\\objdump.exe',
    'C:\\msys64\\mingw64\\bin\\objdump.exe',
    'C:\\msys64\\ucrt64\\bin\\objdump.exe',
];

/** 执行一次命令并拿到合并后的输出。超时/失败都不抛，返回 undefined。 */
function runCapture(exe: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
        execFile(exe, args, {
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            // 显式给编码，避免中文 Windows 上输出被按 latin1 解出乱码
            encoding: 'utf8',
        }, (err, stdout, stderr) => {
            const text = `${stdout ?? ''}${stderr ?? ''}`;
            if (err && text.length === 0) {
                resolve(undefined);
                return;
            }
            // ★ 注意：只要拿到了输出就返回，即使退出码非 0。
            //   实测 binutils 的 `objdump --version` 退出码是 0，
            //   但 `clang -v` 之类会往 stderr 写且可能非 0；把退出码当失败会误判。
            resolve(text);
        });
    });
}

/** 取版本字符串的第一行（探测失败返回 undefined，且【不】影响探测结果）。 */
async function probeVersion(exe: string, args: string[] = ['--version']): Promise<string | undefined> {
    const out = await runCapture(exe, args);
    if (!out) {
        return undefined;
    }
    for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length > 0) {
            return t;
        }
    }
    return undefined;
}

function exists(p: string): boolean {
    try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** 在目录里按候选名找第一个存在的文件。 */
function firstExisting(dir: string, names: string[]): string | undefined {
    for (const n of names) {
        const p = path.join(dir, n);
        if (exists(p)) {
            return p;
        }
    }
    return undefined;
}

/** 把 <root> 归一成它的 bin 目录。root 本身传 bin 目录也接受。 */
function binOf(root: string): string | undefined {
    if (!root) {
        return undefined;
    }
    const r = root.replace(/^"|"$/g, '').trim();
    if (!r) {
        return undefined;
    }
    const direct = path.join(r, 'bin');
    if (fs.existsSync(direct)) {
        return direct;
    }
    if (fs.existsSync(r) && /(^|[\\/])bin$/i.test(r)) {
        return r;
    }
    return undefined;
}

/** PATH 查找（自己实现而不是靠 where.exe，少一次进程启动）。 */
function whichInPath(names: string[]): string | undefined {
    const raw = process.env.PATH ?? '';
    const dirs = raw.split(path.delimiter).filter((d) => d.length > 0);
    const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter((e) => e.length > 0);
    for (const dir of dirs) {
        for (const n of names) {
            const p = path.join(dir, n);
            if (exists(p)) {
                return p;
            }
            if (!path.extname(n)) {
                for (const ext of exts) {
                    const pe = path.join(dir, n + ext.toLowerCase());
                    if (exists(pe)) {
                        return pe;
                    }
                    const pu = path.join(dir, n + ext.toUpperCase());
                    if (exists(pu)) {
                        return pu;
                    }
                }
            }
        }
    }
    return undefined;
}

/**
 * 判断某个 objdump 的 `--version` 输出是不是【binutils】版。
 *
 * ★ 为什么必须靠版本串而不是文件名（本项目最关键的一条坑）：
 *   llvm-mingw 的 bin/ 里同时存在 `llvm-objdump.exe` 和【一个叫 objdump 的
 *   shell 脚本】。后者名字完全看不出问题，但它转发到 llvm-objdump，
 *   而 LLVM 21 已经移除了 `--dwarf=info`（实测报错：
 *   `llvm-objdump: --dwarf=<value>: The only supported value is 'frames'`）。
 *   一旦用错，自动符号发现会【静默失败】——退出码非 0、没有任何提示，
 *   用户只会看到变量面板一直是空的。
 *   binutils 的版本串里一定含 "GNU objdump"，LLVM 的含 "LLVM"。
 *
 * 单独抽成纯函数是为了能直接做单元测试（这条逻辑错了整个变量面板就是空的，
 * 但它藏在「探测环境」里，不抽出来几乎没法测）。
 */
export function isBinutilsObjdumpVersion(versionText: string | undefined): boolean {
    return /GNU objdump/i.test(versionText ?? '');
}

/** 判断某个 objdump 是不是 LLVM 版（用来把警告说得更具体）。 */
export function isLlvmObjdumpVersion(versionText: string | undefined): boolean {
    return /LLVM/i.test(versionText ?? '') && !isBinutilsObjdumpVersion(versionText);
}

/**
 * 找 binutils 的 objdump（不是 LLVM 的）。
 *
 * 判定标准：`objdump --version` 的第一行含 "GNU objdump"。
 * LLVM 版会输出 "LLVM version ..."。这一条判定比看文件名叫 objdump 可靠得多 ——
 * llvm-mingw 里那个 `objdump` 就是脚本，文件名完全看不出问题。
 */
async function findBinutilsObjdump(): Promise<{ path?: string; version?: string; sawLlmObjdump: boolean }> {
    const tried = new Set<string>();

    const consider = async (p: string | undefined) => {
        if (!p || tried.has(p.toLowerCase())) {
            return undefined;
        }
        tried.add(p.toLowerCase());
        const v = await probeVersion(p);
        if (isBinutilsObjdumpVersion(v)) {
            return { path: p, version: v };
        }
        return undefined;
    };

    for (const cand of BINUTILS_OBJDUMP_CANDIDATES) {
        const hit = await consider(exists(cand) ? cand : undefined);
        if (hit) {
            return { ...hit, sawLlmObjdump: false };
        }
    }

    // 工具链自带的 objdump / objdump.exe 也试一次（有些发行版确实带 binutils）
    const toolchainObjdump = whichInPath(['objdump.exe', 'objdump']);
    const hit = await consider(toolchainObjdump);
    if (hit) {
        return { ...hit, sawLlmObjdump: false };
    }

    // 到这里就没找到 binutils 版。看看是不是只存在 llvm-objdump，
    // 好给用户一句【指名道姓】的警告。
    const llvm = whichInPath(['llvm-objdump.exe', 'llvm-objdump']);
    return { sawLlmObjdump: llvm !== undefined };
}

/**
 * 读工程配置里的 pythonPath。
 *
 * ★ 为什么要这个配置（用户实测踩到的坑）★
 *   机器上装了多个 Python 时，自动探测可能挑中【旧的那个】：
 *     `py -3` 反查到的是 Python36-32 注册的 3.6.2，
 *     而 PATH 上的 python 也是 3.6，唯独真正能用的 3.12（conda）
 *     既不在 PATH 上、py 启动器也不知道 —— 探测链全断。
 *   所以给用户一个明确的入口：在配置面板里写死解释器路径。
 *   构建脚本只要求 3.7+、零第三方库，选哪个都行。
 */
function configuredPythonPath(): string {
    const project = detectProject();
    if (!project) {
        return '';
    }
    const { config } = readConfig(project.root);
    return (config ?? defaultConfig()).toolchain.pythonPath.trim();
}

/**
 * 解析出可用的 Python 解释器。
 *
 * ★ 为什么必须校验版本（实测教训）：
 *   本机 PATH 上的 `python` 是 **Python 3.6.2**，而 tools/scut_build.py
 *   第 70 行是 `from __future__ import annotations` —— 这个特性从 3.7 才有，
 *   3.6 下直接 SyntaxError 退出。所以探测时【必须看版本】，
 *   不能拿到第一个叫 python 的东西就用。
 *
 * 顺序：
 *   0) 工程配置 toolchain.pythonPath（用户在面板里指定的，最高优先级）
 *   1) SCUT71_PYTHON 环境变量（显式指定）
 *   2) 工具链 bin 下自带的 python（llvm-mingw 没有，但别的发行版可能有）
 *   3) Windows 启动器 `py -3`：它本身不是解释器，需要用
 *      `py -3 -c "import sys;print(sys.executable)"` 反查出真实 exe
 *   4) PATH 上的 python3.exe / python.exe
 *
 *   ★ 0) 和 1) 若指向了 3.6【不换候选】，直接带着警告返回 ——
 *     用户明确指定了路径，插件替他换掉等于自作主张；
 *     但必须把"这个解释器跑不动脚本"讲清楚。
 */
async function findPython(binDir: string | undefined): Promise<{ path?: string; warning?: string }> {
    const parseVer = (s: string | undefined): [number, number] | undefined => {
        const m = /Python\s+(\d+)\.(\d+)/i.exec(s ?? '');
        return m ? [Number(m[1]), Number(m[2])] : undefined;
    };

    const usable = (v: [number, number] | undefined): boolean =>
        v !== undefined && (v[0] > 3 || (v[0] === 3 && v[1] >= 7));

    const tooOld = (where: string, p: string, v: [number, number] | undefined): string =>
        `${where}指向的 Python 版本过低（${v ? v.join('.') : '无法识别'}）：${p}\n`
        + '    原因：构建脚本 tools/scut_build.py 用了 Python 3.7+ 的语法'
        + '（from __future__ import annotations），3.6 会在第 70 行直接 SyntaxError。\n'
        + '    下一步：在配置面板「工具链 › Python 解释器路径」里改成 3.7+ 的 '
        + 'python.exe（只要求 3.7+，不需要装任何第三方库；conda / python.org 的都行）。';

    // ---- 0) 工程配置：用户在面板里选的，最优先 ----
    const cfgPath = configuredPythonPath();
    if (cfgPath) {
        if (!exists(cfgPath)) {
            return {
                warning: `工程配置里指定的 Python 解释器不存在：${cfgPath}\n`
                    + '    下一步：在配置面板「工具链 › Python 解释器路径」里重新选择，'
                    + '或清空该项改用自动探测。',
            };
        }
        const v = parseVer(await probeVersion(cfgPath));
        if (usable(v)) {
            return { path: cfgPath };
        }
        return { path: cfgPath, warning: tooOld('工程配置', cfgPath, v) };
    }

    // ---- 1) 环境变量 ----
    const envc = (process.env.SCUT71_PYTHON ?? '').replace(/^"|"$/g, '').trim();
    if (envc && exists(envc)) {
        const v = parseVer(await probeVersion(envc));
        if (usable(v)) {
            return { path: envc };
        }
        return { path: envc, warning: tooOld('SCUT71_PYTHON', envc, v) };
    }

    if (binDir) {
        const local = firstExisting(binDir, ['python.exe', 'python3.exe']);
        if (local) {
            const v = parseVer(await probeVersion(local));
            if (usable(v)) {
                return { path: local };
            }
        }
    }

    // Windows 启动器：反查真实解释器路径，这样后面所有调用点都能当普通 exe 用。
    const launcher = whichInPath(['py.exe', 'py']);
    if (launcher) {
        const out = await runCapture(launcher, ['-3', '-c', 'import sys;print(sys.executable)']);
        const real = (out ?? '').trim().split(/\r?\n/).pop()?.trim();
        if (real && exists(real)) {
            const v = parseVer(await probeVersion(real));
            if (usable(v)) {
                return { path: real };
            }
        }
    }

    for (const name of ['python3.exe', 'python.exe', 'python3', 'python']) {
        const p = whichInPath([name]);
        if (!p) {
            continue;
        }
        const v = parseVer(await probeVersion(p));
        if (usable(v)) {
            return { path: p };
        }
    }

    // 一个都没有 → 说清影响，并给出两条路（自动探测失败≠只能再装一个）
    return {
        warning: '没有找到可用的 Python 3.7+ 解释器。\n'
            + '    影响：编译能跑，但【自动符号发现】用不了，变量面板会是空的。\n'
            + '    原因：构建脚本 tools/scut_build.py 用到 Python 3.7+ 的语法'
            + '（from __future__ import annotations）；'
            + '若让 3.6 去跑它，会在第 70 行直接 SyntaxError 退出，'
            + '表现为「编译莫名其妙没反应」。\n'
            + '    下一步（二选一）：\n'
            + '    ① 机器上已经有 3.7+（conda / python.org 都行）——'
            + '在配置面板「工具链 › Python 解释器路径」里选到它的 python.exe。'
            + '只要求 3.7+，不需要装任何第三方库；\n'
            + '    ② 真的没有 → 从 python.org 装 Python 3.12'
            + '（安装时勾选 Add to PATH），然后重新执行「SCUT-71: 环境自检」。',
    };
}

/**
 * 读工程配置里的 toolchain 段。
 *
 * ★ 为什么工具链路径也进了工程配置（用户 2026-10-11 明确要求）★
 *   整个插件的配置统一只留一个真值：`scut_project.json`。
 *   以前它在 VS Code 设置里（scut71.toolchain.path），而
 *   contributes.configuration 的嵌套 object 分组【不注册内层键】，
 *   于是 cfg.get('path') 永远读不到 —— 用户在设置页填了，插件看不见，
 *   而且不报错，只是静默当作没填（用户为此重装过 VS Code）。
 *   现在面板直接读写 JSON，不再经过 VS Code 那套机制，也不再有两个真值。
 *
 * ★ 代价要说清楚 ★
 *   工具链是【这台机器】的环境，放工程里意味着换台机器要重新填一次；
 *   而且【没有打开工程时读不到它】（detectProject 返回 undefined），
 *   此时下面返回空串，探测继续往下走环境变量 → PATH → 询问用户。
 *   所以"没开工程"不会崩，只是享受不到这份配置而已 ——
 *   打开工程后一切照常，而那本来就是插件的使用方式。
 *
 *   SCUT71_TOOLCHAIN 环境变量优先级最高，适合 CI 或临时换工具链。
 */
function configuredToolchainRoot(): string {
    const project = detectProject();
    if (!project) {
        return '';          // 没有工程 → 当作没配置，继续往下探测
    }
    const { config } = readConfig(project.root);
    return (config ?? defaultConfig()).toolchain.path.trim();
}

/**
 * 把用户手动选的工具链目录记进工程配置。
 *
 * 写失败【不阻断探测】—— 目录已经选对了、编译器已经找到了，
 * 这次编译能跑通；写不进去只是"下次还要再选一次"。
 * 把它当致命错误处理，等于因为存个偏好而拦住用户干活。
 */
function saveToolchainRoot(root: string, warnings: string[]): void {
    const project = detectProject();
    if (!project) {
        return;
    }
    const { config } = readConfig(project.root);
    const next = config ?? defaultConfig();
    next.toolchain.path = root;
    try {
        writeConfig(project.root, next);
    } catch (e) {
        warnings.push(
            '已找到工具链，但没能把它记进工程配置'
            + `（${e instanceof Error ? e.message : String(e)}）\n`
            + '    本次编译不受影响，下次找不到工具链时会再问你一次。');
    }
}

function detectImpl(allowDownload: boolean): Promise<Toolchain> {
    return (async () => {
        const warnings: string[] = [];
        const configured = configuredToolchainRoot();
        const envRoot = (process.env.SCUT71_TOOLCHAIN ?? '').trim();

        // ---- 1) 显式指定的位置：工程配置 > SCUT71_TOOLCHAIN ----
        // ★ 这两处是用户自己说的，可信度最高；都不在时交给下面的"问用户"。
        //   刻意不在 PATH 之前加任何猜出来的目录（猜目录被证伪过两次）。
        const roots: Array<{ root: string; from: string }> = [];
        if (configured) {
            roots.push({ root: configured, from: '工具链根目录（工程配置）' });
        }
        if (envRoot) {
            roots.push({ root: envRoot, from: 'SCUT71_TOOLCHAIN 环境变量' });
        }
        for (const r of ROOT_CANDIDATES) {
            roots.push({ root: r, from: '默认安装位置' });
        }

        let root = '';
        let rootFrom = '';
        let binDir: string | undefined;
        for (const c of roots) {
            const b = binOf(c.root);
            if (b && firstExisting(b, ['clang.exe', 'clang'])) {
                root = c.root;
                rootFrom = c.from;
                binDir = b;
                break;
            }
        }

        let cc: string | undefined;
        let cxx: string | undefined;
        let lldbDap: string | undefined;
        let clangd: string | undefined;
        let ld: string | undefined;

        if (binDir) {
            cc = firstExisting(binDir, ['clang.exe', 'clang']);
            cxx = firstExisting(binDir, ['clang++.exe', 'clang++']);
            lldbDap = firstExisting(binDir, ['lldb-dap.exe', 'lldb-dap']);
            clangd = firstExisting(binDir, ['clangd.exe', 'clangd']);
            ld = firstExisting(binDir, ['ld.lld.exe', 'ld.lld']);
        }

        if (!cc) {
            // ---- 1b) 插件之前下载过的目录 ----
            //   ★ 必须放在"问用户"之前：老用户已经装好的那份不该再问一遍。
            //   ★ 不放进上面的 roots 列表：detectImpl(false) 是激活时的只读探测，
            //     那时还没决定要不要用下载来的工具链。
            const fetched = findInstalledToolchain(effectiveStorageDir());
            const fb = fetched ? binOf(fetched) : undefined;
            if (fb && firstExisting(fb, ['clang.exe', 'clang'])) {
                root = fetched!;
                rootFrom = '插件自动下载（上次装好的）';
                binDir = fb;
                cc = firstExisting(fb, ['clang.exe', 'clang']);
                cxx = firstExisting(fb, ['clang++.exe', 'clang++']);
                lldbDap = firstExisting(fb, ['lldb-dap.exe', 'lldb-dap']);
                clangd = firstExisting(fb, ['clangd.exe', 'clangd']);
                ld = firstExisting(fb, ['ld.lld.exe', 'ld.lld']);
            }
        }

        if (!cc) {
            // ---- 2) PATH 兜底。【必须在下载之前】----
            //
            // ★★★ 2026-10-11 修掉的真 bug：下载抢在 PATH 前面 ★★★
            //   原来的顺序是「配置 → 环境变量 → 自下载 → 已知位置 → 下载 → PATH」。
            //   也就是说：只要前面全落空，【不管 PATH 上有没有 clang】，
            //   都会先去下载 182MB，PATH 那一行永远轮不到。
            //   而 PATH 是"用户自己已经装好并确认能用"的证据 ——
            //   它的可信度【高于】我们猜的一堆候选目录。
            //
            //   后果实测：明明 PATH 上有 clang（或装在候选目录里，
            //   但因为某个候选判定细节没命中），用户却在下载。
            //
            //   正确的优先级：显式配置 > 环境变量 > 候选 > PATH > 问用户。
            //   也就是【下载永远是最后手段】。
            cc = whichInPath(['clang.exe', 'clang']);
            if (cc) {
                binDir = path.dirname(cc);
                root = root || binDir;
                rootFrom = rootFrom || 'PATH';
                cxx = cxx ?? firstExisting(binDir, ['clang++.exe', 'clang++']);
                lldbDap = lldbDap ?? firstExisting(binDir, ['lldb-dap.exe', 'lldb-dap']);
                clangd = clangd ?? firstExisting(binDir, ['clangd.exe', 'clangd']);
                ld = ld ?? firstExisting(binDir, ['ld.lld.exe', 'ld.lld']);
            }
        }

        if (!cc && allowDownload) {
            // ---- 3) 本机确实没有 → 【问用户】，不替他决定 ----
            //
            // ★ 只会真正联网下载一次：上一次装好的那份在 1b) 就已经被找到。
            //
            // ★★★ 2026-10-11 用户报告的回归：明明有工具链却在下载 182MB ★★★
            //   根因是"探测失败 = 自动下载"这个设计本身：
            //   它把一个【用户的决定】（用我现成的 / 下载一份新的）
            //   偷偷替他做了。用户看到进度条时才知道，已经晚了。
            //
            // ★ 正确做法：停下来，给两个选项，让他自己选 ★
            //   ① 我已经装了 → 弹目录选择器，指定它
            //      （每个人的安装位置都不一样，插件没有资格替他猜）
            //   ② 帮我下载一份 → 确认后才下，并且说清大小
            //   ③ 取消 → 什么都不做，只在输出里说明怎么手动配置
            //
            //   ★ 为什么这次不能在 activate 之外"更聪明地猜"：
            //     猜目录这件事已经被证伪过两次（见 ROOT_CANDIDATES 注释）。
            //     与其继续猜，不如问一句 —— 一次点击比十次猜测便宜。
            const choice = await promptToolchainMissing();

            if (choice === 'pick') {
                const picked = await pickToolchainFolder();
                if (picked) {
                    const b = binOf(picked);
                    if (b && firstExisting(b, ['clang.exe', 'clang'])) {
                        root = picked;
                        rootFrom = '手动选择';
                        binDir = b;
                        cc = firstExisting(binDir, ['clang.exe', 'clang']);
                        cxx = firstExisting(binDir, ['clang++.exe', 'clang++']);
                        lldbDap = firstExisting(binDir, ['lldb-dap.exe', 'lldb-dap']);
                        clangd = firstExisting(binDir, ['clangd.exe', 'clangd']);
                        ld = firstExisting(binDir, ['ld.lld.exe', 'ld.lld']);
                        // 写回工程配置，下次不用再选。
                        // ★ 原来这里是 cfg.update('path', …)，
                        //   而那个键【从来没被注册过】，VS Code 直接抛
                        //   「没有注册配置 scut71.toolchain.path」——
                        //   用户在自检报告里看到的就是它。
                        saveToolchainRoot(picked, warnings);
                    } else {
                        warnings.push(
                            `你选择的目录里没找到 bin\\clang.exe：${picked}\n`
                            + '    提示：应该选【包含 bin 子目录的那一层】，'
                            + '也就是里面能直接看到 clang.exe 的上一级目录。');
                    }
                }
            } else if (choice === 'download') {
                const dl = await ensureToolchain(effectiveStorageDir(), () => { /* 进度已经在 withProgress 里显示 */ });
                if (dl.ok && dl.root) {
                    root = dl.root;
                    rootFrom = '插件自动下载';
                    binDir = binOf(dl.root);
                    if (binDir) {
                        cc = firstExisting(binDir, ['clang.exe', 'clang']);
                        cxx = firstExisting(binDir, ['clang++.exe', 'clang++']);
                        lldbDap = firstExisting(binDir, ['lldb-dap.exe', 'lldb-dap']);
                        clangd = firstExisting(binDir, ['clangd.exe', 'clangd']);
                        ld = firstExisting(binDir, ['ld.lld.exe', 'ld.lld']);
                    }
                    warnings.push(dl.message);
                } else {
                    warnings.push(dl.message);
                }
            }
        }

        /* ★ 原来这里的 "PATH 兜底" 块已删除。
         *   它位于下载之后，而下载只在前几步全落空时才发生，
         *   所以那段 PATH 兜底【永远不可能执行到】—— 是一段死代码。
         *   留着它会让人误以为 PATH 已经被考虑过了。
         *   PATH 兜底已挪到下载【之前】，见上面第 2 步。
         */
        cxx = cxx ?? cc;

        if (!cc) {
            warnings.push(
                '没有找到 clang 编译器，无法编译仿真程序。\n'
                + '    原因：本项目的编译器固定为 clang（LLVM-MinGW），因为它自带 MinGW sysroot，'
                + '装完即可用，不需要额外配 MSVC 或 mingw 环境。\n'
                + '    下一步（任选其一）：\n'
                + '      1) 从 github.com/mstorsjo/llvm-mingw/releases 下载 '
                + 'ucrt-x86_64 包，解压到任意目录，'
                + '再用配置面板的「工具链 › 工具链根目录」指向它（里面有 bin\\clang.exe 的那一层）；\n'
                + '      2) 把 clang 的 bin 目录加进 PATH；\n'
                + '      3) 检查网络能否连上 GitHub（自动下载走的是它的 release 接口）。');
        } else {
            // 版本探测失败【不算】探测失败，只记 undefined，不阻断流程
            const ver = await probeVersion(cc);
            if (ver && !/clang/i.test(ver)) {
                warnings.push(
                    `配置到的 C 编译器看起来不是 clang：${cc}\n`
                    + `    它自报的版本是：${ver}\n`
                    + '    下一步：确认「工具链根目录」指向的是 LLVM-MinGW 解压根目录'
                    + '（里面有 bin\\clang.exe）。');
            }
        }

        // ---- 2) objdump：必须 binutils ----
        const obj = await findBinutilsObjdump();
        if (!obj.path) {
            if (obj.sawLlmObjdump) {
                warnings.push(
                    '自动符号发现不可用：系统里只找到 llvm-objdump，没有找到 binutils 的 objdump。\n'
                    + '    原因：LLVM 21 已经【移除】了 llvm-objdump 的 --dwarf=info 选项'
                    + '（现在只支持 --dwarf=frames），而自动变量发现正是靠 `objdump --dwarf=info`'
                    + '读 DWARF 调试信息。用 llvm-objdump 会【静默失败】——退出码非 0 且没有任何提示，'
                    + '变量面板会莫名其妙地一直是空的。\n'
                    + '    影响：算法能编译能运行，但 IDE 变量面板里一个变量都不会出现。\n'
                    + '    下一步（任选其一）：\n'
                    + '      1) 安装 MinGW-w64（它自带 binutils），把它的 bin 目录加进 PATH；\n'
                    + '         最省事的一条：装了 Git for Windows 的话，它的\n'
                    + '         C:\\Program Files\\Git\\mingw64\\bin\\objdump.exe 通常就在；\n'
                    + '      2) 已经有 MinGW-w64 的话，在设置里把 objdump 指到它的 bin 目录；\n'
                    + '      3) 暂时跳过：先用 --no-watch 语义构建（本插件会自动这样做），'
                    + '仿真照常跑，只是没有变量。');
            } else {
                warnings.push(
                    '没有找到 objdump，自动符号发现不可用。\n'
                    + '    影响：算法能编译能运行，但 IDE 变量面板里一个变量都不会出现。\n'
                    + '    下一步：安装 MinGW-w64（提供 binutils 的 objdump），'
                    + '把它的 bin 目录加进 PATH，然后重新执行「SCUT-71: 环境自检」。');
            }
        }

        // ---- 3) Python ----
        const py = await findPython(binDir);
        if (py.warning) {
            warnings.push(py.warning);
        }

        // ---- 4) 可选件缺失只提示，不影响仿真 ----
        if (!lldbDap) {
            const found = whichInPath(['lldb-dap.exe', 'lldb-dap']);
            lldbDap = found;
        }
        if (!clangd) {
            const found = whichInPath(['clangd.exe', 'clangd']);
            clangd = found;
        }
        if (!lldbDap) {
            warnings.push(
                '没有找到 lldb-dap，F5 调试功能会降级。\n'
                + '    影响：编译和仿真视图都照常可用，只是没法打断点单步调试 C 代码。\n'
                + '    下一步：lldb-dap 随 LLVM-MinGW 一起发布（bin\\lldb-dap.exe）。'
                + '装好 LLVM-MinGW 后重新执行「SCUT-71: 环境自检」即可。');
        }

        const tc: Toolchain = {
            root: root || (binDir ? path.dirname(binDir) : ''),
            cc: cc ?? '',
            cxx: cxx ?? '',
            ld: ld ?? cc ?? '',
            objdump: obj.path ?? '',
            lldbDap,
            clangd,
            python: py.path,
            warnings,
        };
        if (rootFrom) {
            tc.warnings.unshift(`工具链根目录：${tc.root}（来自 ${rootFrom}）`);
        }
        return tc;
    })();
}

/**
 * 探测工具链（带缓存）。★ 永不 reject：任何异常都退化成「空工具链 + 中文警告」。
 *
 * ★ allowDownload 的语义（很重要，别去掉）：
 *     false（默认）—— 只探测本机，找不到就如实报告，【绝不联网】。
 *     true          —— 本机找不到时尝试自动下载一份精简工具链。
 *
 *   为什么默认不下载：本函数在 activate() 里被调用一次（为了把自检结论
 *   写进输出面板）。如果那里会联网，用户"装完插件第一次开 VS Code"
 *   就会莫名其妙开始下载几百 MB —— 而他此时可能只是打开了一个无关的文件夹。
 *   所以只有明确的动作（编译 / 环境自检）才允许触发下载。
 */
export function detectToolchain(allowDownload = false): Promise<Toolchain> {
    // ★ 只读探测：缓存直接复用，不需要做任何事。
    if (cached && !allowDownload) {
        return Promise.resolve(cached);
    }
    // ★ 允许下载时【直接做一次完整探测】，不与 in-flight 的只读探测合并。
    //   理由：合并需要记录"那次探测允不允许下载"，而一旦记错就会出现
    //   "刚下载完却仍报没有工具链"。下载是罕见的显式动作，
    //   多做一次探测（几百毫秒）远好过一类难查的静默错误。
    if (allowDownload) {
        return detectImpl(true)
            .catch((e: unknown) => fallbackToolchain(e))
            .then((tc) => {
                // 探测到编译器就更新缓存；没探到则保留可能的旧值（可能仍可用）
                if (tc.cc) {
                    cached = tc;
                }
                return tc;
            });
    }
    if (!inflight) {
        inflight = detectImpl(false)
            .catch((e: unknown) => fallbackToolchain(e))
            .then((tc) => {
                if (tc.cc) {
                    cached = tc;
                }
                inflight = undefined;
                return tc;
            });
    }
    return inflight;
}

/** 探测过程出意外时的兜底结果（永远返回可用的对象，不抛异常）。 */
function fallbackToolchain(e: unknown): Toolchain {
    const msg = e instanceof Error ? e.message : String(e);
    return {
        root: '', cc: '', cxx: '', ld: '', objdump: '',
        warnings: [`工具链探测过程中出现意外错误：${msg}\n`
            + '    下一步：执行「SCUT-71: 环境自检」查看详细信息，'
            + '或在配置面板里手动指定「工具链 › 工具链根目录」。'],
    };
}

/** 同步取缓存（还没探测完就返回 undefined）。供不需要等待的调用点使用。 */
export function peekToolchain(): Toolchain | undefined {
    return cached;
}

/** 清缓存（用户改了设置后重新探测）。 */
export function resetToolchainCache(): void {
    cached = undefined;
    inflight = undefined;
}

/** 环境自检：把 Toolchain 变成面向用户的诊断结果。
 *
 * ★ 允许下载：用户点「环境自检」就是想确认"能不能用"，
 *   此时发现缺工具链，顺手装好正是他期望的结果。
 *   （对比：只读探测不会下载，见 detectToolchain 的说明。） */
export async function runDoctor(): Promise<DoctorResult> {
    const tc = await detectToolchain(true);
    const lines: string[] = [];
    const errors: string[] = [];

    lines.push(`VS Code：${vscode.version}`);
    lines.push(`平台：${process.platform} ${process.arch} · Node ${process.versions.node}`);
    lines.push(`工作区：${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(未打开文件夹)'}`);
    lines.push('');

    const row = async (label: string, p: string | undefined, args?: string[]): Promise<void> => {
        if (!p) {
            lines.push(`  ✗ ${label}：未找到`);
            return;
        }
        const v = await probeVersion(p, args);
        lines.push(`  ✓ ${label}：${p}`);
        lines.push(`      ${v ?? '(版本探测失败，但不影响使用)'}`);
    };

    lines.push('【编译链】');
    await row('C 编译器 clang', tc.cc || undefined);
    await row('C++ 编译器 clang++', tc.cxx || undefined);
    if (!tc.cc) {
        errors.push('缺少 clang 编译器：无法编译仿真程序，请按下面的提示安装 LLVM-MinGW。');
    }
    lines.push('');

    lines.push('【自动符号发现】');
    await row('binutils objdump', tc.objdump || undefined);
    await row('Python（构建脚本用）', tc.python || undefined);
    if (!tc.objdump) {
        lines.push('  ! objdump 缺失 → 变量面板会是空的（仿真本身不受影响）');
    }
    lines.push('');

    lines.push('【可选增强】');
    await row('调试适配器 lldb-dap', tc.lldbDap || undefined);
    // clangd 只做「发现 + 建议」，本插件不会替你装它、也不会自己起语言服务。
    await row('语言服务 clangd（可选，用于代码补全）', tc.clangd || undefined);
    if (!tc.lldbDap) {
        lines.push('  ! lldb-dap 缺失 → F5 调试降级，编译与仿真视图照常可用');
    }
    if (!tc.clangd) {
        lines.push('  · 没找到 clangd（可选）。装了 clangd 扩展的话，它能让补全和跳转'
            + '更准；本插件不依赖它，编译与仿真照常。');
    }
    lines.push('');

    if (tc.warnings.length > 0) {
        lines.push('【需要你处理的事项】');
        for (const w of tc.warnings) {
            lines.push(`  · ${w}`);
        }
        lines.push('');
    }

    return {
        ok: errors.length === 0,
        lines,
        errors,
        toolchain: tc,
    };
}

/** 把工具链里各工具的绝对路径列成 ToolInfo（供其它模块显示/日志）。 */
export async function toolInfos(): Promise<ToolInfo[]> {
    const tc = await detectToolchain();
    const items: Array<[string, string | undefined]> = [
        ['clang', tc.cc],
        ['clang++', tc.cxx],
        ['ld', tc.ld],
        ['objdump', tc.objdump],
        ['lldb-dap', tc.lldbDap],
        ['clangd', tc.clangd],
        ['python', tc.python],
    ];
    const out: ToolInfo[] = [];
    for (const [name, p] of items) {
        if (p && exists(p)) {
            out.push({ name, path: p, version: await probeVersion(p) });
        }
    }
    return out;
}
