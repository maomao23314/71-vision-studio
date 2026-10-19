#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scut_build.py —— SCUT-71 Vision Studio 构建编排层。

用法：
    python tools/scut_build.py --project <工程目录> [选项]
    python tools/scut_build.py doctor --project <工程目录>
    python tools/scut_build.py clean  --project <工程目录>

============================================================================
为什么这个脚本长成这样（设计说明，改代码前请先读）
============================================================================

【一】库方向反转：环境 = 静态库，用户 = 普通 .o
----------------------------------------------------------------------------
    旧方案： main(环境) + libuser.a     → 必须 -Wl,--whole-archive，
                                         否则用户构造函数被【静默丢弃】
    新方案： libscut_core.a + user.o    → 不需要任何特殊链接选项

    静态库是「按需拉取」的：用户 .o 是【直接链接输入】而非库成员，
    不存在被丢弃的问题；而 libscut_core.a 里的 main 被 CRT 引用，必然被拉取。
    所以本脚本【刻意不传 --whole-archive】——传了不会更正确，只会掩盖架构问题。

【二】两遍编译：为什么必须编译「包装单元」而不是用户原文件
----------------------------------------------------------------------------
    用户代码里有 static 全局变量（internal linkage）。独立的绑定编译单元
    【无法引用】它们（链接期 undefined reference）。实测三条路线：

        ① 独立绑定 TU        → static 变量链接失败            ❌
        ② -include 前置注入   → 声明尚未出现，编译失败          ❌
        ③ 包装单元            → 全部变量（含 static）注册成功  ✅

    包装单元 = #include "user.c" + constructor 里注册全部全局变量。
    所以本脚本对每个 .c 做：
        探针编译(-g -O0) → scut_symbols.py → 编译包装单元 = 真正的 .o

【三】bind 单元是唯一知道编译期尺寸的地方
----------------------------------------------------------------------------
    bind/scut_bind.c 包含 "scut_config.h"。而模板里的头文件叫 config.h。
    为了【两种命名都能用】且【不改动仓库里的 bind 源码】，本脚本在
    <project>/.scut/gen/ 下生成一个极薄的转发头 scut_config.h：

        #include "config.h"

    把它所在的目录放在 -I 的【最前面】，于是无论
        · 工程提供 config.h         → 转发头补齐 scut_config.h
        · 工程提供 scut_config.h    → 直接用工程的，不生成转发头
        · 两者都没有               → 由 SCUT_IMAGE_W/H 环境变量生成契约头
    bind 源码一行都不用改。

【四】为什么探针编译强制 -gdwarf-4（不是教条，是实测约束）
----------------------------------------------------------------------------
    clang 21 默认产 DWARF 5；而自动发现依赖 binutils 的 objdump，
    本机 binutils 2.30 的新 reader 读不了 DWARF 5 的 .debug_info
    （输出会是空章节，scut_symbols.py 一个变量都发现不了 —— 且【不报错】，
    属于最难查的静默失败）。llvm-objdump 则更糟：LLVM 21 已彻底移除
    --dwarf=info（只剩 =frames），直接失败。

    实测：clang 21 + binutils 2.30，加 -gdwarf-4 后 35/35 变量全部正确发现。
    所以探针编译恒用 -gdwarf-4（固定不变）。

    ★ 另一个实测坑：clang 输出 DWARF 偏移是「八位补零」(0x0000002a)，
      binutils 输出是「不定长」(0x2a)。scut_symbols.py 只认后者。
      本脚本因此【在调用前把探针 .o 规范化】：只做偏移补零的剥离，
      不做任何语义改动，且必须保留 5 空格前缀（深度判定依赖它）。

