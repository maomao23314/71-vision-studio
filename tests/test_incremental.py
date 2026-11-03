#!/usr/bin/env python3
"""
test_incremental.py -- 增量构建的回归测试。

============================================================================
这条测试守的是什么
============================================================================
增量构建的全部价值建立在「判据不出错」上，而它出错的形态【全都是静默的】：

    · 判据太松 → 改了代码却复用旧 .o → 编出来的程序跑的是旧算法。
      画面、日志、变量面板全都正常，只是"改了没生效" ——
      用户会开始怀疑自己没保存文件。
    · 判据太严 → 每次全量重编 → 慢，但至少是对的（可接受）。
    · .d 丢了当成"最新" → 从此永不重建，比上面两条都糟。

所以这里的断言分成两半：
    A. 【必须失效】的输入，逐个验证它真的触发重建；
    B. 【必须命中】的输入，验证它真的没重编（否则增量等于没做）。

B 半尤其重要：只测 A 的话，一个"永远返回需要重建"的实现照样全绿。

用法：
    python tests/test_incremental.py [--toolchain <根目录>]
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
TEMPLATE = os.path.join(ROOT, 'templates', 'starter')
SYMBOLS = os.path.join(ROOT, 'tools', 'scut_symbols.py')

PASS = 0
FAIL = 0
FAILED = []


def check(cond, msg, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  PASS  %s' % msg)
    else:
        FAIL += 1
        FAILED.append(msg)
        print('  FAIL  %s%s' % (msg, ('  <- %s' % detail) if detail else ''))
    return cond


def build(proj, clang_root, extra=None):
    """跑一次构建，返回 (退出码, 完整输出, {阶段名: 毫秒})。"""
    cmd = [sys.executable, BUILD, '--project', proj,
           '--toolchain', clang_root, '-v'] + list(extra or [])
    env = dict(os.environ)
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding='utf-8', errors='replace', env=env,
                       timeout=900)
    out = (r.stdout or '') + (r.stderr or '')
    stages = {}
    for m in re.finditer(r'^\s{2}(\S.*?)\s+(\d+\.\d) ms$', out, re.M):
        stages[m.group(1).strip()] = float(m.group(2))
    return r.returncode, out, stages


def user_stage(stages):
    """取「编译用户代码」那一段的耗时（阶段名里带文件数）。"""
    for k, v in stages.items():
        if k.startswith('编译用户代码'):
            return v
    return None


def reused_count(out):
    """从 -v 输出里取「N/M 个文件未变化」的 N。"""
    m = re.search(r'(\d+)/(\d+) 个文件未变化', out)
    return (int(m.group(1)), int(m.group(2))) if m else (0, None)


def mtime(path):
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return -1


def prepare(tmp):
    """从模板建工程，补成【多编译单元 + 头文件依赖】的形态，并放几张测试图。

    ★ 为什么要补：模板工程只有一个 camera.c、也没有 .h。
      而增量构建真正容易出错的地方恰恰是「多单元」与「头文件依赖」——
      单文件工程下，判据写错了（例如永远返回"需要重建"）也测不出来。
      这里额外造一个 shared.h + 两个 .c，两个 .c 都包含它，
      于是"改这个头文件应该让几个单元重编"就有了确定的答案。
    """
    proj = os.path.join(tmp, 'proj')
    shutil.copytree(TEMPLATE, proj, dirs_exist_ok=True)
    code_dir = os.path.join(proj, 'code')
    with open(os.path.join(code_dir, 'shared.h'), 'w',
              encoding='utf-8', newline='\n') as f:
        # ★ 用 static inline 而不是定义一个全局变量：这个头被两个 .c
        #   包含，写成 `int x;` 会得到 duplicate symbol ——
        #   那是测试工程自己的错，与增量无关（踩过一次）。
        f.write('#ifndef SCUT_TEST_SHARED_H\n'
                '#define SCUT_TEST_SHARED_H\n'
                'static inline int shared_bump(int v)\n'
                '{\n    return v + 1;\n}\n'
                '#endif\n')
    for name, add in (('extra_a.c', 1), ('extra_b.c', 2)):
        with open(os.path.join(code_dir, name), 'w',
                  encoding='utf-8', newline='\n') as f:
            f.write('#include "shared.h"\n'
                    'void %s(void)\n{\n'
                    '    (void)shared_bump(%d);\n}\n'
                    % (name[:-2] + '_step', add))
    cfg_path = os.path.join(proj, 'scut_project.json')
    with open(cfg_path, encoding='utf-8-sig') as f:
        cfg = json.load(f)
    cfg['hooks']['post'].append('extra_a_step')
    cfg['hooks']['post'].append('extra_b_step')
    with open(cfg_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    pics = tc.fixture_pic_dir()
    dst = os.path.join(proj, 'pic', '1')
    os.makedirs(dst, exist_ok=True)
    n = 0
    if os.path.isdir(pics):
        for f in sorted(os.listdir(pics))[:6]:
            if os.path.splitext(f)[1].lower() in ('.bmp', '.png'):
                shutil.copyfile(os.path.join(pics, f),
                                os.path.join(dst, '%d%s'
                                             % (n, os.path.splitext(f)[1])))
                n += 1
    return proj


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--toolchain', default='')
    args = ap.parse_args()
    clang_root = tc.require(args.toolchain)

    tmp = tempfile.mkdtemp(prefix='scut_incr_')
    try:
        proj = prepare(tmp)
        obj_dir = os.path.join(proj, '.scut', 'obj')
        gen_dir = os.path.join(proj, '.scut', 'gen')
        exe = os.path.join(proj, '.scut', 'bin', 'scut_sim.exe')
        code_dir = os.path.join(proj, 'code')
        srcs = sorted(f for f in os.listdir(code_dir) if f.endswith('.c'))

        print('\n=== 1. 冷构建：一切都该真的编译 ===')
        code, out, st = build(proj, clang_root)
        check(code == 0, '模板工程冷构建成功', out[-500:])
        check(os.path.isfile(exe), '产出了可执行文件')
        # ★ 断言的是"链接成功后留下了指纹"，而不是"冷构建时没有指纹"：
        #   冷构建确实会链接一次，链接成功后当然要写 stamp ——
        #   否则第二次构建永远命中不了。（这条一开始写反了，实测才发现。）
        check(os.path.isfile(os.path.join(obj_dir, 'link.stamp')),
              '冷构建链接成功后留下了链接指纹')
        check(len([f for f in os.listdir(obj_dir) if f.endswith('.d')]) >= len(srcs),
              '每个用户单元都留下了依赖文件（-MD）',
              str(os.listdir(obj_dir)))

        print('\n=== 2. 无改动：必须一个都不重编 ===')
        before = {f: mtime(os.path.join(obj_dir, f))
                  for f in os.listdir(obj_dir) if f.endswith('.o')}
        exe_before = mtime(exe)
        code, out, st = build(proj, clang_root)
        check(code == 0, '无改动构建成功')
        got, total = reused_count(out)
        check(total is not None and got == total,
              '所有用户单元都被复用（%s/%s）' % (got, total), out[-800:])
        check('[1/3 探针]' not in out and '[3/3 包装]' not in out,
              '没有启动任何编译器去编用户代码')
        check('未变化，复用' in out and 'bind' in out,
              'bind 单元被复用')
        check('接线单元未变化' in out, '接线单元被复用')
        check('后端 scut_headless_main.c 未变化' in out, '后端被复用')
        check('链接输入未变化' in out, '链接被复用')
        changed = [f for f, t in before.items()
                   if mtime(os.path.join(obj_dir, f)) != t]
        check(not changed, '目标文件的时间戳一个都没动', str(changed))
        check(mtime(exe) == exe_before, '可执行文件没有被重新生成')
        # 用户代码那一段应该只剩"读文件 + 哈希"，是个位数毫秒量级。
        us = user_stage(st)
        check(us is not None and us < 400,
              '「编译用户代码」这一段降到 %s ms' % us)

        print('\n=== 3. 改一个 .c：只有它重编 ===')
        target = os.path.join(code_dir, srcs[0])
        with open(target, 'a', encoding='utf-8', newline='\n') as f:
            f.write('\n/* incremental probe: %d */\n' % os.getpid())
        code, out, st = build(proj, clang_root)
        check(code == 0, '改一个 .c 后构建成功', out[-800:])
        got, total = reused_count(out)
        check(total is not None and got == total - 1,
              '恰好只有一个单元重编（复用 %s/%s）' % (got, total), out[-800:])
        check('[1/3 探针]' in out, '重编走了完整的探针 → 生成 → 包装')

        print('\n=== 4. 再跑一次：又该全部命中 ===')
        code, out, st = build(proj, clang_root)
        got, total = reused_count(out)
        check(code == 0 and got == total, '改完之后重新收敛到全部复用')

        print('\n=== 5. 改头文件：所有依赖它的单元都要重编 ===')
        # shared.h 被 extra_a.c 与 extra_b.c 包含（camera.c 不包含它）。
        hdr = os.path.join(code_dir, 'shared.h')
        if os.path.isfile(hdr):
            dep_units = []
            for d in os.listdir(obj_dir):
                if not d.endswith('.d'):
                    continue
                with open(os.path.join(obj_dir, d), encoding='utf-8',
                          errors='replace') as f:
                    if 'shared.h' in f.read():
                        dep_units.append(d[:-2] + '.o')
            check(len(dep_units) == 2, '恰好两个单元的依赖里有 shared.h',
                  str(dep_units))
            with open(hdr, 'a', encoding='utf-8', newline='\n') as f:
                f.write('\n/* header probe: %d */\n' % os.getpid())
            code, out, st = build(proj, clang_root)
            check(code == 0, '改头文件后构建成功', out[-800:])
            got, total = reused_count(out)
            check(total is not None and got == total - len(dep_units),
                  '只有依赖该头文件的 %d 个单元重编（复用 %s/%s）'
                  % (len(dep_units), got, total), out[-800:])
        else:
            check(False, '工程里没有 code/shared.h（测试需要它）')

        print('\n=== 6. 删掉 .d：判据必须判为「无法判断 → 重建」 ===')
        victim = os.path.join(obj_dir, srcs[0][:-2] + '.d')
        os.unlink(victim)
        code, out, st = build(proj, clang_root)
        check(code == 0, '删掉依赖文件后构建仍成功')
        got, total = reused_count(out)
        check(total is not None and got == total - 1,
              '缺依赖文件的那个单元重编了（其余仍复用）', out[-800:])
        check(os.path.isfile(victim), '重建后依赖文件又被写回来了')

        print('\n=== 7. 删掉 .o：当然要重编 ===')
        victim_o = os.path.join(obj_dir, srcs[-1][:-2] + '.o')
        os.unlink(victim_o)
        code, out, st = build(proj, clang_root)
        got, total = reused_count(out)
        check(code == 0 and total is not None and got == total - 1,
              '缺目标文件的那个单元重编了', out[-600:])

        print('\n=== 8. 改编译期契约（图像尺寸）：一切都要重编 ===')
        cfg_path = os.path.join(proj, 'scut_project.json')
        with open(cfg_path, encoding='utf-8-sig') as f:
            cfg = json.load(f)
        old_w = cfg['image']['width']
        cfg['image']['width'] = old_w - 1
        with open(cfg_path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        code, out, st = build(proj, clang_root)
        check(code == 0, '改图像尺寸后构建成功', out[-800:])
        got, total = reused_count(out)
        check(got == 0, '尺寸变了 → 用户单元一个都不复用（复用 %s/%s）'
              % (got, total), out[-800:])
        check('bind 单元未变化' not in out,
              '尺寸变了 → bind 单元也要重编（它带着尺寸契约）')
        # 还原
        cfg['image']['width'] = old_w
        with open(cfg_path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        code, out, st = build(proj, clang_root)
        check(code == 0, '还原尺寸后构建成功')

        print('\n=== 9. --no-watch 与默认模式不能互相复用错产物 ===')
        code, out, st = build(proj, clang_root, ['--no-watch'])
        check(code == 0, '--no-watch 构建成功', out[-800:])
        got, total = reused_count(out)
        check(got == 0, '--no-watch 不复用带符号发现的产物（复用 %s/%s）'
              % (got, total), out[-800:])
        code, out, st = build(proj, clang_root, ['--no-watch'])
        got, total = reused_count(out)
        check(code == 0 and got == total,
              '--no-watch 自己之间能命中（复用 %s/%s）' % (got, total))
        code, out, st = build(proj, clang_root)
        got, total = reused_count(out)
        check(got == 0, '切回默认模式也不复用 --no-watch 的产物（复用 %s/%s）'
              % (got, total), out[-800:])
        check(code == 0, '切回默认模式构建成功')

        print('\n=== 10. 批量符号发现 == 单文件符号发现（逐字节） ===')
        # ★ 这条是 C 项的正确性底线：把 N 次进程合成 1 次，
        #   输出必须与逐个跑【完全一样】。否则"更快"换来的是
        #   插件里变量面板悄悄少几个变量。
        probe = None
        for f in os.listdir(obj_dir):
            if f.endswith('.probe.o'):
                probe = os.path.join(obj_dir, f)
                break
        if probe:
            src_name = os.path.basename(probe)[:-len('.probe.o')] + '.c'
            single_c = os.path.join(tmp, 'single.c')
            single_j = os.path.join(tmp, 'single.json')
            r1 = subprocess.run(
                [sys.executable, SYMBOLS, '--obj', probe,
                 '--src', src_name, '--src-abs', os.path.join(code_dir, src_name),
                 '--out-c', single_c, '--out-json', single_j],
                capture_output=True, text=True, encoding='utf-8',
                errors='replace')
            batch_c = os.path.join(tmp, 'batchdir', 'single.c')
            batch_j = os.path.join(tmp, 'batchdir', 'single.json')
            os.makedirs(os.path.dirname(batch_c), exist_ok=True)
            # ★ 两次调用必须用【同样的输出文件名】：生成文件头里写着
            #   "AUTO-GENERATED ... <文件名>"，名字不同则逐字节比较必然不等，
            #   而那个差异与批量模式无关。放在不同目录、同名同基名。
            spec_path = os.path.join(tmp, 'spec.json')
            with open(spec_path, 'w', encoding='utf-8', newline='\n') as f:
                json.dump({'outputArray': '', 'exclude': '', 'maxElems': 0,
                           'imageSize': '',
                           'units': [{'obj': probe, 'src': src_name,
                                      'srcAbs': os.path.join(code_dir, src_name),
                                      'outC': batch_c, 'outJson': batch_j}]}, f)
            spec_out = os.path.join(tmp, 'spec.out.json')
            r2 = subprocess.run(
                [sys.executable, SYMBOLS, '--batch', spec_path,
                 '--batch-out', spec_out],
                capture_output=True, text=True, encoding='utf-8',
                errors='replace')
            check(r1.returncode == 0 and r2.returncode == 0,
                  '单文件与批量两种调用都成功',
                  (r1.stdout + r1.stderr + r2.stdout + r2.stderr)[-500:])
            if r1.returncode == 0 and r2.returncode == 0:
                with open(single_c, 'rb') as f:
                    a = f.read()
                with open(batch_c, 'rb') as f:
                    b = f.read()
                check(a == b, '生成的包装单元逐字节相同')
                with open(single_j, encoding='utf-8-sig') as f:
                    ja = json.load(f)
                with open(batch_j, encoding='utf-8-sig') as f:
                    jb = json.load(f)
                check(ja == jb, '变量清单逐字段相同')
                with open(spec_out, encoding='utf-8') as f:
                    res = json.load(f)
                check(res.get('units', [{}])[0].get('code') == 0,
                      '批量结果里这一单元的退出码是 0', str(res))
        else:
            check(False, '找不到探针目标文件（测试需要它）')

        print('\n=== 11. 增量之后程序真的还能跑 ===')
        # ★ 只断言"构建成功"是不够的：复用的可能是错的 .o。
        #   这里真的跑一遍，确认画面不是全黑（复用路径没把程序搞坏）。
        rr = subprocess.run([exe, '--frames', '2', '--json'],
                            cwd=proj, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=180)
        frames = [l for l in (rr.stdout or '').splitlines() if '"frame"' in l]
        check(rr.returncode == 0 and len(frames) >= 2,
              '增量构建出的程序能跑出帧', (rr.stdout or '')[-300:])

        print('\n=== 12. 降级不能被固化（一次失败不能变成永久少变量）===')
        # ★ 这条守的是一个真实踩到的缺陷：
        #   降级（探针失败 / 生成器起不来 / 生成物落盘失败）是【一次性事件】，
        #   但指纹里没有任何一项能反映"上次降级了"——同样的源码与命令行，
        #   降级前后算出来的 fp 完全一样。于是复用旧 stamp 等于把降级固化：
        #   变量面板永远少这个文件的变量，且不再有任何警告。
        #   这里把 stamp 改成 wrapper=False（= 模拟上次降级过），
        #   然后【不改任何代码】再构建一次：必须自己恢复成包装单元。
        stamp_path = os.path.join(obj_dir, 'camera.stamp')
        if os.path.isfile(stamp_path):
            with open(stamp_path, encoding='utf-8') as f:
                saved = json.load(f)
            forced = dict(saved)
            forced['wrapper'] = False
            with open(stamp_path, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(forced, f)
            code, out, st = build(proj, clang_root)
            check(code == 0, '「上次降级过」的工程仍能构建成功', out[-400:])
            with open(stamp_path, encoding='utf-8') as f:
                after = json.load(f)
            check(after.get('wrapper') is True,
                  '一次降级不会永久固化：下次构建自动恢复成包装单元',
                  'stamp=%s' % after)
            # 变量清单必须回来（降级时它是不生成的）
            mf = os.path.join(gen_dir, 'variables.json')
            check(os.path.isfile(mf), '恢复后变量清单重新生成')
            if os.path.isfile(mf):
                with open(mf, encoding='utf-8') as f:
                    man = json.load(f)
                check(man.get('count', 0) > 0,
                      '恢复后变量清单非空（%d 个）' % man.get('count', 0))
        else:
            check(False, '找不到 camera.stamp（测试需要它）')

        print('\n=== 13. 额外库换了内容必须重新链接 ===')
        # ★ 另一个真实踩到的缺陷：scut.extra.mk 里写的是 `-lfoo`（名字），
        #   只把名字放进链接指纹 → 库换了内容指纹不变 → 一直复用旧 exe，
        #   用户更新的第三方库永远进不去，而且没有任何提示。
        mk = os.path.join(proj, 'scut.extra.mk')
        libdir = os.path.join(proj, 'third')
        os.makedirs(libdir, exist_ok=True)
        lib_c = os.path.join(libdir, 'h.c')
        lib_o = os.path.join(libdir, 'h.o')
        lib_a = os.path.join(libdir, 'libextra.a')
        ar = None
        for cand in ('llvm-ar.exe', 'ar.exe'):
            p = os.path.join(clang_root, 'bin', cand)
            if os.path.isfile(p):
                ar = p
                break
        if ar:
            def _pack(val):
                with open(lib_c, 'w', encoding='utf-8', newline='\n') as f:
                    f.write('int extra_helper(void){return %d;}\n' % val)
                subprocess.run([os.path.join(clang_root, 'bin', 'clang.exe'),
                                '-c', lib_c, '-o', lib_o],
                               capture_output=True, timeout=180)
                if os.path.isfile(lib_a):
                    os.unlink(lib_a)
                subprocess.run([ar, 'rcs', lib_a, lib_o],
                               capture_output=True, timeout=180)

            _pack(7)
            with open(mk, 'w', encoding='utf-8', newline='\n') as f:
                f.write('-Lthird\n-lextra\n')
            code, out, st = build(proj, clang_root)
            check(code == 0, '带额外库的工程构建成功', out[-400:])
            link_stamp = os.path.join(obj_dir, 'link.stamp')
            fp1 = ''
            if os.path.isfile(link_stamp):
                with open(link_stamp, encoding='utf-8') as f:
                    fp1 = json.load(f).get('fp', '')
            # 只换库的实现，源码一个字不动
            _pack(99)
            code, out, st = build(proj, clang_root)
            fp2 = ''
            if os.path.isfile(link_stamp):
                with open(link_stamp, encoding='utf-8') as f:
                    fp2 = json.load(f).get('fp', '')
            check(bool(fp1) and fp1 != fp2,
                  '额外库内容变了，链接指纹随之改变（不会复用旧 exe）',
                  'fp1=%s fp2=%s' % (fp1[:12], fp2[:12]))
            check(st.get('链接', 0) > 0,
                  '额外库变了之后确实重新链接了',
                  '链接 %s ms' % st.get('链接'))
            os.unlink(mk)
        else:
            check(False, '找不到 ar（测试需要它来打包静态库）')

        print('\n=== 14. exe 被占用时给的是人话，不是调用栈 ===')
        # ★ Windows 对运行中的 exe 独占写锁。这条失败路径原先会冒到
        #   顶层兜底，报成"构建脚本内部错误，请把调用栈贴给我们"——
        #   而那恰恰是最常见、最该给一句可执行提示的场景。
        try:
            import subprocess as _sp
            running = _sp.Popen([exe, '--frames', '9999'],
                                cwd=proj, stdout=_sp.DEVNULL,
                                stderr=_sp.DEVNULL)
        except Exception:
            running = None
        if running is not None:
            try:
                import time as _t
                _t.sleep(0.8)
                # 改一行代码，逼它重新链接 → 撞上被占用的 exe
                with open(os.path.join(code_dir, 'extra_a.c'), 'a',
                          encoding='utf-8', newline='\n') as f:
                    f.write('\n/* touch to force relink */\n')
                code, out, st = build(proj, clang_root)
                check('正在被占用' in out or '无法写入可执行文件' in out,
                      'exe 被占用时给出「关掉进程再编译」的人话', out[-400:])
                check('构建脚本内部出现未预期的错误' not in out,
                      'exe 被占用不会被误报成「脚本 bug」', out[-400:])
            finally:
                try:
                    running.kill()
                except Exception:
                    pass
        else:
            check(False, '无法启动仿真进程（测试需要它）')

        print('\n=== 15. 清理：只删生成物，且真的让增量归零 ===')
        # ★ 这条守的是「清理」这个按钮的语义边界。它有两种坏法，
        #   而且都很难在事后发现：
        #     · 删多了 → 用户的 code/ 或图集没了。这是不可逆的事故。
        #     · 删少了 → 生成物还在，清理"成功"了但增量判据照样命中，
        #                用户以为回到了干净状态，其实没有。
        #   所以下面同时验证"该没的没了"和"该在的都在"。
        def clean(extra=None):
            cmd = [sys.executable, BUILD, 'clean', '--project', proj, '--json']
            env2 = dict(os.environ)
            env2['PYTHONIOENCODING'] = 'utf-8'
            env2['PYTHONUTF8'] = '1'
            r = subprocess.run(cmd, capture_output=True, text=True,
                               encoding='utf-8', errors='replace',
                               env=env2, timeout=300)
            try:
                payload = json.loads(r.stdout)
            except Exception:
                payload = {}
            return r.returncode, (r.stdout or '') + (r.stderr or ''), payload

        # 清理前记下用户资产的指纹：清理一个字节都不许动它们。
        user_files = []
        for dirpath, _dirs, files in os.walk(code_dir):
            for f in files:
                user_files.append(os.path.join(dirpath, f))
        user_files.append(os.path.join(proj, 'scut_project.json'))
        user_before = {}
        for p in user_files:
            with open(p, 'rb') as fh:
                user_before[p] = fh.read()

        code, out, payload = clean()
        check(code == 0 and payload.get('ok') is True,
              'clean 退出码 0 且 JSON 报 ok', out[-500:])
        check(payload.get('removed') == os.path.join(proj, '.scut')
              or (payload.get('removed') or '').endswith('.scut'),
              'clean 报回了删掉的目录', str(payload.get('removed')))
        check(not os.path.isdir(os.path.join(proj, '.scut')),
              '生成物目录 .scut 真的没了')

        # ★ 用户资产必须一个字节都没变。
        changed = [p for p, b in user_before.items()
                   if (not os.path.isfile(p))
                   or open(p, 'rb').read() != b]
        check(not changed,
              'code/ 与 scut_project.json 一个字节都没动',
              str([os.path.basename(c) for c in changed]))

        # ★ 清理之后再编译必须是【全量】：一个都不该复用。
        code, out, st = build(proj, clang_root)
        check(code == 0, '清理后仍能构建成功', out[-800:])
        got, total = reused_count(out)
        check(total is not None and got == 0,
              '清理后第一次构建是全新的（复用 0/%s）' % total, out[-800:])
        check(os.path.isfile(exe), '清理后重新产出了可执行文件')

        # ★ 第二次构建又要回到全部复用 —— 证明"清理"没有把增量永久关掉。
        code, out, st = build(proj, clang_root)
        got, total = reused_count(out)
        check(code == 0 and total is not None and got == total,
              '清理后再编一次又收敛到全部复用（%s/%s）' % (got, total))

        # ★ 空工程上 clean 也必须成功（幂等），不能报错。
        #   ★ 顺序要紧：先删掉 .scut，再 clean —— 上面那次构建又把它建出来了。
        #     这里手工删而不是再 clean 一次，是为了让"确实没有 .scut"
        #     这个前置条件是测试自己保证的，不依赖被测代码。
        shutil.rmtree(os.path.join(proj, '.scut'), ignore_errors=True)
        code, out, payload = clean()
        check(code == 0 and payload.get('ok') is True,
              '生成物本来就不存在时 clean 也成功（幂等）', out[-400:])
        check(payload.get('removed') is None,
              '没有可删的东西时 removed 为 null', str(payload.get('removed')))

        # ★★ 清理失败时不许留下"删了一半"的 .scut ★★
        #
        #   这是"先改名再删"这个实现的核心理由：直接 rmtree 的失败结果
        #   【不可预测】—— 它按 scandir 顺序逐项删，撞上第一个删不掉的才抛，
        #   而在此之前删掉的东西已经没了。锁 exe 时 bin/ 恰好排首位，
        #   于是什么都没删（运气）；锁 obj/ 里的文件时，排在它前面的
        #   十几项全被删（实测过）。所以判据要覆盖"可能删了一半"而不是
        #   只盯着"exe 被锁"这一种现场。
        #
        # ★ 判据必须是【内容完整】而不是"目录还在"：直接 rmtree 失败时
        #   .scut 目录【也还在】（只是缺了一部分），拿 isdir 当判据会
        #   让这条测试对那个缺陷完全无感 —— 实测过，第一版就是假绿的。
        #   所以这里比较"失败前后的完整清单"，要求逐项一致。
        def snapshot(root):
            """列出 .scut 下全部相对路径（含空目录），用于比对是否原样。"""
            items = []
            for dirpath, dirnames, filenames in os.walk(root):
                for d in dirnames:
                    items.append(os.path.relpath(os.path.join(dirpath, d), root)
                                 + '/')
                for f in filenames:
                    items.append(os.path.relpath(os.path.join(dirpath, f), root))
            return sorted(items)

        # ★★ 机制级验证：直接证明"rmtree 能部分删除"★★
        #
        #   上面那个"锁 exe"的现场是【运气驱动】的：bin/ 恰好排在 scandir
        #   首位被先撞上，于是什么都没删 —— 一个用 rmtree 的实现照样能过。
        #   这里用 msvcrt 锁住一个排在后面的文件，把"删了一半"这个事实
        #   钉成断言。它守的不是 clean 的行为，而是 clean 那个实现选择的
        #   【理由】：如果哪天有人把"先改名再删"简化回 rmtree，理由是假的。
        try:
            import msvcrt as _msvcrt

            part = os.path.join(tmp, 'partprobe')
            for d in ('aaa', 'obj'):
                os.makedirs(os.path.join(part, d), exist_ok=True)
                for i in range(3):
                    with open(os.path.join(part, d, 'f%d.dat' % i), 'wb') as fh:
                        fh.write(b'x' * 50)
            part_before = snapshot(part)
            locked = os.path.join(part, 'obj', 'f1.dat')
            with open(locked, 'rb') as fh:
                _msvcrt.locking(fh.fileno(), _msvcrt.LK_NBLCK, 1)
                try:
                    shutil.rmtree(part)
                    rmtree_raised = False
                except OSError:
                    rmtree_raised = True
                part_after = snapshot(part) if os.path.isdir(part) else []
            gone = [i for i in part_before if i not in part_after]
            check(rmtree_raised, 'rmtree 撞上被锁文件时确实抛异常')
            check(len(gone) > 0,
                  'rmtree 失败时会【部分删除】（这就是不能直接 rmtree 的理由）',
                  '本次删掉了 %d/%d 项' % (len(gone), len(part_before)))
            shutil.rmtree(part, ignore_errors=True)
        except ImportError:
            # 非 Windows 没有 msvcrt。这条是 Windows 专属的机制验证，
            # 明确跳过并说明，而不是安静通过。
            print('  SKIP  msvcrt 不可用（非 Windows），跳过 rmtree 部分删除验证')

        # ★ 前置条件：得先有一个 exe 才能把它跑起来（上面刚把 .scut 删了）。
        code, out, st = build(proj, clang_root)
        check(code == 0 and os.path.isfile(exe),
              '失败路径测试前重新构建出了 exe', out[-400:])
        try:
            import subprocess as _sp2
            import time as _t2
            scut_path = os.path.join(proj, '.scut')
            before_items = snapshot(scut_path)
            check(len(before_items) > 5,
                  '失败路径测试前 .scut 里确实有内容可删', str(len(before_items)))
            running2 = _sp2.Popen([exe, '--frames', '9999'], cwd=proj,
                                  stdout=_sp2.DEVNULL, stderr=_sp2.DEVNULL)
            try:
                _t2.sleep(0.8)
                code, out, payload = clean()
                # 结果只允许两种，绝不允许第三种"删了一半"：
                #   ① 报成功 → .scut 必须完全消失；
                #   ② 报失败 → .scut 的内容必须【逐项与失败前一致】。
                if payload.get('ok') is True:
                    check(not os.path.isdir(scut_path),
                          'exe 在跑时 clean 若报成功，则 .scut 必须已完全消失',
                          out[-400:])
                else:
                    after_items = snapshot(scut_path) if os.path.isdir(scut_path) else []
                    missing = [i for i in before_items if i not in after_items]
                    check(not missing,
                          'clean 报失败时 .scut 必须原样还在（不许删一半）',
                          '少了 %d 项，例如 %s' % (len(missing), missing[:6]))
                check('构建脚本内部出现未预期的错误' not in out,
                      'clean 被占用时不报成「脚本 bug」', out[-400:])
            finally:
                try:
                    running2.kill()
                except Exception:
                    pass
            _t2.sleep(0.3)

            # ★★ 残留目录那条：必须【先真的造出一个 .scut.deleting-*】再验，
            #   否则它会变成一条永远为真的空断言（第一版就是这样假绿的：
            #   变异版根本不创建这个目录，于是"没有残留"恒成立）。
            #   造法：先建出 .scut，再手工改名成 .scut.deleting-99999，
            #   模拟"改名成功但删不动、进程随后被杀"的残留现场。
            # ★ 不能指望上一步留下的 .scut —— 上面 clean 很可能已经成功
            #   （改名不碰文件内容，exe 在跑也能改），那时 .scut 已经不在了。
            #   所以这里无条件重新构建一次，让前置条件由测试自己保证。
            code, out, st = build(proj, clang_root)
            check(code == 0 and os.path.isdir(scut_path),
                  '为了造残留现场，先重新构建出 .scut', out[-400:])
            trash = scut_path + '.deleting-99999'
            if os.path.isdir(trash):
                shutil.rmtree(trash, ignore_errors=True)
            if os.path.isdir(scut_path):
                os.replace(scut_path, trash)
            check(os.path.isdir(trash),
                  '造出了一个 .scut.deleting-* 残留现场（前置条件）')
            code, out, st = build(proj, clang_root)
            left = [n for n in os.listdir(proj) if n.startswith('.scut.deleting-')]
            check(code == 0 and not left,
                  '上次删失败留下的 .scut.deleting-* 被下次构建扫掉',
                  '仍残留：%s' % left)
            check(os.path.isdir(scut_path),
                  '扫掉残留之后，构建自己把新的 .scut 建了出来')

            # 收尾：进程退出后 clean 能正常完成。
            code, out, payload = clean()
            check(code == 0 and payload.get('ok') is True,
                  '进程退出后 clean 能正常完成', out[-400:])
            check(not os.path.isdir(scut_path), '恢复后 .scut 已删干净')
        except Exception as exc:                       # noqa: BLE001
            check(False, '清理失败路径的测试自身出错：%s' % exc)

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('\n' + '=' * 60)
    if FAIL == 0:
        print('全部 %d 项通过' % PASS)
    else:
        print('%d/%d 项通过，%d 项失败：' % (PASS, PASS + FAIL, FAIL))
        for f in FAILED:
            print('  - %s' % f)
    print('=' * 60)
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
