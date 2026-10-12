#!/usr/bin/env python3
"""
test_symbols.py -- scut_symbols.py 的回归测试。

用法:
    python tests/test_symbols.py                    # 用 PATH 里的 gcc
    python tests/test_symbols.py --cc <clang.exe>   # 指定编译器
    python tests/test_symbols.py --cc <gcc> --also <clang>   # 双工具链交叉验证

覆盖:
    1. 基础类型全谱（14 种）符号性是否正确
    2. 一维 / 二维 / 三维数组的维度与元素数
    3. 结构体 / 嵌套结构体 / 结构体数组 / 联合 / 枚举 / 指针 / const / static
    4. ★ 函数内 static 局部变量【必须被排除】（陷阱 P-3）
    5. ★ objdump 间接字符串前缀必须被剥离（陷阱 P-2，gcc/clang 一致性）
    6. 生成文件必须能被编译器接受

退出码 0 = 全部通过。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

# Windows 控制台默认是 GBK，直接 print ✅/❌ 会抛 UnicodeEncodeError。
# 统一把标准输出改成 UTF-8（不可编码的字符替换掉），保证脚本在任何终端可运行。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOOL = os.path.join(ROOT, 'tools', 'scut_symbols.py')
FIXT = os.path.join(HERE, 'fixtures', 'fixtures_all_types.c')

# 期望: 名字 -> (kind, dims, total)   dims=[] 表示标量
EXPECT = {
    # 基础类型（★ 符号性必须正确 —— 陷阱 P-2）
    'v_char':    ('SCUT_T_I8',   [], 1),
    'v_schar':   ('SCUT_T_I8',   [], 1),
    'v_uchar':   ('SCUT_T_U8',   [], 1),
    'v_short':   ('SCUT_T_I16',  [], 1),
    'v_ushort':  ('SCUT_T_U16',  [], 1),
    'v_int':     ('SCUT_T_I32',  [], 1),
    'v_uint':    ('SCUT_T_U32',  [], 1),
    'v_long':    ('SCUT_T_I32',  [], 1),
    'v_ulong':   ('SCUT_T_U32',  [], 1),
    'v_llong':   ('SCUT_T_I64',  [], 1),
    'v_ullong':  ('SCUT_T_U64',  [], 1),
    'v_float':   ('SCUT_T_F32',  [], 1),
    'v_double':  ('SCUT_T_F64',  [], 1),
    'v_bool':    ('SCUT_T_BOOL', [], 1),
    # 一维数组
    'a_int1':    ('SCUT_T_I32',  [120], 120),
    'a_float1':  ('SCUT_T_F32',  [8],   8),
    'a_u8_1':    ('SCUT_T_U8',   [256], 256),
    'a_double1': ('SCUT_T_F64',  [4],   4),
    # 二维 / 三维（★ 维度解析 —— A-15）
    'a_2d':       ('SCUT_T_U8',  [120, 188], 22560),
    'a_2d_small': ('SCUT_T_I32', [4, 8],     32),
    'a_2d_float': ('SCUT_T_F32', [3, 3],     9),
    'a_3d':       ('SCUT_T_I32', [2, 3, 4],  24),
    # ★ 数组 typedef（第 12 轮评审补的盲区）
    #   dims 必须是【外层 + 内层拼接】，total 按乘积算。
    #   ⚠️ 这条【只有 clang 会触发】—— 实测确认：
    #     · gcc 会把 typedef 拍平，DWARF 里看不到 DW_TAG_typedef，
    #       所以 gcc 跑这条是绿的很正常（不构成"已修好"的证据）；
    #     · llvm-mingw 的 clang 原样发出
    #          array_type[120] → DW_TAG_typedef(Row) → array_type[188]
    #       于是外层 _collect_dims 用 [120] 【覆盖】内层的 [188]
    #       → dims=[120] total=120。
    #     本项目的编译器固定是 clang，所以这才是真实路径。
    'td_row':       ('SCUT_T_U8', [120, 188], 22560),
    'td_img':       ('SCUT_T_U8', [120, 188], 22560),
    'td_row_small': ('SCUT_T_U8', [4, 188],   752),
    # 聚合类型
    's_point':     ('SCUT_T_STRUCT', [], 1),
    's_track':     ('SCUT_T_STRUCT', [], 1),
    's_track_arr': ('SCUT_T_STRUCT', [4], 4),
    'u_value':     ('SCUT_T_STRUCT', [], 1),   # union 归入 STRUCT
    'e_status':    ('SCUT_T_ENUM',   [], 1),
    'p_point':     ('SCUT_T_PTR',    [], 1),
    'p_str':       ('SCUT_T_PTR',    [], 1),
    # const
    'c_calib':   ('SCUT_T_F32', [3], 3),
    'c_gain':    ('SCUT_T_I32', [],  1),
    # static（★ internal linkage —— A-12）
    'st_single': ('SCUT_T_I32', [],   1),
    'st_array':  ('SCUT_T_I32', [16], 16),
    'st_float':  ('SCUT_T_F32', [],   1),
    'st_track':  ('SCUT_T_STRUCT', [], 1),
}

# 必须被排除的（陷阱 P-3：函数内 static 局部变量）
MUST_EXCLUDE = {'fixture_local_static'}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True,
                          errors='replace', **kw)


def parse_generated(path):
    """从生成的包装单元里解析出 (name, kind, total, dim)"""
    found = {}
    with open(path, encoding='utf-8-sig') as f:
        for line in f:
            m = re.search(r'SCUT_Watch\("(\w+)",\s*\(const void\*\)&\w+,\s*'
                          r'(SCUT_T_\w+),\s*(\d+),\s*(\d+),\s*(\d+)\)', line)
            if m:
                found[m.group(1)] = (m.group(2), int(m.group(3)),
                                     int(m.group(5)))
    return found


def check(cc, objdump, tmp, label, failures):
    print('\n=== [%s] 探针编译 ===' % label)
    src = os.path.join(tmp, 'fixtures.c')
    shutil.copyfile(FIXT, src)
    obj = os.path.join(tmp, 'fixtures.o')
    r = run([cc, '-std=c11', '-g', '-O0', '-c', src, '-o', obj])
    if r.returncode != 0:
        print('  ❌ 编译失败:\n%s' % r.stderr[:600])
        failures.append('%s: fixture compile failed' % label)
        return
    print('  ✅ %s' % os.path.basename(cc))

    out_c = os.path.join(tmp, 'fixtures.wrapped.c')
    out_j = os.path.join(tmp, 'fixtures.vars.json')
    r = run([sys.executable, TOOL, '--obj', obj, '--src', 'fixtures.c',
             '--out-c', out_c, '--out-json', out_j, '--objdump', objdump])
    if r.returncode != 0:
        print('  ❌ 生成失败:\n%s' % r.stderr[:600])
        failures.append('%s: generator failed' % label)
        return

    got = parse_generated(out_c)
    print('  发现 %d 个变量' % len(got))

    # --- 逐项核对 ---
    missing = [k for k in EXPECT if k not in got]
    if missing:
        print('  ❌ 漏发现: %s' % ', '.join(sorted(missing)))
        failures.append('%s: missing %d' % (label, len(missing)))
    else:
        print('  ✅ 全部 %d 个期望变量均已发现' % len(EXPECT))

    wrong = []
    for name, (ekind, edims, etotal) in EXPECT.items():
        if name not in got:
            continue
        gkind, gtotal, gdim = got[name]
        edim = len(edims)
        if gkind != ekind or gtotal != etotal or gdim != edim:
            wrong.append('%s: 期望(%s,%d,%dd) 实际(%s,%d,%dd)'
                         % (name, ekind, etotal, edim, gkind, gtotal, gdim))
    if wrong:
        print('  ❌ 类型/维度错误:')
        for w in wrong:
            print('       %s' % w)
        failures.append('%s: %d type mismatches' % (label, len(wrong)))
    else:
        print('  ✅ 类型、维度、元素数全部正确')

    # --- 陷阱 P-3：函数内 static 必须被排除 ---
    local = [n for n in got if n.startswith('fixture_local_static')]
    if local:
        print('  ❌ 未排除函数内 static 局部变量: %s' % local)
        failures.append('%s: local static leaked' % label)
    else:
        print('  ✅ 函数内 static 局部变量已正确排除（陷阱 P-3）')

    # --- 生成的 C 必须可编译 ---
    inc = os.path.join(ROOT, 'core', 'include')
    r = run([cc, '-std=c11', '-g', '-O0', '-Wall', '-Wextra',
             '-I', os.path.dirname(src), '-I', inc,
             '-c', out_c, '-o', os.path.join(tmp, 'wrapped.o')])
    if r.returncode != 0:
        print('  ❌ 生成的包装单元编译失败:\n%s' % r.stderr[:600])
        failures.append('%s: generated C does not compile' % label)
    else:
        w = [l for l in (r.stderr or '').splitlines() if 'warning' in l.lower()]
        print('  ✅ 生成的包装单元编译通过%s'
              % ('（%d 条警告）' % len(w) if w else '，零警告'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cc', default='gcc')
    ap.add_argument('--also', default='', help='第二个编译器（交叉验证）')
    ap.add_argument('--objdump', default='objdump')
    args = ap.parse_args()

    for tool in (args.cc, args.objdump, 'objdump'):
        if shutil.which(tool) is None and not os.path.isfile(tool):
            print('❌ 找不到工具: %s' % tool)
            return 2

    failures = []
    tmp = tempfile.mkdtemp(prefix='scut_test_')
    try:
        check(args.cc, args.objdump, tmp, 'primary', failures)
        if args.also:
            check(args.also, args.objdump, tmp, 'cross', failures)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print('\n' + '=' * 62)
    if failures:
        print('❌ 失败 %d 项:' % len(failures))
        for f in failures:
            print('   - %s' % f)
        return 1
    print('✅ 全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