============================================================================
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Python 版本闸门
#
# 用户机器上 PATH 里的 python 可能是很老的版本（本机就有 3.6.2）。
# 与其抛出难以理解的语法错误，不如在这里给出人话提示。
# ---------------------------------------------------------------------------
if sys.version_info < (3, 7):  # pragma: no cover - 环境相关
    sys.stderr.write(
        "本脚本需要 Python 3.7 或更高版本，当前是 %d.%d。\n"
        "原因：脚本第 70 行用了 `from __future__ import annotations`，"
        "这是 3.7 才加入的特性；3.6 及更早会在那一行直接 SyntaxError。\n"
        "解决办法：装一个 Python 3.7+ 再重试。\n"
        "    · 装了 Anaconda：它自带一份，用 where python 或 conda 找；\n"
        "    · 没装：去 python.org 下载安装（勾选 Add to PATH）；\n"
        "    · VS Code 里也可以设置 python.defaultInterpreterPath 指向它。\n"
        "★ 这段提示里刻意【不写任何具体机器的绝对路径】——\n"
        "  开发者的本机路径对学生毫无意义，照着敲只会得到\n"
        "  \"路径不存在\"，反而把真正该做的事（装一个 Python）藏起来了。\n"
        % (sys.version_info[0], sys.version_info[1])
    )
    # ★ 闸门失败时【也要输出一份 JSON】。
    #   原先这里直接 raise SystemExit(2)、不吐 JSON，而插件侧
    #   （extension/src/build.ts）只在看到 /SyntaxError/ 时才换解释器重试。
    #   于是版本刚好卡在闸门下沿时，插件拿不到结构化结果，
    #   只能显示一句笼统的"无法运行构建脚本"——
    #   真实原因（"你的 Python 太老"）根本没传到用户眼前。
    #   这里补一行合法 JSON，让插件能把准确原因显示出来。
    sys.stdout.write(json.dumps({
        "ok": False,
        "exePath": None,
        "output": "",
        "elapsedMs": 0,
        "errors": [{
            "severity": "error",
            "message": "Python 版本过低（当前 %d.%d，需要 3.7+）。\n"
                       "    下一步：用配置面板的「工具链 › Python 解释器路径」"
                       "指定一个 3.7+ 的 python.exe。"
                       % (sys.version_info[0], sys.version_info[1]),
        }],
    }, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(2)

# Windows 控制台默认编码是 GBK，直接输出中文/符号在部分终端会抛
# UnicodeEncodeError。统一改成 UTF-8 + 替换策略，保证任何终端都能跑。
# ★ 注意：--json 模式下 stdout 是给插件解析的，UTF-8 也是正确选择。
for _stream_name in ("stdout", "stderr"):
    _s = getattr(sys, _stream_name, None)
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass


# ===========================================================================
# 常量
# ===========================================================================

# 生成物目录（相对工程根）。
SCUT_DIR = ".scut"

EXE_NAME = "scut_sim.exe"

# 外部命令的超时（秒）。两个不同的量级，各有理由：
#
#   CMD_TIMEOUT_SEC   正式构建（编译 / 链接 / 归档）
#                     给得宽：慢机器上链接带调试信息的静态库确实可能到几十秒，
#                     首次构建还要现编核心库。它的目的是"别永久挂住"，
#                     不是"卡性能预算"。
#
#   PROBE_TIMEOUT_SEC 版本探测（clang --version / objdump --version）
#                     给得短：这只是锦上添花的诊断，而工具链探测阶段
#                     要连试多个候选（objdump 最多 8 个路径）。
#                     若每个都等 300 秒，光探测就能耗掉几十分钟 ——
#                     而用户看到的是"插件卡住了"。
CMD_TIMEOUT_SEC = 300.0
PROBE_TIMEOUT_SEC = 20.0

# 核心静态库在工程内的默认位置
DEFAULT_CORE_LIB_REL = os.path.join(SCUT_DIR, "lib", "libscut_core.a")

# 工具链候选根目录：--toolchain > SCUT71_TOOLCHAIN > PATH
#
# ★★★ 这个列表【刻意为空】 ★★★
#   它先后被填过两轮，两轮都是错的：
#     ① 只填开发机绝对路径 → 换个机器必然落空（用户实测：明明有工具链
#        却在下载 182MB）
#     ② 改填"通用安装位置" → 开发机自己反而开始下载（用户再次实测）
#   两种写法都在赌"我知道别人把工具链装在哪"。
#
#   而这个信息【本来就不该猜】：每个人的安装位置都不一样，
#   装在哪是用户自己的决定。
#
#   所以插件侧的策略是【问】：找不到就弹窗，
#   让用户选「指定已有的」还是「帮我下载」（见 src/toolchain.ts
#   的 promptToolchainMissing）。
#   本脚本是插件的下游，拿到的永远是用户【明确指定过】的路径
#   —— 猜测这件事已经在上游做完了，不该在这里重演一遍。
#
#   保留这个空列表而不是删掉，是为了标出"探测链的最后一环在此收口"。
TOOLCHAIN_ROOT_CANDIDATES: list = []

# binutils 的 objdump 候选（相对「工具链根」之外的本机常见位置）。
# ★ 为什么必须找 binutils：见文件头【四】。
BINUTILS_OBJDUMP_CANDIDATES = [
    r"C:\Program Files\Git\mingw64\bin\objdump.exe",
    r"C:\mingw64\bin\objdump.exe",
    r"C:\msys64\mingw64\bin\objdump.exe",
]

# binutils objdump 里 DWARF 偏移的写法： `<1><2a>` / `  <2b>`。
# clang 会写成 `<0x0000002a>`，见 normalize_probe_dwarf_text() 的说明。
_HEX_OFFSET_RE = re.compile(r"^( *<)([0-9a-fA-F]{5,})(>.*)$")

# gcc/clang 诊断： path:line:col: severity: message
_DIAG_FULL_RE = re.compile(
    r"^(?P<file>.*?):(?P<line>\d+):(?P<col>\d+):\s*"
    r"(?P<sev>fatal error|error|warning|note|remark)\s*:\s*(?P<msg>.*)$"
)
# 无列号： path:line: severity: message
_DIAG_NOCOL_RE = re.compile(
    r"^(?P<file>.*?):(?P<line>\d+):\s*"
    r"(?P<sev>fatal error|error|warning|note|remark)\s*:\s*(?P<msg>.*)$"
)
# 无行号（如 clang: error: ... / ld.lld: error: ...）
_DIAG_NOLOC_RE = re.compile(
    r"^(?P<file>.*?):\s*(?P<sev>fatal error|error|warning)\s*:\s*(?P<msg>.*)$"
)

_SEV_MAP = {
    "fatal error": "error",
    "error": "error",
    "warning": "warning",
    "note": "info",
    "remark": "info",
}

# config.h 里的尺寸宏。写 [-+*/()\s0-9A-Za-z_] 允许简单表达式，
# 但取值时只接受纯整数——表达式形式会明确报错而不是猜。
_IMAGE_W_RE = re.compile(r"^\s*#\s*define\s+SCUT_IMAGE_W\s+(.+?)\s*(?:/\*.*)?$",
                         re.MULTILINE)
_IMAGE_H_RE = re.compile(r"^\s*#\s*define\s+SCUT_IMAGE_H\s+(.+?)\s*(?:/\*.*)?$",
                         re.MULTILINE)


# ===========================================================================
# 输出层
#
# ★ --json 模式下【所有人类可读输出必须走 stderr】，stdout 只保留 JSON，
#   否则插件 JSON.parse 会直接失败（这是本工具最容易被写错的一点）。
# ===========================================================================

class Reporter:
    """统一的人话输出器，负责 --json 下的 stdout/stderr 分流与计时。"""

    def __init__(self, as_json: bool, verbose: bool) -> None:
        self.as_json = as_json
        self.verbose = verbose
        self._lock = threading.Lock()

    def human(self, msg: str) -> None:
        """人类可读信息。--json 时走 stderr，否则走 stdout。"""
        stream = sys.stderr if self.as_json else sys.stdout
        with self._lock:
            stream.write(msg + "\n")
            stream.flush()

    def warn(self, msg: str) -> None:
        with self._lock:
            sys.stderr.write("警告: " + msg + "\n")
            sys.stderr.flush()

    def error(self, msg: str) -> None:
        with self._lock:
            sys.stderr.write("错误: " + msg + "\n")
            sys.stderr.flush()

    def detail(self, msg: str) -> None:
        """只在 --verbose 下打印的细节（例如每一条命令行）。"""
        if self.verbose:
            self.human(msg)

    def emit_json(self, payload: Dict[str, Any]) -> None:
        """把机器可读结果写到 stdout。永远只有这一处写 stdout。"""
        with self._lock:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            sys.stdout.write("\n")
            sys.stdout.flush()


class StageTimer:
    """分阶段计时，最后统一汇报（需求：Report timing per stage）。"""

    def __init__(self, reporter: Reporter) -> None:
        self.reporter = reporter
        self._t0 = time.perf_counter()
        self.stages: List[Tuple[str, float]] = []

    def stage(self, name: str) -> "_Stage":
        return _Stage(self, name)

    def _record(self, name: str, ms: float) -> None:
        self.stages.append((name, ms))

    def report(self) -> None:
        total = (time.perf_counter() - self._t0) * 1000.0
        self.reporter.human("")
        self.reporter.human("—— 各阶段耗时 ——")
        for name, ms in self.stages:
            self.reporter.human("  %-24s %8.1f ms" % (name, ms))
        self.reporter.human("  %-24s %8.1f ms" % ("合计", total))

    def total_ms(self) -> float:
        return (time.perf_counter() - self._t0) * 1000.0


class _Stage:
    def __init__(self, timer: StageTimer, name: str) -> None:
        self.timer = timer
        self.name = name
        self.t0 = 0.0

    def __enter__(self) -> "_Stage":
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.timer._record(self.name, (time.perf_counter() - self.t0) * 1000.0)


# ===========================================================================
# 进程调用
# ===========================================================================

def decode_output(raw: bytes) -> str:
    """
    把子进程原始字节解码成文本。

    ★ 为什么不用 subprocess 的 text=True：
      编译器诊断里会带上【工程路径】。工程路径可能含中文（本项目明确要求
      支持中文路径），而 Windows 上编译器输出编码可能是 UTF-8（clang）
      或本地代码页 GBK（gcc）。text=True 只按一个编码解，另一种就会炸或
      变成乱码。

    ★★ 为什么不能简单地"依次 try 三个编码"（本函数曾经的写法）★★
      原先写的是 `for enc in ("utf-8","gbk","latin-1"): try: return decode(enc)`。
      两个问题：

      (1) **gbk 会静默乱码而不是抛异常**。GBK 几乎能接受任意字节序列 ——
          一段 UTF-8 的中文诊断在 gbk 下通常也能"解出来"，只是全是乱码，
          于是永远走不到后面的候选。用户看到一屏看不懂的字，
          却以为是编译器本身在说怪话。
      (2) **latin-1 永远成功**，所以列表末尾那个 errors="replace" 的兜底
          是【不可达的死代码】。

      正确做法是先用【能自证的编码】。UTF-8 自带约束：非法序列必然抛
      UnicodeDecodeError。所以先按 UTF-8 严格解 —— 成功就一定是真 UTF-8；
      失败才说明是本地代码页（GBK）。这与 extension/src/build.ts 的
      decodeStream 用的是同一个判据（那里用的是 U+FFFD 替换字符哨兵），
      两边口径一致。
    """
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    # 不是合法 UTF-8 → 本地代码页（中文 Windows 是 GBK/936）。
    # 用 replace 兜住极少数既非 UTF-8 也非 GBK 的字节，保证永不抛。
    try:
        return raw.decode("gbk", errors="replace")
    except LookupError:  # pragma: no cover - 无 gbk 编解码器的精简 Python
        return raw.decode("utf-8", errors="replace")


class CmdResult:
    __slots__ = ("argv", "code", "out")

    def __init__(self, argv: Sequence[str], code: int, out: str) -> None:
        self.argv = list(argv)
        self.code = code
        self.out = out

    def pretty(self) -> str:
        """给人看的命令行。仅用于显示；真正执行永远用列表形式。"""
        return " ".join('"%s"' % a if " " in a else a for a in self.argv)


def run_cmd(argv: Sequence[str], cwd: Optional[str] = None,
            env: Optional[Dict[str, str]] = None,
            timeout: float = CMD_TIMEOUT_SEC) -> CmdResult:
    """
    执行外部命令。

    ★ 全程使用【列表形式】参数、绝不 shell=True、绝不做字符串拼接。
      这是「路径含空格与中文必须能用」的唯一可靠做法：
      字符串拼接在遇到 `D:\\我的 工程\\code\\main.c` 时必然被拆成两个参数，
      而编译器只会报「no such file」，用户完全看不出真正原因。

    ★ timeout 是【必须有】的，不是可选的谨慎：
      构建要拉 clang / objdump / ar 三个外部程序，其中 objdump 还要在
      最多 8 个候选路径上逐个试。任何一个挂住（杀毒软件拦在启动阶段、
      网络盘掉线、工具链版本不匹配而卡在等待输入），
      没有超时的 subprocess.run 会让构建【永久挂起】——
      用户看到的是"点了编译，进度条一直转"，没有任何报错可查。
      超时后按失败处理，理由里说清是哪一个命令超时。

    ★ 为什么默认值给得比较宽（300 秒）：
      链接一份带调试信息的静态库在慢机器上确实可能到几十秒，
      首次构建还要现编核心库。宁可比必要值宽松，也不要误杀正常构建 ——
      超时的目的是"别永久挂住"，不是"卡性能预算"。
    """
    try:
        proc = subprocess.run(
            list(argv),
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            shell=False,
            timeout=timeout,
        )
    except FileNotFoundError:
        return CmdResult(argv, 127,
                         "找不到可执行文件: %s\n请检查 --toolchain 指向的目录是否正确。"
                         % argv[0])
    except subprocess.TimeoutExpired:
        return CmdResult(argv, 124,
                         "命令超时（超过 %.0f 秒）: %s\n"
                         "    原因：多半是杀毒软件拦在进程启动阶段，"
                         "或工具链与系统不匹配而卡住。\n"
                         "    下一步：先单独在终端里跑一次这条命令看它停在哪；"
                         "确认工具链版本与系统位数（x86_64）匹配。"
                         % (timeout, " ".join(list(argv)[:2])))
    except OSError as exc:  # pragma: no cover - 环境相关
        return CmdResult(argv, 126, "启动命令失败: %s\n命令: %s" % (exc, argv[0]))
    return CmdResult(argv, proc.returncode, decode_output(proc.stdout))


def atomic_write_text(path: str, text: str, encoding: str = "utf-8") -> None:
    """
    原子写入文本：先写同目录临时文件，再 os.replace 覆盖。

    ★ 为什么必须这么做：插件会在用户点「构建」的瞬间读取这些生成物。
      直接原地写会留下【半截文件】——表现为变量面板偶尔为空、JSON 解析
      偶发失败，且无法复现。os.replace 在同一文件系统内是原子的。
    """
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".scut_tmp_", dir=d)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ===========================================================================
# 工具链探测
# ===========================================================================

class Toolchain:
    """一次探测的结果。字段语义与 extension/src/types.ts 的 Toolchain 对应。"""

    def __init__(self) -> None:
        self.root: str = ""
        self.cc: str = ""
        self.objdump: str = ""
        self.objdump_is_binutils = False
        self.lldb_dap: str = ""
        self.clangd: str = ""
        self.python: str = ""
        self.warnings: List[str] = []
        self.cc_version: str = ""
        self.objdump_version: str = ""

    def to_json(self) -> Dict[str, Any]:
        return {
            "root": self.root,
            "cc": self.cc,
            "objdump": self.objdump,
            "objdumpIsBinutils": self.objdump_is_binutils,
            # ★ objdumpVersion 必须导出：doctor 的人读输出里有它（"版本 : …"），
            #   但 to_json 漏了 —— 于是插件用 --json 拿到的工具链信息
            #   比终端里少一项，"objdump 是不是 binutils"只能看到一个布尔值，
            #   出问题时没法把手上的版本号贴出来。
            "objdumpVersion": self.objdump_version or None,
            "lldbDap": self.lldb_dap or None,
            "clangd": self.clangd or None,
            "python": self.python or None,
            "version": self.cc_version or None,
            "warnings": list(self.warnings),
        }


def _first_existing(paths: Sequence[str]) -> str:
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return ""


def _bin_of(root: str) -> str:
    """
    允许用户把 --toolchain 指到两种位置：
        C:\\Program Files\\LLVM        （根目录，bin/ 在里面）
        C:\\Program Files\\LLVM\\bin   （直接就是 bin）
    两种都接受，避免「明明路径没错却报找不到编译器」。
    """
    if os.path.isfile(os.path.join(root, "bin", "clang.exe")):
        return os.path.join(root, "bin")
    if os.path.isfile(os.path.join(root, "clang.exe")):
        return root
    if os.path.isfile(os.path.join(root, "bin", "clang")):
        return os.path.join(root, "bin")
    if os.path.isfile(os.path.join(root, "clang")):
        return root
    return ""


def _probe_version(exe: str, timeout: float = PROBE_TIMEOUT_SEC) -> str:
    """取版本字符串的第一行（探测失败不阻断流程）。

    ★ timeout 必须【真的传下去】：它原先只是签名里的一个形参，
      从不使用 —— 于是"取版本"这一步实际用的是 run_cmd 的默认超时。
      版本探测比正式构建"更该"有短超时：它只是个锦上添花的诊断，
      而工具链探测阶段要连试多个候选（objdump 最多 8 个路径），
      每个都等 300 秒的话，光探测就能耗掉几十分钟。
    """
    if not exe:
        return ""
    r = run_cmd([exe, "--version"], timeout=timeout)
    if r.code != 0:
        return ""
    for line in r.out.splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def _objdump_supports_dwarf_info(objdump: str, cc: str) -> Optional[bool]:
    """
    功能探测：真的拿一个带 DWARF 的小目标文件跑一次 `objdump --dwarf=info`。

    ★ 为什么不能只看版本号：
      · llvm-objdump 在 LLVM 21 里移除了 --dwarf=info → 直接非 0 退出；
      · 但有的 binutils 太旧，能接受该选项却读不懂 DWARF 5，
        输出为空章节、退出码仍是 0 —— 这种【静默失败】只能靠功能探测发现。
    返回 True/False；无法探测（没有 clang）时返回 None。
    """
    if not cc:
        return None
    tmp = tempfile.mkdtemp(prefix="scut_doctor_")
    try:
        src = os.path.join(tmp, "probe.c")
        obj = os.path.join(tmp, "probe.o")
        with open(src, "w", encoding="ascii", newline="\n") as f:
            # 必须有一个会被引用的全局变量，否则 clang 会把它优化掉，
            # 探测就测不到「能不能看见变量」这件事。
            f.write("#include <stdint.h>\n"
                    "uint8_t scut_doctor_probe_v[4][8];\n"
                    "int main(void){ scut_doctor_probe_v[1][2] = 3;"
                    " return scut_doctor_probe_v[1][2]; }\n")
        rc = run_cmd([cc, "-std=c11", "-gdwarf-4", "-O0", "-c", src, "-o", obj])
        if rc.code != 0:
            return None
        r = run_cmd([objdump, "--dwarf=info", obj])
        if r.code != 0:
            return False
        # 光有 DWARF 不够，必须真的能看到文件作用域变量才算可用。
        return "scut_doctor_probe_v" in r.out
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def detect_toolchain(explicit_root: str, verbose_reporter: Optional[Reporter] = None
                     ) -> Toolchain:
    """
    按优先级探测工具链：
        --toolchain  >  SCUT71_TOOLCHAIN 环境变量  >  PATH
    """
    tc = Toolchain()

    roots: List[str] = []
    if explicit_root:
        roots.append(explicit_root)
    env_root = os.environ.get("SCUT71_TOOLCHAIN", "").strip()
    env_root = env_root.strip('"').strip("'")
    if env_root:
        roots.append(env_root)
    roots.extend(TOOLCHAIN_ROOT_CANDIDATES)

    for root in roots:
        bindir = _bin_of(root)
        if bindir:
            tc.root = root
            tc.cc = _first_existing([
                os.path.join(bindir, "clang.exe"),
                os.path.join(bindir, "clang"),
            ])
            tc.lldb_dap = _first_existing([
                os.path.join(bindir, "lldb-dap.exe"),
                os.path.join(bindir, "lldb-dap"),
            ])
            tc.clangd = _first_existing([
                os.path.join(bindir, "clangd.exe"),
                os.path.join(bindir, "clangd"),
            ])
            break

    if not tc.cc:
        # 退回到 PATH。注意 shutil.which 会正确处理 PATHEXT，能区分
        # llvm-mingw 的 objdump（脚本包装）和 binutils 的 objdump.exe。
        for name in ("clang.exe", "clang"):
            found = shutil.which(name)
            if found:
                tc.cc = found
                tc.root = tc.root or os.path.dirname(found)
                break

    if not tc.cc:
        tc.warnings.append(
            "找不到 clang 编译器。请安装 LLVM-MinGW（自带 MinGW sysroot，"
            "装完即可编译），或把它的 bin 目录加进 PATH，"
            "然后用 --toolchain 指定根目录。"
        )
        # 没有编译器就没法做功能探测，但仍尽量把 objdump 找出来报告。
        tc.objdump = _find_objdump(None)
        if tc.objdump:
            tc.objdump_version = _probe_version(tc.objdump)
            tc.objdump_is_binutils = "GNU objdump" in tc.objdump_version
        tc.python = _find_python()
        return tc

    tc.cc_version = _probe_version(tc.cc)

    # ---- objdump：★ 必须是 binutils 的，不能是 LLVM 的 -------------------
    tc.objdump = _find_objdump(tc)
    if tc.objdump:
        tc.objdump_version = _probe_version(tc.objdump)
        tc.objdump_is_binutils = "GNU objdump" in tc.objdump_version
        usable = _objdump_supports_dwarf_info(tc.objdump, tc.cc)
        if usable is False:
            tc.objdump_is_binutils = False
        elif usable is True:
            tc.objdump_is_binutils = True

    if not tc.objdump or not tc.objdump_is_binutils:
        tc.warnings.append(
            "找不到可用的 objdump。自动符号发现依赖 `objdump --dwarf=info`，"
            "而 LLVM 21 已移除该选项（llvm-objdump 只支持 --dwarf=frames）——"
            "所以必须用 binutils 的 objdump，不能是 llvm-objdump。"
            "请安装 MinGW-w64（提供 binutils），或把 binutils 的 bin 目录"
            "加进 PATH，然后重跑 doctor。"
            "临时绕过：加 --no-watch 仍可正常构建，只是变量面板会是空的。"
        )

    # ---- python ----------------------------------------------------------
    tc.python = _find_python()

    # ---- 调试/语言服务（缺失只降级，不阻断） ------------------------------
    if not tc.lldb_dap:
        found = shutil.which("lldb-dap.exe") or shutil.which("lldb-dap")
        tc.lldb_dap = found or ""
    if not tc.clangd:
        found = shutil.which("clangd.exe") or shutil.which("clangd")
        tc.clangd = found or ""

    return tc


def _find_objdump(tc: Optional[Toolchain]) -> str:
    """
    找 binutils 的 objdump。

    ★ 顺序很关键：
      1) 显式候选路径里的 binutils（C:\\Program Files\\Git\\mingw64\\bin 等）；
      2) PATH 上的 `objdump.exe` —— 【带扩展名】才会命中真正的 .exe；
         llvm-mingw 的 bin 目录里同时有 `llvm-objdump.exe` 和无扩展名的
         `objdump` 脚本（内容就是 llvm-objdump），若用 which('objdump')
         在 PATHEXT 顺序下可能命中那个脚本，得到的是 LLVM 版本。
      3) 兜底：PATH 上的 objdump。
    每取到一个都用 `--version` 验证是不是 GNU binutils。
    """
    candidates: List[str] = []
    candidates.extend(BINUTILS_OBJDUMP_CANDIDATES)
    for exe in ("objdump.exe", "x86_64-w64-mingw32-objdump.exe",
                "objdump", "objdump.bat", "objdump.cmd"):
        found = shutil.which(exe)
        if found:
            candidates.append(found)
    if tc and tc.root:
        for exe in ("objdump.exe", "llvm-objdump.exe", "objdump"):
            p = os.path.join(tc.root, "bin", exe)
            if os.path.isfile(p):
                candidates.append(p)

    seen = set()
    fallback = ""
    for cand in candidates:
        key = os.path.normcase(os.path.abspath(cand))
        if key in seen:
            continue
        seen.add(key)
        ver = _probe_version(cand)
        if "GNU objdump" in ver:
            return cand
        if not fallback:
            fallback = cand
    return fallback


def _find_python() -> str:
    """
    找跑 scut_symbols.py 的解释器。

    ★ 优先用【正在运行本脚本的解释器】：它一定是可用的、且版本已通过顶部
      的 3.7 闸门，不会出现「构建用 3.12、符号发现却拿 3.6 去跑」这种错配
      （本机 PATH 里恰好就有一个 Python 3.6.2，实测过这个坑）。
    """
    cur = sys.executable
    if cur and os.path.isfile(cur):
        return cur
    env_py = os.environ.get("SCUT71_PYTHON", "").strip().strip('"').strip("'")
    if env_py and os.path.isfile(env_py):
        return env_py
    for name in ("python.exe", "python3.exe", "python", "python3"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def _find_objcopy(cc: str) -> str:
    """
    找 objcopy，用于 DWARF 偏移写法规范化（见 normalize_probe_obj_dwarf）。

    优先取【与 clang 同目录】的那一份：llvm-mingw 自带 objcopy.exe，
    与编译器同源，行为最可预期。找不到就返回空串，规范化会被跳过。
    """
    if cc:
        cand = os.path.join(os.path.dirname(cc), "objcopy.exe")
        if os.path.isfile(cand):
            return cand
    return shutil.which("objcopy.exe") or shutil.which("objcopy") or ""


# ===========================================================================
# 工程模型
# ===========================================================================


class Project:
    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        self.code_dir = os.path.join(self.root, "code")
        self.pic_dir = os.path.join(self.root, "pic")
        self.scut_dir = os.path.join(self.root, SCUT_DIR)
        self.obj_dir = os.path.join(self.scut_dir, "obj")
        self.lib_dir = os.path.join(self.scut_dir, "lib")
        self.gen_dir = os.path.join(self.scut_dir, "gen")
        self.bin_dir = os.path.join(self.scut_dir, "bin")
        self.exe_path = os.path.join(self.bin_dir, EXE_NAME)
        self.extra_mk = os.path.join(self.root, "scut.extra.mk")

    # --- 编译期契约头文件 ---------------------------------------------------
    def find_config_header(self) -> Tuple[str, str]:
        """
        返回 (头文件绝对路径, 头文件基名)。找不到返回 ("", "")。

        支持两种命名：优先 scut_config.h（bind 源码就是这么 include 的），
        其次 config.h（模板给用户的名字）。
        """
        for name in ("scut_config.h", "config.h"):
            p = os.path.join(self.root, name)
            if os.path.isfile(p):
                return p, name
        return "", ""

    def user_sources(self) -> List[str]:
        """递归收集 code/ 下的 .c，排序保证构建可复现。"""
        out: List[str] = []
        if not os.path.isdir(self.code_dir):
            return out
        for dirpath, dirnames, filenames in os.walk(self.code_dir):
            dirnames.sort()
            for fn in sorted(filenames):
                if fn.lower().endswith(".c"):
                    out.append(os.path.join(dirpath, fn))
        return out

    def ensure_dirs(self) -> None:
        for d in (self.obj_dir, self.lib_dir, self.gen_dir, self.bin_dir):
            os.makedirs(d, exist_ok=True)


# ===========================================================================
# config.h 解析（★ 绝不为了读数而编译：那要多花一秒多，而且没必要）
# ===========================================================================

class ConfigParseError(Exception):
    pass


def _strip_int_literal(raw: str) -> Optional[int]:
    """
    把一个宏值解析成整数。

    只接受纯整数（可带后缀 U/L/UL/LL）。刻意【不】求值表达式：
    用 Python 去 eval 一段 C 宏是危险且容易错的（整型提升、后缀、
    括号常量引用都会出问题）。遇到表达式就明确报错，让用户写清楚，
    比"算错了但看起来很成功"好得多。
    """
    s = raw.strip()
    # 去掉行尾注释
    s = re.sub(r"/\*.*?\*/", "", s).strip()
    s = re.sub(r"//.*$", "", s).strip()
    # 去掉一层或两层括号
    while s.startswith("(") and s.endswith(")"):
        inner = s[1:-1].strip()
        if inner.count("(") != inner.count(")"):
            break
        s = inner
    m = re.fullmatch(r"(0[xX][0-9a-fA-F]+|\d+)\s*([uUlL]*)", s)
    if not m:
        return None
    return int(m.group(1), 0)


def parse_image_size(header: str) -> Tuple[int, int]:
    """
    从 config.h 里读出 SCUT_IMAGE_W / SCUT_IMAGE_H。

    ★ 为什么不「编译一个小程序打印它」：
      那要多一次进程启动（秒级），而这两个宏在模板里就是字面量。
      正则足够，且失败时我们给的是可操作的提示，不是静默的 0。
    """
    with open(header, "r", encoding="utf-8-sig", errors="replace") as f:
        text = f.read()
    # 先把注释整体去掉，避免被注释里的示例宏误导
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)
    text = re.sub(r"//[^\n]*", " ", text)

    w_raw = _IMAGE_W_RE.search(text)
    h_raw = _IMAGE_H_RE.search(text)
    if not w_raw or not h_raw:
        missing = []
        if not w_raw:
            missing.append("SCUT_IMAGE_W")
        if not h_raw:
            missing.append("SCUT_IMAGE_H")
        raise ConfigParseError(
            "在 %s 里找不到 %s 的定义。这两个宏是编译期契约（用户算法里到处是"
            " int left_line[SCUT_IMAGE_H]; 这类声明，C 要求数组大小是编译期常量），"
            "不能缺失。请在 %s 里补上，例如：\n"
            "    #define SCUT_IMAGE_W  (188)\n"
            "    #define SCUT_IMAGE_H  (120)\n"
            "    （新工程不需要手写这个文件：在插件配置面板里填「图像尺寸」即可，\n"
            "      构建时会自动生成 .scut/gen/scut_config.h。这里读的是【老工程】\n"
            "      自己带的 config.h —— 把它补全，或改用 scut_project.json。）"
            % (header, " 和 ".join(missing), header)
        )
    w = _strip_int_literal(w_raw.group(1))
    h = _strip_int_literal(h_raw.group(1))
    if w is None or h is None:
        bad = "SCUT_IMAGE_W" if w is None else "SCUT_IMAGE_H"
        raw = w_raw.group(1) if w is None else h_raw.group(1)
        raise ConfigParseError(
            "%s 里的 %s 不是字面整数（读到的是 `%s`）。本工具刻意不支持表达式，"
            "因为用脚本求值 C 宏极易出错（整型提升、后缀、括号常量引用）。"
            "请直接写成十进制数，例如 #define SCUT_IMAGE_W (188)。"
            % (header, bad, raw.strip())
        )
    if not (0 < w <= 4096) or not (0 < h <= 4096):
        raise ConfigParseError(
            "%s 里的图像尺寸不合理：%d x %d。"
            "bind/scut_bind.c 里的静态断言要求尺寸在 1..4096 之间；"
            "超出范围会在编译期报「负数组大小」这种难懂的错，所以这里先拦下来。"
            % (header, w, h)
        )
    return w, h


# ===========================================================================
# 工程配置（scut_project.json）—— 单一真值来源
# ===========================================================================
#
# ★★ 为什么配置从 config.h 搬到 JSON ★★
#
#   用户原话："所有的配置不要丢在 config.h 吧，最好也有 UI，
#   然后可以用一个 json 记录，不然用户会乱搞。"
#
#   完全同意。config.h 的问题不是"多了个文件"，而是它同时扮演两个角色：
#     ① 编译期契约（图像尺寸）—— C 语言要求数组大小是常量，这个躲不掉；
#     ② 一堆可调参数（图集路径、扩展名、重复次数）—— 这些根本不是契约。
#   混在一起的结果是：用户改 ② 的时候会顺手改 ①，然后满屏红波浪线。
#
#   现在的分工：
#     scut_project.json  —— 用户/UI 编辑的唯一入口
#     .scut/gen/scut_config.h —— 构建时生成，带 DO NOT EDIT 头，只含契约
#
#   ★ 兼容：没有 JSON 的老工程仍按 config.h 走（迁移期不该强制用户改）。

PROJECT_CONFIG_NAME = "scut_project.json"

# 默认配置。键名与 extension/src/projectconfig.ts 的 interface 一一对应。
#
# ★★★ 0.9.4 起：配置只有这一个真值来源 ★★★
#
#   以前有两处，且互相覆盖：
#       VS Code settings.json  scut71.runtime.picDir / picExt / startFrame
#       工程 scut_project.json  pic.dir / pic.ext / pic.start
#   插件里写的是 fromSettings ?? fromProjectConfig，
#   也就是【设置页压过工程配置】—— 工程 JSON 里配了图集目录却不生效，
#   排查起来极难发现（不报错，只是"配了没用"）。
#
#   现在：全部搬进本文件，settings.json 不再参与。
#   理由有三，都不是"风格偏好"：
#     ① 唯一真值。配置跟着工程走，能进 git、发给同学、换机器不丢。
#     ② 不再依赖 contributes.configuration。那套机制有真实缺陷：
#        嵌套 object 分组【不会注册内层键】，导致 cfg.get 静默拿不到值、
#        cfg.update 直接抛「没有注册配置」。用户为此排查了很久。
#     ③ 用户打开 scut_project.json 就能看到全部配置，所见即所得。
#
#   图像宽高仍在这份文件里，且它们同时被写进 scut_config.h ——
#   C 里数组大小是编译期常量，运行期改不了，这是语言硬约束。
DEFAULT_CONFIG: Dict[str, Any] = {
    "image": {"width": 188, "height": 120},
    "inputArray": "mt9v03x_image",
    "outputArray": "",
    "hooks": {"init": [], "frame": [], "post": []},
    # 图集。dir 空 = 用工程下的 pic/；ext 空 = 交给后端按实际文件探测。
    "pic": {"dir": "", "ext": "", "start": 1},
    # 运行期行为：仿真进程启动参数与「运行 / 测速」的次数。
    "run": {"processRepeat": 1, "runFrames": 60, "benchRepeat": 1000},
    # ★ 故意没有 view 段 ★
    #   面板显示开关（showTiming/showLog 之类）与勾选变量的持久化，
    #   都由 VS Code 那边的面板机制完成。把它们也搬进这份工程配置，
    #   只会造出一组【没人读】的字段 —— 用户勾了却没有任何效果，
    #   反过来怀疑是自己用错了。宁缺毋滥。
    # 本机工具链。path 空 = 依次探测：SCUT71_TOOLCHAIN 环境变量
    # → 插件自动下载过的目录 → PATH；都找不到时弹窗问用户。
    # pythonPath：跑本脚本用的解释器，只要求 3.7+，不依赖任何第三方库
    # （import 全是标准库），conda / python.org 的都可以。
    # 留空 = 插件自动探测；机器上装了多个 Python 时建议写死一个，
    # 因为自动探测可能挑中旧版本（实测：py -3 反查到 3.6）。
    "toolchain": {"path": "", "pythonPath": "",
                  "autoDownload": True, "autoWatch": True,
                  # 变量发现的两个过滤器（见 --exclude / --max-elems）。
                  # ★ 名字必须与 extension/src/projectconfig.ts 的
                  #   ProjectConfig 逐字一致 —— tests/test_extension_settings.py
                  #   的 D 段会在两边不一致时报红。
                  "watchExclude": "", "watchMaxElems": 0},
}


def _deep_merge(base: Dict[str, Any], over: Dict[str, Any]) -> Dict[str, Any]:
    """把 over 合并进 base 的副本。只认识字典与标量，不认识列表的合并语义
    （列表整体替换 —— 钩子顺序由用户完全控制，合并只会制造意外）。"""
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_project_config(proj: "Project", reporter: "Reporter"
                        ) -> Tuple[Dict[str, Any], str]:
    """
    读取工程配置。返回 (配置, 来源说明)。

    优先级：
      1) <root>/scut_project.json      —— 新约定，插件 UI 编辑
      2) <root>/config.h               —— 老约定，兼容用（只取尺寸与图集）
      3) 默认值                         —— 让"什么都没有"也能构建
    """
    cfg_path = os.path.join(proj.root, PROJECT_CONFIG_NAME)
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8-sig") as f:
                raw = json.load(f)
        except (OSError, ValueError) as exc:
            raise ConfigParseError(
                "%s 读不出来：%s\n"
                "    下一步：这个文件由插件设置界面维护；"
                "若手改坏了，删掉它再在设置里重新填一次即可。"
                % (cfg_path, exc))
        if not isinstance(raw, dict):
            raise ConfigParseError("%s 的顶层必须是一个 JSON 对象。" % cfg_path)
        return _deep_merge(DEFAULT_CONFIG, raw), "scut_project.json"

    header, base = proj.find_config_header()
    if header:
        w, h = parse_image_size(header)
        cfg = _deep_merge(DEFAULT_CONFIG, {
            "image": {"width": w, "height": h},
            "pic": {
                "dir": _read_macro_str(header, "SCUT_PIC_DIR") or "",
                "ext": _read_macro_str(header, "SCUT_PIC_EXT") or "",
            },
        })
        return cfg, "%s（老约定，建议改用设置界面）" % base

    return dict(DEFAULT_CONFIG), "内置默认值"


def apply_pic_dir(proj: "Project", cfg: Dict[str, Any]) -> None:
    """把配置里的 pic.dir 落到 proj.pic_dir 上。

    ★★ 为什么需要这个函数（一条真实缺陷的修复）★★

      Project.__init__ 在构造时就把 pic_dir 写死成 <root>/pic；
      而配置是【之后】才由 load_project_config() 读出来的 ——
      构造顺序在前，所以配置里的 pic.dir 从来没有生效过。

      后果不只是"没起作用"，而是【主动误导】：
      用户在插件面板里把图集目录设成 pic/3，仿真会正确地用 pic/3
      （后端读得到），但构建时会打印
          "工程里没有 pic/ 目录，仿真将没有测试图可读……画面会全黑"
      而画面根本不会黑。用户于是去建一个并不需要的 pic/ 目录。

      这正是 0.9.4「配置只有一个真值」那次重构要消灭的缺陷
      （见本文件 DEFAULT_CONFIG 上方的说明），却在同一文件里
      以"构建脚本另有一份硬编码真值"的形式重新出现。

    ★ 为什么做成独立函数、而不是在 Project.__init__ 里读配置：
      构造 Project 时还没有任何配置（配置要先知道 proj.root 才能定位），
      在里面读会变成"配置的读取依赖配置的位置"这种循环。
      所以顺序只能是「先构造 → 再读配置 → 再回写」，
      回写这一步单独成函数，两个调用点各自调一次，语义明确。

    ★ pic.dir 为空串时【保持原值】（<root>/pic）：
      默认工程没有 pic/ 配置项，必须维持当前行为，否则
      所有老工程会突然报"没有图集"。

    ★ 支持绝对路径：与 extension/src/project.ts:237 的口径一致
      （那里写的是 path.isAbsolute(rel) ? rel : path.join(root, rel)）。
      两边都支持绝对路径，用户把图集放在工程外也能用。
    """
    raw = str((cfg.get("pic") or {}).get("dir") or "").strip()
    if not raw:
        return                      # 留空 = 用默认的 <root>/pic

    # 反斜杠统一成正斜杠：配置里用户可能写 "pic\\1"（Windows 习惯），
    # 而 os.path.join / os.path.isabs 在 Windows 上两种都认，
    # 但在别的平台只认 '/'。归一化之后跨平台行为一致。
    raw = raw.replace("\\", "/")

    if os.path.isabs(raw):
        proj.pic_dir = os.path.normpath(raw)
    else:
        proj.pic_dir = os.path.normpath(os.path.join(proj.root, raw))


_STR_MACRO_CACHE: Dict[str, Dict[str, str]] = {}


def _read_macro_str(header: str, macro: str) -> str:
    """从 config.h 里读一个字符串宏的字面量（只支持 "..." 形式）。"""
    cache = _STR_MACRO_CACHE.get(header)
    if cache is None:
        try:
            with open(header, "r", encoding="utf-8-sig", errors="replace") as f:
                text = f.read()
        except OSError:
            return ""
        text = re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)
        text = re.sub(r"//[^\n]*", " ", text)
        cache = {}
        for m in re.finditer(r"#\s*define\s+(\w+)\s+\"([^\"]*)\"", text):
            cache[m.group(1)] = m.group(2)
        _STR_MACRO_CACHE[header] = cache
    return cache.get(macro, "")


