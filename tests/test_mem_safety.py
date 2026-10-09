#!/usr/bin/env python3
"""
test_mem_safety.py —— 内存安全回归：snprintf 返回值语义的两种踩法。

★★★ 这个测试为什么存在 ★★★

2026-10-10 一次外部代码评审揪出两处内存安全缺陷，根因完全相同：
把 snprintf 的返回值当成了"实际写入的字节数"。它们【完全静默】：
不崩溃、不报错，只有在特定输入下才越界，所以常规回归永远测不出来。

    ① core/src/scut_watch.c
       memcpy(dst, tmp, wrote) 但 tmp 只有 64 字节，
       而 wrote 是"本该写入的长度" —— 越界【读】，
       把相邻栈数据抄进变量面板。
    ② backends/headless/scut_headless_main.c 的 json_escape()
       把返回值累加到输出下标 o，\\uXXXX 分支一次推进 6 字节，
       o 跳过缓冲末尾，最后 dst[o]='\\0' 写在【栈数组之外】—— 越界【写】。

所以这个测试的做法是【直接测真实源码】：
    · ② 用 #include 把整个 headless 宿主拉进来 —— 不复制、不改写，
      测的就是仓库里那份代码，而不是"看起来像"的副本
      （复制一份函数再测，等于测的是副本，回归保护是假的）。
    · ① scut_watch_read 依赖注册表，这里改用同样机制的等价驱动，
      因为把整个 watch 模块 + 手工注册流程拉进来成本过高；
      它的截断逻辑与仓库实现逐行对应（见下方注释）。

两种验证手段同时用：
    · AddressSanitizer（能编译出来的话）—— 权威判据
    · 金丝雀字节扫描 —— 不依赖 ASan，任何工具链都能跑，
      能捕捉到"越界但恰好没崩"的情况

退出码 0 = 通过。
"""
import os
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

CLANG = r"D:\TOOLS\llvm-mingw\bin\clang.exe"
CLANG_ROOT = r"D:\TOOLS\llvm-mingw"


# --------------------------------------------------------------------------
# ① json_escape：直接 include 真实源码
# --------------------------------------------------------------------------
#
# headless 宿主有个 main()，所以只把它【当头文件 include】并用宏改名，
# 这样能拿到 json_escape 的真身，同时避免重复符号。
JSON_ESCAPE_DRIVER = r"""
#define main scut_headless_main_unused_main
#include "scut_headless_main.c"
#undef main

#include <stdio.h>

#define CANARY 0x5A

/* 把待测缓冲夹在金丝雀之间：越界写必然改到后哨兵 */
static int try_cap(int cap, const char *evil)
{
    unsigned char buf[2048];
    char        *dst = (char *)buf + 512;
    size_t       before = 0, after = 0, i;

    memset(buf, CANARY, sizeof(buf));
    json_escape(evil, dst, (size_t)cap);

    for (i = 0; i < 512; i++) { if (buf[i] != CANARY) { before++; } }
    for (i = 512 + (size_t)cap; i < sizeof(buf); i++) {
        if (buf[i] != CANARY) { after++; }
    }
    if (before || after) {
        printf("OVERFLOW cap=%d before=%zu after=%zu\n", cap, before, after);
        return 1;
    }
    return 0;
}

int main(void)
{
    int  bad = 0;
    int  cap;

    /* 最恶劣输入：全部控制字符，强制走 \uXXXX（6 字节）分支。
       旧实现在 cap=5,6,7,8,11,12… 都会越界写。 */
    const char *evil =
        "\x01\x02\x03\x04\x05\x06\x07\x08\x1f\"\\\t\n\r"
        "abcdefghijklmnopqrstuvwxyz0123456789";

    /* cap=1 也能安全收尾（连一个 \uXXXX 都放不下时不该越界） */
    for (cap = 1; cap <= 64; cap++) { bad += try_cap(cap, evil); }

    /* 空串与 NULL 输入 */
    {
        unsigned char buf[256];
        char *dst = (char *)buf + 64;
        memset(buf, CANARY, sizeof(buf));
        json_escape("", dst, sizeof(buf) - 64);
        json_escape(NULL, dst, sizeof(buf) - 64);
        if (buf[64] != '\0') { printf("OVERFLOW empty/NULL\n"); bad++; }
    }

    printf(bad ? "JSON_ESCAPE_FAIL=%d\n" : "JSON_ESCAPE_OK\n", bad);
    return bad ? 1 : 0;
}
"""


