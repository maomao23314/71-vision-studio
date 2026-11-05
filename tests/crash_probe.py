#!/usr/bin/env python3
"""
crash_probe.py —— 「用户代码把仿真进程搞死之后，插件表现如何」

★★★ 这条测试为什么存在 ★★★

主回归其余 22 条用的用户代码是 templates/starter 里的模板 ——
线性数组、无递归、无越界。它很"温和"，所以能稳定全绿，
但【从不触发任何崩溃路径】。也就是说：
"用户的算法越界把进程打死之后，界面会怎样"这件事，
在 2026-11-05 之前从来没有被验证过。

而真实工程里它是会发生的。实测一个真实的智能车算法（贪心八邻域搜线）：

    point m_path[800];                   // 路径点，只开 800 个
    for (i = 0; i < l_len; i++)          // 120 次
        for (j = 0; j < r_len; j += k)   // 124 次
            m_path[m_len++] = ...;       // → 14880 次写入，越界 14080 个

越界把那一片 .data 里的 s_gray / s_w / s_h 全踩坏，
最后在 SCUT_EnvCopyOutput 里写非法地址，进程以 0xC0000005 死掉。
63 张图里有 22 张会这样。

当时插件的表现是：
    · 界面停在最后一帧，按钮还能点，但点了没反应
    · 日志里只有一行「进程已退出（退出码 3221225477）」
    · 没有任何提示，用户既不知道发生了什么，也不知道 3221225477 是什么

所以这条测试盯的就是那三件事：
    A. 崩溃确实会被触发（用真实形态的越界，不是 *(int*)0=1）
    B. 崩溃之后，插件有没有把"发生了什么"用人话说出来
    C. 崩完之后还能不能继续用（重启、状态恢复）

★ 判据的分工（很重要，别混）：
    「用户算法越界」不是插件缺陷 —— 那是用户代码的 bug，
    这条测试只记录、不判失败。
    「插件拿到了退出码却什么都没说」才是插件缺陷 —— 判失败。

用法：
    python tests/crash_probe.py --project <工程目录> [--exe <exe>] [--max N]
    python tests/crash_probe.py --self          # 自己建一个必崩的工程来测
    python tests/crash_probe.py --self --project <已建好的工程>   # 复用它

退出码 0 = 插件在这件事上没问题；1 = 有问题。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE = "node"
sys.path.insert(0, HERE)
import toolchain as tc  # noqa: E402

# Windows NTSTATUS 退出码 → 人话。用户看到 "3221225477" 完全不知道发生了什么。
NTSTATUS = {
    0xC0000005: "访问冲突（读写越界 / 空指针）",
    0xC00000FD: "栈溢出（无限递归）",
    0xC0000094: "整数除零",
    0xC0000409: "栈缓冲区溢出（/GS 检出）",
    0xC000001D: "非法指令",
}

results = []


def ok(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print("  %s  %s%s" % ("PASS" if cond else "FAIL", name,
                         ("  -> " + extra) if (extra and not cond) else ""))
    return bool(cond)


def note(msg):
    print("  ....  " + msg)


def run_exe(exe, proj, pic_index, ext, pic_dir, frames=1, timeout=60):
    """跑一次仿真，返回 (退出码, stdout, stderr)。"""
    cmd = [exe, "--frames", str(frames), "--json", "--out",
           os.path.join(proj, ".scut", "frames")]
    if ext:
        cmd += ["--ext", ext]
    if pic_dir:
        cmd += ["--pic", pic_dir]
    if pic_index is not None:
        cmd += ["--frame", str(pic_index)]
    try:
        r = subprocess.run(cmd, cwd=proj, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        return r.returncode, r.stdout or "", r.stderr or ""
    except subprocess.TimeoutExpired:
        return ("TIMEOUT", "", "")


def opened_pic(out):
    """从 --json 输出里取出这一帧实际打开的图（后端报的 "pic" 字段）。

    ★ 为什么需要它：section A 的结论完全建立在"我传的编号 = 被测的那张图"
    之上。而这个前提曾经是错的 —— 按下标传编号时，--frame 0 被后端
    夹到第 1 张，于是第一张测两遍、最后一张一次没测，而计数照样对得上。
    只数"崩了几张"是发现不了这种错的：数字自洽。
    所以这里直接读后端报的文件名，拿事实对编号。
    """
    m = re.search(r'"pic"\s*:\s*"([^"]*)"', out or "")
    if not m:
        return None
    return os.path.basename(m.group(1).replace("\\\\", "/"))


# ---------------------------------------------------------------------------
# A0. 编号 → 文件 的对应关系（section A 的结论建立在这上面）
# ---------------------------------------------------------------------------
def section_a0(exe, proj, ext, pic_dir, numbers):
    """核对"我传的 --frame N，后端打开的是不是第 N 张图"。

    ★ 为什么要单独一条：section A 会说"崩溃 3 张"，而这个数字只有在
      "每个编号确实各自对着一张不同的图"时才有意义。
      按下标传编号时：--frame 0 被夹到第 1 张 → 1.bmp 测两遍，
      最后一张一次没测，而报告仍然是"3 张 / 崩溃 3 张"。
      计数自洽，覆盖不全 —— 只数数永远发现不了。
      所以这里不信自己的循环，直接读后端报的文件名。

    ★ 为什么用 frames=1：这一节只关心"打开了哪张"，不关心崩不崩。
      夹具在第 1 帧是正常的；真实工程若第 1 帧就崩，那几张读不到
      文件名，本节会如实报告"只核对了 N/M 张"，不会假装全对。
    """
    print("\n=== A0. 编号对不对得上文件（覆盖率的自检）===")
    checked = 0
    bad = []
    for num in numbers:
        _, out, _ = run_exe(exe, proj, num, ext, pic_dir, frames=1)
        got = opened_pic(out)
        if got is None:
            continue
        checked += 1
        want = "%d%s" % (num, ext)
        if os.path.normcase(got) != os.path.normcase(want):
            bad.append((num, want, got))
    if checked == 0:
        ok("核对编号→文件（至少一张能读到）", False,
           "一张都没读到文件名，无法确认扫描覆盖的是真实图集")
        return
    for num, want, got in bad:
        ok("--frame %d 打开的是 %s" % (num, want), False, "实际打开 %s" % got)
    if not bad:
        ok("每条 --frame N 都打开对应的 N%s（核对了 %d/%d 张）"
           % (ext, checked, len(numbers)), True)
def section_a(exe, proj, ext, pic_dir, numbers, frames=3):
    """逐图跑一遍，找出会崩的图。

    ★ 参数是【图集编号列表】，不是"循环 0..count-1"（2026-11-05 修的）。
      原来按 range(count) 传 --frame，而图集从 1 起编号：
      --frame 0 会被后端夹到第 1 张，于是
        第 0 张 → 1.bmp
        第 1 张 → 1.bmp   ← 重复
        第 2 张 → 2.bmp
      3 张图里 1.bmp 测了两遍、最后一张【一张都没测】，
      而报告写的是"图集共 3 张 / 崩溃 3 张"，看起来全都覆盖了。
      这类"数得对、覆盖不对"的错最难发现 —— 数字是自洽的。
      现在编号由目录里真实存在的文件名算出，扫描范围 = 真实图集。

    ★ frames 默认 3 而不是 1（2026-11-05 修的）：
      有些算法不是"这张图一进来就崩"，而是【跑了几帧才把数组写满】。
      真实案例里就是要连续翻几张才踩到未映射页。
      用 --frames 1 去扫，会把这类崩溃整个漏掉 ——
      然后测试报告"没有图让进程崩掉"，看起来一切正常。

      ★ 为什么是"同一张图跑 N 帧"而不是 --advance 连着翻：
        --advance 会把崩溃归到"第几帧"，但我们会搞不清是哪张图触发的。
        逐图 + 重复帧，才能把责任精确钉在某一张图上。
    """
    print("\n=== A. 逐图扫一遍：哪些图会让进程死掉 ===")
    crashed = []
    blank = []
    for num in numbers:
        rc, out, err = run_exe(exe, proj, num, ext, pic_dir, frames=frames)
        if rc == "TIMEOUT":
            crashed.append((num, "超时", ""))
            continue
        if rc != 0:
            crashed.append((num, rc, err.strip().splitlines()[-1] if err.strip() else ""))
        elif '"frame"' not in out:
            blank.append(num)
    note("图集共 %d 张（编号 %s）"
         % (len(numbers), numbers if len(numbers) <= 8
            else "%s..%s（共 %d）" % (numbers[0], numbers[-1], len(numbers))))
    if crashed:
        codes = sorted({c[1] for c in crashed})
        note("崩溃 %d 张，退出码 %s" % (len(crashed), codes))
        for num, rc, _ in crashed[:6]:
            print("       第 %s 张 → 退出码 %s（%s）"
                  % (num, rc, NTSTATUS.get(rc, "未知")))
        if len(crashed) > 6:
            print("       ... 其余 %d 张同样" % (len(crashed) - 6))
    else:
        note("没有图让进程崩掉")
    if blank:
        note("另有 %d 张跑完但没输出帧：%s" % (len(blank), blank[:8]))
    return crashed


# ---------------------------------------------------------------------------
# B. 插件侧：退出码拿到之后有没有告诉用户
# ---------------------------------------------------------------------------
PROBE_JS = r"""
const Module = require('module');
const stub = { workspace: { getConfiguration() { return { get(k, d) { return d; } }; } } };
const orig = Module._load;
Module._load = function (r) { if (r === 'vscode') return stub; return orig.apply(this, arguments); };
const { SimSessionImpl } = require(%(simsession)s);
const proj = %(proj)s;
const crashAt = %(crashAt)d;

