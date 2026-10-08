#!/usr/bin/env python3
"""
④ 查看区分层：手动注册（SCUT_Watch）的变量置顶、名称用蓝色；自动捕获的用灰色。
区分依据：后端 --list-vars 与编译期 DWARF 清单的差集 = 手动注册。
manifest augmentation 后 catalog 已含 51 个（44 自动 + 7 手动），
但 catalog 条目本身没有"手动"标记 —— 在扩展宿主构建 catalog 消息时打上。
"""
import io, re

SV  = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio\extension\src\simview.ts"
JS  = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio\extension\media\simview.js"
CSS = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio\extension\media\simview.css"

# ---------- TS：sendCatalog 给每个变量打 manual 标记 ----------
with io.open(SV, "r", encoding="utf-8") as f:
    sv = f.read()

# 需要 runtime-only 名单：在 setBuildOutput 时记下"手动注册"的名字集合。
# augmentManifestFromRuntime 已经算出了 added 名单 —— 让它把名单存进 manifest。
# 简化：在 WatchedVariable 类型上加 isManual?: boolean，augment 时打标。
# 这里改 simview 端：sendCatalog 的 map 里带上 isManual（types 里有就有，没有就 undefined）。
sv = sv.replace(
    "            variables: (this.manifest?.variables ?? []).map((x) => ({ ...x })),",
    "            variables: (this.manifest?.variables ?? []).map((x) => ({ ...x })),\n"
    "            // isManual 随条目自带（augmentManifestFromRuntime 打的标），无需额外处理")

with io.open(SV, "w", encoding="utf-8", newline="") as f:
    f.write(sv)
print("OK ④ TS catalog 透传 isManual")

# ---------- types.ts：WatchedVariable 加 isManual ----------
TYP = ROOT + r"\extension\src\types.ts"
with io.open(TYP, "r", encoding="utf-8") as f:
    typ = f.read()
if "isManual" not in typ:
    typ = typ.replace(
        "    /** 由生成器给出的默认勾选建议（大缓冲默认不勾，避免卡 UI） */\n    defaultSelected: boolean;",
        "    /** 由生成器给出的默认勾选建议（大缓冲默认不勾，避免卡 UI） */\n"
        "    defaultSelected: boolean;\n"
        "    /**\n"
        "     * 手动注册（用户代码里 SCUT_Watch 点名要看的）。\n"
        "     * 查看区据此置顶 + 蓝色显示；自动发现的用灰色 —— 视觉分层。\n"
        "     */\n"
        "    isManual?: boolean;")
    with io.open(TYP, "w", encoding="utf-8", newline="") as f:
        f.write(typ)
    print("OK ④ types.ts isManual 已加")

# ---------- build.ts：augment 时给运行期新增的变量打 isManual ----------
B = ROOT + r"\extension\src\build.ts"
with io.open(B, "r", encoding="utf-8") as f:
    b = f.read()
b = b.replace(
    "        const runtime = normalizeManifest(JSON.parse(line.trim()));",
    "        const runtime = normalizeManifest(JSON.parse(line.trim()));\n"
    "        if (runtime) {\n"
    "            // ★ 运行期注册表 = 自动发现 + 手动 SCUT_Watch；\n"
    "            //   编译期清单里没有的就是手动注册的 —— 打上分层标记。")
    # 打标逻辑：merged 后 diff
b = b.replace(
    """                    if (merged) {
                        const added = merged.variables.length - before;
                        if (added > 0) {
                            ch.appendLine(`[变量] 补充了 ${added} 个手动注册的变量（编译期 DWARF 看不到的）。`);
                        }
                        return merged;
                    }""",
    """                    if (merged) {
                        const before = new Set(
                            (manifest?.variables ?? []).map((v) => v.name));
                        for (const v of merged.variables) {
                            if (!before.has(v.name)) {
                                v.isManual = true;
                            }
                        }
                        const added = merged.variables.length - before.size;
                        if (added > 0) {
                            ch.appendLine(`[变量] 补充了 ${added} 个手动注册的变量（编译期 DWARF 看不到的）。`);
                        }
                        return merged;
                    }""")
with io.open(B, "w", encoding="utf-8", newline="") as f:
    f.write(b)
print("OK ④ build.ts 打标")

# ---------- JS：renderVariables 排序 + class ----------
with io.open(JS, "r", encoding="utf-8") as f:
    js = f.read()

# 排序：manual 在前（稳定排序，同类保持原顺序）
js = js.replace(
    "      var picked = [];\n"
    "      for (var k = 0; k < snapshots.length; k++) {",
    "      var picked = [];\n"
    "      // ★ 手动注册的排前面（用户点名要看的），自动发现的排后面\n"
    "      var manualFirst = function (a, b) {\n"
    "        return (b.isManual ? 1 : 0) - (a.isManual ? 1 : 0);\n"
    "      };\n"
    "      for (var k = 0; k < snapshots.length; k++) {")
js = js.replace(
    "      if (picked.length === 0) {",
    "      picked.sort(manualFirst);\n"
    "      if (picked.length === 0) {")
# 条目 class：手动加 var-manual
js = js.replace(
    "        var li2 = document.createElement('li');\n"
    "        li2.className = 'var-item';\n"
    "        li2.setAttribute('data-name', cv.name);",
    "        var li2 = document.createElement('li');\n"
    "        li2.className = 'var-item' + (cv.isManual ? ' var-manual' : ' var-auto');\n"
    "        li2.setAttribute('data-name', cv.name);")
# kindOf 兜底时带上 isManual
js = js.replace(
    "        var k2 = kindOf(s.name);",
    "        var k2 = kindOf(s.name);")
with io.open(JS, "w", encoding="utf-8", newline="") as f:
    f.write(js)
print("OK ④ JS 排序与 class")

# 勾选区同样排序（选择区也分层，一致的心智模型）
js = js.replace(
    "      var shown = 0;\n"
    "      for (var i = 0; i < catalog.length; i++) {\n"
    "        var v = catalog[i];\n"
    "        if (filter && v.name.toLowerCase().indexOf(filter) < 0) { continue; }",
    "      var shown = 0;\n"
    "      var sortedCatalog = catalog.slice().sort(function (a, b) {\n"
    "        return (b.isManual ? 1 : 0) - (a.isManual ? 1 : 0);\n"
    "      });\n"
    "      for (var i = 0; i < sortedCatalog.length; i++) {\n"
    "        var v = sortedCatalog[i];\n"
    "        if (filter && v.name.toLowerCase().indexOf(filter) < 0) { continue; }")
with io.open(JS, "w", encoding="utf-8", newline="") as f:
    f.write(js)
print("OK ④ 勾选区同步排序")

# ---------- CSS：颜色 ----------
with io.open(CSS, "r", encoding="utf-8") as f:
    css = f.read()
if ".var-manual .var-name" not in css:
    css += """
/* ==========================================================================
 *  变量分层（用户要求：手动暴露的放前面，与自动捕获用颜色区分）
 * ========================================================================== */
.var-manual .var-name {
  color: var(--vscode-symbol-function-color, #4fc1ff);
  font-weight: 600;
}

.var-auto .var-name {
  color: var(--vscode-descriptionForeground, #999);
}

/* 勾选区同样分层 */
.pick-item .var-name {
  color: var(--vscode-descriptionForeground, #999);
}

.pick-item.manual-first .var-name {
  color: var(--vscode-symbol-function-color, #4fc1ff);
  font-weight: 600;
}
"""
    with io.open(CSS, "w", encoding="utf-8", newline="") as f:
        f.write(css)
    print("OK ④ CSS 颜色分层")

print("DONE part3")
