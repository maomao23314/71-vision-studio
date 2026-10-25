#!/usr/bin/env python3
"""
test_firstrun.py -- "到手就能用"这一层的回归测试（0.10.9）。

★★ 为什么需要这一层 ★★

  这一轮改的都是【新用户第一次打开插件时才会碰到】的东西：
    · 配置面板里每个字段都必须真的显示出来（否则用户永远找不到它）；
    · 钩子函数候选必须从代码里真的扫得出来（否则"下拉选一个"是空的）；
    · 没工程时面板必须给引导（否则用户看到一堆点了没用的按钮）；
    · 新建工程必须把必填项问完（否则建完还是跑不起来）。

  这几条的共同点是【跑全量测试不会变红】——它们不影响任何已有行为，
  只影响"第一次用的人会不会卡住"。所以必须单独守着。

★★ 这一轮修掉的一个真实缺陷（下面 §1 守的就是它）★★

  configfields.ts 的 SECTIONS 原先用 `key` 同时表示"分组 id"和
  "负责哪个一级配置键"，而面板按 `f.path[0] === s.key` 过滤字段。
  于是【一个分组只能装一个一级键】，而 outputArray（结果图数组名）
  与 inputArray 同属「图像数组」——两个只能进去一个。

  结果：从 0.9.4 到 0.10.8，配置面板里【从来没有】「结果图数组名」这一项。
  用户想改它只能手改 JSON，或者用那个只有两项的一次性向导。
  而这项是"算法画的东西能不能显示出来"的开关 —— 找不到就等于功能没了。

  ★ 为什么现有测试没抓到：test_extension_settings.py 只检查
    "每个字段都有代码读它"（有 —— scut_build.py 读了），
    从不检查"每个字段都真的被渲染出来"。判据比缺陷窄，所以是绿的。

用法:
    python tests/test_firstrun.py

退出码 0 = 全部通过。
"""
import io
import os
import re
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
SRC = os.path.join(ROOT, 'extension', 'src')
MEDIA = os.path.join(ROOT, 'extension', 'media')

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


def read(rel):
    return io.open(os.path.join(ROOT, rel), encoding='utf-8').read()


def strip_ts_comments(t):
    t = re.sub(r"/\*[\s\S]*?\*/",
               lambda m: "".join("\n" if c == "\n" else " " for c in m.group(0)), t)
    return re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), t)


# ===========================================================================
print('=== 1. 配置面板：每个字段都必须有分组接收（防"字段永远不显示"） ===')
# ===========================================================================
#
# ★ 判据必须是【集合覆盖】，不能是"分组名等于字段前缀"：
#   上一版就是这么比的，于是"一个分组只能装一个键"这个缺陷
#   恰好满足判据 —— 测试是绿的，功能是坏的。
#   现在的判据是：所有字段的 path[0] 并集 ⊆ 所有分组 keys 的并集，
#   且每个字段的 path[0] 至少被一个分组覆盖。
cf = strip_ts_comments(read('extension/src/configfields.ts'))

# 分组：key: 'x', keys: ['a','b']
sections = []
for m in re.finditer(r"\{[^{}]*?key:\s*'(\w+)'[^{}]*?keys:\s*\[([^\]]*)\][^{}]*?\}",
                     cf, re.S):
    keys = re.findall(r"'([^']+)'", m.group(2))
    sections.append((m.group(1), keys))
ok('SECTIONS 里每个分组都声明了 keys', len(sections) >= 6,
   '解析到 %d 个分组' % len(sections))

covered = set()
for _key, keys in sections:
    covered.update(keys)

# 字段：path: ['a'] 或 path: ['a','b']
field_roots = re.findall(r"path:\s*\[\s*'([^']+)'", cf)
orphans = sorted(set(r for r in field_roots if r not in covered))
ok('配置面板里没有"无处分组接收"的孤儿字段', not orphans,
   '孤儿字段（用户永远看不到）：%s' % ', '.join(orphans))

# 反向：每个分组声明的 keys 都得真的存在，否则是空分组
missing = sorted(k for k in covered if k not in field_roots)
ok('没有声明了却一个字段都没有的空分组', not missing,
   '空分组：%s' % ', '.join(missing))

