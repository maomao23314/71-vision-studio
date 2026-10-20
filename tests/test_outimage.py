#!/usr/bin/env python3
"""
test_outimage.py -- 输出图（图片1 / 图片2）与「默认底图」的相互作用。

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

★★ C / D 两段是图片2（0.10.6）★★

    C. 算法往图片2里画 → 帧 JSON 多一条 img2、目录多一个 *_b.ppm；
       第二帧不画 → 必须回到全黑（每帧清空，不残留上一帧）；
       主画面完全不受影响。
    C2. 会话层（`tests/second_session.js`）：开关打开才读那张图、
       关掉连文件都不读。这一段单独跑 Node，因为"读不读"是 TS 的决定。
    D. 算法不写图片2 → 一个字段、一个文件都不多（"选配"= 零开销）。

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
        'run': {'processRepeat': 1, 'benchRepeat': 1},
        'toolchain': {'path': '', 'pythonPath': '',
                      'autoWatch': False},
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
            SCUT_OutImageSet(SCUT_IMG_1, x, y, 200);
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

# ---------------------------------------------------------------------------
# C) 图片2：算法自己往里画
# ---------------------------------------------------------------------------
USER_SECOND = r'''
#include "scut_sdk.h"

static scut_u8 second_buf[SCUT_IMAGE_H][SCUT_IMAGE_W];
static int frame_calls = 0;

/* 第一帧：整幅搬 77，再把 (0,0) 点成红色（验证彩色原样透传）。
 * 之后什么都不画 —— 用来验证"每帧清空、不残留上一帧"。 */
void image_process(void)
{
    int x, y;
    frame_calls++;
    if (frame_calls > 1) {
        return;
    }
    for (y = 0; y < SCUT_IMAGE_H; y++) {
        for (x = 0; x < SCUT_IMAGE_W; x++) {
            second_buf[y][x] = 77;
        }
    }
    SCUT_EnvCopyOutput(SCUT_IMG_2, second_buf[0], 0, 0);
    SCUT_OutImageSetRGB(SCUT_IMG_2, 0, 0, 255, 0, 0);
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

        # ---- C) 算法写「图片2」 ----
        #
        # 这一节守两条承诺：
        #   ① 写了才多一条 —— 帧 JSON 里出现 img2，同目录出现 *_b.ppm；
        #   ② 每帧清黑 —— 第一帧画满，第二帧不画，图片2必须回到全黑，
        #      不能残留上一帧的内容（"残留"会让用户以为这一帧也算出了同样的结果）。
        print('\n[C] 算法写图片2（应当单独成图，且每帧不残留）')
        projC = make_project(work, 'C_second', USER_SECOND, '', pics)
        r = run([sys.executable, BUILD, '--project', projC,
                 '--toolchain', args.toolchain])
        if not check(r.returncode == 0, 'C 工程构建成功',
                     ((r.stdout or '') + (r.stderr or ''))[-600:]):
            return 1

        exeC = os.path.join(projC, '.scut', 'bin', 'scut_sim.exe')
        framesC = os.path.join(projC, '.scut', 'bin', 'frames')
        r = run([exeC, '--json', '--frames', '2', '--out', framesC])
        lines = [l for l in (r.stdout or '').splitlines() if l.startswith('{')]
        check(len(lines) >= 2, 'C 跑了两帧并各吐一行 JSON',
              '实际 %d 行' % len(lines))
        first = second = None
        try:
            first = json.loads(lines[0])
            second = json.loads(lines[1])
        except (ValueError, IndexError) as e:
            check(False, 'C 帧 JSON 可解析', str(e))
        if first and second:
            check('img2' in first, 'C 第 1 帧的 JSON 带 img2 字段')
            check('img2' in second,
                  'C 第 2 帧仍然带 img2（写过一次就一直报，不是"这一帧写过才报"）')

            p2a = os.path.join(framesC, 'frame_0001_b.ppm')
            p2b = os.path.join(framesC, 'frame_0002_b.ppm')
            check(os.path.isfile(p2a), 'C 第 1 帧的图片2落盘（frame_0001_b.ppm）')
            check(os.path.isfile(p2b), 'C 第 2 帧的图片2也落盘')
            if os.path.isfile(p2a):
                got = read_ppm(p2a)
                check(got is not None, 'C 图片2是合法 PPM(P6)')
                if got:
                    w, h, px = got
                    check(px[0:3] == bytes([255, 0, 0]),
                          'C 图片2保留了算法点的红色（彩色原样透传）',
                          '实际 %r' % (px[0:3],))
                    n77 = sum(1 for i in range(3, len(px), 3)
                              if px[i] == 77 and px[i + 1] == 77 and px[i + 2] == 77)
                    check(n77 == w * h - 1,
                          'C 图片2整幅是算法搬进去的 77',
                          '命中 %d/%d' % (n77, w * h - 1))
            if os.path.isfile(p2b):
                got = read_ppm(p2b)
                if got:
                    w, h, px = got
                    check(all(b == 0 for b in px),
                          'C 第 2 帧不再画 → 图片2被清黑（不残留上一帧）')
            # 主画面不该被图片2影响：没配 outputArray ⇒ 仍是默认底图（灰度）
            p1a = os.path.join(framesC, 'frame_0001.ppm')
            if os.path.isfile(p1a):
                got = read_ppm(p1a)
                if got:
                    w, h, px = got
                    grey = all(px[i] == px[i + 1] == px[i + 2]
                               for i in range(0, len(px), 3))
                    check(grey and not (px[0] == 77 and px[1] == 77),
                          'C 主画面不受图片2影响（仍是输入图底图）')

        # ---- C2) 会话层：开关真的决定"读不读" ----
        #
        # ★ 为什么这一小段还要单独跑一次 Node：
        #   C/后端写对了，不代表会话会把 rgb2 组装出来（中间还差一段
        #   "按开关决定读不读 PPM"的 TS 逻辑）。那一段坏掉的表现是
        #   "后端明明写了文件，面板永远没有图片2"，而且不报错。
        print('\n[C2] 会话层：开关打开收到 rgb2 / 关闭连文件都不读')
        node = shutil.which('node')
        if not node:
            print('  SKIP  找不到 node，跳过会话层验证')
        else:
            for mode, needle in (('on', 'rgb2'), ('off', '没有 rgb2')):
                rr = run([node, os.path.join(HERE, 'second_session.js'),
                          projC, mode])
                out = ((rr.stdout or '') + (rr.stderr or ''))
                check(rr.returncode == 0, 'C2 会话层（开关 %s）通过' % mode,
                      out[-500:])
                check(needle in out,
                      'C2 开关 %s 时会话层确认了 rgb2 的有无' % mode,
                      out[-300:])

        # ---- D) 算法不写图片2 ⇒ 一点都不多付 ----
        print('\n[D] 算法不写图片2（不许多写文件、不许多发字段）')
        framesB2 = os.path.join(projB, '.scut', 'bin', 'frames_json')
        r = run([exeB, '--json', '--frames', '1', '--out', framesB2])
        lines = [l for l in (r.stdout or '').splitlines() if l.startswith('{')]
        ok_line = False
        if lines:
            try:
                ok_line = 'img2' not in json.loads(lines[0])
            except ValueError:
                ok_line = False
        check(ok_line, 'D 帧 JSON 里没有 img2 字段')
        extra = [n for n in (os.listdir(framesB2) if os.path.isdir(framesB2) else [])
                 if n.endswith('_b.ppm')]
        check(extra == [], 'D 没有多写 *_b.ppm（从没用过的工程零额外开销）',
              '多写了：%s' % extra)

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
