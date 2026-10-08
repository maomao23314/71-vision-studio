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
    // ★ allowDownload = true：编译是用户明确的动作，只有到这一刻
    //   才允许去下载工具链。只读探测（activate / 状态查询）不会走到这里，
    //   所以"刚装完插件打开 VS Code"不会莫名其妙开始下几百 MB。
    const tc = await detectToolchain(true);
    if (!tc.cc) {
        // 探测阶段已经给出了中文的"下一步"；这里再补一条醒目的失败信息，
        // 因为"点了编译却毫无反应"是最令人困惑的体验。
        const hint = tc.warnings.find((w) => w.includes('clang')) ?? tc.warnings[0] ?? '';
        return fail(started, [{
            severity: 'error',
            message: '没有可用的编译器，无法编译。'
                + (hint ? `\n    ${hint}` : '')
                + '\n    下一步：执行「SCUT-71: 环境自检」查看详细诊断。',
        }], ch);
    }

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'SCUT-71：正在编译（用户代码 -O0 可调试）',
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
                        + '    原因：仿真工程是一个含 code/ 与 scut_project.json 的文件夹，'
                        + '这里既没打开文件夹，也没在设置里指定。\n'
                        + '    下一步：用「文件 → 打开文件夹」打开你的工程，'
                        + '或者先执行「SCUT-71: 新建仿真工程」。',
                }], ch);
            }
            const dirs = projectDirs(root);
            ch.appendLine(`\n===== SCUT-71 构建 ${new Date().toLocaleString()} =====`);
            ch.appendLine(`工程目录：${root}`);
            ch.appendLine(`优化：用户代码 -O0（可调试）· 环境 -O2   自动符号发现：${options.autoWatch ? '开' : '关'}`);

            // ---- 2) 定位构建脚本 ----
            //
            // ★★ 这里刻意【只有一条】构建路径 ★★
            //
            //   以前另有一条 350 行的"内置直调"实现，作为"找不到脚本时"的兜底。
            //   它已经删掉了，理由是三条独立的证据：
            //
            //     ① 它不可达。tools/scut_build.py 是 sync-sdk.js 的必需文件，
            //        并且 package.json 的 files 里带了 sdk/**，
            //        所以正常安装的插件里一定有它。真找不到就说明安装损坏 ——
            //        那种情况下"换一套实现接着编"只会掩盖问题。
            //
            //     ② 它与新架构矛盾。新的架构里，图像尺寸契约头与接线单元
            //        都是【构建脚本生成的】；内置直调不生成它们，
            //        于是它编出来的程序必然链接失败（用户没写注册宏了）。
            //        留着它等于留一条"看起来能跑、实际必然报 undefined reference"
            //        的路径 —— 比直接报错更糟。
            //
            //     ③ 它无法同步维护。同一件事有两份实现，改一处漏一处，
            //        而这个项目的核心价值恰恰是"环境行为可预期"。
            //
            //   所以现在：找不到脚本就明确告诉用户插件安装不完整。
            progress.report({ message: '正在查找构建脚本…' });
            const sdkRoot = locateSdkRoot(root, ctx.extensionUri);
            const buildScript = sdkRoot ? path.join(sdkRoot, 'tools', 'scut_build.py') : undefined;

            if (!buildScript || !isFile(buildScript)) {
                ch.appendLine(`找不到构建脚本：${buildScript ?? '(SDK 目录未定位到)'}`);
                return fail(started, [{
                    severity: 'error',
                    message: '插件安装不完整：找不到构建脚本 tools/scut_build.py。\n'
                        + `    查找位置：${buildScript ?? '(未能定位 SDK 目录)'}\n`
                        + '    原因：构建脚本随插件一起打包，正常安装时一定存在。\n'
                        + '    下一步：重新安装插件；'
                        + '若你是从源码调试，请先在 extension/ 下执行 `npm run sync-sdk`。',
                }], ch);
            }

            ch.appendLine(`构建脚本：${buildScript}`);
            progress.report({ message: '正在调用 tools/scut_build.py…' });
            const r = await buildWithScript(buildScript, dirs, options, tc, token, ch);
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
 * 用运行期注册表（exe --list-vars）补全编译期清单。
 *
 * ★ 补全的是什么：
 *   编译期 .vars.json 来自 DWARF 自动发现，只含编译器能看到的全局量。
 *   用户手写 SCUT_WATCH_SCALAR 注册的【结构体成员】（典型：m7_0_data.lane_status，
 *   DWARF 里是不透明的 <104B>）编译期拿不到独立条目，但运行期注册表里有。
 *   不补全的话这些量面板里根本不存在。
 *
 * ★★ 怎么区分「主动暴露」与「自动捕获」★★
 *   判据来自 scut_symbols.py 的**源码扫描**：用户在 code/ 下亲手写了
 *   SCUT_Watch / SCUT_WATCH_SCALAR → 主动暴露；没写 → 自动捕获。
 *   清单里以 `manual` 字段带过来。
 *
 *   ★ 曾经用"运行期注册表 减 编译期 DWARF"当判据，那【是错的】：
 *     实测真实工程上两边 42 个变量完全重合，差集恒为空 → 主动暴露永远 0 个。
 *     因为自动发现生成的包装单元调用的也是 SCUT_Watch，与手写的进同一张
 *     注册表；注册表只有"名字/地址/类型"，没有"这行代码谁写的"。
 *     唯一可靠的区分点是源码（手写的在 code/，生成的只在 .scut/gen/）。
 *
 * 失败不致命：拿不到就退回编译期清单，只是少几个结构体成员。
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

        // 编译期已有的名字（DWARF 能看到的全局量）
        const known = new Set((manifest?.variables ?? []).map((v) => v.name));

        // ★ 用户手写注册的名字（scut_symbols.py 扫源码得出，跨 TU 汇总）。
        //   注意：手写注册最常见的是【结构体成员】，它在 DWARF 里没有独立条目，
        //   所以这些名字往往【不在上面那个变量数组里】，而在下面的运行期列表里。
        const manualNames = new Set(manifest?.manualWatches ?? []);

        const mark = (v: WatchedVariable): WatchedVariable =>
            ({ ...v, manual: manualNames.has(v.name) || v.manual === true });

        // 编译期清单：按是否手写分成两组，手写的排前面
        const all = (manifest?.variables ?? []).map(mark);
        const manual = all.filter((v) => v.manual);
        const auto = all.filter((v) => !v.manual);

        // 运行期有、编译期没有的条目补进来（DWARF 覆盖不到的结构体成员等）
        const extra = runtime.variables
            .filter((v) => !known.has(v.name))
            .map(mark);

        if (manual.length > 0) {
            ch.appendLine(`[变量] ${manual.length} 个是代码里主动注册的`
                + `（SCUT_Watch/SCUT_WATCH_SCALAR，恒显示）：${
                    manual.map((v) => v.name).join(', ')}`);
        }

        // 主动暴露的排前面（用户的诉求：主动在前面，两者用颜色区分）。
        // ★ manual 与 extra 必须【各自排一次】而不是先拼起来再排：
        //   手写注册最常见的是结构体成员，它们不在 DWARF 清单里、
        //   只存在于 extra 里。若不合并这两组，它们会被排到最后 ——
        //   而它们恰恰是最该置顶的那几个。
        const variables = [...manual, ...extra.filter((v) => v.manual),
            ...auto, ...extra.filter((v) => !v.manual)];
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
        '--json',
    ];
    if (tc.root) {
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
            // 主动暴露的标记（由 scut_symbols.py 扫源码得出）。
            // 缺失时按 false 处理：宁可当成自动捕获，也不要凭空显示一堆变量。
            manual: v.manual === true,
        }));
    return {
        source: typeof o.source === 'string' ? o.source : '',
        count: typeof o.count === 'number' ? o.count : variables.length,
        // 手写注册的名字（跨 TU 汇总）。缺失时给空表而不是报错：
        // 老清单没有这个字段，功能退化成"全按自动捕获"，不至于崩。
        manualWatches: Array.isArray(o.manualWatches)
            ? o.manualWatches.filter((n): n is string => typeof n === 'string')
            : [],
        variables,
    };
}

/** 供 UI 用的二进制路径（不触发构建）。 */
export function expectedExePath(projectRoot: string): string {
    return projectDirs(projectRoot).exePath;
}
