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
import { execFile } from 'child_process';
import type { DoctorResult, Toolchain, ToolInfo } from './types';

/** 探测结果缓存：activate 不能因为探测慢而卡住，所以探测是异步 + 惰性 + 只做一次。 */
let cached: Toolchain | undefined = undefined;
let inflight: Promise<Toolchain> | undefined = undefined;

/** 版本探测的超时。★ 必须有超时：任何一次 getWindowsDirectory 之类的系统调用
 *  卡住都会让整个扩展宿主挂起，学生只会看到「插件没反应」。 */
const PROBE_TIMEOUT_MS = 6000;

/**
 * 工具链根目录兜底候选（与 tools/scut_build.py 的 TOOLCHAIN_ROOT_CANDIDATES 保持一致）。
 *
 * ★ 为什么可以在最后一步用「已知位置」而不是全靠 PATH：
 *   本项目的目标用户是第一次配环境的学生。LLVM-MinGW 解压到哪个目录
 *   在文档里是写死的（D:\TOOLS\llvm-mingw），照着文档做的人不该
 *   因为「没配 PATH」就被卡住。探测顺序仍然是
 *   设置 > 环境变量 > 已知位置 > PATH，显式配置永远优先。
 */
const ROOT_CANDIDATES = [
    'D:\\TOOLS\\llvm-mingw',
];

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
 */
const BINUTILS_OBJDUMP_CANDIDATES = [
    'D:\\TOOLS\\mingw-w64\\bin\\objdump.exe',
    'D:\\TOOLS\\Dev-Cpp\\MinGW64\\bin\\objdump.exe',
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
 * 解析出可用的 Python 解释器。
 *
 * ★ 为什么必须校验版本（实测教训）：
 *   本机 PATH 上的 `python` 是 **Python 3.6.2**，而 tools/scut_build.py
 *   第 70 行是 `from __future__ import annotations` —— 这个特性从 3.7 才有，
 *   3.6 下直接 SyntaxError 退出。所以探测时【必须看版本】，
 *   不能拿到第一个叫 python 的东西就用。
 *
 * 顺序：
 *   1) SCUT71_PYTHON 环境变量（显式指定，最高优先级）
 *   2) 工具链 bin 下自带的 python（llvm-mingw 没有，但别的发行版可能有）
 *   3) Windows 启动器 `py -3`：它本身不是解释器，需要用
 *      `py -3 -c "import sys;print(sys.executable)"` 反查出真实 exe
 *   4) PATH 上的 python3.exe / python.exe
 */
