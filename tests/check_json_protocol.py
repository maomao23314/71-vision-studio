#!/usr/bin/env python3
"""
check_json_protocol.py -- 验证仿真后端的 stdout 是【严格合法】的 JSON 协议。

为什么这是一个独立的测试（而不是随便看一眼）：
    插件靠逐行 JSON.parse 拿帧数据。只要有一行不合法，副作用是
    「插件莫名其妙收不到帧」——而仿真本身跑得好好的，stdout 上看也"像"正常。
    历史上真的踩过两次，都是转义问题：
        · Windows 路径 `C:\\...\\frames/frame_0001.pgm` 里的 `\\f` 是【换页符】、
          `\\d` 是非法转义 → 整行不是合法 JSON
        · 图片加载失败的中文原因里带引号 → 同样破坏 JSON
    两者都不会让仿真报错，只会让插件静默失效。所以这里逐行做严格校验。

★ 与旧版本的区别（重要）：
    旧版本读的是 `%TEMP%/jout.txt` 这个【写死的、别的脚本留下的】文件，
    而且发现非法行之后依然 exit 0 —— 等于一个永远不会失败的测试。
    现在它自己跑仿真进程拿真实输出，并且非法行会让退出码非 0。

用法：
    python tests/check_json_protocol.py [--project <工程目录>]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import toolchain as tc  # noqa: E402

# ★ 默认工程：用命令行传进来的（run_all_tests.py 会传）。
#   ★ 不写任何"仓库外某个具体工程"的兜底路径 —— 那是开发机上的目录名，
#     别人 clone 下来根本不存在。没有参数时走 SKIP 分支：
#     本测试的职责是"校验协议"，不是"要求构建产物存在"。
_DEFAULT_PROJECT = ''

# 帧行的【必需字段】。★ 只增不改：老插件不认识新字段也应照常工作，
# 所以这里只检查"必须存在"，不检查"不能有别的"。
REQUIRED_FRAME_FIELDS = ('frame', 'w', 'h', 'img', 'pic', 'timing')
REQUIRED_TIMING_FIELDS = ('processUs', 'drawUs', 'frameUs', 'cycles', 'cyclesValid')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', default=_DEFAULT_PROJECT,
                    help='用于产生协议输出的工程目录（如 .scut/bin/scut_sim.exe 所在的那一层）')
    ap.add_argument('--frames', type=int, default=3)
    args = ap.parse_args()

    exe = os.path.join(args.project, '.scut', 'bin', 'scut_sim.exe')
    if not os.path.isfile(exe):
        print('  SKIP  仿真程序不存在（还没构建）：%s' % exe)
        # 没构建不算失败：这个测试的职责是"校验协议"，不是"要求构建产物存在"。
        return 0

    out_dir = os.path.join(tempfile.gettempdir(), 'scut_json_probe')
    r = subprocess.run([exe, '--frames', str(args.frames), '--json',
                        '--out', out_dir],
                       cwd=args.project, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', timeout=180)

    lines = [l for l in (r.stdout or '').splitlines() if l.strip()]
    print('  stdout 行数: %d' % len(lines))

    ok = bad = 0
    frames = []
    for i, line in enumerate(lines, 1):
        try:
            obj = json.loads(line)
        except ValueError as e:
            bad += 1
            print('  ❌ 第%d行不是合法 JSON: %s' % (i, e))
            print('     %s' % line[:160])
            continue
        ok += 1
        if ok == 1:
            print('  首个对象字段: %s' % sorted(obj.keys()))
            print('    pic    = %s' % obj.get('pic'))
            print('    timing = %s' % obj.get('timing'))
        # 真正的帧行有 frame+timing；末尾还会有一行纯变量清单，跳过它
        if isinstance(obj, dict) and 'frame' in obj and 'timing' in obj:
            frames.append((i, obj))

    problems = []
    if bad > 0:
        problems.append('%d 行不是合法 JSON' % bad)
    if not frames:
        problems.append('一行帧数据都没有（协议没跑起来？）')

    for lineno, f in frames:
        for k in REQUIRED_FRAME_FIELDS:
            if k not in f:
                problems.append('第%d行缺字段 %s' % (lineno, k))
        t = f.get('timing')
        if not isinstance(t, dict):
            problems.append('第%d行的 timing 不是对象' % lineno)
            continue
        for k in REQUIRED_TIMING_FIELDS:
            if k not in t:
                problems.append('第%d行 timing 缺字段 %s' % (lineno, k))
        # 类型也要对：插件按数字用它们，字符串会让算术静默变 NaN
        for k in ('processUs', 'drawUs', 'frameUs'):
            if not isinstance(t.get(k), (int, float)):
                problems.append('第%d行 timing.%s 不是数字' % (lineno, k))
        if not isinstance(t.get('cyclesValid'), bool):
            problems.append('第%d行 timing.cyclesValid 不是布尔' % lineno)
        if not isinstance(f.get('vars'), list):
            problems.append('第%d行 vars 不是数组' % lineno)
        # 图片路径必须是可用的字符串（空串意味着这一帧没图）
        if not isinstance(f.get('img'), str) or not f.get('img'):
            problems.append('第%d行的 img 不是非空字符串' % lineno)

    print()
    print('  合法 JSON 行 : %d' % ok)
    print('  非法 JSON 行 : %d' % bad)
    print('  含计时的帧   : %d' % len(frames))
    if problems:
        print('  结论: ❌ 协议有问题')
        for p in problems[:20]:
            print('     - %s' % p)
        return 1
    print('  结论: ✅ 协议合法且字段齐全')
    return 0


if __name__ == '__main__':
    sys.exit(main())
