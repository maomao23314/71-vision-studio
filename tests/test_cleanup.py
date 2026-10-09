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
import os
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
ok('strerror 有对应文案', '内存不足：图片太大' in frame_c)
# 4 处分配失败都要用它：读文件 1 处 + PNG 3 处
n_nomem = frame_c.count('SCUT_FRAME_ERR_NOMEM')
ok('scut_frame.c 至少 4 处使用（1 读文件 + 3 PNG 缓冲）', n_nomem >= 4, n_nomem)
ok('不再把内存不足归因为 PNG_FORMAT',
   '内存不足：按「数据无效」归因' not in frame_c)
ok('宿主有 NOMEM 专门分支', 'case SCUT_FRAME_ERR_NOMEM:' in host_c)
ok('宿主文案说明"图片本身没有问题"', '图片本身没有问题' in host_c)

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
# 追加字段都要在文档里
for field in ('loadError', 'bench', 'vars'):
    ok('协议文档提到 %s 字段' % field, field in host_c)

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

# objdumpVersion 要出现在 JSON 里（doctor 的人读输出里有它）
tc = sb.Toolchain()
tc.objdump_version = 'GNU objdump 2.40'
ok('to_json 导出 objdumpVersion',
   tc.to_json().get('objdumpVersion') == 'GNU objdump 2.40')

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
# ★ 只判【代码体】，不判 docstring：docstring 里引用旧写法
#   （"原先写的是 for enc in (...,latin-1)"）是正确的记录。
_code_body = _dc_body.split('"""')[-1] if '"""' in _dc_body else _dc_body
ok('decode_output 代码里不再有 latin-1 候选链', 'latin-1' not in _code_body)
ok('decode_output 的注释里说明了为什么去掉 latin-1',
   'latin-1' in _dc_body)
ok('DWARF 规范化处的 latin-1 用法【保留】（那是正当的）',
   'raw.decode("latin-1")' in src)

print('\n' + '=' * 60)
if FAIL == 0:
    print('全部 %d 项通过' % PASS)
else:
    print('%d/%d 项通过，%d 项失败：' % (PASS, PASS + FAIL, FAIL))
    for f in FAILED:
        print('  - %s' % f)
print('=' * 60)
sys.exit(0 if FAIL == 0 else 1)