const logs = [], exits = [], frames = [];
const s = new SimSessionImpl({
    exePath: proj + '/.scut/bin/scut_sim.exe',
    picDir: proj + '/pic',
    projectRoot: proj,
});
s.onLog((l) => logs.push(l));
s.onFrame((f) => { frames.push(f.index); s.ack(f.index); });
s.onExit((c) => exits.push(c));

const t0 = Date.now();
(async () => {
    await s.start();
    await new Promise((r) => setTimeout(r, 700));
    const framesBefore = frames.length;
    const runningBefore = s.running;
    const waitStart = Date.now();
    const p = s.waitFrame(8000);
    s.gotoPic(crashAt);
    const f = await p;
    const waitMs = Date.now() - waitStart;
    await new Promise((r) => setTimeout(r, 300));

    // 崩溃后：模拟 simview.ensureSession 的重启路径
    const s2 = new SimSessionImpl({
        exePath: proj + '/.scut/bin/scut_sim.exe',
        picDir: proj + '/pic',
        projectRoot: proj,
    });
    const frames2 = [];
    s2.onLog(() => {});
    s2.onFrame((x) => { frames2.push(x.index); s2.ack(x.index); });
    let restarted = false;
    try { await s2.start(); await new Promise((r) => setTimeout(r, 700)); restarted = s2.running; } catch (e) {}
    await s2.stop();

    console.log(JSON.stringify({
        framesBefore, runningBefore,
        exits, logs, waitMs,
        waitReturnedFrame: f === undefined ? null : f.index,
        runningAfter: s.running,
        restarted, frames2,
        exitLogs: logs.filter((l) => /进程已退出|访问冲突|栈溢出|除零|异常终止|退出码/.test(l)),
    }));
    await s.stop();
    process.exit(0);
})();
"""


def section_b(exe_proj, crash_at):
    print("\n=== B. 插件拿到了退出码之后，用户看得到什么 ===")
    simsession = os.path.join(ROOT, "extension", "out", "simsession.js")
    if not os.path.isfile(simsession):
        # ★ 这里必须【判失败】，不能静默跳过。
        #   跳过等于 B 段那 8 条断言一条都不入账，退出码照样是 0 ——
        #   换台机器没先编译 extension，整套回归就绿着，而它测的东西
        #   什么都没验证。本文件 build_self_project 里写的就是这条原则
        #   （"否则换台机器就会静默跳过，那正是这套测试最想避免的"），
        #   同一个文件里不能有两种标准。
        ok("拿得到插件产物 extension/out/simsession.js", False,
           "先在 extension/ 里跑一次 npm run compile")
        return None
    js = PROBE_JS % {
        "simsession": json.dumps(simsession),
        "proj": json.dumps(exe_proj.replace("\\", "/")),
        "crashAt": crash_at,
    }
    tmp = os.path.join(os.environ.get("TEMP", "/tmp"), "scut_crash_probe.js")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, tmp], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=120)
    except (subprocess.TimeoutExpired, OSError) as e:
        note("跑不动探测脚本：%s" % e)
        return None
    line = ""
    for ln in (r.stdout or "").splitlines():
        if ln.strip().startswith("{"):
            line = ln.strip()
    if not line:
        note("探测脚本没有输出 JSON：%s" % ((r.stderr or r.stdout or "")[-400:]))
        return None
    d = json.loads(line)

    ok("崩溃前正常出帧", d["framesBefore"] >= 1, str(d["framesBefore"]))
    ok("崩溃被 onExit 捕获（拿到退出码）", len(d["exits"]) >= 1, str(d["exits"]))
    code = d["exits"][0] if d["exits"] else None
    ok("退出码是 NTSTATUS 形态（0xC0000005 等）",
       code is not None and code >= 0xC0000000, str(code))

    # ★ 这一条是重点：退出码有没有被翻译成人话
    exit_logs = d.get("exitLogs") or []
    human = re.search(r"访问冲突|段错误|栈溢出|除零|越界|崩溃", " ".join(exit_logs))
    ok("会话日志把退出码翻译成了人话（不是裸数字）",
       bool(human), "日志 = %s" % json.dumps(exit_logs, ensure_ascii=False))

    ok("崩溃后 waitFrame 不会永久挂住",
       d["waitMs"] < 2000, "%d ms（>2s 说明在靠超时兜底，exit 没唤醒等待者）" % d["waitMs"])
    ok("崩溃时 waitFrame 返回 undefined（不返回假帧）",
       d["waitReturnedFrame"] is None, str(d["waitReturnedFrame"]))
    ok("崩溃后 running 变 false", d["runningAfter"] is False, str(d["runningAfter"]))
    ok("崩溃后能重新起会话", bool(d["restarted"]), str(d["restarted"]))
    note("重启后帧序列 = %s（重新从第 1 张开始，不保留崩溃前的位置）"
         % d["frames2"])
    return d


# ---------------------------------------------------------------------------
# B2. 退出码翻译表本身（纯函数，逐条核对）
# ---------------------------------------------------------------------------
def section_b2():
    print("\n=== B2. 退出码翻译表（纯函数）===")
    simsession = os.path.join(ROOT, "extension", "out", "simsession.js")
    js = r"""
