#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""toolchain.py —— 测试用的工具链定位（唯一入口）。

★ 为什么单独一个文件（本文件存在的理由）：
    测试文件里曾经【各自写死】`D:\\TOOLS\\llvm-mingw`。那是开发机的路径，
    换台机器整套回归就跑不起来 —— 而"能跑回归"正是这个仓库能交给别人的前提。

    这里的解析顺序与【产品代码】保持一致（见 extension/src/toolchain.ts）：
        1) 命令行 --toolchain（由 run_all_tests.py 透传）
        2) 环境变量 SCUT71_TOOLCHAIN
        3) PATH 上的 clang（用 shutil.which，跨平台）
        4) 常见位置的兜底探测（仅作最后手段，且只在 Windows 上）

    ★ 刻意【不】在模块导入时抛异常：找不到就返回空串，
      由调用方决定是跳过（skip）还是硬失败（fail）——
      例如 e2e 测试缺工具链应当报错，而某个只用 Python 的检查应当照跑。
"""

import os
import shutil
import sys

# 允许用环境变量指定，便于 CI 或换机器
ENV_VAR = "SCUT71_TOOLCHAIN"

# 兜底探测的候选（最后手段）。刻意很短：猜目录在本项目上被证伪过两次，
# 这里只为"独立 clone 下来也能跑"留一条路，不追求覆盖所有发行版。
#
# ★ 这里【不得】出现任何具体机器的路径（例如 D:\TOOLS\llvm-mingw）——
#   文件开头那段注释骂的就是这件事，而它自己曾经又写了一条，
#   靠 test_mem_safety.py 的扫描范围恰好不查 tests/ 才没被发现。
#   要指定自己的工具链，用 --toolchain 或 SCUT71_TOOLCHAIN 环境变量。
_FALLBACK_ROOTS = [
    r"C:\llvm-mingw",
    os.path.expanduser(r"~\llvm-mingw"),
    "/opt/llvm-mingw",
    "/usr/local/llvm-mingw",
]


def _has_clang(root):
    """根目录下是否有 bin/clang(.exe)。"""
    if not root:
        return False
    for name in ("clang.exe", "clang"):
        if os.path.isfile(os.path.join(root, "bin", name)):
            return True
    return False


def _try(explicit=None):
    """按优先级返回工具链根目录；都找不到返回空串。"""
    # 1) 显式传入（命令行）
    if explicit and _has_clang(explicit):
        return explicit

    # 2) 环境变量
    env = (os.environ.get(ENV_VAR) or "").strip().strip('"')
    if env and _has_clang(env):
        return env

    # 3) PATH 上的 clang —— 用户自己装好并确认能用的证据
    exe = shutil.which("clang") or shutil.which("clang.exe")
    if exe:
        # <root>/bin/clang  →  <root>
        root = os.path.dirname(os.path.dirname(os.path.abspath(exe)))
        if _has_clang(root):
            return root

    # 4) 兜底候选
    for cand in _FALLBACK_ROOTS:
        if _has_clang(cand):
            return cand

    return ""


def resolve(explicit=None):
    """返回工具链根目录（含 bin/clang.exe 的那一层）；找不到返回 ''。"""
    return _try(explicit)


def clang(explicit=None):
    """返回 clang 可执行文件路径；找不到返回 ''。"""
    root = _try(explicit)
    if not root:
        return ""
    for name in ("clang.exe", "clang"):
        p = os.path.join(root, "bin", name)
        if os.path.isfile(p):
            return p
    return ""


def lldb_dap(explicit=None):
    """返回 lldb-dap 路径；找不到返回 ''（调试测试据此跳过）。"""
    root = _try(explicit)
    if not root:
        return ""
    for name in ("lldb-dap.exe", "lldb-dap"):
        p = os.path.join(root, "bin", name)
        if os.path.isfile(p):
            return p
    return ""


def require(explicit=None):
    """要求工具链存在，否则给出可执行的中文提示并退出。

    供"缺了就没法测"的入口使用（run_all_tests.py）。
    """
    root = _try(explicit)
    if root:
        return root
    sys.stderr.write(
        "找不到工具链（需要 LLVM-MinGW 之类的 clang）。\n"
        "    下一步（任选其一）：\n"
        "      1) 命令行指定： python tests/run_all_tests.py --toolchain <根目录>\n"
        "      2) 环境变量：   set %s=<根目录>\n"
        "      3) 把 clang 的 bin 目录加进 PATH\n"
        "    ★ <根目录> 指的是【内含 bin\\clang.exe 的那一层】。\n"
        % ENV_VAR)
    raise SystemExit(2)


# ---------------------------------------------------------------------------
# 测试用图集
#
# ★ 为什么要有它：测试需要一组测试图，而它【就在本仓库里】
#   （tests/fixtures/pic/1，36 张 BMP）。原先有几个测试去仓库外的
#   仓库外某个测试工程的 pic/ 拿图 —— 那是开发机上恰好
#   存在的目录，别人 clone 下来没有，测试就静默少跑一部分。
# ---------------------------------------------------------------------------
FIXTURE_PIC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "fixtures", "pic", "1")


def fixture_pic_dir():
    """返回仓库内自带的测试图目录；不存在返回 ''。"""
    return FIXTURE_PIC if os.path.isdir(FIXTURE_PIC) else ""
