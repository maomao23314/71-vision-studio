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
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# Windows 控制台默认是 GBK，直接 print ✅/❌ 会抛 UnicodeEncodeError
# —— 而且是在【最后打印结果】那一步抛，等于跑完所有测试才崩，
# 用户看到的是"跑完了但报错"，完全不知道测试到底过没过。
# 统一把标准输出改成 UTF-8（不可编码的字符替换掉），保证任何终端都能跑完。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PY = sys.executable
CLANG = r"D:\TOOLS\llvm-mingw\bin\clang.exe"
OBJDUMP_TOOLCHAIN = r"D:\TOOLS\llvm-mingw"
# 工具链【根目录】（构建脚本要的是根，不是 bin 下的 clang.exe）
CLANG_ROOT = r"D:\TOOLS\llvm-mingw"
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


def bootstrap_project(root):
    """从模板建一个干净工程并构建，返回它的路径。

    ★ 为什么每次都重建，而不是复用 %TEMP% 里那个固定目录：
      那个目录是历史遗留（scut ascii demo），里面是没有 scut_project.json
      的老工程 —— 现在的构建会直接判它"没配置钩子"而失败，
      而它 .scut/ 里的 exe 又还是旧构建产物。复用它等于让整套回归
      测一个用户根本跑不起来的东西，失败原因还完全看不懂。
      每次从模板重建，后面的每一条测试都作用在"刚构建、确定可用"的产物上。
    """
    src_pics = os.path.join(os.path.dirname(root), "集成仿真环境测试",
                            "scut71-project", "pic", "1")
    proj = tempfile.mkdtemp(prefix="scut_demo_")
    shutil.copytree(os.path.join(root, "templates", "starter"), proj,
                    dirs_exist_ok=True)
    pic_dir = os.path.join(proj, "pic", "1")
    os.makedirs(pic_dir, exist_ok=True)
    n = 0
    if os.path.isdir(src_pics):
        # 按数字排序取前 12 张，保证图集编号连续（探测按 1,2,3… 递增找）。
        pics = sorted(
            (f for f in os.listdir(src_pics)
             if os.path.splitext(f)[1].lower() in (".bmp", ".png")),
            key=lambda f: int(os.path.splitext(f)[0]) if os.path.splitext(f)[0].isdigit() else 0)
        for f in pics[:12]:
            shutil.copyfile(os.path.join(src_pics, f), os.path.join(pic_dir, f))
            n += 1

    # ★ 给模板工程加一个"用户手写注册"，这样主动/自动那条链路才测得到。
    #   模板本身是零注册的（这是设计理念：用户什么都不用写就能跑），
    #   但正因如此，直接拿模板去测 manual_vars.js 会得到"手写变量 0 个"，
    #   看起来像通过、其实什么都没验证。这里补一个最小的手写注册进去。
    probe_c = os.path.join(proj, "code", "manual_probe.c")
    probe_h = os.path.join(proj, "code", "manual_probe.h")
    with open(probe_h, "w", encoding="utf-8", newline="\n") as f:
        f.write("#ifndef MANUAL_PROBE_H\n#define MANUAL_PROBE_H\n"
                "void manual_probe_watch(void);\n"
                "void manual_probe_step(void);\n"
                "#endif\n")
    with open(probe_c, "w", encoding="utf-8", newline="\n") as f:
        f.write('#include "manual_probe.h"\n'
                '#include "scut_sdk.h"\n'
                '\n'
                '/* 手写注册：模拟真实用户把结构体成员单独暴露出来看。\n'
                '   注意这类变量在 DWARF 里【没有独立条目】，所以"手写"的判据\n'
                '   必须来自扫源码，而不是来自变量清单。 */\n'
                'float  manual_probe_f;\n'
                'int    manual_probe_i;\n'
                '\n'
                'void manual_probe_watch(void)\n{\n'
                '    SCUT_WATCH_SCALAR("manual_probe_f", &manual_probe_f, SCUT_T_F32);\n'
                '    SCUT_WATCH_SCALAR("manual_probe_i", &manual_probe_i, SCUT_T_I32);\n'
                '}\n'
                '\n'
                'void manual_probe_step(void)\n{\n'
                '    manual_probe_f = 1.5f;\n'
                '    manual_probe_i = 42;\n'
                '}\n')

    cfg_path = os.path.join(proj, "scut_project.json")
    with open(cfg_path, "r", encoding="utf-8-sig") as f:
        cfg = json.load(f)
    cfg["hooks"]["init"].append("manual_probe_watch")
    cfg["hooks"]["frame"].append("manual_probe_step")
    with open(cfg_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    r = subprocess.run(
        [sys.executable, os.path.join(root, "tools", "scut_build.py"),
         "--project", proj, "--toolchain", CLANG_ROOT],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("  ⚠️  模板工程构建失败，后续组件测试可能失真：")
        print("     " + ((r.stderr or r.stdout or "")[-800:].replace("\n", "\n     ")))
        return proj

    # ★ 必须真的跑一次，把帧图产出来：
    #   dap / webview / json 这几条测试都读 .scut/frames 下的真实帧。
    #   只构建不运行的话那个目录是空的，它们会各自报"没画出内容"。
    exe = os.path.join(proj, ".scut", "bin", "scut_sim.exe")
    frames_dir = os.path.join(proj, ".scut", "frames")
    if os.path.isfile(exe):
        rr = subprocess.run(
            [exe, "--frames", "4", "--json", "--out", frames_dir],
            cwd=proj, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=180)
        got = len([l for l in (rr.stdout or "").splitlines() if '"frame"' in l])
        print("  已就绪的测试工程：%s（测试图 %d 张，跑出 %d 帧）" % (proj, n, got))
    else:
        print("  已就绪的测试工程：%s（未找到仿真程序）" % proj)
    return proj


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default="",
                    help="被测工程目录；留空 = 自动从模板新建一个干净的（推荐）")
    ap.add_argument("--also-cn", action="store_true",
                    help="在含中文与空格的工程路径上再跑一遍端到端")
    args = ap.parse_args()

    banner("0/11  准备被测工程（从模板新建并构建）")
    proj = args.project or bootstrap_project(ROOT)

    banner("1/11  端到端：模板工程 → 零注册用户代码 → 构建 → 运行")
    # ★ 这条排在第一位：它验证的是【设计理念本身】（用户代码零注册、
    #   环境接管图像管道、配置真的生效）。后面的测试都是组件级的，
    #   组件都对但主线断了，这个环境依然是不可用的。
    run("e2e", [PY, os.path.join(HERE, "test_e2e_pipeline.py")])

    banner("2/11  接线单元边界（三条「静默算错」缺陷的回归）")
    # ★ 这三条都是"构建成功、运行正常、结果悄悄是错的"：
    #   同函数填两阶段（性能数字少一半）、--no-watch 重复定义、
    #   结果图数组名指向标量（越界读）。它们不会让任何东西看起来坏掉，
    #   所以必须有专门的测试盯着。
    run("glue-edges", [PY, os.path.join(HERE, "test_glue_edges.py")])

    banner("3/11  自动符号发现（35 变量 × gcc + clang）")
    run("symbols", [PY, os.path.join(HERE, "test_symbols.py"),
                    "--cc", "gcc", "--also", CLANG])

    banner("4/11  JSON 协议合法性（插件依赖它）")
    run("json", [PY, os.path.join(HERE, "check_json_protocol.py")])

    banner("5/11  内存安全（两处 snprintf 返回值误用 → 栈越界）")
    # ★ 这条盯的是"越界但不崩溃"的那类缺陷：静默、随机、只在特定输入下出现，
    #   常规功能回归永远测不到。它直接 include 真实源码并用
    #   AddressSanitizer + 金丝雀双重判据验证。
    #   已经抓到过两个真实缺陷：json_escape 越界写、scut_watch_read 越界读。
    run("mem-safety", [PY, os.path.join(HERE, "test_mem_safety.py")])

    banner("6/11  插件纯逻辑（协议解析 / PPM / 诊断）")
    run("extension", ["node", os.path.join(HERE, "extension_smoke.js"),
                      os.path.join(proj, ".scut", "frames"),
                      os.path.join(proj, ".scut", "bin", "scut_sim.exe")])

    banner("7/11  会话：运行 / 测速 / 翻页 / 停止（ACK 背压链路）")
    # ★ 这条盯的是"按钮点了到底有没有反应"：运行/测速/翻页全都靠 ACK 背压
    #   驱动仿真进程前进，背压断在哪一环的表现都是"画面停在第 1 帧"、不报错。
    #   它已经抓到过一个真实缺陷：runFrames(N) 会多跑一帧。
    run("session", ["node", os.path.join(HERE, "run_frames.js"),
                    os.path.join(proj, ".scut", "bin", "scut_sim.exe"), proj])

    banner("8/11  主动暴露变量（源码扫描 → 分组 → 恒显示）")
    # ★ 这条盯的是"用户主动注册的结构体成员能不能在面板里看见"。
    #   它已经抓到过一个真实缺陷：判据用"运行期注册表减编译期 DWARF"，
    #   而两边完全重合、差集恒空，导致主动暴露永远是 0 个、面板全空。
    run("manual-vars", ["node", os.path.join(HERE, "manual_vars.js"), proj])

    banner("9/11  调试器真实 DAP 会话（lldb-dap）")
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

    banner("10/11  Webview 渲染（真实 Chromium + 真实帧数据）")
    wv_out = os.path.join(tempfile.gettempdir(), "scut_wv_test")
    ok, out = run("webview", ["node", os.path.join(HERE, "webview_render.js"),
                              os.path.join(proj, ".scut", "frames"), wv_out])
    # 渲染判定在脚本内部打印；这里再核一次关键词，避免"脚本没崩但也没画出来"
    if ok and "渲染判定: ✅" not in out:
        results[-1] = ("webview", False, "未画出内容")
        print("  --> ❌ 脚本成功退出，但渲染判定未通过")

    if args.also_cn:
        banner("11/11  端到端（含空格 + 中文的工程路径）")
        cn = os.path.join(tempfile.gettempdir(), "scut proj 中文", "demo")
        if os.path.isdir(cn):
            run("cn-e2e", ["node", os.path.join(HERE, "extension_smoke.js"),
                           os.path.join(cn, ".scut", "frames"),
                           os.path.join(cn, ".scut", "bin", "scut_sim.exe")])
        else:
            print("  SKIP  中文路径工程不存在：%s" % cn)
    else:
        banner("11/11  跳过（用 --also-cn 启用中文路径端到端）")

    banner("汇总")
    npass = sum(1 for _, ok, _ in results if ok)
    for name, ok, note in results:
        print("  %s  %-12s %s" % ("✅" if ok else "❌", name, note))
    print("\n  %d/%d 通过" % (npass, len(results)))
    return 0 if npass == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
