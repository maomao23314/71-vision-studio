/**
 * build.ts —— 构建编排。
 *
 * 设计理念对照：
 *   · 上手即用     → 用户按一下「编译」，不需要记住任何命令行
 *   · 代码松耦合   → 两条构建路径（官方脚本 / 内置直调）产出同一个 BuildResult，
 *                    上层完全不关心走的是哪条
 *   · 适应任意代码 → 用户 .c 走「探针编译 → 自动符号发现 → 包装单元」流水线，
 *                    不假设任何符号名
 *
 * ★ 两条路径的设计动机（来自并行开发的风险）：
 *   tools/scut_build.py 是另一个 agent 在写的。如果插件【硬依赖】它，
 *   那一方的进度就会卡住这一方。所以官方脚本存在时优先用（它更完整：
 *   并行、DWARF 偏移规范化、诊断归并），不存在时用本文件内置的直调路径。
 *   走哪条路径会明确写进 BuildResult.output，不藏着。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import type {
    BuildDiagnostic, BuildOptions, BuildResult, Toolchain, VariableManifest,
    WatchedVariable,
} from './types';
import { parseDiagnostics } from './protocol';
import { detectToolchain } from './toolchain';

/** 生成的仿真可执行文件名（与 tools/scut_build.py 的 EXE_NAME 一致）。 */
const EXE_NAME = 'scut_sim.exe';

/** 生成物目录名（与 tools/scut_build.py 的 SCUT_DIR 一致）。 */
const SCUT_DIR_NAME = '.scut';

/** 上一条构建的输出通道（供「输出」面板查看原始日志）。 */
let outputChannel: vscode.OutputChannel | undefined;

export function getBuildOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('SCUT-71 构建');
    }
    return outputChannel;
}

export function disposeBuildOutputChannel(): void {
    outputChannel?.dispose();
    outputChannel = undefined;
}

/* ==========================================================================
 *  子进程执行
 * ========================================================================== */

interface ExecResult {
    code: number | null;
    stdout: string;
    stderr: string;
    /** 合并输出（stdout + stderr），诊断解析用这个 */
    combined: string;
    spawnError?: string;
}

/**
 * 运行子进程并收集输出。
 *
 * ★ 两个必须写对的细节：
 *   1) `env` 在 Node 的 spawn 里是【替换】而不是合并（与 VS Code 的
 *      DebugAdapterExecutableOptions.env 语义相反！）。所以必须 `{...process.env, ...}`。
 *   2) 输出解码：本机工具链（clang/ld）在中文 Windows 上输出的是 GBK，
 *      Node 默认按 UTF-8 解会得到乱码。所以先按 UTF-8 走，
 *      发现替换字符再用 GBK 重解（见 decodeStream）。
 */
function decodeStream(bufs: Buffer[]): string {
    const raw = Buffer.concat(bufs);
    if (raw.length === 0) {
        return '';
    }
    const utf8 = raw.toString('utf8');
    if (!utf8.includes('\uFFFD')) {
        return utf8;
    }
    // 有替换字符 → 大概率是 GBK（中文 Windows 控制台代码页 936）
    try {
        return new TextDecoder('gbk').decode(raw);
    } catch {
        return utf8;
    }
}

function runProcess(
    exe: string,
    args: string[],
    opts: { cwd?: string; token?: vscode.CancellationToken; onLine?: (line: string) => void },
): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let done = false;
        let child: ReturnType<typeof spawn>;
        // ★ 必须先声明再给 finish 用：spawn 同步抛异常时 finish 会在
        //   tokenSub 赋值【之前】被调用，那时若用 const 就是 TDZ 错误。
        let tokenSub: vscode.Disposable | undefined;

        const finish = (code: number | null, spawnError?: string): void => {
            if (done) {
                return;
            }
            done = true;
            tokenSub?.dispose();
            const stdout = decodeStream(out);
            const stderr = decodeStream(err);
            resolve({
                code,
                stdout,
                stderr,
                combined: stderr.length > 0 ? `${stdout}\n${stderr}` : stdout,
                spawnError,
            });
        };

        try {
            child = spawn(exe, args, {
                cwd: opts.cwd,
                windowsHide: true,
                // ★ 必须展开 process.env：spawn 的 env 是替换语义
                env: { ...process.env },
            });
        } catch (e) {
            finish(null, e instanceof Error ? e.message : String(e));
            return;
        }

        tokenSub = opts.token?.onCancellationRequested(() => {
            try {
                child.kill();
            } catch {
                /* 进程可能已退出 */
            }
            finish(null, '已取消');
        });

        const feed = (chunks: Buffer[], buf: Buffer, stream: 'out' | 'err'): void => {
            chunks.push(buf);
            if (opts.onLine) {
                const text = decodeStream([buf]);
                for (const line of text.split(/\r?\n/)) {
                    if (line.trim().length > 0) {
                        opts.onLine(`${stream === 'err' ? '[stderr] ' : ''}${line}`);
                    }
                }
            }
        };

        child.stdout?.on('data', (d: Buffer) => feed(out, d, 'out'));
        child.stderr?.on('data', (d: Buffer) => feed(err, d, 'err'));
        child.on('error', (e: Error) => finish(null, e.message));
        child.on('close', (code: number | null) => finish(code));
    });
}

