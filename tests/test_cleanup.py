#!/usr/bin/env python3
"""
test_cleanup.py -- 第二轮清理的回归测试（死代码 / 过时注释 / 健壮性）。

★ 为什么需要这一层：本轮删掉的是**死代码与死配置**，而"死代码"的特点是
  删掉之后没有任何测试会变红 —— 这正是它危险的地方：
  ① 删错了（其实有人在用）不会有测试拦住；
  ② 删对了也没有测试守住，下次有人"顺手加回来"同样不会被发现。

  所以这里做两件事：
  · 断言【不该再存在的东西】确实不存在（防回潮）；
  · 断言【本该存在的东西】确实存在（防误删）。

  ★ 判据只看【代码】，不看注释：
    本轮特意在注释里写了很多"这里曾经是什么、为什么删掉"，
    那些字样出现在注释里是【正确】的（记录演进是本项目的习惯）。
    所以本测试先把注释行剔掉再断言，否则会把正确的注释误判成回潮。

用法:
    python tests/test_cleanup.py

退出码 0 = 全部通过。
"""
import io
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

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


def strip_comments(text, style='c'):
    """去掉注释行，只留代码。

    ★ 只剔【整行】注释（C 的 * / /* / //，Python 的 #）。
      行尾注释保留 —— 那是代码行，本来就要参与判断。
      这个粗粒度足够用：本测试关心的是"还有没有真的引用"，
      而真正的引用一定出现在代码行上。
    """
    out = []
    for line in text.split('\n'):
        s = line.strip()
        if style == 'py':
            if s.startswith('#'):
                continue
        else:
            if s.startswith('*') or s.startswith('/*') or s.startswith('//'):
                continue
        out.append(line)
    return '\n'.join(out)


print('=== 1. C 侧：死代码已删除，且真的没人再引用 ===')

# scut_registry_internal.h 整文件删除。
# 它定义的 SCUT_REGISTER 宏体调用的是 SCUT_Register —— 那个符号全树不存在，
# 一用就链接失败；而真正在用的宏是 scut_registry.h 的 ENV_REGISTER。
ok('scut_registry_internal.h 已删除',
   not os.path.isfile(os.path.join(ROOT, 'core', 'include', 'scut_registry_internal.h')))

for rel in ('core/src/scut_registry.c', 'core/include/scut_registry.h',
            'core/src/scut_sched.c'):
    body = strip_comments(read(rel))
    ok('%s 代码里不再 include registry_internal' % os.path.basename(rel),
       'scut_registry_internal.h' not in body)
ok('ENV_REGISTER 仍在（真正在用的那个宏）',
   'ENV_REGISTER' in read('core/include/scut_registry.h'))

# 违规计数的两个 getter：零调用，已删。
inp_code = strip_comments(read('core/src/scut_input.c'))
inh_code = strip_comments(read('core/src/scut_internal.h'))
ok('scut_input_violations 定义已删', 'scut_input_violations' not in inp_code)
ok('scut_input_reset_violations 定义已删',
   'scut_input_reset_violations' not in inp_code)
ok('scut_internal.h 不再声明这两个',
   'scut_input_violations' not in inh_code
   and 'scut_input_reset_violations' not in inh_code)
# 但计数本身要留着（一次性提示靠它）
ok('违规计数变量仍保留（一次性提示要用）', 's_violations' in inp_code)

# sink 计时：算了但结果被 (void) 丢弃。
sched_code = strip_comments(read('core/src/scut_sched.c'))
# 说明性注释里提到它（"原先还算了 … 却只用一句 (void)sink_us 丢掉"）是
# 【正确】的记录方式，所以只断言它不再是【标识符级】的引用：
# 判据是"赋值/取地址"这类真的用它当变量的写法都不存在了。
ok('sink_us 不再被赋值', 'sink_us =' not in sched_code)
ok('sink_us 不再被取地址或运算', 'sink_us)' not in sched_code.replace('(void)sink_us', ''))
ok('sink_begin 已从代码删除', 'sink_begin' not in sched_code)
ok('sink_end 已从代码删除', 'sink_end' not in sched_code)
ok('s_sink_user 仍保留（透传参数，不是死代码）', 's_sink_user' in sched_code)

print('\n=== 2. C 侧：会骗人的 API 已删除 ===')
draw_code = strip_comments(read('core/src/scut_draw.c'))
draw_h = strip_comments(read('core/include/scut_draw.h'))
ok('SCUT_GetImageWidth 定义已删', 'SCUT_GetImageWidth' not in draw_code)
ok('SCUT_GetImageHeight 定义已删', 'SCUT_GetImageHeight' not in draw_code)
ok('SCUT_GetImageWidth 声明已删', 'SCUT_GetImageWidth' not in draw_h)
ok('SCUT_GetOutputWidth 保留（它才是真的）',
   'SCUT_GetOutputWidth' in draw_code and 'SCUT_GetOutputWidth' in draw_h)

print('\n=== 3. C 侧：SCUT_PROCESS_REPEAT 死路径已删 ===')
bind_code = strip_comments(read('bind/scut_bind.c'))
ok('不再有 #ifdef SCUT_PROCESS_REPEAT', '#ifdef SCUT_PROCESS_REPEAT' not in bind_code)
ok('不再有 SCUT_BIND_REPEAT 中间宏', 'SCUT_BIND_REPEAT' not in bind_code)
ok('repeat 直接写 1', 'cfg.repeat       = 1;' in bind_code)

print('\n=== 4. C 侧：半死配置补上了 setter ===')
ok('scut_sched_set_log_enabled 已声明',
   'scut_sched_set_log_enabled' in strip_comments(read('core/include/scut_sched.h')))
ok('scut_sched_set_draw_enabled 已声明',
   'scut_sched_set_draw_enabled' in strip_comments(read('core/include/scut_sched.h')))
ok('scut_sched_set_log_enabled 已实现',
   'scut_sched_set_log_enabled' in sched_code)
ok('scut_sched_set_draw_enabled 已实现',
   'scut_sched_set_draw_enabled' in sched_code)
ok('log_enabled 的消费点仍在（真的会生效）', 's_cfg.log_enabled' in sched_code)
ok('draw_enabled 的消费点仍在', 's_cfg.draw_enabled' in sched_code)

