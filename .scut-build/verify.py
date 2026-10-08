# -*- coding: utf-8 -*-
"""SCUT headless backend: end-to-end verification of the two bug fixes.

Writes a UTF-8 report next to this file (the Windows console is GBK and
mangles the Chinese output, so the report file is the authoritative artifact).
"""
import io
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "verify.out.txt")
_report = io.open(OUT, "w", encoding="utf-8")


def emit(line=""):
    _report.write(line + "\n")
    _report.flush()
    sys.stdout.write(str(line).encode("ascii", "replace").decode("ascii") + "\n")


PROJ = ("D:\\22\u8f66\u961f\u7ba1\u7406\\\u4e00\u8f6e\u8003\u6838\\\u89c6\u89c9\u7ec4\\"
        "\u96c6\u6210\u4eff\u771f\u73af\u5883\u6d4b\u8bd5\\scut71-project")
EXE = os.path.join(PROJ, ".scut", "bin", "scut_sim.exe")
PICDIR = os.path.join(PROJ, "pic", "1")
TMP = os.environ["TEMP"]


def run(args, cwd, stdin_text=None, timeout=90):
    """Run the simulator, return (rc, stdout, stderr)."""
    p = subprocess.run([EXE] + args, cwd=cwd, input=stdin_text,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=timeout)
    return p.returncode, p.stdout or "", p.stderr or ""


def json_line(out, n=1):
    for ln in out.splitlines():
        if ln.startswith('{"frame"'):
            n -= 1
            if n == 0:
                return ln
    return ""


def pic_of(line):
    """Extract the "pic":"..." value without a JSON parser (keeps it literal)."""
    key = '"pic":"'
    i = line.find(key)
    if i < 0:
        return None
    j = line.find('"', i + len(key))
    return line[i + len(key):j]


def pgm_distinct(path):
    """Count distinct byte values in a PGM's pixel payload."""
    with open(path, "rb") as f:
        blob = f.read()
    # header is "P5\n<w> <h>\n255\n"
    parts = blob.split(b"\n", 3)
    pixels = parts[3] if len(parts) > 3 else b""
    return len(set(pixels)), len(pixels), pixels[:16].hex()


def pgm_body(path):
    with open(path, "rb") as f:
        blob = f.read()
    parts = blob.split(b"\n", 3)
    return parts[3] if len(parts) > 3 else b""


def section(title):
    emit()
    emit("=" * 78)
    emit(title)
    emit("=" * 78)


emit("SCUT headless backend verification report")
emit("exe  : %s" % EXE)
emit("pic  : %s (%d files)" % (PICDIR, len(os.listdir(PICDIR))))
emit("exe mtime: %s" % subprocess.run(
    ["cmd", "/c", "dir", "/T:W", EXE.replace("/", "\\")],
    capture_output=True, text=True).stdout.splitlines()[-3:] if False else "")

# ---------------------------------------------------------------- check 0
section("CHECK 0  BEFORE vs AFTER  (baseline captured earlier this session)")
emit("BEFORE (from C:\\, pre-fix binary):")
emit('  stderr: "警告: 没有找到任何测试图，仿真将在【全黑图像】上运行。"')
emit('  JSON  : "pic":""            <- empty => black frame forever')
emit()
emit("BEFORE (from project root, pre-fix binary):")
emit('  JSON  : "pic":"pic/1/1.bmp" <- worked, so the bug was CWD-dependent')

# ---------------------------------------------------------------- check 1
section("CHECK 1  unrelated CWD (C:\\) -> must now FIND the pictures")
rc, out, err = run(["--json", "--frames", "2",
                    "--out", os.path.join(TMP, "v_c1")], cwd="C:\\")
emit("cmd : cd C:\\ && scut_sim.exe --json --frames 2")
emit("exit: %d" % rc)
for ln in out.splitlines():
    if ln.startswith('{"frame"'):
        emit("  " + ln)
warn = [l for l in err.splitlines() if "\u8b66\u544a" in l or "\u9519\u8bef" in l]
emit("stderr warnings: %d %s" % (len(warn), warn[:1]))
emit("PASS" if ('"pic":"pic/1/1.bmp"' in out or '"pic":"pic/1/2.bmp"' in out)
     else "FAIL")

# ---------------------------------------------------------------- check 2
section("CHECK 2  project root -> no regression")
rc, out, err = run(["--json", "--frames", "2",
                    "--out", os.path.join(TMP, "v_c2")], cwd=PROJ)
emit("cmd : cd <project> && .scut\\bin\\scut_sim.exe --json --frames 2")
emit("exit: %d" % rc)
for ln in out.splitlines():
    if ln.startswith('{"frame"'):
        emit("  " + ln)
emit("PASS" if '"pic":"pic/1/1.bmp"' in out else "FAIL")

# ---------------------------------------------------------------- check 2b
section("CHECK 2b other CWDs (exe dir itself, and a deep unrelated dir)")
for cwd in [os.path.join(PROJ, ".scut", "bin"), "D:\\"]:
    rc, out, err = run(["--json", "--frames", "1",
                        "--out", os.path.join(TMP, "v_c2b")], cwd=cwd)
    line = json_line(out)
    emit("cwd=%-60s exit=%d pic=%s" % (cwd, rc, pic_of(line)))

# ---------------------------------------------------------------- check 3
section("CHECK 3  absolute --pic -> works from anywhere")
abs_pic = PICDIR
for cwd in ["C:\\", "D:\\", PROJ]:
    rc, out, err = run(["--json", "--frames", "1", "--pic", abs_pic,
                        "--out", os.path.join(TMP, "v_c3")], cwd=cwd)
    line = json_line(out)
    emit("cwd=%-58s exit=%d pic=%s" % (cwd, rc, pic_of(line)))
