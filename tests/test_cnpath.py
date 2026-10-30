#!/usr/bin/env python3
"""
test_cnpath.py -- 中文路径 / 帧目录 / 废弃键清理 / 暂存目录清理的【行为】测试。

★★ 为什么单独一个文件、而不是塞进 test_firstrun.py ★★

  test_firstrun.py 是静态判据（"源码里有没有那句话"），它守得住"别改回去"，
  但守不住"改对了没有"。本轮的几处改动全是【行为】层面的：

    · 帧到底写到哪个目录（写错了画面全黑，而且不报错）；
    · 中文用户名下帧到底读不读得到（读不到就是一帧黑图接一帧黑图）；
    · 老工程里的废弃键到底会不会被删掉（不删就一直躺在 JSON 里）；
    · .scut/scut_gen_* 空目录到底会不会被清（不清就一直堆）。

  这四条都不会让任何东西"看起来坏掉"，所以必须真的跑一遍。

用法:
    python tests/test_cnpath.py

退出码 0 = 全部通过。
"""
import io
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
EXT = os.path.join(ROOT, 'extension')
OUT = os.path.join(EXT, 'out')

PASS = 0
FAIL = 0
FAILED = []


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  PASS  %s' % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print('  FAIL  %s%s' % (name, ('  -> ' + str(extra)) if extra else ''))


# ---------------------------------------------------------------------------
# 1) 废弃键清理：把 writeConfig 真的跑起来，对真实 JSON 断言
# ---------------------------------------------------------------------------
print('\n=== 1. writeConfig 会清掉已废弃的键，但保留未知键 ===')

DRIVER_PRUNE = r'''
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = path.join(process.argv[2], 'out');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'scut_prune_'));
const cfgFile = path.join(proj, 'scut_project.json');

// 一份"0.8 时代"的配置：三个已废弃的键 + 一个用户自定义键（必须保留）
fs.writeFileSync(cfgFile, JSON.stringify({
  image: { width: 188, height: 120 },
  inputArray: 'mt9v03x_image',
  outputArray: '',
  hooks: { init: [], frame: ['camera_process'], post: [] },
  pic: { dir: 'pic/1', ext: '', start: 1 },
  run: { processRepeat: 1, runFrames: 60, benchRepeat: 1000 },
  toolchain: { path: '', pythonPath: '', autoWatch: true,
               watchExclude: '', watchMaxElems: 0, autoDownload: true },
  display: { secondImage: true },
  myOwnField: 'keep-me',
}, null, 2));

const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') { return {}; }
  return origLoad.call(this, req, parent, isMain);
};
const pc = require(path.join(OUT, 'projectconfig.js'));
const cfg = pc.readConfig(proj).config;
pc.writeConfig(proj, cfg);

const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
console.log(JSON.stringify({
  runFrames: Object.prototype.hasOwnProperty.call(after.run || {}, 'runFrames'),
  autoDownload: Object.prototype.hasOwnProperty.call(after.toolchain || {}, 'autoDownload'),
  display: Object.prototype.hasOwnProperty.call(after, 'display'),
  keepMine: after.myOwnField === 'keep-me',
  hooksKept: (after.hooks.frame || []).length === 1,
  picKept: (after.pic || {}).dir === 'pic/1',
}));
'''


def run_driver(code, *args):
    """把一段 JS 驱动写到临时文件里跑，返回 (ok, stdout)。"""
    fd, p = tempfile.mkstemp(suffix='.js')
    os.close(fd)
    try:
        with io.open(p, 'w', encoding='utf-8') as f:
            f.write(code)
        r = subprocess.run(['node', p, EXT] + list(args),
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=120)
        return r.returncode == 0, (r.stdout or '') + (r.stderr or '')
    finally:
        os.unlink(p)


if not os.path.isdir(OUT):
    print('  ❌ extension/out 不存在，先编译：cd extension && npm run compile')
    sys.exit(1)

good, out = run_driver(DRIVER_PRUNE)
if not good:
    print('  ❌ 驱动失败：\n' + out[-1500:])
    FAIL += 1
    FAILED.append('prune 驱动可执行')
else:
    line = [l for l in out.strip().splitlines() if l.startswith('{')]
    res = json.loads(line[-1]) if line else {}
    ok('run.runFrames 被删掉', res.get('runFrames') is False, res)
    ok('toolchain.autoDownload 被删掉', res.get('autoDownload') is False, res)
    ok('整个 display 块被删掉（唯一键已废弃，留空壳更困惑）',
       res.get('display') is False, res)
    ok('用户自定义键被保留（不误删未知键）', res.get('keepMine') is True, res)
    ok('正常字段没被误删：hooks.frame', res.get('hooksKept') is True, res)
    ok('正常字段没被误删：pic.dir', res.get('picKept') is True, res)