print('\n=== 5. C 侧：内存不足不再被报成格式错误 ===')
frame_h = read('core/include/scut_frame.h')
frame_c = read('core/src/scut_frame.c')
host_c = read('backends/headless/scut_headless_main.c')
ok('SCUT_FRAME_ERR_NOMEM 已定义', 'SCUT_FRAME_ERR_NOMEM' in frame_h)
ok('错误码是 -17', '#define SCUT_FRAME_ERR_NOMEM           -17' in frame_h)
# ★ 判据是"有这条代码路径"，不是"文件里出现过这句话"：
#   前者改了分支才会红，后者注释里提到就假绿。
ok('strerror 对 NOMEM 有独立分支',
   re.search(r'case SCUT_FRAME_ERR_NOMEM:\s*return\s+"[^"]+"', frame_c) is not None)
# 4 处分配失败都要用它：读文件 1 处 + PNG 3 处
n_nomem = frame_c.count('SCUT_FRAME_ERR_NOMEM')
ok('scut_frame.c 至少 4 处使用（1 读文件 + 3 PNG 缓冲）', n_nomem >= 4, n_nomem)
ok('不再把内存不足归因为 PNG_FORMAT',
   '内存不足：按「数据无效」归因' not in frame_c)
ok('宿主有 NOMEM 专门分支', 'case SCUT_FRAME_ERR_NOMEM:' in host_c)
ok('宿主的 NOMEM 分支有独立文案',
   re.search(r'case SCUT_FRAME_ERR_NOMEM:\s*(/\*.*?\*/\s*)?why\s*=\s*"[^"]{6,}"',
             host_c, re.S) is not None)

print('\n=== 6. 过时阶段注释不再断言错误顺序 ===')
# PRE_FRAME / POST_FRAME / REPORT 都已不存在。
# 允许出现在"曾经/更正/已删除"语境的注释里，不允许出现在代码或
# 描述当前顺序的句子里。
for rel in ('core/src/scut_draw.c', 'core/include/scut_draw.h',
            'core/src/scut_sched.c', 'core/src/scut_internal.h',
            'backends/headless/scut_headless_main.c'):
    body = strip_comments(read(rel))
    ok('%s 代码里无 PRE_FRAME' % os.path.basename(rel), 'PRE_FRAME' not in body)
    ok('%s 代码里无 POST_FRAME' % os.path.basename(rel), 'POST_FRAME' not in body)

# 阶段枚举是唯一权威：只有 IDLE / PROCESS / DRAW
internal = read('core/src/scut_internal.h')
ok('阶段枚举只有 IDLE/PROCESS/DRAW',
   'SCUT_PHASE_IDLE' in internal and 'SCUT_PHASE_PROCESS' in internal
   and 'SCUT_PHASE_DRAW' in internal
   and 'SCUT_PHASE_REPORT' not in strip_comments(internal))
# 角色枚举：INIT/PROCESS/DRAW/SHUTDOWN，没有 REPORT
reg_h = strip_comments(read('core/include/scut_registry.h'))
ok('角色枚举里没有 SCUT_ROLE_REPORT', 'SCUT_ROLE_REPORT' not in reg_h)

print('\n=== 7. 后端协议文档与实现一致 ===')
# 帧图是 PPM 不是 PGM
ok('协议文档写的是 ppm', '"<path to ppm>"' in host_c)
# ★ 判据要精确：PGM 出现在"解释为什么改成 PPM"的注释里是【正确】的
#   （本项目的记录习惯），只有把它当成【当前格式】才是错的。
#   所以只断言：没有"把 pgm 当成当前输出格式"的表述。
host_code = strip_comments(host_c)
ok('代码里不再出现 .pgm 作为输出路径',
   '.pgm' not in host_code, [l for l in host_code.split('\n') if '.pgm' in l][:2])
# ★ 上面那句只能说明"代码里没有"。文档段落里 `"<path to pgm>"` 这个【旧写法】
#   只在解释"原先写成这样、现在是 PPM"时出现 —— 那是正确的记录。
#   所以判据是：它不能出现在【格式说明行】上，即不能紧跟 "img": 出现。
_proto = host_c.split('输出协议')[1].split('====')[0] if '输出协议' in host_c else ''
ok('协议示例的 img 字段指向 ppm 而非 pgm',
   '"img":"<path to ppm>"' in _proto)
# 追加字段都要真的被 printf 出来（判"出现在文件里"会被注释骗过）
for field in ('loadError', 'bench', 'vars'):
    ok('帧行里真的有 %s 字段' % field,
       re.search(r'"\\"%s\\"|"%s":|\{\\"%s\\"' % (field, field, field), host_c) is not None
       or ('\\"%s\\"' % field) in host_c)

print('\n=== 8. 用户可见的回绕文案按图集起点 ===')
# 0 起图集要回到 0，说成"回到第 1 张"是错的（这条是直接打给用户看的）
printf_lines = [l for l in host_c.split('\n')
                if ('printf' in l or '回到第' in l) and not l.strip().startswith('*')]
joined = '\n'.join(printf_lines)
ok('printf 里不再写死"回到第 1 张"', '回到第 1 张' not in joined)
ok('回绕提示使用 s_pic_first', 's_pic_first' in host_c)

print('\n=== 9. Python 侧：死函数与半死开关 ===')
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import importlib.util
spec = importlib.util.spec_from_file_location(
    'scut_build_t', os.path.join(ROOT, 'tools', 'scut_build.py'))
sb = importlib.util.module_from_spec(spec)
sys.modules['scut_build_t'] = sb
spec.loader.exec_module(sb)

ok('write_config_shim 已删除', not hasattr(sb, 'write_config_shim'))
ok('JOBS_MAX 常量存在', hasattr(sb, 'JOBS_MAX'))
ok('JOBS_MAX == 16', getattr(sb, 'JOBS_MAX', 0) == 16)
ok('CMD_TIMEOUT_SEC 存在', hasattr(sb, 'CMD_TIMEOUT_SEC'))
ok('PROBE_TIMEOUT_SEC 存在', hasattr(sb, 'PROBE_TIMEOUT_SEC'))
ok('构建超时比探测超时宽',
   sb.CMD_TIMEOUT_SEC > sb.PROBE_TIMEOUT_SEC)

parser = sb.build_parser()
a = parser.parse_args(['--project', '.', '--exclude', 'x,y', '--max-elems', '10'])
ok('--exclude 可解析', a.exclude == 'x,y')
ok('--max-elems 可解析', a.max_elems == 10)
a2 = parser.parse_args(['--project', '.'])
ok('--exclude 默认空', a2.exclude == '')
ok('--max-elems 默认 0', a2.max_elems == 0)

# --exclude / --max-elems 必须真的透传给 scut_symbols.py
src = read('tools/scut_build.py')
ok('--exclude 透传给符号发现', 'gen_cmd += ["--exclude", exclude_names]' in src)
ok('--max-elems 透传给符号发现', 'gen_cmd += ["--max-elems", str(max_elems)]' in src)

