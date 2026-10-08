# -*- coding: utf-8 -*-
"""SCUT headless backend: -Wall -Wextra zero-warning check on gcc + clang.

Chinese paths in this file are written as escape sequences so the script is
robust regardless of how it is copied around (the harness console mangles
non-ASCII literals passed through -Command).
"""
import io
import os
import subprocess
import sys

# The Windows console here is a GBK codepage, so any compiler message that
# contains a non-GBK byte blows up print(). Write everything to a UTF-8 file
# and echo an ASCII-only summary to stdout instead.
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "warncheck.out.txt")
_report = io.open(OUT, "w", encoding="utf-8")


def emit(line=""):
    _report.write(line + "\n")
    _report.flush()
    sys.stdout.write(line.encode("ascii", "replace").decode("ascii") + "\n")

STUDIO = "D:\\22\u8f66\u961f\u7ba1\u7406\\\u4e00\u8f6e\u8003\u6838\\\u89c6\u89c9\u7ec4\\SCUT-71-vision-studio"
PROJ = ("D:\\22\u8f66\u961f\u7ba1\u7406\\\u4e00\u8f6e\u8003\u6838\\\u89c6\u89c9\u7ec4\\"
        "\u96c6\u6210\u4eff\u771f\u73af\u5883\u6d4b\u8bd5\\scut71-project")

SRC = os.path.join(STUDIO, "backends", "headless", "scut_headless_main.c")

INCLUDES = [
    os.path.join(STUDIO, "core", "include"),
    os.path.join(STUDIO, "core", "src"),
    PROJ,
    os.path.join(PROJ, ".scut", "gen"),
    os.path.join(PROJ, "code"),
]

CCS = [
    ("gcc", "gcc"),
    ("clang", "D:\\TOOLS\\llvm-mingw\\bin\\clang.exe"),
]
MODES = [("-O2", "-DNDEBUG"), ("-g", "-O0")]

emit("source exists: %s" % os.path.isfile(SRC))
emit("source path  : %s" % SRC)
emit("source bytes : %d" % os.path.getsize(SRC))
emit()

fail = 0
for cname, cc in CCS:
    for mode in MODES:
        argv = [cc, "-std=c11", "-Wall", "-Wextra"] + list(mode)
        argv += ["-I" + d for d in INCLUDES]
        obj = os.path.join(os.environ["TEMP"], "wcheck_%s_%s.o" % (cname, mode[0].strip("-")))
        argv += ["-c", SRC, "-o", obj]
        p = subprocess.run(argv, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        blob = (p.stdout or "") + (p.stderr or "")
        warn = [ln for ln in blob.splitlines()
                if "warning:" in ln or "error:" in ln or "note:" in ln]
        emit("=== %s %s === exit=%d  diagnostics=%d" %
             (cname, " ".join(mode), p.returncode, len(warn)))
        emit("    cmd: %s" % " ".join('"%s"' % a if " " in a else a for a in argv))
        for ln in warn:
            emit("    " + ln)
        if not warn and not blob.strip():
            emit("    (no compiler output at all)")
        emit()
        if p.returncode != 0 or warn:
            fail = 1

emit("RESULT: %s" % ("FAIL" if fail else
                     "PASS (zero warnings, gcc + clang, -O2 and -O0)"))
_report.close()
sys.exit(fail)
