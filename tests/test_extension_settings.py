# -*- coding: utf-8 -*-
"""设置项归口 —— 配置必须且只能来自 scut_project.json。

★★ 这条测试为什么存在 ★★

0.9.3 把 20 项配置写进 package.json 的 contributes.configuration，
并分了四个组（工具链 / 工程配置 / 运行期 / 面板与显示）。结果三重坑：

  ① 嵌套 object 分组【不注册内层键】
        "scut71.toolchain": { "type": "object",
                              "properties": { "scut71.toolchain.path": {...} } }
     VS Code 只注册 properties 的顶层键，所以注册的是【一个名叫
     scut71.toolchain 的对象型设置】，内层 properties 只是 JSON Schema。

  ② 后果之一：cfg.get('path') 读不到，静默返回默认值
        用户在设置页填了工具链路径，插件完全看不见，而且不报错。

  ③ 后果之二：cfg.update('path', ...) 直接抛
        「没有注册配置 scut71.toolchain.path」  ← 用户在自检报告里看到的

除了这三个，还有两个更隐蔽的：

  ④ 同一份数据有两个真值：scut_project.json 的 pic.dir 与设置的
     scut71.runtime.picDir。project.ts 里写的是
        fromSettings ?? fromProjectConfig
     也就是【设置压过工程配置】—— 工程 JSON 里配的图集目录根本不生效。

  ⑤ UI 上存在没人读的字段：view.showTiming / showVariables / showLog /
     pickPersist 四项全项目没有任何代码读取（勾选的持久化由 webview 的
     setState 完成）。用户勾了「不显示日志」，日志照旧出现。

所以这一版把配置完全交给 scut_project.json。本文件守住这个约定：

    A. package.json 里不许再有 contributes.configuration
    B. 源码里不许再读 VS Code 的 scut71.* 设置
    C. UI 上每个字段都必须【真的有人读】—— 没有读取点的字段就是死界面
    D. scut_project.json 的形状（projectconfig.ts）与构建脚本的默认值
       （scut_build.py）必须逐字一致 —— 两边是同一份数据的两个视图
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, 'extension')
SRC = os.path.join(EXT, 'src')
PKGJSON = os.path.join(EXT, 'package.json')
BUILD = os.path.join(ROOT, 'tools', 'scut_build.py')

bad = []
note = []


def strip_comments(t):
    t = re.sub(r"/\*[\s\S]*?\*/",
               lambda m: "".join("\n" if c == "\n" else " " for c in m.group(0)), t)
    return re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), t)


def read(p):
    return io.open(p, encoding='utf-8').read()


def fail(msg):
    bad.append(msg)


# ==================================================================
#  A. package.json 不许再有 contributes.configuration
# ==================================================================
pkg = json.loads(read(PKGJSON))
contrib = pkg.get('contributes', {})
if 'configuration' in contrib:
    keys = list(contrib['configuration'].get('properties', {}))
    fail('★ package.json 仍有 contributes.configuration（%d 项）\n'
         '    0.9.3 的坑就在这里：嵌套 object 分组【不注册内层键】，\n'
         '    于是 cfg.get 读不到、cfg.update 抛「没有注册配置」。\n'
         '    配置已经全部搬到 scut_project.json，这里必须删干净。\n'
         '    残留键：%s' % (len(keys), ', '.join(keys[:8])))
else:
    note.append('package.json 已无 contributes.configuration（配置只在工程 JSON）')

# configurationDefaults 是改【别人】的设置（关 cpptools），不是自己的配置项，
# 属于完全不同的机制，必须留着。
if 'configurationDefaults' not in contrib:
    fail('★ configurationDefaults 被误删了 —— 它用来关掉 cpptools 的 '
         'intellisense，不是本插件自己的配置项')

# ==================================================================
#  B. 源码里不许再读 VS Code 的 scut71.* 设置
# ==================================================================
leftover = []
for fn in sorted(os.listdir(SRC)):
    if not fn.endswith('.ts'):
        continue
    for i, line in enumerate(read(os.path.join(SRC, fn)).split('\n'), 1):
        clean = strip_comments(line)
        if 'getConfiguration' in clean and 'scut71' in clean:
            leftover.append('%s:%d  %s' % (fn, i, clean.strip()[:76]))
if leftover:
    fail('★ 源码里还有 %d 处读 VS Code 的 scut71.* 设置：\n    %s\n'
         '    这些键已经不存在（contributes.configuration 已删），\n'
         '    读了只会静默拿到默认值。改读 scut_project.json。'
         % (len(leftover), '\n    '.join(leftover)))
else:
    note.append('源码零处读取 VS Code 的 scut71.* 设置')

# ==================================================================
#  C. UI 上每个字段都必须真的有人读（防死界面）
# ==================================================================
cf = read(os.path.join(SRC, 'configfields.ts'))
field_re = re.compile(r"path:\s*\[([^\]]*)\]")
declared = []
for m in field_re.finditer(strip_comments(cf)):
    parts = re.findall(r"'([^']+)'", m.group(1))
    if parts:
        declared.append(parts)

# 只在自己写的文件里提到，不能算"有人用" —— 那只能证明字段存在。
AUTHORED = {'configfields.ts', 'projectconfig.ts', 'settingsview.ts'}

# 收集所有非 authored 文件的正文
others = {}
for fn in sorted(os.listdir(SRC)):
    if fn.endswith('.ts') and fn not in AUTHORED:
        others[fn] = strip_comments(read(os.path.join(SRC, fn)))
build_py = read(BUILD)

dead = []
for parts in declared:
    leaf = parts[-1]
    hit = any(leaf in body for body in others.values()) or (leaf in build_py)
    if not hit:
        dead.append('.'.join(parts))
if dead:
    fail('★ UI 上有 %d 个字段【没有任何代码读取】：%s\n'
         '    这就是死界面：用户勾了/填了却没效果，\n'
         '    还会反过来怀疑是自己用错了。要么接上读取，要么删掉。'
         % (len(dead), ', '.join(dead)))
else:
    note.append('UI 上 %d 个字段全部有真实读取点' % len(declared))

# ==================================================================
#  D. TS 的 ProjectConfig 形状 与 Python 的 DEFAULT_CONFIG 必须一致
# ==================================================================
pcSrc = read(os.path.join(SRC, 'projectconfig.ts'))

# ★ 两边都只认【恰好 4 空格缩进】的一级键 ★
#   不加缩进限制会把嵌套的第二层键（width / dir / processRepeat …）
#   也当成一级字段，于是报告一堆并不存在的"两边不一致"。
#   这个坑今天已经踩第二次了 —— 检查脚本出错时，最像 bug 的表现
#   就是"报了一堆错"，而不是"什么都不报"。
m = re.search(r"interface\s+ProjectConfig\s*\{(.*?)\n\}", pcSrc, re.S)
if not m:
    fail('★ projectconfig.ts 里找不到 interface ProjectConfig')
    ts_top = []
else:
    body = strip_comments(m.group(1))
    ts_top = re.findall(r"^\s{4}([a-zA-Z][a-zA-Z0-9_]*)\s*[:;]", body, re.M)

m2 = re.search(r"DEFAULT_CONFIG:\s*Dict\[str,\s*Any\]\s*=\s*\{(.*?)\n\}",
               read(BUILD), re.S)
if not m2:
    fail('★ scut_build.py 里找不到 DEFAULT_CONFIG')
    py_top = []
else:
    py_top = re.findall(r'^\s{4}"([a-zA-Z][a-zA-Z0-9_]*)"\s*:', m2.group(1), re.M)

if ts_top and py_top:
    only_ts = [k for k in ts_top if k not in py_top]
    only_py = [k for k in py_top if k not in ts_top]
    if only_ts or only_py:
        fail('★ scut_project.json 的形状两边不一致 —— 同一份数据的两个视图'
             '不能各写一套：\n'
             '    只在 projectconfig.ts: %s\n'
             '    只在 scut_build.py   : %s\n'
             '    后果：插件写的字段脚本读不到，或反过来。'
             % (', '.join(only_ts) or '（无）', ', '.join(only_py) or '（无）'))
    else:
        note.append('两边形状一致（%d 个一级段：%s）'
                    % (len(ts_top), ', '.join(ts_top)))

# ---- run 段的默认值两边也必须一致（最容易各写一套的地方）----
for key, expect in [('processRepeat', 1), ('runFrames', 60), ('benchRepeat', 1000)]:
    if re.search(r"%s:\s*number;" % key, pcSrc) is None:
        continue
    if '"%s": %d' % (key, expect) not in read(BUILD):
        fail('★ run.%s 的默认值两边不一致（scut_build.py 应为 %d）' % (key, expect))

# ==================================================================
#  报告
# ==================================================================
print('=' * 66)
print('  设置项归口检查')
print('=' * 66)
for n in note:
    print('  ✔ %s' % n)
print()

if bad:
    print('=' * 66)
    for b in bad:
        print('  ❌ %s' % b)
    print('=' * 66)
    print('  ❌ 失败  设置项归口')
    sys.exit(1)

print('  ✅ 通过  设置项归口')
sys.exit(0)