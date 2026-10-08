#!/usr/bin/env python3
"""
run_all_tests.py —— 一次性跑完全部测试。

为什么需要这个脚本：
    这个项目有 4 层测试，分别用不同的运行器（Python / Node / 浏览器）。
    如果每次都要人肉记住 4 条命令和它们的参数，实际结果就是"没人跑"。
    一条命令跑完全部，是把测试变成习惯的前提。

用法：
    python tests/run_all_tests.py [--project <工程目录>]
    默认工程目录：%TEMP%/scut ascii demo

退出码 0 = 全部通过。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PY = sys.executable
CLANG = r"D:\TOOLS\llvm-mingw\bin\clang.exe"
OBJDUMP_TOOLCHAIN = r"D:\TOOLS\llvm-mingw"
LLDB_DAP = r"D:\TOOLS\llvm-mingw\bin\lldb-dap.exe"

results = []


def banner(title):
    print("\n" + "=" * 68)
    print("  " + title)
    print("=" * 68)


def run(name, cmd, cwd=None, env=None):
    """跑一条命令，返回 (是否通过, 输出尾部)"""
    e = dict(os.environ)
    e["PYTHONIOENCODING"] = "utf-8"
    e["PYTHONUTF8"] = "1"
    if env:
        e.update(env)
    try:
        r = subprocess.run(cmd, cwd=cwd or ROOT, capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           env=e, timeout=600)
    except subprocess.TimeoutExpired:
        results.append((name, False, "超时"))
        print("  ❌ 超时")
        return False, "超时"
    out = (r.stdout or "") + (r.stderr or "")
    ok = (r.returncode == 0)
    results.append((name, ok, "退出码 %d" % r.returncode))
    tail = "\n".join(out.strip().splitlines()[-14:])
    print(tail if tail else "  (无输出)")
    print("  --> %s" % ("✅ 通过" if ok else "❌ 失败（退出码 %d）" % r.returncode))
    return ok, tail


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.path.join(
        tempfile.gettempdir(), "scut ascii demo"))
    ap.add_argument("--also-cn", action="store_true",
                    help="在含中文与空格的工程路径上再跑一遍端到端")
    args = ap.parse_args()
    proj = args.project

    banner("1/7  端到端：模板工程 → 零注册用户代码 → 构建 → 运行")
    # ★ 这条排在第一位：它验证的是【设计理念本身】（用户代码零注册、
    #   环境接管图像管道、配置真的生效）。后面的测试都是组件级的，
    #   组件都对但主线断了，这个环境依然是不可用的。
    run("e2e", [PY, os.path.join(HERE, "test_e2e_pipeline.py")])

    banner("2/7  自动符号发现（35 变量 × gcc + clang）")
    run("symbols", [PY, os.path.join(HERE, "test_symbols.py"),
                    "--cc", "gcc", "--also", CLANG])

    banner("3/7  JSON 协议合法性（插件依赖它）")
    run("json", [PY, os.path.join(HERE, "check_json_protocol.py")])

    banner("4/7  插件纯逻辑（协议解析 / PGM / 诊断）")
    run("extension", ["node", os.path.join(HERE, "extension_smoke.js"),
                      os.path.join(proj, ".scut", "frames"),
                      os.path.join(proj, ".scut", "bin", "scut_sim.exe")])

    banner("5/7  调试器真实 DAP 会话（lldb-dap）")
    # ★ 用户源文件名不再是固定的 main.c（模板默认给的是 camera.c，
    #   而且用户可以任意命名）。所以这里动态挑一个真实存在的 .c，
    #   避免测试因为"模板换了默认文件名"而误报失败。
    user_c_src = None
    code_dir = os.path.join(proj, "code")
    if os.path.isdir(code_dir):
        cs = sorted(n for n in os.listdir(code_dir) if n.endswith(".c"))
        if cs:
            user_c_src = os.path.join(code_dir, cs[0])
    if user_c_src is None:
        # 兜底：老工程可能叫 main.c
        candidate = os.path.join(code_dir, "main.c")
        user_c_src = candidate if os.path.isfile(candidate) else code_dir
        print("  ⚠️  code/ 下没找到 .c，断点位置退回：%s" % user_c_src)
    run("dap", ["node", os.path.join(HERE, "dap_smoke.js"),
                LLDB_DAP,
                os.path.join(proj, ".scut", "bin", "scut_sim.exe"),
                user_c_src])

    banner("6/7  Webview 渲染（真实 Chromium + 真实帧数据）")
    wv_out = os.path.join(tempfile.gettempdir(), "scut_wv_test")
    ok, out = run("webview", ["node", os.path.join(HERE, "webview_render.js"),
                              os.path.join(proj, ".scut", "frames"), wv_out])
    # 渲染判定在脚本内部打印；这里再核一次关键词，避免"脚本没崩但也没画出来"
    if ok and "渲染判定: ✅" not in out:
        results[-1] = ("webview", False, "未画出内容")
        print("  --> ❌ 脚本成功退出，但渲染判定未通过")

    if args.also_cn:
        banner("7/7  端到端（含空格 + 中文的工程路径）")
        cn = os.path.join(tempfile.gettempdir(), "scut proj 中文", "demo")
        if os.path.isdir(cn):
            run("cn-e2e", ["node", os.path.join(HERE, "extension_smoke.js"),
                           os.path.join(cn, ".scut", "frames"),
                           os.path.join(cn, ".scut", "bin", "scut_sim.exe")])
        else:
            print("  SKIP  中文路径工程不存在：%s" % cn)
    else:
        banner("7/7  跳过（用 --also-cn 启用中文路径端到端）")

    banner("汇总")
    npass = sum(1 for _, ok, _ in results if ok)
    for name, ok, note in results:
        print("  %s  %-12s %s" % ("✅" if ok else "❌", name, note))
    print("\n  %d/%d 通过" % (npass, len(results)))
    return 0 if npass == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
