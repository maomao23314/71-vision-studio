# -*- coding: utf-8 -*-
"""Focused probes: absolute --pic, relative-path formatting, step/EOF timing."""
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "probe.out.txt")
R = io.open(OUT, "w", encoding="utf-8")


def emit(s=""):
    R.write(str(s) + "\n")
    R.flush()
    sys.stdout.write(str(s).encode("ascii", "replace").decode("ascii") + "\n")


PROJ = ("D:\\22\u8f66\u961f\u7ba1\u7406\\\u4e00\u8f6e\u8003\u6838\\\u89c6\u89c9\u7ec4\\"
        "\u96c6\u6210\u4eff\u771f\u73af\u5883\u6d4b\u8bd5\\scut71-project")
EXE = os.path.join(PROJ, ".scut", "bin", "scut_sim.exe")
PICDIR = os.path.join(PROJ, "pic", "1")
TMP = os.environ["TEMP"]


def run(args, cwd, stdin_text=None):
    p = subprocess.run([EXE] + args, cwd=cwd, input=stdin_text,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=90)
    return p.returncode, p.stdout or "", p.stderr or ""


def frames(out):
    import re
    return re.findall(r'\{"frame":.*', out)


def pic(line):
    import re
    m = re.search(r'"pic":"((?:[^"\\]|\\.)*)"', line)
    return m.group(1) if m else None


emit("=" * 74)
emit("PROBE A  absolute --pic from several CWDs (args passed via argv, not shell)")
emit("=" * 74)
emit("PICDIR = %s" % PICDIR)
for cwd in ["C:\\", "D:\\", PROJ, os.path.join(PROJ, ".scut", "bin")]:
    rc, out, err = run(["--json", "--frames", "1", "--pic", PICDIR,
                        "--out", os.path.join(TMP, "p_a")], cwd=cwd)
    fl = frames(out)
    emit("  cwd=%-62s rc=%d" % (cwd, rc))
    emit("        pic = %s" % (pic(fl[0]) if fl else "(no frame line)"))

emit()
emit("=" * 74)
emit("PROBE A2  absolute --pic TO A DIFFERENT absolute path spelling")
emit("        (forward slashes + trailing slash, from C:\\)")
emit("=" * 74)
alt = PICDIR.replace("\\", "/") + "\\"
rc, out, err = run(["--json", "--frames", "1", "--pic", alt,
                    "--out", os.path.join(TMP, "p_a2")], cwd="C:\\")
fl = frames(out)
emit("  --pic %s" % alt)
emit("  rc=%d  pic = %s" % (rc, pic(fl[0]) if fl else "(none)"))
emit("  stderr first line: %s" % (err.splitlines()[0] if err.strip() else "(none)"))

emit()
emit("=" * 74)
emit("PROBE B  relative-path formatting: where does the boundary fall?")
emit("=" * 74)
rc, out, err = run(["--json", "--frames", "1",
                    "--out", os.path.join(TMP, "p_b")], cwd="C:\\")
fl = frames(out)
p = pic(fl[0]) if fl else ""
emit("  pic (default --pic, cwd=C:\\) = %s" % p)
emit("  is_absolute (starts with drive colon) = %s" % (len(p) > 1 and p[1] == ":"))
emit("  ends with = %s" % p[-14:])

emit()
emit("=" * 74)
emit("PROBE C  step/EOF semantics: how many frames per N newlines?")
emit("=" * 74)
for n in (1, 2, 3):
    rc, out, err = run(["--json", "--step", "--frames", "0", "--advance",
                        "--out", os.path.join(TMP, "p_c")],
                       cwd=PROJ, stdin_text="\n" * n)
    fl = frames(out)
    emit("  %d newline(s) -> %d frame(s): %s"
         % (n, len(fl), [pic(f).split("/")[-1] for f in fl]))

emit()
emit("=" * 74)
emit("PROBE D  NO --step, --frames 0 (stdin not connected): runaway?")
emit("=" * 74)
rc, out, err = run(["--json", "--frames", "0", "--advance",
                    "--out", os.path.join(TMP, "p_d")], cwd=PROJ,
                   stdin_text="")
fl = frames(out)
emit("  empty stdin -> %d frame(s), rc=%d" % (len(fl), rc))
emit("  (bounded => no hang)")

emit()
emit("=" * 74)
emit("PROBE E  --list-vars (uses cwd=dirname(exe) in the extension)")
emit("=" * 74)
rc, out, err = run(["--json", "--frames", "1", "--list-vars",
                    "--out", os.path.join(TMP, "p_e")],
                   cwd=os.path.join(PROJ, ".scut", "bin"))
emit("  cwd = <project>/.scut/bin   rc=%d" % rc)
emit("  vars json present: %s" % ('"vars"' in out))
emit("  stderr warning present: %s" % ("\u8b66\u544a" in err))

R.close()
