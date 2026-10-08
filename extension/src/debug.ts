/**
 * debug.ts —— 零 JSON 的调试集成。
 *
 * 设计理念对照：
 *   · 上手即用     → 用户按 F5 就能调试，【永远不需要】手写 launch.json
 *   · 代码松耦合   → 调试器只负责「起 lldb-dap、把 exe 交给它」，
 *                    不关心构建怎么做
 *
 * ★ 机制（docs/插件技术要点.md §二，API 行号已核实）：
 *   用户按 F5 且【没有】launch.json 时，VS Code 不会弹「创建 launch.json」，
 *   而是给已注册的 DebugConfigurationProvider 传一个只有
 *   {type, request, name} 的空壳配置，要求 resolveDebugConfiguration 补齐。
 *   · 返回【配置】     → 会话启动
 *   · 返回 undefined   → 会话不启动（并且【不】弹 launch.json）
 *   · 返回 null        → 不启动，并打开底层的 launch.json
 *   我们要的正是第一种，所以全程不落盘任何 JSON。
 *
 * ★ 为什么返回 undefined 而不是 null 来表示失败：
 *   返回 null 会让 VS Code 打开（或创建）launch.json —— 那正好违背
 *   「用户全程不见 JSON」的目标。所以失败时返回 undefined，
 *   并自己弹一条中文的可执行提示。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ScutProject } from './types';
import { detectToolchain } from './toolchain';

export const DEBUG_TYPE = 'scut71';

/** 从配置里取程序路径：优先用户显式写的 program，其次构建产物。 */
function resolveProgram(
    config: vscode.DebugConfiguration,
    project: ScutProject | undefined,
): { program?: string; reason?: string } {
    const configured = typeof config.program === 'string' ? config.program.trim() : '';
    if (configured.length > 0) {
        // 支持 ${workspaceFolder} 之外的相对路径：相对工程根解析
        let p = configured;
        if (!path.isAbsolute(p)) {
            const base = project?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
            p = path.resolve(base, p);
        }
        if (!fs.existsSync(p)) {
            return {
                reason: `launch 配置里写的 program 不存在：${p}\n`
                    + '    下一步：把它改成实际的可执行文件路径，或者留空让我们自动找构建产物。',
            };
        }
        return { program: p };
    }

    if (!project) {
        return {
            reason: '没有识别到仿真工程，也没有在 launch 配置里指定 program。\n'
                + '    下一步：用「文件 → 打开文件夹」打开含 code/ 的工程目录，'
                + '或者先执行「SCUT-71: 新建仿真工程」。',
        };
    }

    const exe = path.join(project.outDir, 'bin', 'scut_sim.exe');
    if (!fs.existsSync(exe)) {
        return {
            reason: `还没有构建产物，找不到 ${exe}\n`
                + '    下一步：先执行「SCUT-71: 编译仿真程序」（或按 Ctrl+Shift+B），'
                + '编译成功后再按 F5。',
        };
    }
    return { program: exe };
}