# objdump 相关的东西必须彻底消失（换成了纯 Python 读 DWARF）
# ★ 这一节是"防回潮"：新写法把 objdump 从构建链里彻底拿掉了，
#   若哪天有人"顺手"把它加回来（比如为了兼容老文档），
#   变量发现就会重新变成"看机器装了什么"的状态。
tc = sb.Toolchain()
ok('Toolchain 不再有 objdump 字段', not hasattr(tc, 'objdump'))
ok('to_json 不再导出 objdump',
   'objdump' not in json.dumps(tc.to_json(), ensure_ascii=False))
ok('不再有 objdump 候选路径表',
   'BINUTILS_OBJDUMP_CANDIDATES' not in src)
ok('不再有 _find_objdump', '_find_objdump' not in src)
ok('不再有 objcopy 修补', '_find_objcopy' not in src
   and 'normalize_probe_obj_dwarf' not in src)
ok('生成器不再接收 --objdump', '"--objdump"' not in src)
ok('符号发现失败提示不再甩锅给 objdump',
   'objdump 不是 binutils 版本' not in src)

print('\n=== 10. Python 版本闸门统一为 3.7 ===')
ok('闸门是 3.7', 'sys.version_info < (3, 7)' in src)
ok('不再有 3.8 闸门', 'sys.version_info < (3, 8)' not in src)
ok('不再声称"f-string 调试"', 'f-string 调试' not in src)
ok('闸门失败时会输出 JSON', '"ok": False' in src and 'raise SystemExit(2)' in src)
# 插件侧的下限必须与脚本一致
tc_ts = read('extension/src/toolchain.ts')
ok('插件侧下限也是 3.7', 'v[1] >= 7' in tc_ts)
ok('插件侧不再接受 3.8 说法', '3.8' not in strip_comments(tc_ts, 'py'))

print('\n=== 11. 解码不再依赖"latin-1 永远成功" ===')
ok('decode_output 先严格 UTF-8', 'raw.decode("utf-8")' in src)
ok('GBK 分支带 replace（永不抛）', 'raw.decode("gbk", errors="replace")' in src)
# ★ decode_output 里不能再有 latin-1 候选链。
#   注意：文件【别处】有 latin-1 的正当用法 —— DWARF 偏移规范化那条
#   逐字节变换用它做"无损字节<->字符"的双向映射（latin-1 是唯一
#   能把 0..255 一一映射到 U+0000..U+00FF 的编码）。
#   所以判据只针对 decode_output 这一个函数体。
_dc_body = src.split('def decode_output')[1].split('\ndef ')[0]
# ★ docstring 在函数【开头】，所以代码体是最后一个 '"'*3 之后的部分。
#   （原来的写法取了最后一段，等于把代码当成了说明，还反过来要求
#    "说明里有 latin-1" —— 结果那条断言恒假、却从来没人发现。）
_parts = _dc_body.split('"""')
_code_body = _parts[-1] if len(_parts) > 2 else _dc_body
_doc_body = _parts[1] if len(_parts) > 2 else _dc_body
ok('decode_output 代码里不再有 latin-1 候选链', 'latin-1' not in _code_body)
ok('decode_output 的说明里讲了为什么没有 latin-1 候选',
   'latin-1' in _doc_body)
# ★ 原来这里还有一条"D W A R F 规范化处的 latin-1 用法保留"。
#   那段代码（用 objcopy 抽 .debug_* 出来、按 latin-1 当文本正则改偏移再写回）
#   已经整块删掉了 —— 现在读的是 DWARF 二进制，不需要任何文本化。
#   所以这条断言没有对象了，跟着一起删，而不是留一个恒真的空壳。
ok('DWARF 读取器里没有文本化 hack',
   'latin-1' not in read('tools/scut_dwarf.py'))

print('\n=== 12. 面向用户的产物里不得出现"设置界面"（G1） ===')

# ★★ 为什么这条断言是"最高杠杆"的一条 ★★
#
#   项目自己在 docs/架构设计.md §7.3 立了规矩：凡会写进用户工程 / 生成物的
#   字符串，一律指向「插件配置面板」或 scut_project.json，
#   不得出现"设置界面"/"settings.json" —— 因为那个设置区 0.9.4 就删了。
#
#   而实测：templates/starter/code/camera.c 有两处、
#   templates/README-pic.txt 有三处、tools/scut_build.py 有四处仍在这么写。
#   它们长期残留的根因就是【没有任何测试守着】。
#
#   ★ 判据刻意区分两类位置，因为危害不同：
#       · templates/  + GLUE_HEAD  → 会随每个新工程 / 每次构建发到用户眼前
#       · tools/ 其它                 → 只影响控制台输出，危害小
#     所以前者从严（零容忍），后者允许但记录。
for rel, must in (
        ('templates/starter/code/camera.c', True),
        ('templates/README-pic.txt', True),
        ('tools/scut_build.py', False)):
    body = read(rel)
    hits = []
    for i, line in enumerate(body.split('\n'), 1):
        if line.strip().startswith('#'):      # Python 注释不算产物
            continue
        if '设置界面' in line or 'settings.json' in line:
            hits.append('%s:%d' % (rel, i))
    if must:
        ok('%s 里没有"设置界面/settings.json"（会发到用户眼前）' % rel,
           not hits, '; '.join(hits))
    else:
        # 只记录不判失败：它不进用户工程，属可控范围
        print('  NOTE  %s 有 %d 处（仅控制台输出，不阻断）' % (rel, len(hits)))

print('\n=== 13. webview 前端静态自检（G7） ===')

# ★★ 为什么需要这一条 ★★
#
#   实测踩过的坑（第 12 轮评审发现）：simview.js 里 renderStructDetail
#   被调用但【全仓零定义】。后果是用户点「展开字段」就 ReferenceError。
#   而这个问题【现有测试体系完全看不见】—— 因为：
#     · 它是纯前端缺陷，Node 侧测试加载不了 webview 沙箱；
#     · 集成工程恰好没踩到（全局量以标量/数组为主）；
#     · 功能测试要真跑一遍 GUI，成本高。
#
#   而"被调用但未定义"这类缺陷是【可静态检查】的：
#   提取全部函数/变量声明，与全部被调用标识符做差集即可。
#   加这一条之后，未来任何"调用了不存在的函数"都会在 CI 当场暴露。