# ★ 这一条是本轮缺陷的"点名"断言：outputArray 必须被覆盖。
#   单独写一条，是因为它坏过一次；将来重构分组时，泛化判据可能被
#   改宽（比如允许"暂时不显示"），而这一条会立刻红。
ok('「结果图数组名」(outputArray) 有分组接收',
   'outputArray' in covered, 'SECTIONS 的 keys 里没有 outputArray')

# 面板脚本必须按 keys 过滤，而不是拿分组名去比 path[0]
sv = read('extension/media/settingsview.js')
ok('面板按分组声明的 keys 过滤字段（不是按分组名）',
   re.search(r"sec\.keys", sv) is not None)
ok('面板不再用 path[0] === 分组名 的写法', 'f.path[0] !== sec.key' not in sv)


# ===========================================================================
print('\n=== 2. 钩子候选扫描：只认真的能当钩子的函数 ===')
# ===========================================================================
#
# ★ 这一项在 Node 里【真的执行】hookscan.ts，而不是读源码猜。
#   因为它的判据是正则 + 注释剥离，静态读代码看不出对不对。
NODE_DRIVER = r'''
const fs = require('fs');
const path = require('path');
const ts = require(path.join(process.argv[2], 'node_modules', 'typescript'));
const src = fs.readFileSync(path.join(process.argv[2], 'src', 'hookscan.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const tmp = path.join(process.argv[3], 'hookscan.js');
fs.writeFileSync(tmp, js);
const h = require(tmp);

const sample = [
  '/* void old_process(void) 已废弃 */',
  'static void helper(void) { }',
  'void image_process(void)',
  '{',
  '    int x; /* void not_this(void) */',
  '}',
  'void *bad_ptr(void) { return 0; }',
  'int  not_hook(void) { return 0; }',
  'void  camera_draw ( void )  { }',
  'void second(void){}',
  'const char *s = "void fake(void) {";'
].join('\n');

const got = h.findVoidFunctions(sample);
console.log('FOUND ' + JSON.stringify(got));
'''
with tempfile.TemporaryDirectory() as td:
    drv = os.path.join(td, 'drv.js')
    with io.open(drv, 'w', encoding='utf-8') as f:
        f.write(NODE_DRIVER)
    r = subprocess.run(['node', drv, os.path.join(ROOT, 'extension'), td],
                       capture_output=True, text=True, encoding='utf-8',
                       errors='replace', timeout=60)
out = (r.stdout or '').strip()
print('    driver: %s' % (out or '(no output)'))
if r.stderr.strip():
    print('    stderr: %s' % r.stderr.strip()[:300])

m = re.search(r'FOUND (\[.*\])', out)
found = []
if m:
    try:
        import json as _json
        found = _json.loads(m.group(1))
    except ValueError:
        found = []
ok('扫描器能跑起来并返回结果', m is not None, out or r.stderr[:200])
ok('认得 void image_process(void)', 'image_process' in found, found)
ok('认得带空格的 void  camera_draw ( void )', 'camera_draw' in found, found)
ok('排除 static 函数（另一个编译单元调不到）', 'helper' not in found, found)
ok('排除 void * 返回（签名不是钩子）', 'bad_ptr' not in found, found)
ok('排除 int 返回', 'not_hook' not in found, found)
ok('排除注释里提到的函数（多半是已废弃的）',
   'old_process' not in found and 'not_this' not in found, found)
ok('排除字符串字面量里的假函数', 'fake' not in found, found)

# 配置面板必须真的把候选喂给前端（否则扫描器写了也没人用）
svts = read('extension/src/settingsview.ts')
ok('settingsview 调用了 scanHookCandidates', 'scanHookCandidates(' in svts)
ok('候选随 config 一起下发给面板', re.search(r"hooks:\s*hookCandidates\(\)", svts) is not None)
ok('面板把候选渲染成下拉框', 'hook-pick' in sv and 'hooks.length > 0' in sv)


# ===========================================================================
print('\n=== 3. 未加载工程时的引导页（用户明确要求） ===')
# ===========================================================================
svjs = read('extension/media/simview.js')

ok('仿真面板有引导页容器', 'id="guide"' in read('extension/src/simview.ts'))
ok('引导页有三个起步按钮（新建 / 打开 / 自检）',
   all(('id="guide-%s"' % b) in read('extension/src/simview.ts')
       for b in ('new', 'open', 'doctor')))
ok('引导页有"打开配置"按钮（缺钩子时用）',
   'id="guide-settings"' in read('extension/src/simview.ts'))
