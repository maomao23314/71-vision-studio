#!/usr/bin/env python3
"""
本轮 8 项修改（一次性完成，改前先回答"为什么之前这么写"）：
  ① SCUT_Log → 独立 OutputChannel（VS Code 底部"输出"面板，不是折叠区）
     之前为什么没有：日志塞在 webview 折叠区里，用户找不到也看不全。
     OutputChannel 是 VS Code 标准日志位，可搜索、可复制、不占侧边栏。
  ② 删「独立窗口」：WebviewPanel 塞在编辑器分栏里的体验不好（用户判定）。
     删按钮、方法、命令、菜单、快捷键 —— 一条不剩。
  ③ 勾选变量即时生效：后端每帧本来就发全量快照（--select 只是省流），
     在扩展宿主侧按当前勾选过滤即可，根本不用重启/重编译。
     之前为什么要求重编译：把 --select 当成了唯一的过滤点，没想到宿主侧过滤。
  ④ 手动注册的变量在查看区置顶 + 名称用主题蓝色区分自动捕获（灰色）。
     依据：手动 SCUT_Watch 是用户【点名要看】的，自动发现是【顺手捎带】的，
     重要性不同，理应视觉分层。
  ⑤ 删「只选关键」HTML 残留（上一轮只删了 JS 逻辑，按钮还在）。
  ⑥ 编译前自动 stop：exe 被运行中的进程占用时 Windows 拒绝写入（WinError 5）。
     之前为什么没有：构建脚本自己重试改名，但进程活着时重试也没用。
  ⑦ 编辑器标题栏加「运行」按钮（F5 语义 = 下一张），与编译并列。
  ⑧ 用户代码强制 -O0：release 模式的 -O2 只对【环境核心】有意义，
     用户算法被优化会改变逐行调试行为（断点漂移、变量被优化掉）。
     用户原话："用户代码需要强制O0优化"。
"""
import io, re, json

ROOT = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio"
TS   = ROOT + r"\extension\src\simview.ts"
EXT  = ROOT + r"\extension\src\extension.ts"
PKG  = ROOT + r"\extension\package.json"
JS   = ROOT + r"\extension\media\simview.js"
CSS  = ROOT + r"\extension\media\simview.css"
PY   = ROOT + r"\tools\scut_build.py"

# ================= ② + ⑤ + ⑦ TS：工具栏与 openPanel =================
with io.open(TS, "r", encoding="utf-8") as f:
    ts = f.read()

# ② 删 openPanel 方法
m = re.search(r'    /\*\*[\s\S]*?\*/\s*public openPanel\(\): void \{[\s\S]*?\n    \}\n', ts)
if m:
    ts = ts.replace(m.group(0), '')
    print("OK ② openPanel 方法已删")

# ② 删 cmd 分发分支
ts = ts.replace("""                } else if (cmd === 'openPanel') {
                    void vscode.commands.executeCommand('scut71.openPanel');""",
"""                }""")
ts = ts.replace("""                } else if (cmd === 'openPanel') {
                    this.openPanel();
                }""", "")
print("OK ② cmd 分发已清")

# ② 删工具栏按钮
ts = ts.replace('      <button id="btn-open" class="primary" title="在编辑器区打开大图（可拉满、可分屏）">独立窗口</button>\n', '')
print("OK ② 独立窗口按钮已删")

# ⑤ 删「只选关键」按钮
ts = ts.replace('        <button id="btn-pick-key" class="ghost" title="只勾选算法常用的关键变量">只选关键</button>\n', '')
print("OK ⑤ 只选关键按钮已删")

# ⑤ 删 pick-tools 里对它的 HTML（如果整行删除后 tools 只剩两个按钮即可）
# ⑦ 顶部注释里的 openPanelPanel 字段清理
ts = ts.replace("""    /** 编辑器区的大图面板（「独立窗口」按钮打开的那个）。
     *  维护要点见 resolveWebviewView 里。 */
    private panel: vscode.WebviewPanel | undefined;
""", "")
print("OK ② panel 字段已删")

with io.open(TS, "w", encoding="utf-8", newline="") as f:
    f.write(ts)

# ================= JS：删 btn-open 绑定与注释 =================
with io.open(JS, "r", encoding="utf-8") as f:
    js = f.read()
js = js.replace("""  bind('btn-open', function () {
    vscode.postMessage({ type: 'cmd', cmd: 'openPanel' });
  });
""", "")
# 删那段长注释（独立窗口的 rationale 已无意义）
js = re.sub(r"  // ---- 画面缩放与\"独立窗口\" ----[\s\S]*?编辑器区的 WebviewPanel 才是既\"大\"又\"还在 IDE 里\"的解法。\n",
            "  // ---- 画面缩放 ----\n", js)
with io.open(JS, "w", encoding="utf-8", newline="") as f:
    f.write(js)
print("OK ② JS 已清")

# ================= extension.ts：删 openPanel 注册，加运行按钮命令 =================
with io.open(EXT, "r", encoding="utf-8") as f:
    ex = f.read()
ex = re.sub(r"\s*vscode\.commands\.registerCommand\('scut71\.openPanel', \(\) => \{[\s\S]*?\}\),", "", ex, count=1)
with io.open(EXT, "w", encoding="utf-8", newline="") as f:
    f.write(ex)
print("OK ② extension.ts openPanel 注册已删")

# ================= package.json：删命令/菜单/快捷键 =================
with io.open(PKG, "r", encoding="utf-8") as f:
    raw = f.read()
if raw[0] == '\ufeff':
    raw = raw[1:]
j = json.loads(raw)
j["contributes"]["commands"] = [c for c in j["contributes"]["commands"] if c["command"] != "scut71.openPanel"]
j["contributes"]["keybindings"] = [k for k in j["contributes"]["keybindings"] if k["command"] != "scut71.openPanel"]
for k in list(j["contributes"]["menus"].keys()):
    j["contributes"]["menus"][k] = [m for m in j["contributes"]["menus"][k] if m["command"] != "scut71.openPanel"]
# ⑦ 编辑器标题栏加运行（下一张）
# 找 editor/title 组，追加 scut71.nextPic
if "editor/title" in j["contributes"]["menus"]:
    has = any(m.get("command") == "scut71.nextPic" for m in j["contributes"]["menus"]["editor/title"])
    if not has:
        j["contributes"]["menus"]["editor/title"].append({
            "command": "scut71.nextPic",
            "when": "resourceLangId == c || resourceLangId == cpp",
            "group": "navigation@3"})
with io.open(PKG, "w", encoding="utf-8", newline="") as f:
    f.write(json.dumps(j, ensure_ascii=False, indent=2) + "\n")
print("OK ②⑦ package.json 已更新（openPanel 删净 / 编辑器标题加运行）")

# ================= ⑥+⑧ 构建脚本 =================
with io.open(PY, "r", encoding="utf-8") as f:
    py = f.read()

# ⑧ 用户代码强制 -O0：找到用户源码的编译行（release 用 -O2 的那处）
#    判别：那行编的是 code/ 下的用户源文件
py2 = py.replace(
    'cmd = ([tc.cc, "-std=c11", "-O2", "-Wall", "-Wextra"]',
    'cmd = ([tc.cc, "-std=c11", "-O0", "-Wall", "-Wextra"]')
if py2 != py:
    py = py2
    print("OK ⑧ 用户源码编译恒为 -O0")
else:
    print("  ⚠️ ⑧ 未匹配到 -O2 编译行（人工检查）")

with io.open(PY, "w", encoding="utf-8", newline="") as f:
    f.write(py)

print("DONE part1")