/* ==========================================================================
 *  路径工具
 * ========================================================================== */

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * 定位 SDK 根（里面有 core/、bind/、backends/、tools/）。
 *
 * ★ 查找顺序（以及为什么是这个顺序）：
 *
 *   1) <扩展安装目录>/sdk —— 【随 .vsix 一起打包的副本】
 *      这是常态，也是唯一【保证存在】的一份：插件安装后运行在
 *      ~/.vscode/extensions/scut-racing.scut-71-vision-studio-x.y.z/，
 *      学生机器上根本不存在"那个仓库"，磁盘上找不到任何含 core/include
 *      的目录。所以只要安装正常，就一定命中这一条。
 *
 *   2) 下面几条是【仓库 / F5 调试】才成立的回退路径：
 *      开发时扩展目录是 <repo>/extension/，SDK 在它上一级；
 *      或者学生直接把整个仓库当工作区打开。
 *      ★ 刻意排在 bundled 之后：这两条路径依赖磁盘上恰好有仓库，
 *        对"装 .vsix 的学生"永远为假；把它们放前面只会让查找绕远路，
 *        还可能误命中一个碰巧同名的、版本不对的旧仓库。
 *
 *   3) 工作区各文件夹及其上一级 —— 最后兜底，覆盖"多工程工作区"。
 *
 *   有效性判据（bundled 与磁盘候选共用）：必须同时有
 *      core/include 目录 且 bind/scut_bind.c 文件。
 *   这两个正好是构建的最小必需集：头文件用于 -I，
 *      bind 单元是唯一知道编译期尺寸的编译单元。
 */
function locateSdkRoot(projectRoot: string, extensionUri: vscode.Uri): string | undefined {
    const candidates: string[] = [
        // ① 随 .vsix 打包的 SDK（正常安装下的必经之路，必须排第一）
        path.join(extensionUri.fsPath, 'sdk'),
        // ② 以下为仓库 / F5 调试回退路径
        projectRoot,
        path.join(projectRoot, '..'),
        extensionUri.fsPath,
        path.join(extensionUri.fsPath, '..'),
    ];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(f.uri.fsPath);
        candidates.push(path.join(f.uri.fsPath, '..'));
    }
    const seen = new Set<string>();
    for (const c of candidates) {
        const abs = path.resolve(c);
        if (seen.has(abs.toLowerCase())) {
            continue;
        }
        seen.add(abs.toLowerCase());
        if (isDir(path.join(abs, 'core', 'include')) && isFile(path.join(abs, 'bind', 'scut_bind.c'))) {
            return abs;
        }
    }
    return undefined;
}

interface ProjectDirs {
    root: string;
    codeDir: string;
    picDir: string;
    scutDir: string;
    objDir: string;
    libDir: string;
    genDir: string;
    binDir: string;
    exePath: string;
}

function projectDirs(root: string): ProjectDirs {
    const scutDir = path.join(root, SCUT_DIR_NAME);
    const binDir = path.join(scutDir, 'bin');
    return {
        root,
        codeDir: path.join(root, 'code'),
        picDir: path.join(root, 'pic'),
        scutDir,
        objDir: path.join(scutDir, 'obj'),
        libDir: path.join(scutDir, 'lib'),
        genDir: path.join(scutDir, 'gen'),
        binDir,
        exePath: path.join(binDir, EXE_NAME),
    };
}

/** 递归收集 code/ 下的 .c（与 scut_build.py 的 user_sources 一致）。 */
function collectUserSources(codeDir: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                walk(p);
            } else if (e.name.toLowerCase().endsWith('.c')) {
                out.push(p);
            }
        }
    };
    walk(codeDir);
    return out;
}

function readConfigHeader(root: string): string | undefined {
    for (const name of ['scut_config.h', 'config.h']) {
        const p = path.join(root, name);
        if (isFile(p)) {
            return p;
        }
    }
    return undefined;
}

/* ==========================================================================
 *  主入口
 * ========================================================================== */

export interface BuildContext {
    extensionUri: vscode.Uri;
    /** 用户显式指定的工程目录；省略则自动识别 */
    projectRoot?: string;
}

export async function build(options: BuildOptions, ctx: BuildContext): Promise<BuildResult> {
    const started = Date.now();
    const ch = getBuildOutputChannel();
    const tc = await detectToolchain();

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `SCUT-71：正在编译（${options.mode === 'debug' ? '可调试 -O0' : '发布 -O2'}）`,
            cancellable: true,
        },
        async (progress, token): Promise<BuildResult> => {
            progress.report({ message: '正在识别工程…' });

            // ---- 1) 工程根 ----
            const root = ctx.projectRoot ?? resolveProjectRoot();
            if (!root || !isDir(root)) {
                return fail(started, [{
                    severity: 'error',
                    message: '没有找到仿真工程目录。\n'
                        + '    原因：仿真工程是一个含 code/ 与 config.h 的文件夹，'
                        + '这里既没打开文件夹，也没在设置里指定。\n'
                        + '    下一步：用「文件 → 打开文件夹」打开你的工程，'
                        + '或者先执行「SCUT-71: 新建仿真工程」。',
                }], ch);
            }
            const dirs = projectDirs(root);
            ch.appendLine(`\n===== SCUT-71 构建 ${new Date().toLocaleString()} =====`);
            ch.appendLine(`工程目录：${root}`);
            ch.appendLine(`模式：${options.mode}  自动符号发现：${options.autoWatch ? '开' : '关'}`);

            // ---- 2) 选路径：官方脚本优先 ----
            progress.report({ message: '正在查找构建脚本…' });
            const sdkRoot = locateSdkRoot(root, ctx.extensionUri);
            const buildScript = sdkRoot ? path.join(sdkRoot, 'tools', 'scut_build.py') : undefined;
            const hasScript = buildScript !== undefined && isFile(buildScript);

            if (hasScript && buildScript) {
                ch.appendLine(`构建路径：官方脚本 ${buildScript}`);
                progress.report({ message: '正在调用 tools/scut_build.py…' });
                const r = await buildWithScript(buildScript, dirs, options, tc, token, ch);
                return finishResult(r, started, ch);
            }

            ch.appendLine('构建路径：内置直调（未找到 tools/scut_build.py）');
            progress.report({ message: '正在用内置路径编译…' });
            const r = await buildDirect(dirs, sdkRoot, ctx.extensionUri, options, tc, progress, token, ch);
            return finishResult(r, started, ch);
        },
    );
}