# ★ 引导页上的按钮必须【每一个都真的会显示】。
#   第一版画了一个「立即编译」（id=guide-build），但两种状态下都 show(..., false) ——
#   它永远不会出现。这正是本项目最反感的那类东西：画了、绑了、不显示。
#   判据：HTML 里的每个 guide-* 按钮，在 simview.js 里都必须至少有一处 show(..., true)。
_guide_html = read('extension/src/simview.ts')
# 只取 <button ... id="guide-xxx" ...>，不取容器（guide-title / guide-body 之类）
_guide_ids = re.findall(r'<button[^>]*\bid="(guide-[a-z]+)"', _guide_html)
ok('解析到引导页的按钮（判据前提）', len(_guide_ids) >= 4,
   '只解析到 %d 个' % len(_guide_ids))
# DOM id 与 guideBtns 的键不是同名（guide-new ↔ newProject），所以显式列表。
_GUIDE_BTN_KEYS = ['newProject', 'open', 'doctor', 'settings']
_never = [k for k in _GUIDE_BTN_KEYS
          if ('show(guideBtns.%s, true)' % k) not in svjs]
ok('引导页每个按钮都至少有一种情况会显示出来', not _never,
   '永远不显示：%s' % ', '.join(_never))
# 反向：guideBtns 里声明的每个键都必须真的有 show(..., true) 和 show(..., false)，
# 否则要么永远显示、要么永远不显示 —— 两种都是"画了不接"。
_declared_btn = re.findall(r"(\w+): document\.getElementById\('guide-", svjs)
ok('guideBtns 的键与断言列表一致',
   sorted(_declared_btn) == sorted(_GUIDE_BTN_KEYS),
   '声明了 %s' % _declared_btn)
ok('引导页由 status 消息驱动（与工程就绪度同源）',
   re.search(r"renderGuide\(msg\.project", svjs) is not None)
ok('没工程时隐藏整个仿真面板（不留点了没用的按钮）',
   "body[data-guide='1'] #app" in read('extension/media/simview.css'))
ok('引导页在仿真运行时不挡画面',
   re.search(r'if \(running\) \{ needGuide = false; \}', svjs) is not None)

# 宿主侧必须真的提供就绪度，否则引导页永远停在"没工程"
ok('SimViewDeps 声明了 getProjectInfo',
   'getProjectInfo(): ProjectInfo | undefined;' in read('extension/src/simview.ts'))
ok('extension.ts 实现了 getProjectInfo',
   'getProjectInfo: (): ProjectInfo | undefined =>' in read('extension/src/extension.ts'))
ok('就绪度包含"钩子填了没"', 'hooksReady' in read('extension/src/extension.ts'))
ok('就绪度包含"图放了没"', 'picCount' in read('extension/src/extension.ts'))
# ★ ProjectInfo 里每个字段都必须有前端消费者 —— 否则又是一处"传了没人用"。
#   picCount / built 曾经就是这样：宿主算好了推过去，前端一个字都没读。
#   现在它们用来决定画面占位文字（"图集里还没有测试图" / "点编译"）。
for field in ('picCount', 'built', 'hooksReady', 'root'):
    ok('ProjectInfo.%s 被前端真的用到' % field,
       field in svjs, '前端没有读 %s' % field)
ok('工作区变化会让面板刷新',
   'onDidChangeWorkspaceFolders' in read('extension/src/extension.ts'))

# 引导页的按钮必须真的接到命令上（画了不接 = 点了没反应）
for cmd in ('newProject', 'openFolder', 'doctor'):
    ok("引导页「%s」发出对应命令" % cmd,
       ("cmd: '%s'" % cmd) in svjs)
    ok("宿主处理 cmd=%s" % cmd,
       ("cmd === '%s'" % cmd) in read('extension/src/simview.ts'))


# ===========================================================================
print('\n=== 4. 新建工程：必填项在新建立时就问完 ===')
# ===========================================================================
ext = read('extension/src/extension.ts')

ok('新建工程问图像尺寸', '图像尺寸' in ext and '宽x高' in ext)
ok('新建工程问每帧处理函数', '每帧处理函数' in ext)
ok('新建工程把尺寸写进配置', 'image: { width, height }' in ext)
ok('新建工程把钩子写进配置', 'frame: frameFn.trim().length > 0' in ext)
# ★ 写配置失败不能让整个新建失败：工程文件已经拷好了
ok('配置写入失败只提示、不中断', 'cfgNote' in ext)