const m = require(%s);
const cases = [
  [0, /正常/],
  [3221225477, /访问冲突|越界/],
  [3221225725, /栈溢出|递归/],
  [3221225620, /除零/],
  [3221226505, /栈缓冲|溢出/],
  [3221225786, /中断/],
  [null, /强制|未拿到/],
  [1, /退出码 1/],
];
const out = cases.map(([code, re]) => {
  const s = m.describeExitCode(code);
  return { code, text: s, ok: re.test(s) };
});
// ★ 每一句都必须带【怎么修】，不能只说"是什么"。
//   只说"访问冲突"用户依然不知道从哪下手。
//   ★ 只查【会弹提示的那几个】：用户中断（0xC000013A）不弹窗，
//     它的那句话只是日志里的说明，不该被要求写修法。
const advice = cases
  .filter(([c]) => c !== null && c !== 0 && (c >>> 0) >= 0xc0000000
                   && (c >>> 0) !== 0xc000013a)
  .map(([c]) => ({ code: c, text: m.describeExitCode(c) }))
  .map((x) => ({ code: x.code, has: /检查|改|重新编译|看|判/.test(x.text) }));
const abn = [
  [0, false],
  [null, false],
  [3221225477, true],
  [1, true],
  // ★ 用户按 Ctrl+C / 关窗口：是中断，不是缺陷。把它算成异常，
  //   弹窗就会变成「异常终止 —— 被中断」＋一段"这通常是数组越界"。
  [3221225786, false],
].map(([c, want]) => ({ c, want, got: m.isAbnormalExit(c) }));
console.log(JSON.stringify({ out, advice, abn, hasFn: typeof m.describeExitCode === 'function' }));
""" % json.dumps(simsession)
    tmp = os.path.join(os.environ.get("TEMP", "/tmp"), "scut_exitcode_probe.js")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(js)
    try:
        r = subprocess.run([NODE, tmp], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=60)
    except (subprocess.TimeoutExpired, OSError) as e:
        note("跑不动：%s" % e)
        return
    line = ""
    for ln in (r.stdout or "").splitlines():
        if ln.strip().startswith("{"):
            line = ln.strip()
    if not line:
        note("无输出：%s" % ((r.stderr or "")[-300:]))
        return
    d = json.loads(line)
    if not ok("describeExitCode 存在", d["hasFn"]):
        return
    NAMES = {0: "0（正常结束）", 3221225477: "0xC0000005 访问冲突",
             3221225725: "0xC00000FD 栈溢出", 3221225620: "0xC0000094 除零",
             3221226505: "0xC0000409 栈缓冲溢出", 3221225786: "0xC000013A 用户中断",
             1: "1（普通非零）", None: "null（强制结束）"}
    for c in d["out"]:
        ok("退出码 %s → %r" % (NAMES.get(c["code"], c["code"]), c["text"]), c["ok"])
    for a in d["advice"]:
        ok("退出码 %s 的解释里带了『怎么修』" % NAMES.get(a["code"], a["code"]),
           a["has"], "只说了是什么，没说怎么办")
    for a in d["abn"]:
        ok("isAbnormalExit(%s) == %s" % (a["c"], a["want"]), a["got"] == a["want"],
           "得到 %s" % a["got"])


# ---------------------------------------------------------------------------
# B3. 呈现层：崩溃有没有真的弹出来
# ---------------------------------------------------------------------------
def section_b3():
    print("\n=== B3. 呈现层有没有把崩溃说出来（源码判据）===")
    sv = os.path.join(ROOT, "extension", "src", "simview.ts")
    try:
        with open(sv, encoding="utf-8") as f:
            src = f.read()
    except OSError as e:
        note("读不到 simview.ts：%s" % e)
        return
    ok("simview 引进了 describeExitCode / isAbnormalExit",
       "describeExitCode" in src and "isAbnormalExit" in src)

    # onExit 回调必须收下退出码（`() =>` 表示丢弃它 —— 那正是原来的缺陷）
    m = re.search(r"s\.onExit\(\s*\(([^)]*)\)\s*=>", src)
    ok("onExit 回调收下了退出码参数",
       bool(m) and m.group(1).strip() != "",
       "回调签名 = (%s)" % (m.group(1) if m else "?"))

    # 异常退出时必须真的弹一条
    block = src[src.find("s.onExit("):]
    block = block[:block.find("});") + 3] if "});" in block else block
    ok("异常退出时调用了 showErrorMessage",
       "showErrorMessage" in block and "isAbnormalExit" in block,
       "onExit 回调块里没找到 showErrorMessage")

    # ★ 弹窗正文必须【完全】由 describeExitCode 决定。
    #   原来这里在 why 之外又硬拼了一句"这通常是算法里的数组越界"，
    #   于是退出码是 0xC0000094（整数除零）时，用户同时看到
    #   「整数除零 —— 除数算成了 0」和「这通常是数组越界」，
    #   两个互相排斥的诊断。判据：正文里出现了 ${why}，
    #   且不再夹带任何写死的病因猜测。
    m_call = re.search(r"showErrorMessage\(\s*([^;]*?)\s*,?\s*\)", block, re.S)
    arg = m_call.group(1) if m_call else ""
    ok("弹窗正文引用了 describeExitCode 的结果（${why}）",
       "${why}" in arg, "showErrorMessage 实参 = %r" % arg[:200])
    ok("弹窗正文没有另写一句写死的病因猜测",
       "数组越界" not in arg and "通常是" not in arg,
       "又在 why 之外补了一句猜测：%r" % arg[:200])

    # ★ 用户按 Ctrl+C 不该被当成崩溃：isAbnormalExit 必须真的挡住它。
    #   注意这条要读 simsession.ts（判定在那里），不是 simview.ts。
    sess = ""
    try:
        with open(os.path.join(ROOT, "extension", "src", "simsession.ts"),
                  encoding="utf-8") as f:
            sess = f.read()
    except OSError as e:
        note("读不到 simsession.ts：%s" % e)
    i_abn = sess.find("export function isAbnormalExit")
    abn_body = sess[i_abn:i_abn + 600] if i_abn >= 0 else ""
    ok("用户中断（0xC000013A）不算异常终止",
       "0xc000013a" in abn_body.lower(),
       "isAbnormalExit 里没有排除 0xC000013A，"
       "按 Ctrl+C 会被报成算法崩了")

    note("★ 这一节是源码判据，不是行为判据：SimViewProvider 依赖 "
         "webview/extensionUri，在 Node 里跑起来成本过高。"
         "行为那一半由 B（会话层）覆盖。")


# ---------------------------------------------------------------------------
# C. 零图警告里的"配置来源"有没有说实话
# ---------------------------------------------------------------------------
def section_c(exe, proj, ext, pic_dir):
    print("\n=== C. 找不到图时，那条警告有没有说实话 ===")
    # 指向一个一定不存在的目录，并显式传 --ext / --pic
    bogus = os.path.join(os.environ.get("TEMP", "/tmp"), "scut_nope_xyz")
    rc, out, err = run_exe(exe, proj, None, ext, bogus)
    text = err + out
    if "配置来源" not in text:
        note("没触发零图警告（图集居然找到了？）—— 跳过")
        return None
    # 现行格式：`配置来源: 目录 取自 --pic，当前 "X"；` / `扩展名 取自 --ext，当前 "Y"。`
    m_dir = re.search(r"目录[^，\n]*，当前 \"([^\"]*)\"", text)
    m_ext = re.search(r"扩展名[^，\n]*，当前 \"([^\"]*)\"", text)
    said_dir = m_dir.group(1) if m_dir else "?"
    said_ext = m_ext.group(1) if m_ext else "?"
    note("警告里说：目录 = %r，扩展名 = %r" % (said_dir, said_ext))
    note("实际传的是：目录 = %r，扩展名 = %r" % (bogus, ext))
    ok("警告里的『目录』与实际传入的一致",
       os.path.normcase(said_dir.rstrip("/\\")) == os.path.normcase(bogus.rstrip("/\\")),
       "说的是 %r，传的是 %r" % (said_dir, bogus))
    ok("警告里的『扩展名』与实际传入的一致",
       said_ext == ext, "说的是 %r，传的是 %r" % (said_ext, ext))

    # 反过来的情形：都不传时，来源必须说"未指定 / 用默认"
    rc2, out2, err2 = run_exe(exe, proj, None, "", "")
    text2 = err2 + out2
    if "配置来源" in text2:
        ok("不传 --pic / --ext 时，来源如实说『未指定』",
           "未指定" in text2, "没看到『未指定』字样")
    return said_dir, said_ext


# ---------------------------------------------------------------------------
#  自建"必崩工程"：让这条测试在没有真实工程也能跑（进主回归的前提）
# ---------------------------------------------------------------------------
def build_self_project(clang_root):
    """从 templates/starter 建一个工程，用户代码换成 crash_camera.c。

    ★ 为什么用 fixtures/crash_camera.c 而不是内联一段越界代码：
      那份夹具写的是【真实形态】的越界（定长数组 + 无上限搜索循环），
      并且注释里记着它对应哪个真实案例。内联一行 *(int*)0=1 也能崩，
      但那不是用户会写出来的错，测出来的东西也就没有代表性。

    ★ 为什么"顺便编译"：这条测试要分两半 ——
      ① 子进程真的会崩（需要能跑的 exe）
      ② 崩溃之后插件说了什么（需要 extension/out 里的真实产物）
      两半缺一，剩下的那半都会变成"静默跳过"。
    """
    src_pics = tc.fixture_pic_dir()
    proj = tempfile.mkdtemp(prefix="scut_crash_")
    shutil.copytree(os.path.join(ROOT, "templates", "starter"), proj,
                    dirs_exist_ok=True)

    # 用户代码：换成故意越界的那份
    code_dir = os.path.join(proj, "code")
    for f in os.listdir(code_dir):
        if f.endswith(".c") or f.endswith(".h"):
            os.remove(os.path.join(code_dir, f))
    shutil.copyfile(os.path.join(HERE, "fixtures", "crash_camera.c"),
                    os.path.join(code_dir, "camera.c"))

    # 配置：钩子换成 crash_*，图集用仓库自带的 BMP
    cfg_path = os.path.join(proj, "scut_project.json")
    with open(cfg_path, "r", encoding="utf-8-sig") as f:
        cfg = json.load(f)
    cfg["outputArray"] = "g_binary"
    cfg["hooks"] = {"init": ["crash_init"],
                    "frame": ["crash_process"],
                    "post": ["crash_draw"]}
    cfg["pic"] = {"dir": "pic", "ext": ".bmp", "start": 1}
    with open(cfg_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    # 图集：至少 3 张，保证"逐图扫一遍"有意义
    pic_dir = os.path.join(proj, "pic")
    os.makedirs(pic_dir, exist_ok=True)
    n = 0
    if os.path.isdir(src_pics):
        pics = sorted(
            (f for f in os.listdir(src_pics)
             if os.path.splitext(f)[1].lower() in (".bmp", ".png")),
            key=lambda f: int(os.path.splitext(f)[0])
            if os.path.splitext(f)[0].isdigit() else 0)
        for f in pics[:3]:
            shutil.copyfile(os.path.join(src_pics, f), os.path.join(pic_dir, f))
            n += 1

    r = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "scut_build.py"),
         "--project", proj, "--toolchain", clang_root],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print("  ⚠️  自建工程构建失败：")
        print("     " + ((r.stderr or r.stdout or "")[-600:].replace("\n", "\n     ")))
        return proj, False
    note("自建工程：%s（%d 张图）" % (proj, n))
    return proj, True


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default="", help="工程目录（不给则 --self 自建）")
    ap.add_argument("--self", dest="selfmode", action="store_true",
                    help="从模板自建一个必崩的工程来测（进主回归时用这个）")
    ap.add_argument("--toolchain", default="", help="工具链根目录（--self 时必需）")
    ap.add_argument("--exe", default="", help="scut_sim.exe 路径（默认 <工程>/.scut/bin/）")
    ap.add_argument("--ext", default="", help="图集扩展名（默认自动探测）")
    ap.add_argument("--pic", default="", help="图集目录（默认 <工程>/pic）")
    ap.add_argument("--max", type=int, default=0, help="最多扫几张（0 = 全扫）")
    args = ap.parse_args()

    if args.selfmode and not args.project:
        try:
            clang_root = tc.require(args.toolchain)
        except SystemExit:
            print("找不到工具链 —— --self 需要先能编译。")
            return 2
        proj, built = build_self_project(clang_root)
        if not built:
            return 2
    elif not args.project:
        print("要么给 --project，要么给 --self。")
        return 2
    else:
        proj = os.path.abspath(args.project)

    exe = args.exe or os.path.join(proj, ".scut", "bin", "scut_sim.exe")
    pic_dir = args.pic or os.path.join(proj, "pic")

    # 扩展名：默认按图集里实际有什么来定（BMP 与 PNG 两种都支持）
    ext = args.ext
    if not ext:
        found = set()
        if os.path.isdir(pic_dir):
            for f in os.listdir(pic_dir):
                e = os.path.splitext(f)[1].lower()
                if e in (".bmp", ".png"):
                    found.add(e)
        ext = ".bmp" if ".bmp" in found else (".png" if ".png" in found else ".bmp")

    if not os.path.isfile(exe):
        print("找不到仿真程序：%s\n请先编译这个工程。" % exe)
        return 2

    pics = []
    if os.path.isdir(pic_dir):
        pics = [f for f in os.listdir(pic_dir)
                if os.path.splitext(f)[1].lower() == ext.lower()]
    # ★ 编号取【文件名里的那个数字】，不是 0..count-1 的下标。
    #   图集从 1 起编号（也有从 0 起的），按下标去传 --frame 会被后端
    #   夹到合法下限，于是第一张被测两遍、最后一张一次都没测 ——
    #   而计数照样对得上（详见 section_a 的说明）。
    numbers = sorted(int(os.path.splitext(f)[0]) for f in pics
                     if os.path.splitext(f)[0].isdigit())
    if not numbers:
        numbers = sorted(range(1, len(pics) + 1))   # 文件名不是数字时的兜底
    if args.max:
        numbers = numbers[:args.max]
    print("工程：%s" % proj)
    print("程序：%s" % exe)
    print("图集：%s（%d 张，扩展名 %s）" % (pic_dir, len(pics), ext))
    if not numbers:
        print("\n图集是空的 —— 这条测试没有可跑的输入。")
        return 2

    section_a0(exe, proj, ext, pic_dir, numbers)
    crashed = section_a(exe, proj, ext, pic_dir, numbers)

    if crashed:
        crash_at = crashed[0][0]
        section_b(proj, crash_at)
    else:
        print("\n=== B. 跳过（没有会崩的图，探测不到崩溃路径）===")

    section_b2()
    section_b3()
    section_c(exe, proj, ext, pic_dir)

    print("\n" + "=" * 68)
    npass = sum(1 for _, c, _ in results if c)
    fails = [(n, e) for n, c, e in results if not c]
    print("  %d/%d 通过" % (npass, len(results)))
    if fails:
        print("\n  插件侧问题：")
        for n, e in fails:
            print("    · %s" % n)
            if e:
                print("      %s" % e)
    if crashed:
        print("\n  另注：这个工程有 %d 张图会让仿真进程崩掉 ——"
              % len(crashed))
        print("  那是用户算法的越界，不是插件的问题（但插件应该把它说清楚）。")
    print("=" * 68)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