def js_declared_names(text):
    """提取 JS 里声明的函数名与 var/let/const 名。"""
    names = set()
    # function foo(  /  function foo (
    for m in re.finditer(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', text):
        names.add(m.group(1))
    # var foo = / let foo = / const foo =
    for m in re.finditer(r'\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)', text):
        names.add(m.group(1))
    # 函数参数（形参名也占命名空间，误报会很多，但这里只取少见的）
    for m in re.finditer(r'function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)', text):
        for p in m.group(1).split(','):
            p = p.strip()
            if re.fullmatch(r'[A-Za-z_$][\w$]*', p or ''):
                names.add(p)
    return names


def js_called_names(text):
    """提取 JS 里被【调用】的【裸】标识符（foo( 形式）。

    ★ 必须排除【成员调用】`obj.foo(`：
      那些是对象方法（`arr.push(`、`el.appendChild(`、`str.trim(`），
      不是本文件需要定义的函数。第一版没排除，报了 28 个假缺失
      （add/appendChild/push/trim…）—— 又是"判据比事实更宽"。
    """
    called = set()
    # 剥掉注释，避免把注释里提到的名字当调用
    t = re.sub(r'/\*[\s\S]*?\*/', ' ', text)
    t = re.sub(r'//[^\n]*', ' ', t)
    # 剥掉字符串字面量（'xxx' / "xxx"），里面的 ( 不算调用
    t = re.sub(r"'(?:\\.|[^'\\])*'", "''", t)
    t = re.sub(r'"(?:\\.|[^"\\])*"', '""', t)
    # 逐个字符扫，只看"前面不是 . 也不是标识符字符"的调用
    for m in re.finditer(r'([A-Za-z_$][\w$]*)\s*\(', t):
        start = m.start(1)
        prev = t[start - 1] if start > 0 else ''
        if prev == '.':
            continue                      # 成员调用，跳过
        called.add(m.group(1))
    return called


# 浏览器/vscode 内建与常见全局 —— 不是本文件缺失
JS_BUILTINS = {
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof',
    'require', 'acquireVsCodeApi', 'getState', 'setState', 'postMessage',
    'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date',
    'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'addEventListener', 'removeEventListener',
    'createElement', 'createImageData', 'getContext', 'querySelector',
    'ResizeObserver', 'Uint8Array', 'Uint8ClampedArray', 'ArrayBuffer',
    'Error', 'RegExp', 'Map', 'Set', 'Promise', 'console', 'document',
    'window', 'navigator', 'process', 'vscode', 'log',
}

for rel in ('extension/media/simview.js', 'extension/media/settingsview.js'):
    body = read(rel)
    declared = js_declared_names(body)
    called = js_called_names(body)
    missing = sorted(n for n in (called - declared)
                     if n not in JS_BUILTINS
                     and not re.match(r'^(?:el|document|window|vscode)\.', n))
    ok('%s 没有被调用但未定义的函数' % os.path.basename(rel),
       not missing, '缺失: ' + ', '.join(missing))

# renderVariables 的调用点都必须在 try 保护下（否则一次抛错停更整个变量区）
sv = read('extension/media/simview.js')
# 调用点数量（不含函数定义行本身）。报告里写的是 5 个，
# 后来新增按钮/折叠交互后变成 7 个 —— 这个数字只用于"发现新增裸调用"，
# 不是硬契约，所以用 >= 而不是 ==。
_render_calls = len(re.findall(r'(?<![\w.])renderVariables\(\)', sv)) - 1
ok('renderVariables() 有多个调用点（每处都该被 try 保护）',
   _render_calls >= 5, '实际 %d 个' % _render_calls)
# vars 消息分支必须包 try/catch —— 它是每帧都会走的高频路径
# ★ 结尾按"任意 6 空格缩进"匹配，不写死具体缩进：改格式化就会假红。
_vars_branch = re.search(r"case 'vars'\s*:\s*\{(.*?)\n\s{6}\}", sv, re.S)
if _vars_branch:
    ok("case 'vars' 分支有 try/catch 兜底",
       'try {' in _vars_branch.group(1))
else:
    ok("case 'vars' 分支存在", False)

print('\n=== 14. 用户可见文档不得教已删除/已改名的注册宏 ===')
# ★ 这条守的是【发给用户的文档】，不是内部设计文档。
#   内部文档（docs/架构设计.md 等）讲历史与现状，写 SCUT_REGISTER 无妨；
#   但 templates/ 与 tools/README.md 会直接进用户视野，
#   教一个既已改名（SCUT_REGISTER → ENV_REGISTER）
#   又【只给生成代码用、用户代码不该碰】的宏，是实打实的误导。
#
#   ★ 注意 tools/scut_build.py 里生成接线单元时确实要写 ENV_REGISTER，
#   所以断言只针对"面向用户的散文"，不做全树禁用 ——
#   否则会把正确的那两处也判成违规。
USER_DOCS = ('templates/README-pic.txt', 'templates/starter/code/camera.c',
             'tools/README.md')
for rel in USER_DOCS:
    body = strip_comments(read(rel))
    ok('%s 不教用户用 SCUT_REGISTER（已改名且仅供生成代码）' % rel,
       'SCUT_REGISTER' not in body)
    ok('%s 不教用户用 ENV_REGISTER（那是接线单元的内部宏）' % rel,
       'ENV_REGISTER' not in body)

# 零注册是核心设计理念，正向断言它被写出来了 ——
# 防止哪天有人"好心"把注册说明加回用户文档。
#
# ★★ 这里【必须读原文，不能 strip_comments】★★
#   camera.c 整个文件几乎全是注释：它是"给学生的说明书"，
#   而说明书本身就是注释。剥掉注释等于把要检查的内容全删了，
#   判据会恒假。
#   上面 §14 的判据要的是"别教已删的宏"——那是【不该出现】的内容，
#   剥注释是对的；而这条要的是"该讲的讲了"——内容就在注释里，
#   剥掉就什么也看不见。
#   两种方向的判据，用的文本必须相反，否则必然有一边恒假。
for rel in ('templates/starter/code/camera.c',):
    body = read(rel)          # ← 原文，不剥注释
    ok('%s 说明了函数名由配置指定（零注册设计）' % rel,
       ('钩子函数' in body or 'hooks' in body)
       and 'scut_project.json' in body)

# 图集说明里的过时配置路径（第 12 轮复核发现）：
#   README-pic.txt 有三处让用户去改 config.h 的宏，但模板里【已经没有
#   config.h 这个文件】了，配置早已搬进 scut_project.json；
#   照着改的用户会找不到文件。新工程一律用 scut_project.json。
_pic = read('templates/README-pic.txt')
ok('README-pic.txt 不再让用户改 config.h 的宏', 'config.h' not in _pic)
ok('README-pic.txt 指向 scut_project.json',
   'scut_project.json' in _pic)
# ★ 但 SCUT_IMAGE_H 作为【算法可用的宏】必须留着 ——
#   它确实还在生成物里（scut_config.h），删掉才是真的破坏功能。
ok('README-pic.txt 保留算法可用的 SCUT_IMAGE_H 说明',
   'SCUT_IMAGE_H' in _pic)
# 格式支持：不能说"仅 BMP"——真实工程里就在用 .png。
ok('README-pic.txt 说明了 PNG 也支持',
   'PNG' in _pic or 'png' in _pic)
ok('README-pic.txt 不再说"目前仅此一种"',
   '仅此一种' not in _pic)
ok('README-pic.txt 说明扩展名由 pic.ext 决定',
   '"ext"' in _pic or 'ext' in _pic)

# ---------------------------------------------------------------------------
# 15. 变量详情区不得显示它拿不到的字段
# ---------------------------------------------------------------------------
# N1（第 12 轮复核发现）：renderStructDetail 曾显示 v.elemBytes，
# 而 renderVariables 传给它的 picked 对象【没有】这个字段
# （simview.js 的 picked.push 只带 name/dims/kind/isStatic/total/manual），
# 于是恒为 undefined → 用户看到「整体大小（0 字节）」——
# 一个看起来像 bug 的错误数字，比不显示更糟。
#
# ★ 判据是"别去读拿不到的字段"，而不是"必须显示字节数"：
#   大小本来就显示在值栏里（C 侧渲染成 "<104B>"），
#   详情区再说一遍是冗余。这条守住的是"别引入假数据"。
sv2 = read('extension/media/simview.js')
# ★ 变量名从 picked 改成了 picked2（拆分 renderPicks / renderVars 时改的）。
#   判据本身没变：那个对象里有哪些字段。
_picked = re.search(r'picked2?\.push\(\{(.*?)\}\)', sv2, re.S)
ok('renderVariables 传入的 picked 对象存在（判据前提）', _picked is not None)
if _picked:
    _has_eb = 'elemBytes' in _picked.group(1)
    # 两条路都允许：要么不读 elemBytes，要么真的把它带上。
    # 只禁止"既不传、又去读"。
    _detail = re.search(r'function renderStructDetail.*?\n  \}', sv2, re.S)
    _reads_eb = bool(_detail and 'elemBytes' in
                     re.sub(r'^\s*\*.*$', '', _detail.group(0), flags=re.M))
    ok('renderStructDetail 不读一个没被传进来的字段',
       (not _reads_eb) or _has_eb,
       'picked 里没有 elemBytes，但 renderStructDetail 读了它')

print('\n=== 16. 本轮修复的回归：元素宽度、包装单元、autoDownload ===')

# H1：SCUT_Watch 必须按类型推导元素宽度，而不是全信调用方传的 sizeof。
watch_c = read('core/src/scut_watch.c')
ok('scut_watch.c 有按类型推导宽度的表',
   re.search(r'static\s+int\s+type_width\s*\(', watch_c) is not None)
ok('SCUT_Watch 对已知类型采用推导出的宽度',
   re.search(r'type_width\s*\(\(int\)t\)\s*>\s*0', watch_c) is not None)

# H2：包装单元在 #include 用户源码之后要重新锚定行号，防止未闭合注释吞掉构造函数。
sym_src = read('tools/scut_symbols.py')
ok('包装单元里有 #line 重新锚定',
   '#line 1 "<scut_autoreg>"' in sym_src)

# 4.2：手写注册的判据要覆盖 ARRAY 与用户包装宏。
ok('手写注册扫描覆盖所有 SCUT_Watch 家族名字',
   r"\b[A-Za-z_]\w*SCUT_Watch\w*\s*\(" in sym_src)

# autoDownload：配置字段已删，任何一侧再引入都会被这条拦住。
pc_ts = read('extension/src/projectconfig.ts')
cfg_ts = read('extension/src/configfields.ts')
sb_src = read('tools/scut_build.py')
ok('ProjectConfig 里没有 autoDownload 字段',
   not re.search(r'autoDownload\s*:', pc_ts) or '没有 autoDownload 字段' in pc_ts)
ok('配置面板字段表里没有 autoDownload', 'autoDownload' not in cfg_ts)
ok('scut_build.py 的 DEFAULT_CONFIG 没有 autoDownload',
   '"autoDownload"' not in sb_src)

# 后端的 --no-draw / --no-log 要真的接到调度器上（否则又是"能设不能生效"）。
ok('后端解析 --no-draw', '"--no-draw"' in host_c)
ok('后端解析 --no-log', '"--no-log"' in host_c)
ok('--no-draw 会调 set_draw_enabled',
   re.search(r'if\s*\(o\.no_draw\)\s*\{\s*scut_sched_set_draw_enabled\(0\)', host_c, re.S) is not None)
ok('--no-log 会调 set_log_enabled',
   re.search(r'if\s*\(o\.no_log\)\s*\{\s*scut_sched_set_log_enabled\(0\)', host_c, re.S) is not None)

# build_vars_json 不允许"先拷条目、最后补 ']'"的越界收尾。
ok('build_vars_json 不再有事后回退找 }',
   'while (k > 0 && out[k]' not in host_c)

print('\n=== 17. 打包完整性：tools/ 的每个模块都要进 vsix ===')

# ★ 这条守的是一类【只在用户机器上才发作】的缺陷：
#   sync-sdk.js 原来逐个列文件（scut_build.py / scut_symbols.py）。
#   加了 scut_dwarf.py 之后那两条没跟着改，于是仓库里测试全绿、
#   而打出来的 vsix 里 sdk/tools/ 少了它 —— 装上去就是
#   "变量面板永远是空的"，还在用户那边。现在改成整目录同步，
#   这条断言盯的是【别再退回逐个列文件】。
sync_js = read('extension/scripts/sync-sdk.js')
ok('sync-sdk.js 整目录同步 tools/',
   re.search(r"from:\s*'tools',\s*to:\s*'sdk/tools'", sync_js) is not None)
ok('sync-sdk.js 的 REQUIRED 覆盖 scut_dwarf.py',
   "'sdk/tools/scut_dwarf.py'" in sync_js)
ok('sync-sdk.js 会跳过 __pycache__',
   "'__pycache__'" in sync_js)

# scut_symbols.py 必须在【同一个目录】里 import scut_dwarf，
# 否则打包后路径一变就 ImportError。
ok('scut_symbols 从同目录导入 scut_dwarf',
   re.search(r'import\s+scut_dwarf', sym_src) is not None)
ok('scut_symbols 不再 import 已删掉的解析辅助',
   'from collections import OrderedDict' not in sym_src)

print('\n=== 18. 图片1 / 图片2：C → 帧 JSON → 插件 → 面板 的通路必须完整 ===')

# ★ 守的是一类"每一段都对、拼起来不通"的缺陷：
#   这个功能横跨六个文件（bind / input / sched / 后端 / 插件 / 前端）。
#   少接一段的表现不是报错，而是"代码写了，面板上什么都没有"，
#   而用户报告里只会写"图片2不显示"，看不出断在哪一段。
#   所以这里逐段断言，缺哪段就报哪段。
bind_h = read('core/include/scut_bind.h')
sdk_h = read('core/include/scut_sdk.h')
draw_h = read('core/include/scut_draw.h')
input_c = read('core/src/scut_input.c')
sched_c = read('core/src/scut_sched.c')
sv3 = read('extension/media/simview.js')

ok('bind 头文件声明了第二块输出图',
   'scut_bind_output2' in bind_h and 'scut_bind_output2_used' in bind_h)
ok('bind 单元真的分配了第二块缓冲',
   'second_image' in bind_code and 'scut_bind_output2(void)' in bind_code)
ok('sdk 头文件用"选图参数"统一了四个接口（不再有 *2 那套）',
   'SCUT_OutImage2Set' not in sdk_h
   and 'SCUT_EnvCopyOutput2' not in sdk_h)
# ★ 选图就是裸数字 1 / 2：不设 SCUT_IMG_1 之类的宏。
#   判据只扫【代码】（去掉注释），因为解释"为什么不用宏"的注释里必然出现这个词。
_sdk_code = strip_comments(sdk_h)
ok('sdk 头文件不提供选图宏（用户直接写 1 / 2）',
   'SCUT_IMG_' not in _sdk_code, '仍然定义了选图宏')
ok('四个接口的签名都带 img 参数',
   re.search(r'void SCUT_OutImageSet\(int img,', sdk_h) is not None
   and re.search(r'void SCUT_OutImageSetRGB\(int img,', sdk_h) is not None
   and re.search(r'scut_u8 SCUT_OutImageGet\(int img,', sdk_h) is not None
   and re.search(r'void SCUT_EnvCopyOutput\(int img,', sdk_h) is not None)
ok('四个接口只有一处实现（不会再出现两份写入代码）',
   input_c.count('void SCUT_OutImageSet(int img') == 1
   and input_c.count('void SCUT_EnvCopyOutput(int img') == 1
   and 'SCUT_OutImageSet(int x, int y' not in read('core/src/scut_draw.c'))
ok('draw.h 不再重复声明输出图写入（声明只在 sdk.h 一处）',
   'SCUT_OutImageSet(' not in draw_h.split('见 scut_sdk.h')[1])
ok('写入时会记账（图片2 用过 / 图片1 本帧写过）',
   'scut_bind_output2_mark()' in input_c
   and 'scut_draw_mark_output_written()' in input_c)
ok('调度器每帧清空图片2',
   'scut_env_clear_second_output();' in sched_c)
ok('后端只在用过之后才写那张图',
   'scut_bind_output2_used()' in host_c)
ok('后端的帧 JSON 带 img2 字段', '"img2"' in host_c)
ok('图片2 落盘文件名带 _b 后缀', 'frame_%04d_b.ppm' in host_c)
ok('生成的接线单元用 1（图片1）搬运结果图',
   'SCUT_EnvCopyOutput(1,' in read('tools/scut_symbols.py')
   and 'SCUT_EnvCopyOutput(1,' in read('tools/scut_build.py'))

# 插件侧：会话读取 → 宿主转发 → 前端渲染，三段都要在。
# ★ 这里【不再】断言任何"显示开关"：用户要求删掉它
#   （「不要选择开启」），两栏恒在、开合只由标题控制。
# ★ 只扫【代码】（去掉注释）：解释"为什么删掉那个开关"的注释里必然出现这些词。
# ★ 2026-10 补充：projectconfig.ts 里【允许】出现这些名字，但只能在
#   DEPRECATED_KEYS 那张清理表里 —— 那是"把老工程里的废弃键删掉"用的，
#   与"又把它做回配置项"是相反的两件事。所以判据从"全文不许出现"
#   收窄成"不许出现在默认值与类型定义里"，再单独断言它出现在清理表中。
def _region(text, start_pat, end_pat):
    m = re.search(start_pat + r'([\s\S]*?)' + end_pat, text)
    return m.group(1) if m else ''


pc_defaults = _region(pc_ts, r'export function defaultConfig\(\)[^{]*\{', r'\n\}')
ok('默认配置里没有"要不要显示图片2"这类开关',
   'secondImage' not in pc_defaults and 'runFrames' not in pc_defaults)
ok('配置面板字段表里没有这类开关',
   'secondImage' not in strip_comments(cfg_ts, 'ts')
   and 'runFrames' not in strip_comments(cfg_ts, 'ts'))
ok('scut_build.py 的 DEFAULT_CONFIG 没有 display 段',
   '"display"' not in strip_comments(sb_src, 'py'))
ok('已废弃的键在清理表里（否则老工程里的键永远删不掉）',
   re.search(r'DEPRECATED_KEYS[\s\S]{0,400}?secondImage', pc_ts) is not None
   and re.search(r'DEPRECATED_KEYS[\s\S]{0,400}?runFrames', pc_ts) is not None
   and re.search(r'DEPRECATED_KEYS[\s\S]{0,400}?autoDownload', pc_ts) is not None)
ok('会话读到 rgb2 就读（不再看开关）',
   re.search(r'if\s*\(frame\.img2\)', read('extension/src/simsession.ts')) is not None)
ok('宿主把 rgb2 转发给面板',
   re.search(r'if\s*\(f\.rgb2\)', read('extension/src/simview.ts')) is not None)
ok('前端把 rgb2 画到第二块画布',
   re.search(r'panes\[1\]\.draw\(rgb2', sv3) is not None)
ok('两块画面的缩放各自独立（不是一份全局 zoom）',
   'state.zoom' not in sv3 and 'st.zoom' in sv3)
# ★ 默认开合只有一种：收起（用户要求）。
#   0.10.7 曾让它随页面而变（监控窗口展开），那个窗口撤了，判断也就回到最简单。
ok('两块画面默认【收起】',
   re.search(r'open:\s*false,\s*zoom: 1', sv3) is not None
   and re.search(r'd\.open = s\.open === true', sv3) is not None)
# ★ 撤销得干净：那个窗口留下的东西一样都不许在。
ok('独立监控窗口（0.10.7 试过又撤掉）没有残留',
   'PIC_MODE' not in strip_comments(sv3)
   and 'data-mode' not in strip_comments(sv3)
   and not os.path.exists(os.path.join(ROOT, 'extension/src/monitorview.ts')))
ok('两栏标题就是「图片1」「图片2」',
   '>图片1<' in read('extension/src/simview.ts')
   and '>图片2<' in read('extension/src/simview.ts'))
ok('旧的单画面 id 已全部改名（防止半新半旧两套 DOM）',
   'screen-section' not in sv3)

# ★★ 翻页/测速/停止这几个键【不许】再绑回 package.json 的 keybindings ★★
#
#   0.10.7 之前它们绑在那里（`when: view == scut71.simview`），结果从来没生效过：
#   侧边栏聚焦时 `←`/`→`/`F9`/`Shift+F5` 一律没反应，而文档还写着"需视图聚焦"。
#   现在它们由 media/simview.js 的 keydown 直接发命令（见 test_webview_js 的
#   `keys` 场景）。绑回去的后果不是"多一层保险"，是**双触发**：
#   页面自己发一次，VS Code 的键位再发一次，按一下翻两页。
_pkg = json.loads(read('extension/package.json'))
_view_keys = {k['command'] for k in _pkg['contributes'].get('keybindings', [])
              if 'scut71.simview' in str(k.get('when', ''))}
ok('翻页/测速/停止没有再绑 VS Code 键位（否则会和页面里的处理双触发）',
   not (_view_keys & {'scut71.prevPic', 'scut71.nextPic',
                      'scut71.bench', 'scut71.stop'}),
   '仍在 keybindings 里：%s' % sorted(_view_keys))
ok('页面自己认这些键（+ - ← → F9 Shift+F5）',
   "'nextPic'" in sv3 and "'prevPic'" in sv3
   and "'F9'" in sv3 and "e.shiftKey" in sv3)

print('\n=== 19. 「运行 N 帧」已彻底删除（不留半截） ===')

# ★ 为什么这条要单独守：删掉一个按钮最容易只删掉"看得见的那一半"——
#   按钮没了，但命令还注册着、F8 还绑着、配置项还躺在面板里。
#   用户看到的是一个按 F8 毫无反应的编辑器，而日志里什么都没有。
pkg_json = read('extension/package.json')
ext_ts = read('extension/src/extension.ts')
sess_ts = read('extension/src/simsession.ts')
for name, body, needle in [
    ('package.json 没有 scut71.run 命令', pkg_json, '"scut71.run"'),
    ('package.json 没有行为 runFrames 的配置项', pkg_json, '"runFrames"'),
    ('extension.ts 不再注册 scut71.run', ext_ts, "'scut71.run'"),
    ('simview.ts 不再有 run() 方法', read('extension/src/simview.ts'), 'async run()'),
    ('simsession.ts 不再有 runFrames', sess_ts, 'runFrames('),
    # ★ 判据要避开"说明为什么删掉"的注释 —— 本项目习惯把历史留在原地
    #   （见 test_cleanup 文件头：只看代码，不看注释）。
    ('types.ts 不再声明 runFrames', read('extension/src/types.ts'),
     re.compile(r'runFrames\(n: number\):\s*Promise')),
    ('configfields.ts 不再列 runFrames', cfg_ts, "['run', 'runFrames']"),
    ('projectconfig.ts 不再有 runFrames 字段', pc_ts, 'runFrames: number'),
    ('scut_build.py 的默认配置不再有 runFrames', sb_src, '"runFrames"'),
    ('simsession.ts 不再有 pendingSteps（连续播放的计数器）', sess_ts,
     re.compile(r'this\.pendingSteps')),
]:
    # ★ 判据可以是字符串（子串）或正则。用正则的那种是为了避开
    #   "说明为什么删掉"的注释 —— 本项目习惯把历史留在原地，
    #   拿裸子串去查会把正确的注释判成回潮（这条已踩过一次）。
    hit = needle.search(body) if hasattr(needle, 'search') else (needle in body)
    ok(name, not hit, '仍然出现：%s' % (
        needle.pattern if hasattr(needle, 'pattern') else needle))

# 播放图标归「编译」：一个图标只对一个命令。
ok('「编译」命令用播放图标 $(play)', '"icon": "$(play)"' in pkg_json)
ok('没有别的命令再用 $(play)',
   pkg_json.count('"icon": "$(play)"') == 1)
ok('仿真视图里的编译按钮带播放图标', '▶ 编译' in read('extension/src/simview.ts'))
ok('F8 键位已删除（它绑的是被删掉的「运行」）',
   '"f8"' not in pkg_json)

print('\n=== 20. 文档里不许写死测试工程的路径 ===')

# ★ 守的是一类"别人 clone 下来就对不上"的缺陷：
#   测试工程在仓库外，名字由用户定。把它写进文档，等于把开发机的目录结构
#   带进仓库 —— 新人照着找，永远找不到那个目录，还以为是自己哪里没配。
#   ★ 判据只查【路径形态】（相对上一级 + 工程名、盘符 + 用户目录名），
#     不查"提到测试工程"这件事本身：文档里说"测试材料在仓库内，
#     不依赖仓库外的目录"是正确的话，不该被这条挡住。
docs = [n for n in os.listdir(ROOT) if n.lower().endswith('.md')] + \
       [os.path.join('docs', n) for n in os.listdir(os.path.join(ROOT, 'docs'))
        if n.lower().endswith('.md')] + \
       [os.path.join('extension', 'README.md'), os.path.join('tools', 'README.md')]

# 归一化：去掉 __pycache__ 噪音，任何盘符/用户名都算硬编码。
# ★ 判据只用"具体工程名"这一条，不拿正则去猜"什么算路径" ——
#   正则版第一稿把 `--toolchain C:\llvm-mingw` 这种【格式示例】也判成了泄漏：
#   那句是"换成你自己那台机器上的位置"，本来就是给用户看的写法。
#   宁可少拦，也不要拦错；真正要防的就是"把某个人的工程目录写进仓库"。
# ★ 自己也要排除在外：本文件里必须写出这些名字，才算得出"哪儿泄漏了"。
#   同理排除 test_mem_safety.py（它查的是另一个主题，且需要写出 anaconda3 这个名字）。
BAD_NAMES = ('scut71-project', '集成仿真环境测试', '22车队管理', 'anaconda3')
_SELF = {'test_cleanup.py', 'test_mem_safety.py'}
# ★ 流水账是【个人逐轮记录】，本来就按时间记着当时在哪个目录里干了什么，
#   而且它被 .gitignore 排除、不进仓库。要守的是"仓库里的文档别把
#   开发机的目录结构当成事实写进去"，不是"私人笔记不许提自己的目录"。
_NOT_SHIPPED = {'改动流水账.md'}
_DOC_EXCLUDE = _SELF | _NOT_SHIPPED

leaks = []
for rel in docs:
    path = os.path.join(ROOT, rel)
    if not os.path.isfile(path):
        continue
    if os.path.basename(rel) in _DOC_EXCLUDE:
        continue
    text = io.open(path, encoding='utf-8').read()
    for name in BAD_NAMES:
        if name in text:
            leaks.append('%s: 出现 %s' % (rel, name))
for bad in leaks:
    print('      ' + bad)
ok('文档里没有写死外部测试工程的名字/路径', not leaks,
   '共 %d 处' % len(leaks))

# 代码侧：测试脚本也不许给"仓库外某个具体工程"兜底。
code_files = [os.path.join('tests', n) for n in os.listdir(os.path.join(ROOT, 'tests'))
              if n.endswith(('.py', '.js'))]
code_leaks = []
for rel in code_files:
    if os.path.basename(rel) in _DOC_EXCLUDE:
        continue
    text = io.open(os.path.join(ROOT, rel), encoding='utf-8').read()
    for name in BAD_NAMES:
        if name in text:
            code_leaks.append('%s: 出现 %s' % (rel, name))
for bad in code_leaks:
    print('      ' + bad)
ok('测试脚本里没有写死外部测试工程的名字/路径', not code_leaks,
   '共 %d 处' % len(code_leaks))

# ---------------------------------------------------------------------------
# 21. clangd 索引（0.12.1 修）
# ---------------------------------------------------------------------------
# ★★ 这条守的是什么 ★★
#
#   用户报："clangd 访问不到仿真环境库，函数无法索引"。
#   根因是编译数据库从来没被生成过 —— 插件自己的 -I 只活在构建脚本内部，
#   clangd 一无所知，于是 `#include "scut_sdk.h"` 永远标红。
#
#   这套东西有三个环节，缺任何一个都会静默退回"没有索引"：
#     ① 生成 .scut/compile_commands.json（内容要含真实 -I）
#     ② 写 .clangd 的 CompilationDatabase 指过去（clangd 只向上找，
#        .scut 是同级目录，不给这一句它永远找不到）
#     ③ 不能覆盖用户自己写的 .clangd，也不能越构建越长（幂等）
#   ①②是纯事实，在源码里断言即可；③是行为，下面直接跑真函数验。
_bs = read('tools/scut_build.py')
ok('scut_build.py 生成 clangd 编译数据库', 'def write_compile_db' in _bs)
ok('scut_build.py 维护 .clangd', 'def ensure_clangd_config' in _bs)
ok('编译数据库写进 .scut（生成物目录，不污染工程根）',
   'os.path.join(proj.scut_dir, "compile_commands.json")' in _bs)
ok('.clangd 用 CompilationDatabase 指向 .scut',
   'CompilationDatabase: .scut' in _bs)
# ★ 为什么不索引生成的包装单元：那是把用户源码 include 进来的产物，
#   索引它等于同一符号两份，跳转会落到拼接出来的生成文件里。
# ★ 判据要看【代码】而不是注释：本函数的说明里恰好会讲到"排除 wrapped"，
#   拿 'wrapped' 全文搜索会命中那段注释 —— 一条恒假的断言比没有更糟。
ok('编译数据库只收用户 .c（排除生成的包装单元）',
   '[one(s) for s in sources]' in _bs)

# 行为验证：幂等 + 不覆盖用户配置。直接 import 那个脚本跑真函数。
# ★ 为什么值得真跑：上面几条都是"字符串在不在"，而这条缺陷的形态
#   恰恰是"字符串都在、行为不对"（连跑两次多一个 --- 分隔符）。
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location(
    '_sb', os.path.join(ROOT, 'tools', 'scut_build.py'))
_sb = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_sb)