# 那个只有两项的一次性向导已经删掉了（它是配置面板的第二个入口）
ok('「配置本工程」向导已删除', 'scut71.setupProject' not in read('extension/package.json'))
ok('向导函数已删除', 'commandSetupProject' not in ext)
ok('向导不再出现在命令注册里', "'scut71.setupProject'" not in ext)


# ===========================================================================
print('\n=== 5. 死代码清理（这一轮删掉的，不许回潮） ===')
# ===========================================================================
# ★ 判据一律用【剥掉注释后的代码】。本项目习惯把"这里曾经有什么、为什么删"
#   留在原地，那些说明里必然出现被删的名字 —— 拿原文查会把正确的注释判成回潮。

def code_of(rel):
    return strip_ts_comments(read(rel))


sess = code_of('extension/src/simsession.ts')
ok('simsession 不再有 productionPaused（没人读的开关）',
   'productionPaused' not in sess)
ok('simsession 不再有 runGeneration（只增不减的计数器）',
   'runGeneration' not in sess)
ok('simsession 不再有 prettyProtocolLine（零调用包装）',
   'prettyProtocolLine' not in sess)

ok('toolchain 不再有 toolInfos（与 runDoctor 重复）',
   'toolInfos' not in code_of('extension/src/toolchain.ts'))
ok('build 不再有 expectedExePath（零调用包装）',
   'expectedExePath' not in code_of('extension/src/build.ts'))
ok('configfields 不再有 pickValue/setValue（宿主侧零调用）',
   'pickValue' not in cf and 'setValue(' not in cf)

# webview 侧：零调用的小工具
# ★ 必须用剥掉注释的版本：这一轮把"这里曾经有什么、为什么删"留在了原地，
#   那些说明里必然出现被删的名字。拿原文查会把自己写的正确注释判成回潮。
svjs_code = re.sub(r'/\*[\s\S]*?\*/', ' ', svjs)
svjs_code = re.sub(r'//[^\n]*', ' ', svjs_code)
ok('simview.js 不再有 cssEscape（变量行已不用选择器查）',
   'cssEscape' not in svjs_code)
# ★ hasFrame 曾经是"零调用的组件方法"，删掉后又因为"占位层要判断
#   该不该继续盖着"重新加了回来 —— 所以判据不是"不许有它"，
#   而是"它有调用点"。零调用的方法迟早会被当成死代码再删一次。
ok('hasFrame 有真实调用点（不是零调用）',
   svjs_code.count('hasFrame') >= 2,
   '出现 %d 次' % svjs_code.count('hasFrame'))
ok('simview.js 的 el 表里不再有 toolbar（零引用）',
   re.search(r"toolbar:\s*document\.getElementById", svjs_code) is None)

# fs 小工具必须只有一份
fsutil = code_of('extension/src/fsutil.ts')
ok('fsutil.ts 提供 isFile/isDir', 'export function isFile' in fsutil
   and 'export function isDir' in fsutil)
dup = []
for fn in sorted(os.listdir(SRC)):
    if not fn.endswith('.ts') or fn == 'fsutil.ts':
        continue
    body = code_of(os.path.join('extension/src', fn))
    if re.search(r'function\s+isFile\s*\(', body) or re.search(r'function\s+isDir\s*\(', body):
        dup.append(fn)
ok('没有第二个文件自己再定义 isFile/isDir', not dup, '重复定义：%s' % ', '.join(dup))


# ===========================================================================
print('\n=== 6. 配置面板自动保存（延迟落盘 + 开关 + 不丢改动） ===')
# ===========================================================================
#
# ★ 自动保存这类功能最容易出的是【静默丢数据】，而不是"报错"：
#     · 改了 → 立刻关面板 → 计时器随页面销毁 → 改动没了；
#     · 改了 → 切出去又切回来 → reload 把界面刷回磁盘旧值；
#     · 连续输入 1024 → 中间态 1 / 10 / 102 各被写盘一次。
#   这三种都不会报错、也不会崩，用户只会觉得"它没生效"。
#   所以下面每条都对应一个具体失效路径，不是"有没有这个函数"。

sv_ts = read('extension/src/settingsview.ts')
sv_js = read('extension/media/settingsview.js')

# --- 默认开启（用户要求"不方便的话就默认自动"）---
ok('自动保存默认开启',
   re.search(r'return v === undefined \? true', sv_ts) is not None,
   '默认值不是 true')