# --------------------------------------------------------------------------
# ② scut_watch_read 的截断逻辑
# --------------------------------------------------------------------------
#
# 不能直接 include core/src/scut_watch.c —— 它虽然有注册表 API，
# 但真实调用需要先注册变量、走完整流程。这里改为复刻它【逐行对应】的
# 截断片段（见 SCUT_WATCH_READ_REPLICA），并显式标注对应行号。
# 复刻的价值：一旦有人把仓库里的 n/wrote 逻辑改回旧写法，
# 这份 replica 不会自动跟着错 —— 所以下面还有一条
# 【源码形态检查】直接在 scut_watch.c 原文上断言。
WATCH_DRIVER = r"""
#include <stdio.h>
#include <string.h>

/* ==== 与 core/src/scut_watch.c 的值格式化循环逐行对应 ==== */
static int read_one_into(char *buf, size_t buf_size, const char *value)
{
    char tmp[64];                 /* 与 scut_watch.c 同尺寸 */
    int  n;                       /* ★ 收窄后的实际写入量 */
    int  wrote;                   /* snprintf 的"本该写入长度" */
    size_t used;

    buf[0] = '\0';
    used = strlen(buf);

    wrote = snprintf(tmp, sizeof(tmp), "%s", value);
    if (wrote < 0) { return 0; }

    /* ★ 修复后的关键一行：收窄。旧代码没有这一步，
       直接 memcpy(buf, tmp, wrote) → 越界读。 */
    n = (wrote >= (int)sizeof(tmp)) ? (int)sizeof(tmp) - 1 : wrote;

    if (used + (size_t)n + 2 > buf_size) { return 0; }
    memcpy(buf + used, tmp, (size_t)n);   /* ★ 用 n 而非 wrote */
    used += (size_t)n;
    buf[used] = '\0';
    return 1;
}

int main(void)
{
    char  big[1024];
    char  out[8192];
    size_t j;
    int   i, bad = 0;

    /* 本工程路径普遍含中文，>64 字符是常态 —— 旧实现在这里越界读 */
    for (j = 0; j < sizeof(big) - 1; j++) { big[j] = 'A' + (j % 26); }
    big[sizeof(big) - 1] = '\0';

    for (i = 0; i < 32; i++) {
        memset(out, 0, sizeof(out));
        if (!read_one_into(out, sizeof(out), big)) { break; }
    }

    /* 单元素最多 63 字节；输出缓冲必须仍然是合法 C 字符串 */
    if (strlen(out) != 63) {
        printf("WATCH_FAIL strlen=%zu (期望 63)\n", strlen(out));
        bad++;
    }
    printf(bad ? "WATCH_FAIL\n" : "WATCH_OK\n");
    return bad ? 1 : 0;
}
"""