def _cfg_image(cfg: Dict[str, Any]) -> Tuple[int, int]:
    img = cfg.get("image") or {}
    try:
        w = int(img.get("width", 0))
        h = int(img.get("height", 0))
    except (TypeError, ValueError):
        w = h = 0
    if not (0 < w <= 4096) or not (0 < h <= 4096):
        raise ConfigParseError(
            "配置里的图像尺寸不合理：%s x %s。\n"
            "    要求：1..4096 之间的整数。\n"
            "    下一步：在插件设置里改「图像宽度/高度」。"
            % (img.get("width"), img.get("height")))
    return w, h


def _cfg_names(cfg: Dict[str, Any], key: str) -> List[str]:
    """取一个钩子列表。容忍用户写成字符串（换行/逗号/分号分隔）。"""
    hooks = cfg.get("hooks") or {}
    val = hooks.get(key)
    if val is None:
        return []
    if isinstance(val, str):
        val = re.split(r"[\n,;]", val)
    out: List[str] = []
    for item in val:
        name = str(item).split("//")[0].strip()
        if name:
            out.append(name)
    return out


def _is_c_identifier(s: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z_]\w*", s or ""))


def write_generated_config(gen_dir: str, cfg: Dict[str, Any]) -> str:
    """
    生成编译期契约头 scut_config.h。

    ★ 内容刻意【只有契约】，没有可调参数：
      尺寸、输入数组名。图集路径之类全部走运行期设置（改完立即生效）。
      把"改完需要重编译"的东西压到最少，是这个文件存在的全部意义。
    """
    w, h = _cfg_image(cfg)
    in_name = str(cfg.get("inputArray") or "mt9v03x_image").strip()
    if not _is_c_identifier(in_name):
        raise ConfigParseError(
            "配置里的「输入图像数组名」不是合法的 C 标识符：%r\n"
            "    下一步：在插件设置里改成一个像 mt9v03x_image 这样的名字。"
            % in_name)

    text = (
        "/* ==========================================================================\n"
        " *  scut_config.h —— 编译期契约（★ 自动生成，不要手改）\n"
        " *  --------------------------------------------------------------------------\n"
        " *  由 tools/scut_build.py 依据 scut_project.json 生成。\n"
        " *  要改这些值，请用插件里的配置面板（仿真视图工具栏的设置按钮）；\n"
        " *  那些值本身存在工程根的 scut_project.json 里，\n"
        " *  手改本文件会在下次构建时被覆盖。\n"
        " *\n"
        " *  ★ 为什么尺寸必须留在编译期：\n"
        " *      C 语言里数组大小必须是常量，而算法里到处是\n"
        " *          int left_line[SCUT_IMAGE_H];\n"
        " *      这类声明。这是语言的硬约束，不是设计偷懒。\n"
        " * ========================================================================== */\n"
        "#ifndef SCUT_CONFIG_H\n"
        "#define SCUT_CONFIG_H\n"
        "\n"
        "#define SCUT_IMAGE_W            (%d)\n"
        "#define SCUT_IMAGE_H            (%d)\n"
        "\n"
        "/* 输入图像数组名（环境拥有、地址恒定，算法直接按名字访问）。 */\n"
        "#define SCUT_INPUT_ARRAY        %s\n"
        "\n"
        "/* 输入图像的 extern 声明：让用户算法不必自己再写一遍。\n"
        " * ★ 用 unsigned char 而不是 scut_u8：本头可能被不含 scut_types.h 的\n"
        " *   车载代码包含，不能依赖环境的类型别名。 */\n"
        "#ifndef SCUT_NO_INPUT_EXTERN\n"
        "extern unsigned char %s[SCUT_IMAGE_H][SCUT_IMAGE_W];\n"
        "#endif\n"
        "\n"
        "#endif /* SCUT_CONFIG_H */\n"
        % (w, h, in_name, in_name))

    path = os.path.join(gen_dir, "scut_config.h")
    atomic_write_text(path, text)
    return path


GLUE_HEAD = '''/* ==========================================================================
 *  scut_env_glue.c —— 环境接线单元（★ 自动生成，不要手改）
 *  --------------------------------------------------------------------------
 *  由 tools/scut_build.py 依据 scut_project.json 里的钩子配置生成。
 *
 *  作用：把用户代码里的普通函数接进环境的三个阶段。
 *
 *  ★★ 为什么要有这一层（这是"用户代码可直接移植"的关键）★★
 *
 *    用户代码必须能原样拷进车载工程，所以它里面【不能】出现
 *    任何仿真环境的注册宏。而仿真环境需要一个入口来驱动算法。
 *
 *    解法：让"谁调用谁"这件事留在环境侧。用户在设置界面里填函数名，
 *    构建时生成本文件，由它声明并调用那些函数。
 *
 *    车载工程里同样存在这件事 —— 它的 main() 里也是按顺序调用
 *    image_process() / ImagePerspective_Init()。所以本文件做的事情，
 *    与车载 main 做的事情完全同构，只是换了个宿主。
 *
 *  ★ 用户函数必须【非 static】（有外部链接）：
 *    本文件是独立编译单元，只能调用外部链接的函数。
 *    这恰好也是车载工程的要求（main 要能调到它们），所以不是额外限制。
 *
 *  源文件: {src}
 * ========================================================================== */
#include "scut_sdk.h"

/* ---- 用户函数声明 ---------------------------------------------------- */
{decls}

/* ---- 初始化（开机一次，不计时） -------------------------------------- */
static void scut_env_init(void)
{{
{init_calls}
}}

/* ---- 图像处理（每帧，★ 计时段：测速测的就是这里） -------------------- */
static void scut_env_frame(void)
{{
{frame_calls}
}}

/* ---- 绘制 / 后处理（每帧，不计时：搬运结果图 + 画标注 + 打日志） ------ */
static void scut_env_draw(void)
{{
{copy_call}{post_calls}
}}

/* ---- 注册（环境的内部宏，用户代码不接触） ---------------------------- */
ENV_REGISTER(SCUT_ROLE_INIT,    100, "env_init",  scut_env_init)
ENV_REGISTER(SCUT_ROLE_PROCESS, 100, "env_frame", scut_env_frame)
ENV_REGISTER(SCUT_ROLE_DRAW,    100, "env_draw",  scut_env_draw)
'''