/** 自动识别工程根（就近优先）。 */
export function resolveProjectRoot(): string | undefined {
    const candidates: string[] = [];
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === 'file') {
        candidates.push(path.dirname(active.fsPath));
    }
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(f.uri.fsPath);
    }
    for (const c of candidates) {
        let cur = path.resolve(c);
        for (let i = 0; i <= 6; i++) {
            const header = readConfigHeader(cur);
            if (header || isDir(path.join(cur, 'code'))) {
                return cur;
            }
            const parent = path.dirname(cur);
            if (parent === cur) {
                break;
            }
            cur = parent;
        }
    }
    return undefined;
}

function fail(startMs: number, diags: BuildDiagnostic[], ch: vscode.OutputChannel): BuildResult {
    for (const d of diags) {
        ch.appendLine(`ERROR: ${d.message}`);
    }
    return {
        ok: false,
        output: diags.map((d) => d.message).join('\n'),
        errors: diags,
        elapsedMs: Date.now() - startMs,
    };
}

/**
 * 用运行期注册表（exe --list-vars）补全编译期清单，并标出「主动暴露」的变量。
 *
 * ★ 为什么必须走这一步：
 *   编译期 .vars.json 来自 DWARF 自动发现，只含编译器能看到的全局量。
 *   用户用 SCUT_Watch 主动注册的变量（典型：结构体成员，DWARF 里是
 *   不透明 <104B>）【编译期不可见、运行期才注册】—— 不补全的话，
 *   后端每帧都输出 cam_err 等关键量，面板却勾不了也看不见。
 *
 * ★★ 怎么区分「主动暴露」与「自动捕获」★
 *   这正是用户要的分组依据，而且它有一个天然的客观判据：
 *
 *     编译期清单（DWARF）   = 编译器能从源码看到的全局量  → 自动捕获
 *     运行期注册表（--list-vars）中【不在编译期清单里】的那些
 *                           = 只能由 SCUT_Watch 主动注册    → 主动暴露
 *
 *   不需要用户额外标注，也不会因为改注释而失效 —— 它是两个集合的差集，
 *   有明确语义。自动捕获的变量排后面并用灰色显示。
 *
 * ★ 为什么放在 finishResult：两条构建路径（官方脚本 / 内置直调）
 *   都汇入这里，一处补全两边生效 —— 之前加在 buildDirect 里，
 *   脚本路径根本不经过它，等于没加（实测就是这样）。
 *
 * 失败不致命：拿不到就退回编译期清单，只是少几个主动注册的变量。
 */
function augmentManifestFromRuntime(
    exePath: string | undefined,
    manifest: VariableManifest | undefined,
    ch: vscode.OutputChannel,
): VariableManifest | undefined {
    if (!exePath || !isFile(exePath)) {
        return manifest;
    }
    try {
        const r = spawnSync(exePath, ['--list-vars', '--json'], {
            encoding: 'utf8', timeout: 15000, windowsHide: true,
            cwd: path.dirname(exePath),
        });
        const line = (r.stdout || '').split('\n')
            .filter((l) => l.includes('"vars"')).pop();
        if (!line) {
            return manifest;
        }
        const runtime = normalizeManifest(JSON.parse(line.trim()));
        if (!runtime || runtime.variables.length === 0) {
            return manifest;
        }

        // 编译期已有的名字 → 这些是自动捕获
        const autoNames = new Set((manifest?.variables ?? []).map((v) => v.name));

        // 运行期独有的 → 主动暴露
        const manual: WatchedVariable[] = runtime.variables
            .filter((v) => !autoNames.has(v.name))
            .map((v) => ({ ...v, manual: true }));

        const auto = (manifest?.variables ?? []).map((v) => ({ ...v, manual: false }));

        if (manual.length > 0) {
            ch.appendLine(`[变量] 其中 ${manual.length} 个是代码里主动注册的`
                + `（编译期 DWARF 看不到，通常是结构体成员）：${
                    manual.map((v) => v.name).join(', ')}`);
        }

        // 主动暴露的排前面（用户的诉求：主动在前面，两者用颜色区分）
        const variables = [...manual, ...auto];
        return { source: manifest?.source ?? runtime.source, count: variables.length, variables };
    } catch {
        return manifest;
    }
}
function finishResult(r: BuildResult, startMs: number, ch: vscode.OutputChannel): BuildResult {
    r.elapsedMs = Date.now() - startMs;
    if (r.ok) {
        ch.appendLine(`构建成功：${r.exePath ?? '(未知路径)'}  用时 ${r.elapsedMs} ms`);
        r.manifest = augmentManifestFromRuntime(r.exePath, r.manifest, ch);
        if (r.manifest) {
            ch.appendLine(`变量清单：${r.manifest.count} 个变量`);
        }
    } else {
        ch.appendLine(`构建失败（用时 ${r.elapsedMs} ms），共 ${r.errors.length} 条结构化诊断。`);
    }
    return r;
}

/* ==========================================================================
 *  路径 A：官方脚本
 * ========================================================================== */