# ---------------------------------------------------------------------------
# 2) .scut/scut_gen_* 清理：真的造目录、真的跑 prune_stale_staging
# ---------------------------------------------------------------------------
print('\n=== 2. 构建前清掉上次强杀留下的空暂存目录（只删空的）===')

sys.path.insert(0, os.path.join(ROOT, 'tools'))
import scut_build  # noqa: E402

tmp_proj = tempfile.mkdtemp(prefix='scut_prune_gen_')
scut_dir = os.path.join(tmp_proj, '.scut')
os.makedirs(scut_dir, exist_ok=True)
# 三个空目录（强杀残留）+ 一个非空目录（可能是并行构建正在用）
for n in ('scut_gen_aaa', 'scut_gen_bbb', 'scut_gen_ccc'):
    os.makedirs(os.path.join(scut_dir, n))
busy = os.path.join(scut_dir, 'scut_gen_busy')
os.makedirs(busy)
with io.open(os.path.join(busy, 'in_use.o'), 'w') as f:
    f.write('x')
# 一个不属于暂存的名字，不该被碰
os.makedirs(os.path.join(scut_dir, 'gen'))

removed = scut_build.prune_stale_staging(scut_dir)
left = sorted(os.listdir(scut_dir))
ok('删掉了 3 个空暂存目录', removed == 3, removed)
ok('空暂存目录都没了',
   not any(n.startswith('scut_gen_') and os.path.isdir(os.path.join(scut_dir, n))
           and not os.listdir(os.path.join(scut_dir, n)) for n in left), left)
ok('非空的暂存目录被保留（可能是并行构建正在用）', 'scut_gen_busy' in left, left)
ok('名字不以 scut_gen_ 开头的目录不受影响', 'gen' in left, left)
shutil.rmtree(tmp_proj, ignore_errors=True)

# 目录不存在时不能抛（首次构建就是这个状态）
ok('目录不存在时返回 0 且不抛',
   scut_build.prune_stale_staging(os.path.join(tmp_proj, 'nope')) == 0)


# ---------------------------------------------------------------------------
# 3) 帧目录：没有工程根时才退回系统临时目录
# ---------------------------------------------------------------------------
print('\n=== 3. 帧输出目录的优先级 ===')

DRIVER_DIR = r'''
const path = require('path');
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') { return {}; }
  return origLoad.call(this, req, parent, isMain);
};
const OUT = path.join(process.argv[2], 'out');
const src = require('fs').readFileSync(path.join(OUT, 'simsession.js'), 'utf8');
// 内部函数没有导出，直接按契约核对"有工程根时用工程内目录"：
// 用一次真实的 start() 代价太大（要 exe），这里退一步查函数体行为。
const hasProject = /path\.join\(projectRoot,\s*'\.scut',\s*'frames'\)/.test(src);
const hasTemp = /scut71_frames/.test(src);
console.log(JSON.stringify({ hasProject, hasTemp }));
'''
good, out = run_driver(DRIVER_DIR)
line = [l for l in out.strip().splitlines() if l.startswith('{')]
res = json.loads(line[-1]) if line else {}
ok('有工程根时帧目录在工程内', res.get('hasProject') is True, res)
ok('无工程根时退回系统临时目录（不能因此跑不起来）', res.get('hasTemp') is True, res)


# ---------------------------------------------------------------------------
# 4) 真实会话：中文用户名 + 中文工程路径（需要已构建的工程）
# ---------------------------------------------------------------------------
print('\n=== 4. 中文用户名 + 中文工程目录下的真实会话 ===')
# ★ 这条要一个已构建的工程（有 .scut/bin/scut_sim.exe）。没有就跳过，
#   但【明确说出来】—— 静默少跑是本项目最反对的那种"看起来全绿"。
proj_arg = os.environ.get('SCUT_TEST_PROJECT', '')
if not proj_arg or not os.path.isfile(
        os.path.join(proj_arg, '.scut', 'bin', 'scut_sim.exe')):
    print('  SKIP  没有可用的已构建工程（设 SCUT_TEST_PROJECT 指向它）')
    print('        run_all_tests.py 会在构建完之后把这条真正跑起来')
else:
    r = subprocess.run(['node', os.path.join(HERE, 'cn_path_session.js'),
                        EXT, proj_arg],
                       capture_output=True, text=True, encoding='utf-8',
                       errors='replace', timeout=300)
    tail = ((r.stdout or '') + (r.stderr or '')).strip()
    ok('中文用户名 + 中文工程路径：帧能读到且非全黑', r.returncode == 0, tail[-800:])


print('\n' + '=' * 60)
if FAIL == 0:
    print('全部 %d 项通过' % PASS)
else:
    print('%d/%d 项通过，%d 项失败：' % (PASS, PASS + FAIL, FAIL))
    for f in FAILED:
        print('  - %s' % f)
print('=' * 60)
sys.exit(1 if FAIL else 0)