def write_glue(gen_dir: str, cfg: Dict[str, Any]) -> str:
    """
    生成环境接线单元。

    ★ 输出图的搬运也放在这里，而不是让用户调用 SCUT_OutImageSet：
      用户算法写的是自己的结果数组（车上就是这么写的），
      "把它搬去显示"是呈现层的事，不该出现在算法文件里。
      搬运函数体由 scut_symbols.py 生成到【能看到该数组声明】的那个
      编译单元里（见 --output-array），本文件只负责调用它。
    """
    init_names = _cfg_names(cfg, "init")
    frame_names = _cfg_names(cfg, "frame")
    post_names = _cfg_names(cfg, "post")
    out_array = str(cfg.get("outputArray") or "").strip()

    for nm in init_names + frame_names + post_names:
        if not _is_c_identifier(nm):
            raise ConfigParseError(
                "钩子函数名不是合法的 C 标识符：%r\n"
                "    下一步：在插件设置里填【函数名】（每行一个），"
                "例如 image_process。" % nm)

    if out_array and not _is_c_identifier(out_array):
        raise ConfigParseError(
            "结果图数组名不是合法的 C 标识符：%r" % out_array)

    if not (init_names or frame_names):
        raise ConfigParseError(
            "没有配置任何钩子函数。\n"
            "    原因：环境需要一个「图像处理函数」才能跑起来 —— "
            "它就是你算法的主入口。\n"
            "    下一步：打开插件的配置面板（侧边栏 ⚙ 按钮，\n"
            "    或命令面板执行「SCUT-71: 配置本工程」），在\n"
            "    「每帧处理函数」里填你代码里的函数名（每行一个），\n"
            "    例如 image_process。\n"
            "    说明：用户代码里【不需要】写任何注册宏 —— "
            "那样代码才能保持与车载工程一致、直接可移植。")

    # 声明：同名只声明一次（同一函数可能被填进多个阶段）
    all_names = list(dict.fromkeys(init_names + frame_names + post_names))
    decls = "\n".join("void %s(void);" % n for n in all_names)

    # ★★ 同一个函数【不允许】被填进两个阶段 ★★
    #
    #   这条检查不是形式主义。它挡住的是一类"看起来完全正常、数字却是错的"缺陷：
    #
    #     把 image_process 同时填进「图像处理」和「后处理」时，
    #     它会每帧跑【两遍】—— 一遍在计时的 PROCESS 里，一遍在不计时的 DRAW 里。
    #     于是 processUs 只统计到其中一遍，而实际工作量翻倍：
    #     报出来的算法耗时凭空少了一半，而画面、日志、变量全都正常。
    #     用户拿这个数字去比较算法、判断优化效果，结论会直接错。
    #
    #   这比"直接报错"更危险的地方在于它【不报错】：构建成功、运行正常、
    #   只有性能数字是假的。所以宁可在构建期拦住，并说清为什么。
    #
    #   （如果确实需要在两个阶段都做点什么，正确做法是写两个不同的函数，
    #     让"哪一段该被计时"这件事在代码里是明确的。）
    seen_phase: Dict[str, str] = {}
    phase_of = ([(n, "初始化") for n in init_names]
                + [(n, "图像处理") for n in frame_names]
                + [(n, "后处理") for n in post_names])
    for nm, ph in phase_of:
        if nm in seen_phase:
            raise ConfigParseError(
                "同一个函数被填进了两个阶段：%s\n"
                "    它同时出现在「%s」和「%s」里，于是每帧会被调用两次。\n"
                "    为什么必须拦住：其中只有一次算进「处理时间」，"
                "另一次不算 —— 报出来的算法耗时凭空少了一半，\n"
                "    而画面、变量、日志全都正常，属于「数字是假的但看不出错」"
                "的那一类问题。\n"
                "    下一步（任选其一）：\n"
                "      1) 从其中一个阶段删掉它"
                "（多数情况应该只留在「图像处理」里）；\n"
                "      2) 如果确实两个阶段都要做，请写成两个不同的函数，"
                "让「哪一段该被计时」在代码里明确下来。"
                % (nm, seen_phase[nm], ph))
        seen_phase[nm] = ph

    def _calls(names: List[str]) -> str:
        if not names:
            return "    /* （未配置，本阶段不做任何事） */"
        return "\n".join("    %s();" % n for n in names)

    copy_call = ""
    if out_array:
        copy_call = (
            "    /* 把用户的结果图搬进环境的输出图（逐像素深拷贝）。\n"
            "     * 深拷贝而不是换指针：算法里可能建立了指向图像像素的\n"
            "     * 指针表（逆透视），换指针会让它们集体悬空。 */\n"
            "    scut_env_copy_output();\n\n")
    else:
        copy_call = (
            "    /* 未配置结果图数组 —— 画面显示的是输入图本身。\n"
            "     * 想看到算法输出，请在设置里填「结果图数组名」。 */\n\n")

    text = GLUE_HEAD.format(
        src=PROJECT_CONFIG_NAME,
        decls=decls,
        init_calls=_calls(init_names),
        frame_calls=_calls(frame_names),
        copy_call=copy_call,
        post_calls=_calls(post_names))

    # 结果图搬运函数的声明：由 scut_symbols.py 生成到能看见该数组的 TU 里。
    # ★ 必须放在【调用之前】—— 所以拼在 GLUE_HEAD 的开头而不是尾部：
    #   C 语言里函数必须先声明后使用，放尾部会得到
    #   "call to undeclared function" 的编译错误。
    if out_array:
        text = (
            "\n/* 由符号发现阶段生成到【声明了 %s 的那个编译单元】里 ——\n"
            " * 只有在那里才看得见它的真实类型（可能是 static，也可能是\n"
            " * 二维数组，独立编译单元猜不准）。\n"
            " *\n"
            " * ★ 为什么搬运函数体不写在这里，而只在这里【声明】：\n"
            " *   本文件是独立编译单元，看不到用户的数组定义；\n"
            " *   只有展开了用户源码的那个包装单元才知道它长什么样。 */\n"
            "void scut_env_copy_output(void);\n" % out_array) + text

    path = os.path.join(gen_dir, "scut_env_glue.c")
    atomic_write_text(path, text)
    return path


def _split_mk_tokens(line: str) -> List[str]:
    """
    最小可用的 scut.extra.mk 词法分析：按空白切分，但引号内的整段算一个 token。

    ★ 为什么不能直接用 str.split()：
      `-L"C:\\我的 库目录"` 会被 split 拆成 `-L"C:\\我的` 与 `库目录"`，
      结果是库目录静默丢失、链接期报一堆 undefined reference，
      而用户完全看不出根因。本项目明确要求「路径含空格与中文必须能用」，
      所以这里宁可自己写十几行，也不依赖 split 的默认行为。

    ★ 刻意【不】支持变量展开（$(...)）、通配（*）、反引号：
      它们会把任意命令执行带进构建流程，破坏路径安全的保证。
      这类 token 会被原样返回，随后在调用点被当作非法条目拒绝并告警。
    """
    out: List[str] = []
    cur: List[str] = []
    quote = ""
    for ch in line:
        if quote:
            if ch == quote:
                quote = ""
            else:
                cur.append(ch)
            continue
        if ch in ('"', "'"):
            quote = ch
            continue
        if ch.isspace():
            if cur:
                out.append("".join(cur))
                cur = []
            continue
        cur.append(ch)
    if cur:
        out.append("".join(cur))
    return out


def parse_extra_mk(path: str, reporter: Reporter) -> Tuple[List[str], List[str]]:
    """
    解析 scut.extra.mk，取出额外的 -l / -L 选项。

    ★ 为什么要有这个逃生舱：
      用户的算法可能要用到第三方静态库或系统库。但把任意 shell 命令塞进
      构建流程，会立刻破坏「路径含空格与中文也能用」这条硬要求
      （字符串拼接、shell 展开都会出问题）。所以这里只接受两类【安全】
      的 token：-l<name> 与 -L<dir>，其余一律忽略并警告。
      它不做变量展开、不做通配、不执行任何命令 —— 这是刻意的。
    """
    libs: List[str] = []
    libdirs: List[str] = []
    if not os.path.isfile(path):
        return libs, libdirs
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            lines = f.readlines()
    except OSError as exc:
        reporter.warn("读取 %s 失败（已忽略）：%s" % (path, exc))
        return libs, libdirs

    ignored: List[str] = []
    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        # 允许 `LIBS = -lfoo -Lbar` 这种简单形式：等号右边才是选项
        if "=" in line and not line.startswith("-"):
            line = line.split("=", 1)[1].strip()
        # ★ 先按 shell 词法切分，再处理引号。
        #   直接 line.split() 会把 -L"C:\我的 目录\libs" 拆成两半，
        #   于是含空格的库目录静默丢失 —— 而「路径含空格必须能用」
        #   是本项目的硬要求，所以这里必须自己做一个最小的词法分析：
        #   支持 "双引号" 与 '单引号' 包裹的整段 token。
        for tok in _split_mk_tokens(line):
            if tok.startswith("-L"):
                if len(tok) > 2:
                    # 相对路径按 scut.extra.mk 所在目录解析，
                    # 用户不用写绝对路径，也不用关心当前工作目录。
                    d = tok[2:]
                    if not os.path.isabs(d):
                        d = os.path.normpath(os.path.join(os.path.dirname(path), d))
                    libdirs.append("-L" + d)
                else:
                    ignored.append(tok)
            elif tok.startswith("-l") and len(tok) > 2:
                libs.append(tok)
            else:
                ignored.append(tok)
    if ignored:
        reporter.warn(
            "%s 里有无法安全处理的条目：%s。"
            "该文件是「逃生舱」，只接受 -l<库名> 与 -L<目录> 两种选项——"
            "任意命令/通配/变量展开会破坏「路径含空格与中文也能构建」，"
            "因此被刻意拒绝。需要其它选项请改本脚本或提 issue。"
            % (os.path.basename(path), ", ".join(ignored[:6]))
        )
    return libs, libdirs


# ===========================================================================
# 诊断解析
# ===========================================================================

def parse_diagnostics(text: str) -> List[Dict[str, Any]]:
    """
    把编译器/链接器输出解析成结构化记录（插件用它做 Problems 面板跳转）。

    兼容三种形态：
        path:line:col: error: msg      （gcc/clang 主流）
        path:line: error: msg          （clang 无列号）
        <tool>: error: msg             （ld.lld / clang 驱动自身）
    """
    out: List[Dict[str, Any]] = []
    seen = set()
    for line in text.splitlines():
        line = line.rstrip()
        if not line:
            continue
        m = _DIAG_FULL_RE.match(line)
        line_no: Optional[int] = None
        col_no: Optional[int] = None
        if m:
            line_no = int(m.group("line"))
            col_no = int(m.group("col"))
        else:
            m = _DIAG_NOCOL_RE.match(line)
            if m:
                line_no = int(m.group("line"))
            else:
                m = _DIAG_NOLOC_RE.match(line)
                if not m:
                    # 链接器还有一种没有冒号-空格分隔的形态，例如
                    #   ld.lld: error: undefined symbol: scut_core_init
                    # 已被上面捕获；这里只兜底 `undefined reference`。
                    if "undefined reference to" in line:
                        out.append({
                            "file": None, "line": None, "column": None,
                            "severity": "error", "message": line.strip(),
                        })
                    continue
        sev_raw = m.group("sev")
        sev = _SEV_MAP.get(sev_raw, "error")
        fname = m.group("file").strip()
        msg = m.group("msg").strip()
        # 过滤掉「In file included from ...」这类 note 噪声的路径前缀
        key = (fname, line_no, col_no, msg)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "file": fname or None,
            "line": line_no,
            "column": col_no,
            "severity": sev,
            "message": msg,
        })
    return out


def first_error_digest(diags: List[Dict[str, Any]]) -> str:
    """
    把第一条 error 变成「说人话」的提示。

    需求原文：Also surface the FIRST error prominently in human form.
    这里刻意把位置和原因分行写，而不是把编译器原文再抄一遍。
    """
    for d in diags:
        if d["severity"] != "error":
            continue
        loc = d["file"] or "(命令行)"
        if d["line"]:
            loc += ":%d" % d["line"]
            if d["column"]:
                loc += ":%d" % d["column"]
        return ("第一个错误：%s\n    原因/说明：%s\n"
                "    下一步：先只修这一个错误。编译器常在修好第一个错误后"
                "「连带消失」后面几十个，逐个修反而更慢。" % (loc, d["message"]))
    return ""


# ===========================================================================
# 构建
# ===========================================================================

class BuildError(Exception):
    """致命构建错误，消息本身已经是说人话的中文。"""


class UnitJob:
    """一个用户 .c 的构建任务（两遍编译链在这里闭环）。"""

    def __init__(self, src: str, rel: str, obj: str, wrapped: str,
                 wrapped_obj: str, manifest: str) -> None:
        self.src = src          # 绝对路径
        self.rel = rel          # 相对 code/ 的路径，用 / 分隔（给 #include 用）
        self.obj = obj          # 探针 .o
        self.wrapped = wrapped  # 生成的包装 .c
        self.wrapped_obj = wrapped_obj  # 真正参与链接的 .o
        self.manifest = manifest        # 变量清单 json
        self.ok = True
        self.used_wrapper = False
        self.warnings: List[str] = []
        # 用户配置错误（不是编译错误）：整条构建要立刻停下并原文报出，
        # 不能降级、不能继续 —— 见 build_one_unit 里对退出码 4 的处理。
        self.config_error: str = ""


