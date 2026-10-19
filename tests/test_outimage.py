#!/usr/bin/env python3
"""
test_outimage.py -- SCUT_OutImageSet 与「默认底图」的相互作用。

★★ 这条测试为什么存在（一个真实的接口缺口）★★

  `scut_sdk.h` 把 `SCUT_OutImageSet` / `SCUT_OutImageSetRGB` 宣传为
  "算法直接产出显示图"的路径。但调度器每帧在 PROCESS 之后、DRAW 之前，
  会把输入图【铺满】输出图当默认底图（`scut_env_seed_output_from_input`）。

  于是算法在 PROCESS 里用 OutImageSet 画的像素会被那一铺【全量冲掉】。
  用户看到的是"我明明写了 OutImageSet，画面却还是原始灰度图"——
  不报错、不崩溃，只是他写的东西没了。很难归因。

  修法：调度器读一个"本帧是否已被算法直接写过输出图"的标志，
  有人写过就跳过铺底图（见 scut_draw_output_written 的说明）。

★★ 这条测试必须同时守住两侧 ★★

  只测"修好了"是不够的 —— 修法动的是【每帧的时序】，
  一旦判断条件写反，最可能的后果是【把默认底图整个弄没】，
  于是"没配 outputArray 的用户画面全黑"。
  而那种坏法同样是静默的。所以这里两个方向都测：

    A. 算法调了 OutImageSet  → 算法画的东西必须出现（修的是这个）
    B. 算法没调 OutImageSet  → 必须仍然铺默认底图，画面 = 输入图
                               （证明没有把原有行为改坏）

  两条都过，才说明"该保留的保留、该修好的修好了"。

用法:
    python tests/test_outimage.py [--toolchain <根目录>]
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

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import toolchain as tc  # noqa: E402

BUILD = os.path.join(ROOT, 'tools', 'scut_build.py')
# 仓库内自带的测试图（原先借仓库外的集成工程 —— 别人 clone 下来没有）
PIC_SRC = tc.fixture_pic_dir()

checks = 0
failures = []


def check(cond, msg, extra=''):
    """记一条断言，并返回 cond 本身。

    ★ 返回值是必需的：下面有 `if not check(...): return 1` 这种"构建失败就
      立刻停"的用法。若本函数不返回 cond（默认返回 None），
      `not None` 恒为真 —— 于是【每次都会提前 return】，
      而且一行错误都不打印，表现为"测试静默退出、什么都没测"。
      实测踩过这个坑：输出只到第一条 OK 就结束了。
    """
    global checks
    checks += 1
    if cond:
        print('  [OK]   %s' % msg)
    else:
        failures.append(msg)
        print('  [FAIL] %s%s' % (msg, ('  -> ' + str(extra)) if extra else ''))
    return cond


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


def read_ppm(path):
    """读 P6 PPM，返回 (w, h, bytes)。"""
    with open(path, 'rb') as f:
        raw = f.read()
    # 头部：P6\n<w> <h>\n255\n
    m = re.match(rb'P6\s+(\d+)\s+(\d+)\s+255\s', raw)
    if not m:
        return None
    w, h = int(m.group(1)), int(m.group(2))
    off = m.end()
    return w, h, raw[off:off + w * h * 3]


def make_project(work, name, user_c, output_array, pic_files):
    """搭一个工程：user_c 是 code/camera.c 的内容。"""
    proj = os.path.join(work, name)
    os.makedirs(os.path.join(proj, 'code'), exist_ok=True)
    os.makedirs(os.path.join(proj, 'pic', '1'), exist_ok=True)
    with open(os.path.join(proj, 'code', 'camera.c'), 'w', encoding='utf-8') as f:
        f.write(user_c)
    cfg = {
        'image': {'width': 188, 'height': 120},
        'inputArray': 'mt9v03x_image',
        'outputArray': output_array,
        'hooks': {'init': [], 'frame': ['image_process'], 'post': []},
        'pic': {'dir': 'pic/1', 'ext': '.bmp', 'start': 1},
        'run': {'processRepeat': 1, 'runFrames': 1, 'benchRepeat': 1},
        'toolchain': {'path': '', 'pythonPath': '',
                      'autoDownload': False, 'autoWatch': False},
    }
    with open(os.path.join(proj, 'scut_project.json'), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    for n in pic_files:
        shutil.copyfile(os.path.join(PIC_SRC, n),
                        os.path.join(proj, 'pic', '1', n))
    return proj


# ---------------------------------------------------------------------------
# A) 算法直接写输出图 —— 它画的东西必须活下来
# ---------------------------------------------------------------------------
# 用一个"绝不可能是输入图内容"的值（200）铺满，这样只要画面里出现 200，
# 就证明 seed 没有把它冲掉。输入图是真实灰度照片，整幅都是 200 不可能。
USER_WRITES_OUT = r'''
#include "scut_sdk.h"

/* 每帧把整幅输出图刷成 200（等值三通道 = 灰 200）。
 * 不配 outputArray —— 这正是 scut_sdk.h 说的"算法直接产出显示图"路径。 */
void image_process(void)
{
    int x, y;
    for (y = 0; y < SCUT_IMAGE_H; y++) {
        for (x = 0; x < SCUT_IMAGE_W; x++) {
            SCUT_OutImageSet(x, y, 200);
        }
    }
}
'''

# ---------------------------------------------------------------------------
# B) 算法【不】写输出图 —— 必须仍然铺默认底图（证明没改坏原有行为）
# ---------------------------------------------------------------------------
USER_NO_WRITE = r'''
#include "scut_sdk.h"

/* 什么都不做：输出图应当仍是"输入图本身"（默认底图）。
 * 这是 README 承诺的行为：「结果图数组名留空 = 画面显示输入图本身」。 */
void image_process(void)
{
    volatile int x = mt9v03x_image[10][10];
    (void)x;
}
'''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--toolchain', default='',
                    help='工具链根目录（含 bin/clang.exe）。留空 = 自动探测')
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()

    args.toolchain = tc.require(args.toolchain)

    print('SCUT-71 SCUT_OutImageSet × 默认底图 测试')
    work = tempfile.mkdtemp(prefix='scut_outimg_')
    print('  临时目录: %s' % work)

    if not os.path.isdir(PIC_SRC):
        print('  SKIP  找不到测试图集：%s' % PIC_SRC)
        return 0
    pics = sorted(n for n in os.listdir(PIC_SRC) if n.lower().endswith('.bmp'))[:2]
    if not pics:
        print('  SKIP  图集里没有 .bmp')
        return 0

    try:
        # ---- A) 算法写输出图 ----
        print('\n[A] 算法调用 SCUT_OutImageSet（应当保留算法画的内容）')
        projA = make_project(work, 'A_writes', USER_WRITES_OUT, '', pics)
        r = run([sys.executable, BUILD, '--project', projA,
                 '--toolchain', args.toolchain])
        if not check(r.returncode == 0, 'A 工程构建成功',
                     ((r.stdout or '') + (r.stderr or ''))[-600:]):
            return 1

        exeA = os.path.join(projA, '.scut', 'bin', 'scut_sim.exe')
        framesA = os.path.join(projA, '.scut', 'bin', 'frames')
        r = run([exeA, '--frames', '1', '--out', framesA])
        ppmA = os.path.join(framesA, 'frame_0001.ppm')
        check(os.path.isfile(ppmA), 'A 产出了帧文件')
        if os.path.isfile(ppmA):
            got = read_ppm(ppmA)
            check(got is not None, 'A 帧文件是合法 PPM(P6)')
            if got:
                w, h, px = got
                # 统计有多少像素是"三通道都等于 200"
                n200 = sum(1 for i in range(0, len(px), 3)
                           if px[i] == 200 and px[i + 1] == 200 and px[i + 2] == 200)
                total = w * h
                check(n200 == total,
                      'A 整幅画面都是算法写的 200（seed 没有冲掉它）',
                      '命中 %d/%d 像素' % (n200, total))

        # ---- B) 算法不写输出图 ----
        print('\n[B] 算法不碰输出图（应当仍然铺默认底图 = 输入图本身）')
        projB = make_project(work, 'B_nowrite', USER_NO_WRITE, '', pics)
        r = run([sys.executable, BUILD, '--project', projB,
                 '--toolchain', args.toolchain])
        if not check(r.returncode == 0, 'B 工程构建成功',
                     ((r.stdout or '') + (r.stderr or ''))[-600:]):
            return 1

        exeB = os.path.join(projB, '.scut', 'bin', 'scut_sim.exe')
        framesB = os.path.join(projB, '.scut', 'bin', 'frames')
        r = run([exeB, '--frames', '1', '--out', framesB])
        ppmB = os.path.join(framesB, 'frame_0001.ppm')
        check(os.path.isfile(ppmB), 'B 产出了帧文件')
        if os.path.isfile(ppmB):
            got = read_ppm(ppmB)
            check(got is not None, 'B 帧文件是合法 PPM(P6)')
            if got:
                w, h, px = got
                # 默认底图 = 输入图的灰度扩成三通道 ⇒ R==G==B 且非全同一值
                distinct = set()
                grey_ok = True
                for i in range(0, len(px), 3):
                    if not (px[i] == px[i + 1] == px[i + 2]):
                        grey_ok = False
                        break
                    distinct.add(px[i])
                    if len(distinct) > 8:
                        break
                check(grey_ok, 'B 画面是三通道相等的灰度（底图来自灰度输入图）')
                check(len(distinct) > 1,
                      'B 画面不是单色（说明画的是真实输入图，不是一片 200 或全黑）',
                      'distinct=%d' % len(distinct))
                check(px[0] != 200 or len(distinct) > 1,
                      'B 画面不是被 A 的常量污染')

        print('\n' + '=' * 60)
        if failures:
            print('%d/%d 项通过，%d 项失败：' % (checks - len(failures), checks,
                                                len(failures)))
            for f in failures:
                print('  - %s' % f)
        else:
            print('全部 %d 项通过' % checks)
        print('=' * 60)
        return 1 if failures else 0
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
        else:
            print('  保留临时工程：%s' % work)


if __name__ == '__main__':
    sys.exit(main())