def find_clang():
    if os.path.isfile(CLANG):
        return CLANG
    for cand in (r"C:\Program Files\LLVM\bin\clang.exe", "clang.exe", "clang"):
        try:
            r = subprocess.run([cand, "--version"], capture_output=True,
                               text=True, timeout=30)
            if r.returncode == 0:
                return cand
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def core_sources(cfg_dir):
    """核心库 + bind 单元 —— include 后端源文件时要把它们一起链上。

    json_escape 是 static，只能通过 #include 后端源文件拿到真身，
    于是这个可执行文件里会带上 main.c 的全部符号引用，必须把 core 链进去。
    bind 单元也要链（core/src/scut_input.c 会调 scut_bind_output/overlay），
    而它需要编译期尺寸 —— 真实构建里由 scut_project.json 生成 scut_config.h，
    这里就生成一份最小可用的：尺寸大小对越界测试毫无影响。
    """
    cdir = os.path.join(ROOT, "core", "src")
    srcs = [os.path.join(cdir, n) for n in sorted(os.listdir(cdir))
            if n.endswith(".c")]
    srcs.append(os.path.join(ROOT, "bind", "scut_bind.c"))
    with open(os.path.join(cfg_dir, "scut_config.h"), "w",
              encoding="utf-8", newline="\n") as f:
        f.write("#ifndef SCUT_CONFIG_H\n#define SCUT_CONFIG_H\n"
                "#define SCUT_IMAGE_W 188\n"
                "#define SCUT_IMAGE_H 120\n"
                "#define SCUT_IN_NAME  mt9v03x_image\n"
                "#endif\n")
    return srcs


def compile_and_run(name, source, cwd, asan, extra_inc=(), extra_src=()):
    """编译并运行一个测试程序；返回 (通过, 输出)
    ★ 第三个返回值可能是 None：表示"判据本身没生效"（如 ASan 装不上），
      与 False（真的失败）必须区分开，否则会把"没跑"当成"通过"。
    """
    exe = os.path.join(cwd, name + (".exe" if sys.platform == "win32" else ""))
    cmd = [find_clang(), "-std=c11", "-O0", "-g", "-w"]
    cmd += list(extra_inc)
    if asan:
        cmd.append("-fsanitize=address")
    cmd += ["-o", exe, source]
    cmd += list(extra_src)

    if asan:
        # 目标必须放在有 ASan 运行时的目录才能启动
        exe = os.path.join(CLANG_ROOT, "bin", os.path.basename(exe))
        cmd[cmd.index("-o") + 1] = exe

    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=300)
    if r.returncode != 0:
        return False, "编译失败:\n" + ((r.stderr or "")[-1500:])

    # ★ 退出码 -1073741515 == STATUS_DLL_NOT_FOUND：
    #   ASan 运行时装不上（工具链 bin 不在 PATH）。这时"没有 ASan 报告"
    #   是假阴性，必须识别出来，否则会把"根本没跑"当成"通过了"。
    env = dict(os.environ)
    env["PATH"] = CLANG_ROOT + r"\bin;" + env.get("PATH", "")
    try:
        rr = subprocess.run([exe], capture_output=True, text=True,
                            encoding="utf-8", errors="replace",
                            timeout=300, env=env)
    except OSError as e:
        return False, "无法启动: %s" % e

    if rr.returncode == -1073741515:
        return None, "ASan 运行时装不上（STATUS_DLL_NOT_FOUND），本项改用金丝雀判据"
    out = (rr.stdout or "") + (rr.stderr or "")
    if "AddressSanitizer" in out:
        return False, "ASan 报告:\n" + out[:1800]
    return (rr.returncode == 0), out.strip()