def normalize_probe_obj_dwarf(objcopy: str, obj_path: str,
                              reporter: Reporter) -> None:
    """
    ★ 实测兼容性补丁：把 clang 的 DWARF 偏移写法改写成 binutils 的写法。

    现象（本机实测，clang 21.1.1 + binutils 2.30）：
        · clang 产出： ` <1><0000002a>: Abbrev Number: 2 (DW_TAG_variable)`
        · binutils 产出：` <1><2a>: Abbrev Number: 2 (DW_TAG_variable)`

    scut_symbols.py 的 DIE_RE 只认不定长的十六进制，遇到八位补零会
    一个 DIE 都匹配不上 —— 结果是「构建成功，但变量面板永远是空的」，
    属于最严重的静默失败。

    做法：objcopy 把 .debug_* 抽出来 → 正则只做「去掉偏移的高位补零」
    → 再写回去。只动这几个 section，且只动这一种模式；不碰任何别的字节。

    ★ 为什么不一并处理 DW_TAG 的行格式差异：
      实测发现 clang 的 `Abbrev Number` 行缩进与左尖括号前的空格数
      与 binutils 不同，但 scut_symbols.py 的 DIE_RE 用 ^ 锚定，
      而 objdump 的实际输出前缀是 "\n  "（两个空格）—— 这一点对
      clang 与 binutils 产物【是一致的】（已实测 35/35 变量全部发现）。
      所以这里只补偏移写法这一处，绝不擅自改动行格式。

    失败时静默降级为「可能发现不了变量」，而不是让构建失败 ——
    「少几个变量」和「算法跑不起来」严重性完全不同。
    """
    if not objcopy:
        reporter.detail("  [dwarf] 找不到 objcopy，跳过偏移规范化"
                        "（若变量面板为空，请运行 doctor）")
        return

    def _fix(text: str) -> str:
        return "\n".join(
            _HEX_OFFSET_RE.sub(
                lambda m: m.group(1) + (m.group(2).lstrip("0") or "0") + m.group(3),
                ln)
            for ln in text.split("\n"))

    tmpdir = tempfile.mkdtemp(prefix="scut_dwarf_")
    try:
        changed = False
        for sec in (".debug_info", ".debug_abbrev", ".debug_str"):
            dump = os.path.join(tmpdir, sec.strip("."))
            r = run_cmd([objcopy, "--dump-section", "%s=%s" % (sec, dump),
                         obj_path])
            if r.code != 0 or not os.path.isfile(dump):
                continue
            with open(dump, "rb") as f:
                raw = f.read()
            text = raw.decode("latin-1")
            fixed = _fix(text)
            if fixed == text:
                continue
            with open(dump, "wb") as f:
                f.write(fixed.encode("latin-1"))
            r = run_cmd([objcopy, "--update-section",
                         "%s=%s" % (sec, dump), obj_path])
            if r.code == 0:
                changed = True
            else:
                reporter.detail("  [dwarf] %s 回写失败，已跳过" % sec)
        if changed:
            reporter.detail("  [dwarf] 已规范化 DWARF 偏移写法（clang → binutils）")
    except OSError as exc:  # pragma: no cover - 环境相关
        reporter.detail("  [dwarf] 规范化异常，已跳过：%s" % exc)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def build_one_unit(job: UnitJob, cc: str, objdump: str, python: str,
                   symbols_tool: str, base_flags: List[str], user_flags: List[str],
                   probe_flags: List[str], include_dirs: List[str],
                   objcopy: str, auto_watch: bool, output_array: str,
                   output_owner: Optional[str], image_size: str,
                   reporter: Reporter, log_lock: threading.Lock,
                   logs: List[str], proj: "Project",
                   exclude_names: str = "", max_elems: int = 0) -> bool:
    """
    一个用户编译单元的完整流水线：

        探针编译 → scut_symbols.py → 编译包装单元
        任一环节失败 → 直接编译原文件（降级，但绝不整体失败）
    """
    def _append(text: str) -> None:
        if text:
            with log_lock:
                logs.append(text)

    if not auto_watch:
        # --no-watch：跳过探针与符号发现，直接编译原文件（最快路径）。
        #
        # ★ 但"结果图搬运"必须照旧生成 —— 它和符号发现是两件事：
        #   前者是可移植性要求（用户代码不能自己搬图），
        #   后者只是"顺便看看有哪些变量"。
        #   旧实现把两者绑在一起，于是关掉 autoWatch 就会得到一个
        #   链接错误（scut_env_copy_output 未定义）。
        #
        # ★★ 只有【数组的所有者】那个文件生成搬运函数 ★★
        #   每个用户 .c 都参与链接；若人人都定义一遍，链接期就是
        #   duplicate symbol —— 而报错指向生成文件，用户完全看不懂。
        #   所有者由 find_output_owner 在 do_build 里预先探查好传进来。
        if output_array and output_owner == job.src:
            with open(job.wrapped, "w", encoding="utf-8") as f:
                f.write('/* 由 scut_build.py 生成（--no-watch 薄包装）：'
                        '只放结果图搬运，不做符号发现。 */\n')
                f.write('#include "scut_sdk.h"\n')
                f.write('#include "%s"\n' % job.rel)
                f.write(_thin_copy_fn(output_array))
            cmd = [cc] + base_flags + user_flags + include_dirs + \
                  ["-c", job.wrapped, "-o", job.wrapped_obj]
        else:
            cmd = [cc] + base_flags + user_flags + include_dirs + \
                  ["-c", job.src, "-o", job.wrapped_obj]
        reporter.detail("  $ " + " ".join('"%s"' % a if " " in a else a for a in cmd))
        r = run_cmd(cmd)
        _append(r.out)
        if r.code != 0:
            job.ok = False
        return job.ok

    # ---- 第 1 遍：探针编译（-g -O0，固定） ----------------
    probe_cmd = [cc] + base_flags + probe_flags + include_dirs + \
                ["-c", job.src, "-o", job.obj]
    reporter.detail("  [1/3 探针] $ " + " ".join(
        '"%s"' % a if " " in a else a for a in probe_cmd))
    r = run_cmd(probe_cmd)
    _append(r.out)
    if r.code != 0:
        job.warnings.append(
            "探针编译失败，已改为直接编译原文件（不会影响本次构建，"
            "但该文件的全局变量不会出现在变量面板里）。")
        return _fallback_compile(job, cc, base_flags, user_flags, include_dirs,
                                 reporter, _append)

    # ---- DWARF 偏移写法规范化（见 normalize_probe_obj_dwarf 的说明） ------
    normalize_probe_obj_dwarf(objcopy, job.obj, reporter)

    # ---- 第 2 遍：调用 scut_symbols.py 生成包装单元 ----------------------
    # ★ 先写临时文件再 os.replace：插件可能在构建过程中读这些文件，
    #   半截文件会让变量面板偶发为空，且极难复现。
    #
    # ★ 为什么临时文件放在【独立的临时目录】而不是 `xxx.wrapped.c.tmp`：
    #   scut_symbols.py 会把 --out-c 的【文件名】写进生成文件头的注释里
    #   （"<name> AUTO-GENERATED ..."）。若临时名带 .tmp，最终产物开头
    #   会永远写着 `main.wrapped.c.tmp` —— 一个看得见、但没人能解释的
    #   脏东西。把临时文件放到同盘的另一目录、并保持【同样的文件名】，
    #   既保住了 os.replace 的原子性（同文件系统），产物内容也干净。
    staging = tempfile.mkdtemp(prefix="scut_gen_", dir=proj.scut_dir)
    try:
        tmp_c = os.path.join(staging, os.path.basename(job.wrapped))
        tmp_j = os.path.join(staging, os.path.basename(job.manifest))

        gen_cmd = [
            python, symbols_tool,
            "--obj", job.obj,
            # --src 会原样写进生成文件的 #include，所以必须是【相对 code/】的
            # 路径（--src 只能给相对路径，给绝对路径会编不过）。
            "--src", job.rel,
            # 扫描"用户手写注册"要另给一个绝对路径：本脚本可能在任意工作目录
            # 下运行，若生成器按相对路径 open()，会失败、被 except 吞掉、
            # 静默返回空集 —— 症状是"用户主动注册的变量一个都不显示"，
            # 而且没有任何报错。（曾经就这么坏着，靠手动调生成器才暴露。）
            "--src-abs", job.src,
            "--out-c", tmp_c,
            "--out-json", tmp_j,
            "--objdump", objdump,
        ]
        if output_array:
            # 结果图数组名交给生成器：只有它展开了用户源码，
            # 才知道这个数组的真实类型与作用域。
            gen_cmd += ["--output-array", output_array]
        if image_size:
            # 尺寸只用于错误提示的措辞（"环境要按 120 行 × 188 列去读它"），
            # 不参与任何生成逻辑 —— 真值来源始终是工程配置。
            gen_cmd += ["--image-size", image_size]
        # ★ 这两个开关 scut_symbols.py 一直支持，但本脚本【从来不传】——
        #   于是它们在整条构建链上不可达：命令行没有、配置没有、UI 也没有。
        #   一个"实现了却没人能调到"的开关比没有更糟：读生成器代码的人
        #   会以为构建侧已经在用它们了。
        #   现在补上透传（值来自 --exclude / --max-elems，默认空/0 = 不启用）。
        if exclude_names:
            gen_cmd += ["--exclude", exclude_names]
        if max_elems > 0:
            gen_cmd += ["--max-elems", str(max_elems)]
        reporter.detail("  [2/3 生成] $ " + " ".join(
            '"%s"' % a if " " in a else a for a in gen_cmd))
        env = dict(os.environ)
        # 保证生成脚本自身的中文输出不会因 Windows 控制台编码而炸
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        r = run_cmd(gen_cmd, env=env)
        _append(r.out)
        if r.code == 4:
            # ★ 退出码 4 = 生成器发现【用户配置问题】（结果图数组名指向标量）。
            #
            #   这里【绝不能】降级为"直接编译原文件"：
            #   那样会得到一个"构建成功但图是垃圾"的结果，
            #   而用户配置错了这件事就被彻底掩盖了 —— 那正是要避免的。
            #
            #   ★ 保留完整的多行说明，只剥掉生成器的 [scut_symbols] 前缀：
            #     "为什么必须拦住 / 下一步"才是用户真正要读的，
            #     只取第一行等于把最有用的部分丢掉。
            raw = (r.out or "").strip() or "结果图数组的形状不合法。"
            kept = []
            for line in raw.splitlines():
                s = line.strip()
                if s.startswith("[scut_symbols]"):
                    s = s[len("[scut_symbols]"):].strip()
                kept.append(s)
            job.config_error = "\n".join(kept).strip()
            job.ok = False
            return False
        if r.code != 0 or not os.path.isfile(tmp_c):
            job.warnings.append(
                "自动符号发现失败（%s），已改为直接编译原文件。"
                "最常见原因：objdump 不是 binutils 版本，或 PATH 里的是 "
                "llvm-objdump（LLVM 21 已移除 --dwarf=info）。"
                "请运行 doctor 查看详情。"
                % (r.out.strip().splitlines()[-1] if r.out.strip() else "无输出"))
            return _fallback_compile(job, cc, base_flags, user_flags,
                                     include_dirs, reporter, _append)

        try:
            os.replace(tmp_c, job.wrapped)
            if os.path.isfile(tmp_j):
                os.replace(tmp_j, job.manifest)
        except OSError as exc:
            job.warnings.append("生成物落盘失败（%s），已改为直接编译原文件。"
                                % exc)
            return _fallback_compile(job, cc, base_flags, user_flags,
                                     include_dirs, reporter, _append)
    finally:
        # 无论成败都清掉暂存目录，避免 .scut 下堆积临时文件
        shutil.rmtree(staging, ignore_errors=True)

    # ---- 第 3 遍：编译包装单元 = 真正的目标文件 ---------------------------
    wrap_cmd = [cc] + base_flags + user_flags + include_dirs + \
               ["-c", job.wrapped, "-o", job.wrapped_obj]
    reporter.detail("  [3/3 包装] $ " + " ".join(
        '"%s"' % a if " " in a else a for a in wrap_cmd))
    r = run_cmd(wrap_cmd)
    _append(r.out)
    if r.code != 0:
        # 包装单元编译失败通常是自动发现的边界情况（例如某个变量在
        # 文件作用域其实不可见）。降级编译原文件，保证「算法能跑」优先。
        job.warnings.append(
            "编译自动生成的包装单元失败，已改为直接编译原文件。"
            "该文件的全局变量不会出现在变量面板里，但算法本身可以正常运行。")
        return _fallback_compile(job, cc, base_flags, user_flags, include_dirs,
                                 reporter, _append)

    job.used_wrapper = True
    return True


def _thin_copy_fn(out_array: str) -> str:
    """
    生成结果图搬运函数（--no-watch 路径用）。

    ★ 为什么不复用 scut_symbols._copy_fn_text：
      那条路径会顺手把变量清单也生成出来。--no-watch 的语义就是
      "不要变量清单"，所以这里只写搬运函数本身，保持职责清晰。

    ★ 宽高为什么传 0（= 用环境的宽高）：
      这条路径刻意不做 DWARF 分析，拿不到数组维度。
      形状安全性由 find_output_owner 的探针保证 ——
      探针里带 sizeof(arr[0][0])，标量会在那里就被排除掉。
    """
    return (
        "\n/* 把结果图搬进环境的输出图（逐像素深拷贝）。\n"
        " * 深拷贝而不是换指针：算法里的逆透视指针表指向原图，\n"
        " * 换掉目标缓冲会让它们集体悬空。 */\n"
        "void scut_env_copy_output(void)\n"
        "{\n"
        "    SCUT_EnvCopyOutput((const unsigned char *)%s, 0, 0);\n"
        "}\n" % out_array)


def find_output_owner(sources: List[str], out_array: str, cc: str,
                      base_flags: List[str], include_dirs: List[str],
                      tmp_dir: str) -> Optional[str]:
    """
    在 --no-watch 路径下找出【哪一个用户 .c 声明了结果图数组】。

    ★★ 为什么必须找出唯一的所有者 ★★

      每个用户 .c 都会生成一个包装单元，而它们都参与链接。
      如果每个包装单元都定义 scut_env_copy_output()，链接期就是
      "duplicate symbol: scut_env_copy_output" —— 而报错指向生成文件，
      用户完全看不懂（那文件他根本没写过）。

      自动符号发现那条路靠 DWARF 的变量表判断归属；
      --no-watch 明确不做 DWARF 分析，所以这里用【编译器本身】当判据。

    ★ 为什么拿编译器当判据是合理的（而不是 hack）：
      "这个数组在本文件里可见吗、它是不是数组" 本质上是编译期问题，
      编译器就是唯一权威。我们让每个候选文件试编译一小段代码，
      谁通过谁就是所有者。它顺带还挡掉了"填了个标量"这种误配 ——
      因为探针里对非数组的 sizeof 写法根本编不过。

    ★ 代价：最坏情况 N 次小编译（N = 用户 .c 个数，通常 1~5）。
      --no-watch 是"跳过 DWARF 分析"的快速路径，
      这点开销仍远小于一次 DWARF 解析 + 包装生成，没有违背它的语义。

    返回所有者源文件的绝对路径；一个都不行时返回 None。
    """
    for src in sources:
        probe = os.path.join(tmp_dir, "owner_probe.c")
        obj = os.path.join(tmp_dir, "owner_probe.o")
        try:
            with open(probe, "w", encoding="utf-8") as f:
                f.write('#include "scut_sdk.h"\n')
                # ★ #include 用户源码而不是链接它：
                #   #include 能看到 static 变量，链接看不到。
                f.write('#include "%s"\n' % os.path.basename(src))
                # 探针本体：既证明可见性，又证明它是【二维数组】。
                # 对标量/一维数组，第二行 sizeof 编不过 —— 正是我们要的判据。
                f.write("void scut_owner_probe(void)\n{\n")
                f.write("    (void)sizeof(%s[0]);\n" % out_array)
                f.write("    (void)sizeof(%s[0][0]);\n" % out_array)
                f.write("}\n")
        except OSError:
            continue
        # -I 用户源码所在目录：探针在 .scut 下，要用 basename 形式 #include 它。
        cmd = ([cc] + base_flags + ["-I" + os.path.dirname(src)]
               + include_dirs + ["-c", probe, "-o", obj])
        rc = run_cmd(cmd)
        if rc.code == 0:
            return src
    return None


def _fallback_compile(job: UnitJob, cc: str, base_flags: List[str],
                      user_flags: List[str], include_dirs: List[str],
                      reporter: Reporter, append) -> bool:
    """
    降级路径：直接编译用户原文件。

    ★ 需求明确要求：never fail the whole build because symbol discovery failed。
      「变量面板少几个变量」和「算法根本跑不起来」是严重性完全不同的两件事，
      绝不能让前者导致后者。

    ★ 参数名写 user_flags 而不是 mode_flags：这里编的是【用户源码】，
      必须恒为 -O0（可调试性要求），不能跟随环境变成 -O2。
    """
    cmd = [cc] + base_flags + user_flags + include_dirs + \
          ["-c", job.src, "-o", job.wrapped_obj]
    reporter.detail("  [降级] $ " + " ".join(
        '"%s"' % a if " " in a else a for a in cmd))
    r = run_cmd(cmd)
    append(r.out)
    if r.code != 0:
        job.ok = False
    return job.ok


# ===========================================================================
# 主构建流程
# ===========================================================================