async function buildWithScript(
    script: string,
    dirs: ProjectDirs,
    options: BuildOptions,
    tc: Toolchain,
    token: vscode.CancellationToken,
    ch: vscode.OutputChannel,
): Promise<BuildResult> {
    const r = await runBuildScript(script, dirs, options, tc, token, ch);
    return {
        ok: r.ok,
        exePath: r.exePath,
        output: `[构建路径] tools/scut_build.py\n\n${r.output}`,
        manifest: r.manifest,
        errors: r.errors,
        elapsedMs: 0,
    };
}

interface ScriptResult {
    ok: boolean;
    exePath?: string;
    output: string;
    errors: BuildDiagnostic[];
    manifest?: VariableManifest;
}

/**
 * 调用 tools/scut_build.py 并解析它的 --json 契约。
 *
 * 契约（已对真实脚本核实，见 tools/scut_build.py:1199-1218 / 1990）：
 *   stdout 上恰好一份 JSON：
 *     {ok, exePath, output, elapsedMs, errors:[{file,line,column,severity,message}], manifest}
 *   --json 时所有人类可读进度都走 stderr，所以 stderr 拿来给用户看。
 *
 * ★ 「找不到解释器」的两种处理：
 *   1) 先用插件自己探测到的 python（已经校验过 3.7+，见 toolchain.ts）；
 *   2) 再退回 Windows 启动器 `py -3`（本机实测：py -3 指向 3.12，而
 *      PATH 上的裸 `python` 是 3.6.2，跑 scut_build.py 会 SyntaxError）。
 */
async function runBuildScript(
    script: string,
    dirs: ProjectDirs,
    options: BuildOptions,
    tc: Toolchain,
    token: vscode.CancellationToken,
    ch: vscode.OutputChannel,
): Promise<ScriptResult> {
    const args: string[] = [
        script,
        '--project', dirs.root,
        '--mode', options.mode,
        '--json',
    ];
    if (options.mode === 'debug' && tc.root) {
        args.push('--toolchain', tc.root);
    }
    if (!options.autoWatch) {
        args.push('--no-watch');
    }

    const attempts: Array<{ exe: string; prefix: string[] }> = [];
    if (tc.python) {
        attempts.push({ exe: tc.python, prefix: [] });
    }
    attempts.push({ exe: 'py', prefix: ['-3'] });
    if (!tc.python) {
        attempts.push({ exe: 'python', prefix: [] });
    }

    let lastHuman = '';
    for (const a of attempts) {
        ch.appendLine(`$ "${a.exe}" ${[...a.prefix, ...args].join(' ')}`);
        const r = await runProcess(a.exe, [...a.prefix, ...args], {
            cwd: dirs.root,
            token,
            onLine: (line) => {
                lastHuman = line;
                ch.appendLine(line);
            },
        });

        if (r.spawnError) {
            ch.appendLine(`  （这个解释器启动失败：${r.spawnError}，换下一个）`);
            continue;
        }
        lastHuman = r.stderr.trim() || lastHuman;

        const parsed = parseScriptJson(r.stdout);
        if (parsed) {
            if (parsed.output && parsed.output.trim().length > 0) {
                ch.appendLine('--- 构建脚本详细输出 ---');
                ch.appendLine(parsed.output);
            }
            const diags: BuildDiagnostic[] = (parsed.errors ?? []).map((d) => ({
                file: d.file ?? undefined,
                line: d.line ?? undefined,
                column: d.column ?? undefined,
                severity: (d.severity === 'error' || d.severity === 'warning'
                    ? d.severity : 'info') as BuildDiagnostic['severity'],
                message: d.message ?? '',
            }));
            // 脚本没给出结构化错误但确实失败了 → 至少把人类可读的尾巴留住，
            // 否则用户只看到「构建失败」四个字，无从下手。
            if (!parsed.ok && diags.length === 0 && lastHuman.length > 0) {
                diags.push({ severity: 'error', message: lastHuman });
            }
            return {
                ok: parsed.ok === true,
                exePath: parsed.exePath ?? undefined,
                output: `${r.stderr}\n${parsed.output ?? ''}`.trim(),
                errors: diags,
                manifest: normalizeManifest(parsed.manifest),
            };
        }

        // 没解析出 JSON。可能是 Python 语法错（说明解释器太老）
        const combined = `${r.stdout}\n${r.stderr}`;
        if (/SyntaxError/.test(combined)) {
            ch.appendLine(`  （${a.exe} 版本过旧，scut_build.py 语法不兼容，换下一个解释器）`);
            continue;
        }
        if (r.code !== 0 || combined.trim().length > 0) {
            return {
                ok: false,
                output: combined.trim(),
                errors: parseDiagnostics(combined),
            };
        }
    }

    return {
        ok: false,
        output: lastHuman,
        errors: [{
            severity: 'error',
            message: '无法运行构建脚本 tools/scut_build.py：没有找到可用的 Python 3.7+ 解释器。\n'
                + `    脚本位置：${script}\n`
                + '    原因：本机 PATH 上的 python 可能是 3.6，而脚本用了 3.7+ 的语法'
                + '（from __future__ import annotations）。\n'
                + '    下一步：安装 Python 3.12（安装时勾选 Add to PATH），'
                + '然后重新执行「SCUT-71: 环境自检」确认 Python 一项是 ✓。',
        }],
    };
}

interface ScriptJson {
    ok?: boolean;
    exePath?: string | null;
    output?: string;
    elapsedMs?: number;
    errors?: Array<{ file?: string | null; line?: number | null; column?: number | null; severity?: string; message?: string }>;
    manifest?: unknown;
}

/**
 * 从脚本 stdout 里取 JSON。
 * ★ 不能直接 JSON.parse 整个 stdout：脚本在某些异常路径上可能先吐了别的东西。
 *   做法是找第一段能解析成功的 {...}（从第一个 { 到最后一个 }）。
 */
