#!/usr/bin/env python3
"""
第二轮：① OutputChannel 日志 ③ 动态勾选 ④ 手动变量置顶+着色 ⑥ 编译前停止。
"""
import io, re

ROOT = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio"
EXT  = ROOT + r"\extension\src\extension.ts"
SV   = ROOT + r"\extension\src\simview.ts"
SS   = ROOT + r"\extension\src\simsession.ts"
JS   = ROOT + r"\extension\media\simview.js"

# ================= ① SCUT_Log → 独立 OutputChannel =================
with io.open(EXT, "r", encoding="utf-8") as f:
    ex = f.read()

# 1) 定义通道（紧跟 build channel 的 import 之后）
if "createOutputChannel('SCUT-71 运行日志')" not in ex:
    ex = ex.replace(
        "import { build, disposeBuildOutputChannel, getBuildOutputChannel } from './build';",
        "import { build, disposeBuildOutputChannel, getBuildOutputChannel } from './build';\n\n"
        "/**\n"
        " * 用户算法 SCUT_Log 的独立输出通道（VS Code 底部「输出」面板）。\n"
        " *\n"
        " * ★ 为什么是 OutputChannel 而不是侧边栏折叠区（用户原话：\n"
        " *   \"我程序输出的LOG还是没有单独的窗口啊\"）：\n"
        " *   OutputChannel 可搜索、可复制、可拖到底部任意高度、不占侧边栏；\n"
        " *   而且 VS Code 用户对「输出」面板有统一的心智模型。\n"
        " */\n"
        "let simLogChannel: vscode.OutputChannel | undefined;\n"
        "export function getSimLogChannel(): vscode.OutputChannel {\n"
        "    if (!simLogChannel) {\n"
        "        simLogChannel = vscode.window.createOutputChannel('SCUT-71 运行日志');\n"
        "    }\n"
        "    return simLogChannel;\n"
        "}\n"
        "export function disposeSimLogChannel(): void {\n"
        "    simLogChannel?.dispose();\n"
        "    simLogChannel = undefined;\n"
        "}")

# 2) dispose 注册
ex = ex.replace(
    "context.subscriptions.push({ dispose: () => disposeBuildOutputChannel() });",
    "context.subscriptions.push({ dispose: () => disposeBuildOutputChannel() });\n"
    "        context.subscriptions.push({ dispose: () => disposeSimLogChannel() });")

with io.open(EXT, "w", encoding="utf-8", newline="") as f:
    f.write(ex)
print("OK ① extension.ts 通道已建")

# 3) simview 的 deps.log 拆流：[LOG] 前缀的行进通道，其余照旧
with io.open(SV, "r", encoding="utf-8") as f:
    sv = f.read()

# 找 pushLog / deps.log 的定义位置
m = re.search(r'public pushLog\(line: string\): void \{[\s\S]{0,300}\n    \}', sv)
if m:
    sv = sv.replace(m.group(0),
        "public pushLog(line: string): void {\n"
        "        // ★ 双通道分流：\n"
        "        //   [LOG] 前缀 = 用户算法 SCUT_Log 的输出 → 独立「输出」面板（可搜索复制）\n"
        "        //   其余       = 环境自身的会话日志 → 侧边栏日志折叠区（轻量、随帧滚动）\n"
        "        //   之所以分流，是用户原话的要求：程序 LOG 要有【单独的窗口】。\n"
        "        if (line.startsWith('[LOG] ')) {\n"
        "            getSimLogChannel().appendLine(line.slice(6));\n"
        "            return;\n"
        "        }\n"
        "        this.deps.log(line);\n"
        "    }")
    print("OK ① pushLog 双通道分流")
else:
    print("  ⚠️ pushLog 未匹配（人工检查）")

# import getSimLogChannel
sv = sv.replace(
    "import { SimSessionImpl } from './simsession';",
    "import { SimSessionImpl } from './simsession';\n"
    "import { getSimLogChannel } from './extension';")
with io.open(SV, "w", encoding="utf-8", newline="") as f:
    f.write(sv)

# ================= ⑥ commandBuild 前自动 stop =================
with io.open(EXT, "r", encoding="utf-8") as f:
    ex = f.read()
ex = ex.replace(
    "    const options = buildOptions();\n"
    "    log(`[构建] ${describeProject(project)}（模式 ${options.mode}，自动发现 ${options.autoWatch ? '开' : '关'}）`);",
    "    // ★ 编译前先停掉运行中的仿真进程（用户原话：\"按下编译的时候应该自动\n"
    "    //   尝试关闭进程，否则容易出现无法写入文件\"）：\n"
    "    //   Windows 对正在运行的 exe 独占写锁，链接器 rename(tmp → exe)\n"
    "    //   会得到 WinError 5 拒绝访问。进程不重启对用户也无感 —— 编译完\n"
    "    //   本来就要重新开始。\n"
    "    await simView.stop();\n\n"
    "    const options = buildOptions();\n"
    "    log(`[构建] ${describeProject(project)}（模式 ${options.mode}，自动发现 ${options.autoWatch ? '开' : '关'}）`);")
with io.open(EXT, "w", encoding="utf-8", newline="") as f:
    f.write(ex)
print("OK ⑥ 编译前自动停止")

# ================= ③ 动态勾选：宿主侧过滤（sendSnapshot 已有过滤，确认链路通） =================
# sendSnapshot 已经按 selected 过滤（见 simview.ts sendSnapshot）。
# 关键是勾选变化时【不需要】重启进程/重编译 —— 确认 selectVariables 不触发重启：
with io.open(SS, "r", encoding="utf-8") as f:
    ss = f.read()
# setSelectedVariables 里 restartPending 的逻辑：启动时带 --select 才标记重启。
# 现在改为：彻底不走 --select（快照全量发，宿主过滤），永远不需要重启。
ss = ss.replace(
    "        // ★ --select 的作用只是省流（少发不关心的变量），",
    "        // ★ --select 已弃用：快照全量发，宿主按勾选过滤（见 sendSnapshot）。")
ss = ss.replace(
    "    setSelectedVariables(names: string[]): void {\n"
    "        this.selected = [...names];\n"
    "        if (this.child && names.length > 0) {\n"
    "            this.restartPending = true;\n"
    "        }\n"
    "    }",
    "    setSelectedVariables(names: string[]): void {\n"
    "        // 只更新宿主侧的过滤名单 —— 快照每帧全量发，这里只是过滤口径变化，\n"
    "        // 【不需要重启进程，更不需要重新编译】（用户原话：勾选后要能动态捕获）。\n"
    "        this.selected = [...names];\n"
    "    }")
ss = ss.replace(
    "    get needsRestartForSelection(): boolean {\n"
    "        return this.restartPending;\n"
    "    }", "")
ss = ss.replace("    private restartPending = false;\n", "")
# 启动参数里不再传 --select
ss = ss.replace("""        if (this.selected.length > 0) {
            args.push('--select', this.selected.join(','));
        }
""", "")
with io.open(SS, "w", encoding="utf-8", newline="") as f:
    f.write(ss)
print("OK ③ 动态勾选（不再依赖 --select / 重启）")

print("DONE part2")