def do_build(args: argparse.Namespace, reporter: Reporter,
             timer: StageTimer) -> Tuple[int, Dict[str, Any]]:
    proj = Project(args.project)
    logs: List[str] = []
    log_lock = threading.Lock()
    diags: List[Dict[str, Any]] = []
    result: Dict[str, Any] = {
        "ok": False,
        "exePath": None,
        "output": "",
        "elapsedMs": 0,
        "errors": [],
        "manifest": None,
    }

    def finish(code: int) -> Tuple[int, Dict[str, Any]]:
        result["output"] = "".join(logs)
        result["elapsedMs"] = int(timer.total_ms())
        result["errors"] = diags
        return code, result

    reporter.human("SCUT-71 Vision Studio 构建")
    reporter.human("  工程目录: %s" % proj.root)
    # ★ 优化等级不是"模式"，而是固定约定（用户要求：Build Mode 参数没有意义）：
    #   用户算法恒 -g -O0（断点不漂移、变量看得见），环境自身恒 -O2（跑得快）。
    reporter.human("  优化: 用户代码 -g -O0（可调试）· 环境 -O2")

    # --- 0) 工程合法性 -----------------------------------------------------
    if not os.path.isdir(proj.root):
        reporter.error("工程目录不存在：%s\n"
                       "    下一步：确认 --project 指向包含 code/ 与 config.h 的目录。"
                       % proj.root)
        return finish(2)
    if not os.path.isdir(proj.code_dir):
        reporter.error("工程里没有 code/ 目录：%s\n"
                       "    原因：用户算法必须放在 code/ 下（约定优于配置）。\n"
                       "    下一步：创建 code/ 并至少放入一个 .c 文件；"
                       "也可以从 templates/starter/ 复制一份起步模板。"
                       % proj.code_dir)
        return finish(2)

    sources = proj.user_sources()
    if not sources:
        reporter.error("code/ 目录里一个 .c 文件都没有：%s\n"
                       "    原因：没有用户算法就没有可链接的目标文件，"
                       "链接期也一定会因为缺少 SCUT_REGISTER 回调而失败。\n"
                       "    下一步：把算法写进 code/*.c，"
                       "或从 templates/starter/code/camera.c 复制一份改。"
                       % proj.code_dir)
        return finish(2)

    # --- 1) 工具链 ---------------------------------------------------------
    with timer.stage("工具链探测"):
        tc = detect_toolchain(args.toolchain, reporter)
        for w in tc.warnings:
            reporter.warn(w)
    if not tc.cc:
        reporter.error("找不到 clang 编译器，无法构建。\n"
                       "    原因：本环境的 C 编译器固定为 clang（LLVM-MinGW），"
                       "它自带 MinGW sysroot，装完即可编译。\n"
                       "    下一步（三选一）：\n"
                       "      1) 装 LLVM-MinGW：\n"
                       "         https://github.com/mstorsjo/llvm-mingw/releases\n"
                       "         下载后解压到一个固定目录，例如 C:\\llvm-mingw\n"
                       "      2) 或把解压出来的 bin 目录加进系统 PATH\n"
                       "      3) 或用 --toolchain 指定根目录，例如：\n"
                       "         scut_build.py --toolchain C:\\llvm-mingw ...\n"
                       "         （根目录下要有 bin\\clang.exe）\n"
                       "    ★ 不要照抄别人机器上的绝对路径 —— 各人装的位置不同，\n"
                       "      那条命令在你自己机器上几乎必然不存在。")
        return finish(2)
    reporter.human("  编译器  : %s" % tc.cc)

    auto_watch = not args.no_watch
    if auto_watch and (not tc.objdump or not tc.objdump_is_binutils):
        # 不致命：降级为 --no-watch 继续构建，但必须说清楚会失去什么。
        reporter.warn(
            "自动符号发现已【自动关闭】：没有可用的 binutils objdump。\n"
            "    影响：算法能正常编译运行，但 IDE 变量面板会是空的。\n"
            "    原因：自动发现依赖 `objdump --dwarf=info`，"
            "而 LLVM 21 的 llvm-objdump 已移除该选项。\n"
            "    下一步：安装 MinGW-w64（提供 binutils）或把 binutils 的 bin "
            "加进 PATH，然后重跑 doctor。"
            "也可以显式传 --no-watch 来消除本提示。")
        auto_watch = False

    # 变量发现的两个过滤器（透传给 scut_symbols.py）。
    # ★ 值来源见下面「配置读出来之后」那一段 —— CLI 优先、其次工程配置。
    #   这里只取 CLI 的原始值（空/0 表示"用户没指定"）。
    cli_exclude = getattr(args, "exclude", "") or ""
    cli_max_elems = getattr(args, "max_elems", 0) or 0
    exclude_names = cli_exclude
    max_elems = cli_max_elems

    if auto_watch:
        reporter.human("  符号发现: %s" % tc.objdump)
    else:
        reporter.human("  符号发现: 已关闭（--no-watch）")

    # --- 2) 核心静态库 -----------------------------------------------------
    #
    # ★ 先记下路径，但【不在这里判存在性】—— 检查顺序刻意是
    #   「工程结构 → 编译期契约 → 核心库 → 编译 → 链接」。
    #   理由：核心库缺失是构建【最后一步】才会暴露的问题，而
    #   config.h 缺失 / 结构不对是【第一步】就挡路的问题。
    #   人的读错顺序是自上而下的：先告诉他「你 config.h 写错了」，
    #   比喂给他一句「找不到 libscut_core.a」有用得多 —— 修完前者的
    #   过程中很可能又会撞上后者，那时再提示才不浪费他的注意力。
    #   （真机实测过：反过来会让 C 路径的用户先看到误导性的核心库报错。）
    core_lib = args.core_lib or os.path.join(proj.root, DEFAULT_CORE_LIB_REL)
    core_lib = os.path.abspath(core_lib)

    # bind/scut_bind.c 的来源：仓库自带的那一份。也允许工程自带覆盖。
    # ★ 必须在这里解析（而不是等到编译阶段）：核心库的内容指纹要把它
    #   算进去 —— 改了 bind 就等于改了环境代码，必须触发重建。
    bind_src = os.path.join(proj.root, "bind", "scut_bind.c")
    if not os.path.isfile(bind_src):
        bind_src = os.path.join(SCUT_TOOL_ROOT, "bind", "scut_bind.c")
    if not os.path.isfile(bind_src):
        reporter.error(
            "找不到绑定单元源码 scut_bind.c。\n"
            "    原因：这是【唯一】知道编译期图像尺寸的编译单元，"
            "核心库刻意不知道尺寸，没有它就无法把尺寸交给环境。\n"
            "    下一步：确认 <仓库>/bind/scut_bind.c 存在，"
            "或在 %s 下放一份自定义的 scut_bind.c。"
            % os.path.join(proj.root, "bind"))
        return finish(2)

    # ------------------------------------------------------------------------
    # ★ 自动构建 / 增量重建核心库
    #
    # 为什么必须自动化（而不是只报「找不到核心库」）：
    #   「上手即用」是本项目的首要理念。如果用户拿到的工程里没有
    #   libscut_core.a，却要先自己去 core/ 手工编译一遍才能跑，
    #   那这个理念就是空话。
    #
    # 为什么必须【增量】判断：
    #   核心库存在的意义就是「改用户算法时环境不重编」。
    #   但如果无脑每次重建，这个收益就没了，而且用户改一行算法要等好几秒。
    #
    # ★★ 判据用【内容指纹】而不是 mtime ★★
    #   旧实现只比较文件修改时间。这在两种真实场景下会静默用错库：
    #     ① git clone / 解压 zip：文件时间戳来自打包顺序，源码可能比
    #        库文件"更旧"，于是改过的源码被判成"没变"，用旧库链接 ——
    #        报出来的是一堆 undefined reference，而根因完全看不出来；
    #     ② 本仓库里真的发生过：一个预先放好的 .a 缺了两个目标文件，
    #        因为它的 mtime 恰好较新，一直没被重建。
    #   指纹方案对这两种情况都免疫，代价只是每次构建多读几十 KB。
    #
    # 为什么源码缺失时【不报错】：
    #   SDK 可以以「只有库、没有源码」的形式分发（保护环境实现）。
    #   这时库文件本身就是要用的东西，源码不在是完全正常的。
    #   但那种情况下我们【无法】校验指纹，所以只在存在指纹文件时才比对。
    # ------------------------------------------------------------------------
    sdk_core_src_dir = os.path.join(SDK_ROOT, "core", "src")
    sdk_core_inc_dir = os.path.join(SDK_ROOT, "core", "include")
    core_sources = []
    if os.path.isdir(sdk_core_src_dir):
        core_sources = sorted(
            os.path.join(sdk_core_src_dir, n)
            for n in os.listdir(sdk_core_src_dir) if n.endswith(".c"))

    core_headers = []
    if os.path.isdir(sdk_core_inc_dir):
        core_headers = sorted(
            os.path.join(sdk_core_inc_dir, n)
            for n in os.listdir(sdk_core_inc_dir) if n.endswith(".h"))

    # 核心库的编译参数（环境自身，恒 -O2 —— 见下面 user_flags/env_flags 的说明）。
    # ★ 必须参与内容指纹：否则改了优化等级指纹却不变，旧的 -O0 核心库会被
    #   一直复用，表现为"改了构建参数却没生效"，不报错、极难发现。
    core_flags = ["-std=c11", "-O2", "-Wall", "-Wextra"]

    def _core_fingerprint() -> str:
        """核心库全部输入（编译器身份 + 编译参数 + .c/.h + bind 源码）的内容指纹。

        ★★ 为什么【必须】把编译器身份也算进去 ★★
          指纹原先只含 core_flags 与源码字节。于是用户在配置面板里把工具链
          从"A 处的 clang"换成"B 处的 clang"（或从 llvm-mingw 的 msvcrt 版
          换成 ucrt 版）之后，源码没变 → 指纹没变 → **继续复用上一次编出来的
          libscut_core.a**。而那份库是用【另一个 ABI/CRT】编的，
          链接期就会报一堆莫名其妙的符号错误 —— 报错完全指不到
          "库和编译器不匹配"这个真实原因。

          这正是本文件别处（以及 sync-sdk.js）反复强调的那类事故：
          分发预编译的 .a 之所以危险，就是因为 ABI 绑死。
          增量缓存里同样会发生，只是更容易被忽略。

          所以指纹里加入：编译器的【绝对路径】+ 它的【版本串】。
          路径也要算 —— 同一台机器上可能并存多个 clang，版本串相同
          但 CRT/sysroot 不同（实测过 msvcrt 与 ucrt 两个发行版）。
          版本串拿不到时退化成空串，此时至少路径仍能区分。
        """
        h = hashlib.sha256()
        # 编译器身份：路径 + 版本。必须放在最前，便于日后排查时肉眼比对。
        # ★ 用 tc.cc / tc.cc_version（do_build 里的 Toolchain 值），
        #   不是 cc —— 后者是本文件别处的局部名，在这里并不存在。
        h.update(("cc=" + str(tc.cc)).encode("utf-8", "replace"))
        h.update(b"\0")
        h.update(("ccver=" + str(tc.cc_version)).encode("utf-8", "replace"))
        h.update(b"\0")
        h.update((" ".join(core_flags)).encode("utf-8"))
        for p in sorted(core_sources + core_headers + [bind_src]):
            h.update(os.path.basename(p).encode("utf-8", "replace"))
            try:
                with open(p, "rb") as f:
                    h.update(f.read())
            except OSError:
                h.update(b"<unreadable>")
        return h.hexdigest()

    need_core_rebuild = False
    if core_sources:
        core_stamp = core_lib + ".sha256"
        if not os.path.isfile(core_lib):
            need_core_rebuild = True
            reporter.human("  核心库不存在，将从源码构建（首次构建较慢，之后会缓存）")
        else:
            want = _core_fingerprint()
            have = ""
            if os.path.isfile(core_stamp):
                try:
                    with open(core_stamp, "r", encoding="utf-8") as f:
                        have = f.read().strip()
                except OSError:
                    have = ""
            if have != want:
                need_core_rebuild = True
                if not have:
                    reporter.human("  核心库没有内容指纹（旧版本留下的），重建以保证一致")
                else:
                    reporter.human("  核心源码有更新，重建核心库")

    if need_core_rebuild:
        with timer.stage("构建核心库"):
            os.makedirs(os.path.dirname(core_lib), exist_ok=True)
            core_objs: List[str] = []
            core_stage = os.path.join(proj.obj_dir, "core")
            os.makedirs(core_stage, exist_ok=True)
            for src in core_sources:
                obj = os.path.join(core_stage,
                                   os.path.basename(src)[:-2] + ".o")
                cmd = ([tc.cc] + core_flags
                       + ["-I" + sdk_core_inc_dir, "-I" + sdk_core_src_dir]
                       + ["-c", src, "-o", obj])
                reporter.detail("  $ " + " ".join(
                    '"%s"' % a if " " in a else a for a in cmd))
                rc = run_cmd(cmd)
                if rc.code != 0:
                    reporter.error(
                        "核心库源码编译失败：%s\n"
                        "    这是环境自身的问题，不是你的算法问题。\n"
                        "    下一步：把上面的编译输出贴给我们。"
                        % os.path.basename(src))
                    return finish(2)
                core_objs.append(obj)

            ar = shutil.which("ar") or shutil.which("llvm-ar")
            if not ar:
                # 退回到工具链目录里的 ar
                cand = os.path.join(os.path.dirname(tc.cc), "ar.exe")
                ar = cand if os.path.isfile(cand) else None
            if not ar:
                reporter.error(
                    "找不到 ar（打包静态库的工具）。\n"
                    "    下一步：安装 binutils，或把它的目录加进 PATH。")
                return 1, None

            # 先写临时库再 os.replace：避免插件在构建过程中读到半个库
            tmp_lib = core_lib + ".tmp"
            try:
                os.unlink(tmp_lib)
            except OSError:
                pass
            rc = run_cmd([ar, "rcs", tmp_lib] + core_objs)
            if rc.code != 0:
                reporter.error("打包核心静态库失败。")
                return 1, None
            os.replace(tmp_lib, core_lib)
            atomic_write_text(core_lib + ".sha256", _core_fingerprint() + "\n")
            reporter.human("  核心库已构建: %s" % core_lib)

    # 注：用户代码的优化等级由下面的 user_flags 统一决定（恒 -O0），
    # 见"用户代码与【非环境代码】的优化等级"那段说明。

    # --- 3) 工程配置 → 生成编译期契约头 + 环境接线单元 ---------------------
    #
    # ★ 配置的唯一入口是 scut_project.json（插件设置界面维护）。
    #   没有它时回落到老的 config.h（迁移期不该强制用户改），
    #   两者都没有则用默认值 —— "什么都没有也能构建"是上手即用的一部分。
    #
    # ★ 生成物放 .scut/gen/，并且 -I 顺序把它排在最前，
    #   于是 bind 与用户代码的 #include "scut_config.h" 都命中生成的那一份。
    cfg: Dict[str, Any] = {}
    cfg_source = ""
    with timer.stage("读取工程配置"):
        try:
            cfg, cfg_source = load_project_config(proj, reporter)
            img_w, img_h = _cfg_image(cfg)
            # ★ 配置读出来之后必须【立刻】把 pic.dir 落到 proj 上：
            #   下面第 5) 步的"没有测试图"警告读的就是 proj.pic_dir。
            #   放在这里而不是等用到时现算，是为了让两处消费者
            #   （那条警告 + do_clean 的图集统计）天然看到同一个值。
            apply_pic_dir(proj, cfg)

            # ★ 变量发现的两个过滤器：CLI 优先，其次工程配置。
            #   为什么 CLI 优先：命令行是"这一次构建"的显式覆盖，
            #   与 --toolchain / --core-lib 等的取向一致
            #   （显式的东西压过配置里的默认值）。
            #   为什么要从配置里读：插件没有命令行，它只能改
            #   scut_project.json —— 不读配置的话这两个开关就
            #   永远只有手敲命令的人能用（那正是它们原先的状态）。
            if not cli_exclude:
                exclude_names = str(
                    ((cfg.get("toolchain") or {}).get("watchExclude") or "")).strip()
            if cli_max_elems <= 0:
                try:
                    max_elems = int(
                        ((cfg.get("toolchain") or {}).get("watchMaxElems") or 0))
                except (TypeError, ValueError):
                    max_elems = 0
                if max_elems < 0:
                    max_elems = 0
        except ConfigParseError as exc:
            reporter.error(str(exc) + "\n    下一步：修好后重跑构建。")
            return finish(2)

        reporter.human("  配置来源: %s" % cfg_source)
        reporter.human("  图像尺寸: %d x %d" % (img_w, img_h))
        if exclude_names:
            reporter.human("  变量黑名单: %s" % exclude_names)
        if max_elems > 0:
            reporter.human("  变量元素上限: %d（超过的不进面板）" % max_elems)

        try:
            write_generated_config(proj.gen_dir, cfg)
            glue_path = write_glue(proj.gen_dir, cfg)
        except ConfigParseError as exc:
            reporter.error(str(exc) + "\n    下一步：修好后重跑构建。")
            return finish(2)

        n_init = len(_cfg_names(cfg, "init"))
        n_frame = len(_cfg_names(cfg, "frame"))
        n_post = len(_cfg_names(cfg, "post"))
        out_array = str(cfg.get("outputArray") or "").strip()
        reporter.human("  钩子函数: 初始化 %d 个 / 处理 %d 个 / 后处理 %d 个"
                       % (n_init, n_frame, n_post))
        reporter.human("  结果图数组: %s"
                       % (out_array if out_array else "（未配置，显示输入图）"))
        reporter.detail("  生成契约头: %s"
                        % os.path.join(proj.gen_dir, "scut_config.h"))
        reporter.detail("  生成接线单元: %s" % glue_path)

    # 尺寸宏由生成的头文件提供，绝不再传 -D（会报 macro redefined）
    cfg_flags: List[str] = []

    # ★ 文案里必须出现【实际用的目录】，不能写死 "pic/"：
    #   目录来自配置（apply_pic_dir 刚落的 pic.dir），
    #   用户配的是 pic/3 时提示"创建 pic/"会把人指到错的地方。
    #   相对工程根显示，避免把绝对路径铺满终端（与后端
    #   scut_pic_path_display 的口径一致）。
    #
    # ★ 必须在分支【之前】算好：两个分支都要用它。
    #   （第一版把它写在 if 分支里、else 分支引用，直接 UnboundLocalError，
    #     被 tests/test_glue_edges.py 当场抓住 —— 这正是那套测试存在的意义。）
    _shown = os.path.relpath(proj.pic_dir, proj.root).replace("\\", "/")

    if not os.path.isdir(proj.pic_dir):
        reporter.warn(
            "工程里没有 %s 目录，仿真将没有测试图可读。\n"
            "    影响：仿真能启动，但画面会全黑，容易误判成算法有问题。\n"
            "    下一步：把测试图放进 %s，或在配置面板里改「图集目录」。"
            % (_shown, _shown))
    else:
        pics = [n for n in os.listdir(proj.pic_dir)
                if os.path.splitext(n)[1].lower()
                in (".bmp", ".png", ".jpg", ".jpeg", ".pgm")]
        if not pics:
            reporter.warn(
                "目录 %s 里没有任何图片，仿真将没有测试图可读。\n"
                "    影响：画面会全黑，容易误判成算法有问题。\n"
                "    下一步：往这个目录里放测试图。" % _shown)

    # --- 4) 核心静态库存在性 ------------------------------------------------
    # 放在契约解析【之后】：先让用户把「工程自身的配置问题」修完，
    # 再来处理「环境产物缺了」这类部署问题。见上面 --- 2) 的说明。
    if not os.path.isfile(core_lib):
        reporter.error(
            "找不到环境核心静态库：%s\n"
            "    原因：环境核心（调度/注册表/计时/绘制/日志）是预编译成静态库"
            "发布的，构建脚本本身不负责编译它——这样你改算法时环境零重编。\n"
            "    下一步（任选其一）：\n"
            "      1) 把 libscut_core.a 放到 %s\n"
            "      2) 用 --core-lib <path> 指定它的位置\n"
            "      3) 若你是从源码构建环境：先用 core/ 产出 libscut_core.a，"
            "再重跑本命令。"
            % (core_lib, os.path.join(proj.root, DEFAULT_CORE_LIB_REL)))
        return finish(2)
    reporter.human("  核心库  : %s" % core_lib)

    # --- 5) 准备目录与公共选项 --------------------------------------------
    proj.ensure_dirs()
    core_include = os.path.join(SCUT_TOOL_ROOT, "core", "include")
    if not os.path.isdir(core_include):
        reporter.warn(
            "找不到环境头文件目录：%s\n"
            "    影响：编译一定失败（bind 与用户代码都要 include scut_*.h）。\n"
            "    下一步：确认本脚本位于 <仓库>/tools/ 下，"
            "且 <仓库>/core/include/ 存在。" % core_include)

    # bind/scut_bind.c 已在 core_lib 解析处定位（见上面的说明）。

    # include 搜索顺序（★ 顺序本身就是设计）：
    #   1) .scut/gen          —— 必须有，转发头 scut_config.h 在这里，
    #                            才能让 bind 源码的原样 #include 生效
    #   2) core/include       —— 环境头文件
    #   3) 工程根             —— 让用户代码写 #include "config.h" 也能用
    #   4) code/              —— 允许用户把 .h 放在 code/ 里就近 include
    include_dirs = (["-I" + proj.gen_dir]
                    + ["-I" + core_include]
                    + ["-I" + proj.root]
                    + ["-I" + proj.code_dir])

    # objcopy 用于把探针 .o 的 DWARF 偏移写法规范化（clang → binutils），
    # 见 normalize_probe_obj_dwarf。缺失时静默跳过，不让构建失败。
    objcopy = _find_objcopy(tc.cc)

    base_flags = ["-std=c11", "-Wall", "-Wextra"] + cfg_flags
    # 探针 flags：★ 恒用 -g -O0（固定不变）。
    #   理由（两条都是实测）：
    #     1) 环境侧的 -O2 会把「未使用的 static」整个删掉（clang 有权这么做），
    #        那些变量在目标文件里根本不存在，自然发现不了 —— 用户会以为
    #        「变量面板坏了」。探针阶段保持 -O0 就不丢变量。
    #     2) -g 是 DWARF 的来源，自动发现完全依赖它。
    probe_flags = ["-g", "-O0"]

    # ★★ 用户代码与【环境代码】的优化等级固定分开，不提供开关 ★★
    #
    #   用户需求原话：
    #     · "用户代码需要强制 O0 优化（不优化）"
    #     · "Scut71: Build Mode 参数没有意义，说了 C 代码只要 O0，别的部分可以优化"
    #
    #   用户代码恒 -g -O0：-O2 会重排、合并语句、把变量优化进寄存器，
    #   逐行调试时断点漂移、变量看不到值 —— 与"用仿真理解算法行为"直接冲突。
    #
    #   环境自身（bind 单元、核心库、呈现后端、接线单元）恒 -O2：
    #   它们不是算法，优化只影响环境开销，不影响可调试性，还能让仿真更接近
    #   真机节奏。原来把它做成 `--mode` 选项，用户既看不懂也没必要选，
    #   现在直接写死成上面的约定。
    #
    #   ★ 曾经这里只有一套 mode_flags，release 时会把用户代码也压成 -O2，
    #     直接违反上面这条需求（而且注释还写着"用户源码永远 -O0"）——
    #     注释与实现不一致是最容易骗过 review 的一类 bug，所以拆成两个变量，
    #     让"谁该被优化"在代码里一眼可见。
    user_flags = ["-g", "-O0"]
    env_flags = ["-O2"]

    reporter.human("")

    # --- 5) 编译 bind 单元 -------------------------------------------------
    # bind 是唯一知道编译期尺寸的地方，改 config.h 只需重编它 + 用户算法，
    # 核心库零重编 —— 这是整套架构的核心收益。
    bind_obj = os.path.join(proj.obj_dir, "scut_bind.o")
    with timer.stage("编译 bind 单元"):
        bind_cmd = ([tc.cc] + base_flags + env_flags + include_dirs
                    + ["-c", bind_src, "-o", bind_obj])
        reporter.detail("  $ " + " ".join(
            '"%s"' % a if " " in a else a for a in bind_cmd))
        rb = run_cmd(bind_cmd)
        with log_lock:
            logs.append(rb.out)
        if rb.code != 0:
            diags = parse_diagnostics(rb.out)
            reporter.error("绑定单元 scut_bind.c 编译失败。\n"
                           "    原因：多半是 config.h 里的 SCUT_IMAGE_W/H "
                           "不合法，或 core/include 下的头文件缺失。\n"
                           "    " + first_error_digest(diags).replace("\n", "\n    "))
            timer.report()
            return finish(1)

    # --- 6) 编译用户单元（两遍编译，多线程并行） ---------------------------
    jobs: List[UnitJob] = []
    for src in sources:
        rel = os.path.relpath(src, proj.code_dir).replace("\\", "/")
        stem = rel[:-2] if rel.lower().endswith(".c") else rel
        flat = stem.replace("/", "__")
        jobs.append(UnitJob(
            src=src,
            rel=rel,
            obj=os.path.join(proj.obj_dir, flat + ".probe.o"),
            wrapped=os.path.join(proj.gen_dir, flat + ".wrapped.c"),
            wrapped_obj=os.path.join(proj.obj_dir, flat + ".o"),
            manifest=os.path.join(proj.gen_dir, flat + ".vars.json"),
        ))

    workers = max(1, int(args.jobs))
    # 结果图数组名：交给符号发现阶段，让它在【声明了该数组的那个 TU】里
    # 生成 scut_env_copy_output()。不在这里生成，是因为只有展开了用户
    # 源码才看得见该数组的真实类型与作用域。
    out_array = str(cfg.get("outputArray") or "").strip()
    # 尺寸字符串只用于错误提示的措辞，不参与生成逻辑。
    img_shape = "%d 行 × %d 列" % (img_h, img_w) if (img_w and img_h) else ""

    # --no-watch 路径没有 DWARF 可用，所以事先用编译器探出数组的归属文件。
    # 这一步只在真的需要搬运函数时才做（否则纯属浪费）。
    out_owner: Optional[str] = None
    if out_array and not auto_watch:
        with timer.stage("定位结果图数组"):
            probe_dir = tempfile.mkdtemp(prefix="scut_own_", dir=proj.scut_dir)
            try:
                out_owner = find_output_owner(sources, out_array, tc.cc,
                                              base_flags, include_dirs,
                                              probe_dir)
            finally:
                shutil.rmtree(probe_dir, ignore_errors=True)
        if out_owner is None:
            reporter.error(
                "设置里指定的「结果图数组名」在 code/ 里找不到：%s\n"
                "    原因：没有哪个 code/*.c 能在文件作用域里看到这个名字，\n"
                "    或者它指向的不是二维数组"
                "（环境要按【%s】的图像去读它）。\n"
                "    下一步（任选其一）：\n"
                "      1) 把它改成你代码里真正存放结果图的数组名"
                "（例如 unsigned char g_binary[SCUT_IMAGE_H][SCUT_IMAGE_W]）；\n"
                "      2) 或者把这个设置留空 —— 画面将显示输入图本身。\n"
                "    说明：数组名填错只会影响「处理后的图像」显示，"
                "不影响算法的编译与运行。"
                % (out_array, img_shape or "环境配置的"))
            timer.report()
            return finish(2)
        reporter.human("  结果图数组 : %s（声明在 %s）"
                       % (out_array, os.path.relpath(out_owner, proj.root)))

    with timer.stage("编译用户代码（%d 个文件）" % len(jobs)):
        if workers == 1 or len(jobs) == 1:
            for j in jobs:
                build_one_unit(j, tc.cc, tc.objdump, tc.python,
                               SYMBOLS_TOOL, base_flags, user_flags, probe_flags,
                               include_dirs, objcopy, auto_watch, out_array,
                               out_owner, img_shape,
                               reporter, log_lock, logs, proj,
                               exclude_names, max_elems)
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                futs = [ex.submit(
                    build_one_unit, j, tc.cc, tc.objdump, tc.python,
                    SYMBOLS_TOOL, base_flags, user_flags, probe_flags,
                    include_dirs, objcopy, auto_watch, out_array,
                    out_owner, img_shape,
                    reporter, log_lock, logs, proj,
                    exclude_names, max_elems)
                    for j in jobs]
                concurrent.futures.wait(futs)

    for j in jobs:
        for w in j.warnings:
            reporter.warn("%s：%s" % (os.path.relpath(j.src, proj.root), w))

    # --- 6) 用户配置错误：立刻停下，原文报出 --------------------------------
    #
    # ★ 为什么必须在编译/链接【之前】拦下来：
    #   这类错误（例如结果图数组名指向一个标量）不会让编译失败，
    #   而是让程序每帧越界读一大片内存 —— 画面是垃圾，但不报错、不崩溃。
    #   继续构建只会把一个"看不出来的错误"交付给用户。
    for j in jobs:
        if j.config_error:
            reporter.error(j.config_error)
            timer.report()
            return finish(2)

    # --- 6a) 确认结果图搬运函数确实被生成了 ---------------------------------
    #
    # ★ 为什么必须显式检查（而不是等链接器报错）：
    #   搬运函数由"声明了该数组的那个包装单元"生成。如果数组名写错、
    #   或者它被声明在头文件里而我们没找到，函数就没人生成 ——
    #   而接线单元仍在调它，链接期报的是
    #       undefined reference to `scut_env_copy_output'
    #   这句话对用户毫无指导意义（他从没写过这个函数）。
    #   在这里先检查一遍，就能给出"你填的数组名在 code/ 里找不到"这种
    #   能直接照着改的提示。
    if out_array and auto_watch:
        defined = False
        for j in jobs:
            if not j.used_wrapper or not os.path.isfile(j.wrapped):
                continue
            try:
                with open(j.wrapped, "r", encoding="utf-8-sig",
                          errors="replace") as f:
                    if "void scut_env_copy_output(void)" in f.read():
                        defined = True
                        break
            except OSError:
                continue
        if not defined:
            reporter.error(
                "设置里指定的「结果图数组名」在 code/ 里找不到：%s\n"
                "    原因：这个数组必须【定义】在某个 code/*.c 的\n"
                "    文件作用域里（不能只声明在头文件里，也不能写成局部的）。\n"
                "    下一步（任选其一）：\n"
                "      1) 把它改成你代码里真正存放结果图的数组名；\n"
                "      2) 或者把这个设置留空 —— 画面将显示输入图本身。\n"
                "    说明：数组名填错只会影响「处理后的图像」显示，"
                "不影响算法编译与运行。" % out_array)
            timer.report()
            return finish(2)

    # --- 6b) 编译环境接线单元 ------------------------------------------------
    #
    # ★ 这个单元把用户函数接进环境的三个阶段（初始化/处理/绘制）。
    #   它是"用户代码可直接移植"的关键：注册信息留在环境侧，
    #   用户 code/ 里一个 SCUT_ 宏都不需要。
    #
    # ★ 放在用户代码【之后】编译：它的函数声明来自用户代码，
    #   若用户函数名填错，这里会给出"未定义符号"的链接期错误，
    #   而那正是我们想暴露的问题（比静默不执行好得多）。
    # ★ 用 env_flags 而不是 user_flags：接线单元属于【环境】，
    #   不是用户算法 —— 环境部分恒 -O2（用户代码恒 -O0，见上面的说明）。
    glue_obj = os.path.join(proj.obj_dir, "scut_env_glue.o")
    with timer.stage("编译环境接线"):
        gcmd = ([tc.cc] + base_flags + env_flags + include_dirs
                + ["-c", glue_path, "-o", glue_obj])
        reporter.detail("  $ " + " ".join(
            '"%s"' % a if " " in a else a for a in gcmd))
        rg = run_cmd(gcmd)
        with log_lock:
            logs.append(rg.out)
        if rg.code != 0:
            gd = parse_diagnostics(rg.out)
            reporter.error(
                "环境接线单元编译失败。\n"
                "    原因：多半是设置里填的钩子函数名与代码不一致，"
                "或者函数被写成了 static（必须是非 static 的 void f(void)）。\n"
                "    " + first_error_digest(gd).replace("\n", "\n    "))
            timer.report()
            return finish(1)

    all_output = "".join(logs)
    diags = parse_diagnostics(all_output)
    errors = [d for d in diags if d["severity"] == "error"]
    if errors:
        reporter.human("")
        reporter.error("编译失败。\n    "
                       + first_error_digest(diags).replace("\n", "\n    "))
        timer.report()
        return finish(1)

    # --- 7) 汇总变量清单 ---------------------------------------------------
    manifest: Optional[Dict[str, Any]] = None
    if auto_watch:
        with timer.stage("汇总变量清单"):
            manifest = merge_manifests(jobs)
            if manifest is not None:
                atomic_write_text(
                    os.path.join(proj.gen_dir, "variables.json"),
                    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
                reporter.human("  变量清单: 共发现 %d 个全局变量" % manifest["count"])
                for var in manifest["variables"]:
                    reporter.human("      %-24s %-14s %s%s"
                                   % (var["name"], var["kind"],
                                      "x".join(str(n) for n in var["dims"])
                                      or "scalar",
                                      "  (static)" if var["isStatic"] else ""))

    if not auto_watch:
        reporter.human("  变量清单: 未生成（自动符号发现已关闭）")

    # --- 7.5) 编译呈现后端 ------------------------------------------------
    # ★ 为什么必须有这一步：
    #   核心库刻意【不提供 main】—— 「核心不拥有窗口」这条原则的直接后果。
    #   谁提供 main 谁就是「后端」：headless / 独立窗口 / Webview 各有一个。
    #   早期版本漏了这一步，链接期报 `undefined symbol: WinMain`：
    #   因为没有 main，MinGW 的启动代码就去找 Windows GUI 入口点，
    #   而报错完全没提「你少了个后端」，属于典型的误导性错误。
    #
    #   后端源码位置（按优先级）：
    #     1) <project>/backend/*.c        —— 允许工程自带自定义后端
    #     2) <sdk>/backends/<backend>/*.c —— 环境自带的后端
    backend_objs: List[str] = []
    backend_dirs: List[str] = []

    proj_backend = os.path.join(proj.root, "backend")
    if os.path.isdir(proj_backend):
        backend_dirs.append(proj_backend)

    sdk_backend = os.path.join(SDK_ROOT, "backends", args.backend)
    if os.path.isdir(sdk_backend):
        backend_dirs.append(sdk_backend)

    if not backend_dirs:
        reporter.error(
            "找不到呈现后端（没有 main 函数，链接必然失败）。\n"
            "    后端是「谁提供 main」的地方：headless / window / webview 各一个。\n"
            "    下一步：确认 SDK 的 backends/%s/ 目录存在，"
            "或在工程里新建 backend/ 放一个带 main 的 .c。" % args.backend)
        return 1, None

    with timer.stage("编译呈现后端"):
        for bdir in backend_dirs:
            for name in sorted(os.listdir(bdir)):
                if not name.endswith(".c"):
                    continue
                src = os.path.join(bdir, name)
                obj = os.path.join(proj.obj_dir, "backend_" + name[:-2] + ".o")
                cmd = ([tc.cc] + base_flags + env_flags + include_dirs
                       + ["-c", src, "-o", obj])
                reporter.detail("  $ " + " ".join(
                    '"%s"' % a if " " in a else a for a in cmd))
                rb = run_cmd(cmd)
                with log_lock:
                    logs.append(rb.out)
                if rb.code != 0:
                    reporter.error("后端 %s 编译失败。" % name)
                    return 1, None
                backend_objs.append(obj)

    # --- 8) 链接 ------------------------------------------------------------
    # 链接命令行构造。★ 这里刻意【不含 --whole-archive】：
    #   用户代码是直接链接输入（不是库成员），不存在被丢弃的问题；
    #   而 libscut_core.a 里被引用的符号必然被拉取。
    #   （旧方案把用户代码打成 libuser.a 才需要该选项。）
    extra_libs, extra_libdirs = parse_extra_mk(proj.extra_mk, reporter)
    if extra_libs or extra_libdirs:
        reporter.human("  额外链接: %s" % " ".join(extra_libdirs + extra_libs))

    # 先链到临时文件，成功后再 os.replace —— 避免插件拿到「上一次的旧 exe」
    # 或「链接到一半的损坏 exe」。
    tmp_exe = os.path.join(proj.bin_dir, "scut_sim.tmp.exe")
    for p in (tmp_exe,):
        try:
            os.unlink(p)
        except OSError:
            pass

    link_cmd = ([tc.cc]
                + [bind_obj]
                + [j.wrapped_obj for j in jobs]
                + [glue_obj]
                + backend_objs
                + ["-L" + os.path.dirname(core_lib)]
                + extra_libdirs
                + ["-lscut_core"]
                + extra_libs
                + ["-lm"]
                + ["-o", tmp_exe])

    with timer.stage("链接"):
        reporter.detail("  $ " + " ".join(
            '"%s"' % a if " " in a else a for a in link_cmd))
        rl = run_cmd(link_cmd)
        with log_lock:
            logs.append(rl.out)
        if rl.code != 0:
            link_diags = parse_diagnostics(rl.out)
            # 链接错误常常没有位置信息，这里补一条人话解释：
            # 未定义符号几乎一定是「核心库不完整」或「用户少写了实现」。
            missing = re.findall(r"undefined (?:reference to|symbol:?)\s*[`'\"]?([A-Za-z_]\w*)",
                                 rl.out)
            hint = ""
            if missing:
                uniq = []
                for m in missing:
                    if m not in uniq:
                        uniq.append(m)
                hint = ("\n    缺失的符号：%s\n"
                        "    原因：这些符号既不在你的 code/*.c 里，"
                        "也不在核心库 %s 里。若它们是 scut_core_init / "
                        "SCUT_Register / SCUT_Watch 之类，说明核心库不完整或"
                        "根本不是本环境的核心库。"
                        % (", ".join(uniq[:8]), os.path.basename(core_lib)))
            reporter.error("链接失败。" + hint + "\n    "
                           + (first_error_digest(link_diags).replace("\n", "\n    ")
                              or rl.out.strip()[:400]))
            diags = diags + link_diags
            timer.report()
            return finish(1)
        os.replace(tmp_exe, proj.exe_path)

    reporter.human("")
    reporter.human("构建成功")
    reporter.human("  可执行文件: %s" % proj.exe_path)
    timer.report()

    result["ok"] = True
    result["exePath"] = proj.exe_path
    result["manifest"] = manifest
    return finish(0)


def merge_manifests(jobs: List[UnitJob]) -> Optional[Dict[str, Any]]:
    """
    把每个文件的 vars.json 合成一份清单。

    单文件时原样透传（保持与 scut_symbols.py 完全一致的形状）；
    多文件时拼接并注明来源。形状固定为
    {source, count, variables, manualWatches}，
    与 extension/src/types.ts 的 VariableManifest 对应。

    ★ manualWatches 要【跨所有 TU 汇总】，不能只取单个文件的：
      用户把注册调用写在 camera.c 里，而另一个文件 common_var.c 可能一个
      手写变量都没有。只看第一份的话，注册写在哪个文件决定了这个功能
      有没有效 —— 这属于"结果取决于无关因素"，是最难查的一类缺陷。
    """
    pieces: List[Dict[str, Any]] = []
    for j in jobs:
        if not j.used_wrapper or not os.path.isfile(j.manifest):
            continue
        try:
            with open(j.manifest, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("variables"), list):
            pieces.append(data)
    if not pieces:
        return None

    # 手写注册的名字：并集 + 去重 + 稳定排序
    manual: Set[str] = set()
    for p in pieces:
        for n in p.get("manualWatches", []) or []:
            if isinstance(n, str) and n:
                manual.add(n)

    if len(pieces) == 1:
        only = pieces[0]
        return {
            "source": only.get("source", ""),
            "count": int(only.get("count", len(only.get("variables", [])))),
            "manualWatches": sorted(manual),
            "variables": only.get("variables", []),
        }
    variables: List[Dict[str, Any]] = []
    for p in pieces:
        variables.extend(p.get("variables", []))
    return {
        "source": ", ".join(str(p.get("source", "?")) for p in pieces),
        "count": len(variables),
        "manualWatches": sorted(manual),
        "variables": variables,
    }


# ===========================================================================
# doctor
# ===========================================================================

def do_doctor(args: argparse.Namespace, reporter: Reporter,
              timer: StageTimer) -> Tuple[int, Dict[str, Any]]:
    proj = Project(args.project)
    lines: List[str] = []
    errors: List[str] = []
    warnings: List[str] = []

    def say(msg: str, to_lines: bool = True) -> None:
        reporter.human(msg)
        if to_lines:
            lines.append(msg)

    say("SCUT-71 Vision Studio 环境自检（doctor）")
    say("=" * 62)

    # ---- 1) 工具链 --------------------------------------------------------
    say("")
    say("[1/3] 工具链")
    with timer.stage("工具链探测"):
        tc = detect_toolchain(args.toolchain, reporter)

    if tc.cc:
        say("  ✅ clang      : %s" % tc.cc)
        if tc.cc_version:
            say("     版本       : %s" % tc.cc_version)
    else:
        say("  ❌ clang      : 未找到")
        errors.append(
            "找不到 clang 编译器。下一步：安装 LLVM-MinGW（自带 MinGW sysroot，"
            "装完即可编译），或用 --toolchain <根目录> 指定，"
            "或把它的 bin 目录加进 PATH。")

    if tc.objdump and tc.objdump_is_binutils:
        say("  ✅ objdump    : %s" % tc.objdump)
        say("     版本       : %s（binutils，支持 --dwarf=info）"
            % (tc.objdump_version or "未知"))
    elif tc.objdump:
        say("  ⚠️  objdump    : %s" % tc.objdump)
        say("     版本       : %s" % (tc.objdump_version or "未知"))
        say("     ★ 这不是 binutils 的 objdump。")
        warnings.append(
            "objdump 不是 binutils 版本（看起来是 LLVM 的）。自动符号发现依赖 "
            "`objdump --dwarf=info`，而 LLVM 21 已移除该选项"
            "（llvm-objdump 只支持 --dwarf=frames）。"
            "后果：变量面板永远是空的，而且【不会报任何错】。"
            "下一步：安装 MinGW-w64（提供 binutils），"
            "或把 binutils 的 bin 目录加进 PATH；也可以加 --no-watch 显式跳过。")
    else:
        say("  ❌ objdump    : 未找到")
        warnings.append(
            "找不到 objdump。自动符号发现依赖 `objdump --dwarf=info`；"
            "这不是 LLVM 能提供的（LLVM 21 已移除 --dwarf=info），"
            "必须用 binutils 的版本。"
            "下一步：安装 MinGW-w64 或把 binutils 加进 PATH。"
            "临时绕过：加 --no-watch 仍可正常构建。")

    if tc.lldb_dap:
        say("  ✅ lldb-dap   : %s" % tc.lldb_dap)
    else:
        say("  ⚠️  lldb-dap   : 未找到（调试功能将降级为「只能跑」）")
    if tc.clangd:
        say("  ✅ clangd     : %s" % tc.clangd)
    else:
        say("  ⚠️  clangd     : 未找到（补全/跳转将降级，不影响仿真）")

    if tc.python:
        say("  ✅ python     : %s" % tc.python)
    else:
        say("  ❌ python     : 未找到")
        errors.append(
            "找不到用于运行 tools/scut_symbols.py 的 Python 解释器。"
            "下一步：安装 Python 3.7+，或用配置面板的「工具链 › Python 解释器路径」"
            "指定它。")

    for w in tc.warnings:
        # 上面已经用更具体的话说过一遍了，这里去重
        if w not in warnings:
            warnings.append(w)

    # ---- 2) 工程结构 ------------------------------------------------------
    say("")
    say("[2/3] 工程结构")
    if not os.path.isdir(proj.root):
        say("  ❌ 工程目录不存在：%s" % proj.root)
        errors.append("工程目录不存在：%s。下一步：确认 --project 指向正确的目录。"
                      % proj.root)
    else:
        say("  ✅ 工程根目录 : %s" % proj.root)

    if os.path.isdir(proj.code_dir):
        sources = proj.user_sources()
        if sources:
            say("  ✅ code/      : 找到 %d 个 .c 文件" % len(sources))
            for s in sources[:20]:
                say("       %s" % os.path.relpath(s, proj.root))
            if len(sources) > 20:
                say("       … 另有 %d 个" % (len(sources) - 20))
        else:
            say("  ❌ code/      : 目录存在，但没有 .c 文件")
            errors.append(
                "code/ 目录里没有 .c 文件。下一步：把算法写进 code/*.c，"
                "或从 templates/starter/code/camera.c 复制一份起步模板。")
    else:
        say("  ❌ code/      : 不存在")
        errors.append(
            "工程里没有 code/ 目录。下一步：创建 code/ 并放入至少一个 .c 文件"
            "（或从 templates/starter/ 复制起步模板）。")

    # 工程配置：scut_project.json 是新约定，config.h 只为兼容老工程保留。
    try:
        cfg, cfg_source = load_project_config(proj, reporter)
        w, h = _cfg_image(cfg)
        # ★ 与 do_build 同一处理：doctor 也要按配置里的图集目录去看。
        #   不加这一句，doctor 会对着硬编码的 <root>/pic 报告图集状态，
        #   与构建、与仿真实际用的目录都不是同一个。
        apply_pic_dir(proj, cfg)
        say("  ✅ 工程配置   : %s" % cfg_source)
        say("     图像尺寸   : %d x %d" % (w, h))
        n_init = len(_cfg_names(cfg, "init"))
        n_frame = len(_cfg_names(cfg, "frame"))
        n_post = len(_cfg_names(cfg, "post"))
        say("     钩子函数   : 初始化 %d / 处理 %d / 后处理 %d"
            % (n_init, n_frame, n_post))
        out_array = str(cfg.get("outputArray") or "").strip()
        say("     结果图数组 : %s" % (out_array or "（未配置，显示输入图）"))
        if not (n_init or n_frame):
            errors.append(
                "工程配置里没有填「图像处理函数」，环境无法运行你的算法。\n"
                "    下一步：执行「SCUT-71: 配置本工程」，或在设置里搜索 "
                "\"SCUT-71\" 填上「图像处理函数」。")
    except ConfigParseError as exc:
        say("  ❌ 工程配置   : 读不出来")
        errors.append(str(exc))

    core_lib = args.core_lib or os.path.join(proj.root, DEFAULT_CORE_LIB_REL)
    core_lib = os.path.abspath(core_lib)
    if os.path.isfile(core_lib):
        say("  ✅ 核心库     : %s（%.1f KB）"
            % (core_lib, os.path.getsize(core_lib) / 1024.0))
    else:
        say("  ❌ 核心库     : 不存在 %s" % core_lib)
        errors.append(
            "找不到环境核心静态库：%s。"
            "下一步：把 libscut_core.a 放到该位置，或用 --core-lib <path> 指定。"
            "（环境核心由 core/ 单独构建，改用户算法时它不需要重编——"
            "这正是本架构「环境零重编」的收益来源。）" % core_lib)

    # pic/ 只警告，不致命：没有测试图仍然可以构建与运行。
    #
    # ★ 必须【递归】统计，而不是只看 pic/ 这一层。
    #   因为图集的约定布局是 pic/<组号>/<编号>.bmp（见 config.h 的 SCUT_PIC_DIR="pic/1"），
    #   图片天生就在子目录里。早期版本只 listdir(pic/)，于是 pic/1/ 里明明有 36 张图，
    #   doctor 仍然报「pic/ 目录里没有任何图片」—— 一句纯粹误导人的警告：
    #   用户会去检查图片，而唯一的错误其实在这里。
    if os.path.isdir(proj.pic_dir):
        pics = []
        for dirpath, _dirnames, filenames in os.walk(proj.pic_dir):
            for n in filenames:
                if os.path.splitext(n)[1].lower() in (".bmp", ".png", ".jpg",
                                                      ".jpeg", ".pgm"):
                    pics.append(os.path.join(dirpath, n))
        if pics:
            # 顺带报出实际发现到哪几个子目录，便于用户核对组号
            groups = sorted({os.path.relpath(os.path.dirname(p), proj.pic_dir)
                             for p in pics})
            say("  ✅ pic/       : 找到 %d 张测试图（%d 个图集：%s）"
                % (len(pics), len(groups), ", ".join(groups[:6])
                   + (" …" if len(groups) > 6 else "")))
        else:
            say("  ⚠️  pic/       : 目录存在，但没有图片")
            warnings.append(
                "pic/ 目录里没有图片。影响：仿真画面会全黑，"
                "容易误判成算法有问题（这是最常见的「假 bug」来源）。"
                "下一步：往 pic/ 里放测试图。")
    else:
        say("  ⚠️  pic/       : 不存在")
        warnings.append("工程里没有 pic/ 目录，仿真将没有测试图可读。")

    if os.path.isfile(proj.extra_mk):
        say("  ✅ scut.extra.mk: 存在（会追加其中的 -l / -L）")
    else:
        say("  ·  scut.extra.mk: 不存在（可选，用于追加 -l / -L）")

    # ---- 3) 结论 ----------------------------------------------------------
    say("")
    say("[3/3] 结论")
    if warnings:
        say("  ⚠️  有 %d 条需要留意的事项：" % len(warnings))
        for i, w in enumerate(warnings, 1):
            say("      %d) %s" % (i, w))
    if errors:
        say("  ❌ 发现 %d 个致命问题，当前【不能】构建：" % len(errors))
        for i, e in enumerate(errors, 1):
            say("      %d) %s" % (i, e))
        reporter.human("")
        reporter.human("退出码 2：存在致命问题。修好上面列出的条目后重新运行 doctor。")
        timer.report()
        return 2, {
            "ok": False,
            "lines": lines,
            "errors": errors,
            "toolchain": tc.to_json(),
        }

    say("  ✅ 工具链与工程结构均正常，可以构建。")
    reporter.human("")
    reporter.human("退出码 0：可以构建。")
    timer.report()
    return 0, {
        "ok": True,
        "lines": lines,
        "errors": [],
        "toolchain": tc.to_json(),
    }


# ===========================================================================
# clean
# ===========================================================================

def do_clean(args: argparse.Namespace, reporter: Reporter,
             timer: StageTimer) -> Tuple[int, Dict[str, Any]]:
    proj = Project(args.project)
    t0 = time.perf_counter()
    if os.path.isdir(proj.scut_dir):
        try:
            # 只删生成物目录 .scut，绝不碰 code/、config.h、pic/ 等用户资产。
            shutil.rmtree(proj.scut_dir)
        except OSError as exc:
            reporter.error("删除生成物目录失败：%s\n"
                           "    原因：多半是有进程正在占用里面的文件"
                           "（例如仿真还在运行，或资源管理器打开了该目录）。\n"
                           "    下一步：关闭 scut_sim.exe / 关闭占用该目录的窗口，"
                           "然后重试。" % exc)
            return 2, {"ok": False, "removed": None, "elapsedMs":
                       int((time.perf_counter() - t0) * 1000)}
        reporter.human("已清理生成物目录：%s" % proj.scut_dir)
        removed = proj.scut_dir
    else:
        reporter.human("生成物目录本来就不存在，无需清理：%s" % proj.scut_dir)
        removed = None
    reporter.human("（code/、config.h、pic/ 等用户资产未做任何改动）")
    timer._record("clean", (time.perf_counter() - t0) * 1000)
    timer.report()
    return 0, {"ok": True, "removed": removed,
               "elapsedMs": int((time.perf_counter() - t0) * 1000)}


# ===========================================================================
# 入口
# ===========================================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="scut_build.py",
        description="SCUT-71 Vision Studio 构建编排（环境=静态库，用户代码=普通 .o）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python tools/scut_build.py --project .\n"
            "  python tools/scut_build.py --project . --jobs 8\n"
            "  python tools/scut_build.py doctor --project .\n"
            "  python tools/scut_build.py clean  --project .\n"
            "  python tools/scut_build.py --project . --json   # 给插件用\n"
        ),
    )
    p.add_argument("command", nargs="?", default="build",
                   choices=["build", "doctor", "clean"],
                   help="build（默认）/ doctor / clean")
    p.add_argument("--project", required=True,
                   help="工程目录（含 code/ 与 scut_project.json；老工程用 config.h 也支持）")
    p.add_argument("--toolchain", default="",
                   help="工具链根目录。省略时按 SCUT71_TOOLCHAIN 环境变量、PATH 探测；"
                         "都找不到时插件会问你要（每个人的安装位置不同，不靠猜）")
    p.add_argument("--no-watch", action="store_true",
                   help="关闭自动符号发现（构建更快，但 IDE 变量面板会是空的）")
    p.add_argument("--core-lib", default="",
                   help="预编译核心静态库路径。默认 <project>/.scut/lib/libscut_core.a")
    p.add_argument("--jobs", type=int, default=0,
                   help="并行编译任务数（默认 = CPU 核数，上限 %d）" % JOBS_MAX)
    p.add_argument("--exclude", default="",
                   help="逗号分隔的变量名黑名单：这些全局量不进变量面板"
                        "（透传给 scut_symbols.py）。适合排除体积大又不想看的缓冲。")
    p.add_argument("--max-elems", type=int, default=0, metavar="N",
                   help="只把元素数 <= N 的变量放进面板（0 = 不限制）。"
                        "透传给 scut_symbols.py，用于避开 22560 元素的大图数组。")
    p.add_argument("--json", action="store_true",
                   help="把机器可读结果输出到 stdout；"
                        "此时所有人类可读进度都走 stderr")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="打印每一条实际执行的命令行（排查构建问题时用）")
    # ★ --backend 目前【只有一个合法取值】，这是有意为之，不是漏填。
    #   它的作用是把"呈现后端是谁"这件事显式化：仓库里目前只有
    #   backends/headless/ 一个后端，但这一层是刻意留出的接口 ——
    #   将来加 GUI / 录制 / 别的宿主时，只需在这里补一个取值，
    #   构建路径（下面按 sdk_backend 定位源码）不用改。
    #   choices 限死一个值，是为了让"传了别的后端名"当场报错，
    #   而不是静默退回 headless。
    p.add_argument("--backend", default="headless",
                   choices=["headless"],
                   help="呈现后端（谁提供 main）。headless = 由插件驱动的"
                        "无窗口后端，帧经 stdout 协议交给 IDE（默认）。"
                        "目前只有这一个取值，这一层是为将来的其它后端预留的接口")
    return p


