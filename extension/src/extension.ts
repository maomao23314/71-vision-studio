/**
 * extension.ts —— 插件激活入口与命令编排。
 *
 * 设计理念对照（每一步自检）：
 *   · 上手即用     → activate 里只【启动】探测，不等待结果，缺什么也不会崩；
 *                    用户按下第一个命令时才给中文的可执行提示
 *   · 代码松耦合   → 本文件只做「接线」：各模块自己不知道彼此的存在
 *   · 适应任意代码 → 变量靠自动发现，插件不假设任何用户符号名
 *   · 模拟单片机   → 插件不假设目标芯片，全部走可配置的工具链路径
 *
 * ★ activate() 的三条硬约束：
 *   1) 必须快。任何 await 都可能让窗口启动变慢，所以这里【不 await 探测】。
 *   2) 必须不抛。VS Code 对 activate 抛异常的处理是显示「扩展已崩溃」，
 *      用户完全不知道该怎么办；所以这里全部 try/catch，降级成警告。
 *   3) 每个 disposable 都要进 context.subscriptions，否则改设置后
 *      重复激活会叠加注册（表现为命令被执行多次）。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { BuildOptions, BuildResult, ScutProject } from './types';
import { detectToolchain, peekToolchain, resetToolchainCache, runDoctor } from './toolchain';
import { createProjectFromTemplate, describeProject, detectProject, locatePicReadme, locateTemplateDir } from './project';
import { build, disposeBuildOutputChannel, getBuildOutputChannel } from './build';

/**
 * 用户算法 SCUT_Log 的独立输出通道（VS Code 底部「输出」面板）。
 *
 * ★ 为什么是 OutputChannel 而不是侧边栏折叠区（用户原话：
 *   "我程序输出的LOG还是没有单独的窗口啊"）：
 *   OutputChannel 可搜索、可复制、可拖到底部任意高度、不占侧边栏；
 *   而且 VS Code 用户对「输出」面板有统一的心智模型。
 */
let simLogChannel: vscode.OutputChannel | undefined;
export function getSimLogChannel(): vscode.OutputChannel {
    if (!simLogChannel) {
        simLogChannel = vscode.window.createOutputChannel('SCUT-71 运行日志');
    }
    return simLogChannel;
}
export function disposeSimLogChannel(): void {
    simLogChannel?.dispose();
    simLogChannel = undefined;
}
import { SimViewProvider, SIM_VIEW_ID } from './simview';
import {
    DEBUG_TYPE,
    ScutDebugAdapterDescriptorFactory,
    ScutDebugConfigurationProvider,
} from './debug';

/** 构建产物相对工程根的路径（与 tools/scut_build.py 的 Project.exe_path 一致）。 */
function exePathOf(project: ScutProject): string {
    return path.join(project.outDir, 'bin', 'scut_sim.exe');
}

