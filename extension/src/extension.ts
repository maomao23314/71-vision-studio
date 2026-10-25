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
import { detectToolchain, peekToolchain, resetToolchainCache, runDoctor, setGlobalStorageDir } from './toolchain';
import { createProjectFromTemplate, describeProject, detectProject, locatePicReadme, locateTemplateDir } from './project';
import { build, disposeBuildOutputChannel, getBuildOutputChannel } from './build';
import {
    CONFIG_FILENAME,
    defaultConfig,
    hasHooks,
    readConfig,
    writeConfig,
} from './projectconfig';
import { showSettingsPanel } from './settingsview';
import { SimViewProvider, SIM_VIEW_ID } from './simview';
import type { ProjectInfo } from './simview';
import {
    DEBUG_TYPE,
    ScutDebugAdapterDescriptorFactory,
    ScutDebugConfigurationProvider,
} from './debug';
import { isDir, isFile } from './fsutil';

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

/** 构建产物相对工程根的路径（与 tools/scut_build.py 的 Project.exe_path 一致）。 */
function exePathOf(project: ScutProject): string {
    return path.join(project.outDir, 'bin', 'scut_sim.exe');
}

/**
 * 启动时确认工程配置存在。
 *
 * ★ 0.9.4 简化到只剩一件事：文件不存在就建一份默认的。
 *   以前还要"把 JSON 同步进 VS Code 设置界面"，那是因为设置页
 *   当时是编辑 UI。现在编辑 UI 是插件自己的面板（settingsview.ts），
 *   它直接读写 JSON，中间不再需要任何同步 ——
 *   同步步骤本身就是"两份数据可能对不上"的来源。
 */
