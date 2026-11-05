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
    C2. 会话层（`tests/second_session.js`）：算法写过 → 会话把 rgb2 组装出来；
       算法没写 → 后端根本不发 img2，会话也就没有 rgb2。
       这一段单独跑 Node，因为"读不读那张 PPM"是 TS 的决定。
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
import time

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


def _same_bytes(a, b):
    """两个文件内容是否逐字节相同（大小先比，避免读整个大文件）。"""
    if os.path.getsize(a) != os.path.getsize(b):
        return False
    with open(a, 'rb') as fa, open(b, 'rb') as fb:
        return fa.read() == fb.read()


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
            SCUT_OutImageSet(1, x, y, 200);
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
    SCUT_EnvCopyOutput(2, second_buf[0], 0, 0);
    SCUT_OutImageSetRGB(2, 0, 0, 255, 0, 0);
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

        # ---- C2) 会话层：那位 TS 真的会把 rgb2 组装出来 ----
        #
        # ★ 为什么这一小段还要单独跑一次 Node：
        #   C/后端写对了，不代表会话会把 rgb2 组装出来（中间还差一段
        #   "读那张 PPM、解析、装进 FramePacket"的 TS 逻辑）。那一段坏掉的表现是
        #   "后端明明写了文件，面板永远没有图片2"，而且不报错。
        print('\n[C2] 会话层：写过图片2 -> 有 rgb2；没写 -> 没有')
        node = shutil.which('node')
        if not node:
            print('  SKIP  找不到 node，跳过会话层验证')
        else:
            for mode, needle in (('with', '带 rgb2'), ('without', '图片2 全黑')):
                rr = run([node, os.path.join(HERE, 'second_session.js'),
                          projC, mode])
                out = ((rr.stdout or '') + (rr.stderr or ''))
                check(rr.returncode == 0, 'C2 会话层（%s 图片2）通过' % mode,
                      out[-500:])
                check(needle in out,
                      'C2 %s 图片2 时会话层确认了 rgb2 的有无' % mode,
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

        # ---- E) 输入图副本 Input_pic ----
        #
        # 这一节守的是「环境读的是工程根那一份副本」这条承诺：
        #   ① 跑完之后工程根必须出现 Input_pic.<后缀>，且内容与当前那张图一致；
        #   ② 翻页（协议 n）之后副本要跟着换 —— 不换的话用户会对着
        #      "上一张的副本"调参，而画面早就是下一张了；
        #   ③ 同一张图重复加载【不重写】—— 这是用户明确要求的"不用重复搬运"。
        #      判据用 mtime：内容相同却重写一遍的话，同步盘会当成文件被修改，
        #      而用户什么都没改。
        print('\n[E] 输入图副本 Input_pic（跟随当前帧、重复运行不重搬）')
        projE = make_project(work, 'E_mirror', USER_NO_WRITE, '', pics)
        # ★ 必须把图重命名成【连续编号】1.bmp / 2.bmp：
        #   tests/fixtures 里的文件名是 1.bmp、10.bmp、11.bmp（真实图集的抽样），
        #   而图集按"读到缺号就结束"的规则只认 1 张 —— 于是"翻页"这一步
        #   根本没有第 2 张可翻，测试会误报成"副本没跟着换"。
        #   这一节要验的是镜像行为，不是编号规则，所以在这里把编号摆正。
        pic_dirE = os.path.join(projE, 'pic', '1')
        for old in sorted(os.listdir(pic_dirE)):
            os.remove(os.path.join(pic_dirE, old))
        for i, n in enumerate(pics, 1):
            shutil.copyfile(os.path.join(PIC_SRC, n),
                            os.path.join(pic_dirE, '%d.bmp' % i))
        pics = ['%d.bmp' % i for i in range(1, len(pics) + 1)]

        r = run([sys.executable, BUILD, '--project', projE,
                 '--toolchain', args.toolchain])
        if not check(r.returncode == 0, 'E 工程构建成功',
                     ((r.stdout or '') + (r.stderr or ''))[-600:]):
            return 1

        exeE = os.path.join(projE, '.scut', 'bin', 'scut_sim.exe')
        framesE = os.path.join(projE, '.scut', 'bin', 'frames')
        mirror = os.path.join(projE, 'Input_pic.bmp')

        # ① 跑一帧 → 副本出现，内容 = 第 1 张
        run([exeE, '--frames', '1', '--out', framesE])
        if not check(os.path.isfile(mirror), 'E 工程根出现 Input_pic.bmp'):
            print('  （后续 E 项跳过：副本不存在）')
        else:
            src1 = os.path.join(projE, 'pic', '1', pics[0])
            check(_same_bytes(mirror, src1),
                  'E 副本内容 = 当前那张输入图（%s）' % pics[0])

            # ③ 同一张图再跑一次 → mtime 不变（没重写）
            m1 = os.stat(mirror).st_mtime_ns
            time.sleep(0.05)     # 让"如果重写了"必然能看出 mtime 差异
            run([exeE, '--frames', '1', '--out', framesE])
            m2 = os.stat(mirror).st_mtime_ns
            check(m1 == m2, 'E 同一张图重复运行不重写副本（mtime 未变）',
                  '%d -> %d' % (m1, m2))

            # ② 翻页 → 副本跟着换
            if len(pics) >= 2:
                rr = subprocess.run([exeE, '--json', '--step', '--frames', '0',
                                     '--out', framesE],
                                    input='n\n', capture_output=True,
                                    text=True, encoding='utf-8',
                                    errors='replace')
                pics_seen = re.findall(r'"pic":"([^"]*)"', rr.stdout or '')
                src2 = os.path.join(projE, 'pic', '1', pics[1])
                check(_same_bytes(mirror, src2),
                      'E 翻页后副本换成第 2 张（%s）' % pics[1],
                      'JSON 里的 pic 序列=%s' % pics_seen[-2:])
            else:
                print('  SKIP  图集只有 1 张，跳过翻页验证')

            # ④ ★ 核心断言：环境解码的是【副本】而不是原图 ★
            #
            # 这条不能靠"副本内容 = 原图"来证明 —— 那只能说明复制成功了，
            # 说明不了解码器读的是哪一条。所以反过来做：
            #   把原图换成一个【内容不同】的文件、同时保持副本不变，
            #   然后看画面跟着谁变。
            #
            # ★ 怎么做到"副本变了而原图没变"：
            #   把副本覆盖成一张【纯白图】，再让加载跳过复制
            #   （判据是 源路径+大小+mtime 都没变 → 不重写副本）。
            #   同一次进程内连续加载同一张图时，第二次就不会重写副本，
            #   于是我们写进去的白图得以保留、被解码器读到。
            #
            # ★ 这条测试本身踩过两次坑，都记在 mirror_decode.js 的头部：
            #   ① 副本后缀跟着图集走（PNG 图集 → Input_pic.png），
            #      旧版把名字写死成 Input_pic.bmp，在 PNG 工程上直接报
            #      "副本没有生成"；
            #   ② 阈值定成"正好 255"会假失败 —— 画面是合成后的最终图，
            #      算法会在上面画绿色标注，实测纯白输入得到 244。
            print('\n[E2] 解码确实走副本（同进程内改副本 → 画面跟着变）')
            node = shutil.which('node')
            if not node:
                print('  SKIP  找不到 node，跳过"解码走副本"验证')
            else:
                # ★ 图集目录要显式传：这个测试工程的图在 pic/1/ 下，
                #   而 mirror_decode.js 默认按 pic/ 找（与 pic.dir 一致）。
                rr = run([node, os.path.join(HERE, 'mirror_decode.js'),
                          projE, pic_dirE])
                out = ((rr.stdout or '') + (rr.stderr or ''))
                check(rr.returncode == 0, 'E2 解码走副本的会话验证通过',
                      out[-700:])
                check('DECODED_FROM_MIRROR' in out,
                      'E2 改副本后画面跟着变（证明解码读的是 Input_pic）',
                      out[-400:])

            # ---- E3) 热重载 ----
            # 这一节守的是 0.15.0 的新承诺：
            #   ① 帧 JSON 里的 inHash 就是磁盘上那份副本的指纹（C 与 JS 一致）；
            #   ② 发 'r' 之后进程重读【当前磁盘内容】，而不是重新从图集复制 ——
            #      后者会把用户用图片编辑器改过的副本覆盖掉，热重载等于没做。
            # ★ 必须用真进程：这条链路里"后端怎么处理 r""镜像会不会覆盖"
            #   都不是宿主侧能推出来的（理由同 mirror_decode.js 的头部）。
            print('\n[E3] 热重载（协议 r：重读当前副本，不重新复制）')
            if not shutil.which('node'):
                print('  SKIP  找不到 node，跳过热重载验证')
            else:
                rr = run([shutil.which('node'),
                          os.path.join(HERE, 'hot_reload_e2e.js'),
                          projE, pic_dirE])
                out = ((rr.stdout or '') + (rr.stderr or ''))
                check(rr.returncode == 0, 'E3 热重载端到端验证通过', out[-900:])
                check('HOT_RELOAD_OK' in out,
                      'E3 重载读的是改写后的副本（没有被图集覆盖）',
                      out[-500:])

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