export class ScutDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    constructor(private readonly project: () => ScutProject | undefined) {}

    /**
     * 提供初始模板（用户主动执行「创建 launch.json」时才会用到）。
     * ★ 刻意返回一个【不含绝对路径】的模板：路径由
     *   resolveDebugConfiguration 在运行时补齐，这样模板可以进版本库共享。
     */
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [
            {
                type: DEBUG_TYPE,
                request: 'launch',
                name: 'SCUT-71 仿真调试',
                program: '${workspaceFolder}/.scut/bin/scut_sim.exe',
                // ★ 调试用参数：跑 1 帧就停，方便下断点、单步。
                //   刻意【不加 --json】—— 调试控制台里显示人话（"[帧 1] 处理 …"）
                //   比一行 JSON 有用得多；SCUT_Log 走 stderr，照样能看到。
                args: ['--frames', '1'],
            },
        ];
    }

    /**
     * ★ F5 无 launch.json 的关键路径。
     * 返回补齐后的配置即启动会话；返回 undefined 则不启动（且不弹 JSON）。
     */
    async resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        // ★ 只有空壳配置（F5 无 launch.json）才走「自动补齐」。
        //   如果 VS Code 传进来的东西看起来不是我们认得的配置，直接问一下，
        //   而不是硬猜一个路径塞进去 —— 猜错会让用户调试到一个莫名其妙的 exe。
        const isShell = (typeof config.program !== 'string' || config.program.trim().length === 0);
        const project = this.project();

        if (isShell && !project) {
            // 既没有工程，也没有 program：没有任何可靠依据可以推断。
            // 返回 undefined（不是 null！null 会让 VS Code 打开 launch.json，
            // 与「用户全程不见 JSON」直接冲突）。
            void vscode.window.showErrorMessage(
                'SCUT-71 调试无法启动：没有识别到仿真工程，launch 配置里也没有指定 program。\n'
                + '    原因：仿真程序的位置要么由工程目录（含 code/）推断，'
                + '要么由你在 launch 配置里显式给出；两者都没有时无法确定要调试什么。\n'
                + '    下一步（任选其一）：\n'
                + '      1) 用「文件 → 打开文件夹」打开含 code/ 的工程目录；\n'
                + '      2) 执行「SCUT-71: 新建仿真工程」从头建一个；\n'
                + '      3) 在 launch 配置里显式写 program。',
            );
            return undefined;
        }

        const { program, reason } = resolveProgram(config, project);
        if (!program) {
            // ★ 返回 undefined（不是 null！）：null 会让 VS Code 打开 launch.json，
            //   与「用户全程不见 JSON」的目标直接冲突。错误由我们自己用中文说清楚。
            void vscode.window.showErrorMessage(
                `SCUT-71 调试无法启动。\n${reason ?? '未知原因'}`,
            );
            return undefined;
        }

        const tc = await detectToolchain();
        if (!tc.lldbDap) {
            void vscode.window.showErrorMessage(
                'SCUT-71 调试无法启动：没有找到 lldb-dap。\n'
                + '    影响：编译与仿真视图都可以正常用，只是没法打断点单步调试。\n'
                + '    下一步：lldb-dap 随 LLVM-MinGW 一起发布（bin\\lldb-dap.exe）。'
                + '装好后重新执行「SCUT-71: 环境自检」确认这一项是 ✓。',
                { modal: false },
            );
            return undefined;
        }

        const args = Array.isArray(config.args) && config.args.length > 0
            ? config.args
            : ['--frames', '1'];

        // 合并出最终配置：补齐 program / args / cwd / env
        const resolved: vscode.DebugConfiguration = {
            ...config,
            type: DEBUG_TYPE,
            request: 'launch',
            name: config.name || 'SCUT-71 仿真调试',
            program,
            args,
            cwd: project?.root ?? path.dirname(program),
            // 把工具链 bin 前置进 PATH：lldb 需要它来解析运行库，
            // 目标程序自己也可能需要（DLL 搜索路径）。
            // ★ 这里的 env【会与父进程合并】（DebugAdapterExecutableOptions.env
            //   的语义与 Node spawn 相反，见技术要点 §二），所以只放增量。
            env: {
                PATH: tc.root
                    ? path.join(tc.root, 'bin') + path.delimiter + (process.env.PATH ?? '')
                    : (process.env.PATH ?? ''),
            },
        };
        return resolved;
    }
}

/**
 * 调试适配器工厂：把 lldb-dap 交给 VS Code。
 *
 * ★ 只为本插件【自己拥有】的调试类型注册（scut71）。
 *   给别的类型（比如 cppdbg）注册工厂会把别人的调试会话劫走，
 *   这是很常见的越界 bug，这里刻意避开。
 */
export class ScutDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    async createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined,
    ): Promise<vscode.DebugAdapterDescriptor> {
        const tc = await detectToolchain();
        if (!tc.lldbDap) {
            // 这里抛异常是正确的：能走到这里说明 resolve 阶段已经放行过，
            // 中途 lldb-dap 消失属于真的出错，必须让 VS Code 把错误显示出来。
            throw new Error(
                'SCUT-71：找不到 lldb-dap，无法启动调试。\n'
                + '    下一步：安装 LLVM-MinGW（含 bin\\lldb-dap.exe），'
                + '或执行「SCUT-71: 环境自检」查看探测结果。',
            );
        }
        const binDir = path.join(tc.root || path.dirname(tc.lldbDap), 'bin');
        return new vscode.DebugAdapterExecutable(tc.lldbDap, [], {
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(tc.lldbDap),
            // ★ 这里的 env 与父进程【合并】（与 Node spawn 的替换语义不同），
            //   所以只给增量即可。
            env: { PATH: binDir + path.delimiter + (process.env.PATH ?? '') },
        });
    }
}