function fileExists(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function dirExists(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    // ---- 日志通道：所有「说人话」的诊断都往这里写一份，便于用户复制求助 ----
    const out = getBuildOutputChannel();
    const log = (line: string): void => {
        out.appendLine(line);
    };
    log(`SCUT-71 Vision Studio 已激活（VS Code ${vscode.version}，Node ${process.versions.node}）。`);

    // ---- 工具链探测：后台跑，不阻塞激活 ----
    // ★ 不 await：探测要 spawn 好几个进程，放在 activate 的同步路径上
    //   会让「窗口刚打开」的那几百毫秒变卡。失败也只是警告。
    void detectToolchain().then(
        (tc) => {
            for (const w of tc.warnings) {
                log(`[自检] ${w}`);
            }
            if (!tc.cc) {
                log('[自检] 没有找到 clang —— 编译功能不可用。执行「SCUT-71: 环境自检」查看怎么办。');
            } else {
                log(`[自检] clang = ${tc.cc}`);
                log(`[自检] objdump = ${tc.objdump || '(缺失，自动符号发现不可用)'}`);
                log(`[自检] python = ${tc.python ?? '(缺失，构建脚本不可用)'}`);
            }
        },
        (e: unknown) => {
            // 理论上 detectToolchain 永不 reject，这里是最后一道保险
            log(`[自检] 工具链探测出现意外错误（不影响其它功能）：${e instanceof Error ? e.message : String(e)}`);
        },
    );

    // ---- 当前工程（惰性求值：用户可能在运行中切换文件夹）----
    const projectOf = (): ScutProject | undefined => detectProject();

    // ---- 仿真视图 ----
    const simView = new SimViewProvider(context.extensionUri, {
        getExePath: (): string | undefined => {
            const p = projectOf();
            if (!p) {
                return undefined;
            }
            const exe = exePathOf(p);
            return fileExists(exe) ? exe : undefined;
        },
        getToolchainBin: (): string | undefined => {
            // ★ 用同步缓存：这里跑在消息处理的热路径上，不能 await。
            //   还没探测完就返回 undefined —— 只是子进程 PATH 少一段，
            //   不影响正确性（工具链 bin 里的 DLL 找不到才会有问题，而那种
            //   情况下用户会先看到自检提示）。
            const cached = peekToolchain();
            if (!cached) {
                return undefined;
            }
            if (cached.root) {
                const bin = path.join(cached.root, 'bin');
                if (dirExists(bin)) {
                    return bin;
                }
            }
            return cached.cc ? path.dirname(cached.cc) : undefined;
        },
        getPicDir: (): string | undefined => {
            const p = projectOf();
            return p && dirExists(p.picDir) ? p.picDir : undefined;
        },
        log,
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SIM_VIEW_ID, simView),
        // ★ 第二个视图共用同一个 provider 实例：
        //   变量面板与仿真视图需要看到【同一份】勾选状态；
        //   用两个实例会让两边勾选不同步（这是「保持简单」的刻意选择）。
        simView,
    );

    // ---- 调试：配置提供者 + 适配器工厂 ----
    // ★ 只为 scut71 这个【我们自己的】类型注册（DEBUG_TYPE 常量就是 'scut71'）。
    //   给 cppdbg / lldb 之类别人的类型注册工厂会劫走别人的调试会话 ——
    //   这是很常见的越界 bug，所以这里刻意只用常量、不写字面量。
    const debugProvider = new ScutDebugConfigurationProvider(projectOf);
    const debugFactory = new ScutDebugAdapterDescriptorFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, debugProvider),
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, debugFactory),
    );

    // ---- 命令 ----
    context.subscriptions.push(
        vscode.commands.registerCommand('scut71.doctor', () => commandDoctor()),
        vscode.commands.registerCommand('scut71.build', () => commandBuild(context, simView, projectOf, log)),
        vscode.commands.registerCommand('scut71.newProject', () => commandNewProject(context)),
        vscode.commands.registerCommand('scut71.openSimView', () => commandOpenSimView()),
        vscode.commands.registerCommand('scut71.bench', () => simView.bench()),
        vscode.commands.registerCommand('scut71.stop', () => commandStop(simView, log)),
        vscode.commands.registerCommand('scut71.prevPic', () => simView.prevPic()),
        vscode.commands.registerCommand('scut71.nextPic', () => simView.nextPic()),
        vscode.commands.registerCommand('scut71.selectVariables', () => commandSelectVariables(simView)),
    );

    // ---- 配置变化：工具链路径改了要重新探测 ----
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('scut71.toolchainPath')) {
                resetToolchainCache();
                log('[配置] scut71.toolchainPath 已变化，工具链缓存已清除，下次使用会重新探测。');
                void detectToolchain().then((tc) => {
                    log(tc.cc
                        ? `[配置] 重新探测完成：clang = ${tc.cc}`
                        : '[配置] 重新探测完成：仍然没有找到 clang。');
                });
            }
        }),
    );

    // ---- 退出时清理输出通道 ----
    context.subscriptions.push({ dispose: () => disposeBuildOutputChannel() });
        context.subscriptions.push({ dispose: () => disposeSimLogChannel() });
}

export function deactivate(): void {
    /* 无需额外清理：所有 disposables 都挂到了 context.subscriptions，
     * 仿真子进程由 SimViewProvider.dispose() 负责收尸。 */
}

/* ==========================================================================
 *  命令实现
 * ========================================================================== */

/** 取构建选项（统一从设置里读，保证命令面板与其它入口行为一致）。 */
function buildOptions(): BuildOptions {
    const cfg = vscode.workspace.getConfiguration('scut71');
    const mode = cfg.get<string>('buildMode', 'debug');
    return {
        mode: mode === 'release' ? 'release' : 'debug',
        autoWatch: cfg.get<boolean>('autoWatch', true),
    };
}