function parseScriptJson(stdout: string): ScriptJson | undefined {
    const text = stdout.trim();
    if (text.length === 0) {
        return undefined;
    }
    const direct = tryJson(text);
    if (direct) {
        return direct;
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        const sliced = tryJson(text.slice(start, end + 1));
        if (sliced) {
            return sliced;
        }
    }
    return undefined;
}

function tryJson(text: string): ScriptJson | undefined {
    try {
        const o = JSON.parse(text) as unknown;
        if (typeof o === 'object' && o !== null && 'ok' in (o as Record<string, unknown>)) {
            return o as ScriptJson;
        }
    } catch {
        /* 不是 JSON，交给上层继续找 */
    }
    return undefined;
}

/** 把脚本给的 manifest 归一成 types.ts 的 VariableManifest（字段缺失就补默认值）。 */
function normalizeManifest(raw: unknown): VariableManifest | undefined {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.variables)) {
        return undefined;
    }
    const variables = o.variables
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .filter((v) => typeof v.name === 'string')
        .map((v) => ({
            name: v.name as string,
            kind: typeof v.kind === 'string' ? v.kind : 'SCUT_T_I32',
            dims: Array.isArray(v.dims) ? v.dims.filter((n): n is number => typeof n === 'number') : [],
            total: typeof v.total === 'number' ? v.total : 1,
            elemBytes: typeof v.elemBytes === 'number' ? v.elemBytes : 4,
            isStruct: v.isStruct === true,
            isPtr: v.isPtr === true,
            isStatic: v.isStatic === true,
            declLine: typeof v.declLine === 'string' ? v.declLine : undefined,
            defaultSelected: v.defaultSelected !== false,
        }));
    return {
        source: typeof o.source === 'string' ? o.source : '',
        count: typeof o.count === 'number' ? o.count : variables.length,
        variables,
    };
}

/* ==========================================================================
 *  路径 B：内置直调
 *
 *  这是 scut_build.py 缺席时的兜底。流水线与官方脚本一致：
 *      核心库 → bind → (用户 .c: 探针 → 符号 → 包装) → 后端 → 链接
 *  但【不】做并行、不做 DWARF 偏移规范化。
 * ========================================================================== */