def check_source_shape():
    """在仓库源码【原文】上断言，防止 replica 与实现漂移。

    这条比运行 replica 更可靠：它检查的是真实文件的内容。

    ★★ 为什么是"整行精确匹配"而不是只搜一个子串 ★★
      验证期间踩过一次：把实现改成 `n = wrote;  /* NEGATIVE CONTROL */`
      （语义完全退回旧写法，但 memcpy 那一行仍然是 `(size_t)n`），
      只搜 memcpy 那一行的检查照样通过 —— 它只证明"变量名叫 n"，
      不证明"n 真的是收窄过的"。所以断言必须落在
      【真正做收窄的那一条赋值】上。
    """
    p = os.path.join(ROOT, "core", "src", "scut_watch.c")
    with open(p, "r", encoding="utf-8") as f:
        src = f.read()

    bad = []

    # ① 收窄的那一步必须原样存在（这才是防越界的关键）
    narrow = "n = (wrote >= (int)sizeof(tmp)) ? (int)sizeof(tmp) - 1 : wrote;"
    if narrow not in src:
        bad.append("scut_watch.c 里找不到收窄语句：\n        %s\n"
                   "    —— 这是栈越界读的关键一步，没它就等于没修。" % narrow)

    # ② 拷贝必须用收窄后的 n
    if "memcpy(buf + used, tmp, (size_t)n)" not in src:
        bad.append("scut_watch.c 的 memcpy 长度不是收窄后的 n（越界读会回来）")

    # ③ 反向断言：任何地方都不得再用未收窄的 wrote 当长度
    if "memcpy(buf + used, tmp, (size_t)wrote)" in src:
        bad.append("memcpy 仍在用未收窄的 wrote（越界读会回来）")

    return bad


def main():
    if find_clang() is None:
        print("⚠️  找不到 clang，跳过（需要 C 工具链）")
        return 0

    tmp = tempfile.mkdtemp(prefix="scut_memsafe_")
    # ① 要 #include 真实的后端源文件，所以后端目录必须在 include 路径里
    inc = ["-I" + os.path.join(ROOT, "core", "include"),
           "-I" + os.path.join(ROOT, "backends", "headless"),
           "-I" + tmp]          # 放生成的 scut_config.h
    srcs = core_sources(tmp)

    print("=" * 68)
    print("  json_escape —— 栈越界【写】（include 真实源码）")
    print("=" * 68)
    src1 = os.path.join(tmp, "d_json.c")
    with open(src1, "w", encoding="utf-8", newline="\n") as f:
        f.write(JSON_ESCAPE_DRIVER)

    # ASan 与金丝雀各跑一次：ASan 权威，金丝雀不依赖它
    ok_asan = None
    ok, out = compile_and_run("t_json", src1, tmp, asan=False,
                              extra_inc=inc, extra_src=srcs)
    print("  [金丝雀] " + (out.splitlines()[-1] if out else "(无输出)"))
    ok_canary = ok

    ok2, out2 = compile_and_run("t_json_asan", src1, tmp, asan=True,
                                extra_inc=inc, extra_src=srcs)
    if ok2 is None:
        print("  [ASan]   " + out2)
    else:
        ok_asan = ok2
        print("  [ASan]   " + ("✅ 无越界" if ok2 else "❌ " + out2[:400]))

    print()
    print("=" * 68)
    print("  scut_watch 值格式化 —— 栈越界【读】")
    print("=" * 68)
    src2 = os.path.join(tmp, "d_watch.c")
    with open(src2, "w", encoding="utf-8", newline="\n") as f:
        f.write(WATCH_DRIVER)
    ok3, out3 = compile_and_run("t_watch", src2, tmp, asan=True)
    if ok3 is None:
        print("  " + out3)
        ok3, out3 = compile_and_run("t_watch_n", src2, tmp, asan=False)
        print("  [无ASan] " + (out3.splitlines()[-1] if out3 else "(无输出)"))
    else:
        print("  [ASan]   " + ("✅ 无越界，截断长度正确" if ok3 else "❌ " + out3[:400]))

    print()
    print("=" * 68)
    print("  源码形态检查（防止实现与测试漂移）")
    print("=" * 68)
    bad = check_source_shape()
    for b in bad:
        print("  ❌ " + b)
    if not bad:
        print("  ✅ scut_watch.c 的拷贝长度已收窄为 n")

    allok = ok_canary and (ok_asan is not False) and ok3 and not bad
    print()
    print("=" * 68)
    print("  %s  内存安全回归" % ("✅ 通过" if allok else "❌ 失败"))
    print("=" * 68)
    return 0 if allok else 1


if __name__ == "__main__":
    sys.exit(main())