async function findPython(binDir: string | undefined): Promise<{ path?: string; warning?: string }> {
    const parseVer = (s: string | undefined): [number, number] | undefined => {
        const m = /Python\s+(\d+)\.(\d+)/i.exec(s ?? '');
        return m ? [Number(m[1]), Number(m[2])] : undefined;
    };

    const usable = (v: [number, number] | undefined): boolean =>
        v !== undefined && (v[0] > 3 || (v[0] === 3 && v[1] >= 7));

    const envc = (process.env.SCUT71_PYTHON ?? '').replace(/^"|"$/g, '').trim();
    if (envc && exists(envc)) {
        const v = parseVer(await probeVersion(envc));
        if (usable(v)) {
            return { path: envc };
        }
        return {
            path: envc,
            warning: `SCUT71_PYTHON 指向的 Python 版本过低（${v ? v.join('.') : '无法识别'}）：${envc}\n`
                + '    原因：构建脚本 tools/scut_build.py 用了 Python 3.7+ 的语法'
                + '（from __future__ import annotations），3.6 会在第 70 行直接 SyntaxError。\n'
                + '    下一步：改指到 3.7 以上的解释器，例如 '
                + 'set SCUT71_PYTHON=C:\\Python312\\python.exe ，或删掉这个变量让我们自动探测。',
        };
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

    // 一个都没有 → 明确告诉用户装什么、装完怎么办
    return {
        warning: '没有找到可用的 Python 3.7+ 解释器。\n'
            + '    影响：编译能跑，但【自动符号发现】用不了，变量面板会是空的。\n'
            + '    原因：自动发现脚本 tools/scut_symbols.py 由构建脚本调用，'
            + '而 tools/scut_build.py 用到 Python 3.7+ 的语法'
            + '（from __future__ import annotations）；'
            + '若让 3.6 去跑它，会在第 70 行直接 SyntaxError 退出，'
            + '表现为「编译莫名其妙没反应」。\n'
            + '    下一步：从 python.org 装 Python 3.12（安装时勾选 Add to PATH），'
            + '然后重新执行「SCUT-71: 环境自检」；'
            + '若你已经有 3.7+ 但不在 PATH 上，'
            + '也可以设 SCUT71_PYTHON 指向它的 python.exe。',
    };
}

function detectImpl(): Promise<Toolchain> {
    return (async () => {
        const warnings: string[] = [];
        const cfg = vscode.workspace.getConfiguration('scut71');
        const configured = (cfg.get<string>('toolchainPath', '') ?? '').trim();
        const envRoot = (process.env.SCUT71_TOOLCHAIN ?? '').trim();

        // ---- 1) 工具链根目录：配置 > 环境变量 > 已知位置 > PATH ----
        const roots: Array<{ root: string; from: string }> = [];
        if (configured) {
            roots.push({ root: configured, from: 'scut71.toolchainPath 设置' });
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
            // PATH 兜底
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
        cxx = cxx ?? cc;

        if (!cc) {
            warnings.push(
                '没有找到 clang 编译器，无法编译仿真程序。\n'
                + '    原因：本项目的编译器固定为 clang（LLVM-MinGW），因为它自带 MinGW sysroot，'
                + '装完即可用，不需要额外配 MSVC 或 mingw 环境。\n'
                + '    下一步：从 github.com/mstorsjo/llvm-mingw/releases 下载 '
                + 'ucrt-x86_64 包，解压到 D:\\TOOLS\\llvm-mingw（或任意目录），'
                + '然后在设置里把「Scut71 › Toolchain Path」指向该目录；'
                + '也可以把它的 bin 目录加进 PATH。');
        } else {
            // 版本探测失败【不算】探测失败，只记 undefined，不阻断流程
            const ver = await probeVersion(cc);
            if (ver && !/clang/i.test(ver)) {
                warnings.push(
                    `配置到的 C 编译器看起来不是 clang：${cc}\n`
                    + `    它自报的版本是：${ver}\n`
                    + '    下一步：确认 scut71.toolchainPath 指向的是 LLVM-MinGW 解压根目录'
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
                    + '      2) 已经有 Dev-C++ 的话，直接在设置里把 objdump 指到 '
                    + 'D:\\TOOLS\\Dev-Cpp\\MinGW64\\bin\\objdump.exe 所在目录也行；\n'
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

/** 探测工具链（带缓存）。★ 永不 reject：任何异常都退化成「空工具链 + 中文警告」。 */
export function detectToolchain(): Promise<Toolchain> {
    if (cached) {
        return Promise.resolve(cached);
    }
    if (!inflight) {
        inflight = detectImpl()
            .catch((e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                const fallback: Toolchain = {
                    root: '', cc: '', cxx: '', ld: '', objdump: '',
                    warnings: [`工具链探测过程中出现意外错误：${msg}\n`
                        + '    下一步：执行「SCUT-71: 环境自检」查看详细信息，'
                        + '或在设置里手动指定 scut71.toolchainPath。'],
                };
                return fallback;
            })
            .then((tc) => {
                cached = tc;
                inflight = undefined;
                return tc;
            });
    }
    return inflight;
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

/** 环境自检：把 Toolchain 变成面向用户的诊断结果。 */
export async function runDoctor(): Promise<DoctorResult> {
    const tc = await detectToolchain();
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
    await row('语言服务 clangd', tc.clangd || undefined);
    if (!tc.lldbDap) {
        lines.push('  ! lldb-dap 缺失 → F5 调试降级，编译与仿真视图照常可用');
    }
    if (!tc.clangd) {
        lines.push('  ! clangd 缺失 → 代码补全降级（本插件不依赖 clangd 也能工作）');
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