/** 从 core/src/*.c 编出 libscut_core.a，或复用工程/仓库里已有的那份。 */
async function ensureCoreLib(
    dirs: ProjectDirs,
    sdkRoot: string | undefined,
    extensionUri: vscode.Uri,
    tc: Toolchain,
    base: string[],
    token: vscode.CancellationToken,
    ch: vscode.OutputChannel,
    progress: vscode.Progress<{ message?: string }>,
): Promise<{ ok: true; lib: string } | { ok: false; message: string }> {
    const projectLib = path.join(dirs.libDir, 'libscut_core.a');
    if (isFile(projectLib)) {
        ch.appendLine(`核心库：复用工程里已有的 ${projectLib}`);
        return { ok: true, lib: projectLib };
    }

    const repoLib = sdkRoot ? path.join(sdkRoot, '.scut-build', 'lib', 'libscut_core.a') : undefined;
    if (repoLib && isFile(repoLib)) {
        fs.mkdirSync(dirs.libDir, { recursive: true });
        fs.copyFileSync(repoLib, projectLib);
        ch.appendLine(`核心库：从 ${repoLib} 复制到工程 .scut/lib/`);
        return { ok: true, lib: projectLib };
    }

    // 都没有 → 现场编译 core/src/*.c
    if (!sdkRoot) {
        return {
            ok: false,
            message: '插件安装似乎不完整：既找不到随插件分发的 SDK，'
                + '也没找到核心库 libscut_core.a，无法继续。\n'
                + '    原因：正常安装的插件里自带一份 SDK 源码（core/、bind/、backends/、tools/），'
                + '插件就是靠它在你的机器上把 libscut_core.a 编出来的；'
                + '现在既没在插件目录里找到这份副本，'
                + '也没在工程 .scut/lib/ 下找到别人编译好的库。\n'
                + `    查找过的插件 SDK 目录：${path.join(extensionUri.fsPath, 'sdk')}\n`
                + `    工程核心库应有的位置：${projectLib}\n`
                + '    下一步：重新安装插件（在 VS Code 里执行「扩展: 从 VSIX 安装…」'
                + '重装同一个 .vsix，或先卸载再安装），装完执行「SCUT-71: 环境自检」确认；\n'
                + '    如果你是在源码里 F5 调试插件，先运行 '
                + '`cd extension && npm run sync-sdk` 生成 extension/sdk/ 再试。',
        };
    }

    const coreSrcDir = path.join(sdkRoot, 'core', 'src');
    const sources = collectUserSources(coreSrcDir);
    if (sources.length === 0) {
        return {
            ok: false,
            message: `SDK 的 core/src 里没有 .c 文件：${coreSrcDir}\n`
                + '    下一步：确认 SDK 仓库结构完整（core/src/*.c 应该有一批文件）。',
        };
    }

    progress.report({ message: `正在编译核心库（${sources.length} 个文件）…` });
    const coreInclude = path.join(sdkRoot, 'core', 'include');
    const objs: string[] = [];
    for (const src of sources) {
        const obj = path.join(dirs.objDir, `core_${path.basename(src, '.c')}.o`);
        const r = await runProcess(tc.cc, [
            ...base, '-I' + coreInclude, '-c', src, '-o', obj,
        ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
        if (r.code !== 0) {
            return { ok: false, message: `核心库编译失败：\n${r.combined.trim()}` };
        }
        objs.push(obj);
    }

    const ar = whichAr(tc);
    if (!ar) {
        return {
            ok: false,
            message: '找不到 ar（静态库归档工具），无法生成核心库。\n'
                + '    下一步：它随 LLVM-MinGW 发布（bin\\llvm-ar.exe），'
                + '确认 scut71.toolchainPath 指向解压根目录。',
        };
    }
    fs.mkdirSync(dirs.libDir, { recursive: true });
    const r = await runProcess(ar, ['rcs', projectLib, ...objs], {
        cwd: dirs.root, token, onLine: (l) => ch.appendLine(l),
    });
    if (r.code !== 0) {
        return { ok: false, message: `打包核心库失败：\n${r.combined.trim()}` };
    }
    ch.appendLine(`核心库：现场编译生成 ${projectLib}`);
    return { ok: true, lib: projectLib };
}

function whichAr(tc: Toolchain): string | undefined {
    const dir = tc.cc ? path.dirname(tc.cc) : '';
    const candidates = dir
        ? ['llvm-ar.exe', 'ar.exe'].map((n) => path.join(dir, n))
        : [];
    for (const c of candidates) {
        if (isFile(c)) {
            return c;
        }
    }
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
    for (const d of pathDirs) {
        for (const n of ['llvm-ar.exe', 'ar.exe']) {
            const p = path.join(d, n);
            if (isFile(p)) {
                return p;
            }
        }
    }
    return undefined;
}

async function buildDirect(
    dirs: ProjectDirs,
    sdkRoot: string | undefined,
    extensionUri: vscode.Uri,
    options: BuildOptions,
    tc: Toolchain,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
    ch: vscode.OutputChannel,
): Promise<BuildResult> {
    const logs: string[] = [];
    const push = (s: string): void => {
        if (s.trim().length > 0) {
            logs.push(s);
            ch.appendLine(s);
        }
    };

    if (!tc.cc) {
        return {
            ok: false,
            output: tc.warnings.join('\n'),
            errors: [{
                severity: 'error',
                message: '找不到 clang 编译器，无法构建。\n'
                    + '    下一步：按「SCUT-71: 环境自检」里的提示安装 LLVM-MinGW，'
                    + '或在设置里指定 scut71.toolchainPath。',
            }],
            elapsedMs: 0,
        };
    }

    const header = readConfigHeader(dirs.root);
    if (!header) {
        return {
            ok: false,
            output: '',
            errors: [{
                severity: 'error',
                message: `工程里没有编译期契约头文件（config.h 或 scut_config.h）：${dirs.root}\n`
                    + '    原因：C 语言里数组尺寸必须是编译期常量，'
                    + '用户的 int line[SCUT_IMAGE_H] 这类声明必须能看到尺寸定义。\n'
                    + '    下一步：把 templates/starter/config.h 复制到工程根目录，'
                    + '改好 SCUT_IMAGE_W / SCUT_IMAGE_H。',
            }],
            elapsedMs: 0,
        };
    }
    if (!isDir(dirs.codeDir)) {
        return {
            ok: false,
            output: '',
            errors: [{
                severity: 'error',
                message: `工程里没有 code/ 目录：${dirs.codeDir}\n`
                    + '    下一步：把你的算法 .c 文件放进 code/，'
                    + '或从 templates/starter/code/camera.c 复制一份改。',
            }],
            elapsedMs: 0,
        };
    }
    const userSources = collectUserSources(dirs.codeDir);
    if (userSources.length === 0) {
        return {
            ok: false,
            output: '',
            errors: [{
                severity: 'error',
                message: `code/ 目录里一个 .c 文件都没有：${dirs.codeDir}\n`
                    + '    原因：仿真宿主需要用户算法注册 PROCESS 回调，没有源文件就没有算法。\n'
                    + '    下一步：把算法写进 code/*.c。',
            }],
            elapsedMs: 0,
        };
    }

    fs.mkdirSync(dirs.objDir, { recursive: true });
    fs.mkdirSync(dirs.libDir, { recursive: true });
    fs.mkdirSync(dirs.genDir, { recursive: true });
    fs.mkdirSync(dirs.binDir, { recursive: true });

    const base = ['-std=c11', '-Wall', '-Wextra'];
    const modeFlags = options.mode === 'debug' ? ['-g', '-O0'] : ['-O2', '-DNDEBUG'];
    const probeFlags = ['-g', '-O0'];      // 探针必须 -O0 -g，否则 clang 会删掉未引用的 static

    const coreInclude = sdkRoot ? path.join(sdkRoot, 'core', 'include') : undefined;
    const includeDirs: string[] = [];
    if (coreInclude) {
        includeDirs.push('-I' + coreInclude);
    }
    includeDirs.push('-I' + dirs.root, '-I' + dirs.codeDir);

    // ---- 1) 核心库 ----
    progress.report({ message: '正在准备核心库…' });
    const core = await ensureCoreLib(dirs, sdkRoot, extensionUri, tc, base, token, ch, progress);
    if (!core.ok) {
        return {
            ok: false,
            output: logs.join('\n'),
            errors: [{ severity: 'error', message: core.message }],
            elapsedMs: 0,
        };
    }

    // ---- 2) bind 单元（唯一知道编译期尺寸的地方）----
    progress.report({ message: '正在编译 bind 单元…' });
    const bindSrc = (sdkRoot ? path.join(dirs.root, 'bind', 'scut_bind.c') : '');
    const bindSource = (bindSrc && isFile(bindSrc))
        ? bindSrc
        : (sdkRoot ? path.join(sdkRoot, 'bind', 'scut_bind.c') : '');
    if (!bindSource || !isFile(bindSource)) {
        return {
            ok: false,
            output: logs.join('\n'),
            errors: [{
                severity: 'error',
                message: '插件安装似乎不完整：找不到绑定单元源码 bind/scut_bind.c。\n'
                    + '    原因：它是「唯一知道编译期图像尺寸」的编译单元，'
                    + '环境核心刻意不知道尺寸，没有它链接必然失败。'
                    + '它本应随插件一起分发。\n'
                    + `    查找过的位置：${sdkRoot ? path.join(sdkRoot, 'bind', 'scut_bind.c') : '(没有找到可用的 SDK 目录)'}\n`
                    + '    下一步：重新安装插件（在 VS Code 里执行「扩展: 从 VSIX 安装…」'
                    + '重装同一个 .vsix，或先卸载再安装）；'
                    + '如果你是在源码里 F5 调试插件，先运行 '
                    + '`cd extension && npm run sync-sdk`。',
            }],
            elapsedMs: 0,
        };
    }
    const bindObj = path.join(dirs.objDir, 'scut_bind.o');
    {
        const r = await runProcess(tc.cc, [
            ...base, ...modeFlags, ...includeDirs, '-c', bindSource, '-o', bindObj,
        ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
        push(r.combined);
        if (r.code !== 0) {
            return directFailure(logs, r.combined, 'bind 单元 scut_bind.c 编译失败');
        }
    }

    // ---- 3) 用户单元：探针 → 符号 → 包装 ----
    const symbolsTool = sdkRoot ? path.join(sdkRoot, 'tools', 'scut_symbols.py') : undefined;
    const canWatch = options.autoWatch
        && symbolsTool !== undefined && isFile(symbolsTool)
        && tc.objdump.length > 0 && tc.python !== undefined;

    const wrappedObjs: string[] = [];
    const manifests: unknown[] = [];
    let hadWatchFailure = false;

    for (let i = 0; i < userSources.length; i++) {
        const src = userSources[i];
        const flat = path.basename(src, '.c');
        progress.report({ message: `正在编译用户算法 ${i + 1}/${userSources.length}：${flat}.c` });

        if (!canWatch) {
            // 不做符号发现 → 直接编原始文件。变量面板会是空的，但算法能跑。
            const obj = path.join(dirs.objDir, `${flat}.o`);
            const r = await runProcess(tc.cc, [
                ...base, ...modeFlags, ...includeDirs, '-c', src, '-o', obj,
            ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
            push(r.combined);
            if (r.code !== 0) {
                return directFailure(logs, r.combined, `${flat}.c 编译失败`);
            }
            wrappedObjs.push(obj);
            continue;
        }

        // 3a) 探针编译（-g -O0，保证 static 全局都在 DWARF 里）
        const probeObj = path.join(dirs.objDir, `${flat}.probe.o`);
        const pr = await runProcess(tc.cc, [
            ...base, ...probeFlags, ...includeDirs, '-c', src, '-o', probeObj,
        ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
        push(pr.combined);
        if (pr.code !== 0) {
            return directFailure(logs, pr.combined, `${flat}.c 探针编译失败`);
        }

        // 3b) 自动符号发现 → 包装单元 + 清单
        const wrappedSrc = path.join(dirs.genDir, `${flat}.wrapped.c`);
        const manifestPath = path.join(dirs.genDir, `${flat}.vars.json`);
        const sr = await runProcess(tc.python as string, [
            symbolsTool as string,
            '--obj', probeObj,
            '--src', src,
            '--out-c', wrappedSrc,
            '--out-json', manifestPath,
            '--objdump', tc.objdump,
        ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
        push(sr.combined);
        if (sr.code !== 0 || !isFile(wrappedSrc)) {
            hadWatchFailure = true;
            push(`[提示] ${flat}.c 的自动符号发现失败，已退回直接编译该文件（它里面的变量不会出现在变量面板）。`);
            const obj = path.join(dirs.objDir, `${flat}.o`);
            const r = await runProcess(tc.cc, [
                ...base, ...modeFlags, ...includeDirs, '-c', src, '-o', obj,
            ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
            push(r.combined);
            if (r.code !== 0) {
                return directFailure(logs, r.combined, `${flat}.c 编译失败`);
            }
            wrappedObjs.push(obj);
            continue;
        }

        // 3c) 编译包装单元（-I 必须先指向 gen/，否则 #include "main.c" 找不到）
        const obj = path.join(dirs.objDir, `${flat}.o`);
        const r = await runProcess(tc.cc, [
            ...base, ...modeFlags, '-I' + dirs.genDir, ...includeDirs,
            '-c', wrappedSrc, '-o', obj,
        ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
        push(r.combined);
        if (r.code !== 0) {
            return directFailure(logs, r.combined, `${flat}.wrapped.c 编译失败`);
        }
        wrappedObjs.push(obj);
        if (isFile(manifestPath)) {
            try {
                manifests.push(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown);
            } catch {
                /* 清单坏了不影响构建本体 */
            }
        }
    }

    // ---- 4) 后端（提供 main 的地方）----
    progress.report({ message: '正在编译仿真宿主…' });
    const backendDirs: string[] = [];
    if (isDir(path.join(dirs.root, 'backend'))) {
        backendDirs.push(path.join(dirs.root, 'backend'));
    }
    if (sdkRoot && isDir(path.join(sdkRoot, 'backends', 'headless'))) {
        backendDirs.push(path.join(sdkRoot, 'backends', 'headless'));
    }
    if (backendDirs.length === 0) {
        return {
            ok: false,
            output: logs.join('\n'),
            errors: [{
                severity: 'error',
                message: '插件安装似乎不完整：找不到仿真宿主后端（提供 main 的地方）。\n'
                    + '    原因：环境拥有 main()，用户只注册回调；没有后端就没有入口，链接必然失败。'
                    + '它本应随插件一起分发。\n'
                    + `    查找过的位置：${sdkRoot ? path.join(sdkRoot, 'backends', 'headless') : '(没有找到可用的 SDK 目录)'}\n`
                    + '    下一步：重新安装插件（在 VS Code 里执行「扩展: 从 VSIX 安装…」'
                    + '重装同一个 .vsix，或先卸载再安装）；'
                    + '如果你是在源码里 F5 调试插件，先运行 '
                    + '`cd extension && npm run sync-sdk`。\n'
                    + '    备选：在工程的 backend/ 下放一个带 main 的 .c，插件同样会用它。',
            }],
            elapsedMs: 0,
        };
    }
    const backendObjs: string[] = [];
    for (const bdir of backendDirs) {
        for (const name of fs.readdirSync(bdir).sort()) {
            if (!name.toLowerCase().endsWith('.c')) {
                continue;
            }
            const obj = path.join(dirs.objDir, `be_${path.basename(name, '.c')}.o`);
            const r = await runProcess(tc.cc, [
                ...base, ...modeFlags, ...includeDirs, '-c', path.join(bdir, name), '-o', obj,
            ], { cwd: dirs.root, token, onLine: (l) => ch.appendLine(l) });
            push(r.combined);
            if (r.code !== 0) {
                return directFailure(logs, r.combined, `后端 ${name} 编译失败`);
            }
            backendObjs.push(obj);
        }
    }

    // ---- 5) 链接 ----
    progress.report({ message: '正在链接…' });
    const tmpExe = path.join(dirs.binDir, `${EXE_NAME}.tmp`);
    const linkArgs = [
        ...backendObjs,
        bindObj,
        ...wrappedObjs,
        '-L' + dirs.libDir,
        '-lscut_core',
        '-lm',
        '-o', tmpExe,
    ];
    const lr = await runProcess(tc.cc, linkArgs, {
        cwd: dirs.root, token, onLine: (l) => ch.appendLine(l),
    });
    push(lr.combined);
    if (lr.code !== 0) {
        const diags = parseDiagnostics(lr.combined);
        const missing = [...new Set(
            [...lr.combined.matchAll(/undefined (?:reference to|symbol:?)\s*[`'"]?([A-Za-z_]\w*)/g)]
                .map((m) => m[1]),
        )].slice(0, 8);
        if (missing.length > 0) {
            diags.unshift({
                severity: 'error',
                message: `链接失败，缺少这些符号：${missing.join('、')}\n`
                    + '    原因：它们既不在 code/*.c 里，也不在核心库 libscut_core.a 里。'
                    + '若缺的是 scut_core_init / SCUT_Watch 之类，说明核心库不是本项目的那一份。\n'
                    + '    下一步：确认 .scut/lib/libscut_core.a 来自本 SDK 的 core/，'
                    + '或者删掉它让插件重新编译核心库。',
            });
        }
        return {
            ok: false,
            output: logs.join('\n'),
            errors: diags.length > 0 ? diags : [{ severity: 'error', message: '链接失败' }],
            elapsedMs: 0,
        };
    }
    if (isFile(dirs.exePath)) {
        try {
            fs.unlinkSync(dirs.exePath);
        } catch {
            /* 被占用也无所谓，rename 会失败并报出来 */
        }
    }
    try {
        fs.renameSync(tmpExe, dirs.exePath);
    } catch (e) {
        return {
            ok: false,
            output: logs.join('\n'),
            errors: [{
                severity: 'error',
                message: `无法把临时可执行文件改名到 ${dirs.exePath}：`
                    + `${e instanceof Error ? e.message : String(e)}\n`
                    + '    原因：上一次的仿真进程可能还在运行，占着这个 exe。\n'
                    + '    下一步：在仿真视图里点「停止」，或关掉正在运行的 scut_sim.exe，再重新编译。',
            }],
            elapsedMs: 0,
        };
    }

    // ---- 6) 变量清单 ----
    let manifest: VariableManifest | undefined;
    if (manifests.length > 0) {
        manifest = mergeManifests(manifests);
    } else if (canWatch && hadWatchFailure) {
        ch.appendLine('[提示] 部分文件的自动符号发现失败，变量面板可能不全。');
    }

    return {
        ok: true,
        exePath: dirs.exePath,
        output: `[构建路径] 内置直调（未找到 tools/scut_build.py）\n\n${logs.join('\n')}`,
        manifest,
        errors: parseDiagnostics(logs.join('\n')).filter((d) => d.severity !== 'info'),
        elapsedMs: 0,
    };
}

function directFailure(logs: string[], combined: string, what: string): BuildResult {
    const diags = parseDiagnostics(combined);
    return {
        ok: false,
        output: logs.join('\n'),
        errors: diags.length > 0 ? diags : [{ severity: 'error', message: what }],
        elapsedMs: 0,
    };
}

/** 把多个 .vars.json 合并成一份清单（与 scut_build.py 的 merge_manifests 语义一致）。 */
function mergeManifests(pieces: unknown[]): VariableManifest | undefined {
    const variables: VariableManifest['variables'] = [];
    const seen = new Set<string>();
    let source = '';
    for (const p of pieces) {
        const m = normalizeManifest(p);
        if (!m) {
            continue;
        }
        source = source.length === 0 ? m.source : `${source}+${m.source}`;
        for (const v of m.variables) {
            if (seen.has(v.name)) {
                continue;       // 去重：同名保留第一个
            }
            seen.add(v.name);
            variables.push(v);
        }
    }
    if (variables.length === 0) {
        return undefined;
    }
    return { source, count: variables.length, variables };
}

/** 供 UI 用的二进制路径（不触发构建）。 */
export function expectedExePath(projectRoot: string): string {
    return projectDirs(projectRoot).exePath;
}