async function commandDoctor(): Promise<void> {
    const r = await runDoctor();
    const doc = await vscode.workspace.openTextDocument({
        content: formatDoctor(r.lines, r.errors),
        language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    if (!r.ok) {
        void vscode.window.showWarningMessage(
            'SCUT-71 环境自检发现问题：还有必需组件没就绪，详情见刚打开的文档。',
        );
    }
}

function formatDoctor(lines: string[], errors: string[]): string {
    const out: string[] = [];
    out.push('# SCUT-71 环境自检报告');
    out.push('');
    out.push('```text');
    for (const l of lines) {
        out.push(l);
    }
    out.push('```');
    out.push('');
    if (errors.length === 0) {
        out.push('**结论：环境就绪，可以编译并运行仿真。**');
    } else {
        out.push('## 需要处理的问题');
        out.push('');
        for (const e of errors) {
            out.push(`- ${e}`);
        }
    }
    out.push('');
    out.push('---');
    out.push('');
    out.push('> 每一项的路径与版本都来自真实探测（会实际启动对应程序取 `--version`）。');
    out.push('> 若某项显示「未找到」，直接按它下面那句话操作即可，不需要读别的文档。');
    return out.join('\n');
}

async function commandBuild(
    context: vscode.ExtensionContext,
    simView: SimViewProvider,
    projectOf: () => ScutProject | undefined,
    log: (line: string) => void,
): Promise<void> {
    const project = projectOf();
    if (!project) {
        const choice = await vscode.window.showWarningMessage(
            'SCUT-71：没有找到仿真工程（需要含 code/ 与 config.h 的文件夹）。',
            '新建工程',
            '打开文件夹',
        );
        if (choice === '新建工程') {
            await vscode.commands.executeCommand('scut71.newProject');
        } else if (choice === '打开文件夹') {
            await vscode.commands.executeCommand('workbench.action.files.openFolder');
        }
        return;
    }

    // ★ 编译前先停掉运行中的仿真进程（用户原话："按下编译的时候应该自动
    //   尝试关闭进程，否则容易出现无法写入文件"）：
    //   Windows 对正在运行的 exe 独占写锁，链接器 rename(tmp → exe)
    //   会得到 WinError 5 拒绝访问。进程不重启对用户也无感 —— 编译完
    //   本来就要重新开始。
    await simView.stop();

    const options = buildOptions();
    log(`[构建] ${describeProject(project)}（模式 ${options.mode}，自动发现 ${options.autoWatch ? '开' : '关'}）`);

    let result: BuildResult;
    try {
        result = await build(options, {
            extensionUri: context.extensionUri,
            projectRoot: project.root,
        });
    } catch (e) {
        // build() 契约上不该抛，这里兜住并给出可执行提示
        const msg = e instanceof Error ? e.message : String(e);
        log(`[构建] 出现意外异常：${msg}`);
        void vscode.window.showErrorMessage(
            `SCUT-71 编译出现意外错误：${msg}\n`
            + '    下一步：打开「输出 → SCUT-71 构建」通道查看完整日志，'
            + '并执行「SCUT-71: 环境自检」确认工具链。',
        );
        return;
    }

    simView.setBuildOutput(result.exePath, result.manifest);

    if (result.ok) {
        const n = result.manifest?.count ?? 0;
        void vscode.window.showInformationMessage(
            `SCUT-71 编译成功（${result.elapsedMs} ms）。`
            + (n > 0 ? `已发现 ${n} 个可观察变量。` : '变量清单为空，变量面板不会显示内容。'),
        );
        if (result.manifest) {
            log(`[构建] 变量清单：${result.manifest.variables.map((v) => v.name).join(', ')}`);
        }
    } else {
        const first = result.errors.find((d) => d.severity === 'error');
        const where = first?.file
            ? `${path.basename(first.file)}:${first.line ?? '?'}:${first.column ?? '?'}`
            : '';
        const choice = await vscode.window.showErrorMessage(
            `SCUT-71 编译失败${where ? `（${where}）` : ''}：`
            + `${first?.message ?? '详见输出面板'}`,
            '查看输出',
        );
        if (choice === '查看输出') {
            getBuildOutputChannel().show(true);
        }
    }
}

async function commandNewProject(context: vscode.ExtensionContext): Promise<void> {
    const template = locateTemplateDir(context.extensionUri);
    if (!template) {
        void vscode.window.showErrorMessage(
            'SCUT-71：找不到工程模板 templates/starter/。\n'
            + '    原因：模板应该随插件一起打包；若你是从源码调试插件，'
            + '请确认仓库里存在 templates/starter/config.h。\n'
            + '    下一步：重新安装插件，或从仓库的 templates/starter 手动复制。',
        );
        return;
    }

    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '在这里创建工程',
        title: 'SCUT-71：选择工程的父目录（会自动创建子文件夹）',
    });
    if (!picked || picked.length === 0) {
        return;
    }

    const name = await vscode.window.showInputBox({
        title: 'SCUT-71：工程名',
        prompt: '会在上面选的目录下创建这个子文件夹，并把模板拷进去',
        value: 'scut71-project',
        validateInput: (v) => {
            if (!v || v.trim().length === 0) {
                return '工程名不能为空';
            }
            return /[\\/:*?"<>|]/.test(v) ? '工程名不能包含 \\ / : * ? " < > | 这些字符' : undefined;
        },
    });
    if (!name) {
        return;
    }

    const target = path.join(picked[0].fsPath, name.trim());
    // ★ README-pic.txt 是可选的：找不到也照样建工程（pic/1/ 空目录仍会创建），
    //   不因为少一份说明文档就让「新建工程」整个失败。
    const r = createProjectFromTemplate(template, target, locatePicReadme(context.extensionUri));
    if (!r.ok) {
        void vscode.window.showErrorMessage(`SCUT-71：新建工程失败。\n${r.message}`);
        return;
    }

    const open = await vscode.window.showInformationMessage(
        `SCUT-71：${r.message}`,
        '在新窗口打开',
    );
    if (open === '在新窗口打开' && r.root) {
        await vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(r.root),
            { forceNewWindow: true },
        );
    }
}