ok('开关存进 globalState（不是工程 JSON）',
   'globalState' in sv_ts and 'AUTO_SAVE_KEY' in sv_ts)
# ★ 关键判据：偏好不能写进 scut_project.json —— 它是"本机本用户"的，
#   塞进工程 JSON 会让别人 clone 下来多一个与他无关的开关。
ok('自动保存开关不在工程配置字段表里',
   'autoSave' not in cf, 'configfields.ts 里出现了 autoSave')
ok('自动保存开关不在 ProjectConfig 里',
   'autoSave' not in code_of('extension/src/projectconfig.ts'))

# --- 延迟合并：不是每次 input 都写盘 ---
ok('自动保存走延迟（有计时器）', 'setTimeout' in sv_ts)
ok('延迟时长是个具名常量（便于调）',
   re.search(r'AUTO_SAVE_DELAY_MS\s*=\s*\d+', sv_ts) is not None)
ok('新的改动会重置计时器（合并连续输入）',
   re.search(r'if \(autoSaveTimer\) \{\s*clearTimeout\(autoSaveTimer\);\s*\}',
             sv_ts) is not None)

# --- 不丢改动：挂起的那份配置必须存下来，并在 dispose 时落盘 ---
ok('挂起的配置被真的存下来（不只是存计时器）',
   'pendingValue' in sv_ts)
ok('关面板时把挂起的改动落盘（不是丢弃）',
   re.search(r'onDidDispose\(\(\) => \{\s*flushPending\(\)', sv_ts) is not None)
# ★ 负向断言：dispose 里只清计时器不写盘 = 丢数据。
#   这条防的是"看起来有兜底、其实只是取消"。
ok('dispose 不是"只清计时器"（那样等于丢改动）',
   not re.search(r'onDidDispose\(\(\) => \{\s*(//[^\n]*\n\s*)*if \(autoSaveTimer\) \{\s*clearTimeout\(autoSaveTimer\);\s*autoSaveTimer = undefined;\s*\}\s*current = undefined;',
                 sv_ts))

# --- reload 必须先落盘再回读，否则界面会刷回旧值 ---
ok('reload 之前先 flushPending（否则界面刷回旧值）',
   re.search(r"type === 'reload'[\s\S]{0,400}?flushPending\(\)", sv_ts) is not None)

# --- 关掉开关时要先落盘，且底栏不能盖掉"有未保存改动" ---
ok('关掉自动保存前先把挂起的改动落盘',
   re.search(r"if \(!on\) \{\s*flushPending\(\);\s*\}", sv_ts) is not None)
ok('底栏不会用"需要手动保存"盖掉"有未保存的改动"',
   re.search(r'if \(!autoSave && !dirtyPending\)', sv_js) is not None)

# --- 前端不做 debounce（前端计时器会随页面销毁而丢）---
ok('前端每次改动都发给宿主（不在前端做 debounce）',
   re.search(r'function queueAutoSave\(\)[\s\S]{0,300}?vscode\.postMessage',
             sv_js) is not None)
ok('前端没有自己的自动保存计时器',
   'setTimeout' not in sv_js)

# --- 开关真的在界面上 ---
ok('底栏有自动保存复选框', 'id="chk-autosave"' in sv_ts)
ok('开关旁边说明了当前行为',
   'autosave-tip' in sv_ts and '改完自动写入' in sv_js)
# ★ 关掉之后「保存」按钮必须重新显眼：否则用户以为还在自动存
ok('关掉自动保存后「保存」按钮变显眼',
   re.search(r"btn\.classList\.toggle\('primary', !autoSave\)", sv_js) is not None)

# --- 宿主必须回执，否则底栏永远停在"正在自动保存…" ---
ok('宿主落盘后回执 autoSaved', "type: 'autoSaved'" in sv_ts)
ok('前端收到 autoSaved 才切成"已自动保存"',
   re.search(r"m\.type === 'autoSaved'[\s\S]{0,200}?noteSaved\(true\)", sv_js) is not None)


# ===========================================================================
print('\n' + '=' * 60)
if FAIL == 0:
    print('全部 %d 项通过' % PASS)
else:
    print('%d/%d 项通过，%d 项失败：' % (PASS, PASS + FAIL, FAIL))
    for f in FAILED:
        print('  - %s' % f)
print('=' * 60)
sys.exit(1 if FAIL else 0)