class _Quiet(object):
    def detail(self, msg):
        pass

    def human(self, msg):
        pass


import tempfile as _tf

with _tf.TemporaryDirectory() as _td:
    class _P(object):
        root = _td
        scut_dir = os.path.join(_td, '.scut')

    os.makedirs(_P.scut_dir)
    _cl = os.path.join(_td, '.clangd')

    # ① 空工程：建出来、且内容正确
    _sb.ensure_clangd_config(_P, _Quiet())
    _first = io.open(_cl, encoding='utf-8').read()
    ok('空工程会建出 .clangd 且指向 .scut',
       'CompilationDatabase: .scut' in _first)

    # ② 连跑 5 次：内容必须完全不变（幂等）
    for _ in range(5):
        _sb.ensure_clangd_config(_P, _Quiet())
    _after = io.open(_cl, encoding='utf-8').read()
    ok('.clangd 幂等（连跑 5 次不累积 --- 分隔符）', _after == _first,
       '长度 %d → %d' % (len(_first), len(_after)))

    # ③ 用户已有配置：一个字符都不许动
    io.open(_cl, 'w', encoding='utf-8', newline='').write(
        '# 用户自己的\nCompileFlags:\n  CompilationDatabase: my_dir\n')
    _user = io.open(_cl, encoding='utf-8').read()
    _sb.ensure_clangd_config(_P, _Quiet())
    ok('用户自己配了 CompilationDatabase 时完全不碰 .clangd',
       io.open(_cl, encoding='utf-8').read() == _user)

    # ④ 用户有其它配置（没有 CDB）：保留原内容 + 追加我们那段
    io.open(_cl, 'w', encoding='utf-8', newline='').write(
        '# 用户自己的\nCompileFlags:\n  Add:\n    - -Wall\n')
    _sb.ensure_clangd_config(_P, _Quiet())
    _merged = io.open(_cl, encoding='utf-8').read()
    ok('用户已有 .clangd 时保留原内容并追加',
       '# 用户自己的' in _merged and 'CompilationDatabase: .scut' in _merged)

print('\n' + '=' * 60)
if FAIL == 0:
    print('全部 %d 项通过' % PASS)
else:
    print('%d/%d 项通过，%d 项失败：' % (PASS, PASS + FAIL, FAIL))
    for f in FAILED:
        print('  - %s' % f)
print('=' * 60)
sys.exit(0 if FAIL == 0 else 1)