async function commandOpenSimView(): Promise<void> {
    try {
        await vscode.commands.executeCommand(`${SIM_VIEW_ID}.focus`);
    } catch {
        // 视图 id 的 focus 命令在部分版本上不可用 → 退回到显示活动栏容器
        await vscode.commands.executeCommand('workbench.view.extension.scut71');
    }
}





async function commandStop(simView: SimViewProvider, log: (line: string) => void): Promise<void> {
    log('[命令] 停止仿真。');
    await simView.stop();
}

/**
 * 选择要观察的变量。
 *
 * ★ 为什么要有这个命令：
 *   「用户自由选择想看哪些变量」是本项目的硬需求，但侧边栏窄的时候
 *   逐个点复选框很费劲。这个命令用 QuickPick（多选）一次勾完，
 *   并【回写】到侧边栏的同一个 provider，保证两边状态一致。
 */
async function commandSelectVariables(simView: SimViewProvider): Promise<void> {
    const manifest = simView.getManifest();
    if (!manifest || manifest.variables.length === 0) {
        void vscode.window.showWarningMessage(
            'SCUT-71：还没有变量清单。\n'
            + '    下一步：先执行「SCUT-71: 编译仿真程序」。'
            + '若编译成功但清单仍为空，说明自动符号发现不可用'
            + '（通常是缺 binutils 的 objdump），执行「SCUT-71: 环境自检」查看原因。',
        );
        return;
    }

    const current = new Set(simView.getSelected());
    const items = manifest.variables.map((v) => ({
        label: v.name,
        description: `${(v.dims.length ? v.dims.join('×') : '标量')} · ${v.kind.replace('SCUT_T_', '')}`
            + (v.isStatic ? ' · static' : ''),
        picked: current.has(v.name),
    }));

    const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'SCUT-71：选择要观察的变量',
        placeHolder: '勾选要显示数值与曲线的变量（可搜索变量名）',
        matchOnDescription: true,
    });
    if (!picked) {
        return;
    }
    await simView.selectVariables(picked.map((p) => p.label));
    void vscode.window.showInformationMessage(
        `SCUT-71：已选择 ${picked.length} 个变量，仿真视图的变量面板已同步。`,
    );
}