# 本脚本所在仓库根目录：<repo>/tools/scut_build.py → <repo>
SCUT_TOOL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYMBOLS_TOOL = os.path.join(SCUT_TOOL_ROOT, "tools", "scut_symbols.py")
# SDK 根目录：后端源码、核心头文件都相对它定位。
# ★ 与「工程目录」区分开：一个工程可以换不同的 SDK 版本，
#   所以这两个路径不能混为一谈（否则升级 SDK 就等于改工程）。
SDK_ROOT = SCUT_TOOL_ROOT

# 并行编译任务数上限。
#
# ★ 必须有上限，而且是【硬】上限：本环境面向的是学生机器，
#   而 --jobs 是用户可控的数字。没有上限时 `--jobs 9999` 会真的去
#   创建 9999 个线程、每个线程拉一个 clang 进程 —— 内存瞬间打满、
#   机器假死，而用户只看到"编译卡住了"。
#
# ★ 原先 --jobs 的 help 里写着"上限 16"，但那个 16 只作用在
#   【自动推导的默认值】上，用户显式传的值完全不受约束 ——
#   即"注释承诺了代码没做的事"。现在两边共用这一个常量。
#   16 的理由：一般学生机 8~16 个逻辑核，再多对编译（本身就是
#   CPU 密集）没有收益，只会互相抢内存。
JOBS_MAX = 16


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    if not args.jobs:
        cpu = os.cpu_count() or 2
        args.jobs = max(1, min(16, cpu))
    else:
        # ★ 夹取用户的显式值：负数/0 会在下面除零或起 0 个线程，
        #   超大值会拖垮机器。夹取而不是报错 —— 这是个"手滑"类输入，
        #   没必要让整次构建失败（与 --frames / --repeat 的取向一致）。
        args.jobs = max(1, min(JOBS_MAX, args.jobs))

    # --json 时：stdout 只放 JSON，人类可读输出全部走 stderr。
    reporter = Reporter(as_json=args.json, verbose=args.verbose)
    timer = StageTimer(reporter)

    try:
        if args.command == "doctor":
            code, payload = do_doctor(args, reporter, timer)
            payload["elapsedMs"] = int(timer.total_ms())
        elif args.command == "clean":
            code, payload = do_clean(args, reporter, timer)
        else:
            if not os.path.isfile(SYMBOLS_TOOL) and not args.no_watch:
                reporter.error(
                    "找不到自动符号发现脚本：%s\n"
                    "    原因：本脚本假定它与自己同处 <仓库>/tools/ 下。\n"
                    "    下一步：确认仓库结构完整；"
                    "或加 --no-watch 先跳过自动发现继续构建。"
                    % SYMBOLS_TOOL)
                code = 2
                payload = {"ok": False, "exePath": None, "output": "",
                           "elapsedMs": int(timer.total_ms()),
                           "errors": [{"file": None, "line": None,
                                       "column": None, "severity": "error",
                                       "message": "缺少 scut_symbols.py"}],
                           "manifest": None}
            else:
                code, payload = do_build(args, reporter, timer)
    except KeyboardInterrupt:
        reporter.error("已被用户中断（Ctrl+C）。\n"
                       "    影响：生成物目录 .scut 里可能留有半成品；"
                       "不过目标文件与可执行文件都是「先写临时文件再原子替换」，"
                       "不会出现损坏的 exe。\n"
                       "    下一步：直接重新构建即可。")
        return 130
    except Exception as exc:  # noqa: BLE001 - 顶层兜底，保证永远给人话
        import traceback
        reporter.error(
            "构建脚本内部出现未预期的错误：%s\n"
            "    这是一条脚本 bug，不是你的算法问题。\n"
            "    下一步：把下面的调用栈完整贴给我们。\n%s"
            % (exc, traceback.format_exc()))
        if args.json:
            reporter.emit_json({
                "ok": False, "exePath": None, "output": traceback.format_exc(),
                "elapsedMs": int(timer.total_ms()),
                "errors": [{"file": None, "line": None, "column": None,
                            "severity": "error",
                            "message": "构建脚本内部错误: %s" % exc}],
                "manifest": None,
            })
        return 3

    if args.json:
        reporter.emit_json(payload)
    return code


if __name__ == "__main__":
    sys.exit(main())