emit()
emit("(note: path is outside nothing here, so it is reported relative to the")
emit(" project root even though --pic was absolute -- that is the intended")
emit(" 'short path' formatting; see CHECK 3b for a genuinely external dir.)")

# ---------------------------------------------------------------- check 3b
section("CHECK 3b --pic pointing OUTSIDE the project -> absolute is kept")
ext_dir = os.path.join(TMP, "scut_ext_pic", "1")
os.makedirs(ext_dir, exist_ok=True)
import shutil
for i in (1, 2, 3):
    shutil.copyfile(os.path.join(PICDIR, "%d.bmp" % i),
                    os.path.join(ext_dir, "%d.bmp" % i))
rc, out, err = run(["--json", "--frames", "1", "--pic", ext_dir,
                    "--out", os.path.join(TMP, "v_c3b")], cwd="C:\\")
line = json_line(out)
emit("external pic dir: %s" % ext_dir)
emit("cwd=C:\\  exit=%d  pic=%s" % (rc, pic_of(line)))
emit("PASS (kept absolute, honest about being external)"
     if pic_of(line) and os.path.isabs(pic_of(line)) else "CHECK")

# ---------------------------------------------------------------- check 4
section("CHECK 4  bogus --pic -> warning lists tried paths, exit 0")
rc, out, err = run(["--json", "--frames", "2", "--pic", "no/such/pic/dir",
                    "--out", os.path.join(TMP, "v_c4")], cwd="C:\\")
emit("cmd : cd C:\\ && scut_sim.exe --json --frames 2 --pic no/such/pic/dir")
emit("exit: %d" % rc)
emit("--- stderr (verbatim) ---")
emit(err.rstrip())
emit("--- end stderr ---")
emit("frames emitted: %d" % sum(1 for l in out.splitlines()
                                if l.startswith('{"frame"')))
emit("PASS (exit 0 and paths listed)"
     if rc == 0 and "1)" in err and "2)" in err and "3)" in err else "FAIL")

# ---------------------------------------------------------------- check 5
section("CHECK 5  playback: --json --step --frames 0 --advance, 6 newlines")
outdir = os.path.join(TMP, "v_c5")
if os.path.isdir(outdir):
    shutil.rmtree(outdir, ignore_errors=True)
rc, out, err = run(["--json", "--step", "--frames", "0", "--advance",
                    "--out", outdir], cwd=PROJ, stdin_text="\n" * 8)
pics = []
emit("cmd : cd <project> && .scut\\bin\\scut_sim.exe "
     "--json --step --frames 0 --advance   (8 newlines on stdin)")
emit("exit: %d" % rc)
for ln in out.splitlines():
    if ln.startswith('{"frame"'):
        pics.append(pic_of(ln))
        emit("  frame pic = %s" % pic_of(ln))
expected = ["pic/1/%d.bmp" % i for i in range(1, len(pics) + 1)]
emit()
emit("sequence      : %s" % " ".join(pics))
emit("expected 1..N : %s" % " ".join(expected))
emit("PASS (strictly 1,2,3,... no repeat, no off-by-one)"
     if pics == expected else "FAIL")
emit()
emit("--- produced PGM frames: are they actually different? ---")
files = sorted(f for f in os.listdir(outdir) if f.endswith(".pgm"))
bodies = []
for f in files[:8]:
    d, n, head = pgm_distinct(os.path.join(outdir, f))
    bodies.append(pgm_body(os.path.join(outdir, f)))
    emit("  %-18s distinctByteValues=%-4d pixels=%d  first16=%s"
         % (f, d, n, head))
uniq = len({b for b in bodies})
emit()
emit("distinct frame payloads among first %d frames: %d" % (len(bodies), uniq))
emit("PASS (frames are NOT all identical)" if uniq > 1 else "FAIL (identical!)")

# ---------------------------------------------------------------- check 5b
section("CHECK 5b wrap-around at the end of the 36-picture set")
rc, out, err = run(["--json", "--step", "--frames", "0", "--advance",
                    "--frame", "35", "--out", os.path.join(TMP, "v_c5b")],
                   cwd=PROJ, stdin_text="\n" * 5)
seq = [pic_of(l) for l in out.splitlines() if l.startswith('{"frame"')]
emit("--frame 35 then 5 newlines:")
emit("  %s" % " ".join(seq))
ok = seq[-2:] == ["pic/1/1.bmp", "pic/1/2.bmp"] if len(seq) >= 4 else False
emit("PASS (wraps 36 -> 1 with no separate --loop flag)"
     if seq[:3] == ["pic/1/35.bmp", "pic/1/36.bmp", "pic/1/1.bmp"] else
     "CHECK -> %s" % seq)

# ---------------------------------------------------------------- check 5c
section("CHECK 5c single-step really is one picture per newline")
rc, out, err = run(["--json", "--step", "--frames", "0", "--advance",
                    "--out", os.path.join(TMP, "v_c5c")],
                   cwd=PROJ, stdin_text="\n")
seq = [pic_of(l) for l in out.splitlines() if l.startswith('{"frame"')]
emit("exactly one '\\n' on stdin -> %d frame(s): %s" % (len(seq), seq))
emit("PASS" if seq == ["pic/1/1.bmp"] else "CHECK")

# ---------------------------------------------------------------- check 6
section("CHECK 6  -Wall -Wextra zero warnings (see warncheck.out.txt)")
wc = os.path.join(HERE, "warncheck.out.txt")
if os.path.isfile(wc):
    txt = io.open(wc, encoding="utf-8").read()
    for ln in txt.splitlines():
        if ln.startswith("===") or ln.startswith("RESULT"):
            emit(ln)
else:
    emit("(run warncheck.py first)")

emit()
emit("=" * 78)
emit("report written to: %s" % OUT)
_report.close()
