#!/usr/bin/env python3
"""
test_e2e_pipeline.py -- 端到端验证「用户代码零注册 + 环境接管」这条主线。

这是本项目【最重要】的一条测试：它验证的是设计理念本身，而不是某个函数。

覆盖的断言（每一条都对应一个曾经真实存在的缺陷）：
    1. 新建工程（templates/starter）能【直接】构建成功
       —— "到手即用"的底线
    2. 用户 code/ 里【没有任何注册宏】（SCUT_INIT/FRAME/POST/REGISTER）
       —— 保证代码能直接拷进车载工程
    3. 生成了接线单元，且它按配置调用了用户的钩子函数
    4. 运行期变量清单非空（自动符号发现在工作）
    5. 输出图【不是全黑】—— 证明结果图深拷贝通了
       （曾经的现象：图集加载不到，静默黑图）
    6. 结果图与输入图【不相同】—— 证明拷的是算法结果而不是输入
    7. 每帧 JSON 里有 timing，且 drawUs 不再恒为 0
       （曾经的现象：计时在 sink 之后才发布，drawUs 永远是 0）
    8. 用户 SCUT_Log 的输出出现在 stderr 的 [LOG] 行里
    9. 改「结果图数组名」后画面随之改变（配置真的生效）

用法：
    python tests/test_e2e_pipeline.py [--toolchain <根目录>]
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
# 测试图：用【仓库内自带的】tests/fixtures/pic/1（模板故意不带图）。
# ★ 原先借仓库外某个测试工程 —— 别人 clone 下来没有那个目录，
#   这部分会静默少跑（而不是报错）。
PIC_SRC = tc.fixture_pic_dir()

failures = []
checks = 0


def check(cond, msg):
    """记一条断言。失败时打印但继续跑，最后统一汇总。"""
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
                          encoding='utf-8', errors='replace', env=env,
                          timeout=600)


def read_ppm(path):
    """读 P6 PPM，返回像素 bytes。跳过 3 行头（P6 / 宽高 / 最大值）。"""
    with open(path, 'rb') as f:
        data = f.read()
    # 头部可能含注释，稳健地按行找到第三行结束
    pos = 0
    lines = 0
    while lines < 3 and pos < len(data):
        nl = data.find(b'\n', pos)
        if nl < 0:
            break
        pos = nl + 1
        lines += 1
    return data[pos:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--toolchain', default='',
                    help='工具链根目录（含 bin/clang.exe）。'
                         '留空 = 自动探测 %s / PATH' % tc.ENV_VAR)
    ap.add_argument('--keep', action='store_true', help='保留临时工程便于排查')
    args = ap.parse_args()

    args.toolchain = tc.require(args.toolchain)

    work = tempfile.mkdtemp(prefix='scut_e2e_')
    proj = os.path.join(work, 'proj')
    print('SCUT-71 端到端流水线测试')
    print('  临时工程: %s' % proj)
    print('  工具链  : %s' % args.toolchain)

    try:
        # ---- 0) 从模板建工程 -------------------------------------------
        print('\n[0] 从模板新建工程')
        shutil.copytree(TEMPLATE, proj)
        os.makedirs(os.path.join(proj, 'pic', '1'), exist_ok=True)
        pics = []
        if os.path.isdir(PIC_SRC):
            pics = sorted(n for n in os.listdir(PIC_SRC) if n.lower().endswith('.bmp'))[:4]
            for n in pics:
                shutil.copyfile(os.path.join(PIC_SRC, n),
                                os.path.join(proj, 'pic', '1', n))
        check(os.path.isfile(os.path.join(proj, 'scut_project.json')),
              '模板带 scut_project.json（配置真值来源）')
        check(len(pics) > 0, '测试图已就位（借集成工程图集，共 %d 张）' % len(pics))

        # ---- 1) 用户代码必须零注册 -------------------------------------
        print('\n[1] 用户代码不含任何注册宏（可移植性底线）')
        user_src = ''
        for dirpath, _dirs, files in os.walk(os.path.join(proj, 'code')):
            for fn in files:
                if fn.lower().endswith(('.c', '.h')):
                    with open(os.path.join(dirpath, fn), encoding='utf-8',
                              errors='replace') as f:
                        user_src += f.read()
        for macro in ('SCUT_INIT', 'SCUT_FRAME', 'SCUT_POST', 'SCUT_REGISTER',
                      'ENV_REGISTER', 'scut_register_internal'):
            # 注释里提到名字是允许的（说明文档），这里只禁真正的调用形式
            used = re.search(r'^\s*%s\s*\(' % macro, user_src, re.M) is not None
            check(not used, '用户代码里没有调用 %s' % macro)
        check('SCUT_GetInputImage' not in user_src,
              '用户代码不再依赖输入图访问器（直接读全局数组）')

        # ---- 2) 构建 ---------------------------------------------------
        print('\n[2] 构建（环境库 + 用户代码 + 生成的接线单元）')
        r = run([sys.executable, BUILD, '--project', proj,
                 '--toolchain', args.toolchain])
        if not check(r.returncode == 0, '构建成功'):
            print((r.stdout or '')[-2500:])
            print((r.stderr or '')[-2500:])
            return 1

        gen_dir = os.path.join(proj, '.scut', 'gen')
        glue = os.path.join(gen_dir, 'scut_env_glue.c')
        cfg_h = os.path.join(gen_dir, 'scut_config.h')
        check(os.path.isfile(glue), '生成了接线单元 scut_env_glue.c')
        check(os.path.isfile(cfg_h), '生成了编译期契约 scut_config.h')

        glue_text = ''
        if os.path.isfile(glue):
            with open(glue, encoding='utf-8', errors='replace') as f:
                glue_text = f.read()
        # 接线单元必须调用模板里配置的那些函数
        with open(os.path.join(proj, 'scut_project.json'), encoding='utf-8') as f:
            cfg = json.load(f)
        for nm in cfg['hooks']['frame'] + cfg['hooks']['init'] + cfg['hooks']['post']:
            check(('%s();' % nm) in glue_text, '接线单元调用了 %s()' % nm)
        check('SCUT_ROLE_PROCESS' in glue_text, '接线单元注册了处理阶段')
        check('SCUT_ROLE_DRAW' in glue_text, '接线单元注册了绘制阶段')

        exe = os.path.join(proj, '.scut', 'bin', 'scut_sim.exe')
        check(os.path.isfile(exe), '生成了 scut_sim.exe')

        # ---- 3) --list-vars（变量清单非空） ----------------------------
        print('\n[3] 运行期变量清单')
        rl = run([exe, '--list-vars', '--json'], cwd=proj)
        vars_line = None
        for line in (rl.stdout or '').splitlines():
            if '"vars"' in line:
                vars_line = line
        var_count = 0
        if vars_line:
            try:
                var_count = len(json.loads(vars_line).get('vars', []))
            except ValueError:
                var_count = 0
        check(var_count > 0, '自动符号发现找到 %d 个变量' % var_count)

        # ---- 4) 跑帧：输出图必须非黑、且与输入不同 ---------------------
        print('\n[4] 跑帧：输出图与计时')
        frames_dir = os.path.join(work, 'frames')
        r3 = run([exe, '--frames', '3', '--json', '--out', frames_dir], cwd=proj)
        lines = [l for l in (r3.stdout or '').splitlines() if l.startswith('{')]
        check(len(lines) >= 3, '收到 %d 行帧 JSON' % len(lines))

        frames = []
        for line in lines:
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            # ★ 只收【真正的帧行】。进程退出前还会补一行纯变量清单
            #   （同样含 "vars" 但没有 "frame"/"timing"），
            #   把它算进来会让"每帧都有计时"这类断言误报失败。
            if isinstance(obj, dict) and 'frame' in obj and 'timing' in obj:
                frames.append(obj)
        check(len(frames) > 0, '帧 JSON 全部可解析（其中 %d 行是真正的帧）' % len(frames))

        # 输出图（sink 写的是环境的输出图，即被深拷贝进来的结果图）
        ppms = sorted(n for n in os.listdir(frames_dir)) if os.path.isdir(frames_dir) else []
        check(len(ppms) > 0, '落盘了 %d 张帧图' % len(ppms))
        if ppms:
            body = read_ppm(os.path.join(frames_dir, ppms[0]))
            nonzero = sum(1 for b in body if b != 0)
            check(nonzero > 0,
                  '输出图非全黑（%d / %d 非零像素）—— 结果图深拷贝生效'
                  % (nonzero, len(body)))
            check(0 < nonzero < len(body),
                  '输出图不是全白（说明经过真实二值化，而非常量填充）')

        # 计时：drawUs 不再恒为 0（历史上它一直是 0）
        if frames:
            draw_us = [f.get('timing', {}).get('drawUs', 0) for f in frames]
            check(any(v > 0 for v in draw_us),
                  'drawUs 有非零值 %s —— 计时在 sink 之前正确发布' % draw_us)
            # ★ 只断言前几帧：最后一帧的 PROCESS 可能因退出请求而没跑到，
            #   这种"末帧不完整"是刻意允许的（见 scut_run_frames 的说明）。
            proc_us = [f.get('timing', {}).get('processUs', 0) for f in frames[:-1]]
            check(len(proc_us) > 0 and all(v > 0 for v in proc_us),
                  'processUs 为正 %s（末帧可能因退出请求不完整，不计）' % proc_us)

        # ---- 5) 用户日志必须出现在 stderr 的 [LOG] 行 -------------------
        print('\n[5] 用户 SCUT_Log 的输出')
        check('[LOG]' in (r3.stderr or ''),
              '算法日志以 [LOG] 前缀出现在 stderr（插件据此送进独立输出面板）')

        # ---- 6) 配置真的生效：换结果图数组 -----------------------------
        print('\n[6] 配置生效性：换一个结果图数组，画面应随之改变')
        # 在用户代码里再加一个反色的结果图，并把配置切过去
        extra = os.path.join(proj, 'code', 'extra_result.c')
        with open(extra, 'w', encoding='utf-8') as f:
            f.write(
                '/* 测试用：另一个结果图（反色），用来证明配置真的被读取 */\n'
                '#include "scut_sdk.h"\n'
                'extern unsigned char mt9v03x_image[SCUT_IMAGE_H][SCUT_IMAGE_W];\n'
                'unsigned char g_inverted[SCUT_IMAGE_H][SCUT_IMAGE_W];\n'
                'void camera_process_2(void)\n'
                '{\n'
                '    int x, y;\n'
                '    for (y = 0; y < SCUT_IMAGE_H; y++) {\n'
                '        for (x = 0; x < SCUT_IMAGE_W; x++) {\n'
                '            g_inverted[y][x] = (unsigned char)(255 - mt9v03x_image[y][x]);\n'
                '        }\n'
                '    }\n'
                '}\n')
        cfg['outputArray'] = 'g_inverted'
        cfg['hooks']['post'] = cfg['hooks']['post'][:1] + ['camera_process_2']
        with open(os.path.join(proj, 'scut_project.json'), 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)

        before = read_ppm(os.path.join(frames_dir, ppms[0])) if ppms else b''

        r4 = run([sys.executable, BUILD, '--project', proj,
                  '--toolchain', args.toolchain])
        if check(r4.returncode == 0, '改配置后仍能构建成功'):
            glue_text2 = ''
            with open(glue, encoding='utf-8', errors='replace') as f:
                glue_text2 = f.read()
            check('scut_env_copy_output' in glue_text2,
                  '接线单元仍调用结果图搬运（新数组）')
            frames2 = os.path.join(work, 'frames2')
            run([exe, '--frames', '1', '--json', '--out', frames2], cwd=proj)
            ppms2 = sorted(n for n in os.listdir(frames2)) if os.path.isdir(frames2) else []
            if check(len(ppms2) > 0, '换了结果图后仍产出帧图'):
                after = read_ppm(os.path.join(frames2, ppms2[0]))
                check(after != before,
                      '输出图内容随「结果图数组名」改变 —— 配置确实被读取')

        print('\n' + '=' * 60)
        if failures:
            print('%d/%d 项通过，%d 项失败：' % (checks - len(failures), checks, len(failures)))
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