function ensureConfigOnActivate(log: (l: string) => void): void {
    const project = detectProject();
    if (!project) {
        return;
    }
    const { config, error } = readConfig(project.root);
    if (error) {
        log(`[配置] ${error}`);
        return;
    }
    if (config) {
        log(`[配置] 工程配置来自 ${CONFIG_FILENAME}（${config.image.width}×${config.image.height}）。`);
        return;
    }
    try {
        writeConfig(project.root, defaultConfig());
        log(`[配置] 已为工程创建 ${CONFIG_FILENAME}。`);
        if (!hasHooks(defaultConfig())) {
            /* ★ 这里【不】提示"去点 ⚙ 配置本工程"—— 那个向导已删除。
             *   真正的入口是侧边栏：没填钩子时它整块换成引导页，
             *   并且只留「打开配置」一个按钮。日志只是给事后排查留痕。 */
            log('[配置] 还没有填「每帧处理函数」——侧边栏会显示引导页，点「打开配置」即可。');
        }
    } catch (e) {
        log(`[配置] 创建 ${CONFIG_FILENAME} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
}

/**
 * 「配置本工程」向导 —— **已删除**（2026-10-22）。
 *
 * ★ 为什么删：它是配置面板的【第二个入口】，而且是个半截的入口 ——
 *   只问「每帧处理函数」和「结果图数组名」两项，其余十几项仍然要去面板改。
 *   用户于是要在两套界面之间来回：向导里改一项、面板里改一项，
 *   而两者写的是同一个 scut_project.json。这正是本项目反复删的那类重复。
 *
 * ★ 它曾经的理由是"新工程只有处理函数是必填的，两个输入框比翻面板快"。
 *   这个理由现在不成立了：配置面板第一组就是「钩子函数」，点开即填；
 *   而「新建工程」已经改成把这一步直接问掉（见 commandNewProject），
 *   用户拿到手的工程本来就是配好的 —— 不存在"还需要再跑一次向导"的场景。
 */

/**
 * 数一数图集目录里有多少张能识别的图（给引导页判断"放图了没"）。
 *
 * ★ 为什么只数一层、且只认后端支持的扩展名：
 *   图集约定是 pic/<组号>/<编号>.<ext>，一个组号一层。
 *   递归数会把 pic/ 下所有组加起来，得出"有 200 张"却一张都跑不到
 *   （后端只看当前组）。只数实际会被用的那一层才对得上。
 * ★ 只认 bmp/png/jpg 之外还要认 jpg 吗：不认 —— 后端明确不支持 JPEG
 *   （见 README「已知边界」）。数进来会让用户以为"图放好了"，
 *   然后得到一张黑图。
 */
function countPictures(picDir: string): number {
    const EXTS = new Set(['.bmp', '.png']);
    const walk = (dir: string, depth: number): number => {
        if (depth > 2) {
            return 0;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return 0;
        }
        let n = 0;
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                n += walk(p, depth + 1);
            } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
                n++;
            }
        }
        return n;
    };
    return walk(picDir, 0);
}

export function activate(context: vscode.ExtensionContext): void {
    // ---- 把 VS Code 官方给的存储目录注入工具链模块 ----
    // ★ 为什么必须做：工具链模块原先手拼 <APPDATA>\Code\User\globalStorage\...
    //   路径，于是 Insiders / VSCodium / Code - OSS 会落到错目录，
    //   改扩展名后已下载的 165MB 还会失联。globalStorageUri 正是干这个的，
    //   且 VS Code 保证它"按扩展隔离、升级时保留"—— 与我们要的语义一致。
    //   （注入只在激活时做一次，探测函数的签名一个都不用改。）
    setGlobalStorageDir(context.globalStorageUri.fsPath);

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
            return isFile(exe) ? exe : undefined;
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
                if (isDir(bin)) {
                    return bin;
                }
            }
            return cached.cc ? path.dirname(cached.cc) : undefined;
        },
        getPicDir: (): string | undefined => {
            const p = projectOf();
            return p && isDir(p.picDir) ? p.picDir : undefined;
        },
        projectRoot: (): string | undefined => projectOf()?.root,
        getProjectInfo: (): ProjectInfo | undefined => {
            const p = projectOf();
            if (!p) {
                return undefined;
            }
            const { config } = readConfig(p.root);
            const cfg = config ?? defaultConfig();
            const exe = exePathOf(p);
            return {
                root: p.root,
                // ★ 判据用 hasHooks（与 ensureConfigOnActivate 的提示同一个），
                //   而不是"配置里有没有 frame 数组"：init 填了也算配好，
                //   因为构建脚本的校验就是 `init_names or frame_names`。
                hooksReady: hasHooks(cfg),
                picCount: countPictures(p.picDir),
                built: isFile(exe),
            };
        },
        log,
    });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SIM_VIEW_ID, simView),
        // ★ 把 provider 自己也算进 subscriptions：它的 dispose() 负责收掉
        //   仿真子进程，插件卸载/窗口关闭时不会留下孤儿进程。
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
        /* ★ 这里原先还有 `scut71.run`（连续跑 N 帧）。
         *   功能与「测速」重复却给不出结论，用户明确要求删掉，
         *   连同 package.json 的命令 / 菜单 / F8 键位一起删了。 */
        // ★ 独立的「调试」入口：不再只靠 F5。
        //   F5 在没有 launch.json 时要靠 VS Code 自己挑调试器，
        //   旁边还装着 cpptools（也认 C 文件），用户很容易走错 ——
        //   这里给一个"点了就调"的按钮，入口唯一且明确。
        vscode.commands.registerCommand('scut71.debug', () => commandDebug(simView, log)),
        vscode.commands.registerCommand('scut71.stop', () => commandStop(simView, log)),
        vscode.commands.registerCommand('scut71.prevPic', () => simView.prevPic()),
        vscode.commands.registerCommand('scut71.nextPic', () => simView.nextPic()),
        vscode.commands.registerCommand('scut71.gotoPic', () => commandGotoPic(simView)),
        vscode.commands.registerCommand('scut71.openSettings',
            () => commandOpenSettings(context, log)),
        vscode.commands.registerCommand('scut71.selectVariables', () => commandSelectVariables(simView)),
        vscode.commands.registerCommand('scut71.showLog', () => getSimLogChannel().show(true)),
    );

    // ---- 启动时确认工程配置存在 ----
    void ensureConfigOnActivate(log);

    /* ---- 工作区变化 → 让面板重新判断"现在该显示什么" ----
     *
     * ★ 为什么必须有这一条：用户点了引导页的「新建工程」→ 在新窗口打开，
     *   或者自己「打开文件夹」切到另一个工程。这两种情况都【不会】
     *   触发任何帧或命令，面板会一直停在旧的引导页上。
     *   监听工作区变化后补一次状态推送，面板就能自己切换过来。
     */
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => simView.refresh()),
    );

    // ★★ 0.9.4：不再监听 VS Code 设置变化 ★★
    //   配置的唯一真值是 scut_project.json，它【不在 VS Code 的配置系统里】，
    //   onDidChangeConfiguration 永远不会因为它触发。
    //   而且这段监听器本身就是"第二个真值"的产物：它在设置变化时把值
    //   落盘到 JSON，等于两边来回同步 —— 一旦哪次没同步上，
    //   就是"设置页改了但没生效"这类最难查的问题。
    //   现在改配置只有一个入口（面板），落盘也只发生在那里。
    //
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

/**
 * 取构建选项（统一从设置里读，保证命令面板与其它入口行为一致）。
 *
 * ★ 没有「构建模式」：优化等级是工程约定而非用户选项 ——
 *   用户算法恒 `-g -O0`（可调试），环境自身恒 `-O2`（跑得快）。
 *   （原来的 Scut71: Build Mode 参数只影响环境库，对用户没有意义，
 *     已按用户要求删除。）
 */
function buildOptions(projectRoot: string): BuildOptions {
    // ★ 0.9.4：配置只在 scut_project.json 里，读不到就用默认值，
    //   不再回落到 VS Code 设置 —— 回落到设置等于请回第二个真值。
    const { config } = readConfig(projectRoot);
    const cfg = config ?? defaultConfig();
    return {
        autoWatch: cfg.toolchain.autoWatch,
        // 变量发现的两个过滤器也走同一条路：插件读配置 → 进 argv。
        // （脚本侧同样会读配置兜底，但显式传参让启动日志可追溯。）
        watchExclude: cfg.toolchain.watchExclude,
        watchMaxElems: cfg.toolchain.watchMaxElems,
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

/* ============================================================================
 * 打开设置页
 * ========================================================================== */

/**
 * 打开本插件的配置面板（scut_project.json 的编辑器）。
 *
 * ★ 为什么自己画面板，而不用 VS Code 的 settings.json ★
 *   0.9.3 用的就是设置页，结果踩了三重坑：
 *     ① contributes.configuration 里的嵌套 object 分组【不注册内层键】，
 *        用户在设置页填了工具链路径，cfg.get 静默返回默认值 —— 不报错，
 *        只是"配了没用"；
 *     ② cfg.update 直接抛「没有注册配置 scut71.toolchain.path」；
 *     ③ 配置跟着用户走，不跟着工程走 —— 换机器、发给同学就丢了，
 *        而里面存着"哪个函数是处理函数"，丢了工程根本跑不起来。
 *
 *   现在配置只在 scut_project.json 里，面板是它的编辑器。
 *   面板自己不持有状态：关掉再开、窗口重载，值都还在。
 */
function commandOpenSettings(
    context: vscode.ExtensionContext,
    log: (l: string) => void,
): void {
    const project = detectProject();
    if (!project) {
        void vscode.window.showWarningMessage(
            'SCUT-71：没有找到仿真工程（需要含 code/ 的文件夹），配置按工程存放。\n'
            + '    下一步：用「文件 → 打开文件夹」打开你的工程。');
        return;
    }
    /* ★ 传 context 而不是 extensionUri：面板需要 globalState 存"自动保存"这个
     *   偏好。它是【本机本用户】的操作习惯，不属于工程配置（见 settingsview.ts）。 */
    showSettingsPanel(context, project.root, (sections) => {
        log(`[配置] 已更新：${sections.join(', ')}`);
        // 工具链改了要重新探测，否则界面还停在"未找到编译器"上。
        if (sections.includes('toolchain')) {
            resetToolchainCache();
            void detectToolchain().then((tc) => {
                log(tc.cc
                    ? `[配置] 重新探测完成：clang = ${tc.cc}`
                    : '[配置] 重新探测完成：仍然没有找到 clang。');
            });
        }
    });
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
            'SCUT-71：没有找到仿真工程（需要含 code/ 的文件夹）。',
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

    const options = buildOptions(project.root);
    log(`[构建] ${describeProject(project)}（自动发现 ${options.autoWatch ? '开' : '关'}）`);

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

/**
 * 新建工程。
 *
 * ★★ 为什么它比 0.10.8 多问了两个问题（用户原话：
 *    "目前工程到手的配置还是有点麻烦，有没有可能简化一点"）★★
 *
 *   旧流程是：选父目录 → 填工程名 → 拷模板 → 提示"去 ⚙ 面板里填处理函数"。
 *   于是新工程建出来是【跑不起来】的：模板的钩子函数名是
 *   camera_init / camera_process（模板自带的示例代码），
 *   一旦用户把自己的 camera.c 换进去，那两个名字就不存在了，
 *   编译报 `undefined reference to camera_process` —— 用户完全不知道
 *   这是配置问题，只会觉得"环境坏了"。
 *
 *   现在把这条必经之路在新建立时就问完：
 *     ① 图像尺寸（默认 188×120，回车即可）—— 它决定算法里的数组大小，
 *        换摄像头就必须改，而改晚了要连算法一起改；
 *     ② 每帧处理函数（可从代码里选）—— 唯一必填项。
 *   问完写进 scut_project.json，工程拿到手就是【能直接编译】的。
 *
 * ★ 为什么不是"建完再打开配置面板让用户自己填"：
 *   那还是两步，而且面板里十几个字段会让人以为都要填。
 *   新建时的两个问题只问"非问不可"的，其余全用默认值 ——
 *   这正是"到手即用"与"可配置"的边界。
 */
async function commandNewProject(context: vscode.ExtensionContext): Promise<void> {
    const template = locateTemplateDir(context.extensionUri);
    if (!template) {
        void vscode.window.showErrorMessage(
            'SCUT-71：找不到工程模板 templates/starter/。\n'
            + '    原因：模板应该随插件一起打包；若你是从源码调试插件，'
            + '请确认仓库里存在 templates/starter/scut_project.json。\n'
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
        title: 'SCUT-71：新建工程（1/3）工程名',
        prompt: '会在上面选的目录下创建这个子文件夹，并把模板拷进去',
        value: 'vision-project',
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

    // ---- 2/3 图像尺寸 ----
    //
    // ★ 为什么要问：它是【编译期契约】，算法里到处是 `int line[SCUT_IMAGE_H]`。
    //   默认 188×120 对应逐飞常见的 MT9V03x，换摄像头就得改。
    //   先问清楚，比让用户编译一次、看到画面错位、再去翻面板要快得多。
    const sizeRaw = await vscode.window.showInputBox({
        title: 'SCUT-71：新建工程（2/3）图像尺寸',
        prompt: '你的摄像头出图尺寸，格式 宽x高（回车用 188x120）',
        value: '188x120',
        placeHolder: '188x120',
        validateInput: (v) => {
            const m = /^\s*(\d{1,4})\s*[x×*,\s]\s*(\d{1,4})\s*$/i.exec(v);
            if (!m) {
                return '请写成 宽x高，例如 188x120';
            }
            const w = Number(m[1]);
            const h = Number(m[2]);
            if (w < 1 || w > 4096 || h < 1 || h > 4096) {
                return '宽高要在 1..4096 之间';
            }
            return undefined;
        },
    });
    if (sizeRaw === undefined) {
        return;
    }
    const mm = /^\s*(\d{1,4})\s*[x×*,\s]\s*(\d{1,4})\s*$/i.exec(sizeRaw);
    const width = mm ? Number(mm[1]) : 188;
    const height = mm ? Number(mm[2]) : 120;

    // ---- 3/3 每帧处理函数 ----
    //
    // ★ 模板里自带 camera.c，它的处理函数是 camera_process。
    //   用户如果打算【换掉】这份示例代码，那个名字就不存在了 ——
    //   所以这里给一个可留空的输入框：留空 = 用模板自带的，
    //   等用户把自己的代码放进去之后，再到面板里改成自己的（面板有候选下拉）。
    const frameFn = await vscode.window.showInputBox({
        title: 'SCUT-71：新建工程（3/3）每帧处理函数',
        prompt: '你算法的主入口函数名（回车用模板自带的 camera_process）',
        value: 'camera_process',
        placeHolder: '例如 image_process',
        validateInput: (v) => {
            const t = v.trim();
            if (t.length === 0) {
                return undefined;       // 留空 = 用模板自带的
            }
            return /^[A-Za-z_]\w*$/.test(t) ? undefined : '函数名必须是合法的 C 标识符';
        },
    });
    if (frameFn === undefined) {
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

    // ---- 把刚才问到的两项写进 scut_project.json ----
    //
    // ★ 失败不算新建失败：工程文件已经拷好了，配置写不进去只是退回默认值，
    //   用户到面板里改一样能用。所以这里只记日志、不弹错、不中断流程。
    let cfgNote = '';
    try {
        const { config } = readConfig(target);
        const base = config ?? defaultConfig();
        const next = {
            ...base,
            image: { width, height },
            hooks: {
                ...base.hooks,
                frame: frameFn.trim().length > 0 ? [frameFn.trim()] : base.hooks.frame,
            },
        };
        writeConfig(target, next);
        cfgNote = `图像 ${width}×${height}，每帧处理函数 ${next.hooks.frame.join(', ') || '(未设置)'}。`;
    } catch (e) {
        cfgNote = `配置写入失败（${e instanceof Error ? e.message : String(e)}），`
            + '请打开配置面板确认「钩子函数」那一组。';
    }

    const open = await vscode.window.showInformationMessage(
        `SCUT-71：工程已创建（${cfgNote}）`,
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





/**
 * 「调试」：显式启动一个 scut71 调试会话。
 *
 * ★ 为什么要有这个命令（用户原话："最最重要的调试功能打不开"）：
 *   之前唯一的入口是 F5，而 F5 在没有 launch.json 时要由 VS Code
 *   自己挑调试器 —— 本机还装着 ms-vscode.cpptools（同样认 C 文件），
 *   于是按 F5 很可能落到 cppdbg 上（它需要 launch.json，自然"打不开"）。
 *   （更糟的是旧版还把 F5 绑给了「运行 N 帧」，在仿真视图里按 F5 直接是运行。）
 *   现在：F5 恢复成 VS Code 标准的"开始调试"含义，
 *   另外给一个图标按钮，走我们自己的类型 scut71 —— 入口唯一、不歧义。
 */
async function commandDebug(simView: SimViewProvider, log: (line: string) => void): Promise<void> {
    // 先停掉正在跑的仿真进程：同一份 exe 同时被"运行"和"调试"两份进程用，
    // 用户看到的画面与断点命中的不是同一个进程，没有任何线索能看出来。
    await simView.stop();

    const folder = vscode.workspace.workspaceFolders?.[0];
    const config: vscode.DebugConfiguration = {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'SCUT-71 仿真调试',
    };
    log('[调试] 正在启动调试会话…');
    // startDebugging 会走 registerDebugConfigurationProvider 注册的
    // resolveDebugConfiguration —— 也就是补齐 program / args / cwd / PATH
    // 的那段逻辑，与 F5 完全同一条路径，不重复实现。
    const ok = await vscode.debug.startDebugging(folder, config);
    if (!ok) {
        log('[调试] 调试会话未能启动。'
            + '常见原因：还没编译（先按 Ctrl+Shift+B）、没有识别到工程、'
            + '或没找到 lldb-dap。上方如果有错误提示，按提示操作即可。');
    }
}

async function commandStop(simView: SimViewProvider, log: (line: string) => void): Promise<void> {
    log('[命令] 停止仿真。');
    await simView.stop();
}

/**
 * 跳到指定编号的测试图。
 *
 * ★ 为什么要有这个命令（一个"功能做了但用不到"的补齐）：
 *   后端一直实现了 `g<N>` 命令（含边界钳位），协议注释里也写着，
 *   但插件【从不发送它】—— 用户在 60 多张图的工程里只能一张张点
 *   「下一张」，没法跳转。这里补上唯一缺的入口。
 *
 * ★ 与「上一张/下一张」完全同一条通道：只换输入图，不重启进程，
 *   算法内部状态（环形缓冲、状态机、丢线计数）全部保留。
 *   理由见 simview.nudgePic 的长注释。
 *
 * ★ 编号怎么填：用输入框而不是下拉列表 —— 图集可能有几百张，
 *   下拉列表反而更难选；而"我知道我要第几张"是最直接的表达。
 *   真正越界了也不用担心：后端会把编号夹到合法区间，
 *   并把实际用的那张随帧 JSON 报回来（界面状态栏会显示）。
 */
async function commandGotoPic(simView: SimViewProvider): Promise<void> {
    const raw = await vscode.window.showInputBox({
        title: 'SCUT-71：跳到第几张图',
        prompt: '填图集里的编号（0 起的图集就填 0 开始的号）',
        placeHolder: '例如 12',
        validateInput: (v) => {
            const t = v.trim();
            if (t.length === 0) {
                return '请填一个编号';
            }
            return /^\d+$/.test(t) ? undefined : '请填一个非负整数';
        },
    });
    if (raw === undefined) {
        return;                    // 用户取消
    }
    await simView.gotoPic(Number(raw.trim()));
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
            + '若编译成功但清单仍为空，执行「SCUT-71: 环境自检」查看变量发现那一项。',
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
