/**
 * debug.ts —— 调试 = 附着(attach)到界面正在对话的那个仿真进程。零 JSON。
 *
 * 设计理念对照：
 *   · 上手即用     → 按 F5 / 点「调试」就能下断点，【永远不需要】手写 launch.json
 *   · 代码松耦合   → 调试器只负责「起 lldb-dap、把它指向哪个 pid」，
 *                    不关心构建怎么做、不关心图集从哪来
 *
 * ★★ 为什么是 attach，而不是 launch（2026-11 用户反馈后的返工）★★
 *
 *   上一版调试是"另起一个 scut_sim.exe"（`--frames 1`，后来改成跑完整组图）。
 *   用户在真机上试出来的三个问题，其实是同一条设计错误的三个面：
 *
 *     1) 断点命中后一 Continue 就又进断点、LOG 是新的 —— 因为那个进程
 *        没人喂 stdin，它只能憋着一口气往下跑。"什么时候换图"由不得用户，
 *        而用户要的正是「等用户切图片之后再运行下一次循环」；
 *     2) 断点命中的进程和界面看到的进程不是同一个 —— 图/算法状态对不上；
 *     3) 它画出来的图没有任何地方显示，看起来就是"图像缓冲区没了"。
 *
 *   这三条只有在【调试器附着到界面正在对话的那个进程】时才可能同时成立：
 *     · 帧什么时候前进 = 用户点「运行 / 上一张 / 下一张」（会话本来就靠 stdin 驱动）；
 *     · 画面与标注照常回到界面（同一个会话、同一条 JSON 协议）；
 *     · 算法状态完整保留（同一个进程，翻页/调试都不重启）。
 *
 * ★ 机制（vscode.d.ts 的 resolveDebugConfiguration 契约）：
 *   按 F5 且【没有】launch.json 时，VS Code 不会弹「创建 launch.json」，
 *   而是给已注册的 Provider 一个只有 {type, request, name} 的空壳配置，
 *   要求 resolveDebugConfiguration 补齐。
 *     · 返回【配置】     → 会话启动
 *     · 返回 undefined   → 会话不启动（并且【不】弹 launch.json）
 *     · 返回 null        → 不启动，并打开底层的 launch.json
 *   所以这里只做一件事：把 request 改成 attach，并补上 pid。
 *
 * ★ 为什么失败时返回 undefined 而不是 null：
 *   返回 null 会让 VS Code 打开（或创建）launch.json —— 那正好违背
 *   「用户全程不见 JSON」的目标。错误由 target() 那边用中文说清楚。
 *
 * ★ 为什么不在这里启动仿真进程：
 *   "会话怎么启动"（`--json --step --frames 0 --out … --pic …`、帧目录选择、
 *   事件接线）只有一处答案 —— simview 的 ensureSession。调试再写一份，
 *   就会出现"运行和调试看到的不是同一组参数"那类历史缺陷。
 *   本文件只向它要一个 { pid, program }。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { detectToolchain } from './toolchain';

export const DEBUG_TYPE = 'scut71';

/**
 * attach 的目标。
 *
 * ★ pid 是必须的；program 不是（lldb 能自己从进程里读），
 *   但给了它才能稳定地把源码/符号对应上 —— 断点是靠这个定位的。
 */
export interface ScutDebugTarget {
    pid: number;
    program?: string;
}

export class ScutDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    /**
     * @param target 取得"要附着的进程"。实现方（simview）负责"没有就起一个会话"，
     *               失败时自己弹中文原因并返回 undefined —— 本文件不重复判断
     *               工程在不在、编译过没有，那些答案只有一处。
     */
    constructor(private readonly target: () => Promise<ScutDebugTarget | undefined>) {}

    /**
     * 提供初始模板（只有用户主动执行「创建 launch.json」时才会用到）。
     *
     * ★ 模板里【不写 pid】：pid 每次运行都不一样，写死等于写死一个错误。
     *   由 resolveDebugConfiguration 在运行时补齐。
     * ★ 也不再写 program / args：attach 一个已经在跑的进程用不上它们，
     *   写了反而会让人以为"调试会另起一个 exe"。
     */
    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [
            {
                type: DEBUG_TYPE,
                request: 'attach',
                name: 'SCUT-71 仿真调试',
            },
        ];
    }

    /**
     * ★ F5 无 launch.json 的关键路径：返回补齐后的配置即启动会话。
     */
    async resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken,
    ): Promise<vscode.DebugConfiguration | undefined> {
        // ★ 用户显式写了 pid 就以他为准（"attach 到我自己挑的进程"是合法用法），
        //   否则附着到仿真视图那个会话进程（没有就顺手起一个，状态照旧保留）。
        const explicit = (typeof config.pid === 'number' && config.pid > 0)
            ? config.pid
            : (typeof config.processId === 'number' && config.processId > 0
                ? config.processId
                : undefined);

        const target: ScutDebugTarget | undefined = explicit !== undefined
            ? { pid: explicit }
            : await this.target();

        if (!target) {
            // ★ target() 失败时【已经】弹过原因（没工程 / 没编译 / 启动失败），
            //   这里再弹一条只会让用户收到两条重复的通知。
            return undefined;
        }

        return {
            ...config,
            type: DEBUG_TYPE,
            // ★ 不管进来的是 launch 还是 attach，出去一律 attach ——
            //   见文件头"为什么是 attach"。老的 launch.json 因此仍然能用。
            request: 'attach',
            name: config.name || 'SCUT-71 仿真调试',
            pid: target.pid,
            // 只在真有 exe 路径时才带上：没有它 lldb 也能 attach，
            // 但断点可能对不上源码（见 ScutDebugTarget 的说明）。
            ...(target.program ? { program: target.program } : {}),
            /* ★ 断开调试时【不要】顺手杀掉目标进程：它就是界面正在用的会话。
             *   杀掉等于"点一下停止调试，画面和状态全没了"，
             *   而用户想表达的只是"我调完了"。 */
            terminateDebuggee: false,
        };
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
