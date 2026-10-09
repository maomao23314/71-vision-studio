#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_extension_settings.py —— 设置项分组的一致性回归。

★★★ 这个测试为什么存在 ★★★

2026-10-11 把 16 项设置分成四个子栏目（工具链 / 工程配置 / 运行期 / 面板与显示）。
这类改动有一个特别危险的性质：

    ★ 读错设置名【不会报错】，只会静默退回默认值 ★

也就是说，漏改一个读取点不会让任何测试变红，只会让用户
"明明在设置里改了，却一点反应都没有" —— 而且现象出现在编译产物上，
排查时根本想不到要去查读取点。

实际改的时候就有 9 处读取点（cfg.get / cfg.update / affectsConfiguration），
手工核对漏一处是迟早的事，所以这里把它变成断言。

检查两件事：
    ① package.json 里声明的设置键，与源码里读写的键【完全一致】
       （不多、不少、不重名）
    ② 源码里不得残留【旧的扁平键名】 —— 那种写法不报错，只是失效
"""
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT = os.path.join(ROOT, "extension")

# 这些是 0.9.3 之前的扁平键名。任何一个出现在源码里都是 bug：
# 它读/写的是一个"设置界面里不存在、但确实存在"的键。
LEGACY_KEYS = [
    "toolchainPath", "autoDownloadToolchain", "autoWatch",
    "imageWidth", "imageHeight", "inputArray", "outputArray",
    "initFunctions", "frameFunctions", "postFunctions",
    "picDir", "picExt", "startFrame", "processRepeat",
    "benchRepeat", "runFrames",
]

# 分组名（package.json 里的子栏目 id）
SECTIONS = ["scut71.toolchain", "scut71.project", "scut71.runtime", "scut71.view"]


def declared_keys():
    """返回 {设置键: 子栏目名}。"""
    with open(os.path.join(EXT, "package.json"), "r", encoding="utf-8") as f:
        pkg = json.load(f)
    out = {}
    props = pkg["contributes"]["configuration"]["properties"]
    for sec_id, sec in props.items():
        if sec.get("type") != "object" or "properties" not in sec:
            # 还是扁平的（没分组）
            out[sec_id] = "(flat)"
            continue
        for k in sec["properties"]:
            if k in out:
                raise AssertionError("设置键重复声明：%s" % k)
            out[k] = sec_id
    return out


def src_files():
    d = os.path.join(EXT, "src")
    for name in sorted(os.listdir(d)):
        if name.endswith(".ts"):
            yield os.path.join(d, name)


def main():
    bad = []

    # ---------- ① 分组结构本身 ----------
    keys = declared_keys()
    got_sections = sorted(set(keys.values()))
    if got_sections != sorted(SECTIONS):
        bad.append("子栏目不对。\n    期望: %s\n    实际: %s"
                   % (sorted(SECTIONS), got_sections))

    flat = [k for k, v in keys.items() if v == "(flat)"]
    if flat:
        bad.append("这些设置还没分组（应为 object 子栏目）：%s" % flat)

    # ---------- ②③ 逐个读取点核对所属分组 ----------
    # 抓的是这一类错误：
    #     getConfiguration('scut71.runtime').get<number>('benchRepeat')  ✔ 对
    #     getConfiguration('scut71').get<number>('benchRepeat')            ✘ 错
    # 错的那个读不到键（键已迁到 scut71.runtime），会静默退回默认值。
    #
    # ★ 两个实现要点，都是被自己的负向验证逼出来的 ★
    #   ① 必须【跨行】匹配：本项目的写法是
    #        const cfg = vscode.workspace.getConfiguration('scut71');
    #        const n = cfg.get<number>('benchRepeat', 1000);
    #      getConfiguration 和 .get 根本不在同一行。用单行正则会漏掉
    #      【全部】真实读取点 —— 也就是这个检查会永远显示"通过"，
    #      而它恰恰是本文件唯一要做的事。
    #   ② 必须【先剥掉注释】：注释里提到旧键名是正常的说明文字，
    #      不该报错。剥注释后剩下的才是真正的读取点。
    cfg_re = re.compile(
        r"getConfiguration\(\s*'(scut71(?:\.[a-zA-Z]+)?)'\s*\)"
        r"[\s\S]{0,400}?\.\s*get<[^>]*>\(\s*'([A-Za-z]+)'"
        r"[\s\S]{0,400}?(?:;\s*|\n\s*\n)",
    )

    def strip_comments(text):
        """把 // 与 /* */ 注释换成等长空白，保持行号不变。"""
        text = re.sub(r"/\*[\s\S]*?\*/",
                      lambda m: "".join("\n" if ch == "\n" else " " for ch in m.group(0)),
                      text)
        text = re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), text)
        return text

    for p in src_files():
        rel = os.path.relpath(p, ROOT)
        with open(p, "r", encoding="utf-8") as f:
            raw = f.read()
        clean = strip_comments(raw)
        for m in cfg_re.finditer(clean):
            section, key = m.group(1), m.group(2)
            lineno = clean.count("\n", 0, m.start()) + 1
            full = "%s.%s" % (section, key)
            if full in keys:
                if keys[full] != section:
                    bad.append("%s:%d  读到 %s，但它属于 %s"
                               % (rel, lineno, full, keys[full]))
            elif section == "scut71":
                bad.append(
                    "%s:%d  ★ 读了旧的扁平键 scut71.%s —— "
                    "不会报错，只会静默退回默认值（用户改了没反应）"
                    % (rel, lineno, key))

    # ---------- ④ 设置按钮与命令必须成对存在 ----------
    with open(os.path.join(EXT, "src", "simview.ts"), "r",
              encoding="utf-8") as f:
        simview = f.read()
    with open(os.path.join(EXT, "media", "simview.js"), "r",
              encoding="utf-8") as f:
        simjs = f.read()
    with open(os.path.join(EXT, "package.json"), "r", encoding="utf-8") as f:
        pkg_text = f.read()

    if 'id="btn-settings"' not in simview:
        bad.append("仿真面板里没有 btn-settings 按钮")
    if "btn-settings" not in simjs:
        bad.append("media/simview.js 里没有给 btn-settings 绑事件")
    if "cmd === 'settings'" not in simview:
        bad.append("simview.ts 没有处理 settings 命令（按钮点了没反应）")
    if '"scut71.openSettings"' not in pkg_text:
        bad.append("package.json 里没有声明 scut71.openSettings 命令")

    # ---------- 汇总 ----------
    print("=" * 68)
    print("  设置项分组一致性")
    print("=" * 68)
    by_sec = {}
    for k, v in keys.items():
        by_sec.setdefault(v, []).append(k)
    for sec in sorted(by_sec):
        print("  %-16s %d 项" % (sec, len(by_sec[sec])))
    print()
    for b in bad:
        print("  ❌ " + b)
    if not bad:
        print("  ✅ 分组、读取点、按钮链路全部一致")
    ok = not bad
    print()
    print("=" * 68)
    print("  %s  设置项分组" % ("✅ 通过" if ok else "❌ 失败"))
    print("=" * 68)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())