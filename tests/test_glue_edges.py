#!/usr/bin/env python3
"""
test_glue_edges.py -- 接线单元的边界情况（三条 HIGH 缺陷的回归测试）。

每一条都对应一个【真实存在过】的缺陷，而且三条都属于
"构建成功、运行正常、但结果悄悄是错的"这一类 —— 最危险的那种。

    1. 同一个函数被填进两个阶段 → 每帧跑两遍，而 processUs 只统计一遍
       （性能数字凭空少一半）
    2. --no-watch + 结果图数组被多个 .c 看到 → 搬运函数被定义多份
       （duplicate symbol，而报错指向用户没写过的生成文件）
    3. 结果图数组名指向【标量】→ 编译通过，运行期每帧越界读约 22KB
       （不报错、不崩溃，只是一张垃圾图）

用法：
    python tests/test_glue_edges.py [--toolchain <根目录>]
退出码 0 = 全部通过。
"""
import argparse
import json
import os
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

failures = []
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if cond:
        print('  [OK]   %s' % msg)
    else:
        print('  [FAIL] %s' % msg)
        failures.append(msg)
    return cond


def run(cmd, cwd=None):
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', env=env, timeout=600)


def make_project(work, name, sources, cfg_overrides=None, pic=True):
    """搭一个最小可构建工程。sources: {相对路径: 内容}"""
    proj = os.path.join(work, name)
    os.makedirs(os.path.join(proj, 'code'), exist_ok=True)
    for rel, text in sources.items():
        p = os.path.join(proj, 'code', rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(text)
    cfg = {
        'image': {'width': 188, 'height': 120},
        'inputArray': 'mt9v03x_image',
        'outputArray': '',
        'hooks': {'init': [], 'frame': ['cam_process'], 'post': []},
        'pic': {'dir': '', 'ext': '', 'start': 1},
    }
    if cfg_overrides:
        for k, v in cfg_overrides.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k] = {**cfg[k], **v}
            else:
                cfg[k] = v
    with open(os.path.join(proj, 'scut_project.json'), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    if pic:
        os.makedirs(os.path.join(proj, 'pic', '1'), exist_ok=True)
    return proj


def build(proj, tc, extra=None):
    cmd = [sys.executable, BUILD, '--project', proj, '--toolchain', tc]
    if extra:
        cmd += extra
    return run(cmd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--toolchain', default='',
                    help='工具链根目录（含 bin/clang.exe）。留空 = 自动探测')
    ap.add_argument('--keep', action='store_true')
    args = ap.parse_args()

    args.toolchain = tc.require(args.toolchain)

    work = tempfile.mkdtemp(prefix='scut_glue_')
    print('SCUT-71 接线单元边界测试')
    print('  临时目录: %s' % work)

    simple = (
        '#include "scut_sdk.h"\n'
        'unsigned char g_out[SCUT_IMAGE_H][SCUT_IMAGE_W];\n'
        'void cam_process(void)\n'
        '{\n'
        '    int x, y;\n'
        '    for (y = 0; y < SCUT_IMAGE_H; y++)\n'
        '        for (x = 0; x < SCUT_IMAGE_W; x++)\n'
        '            g_out[y][x] = mt9v03x_image[y][x];\n'
        '}\n'
    )

    try:
        # ==============================================================
        print('\n[1] 同一函数填进两个阶段（必须报错，而不是跑两遍）')
        p1 = make_project(work, 'dup_hook', {'a.c': simple},
                          {'outputArray': 'g_out',
                           'hooks': {'frame': ['cam_process'],
                                     'post': ['cam_process']}})
        r1 = build(p1, args.toolchain)
        check(r1.returncode != 0,
              '构建被拦下（退出码 %d）' % r1.returncode)
        combined = (r1.stdout or '') + (r1.stderr or '')
        check('两个阶段' in combined or '两次' in combined,
              '错误信息说明了"被填进两个阶段"')
        check('处理时间' in combined or '计时' in combined,
              '错误信息说明了为什么这会算错性能数字')
        if os.path.isfile(os.path.join(p1, '.scut', 'gen', 'scut_env_glue.c')):
            check(False, '不应该生成接线单元')
        else:
            check(True, '没有生成接线单元（在生成前就拦下了）')

        # 反证：只填一个阶段应当正常构建
        p1b = make_project(work, 'dup_hook_ok', {'a.c': simple},
                           {'outputArray': 'g_out'})
        check(build(p1b, args.toolchain).returncode == 0,
              '同一个函数只填一个阶段时正常构建（没有误伤）')

        # ==============================================================
        print('\n[2] 结果图数组被多个 .c 看到（搬运函数只能定义一份）')
        # shared.h 声明 extern，两个 .c 都 include 它
        hdr = ('#ifndef SHARED_H\n#define SHARED_H\n'
               '#include "scut_sdk.h"\n'
               'extern unsigned char g_shared[SCUT_IMAGE_H][SCUT_IMAGE_W];\n'
               '#endif\n')
        owner = ('#include "shared.h"\n'
                 'unsigned char g_shared[SCUT_IMAGE_H][SCUT_IMAGE_W];\n'
                 'void cam_process(void) { g_shared[0][0] = mt9v03x_image[0][0]; }\n')
        other = ('#include "shared.h"\n'
                 'void helper(void) { g_shared[1][1] = 1; }\n')
        p2 = make_project(work, 'multi_tu',
                          {'shared.h': hdr, 'a.c': owner, 'b.c': other},
                          {'outputArray': 'g_shared'})

        r2a = build(p2, args.toolchain)                    # 自动发现路径
        check(r2a.returncode == 0, '自动发现路径构建成功')

        r2b = build(p2, args.toolchain, ['--no-watch'])    # --no-watch 路径
        check(r2b.returncode == 0,
              '--no-watch 路径也构建成功（曾经是 duplicate symbol）')
        c2 = (r2b.stdout or '') + (r2b.stderr or '')
        check('duplicate symbol' not in c2,
              '没有 duplicate symbol 错误')
        # 搬运函数必须恰好定义一次
        n_def = 0
        gen = os.path.join(p2, '.scut', 'gen')
        if os.path.isdir(gen):
            for fn in os.listdir(gen):
                if fn.endswith('.wrapped.c'):
                    with open(os.path.join(gen, fn), encoding='utf-8',
                              errors='replace') as f:
                        n_def += f.read().count('void scut_env_copy_output(void)')
        check(n_def == 1, '搬运函数恰好定义 1 次（实际 %d 次）' % n_def)

        # ==============================================================
        print('\n[3] 结果图数组名指向标量（必须报错，而不是越界读）')
        scalar_src = (
            '#include "scut_sdk.h"\n'
            'int g_scalar = 3;\n'
            'void cam_process(void) { g_scalar++; }\n'
        )
        p3 = make_project(work, 'scalar_out', {'a.c': scalar_src},
                          {'outputArray': 'g_scalar'})
        r3 = build(p3, args.toolchain)
        check(r3.returncode != 0,
              '构建被拦下（退出码 %d）' % r3.returncode)
        c3 = (r3.stdout or '') + (r3.stderr or '')
        check('不是数组' in c3 or '标量' in c3,
              '错误信息指出它是标量而不是数组')
        check('越界' in c3,
              '错误信息说明了越界读的后果')
        # 关键：不能生成一个会越界读的搬运函数
        gen3 = os.path.join(p3, '.scut', 'gen')
        bad = False
        if os.path.isdir(gen3):
            for fn in os.listdir(gen3):
                if fn.endswith('.wrapped.c'):
                    with open(os.path.join(gen3, fn), encoding='utf-8',
                              errors='replace') as f:
                        if 'SCUT_EnvCopyOutput' in f.read():
                            bad = True
        check(not bad, '没有生成会越界读的搬运函数')

        # 反证：正常的一维数组应当可用（不能把一维也一并否掉）
        arr1d = ('#include "scut_sdk.h"\n'
                 'unsigned char g_row[SCUT_IMAGE_W];\n'
                 'void cam_process(void) { g_row[0] = 1; }\n')
        p4 = make_project(work, 'array_1d', {'a.c': arr1d},
                          {'outputArray': 'g_row'})
        r4 = build(p4, args.toolchain)
        check(r4.returncode == 0,
              '一维数组作为结果图仍然可用（没有误伤）')

        print('\n' + '=' * 60)
        if failures:
            print('%d/%d 项通过，%d 项失败：'
                  % (checks - len(failures), checks, len(failures)))
            for m in failures:
                print('  - %s' % m)
            return 1
        print('全部 %d 项通过' % checks)
        return 0
    finally:
        if args.keep:
            print('\n临时目录保留：%s' % work)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
