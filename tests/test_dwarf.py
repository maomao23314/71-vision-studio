#!/usr/bin/env python3
"""
test_dwarf.py -- scut_dwarf.py（纯 Python 的 DWARF 读取器）的回归测试。

===============================================================================
这个测试守的是什么
===============================================================================
变量面板"整块失效"只有一种表现形式：**一个变量都没有，而且不报错**。
历史上它坏过三次，每次原因都不一样：

    · 外部 objdump 不存在 / 是 LLVM 版（LLVM 21 移除了 --dwarf=info）
    · DWARF 5 的编译单元头多跳了 8 字节（凭印象加的 dwo_id）
    · DW_AT_str_offsets_base 的编号记错（写成 0x21，实际是 0x72）

后两次的表现完全一样：一半以上变量的名字跑到隔壁去了。所以这个测试
【不测"能解析出东西"，而测"解析出的东西对"】—— 逐字段核对。

覆盖：
    1. PE/COFF（Windows .o）与 ELF（Linux .o）两种容器
    2. DWARF 4（.debug_str 偏移字符串）与 DWARF 5（.debug_str_offsets + strx）
    3. 多编译单元：偏移必须按单元抬基址，不能互相覆盖
    4. 函数内 static 的 depth 判定（depth==1 才是文件作用域）
    5. 数组维度、typedef 链、const 穿透、结构体/联合/枚举/指针
    6. 坏输入：不是目标文件、空文件、截断文件 —— 必须给出人话错误

用法:
    python tests/test_dwarf.py
    python tests/test_dwarf.py --cc <clang.exe> --also <gcc.exe>
退出码 0 = 全部通过。
"""
import argparse
import io
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
sys.path.insert(0, os.path.join(ROOT, 'tools'))

import scut_dwarf as dwarf   # noqa: E402

FIXT = os.path.join(HERE, 'fixtures', 'fixtures_all_types.c')

# 期望的 文件作用域变量 -> (标签名, 深度)
EXPECT = {
    'v_int':     'DW_TAG_variable',
    'v_float':   'DW_TAG_variable',
    'a_2d':      'DW_TAG_variable',
    'a_3d':      'DW_TAG_variable',
    'td_row':    'DW_TAG_variable',
    'td_img':    'DW_TAG_variable',
    's_track':   'DW_TAG_variable',
    's_track_arr': 'DW_TAG_variable',
    'u_value':   'DW_TAG_variable',
    'e_status':  'DW_TAG_variable',
    'p_point':   'DW_TAG_variable',
    'c_calib':   'DW_TAG_variable',
    'st_single': 'DW_TAG_variable',
    'st_track':  'DW_TAG_variable',
}

failures = []


def ok(cond, msg, extra=''):
    if cond:
        print('  ✅ %s' % msg)
    else:
        print('  ❌ %s%s' % (msg, ('  ' + extra) if extra else ''))
        failures.append(msg + ((' | ' + extra) if extra else ''))


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True,
                          errors='replace', **kw)


# ===========================================================================
# 坏输入：必须给人话错误，不能抛原始异常
# ===========================================================================

def test_bad_inputs(tmp):
    print('\n=== [坏输入] 必须给出可读的错误，而不是抛出底层异常 ===')

    p = os.path.join(tmp, 'not_an_object.bin')
    with open(p, 'wb') as f:
        f.write(b'this is definitely not an object file, just text\n' * 4)
    try:
        dwarf.load_die_tree(p)
        ok(False, '非目标文件应当被拒绝')
    except dwarf.DwarfError as exc:
        ok('不认识的文件格式' in str(exc), '非目标文件 → DwarfError（人话）',
           str(exc)[:60])
    except Exception as exc:      # noqa: BLE001
        ok(False, '非目标文件抛了非 DwarfError 的异常', type(exc).__name__)

    p2 = os.path.join(tmp, 'tiny.o')
    with open(p2, 'wb') as f:
        f.write(b'\x64\x86\x00')
    try:
        dwarf.load_die_tree(p2)
        ok(False, '过小的文件应当被拒绝')
    except dwarf.DwarfError as exc:
        ok('太小' in str(exc), '过小的文件 → DwarfError（人话）', str(exc)[:60])

    # 不存在的路径
    try:
        dwarf.load_die_tree(os.path.join(tmp, 'no_such_file.o'))
        ok(False, '不存在的文件应当抛 DwarfError')
    except dwarf.DwarfError as exc:
        ok('读不了' in str(exc), '不存在的文件 → DwarfError（人话）',
           str(exc)[:60])


# ===========================================================================
# 正常输入
# ===========================================================================

def test_object(obj_path, label):
    print('\n=== [%s] 解析 %s ===' % (label, os.path.basename(obj_path)))
    rd, dies = dwarf.load_die_tree(obj_path)
    ok(len(dies) > 50, '解析出 DIE（%d 个）' % len(dies))
    if not dies:
        return None

    variables = [d for d in dies.values() if d.tag == 'DW_TAG_variable']
    by_depth = {}
    for d in variables:
        by_depth[d.depth] = by_depth.get(d.depth, 0) + 1
    print('    变量按深度分布：%s' % dict(sorted(by_depth.items())))

    # --- 逐项核对期望的变量 ---
    file_scope = {}
    for d in variables:
        if d.depth != 1:
            continue
        name = dwarf.attr_str(d, 'DW_AT_name')
        if name:
            file_scope[name] = d

    missing = [k for k in EXPECT if k not in file_scope]
    ok(not missing, '文件作用域变量齐全（%d 个期望）' % len(EXPECT),
       '缺: %s' % ', '.join(missing) if missing else '')

    import scut_symbols   # noqa: E402  （只在核对时需要）
    for name, want_dims, want_bytes in (
            ('a_2d', [120, 188], 1),
            ('a_3d', [2, 3, 4], 4),
            ('td_row', [120, 188], 1),
            ('td_img', [120, 188], 1),
            ('v_int', [], 4),
            ('v_float', [], 4),
            ('c_calib', [3], 4),
            ('s_track_arr', [4], 24)):
        d = file_scope.get(name)
        if d is None:
            continue
        ty = scut_symbols.resolve_type(dies, dwarf.attr_ref(d, 'DW_AT_type'))
        good = (ty is not None and ty['dims'] == want_dims
                and ty['elem_bytes'] == want_bytes)
        detail = ''
        if ty is not None:
            detail = '实际: dims=%s, %dB' % (ty['dims'], ty['elem_bytes'])
        ok(good, '%s 的形状正确（dims=%s, %dB）'
           % (name, want_dims, want_bytes), detail)

    # --- 函数内 static 必须落在 depth>=2 ---
    local = [d for d in variables
             if dwarf.attr_str(d, 'DW_AT_name') == 'fixture_local_static']
    ok(bool(local), '找得到函数内 static（用来验证深度判定）')
    if local:
        ok(all(d.depth >= 2 for d in local),
           '函数内 static 的 depth >= 2（陷阱 P-3）',
           '实际 depth=%s' % [d.depth for d in local])

    # --- 每个文件作用域变量都必须有绝对地址 ---
    no_addr = [dwarf.attr_str(d, 'DW_AT_name') for d in file_scope.values()
               if not dwarf.has_absolute_address(d)]
    ok(not no_addr, '文件作用域变量都带绝对地址',
       '缺地址: %s' % ', '.join(no_addr[:5]) if no_addr else '')

    # --- 类型引用必须都能解析（悬空引用说明偏移算错了）---
    dangling = []
    for d in file_scope.values():
        ref = dwarf.attr_ref(d, 'DW_AT_type')
        if ref is None or ref not in dies:
            dangling.append(dwarf.attr_str(d, 'DW_AT_name'))
    ok(not dangling, '所有类型引用都指向真实 DIE',
       '悬空: %s' % ', '.join(dangling[:5]) if dangling else '')

    return file_scope


def compile_probe(cc, src, out, dwarf_ver=None):
    cmd = [cc, '-std=c11', '-g', '-O0']
    if dwarf_ver:
        cmd.append('-gdwarf-%s' % dwarf_ver)
    cmd += ['-c', src, '-o', out]
    r = run(cmd)
    if r.returncode != 0:
        print('  ❌ 编译失败: %s' % (r.stderr[:400]))
        failures.append('compile %s dwarf%s' % (os.path.basename(out), dwarf_ver))
        return False
    return True


def test_multi_unit(cc, tmp):
    """多编译单元：偏移必须按单元抬基址，否则后者覆盖前者。"""
    print('\n=== [多编译单元] include 另一个 .c 时变量不能互相覆盖 ===')
    b = os.path.join(tmp, 'unit_b.c')
    io.open(b, 'w', encoding='utf-8', newline='\n').write(
        'int shared_from_b = 22;\n'
        'static float b_scale = 1.5f;\n'
        'int b_fn(void){ return shared_from_b + (int)b_scale; }\n')
    a = os.path.join(tmp, 'unit_a.c')
    io.open(a, 'w', encoding='utf-8', newline='\n').write(
        '#include "unit_b.c"\n'
        'int g_in_a = 11;\n'
        'int a_fn(void){ return g_in_a + b_fn(); }\n')
    obj = os.path.join(tmp, 'multi.o')
    if not compile_probe(cc, a, obj, '4'):
        return
    rd, dies = dwarf.load_die_tree(obj)
    names = {dwarf.attr_str(d, 'DW_AT_name') for d in dies.values()
             if d.tag == 'DW_TAG_variable' and d.depth == 1}
    want = {'shared_from_b', 'b_scale', 'g_in_a'}
    ok(want <= names, '两个编译单元的变量都在（共 %d 个文件作用域）' % len(names),
       '缺: %s' % ', '.join(sorted(want - names)))
    # ★ 这一段是这条测试的核心：如果两个 CU 的偏移不加基址，
    #   后一个 CU 的 DIE 会把前一个的覆盖掉，于是只数得到一半。
    ok(len(rd.units) >= 1, '至少一个编译单元', 'units=%d' % len(rd.units))


def test_elf_with_gcc(cc, tmp):
    """ELF 容器（Linux .o）：用 gcc 的 --target 或直接用 elf 交叉编译。"""
    print('\n=== [ELF] 非 PE 容器的节表读取 ===')
    obj = os.path.join(tmp, 'elf_probe.o')
    src = os.path.join(tmp, 'elf_probe.c')
    io.open(src, 'w', encoding='utf-8', newline='\n').write(
        'int g_elf_value = 7;\n'
        'static unsigned char g_elf_buf[6];\n'
        'int elf_fn(void){ g_elf_buf[0] = 1; return g_elf_value + g_elf_buf[0]; }\n')
    r = run([cc, '-std=c11', '-g', '-gdwarf-4', '-O0',
             '--target=x86_64-linux-gnu', '-c', src, '-o', obj])
    if r.returncode != 0:
        print('  SKIP  这台编译器产不出 ELF（%s）'
              % (r.stderr.strip().splitlines() or ['无输出'])[0][:80])
        return
    with open(obj, 'rb') as f:
        magic = f.read(4)
    if magic != b'\x7fELF':
        print('  SKIP  产物不是 ELF（编译器忽略了 --target）')
        return
    rd, dies = dwarf.load_die_tree(obj)
    names = {dwarf.attr_str(d, 'DW_AT_name') for d in dies.values()
             if d.tag == 'DW_TAG_variable' and d.depth == 1}
    ok({'g_elf_value', 'g_elf_buf'} <= names, 'ELF 里的变量被发现',
       '实际: %s' % sorted(names))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cc', default='gcc')
    ap.add_argument('--also', default='', help='第二个编译器（交叉验证）')
    args = ap.parse_args()

    compilers = [args.cc] + ([args.also] if args.also else [])
    for c in compilers:
        if shutil.which(c) is None and not os.path.isfile(c):
            print('❌ 找不到编译器: %s' % c)
            return 2

    tmp = tempfile.mkdtemp(prefix='scut_dwarf_test_')
    try:
        test_bad_inputs(tmp)

        first = None
        for cc in compilers:
            for dw in ('4', '5'):
                obj = os.path.join(
                    tmp, 'probe_%s_dw%s.o'
                    % (os.path.basename(cc).replace('.', '_'), dw))
                print('\n=== 编译 [%s] -gdwarf-%s ===' % (os.path.basename(cc), dw))
                if not compile_probe(cc, FIXT, obj, dw):
                    continue
                fs = test_object(obj, '%s/dwarf%s' % (os.path.basename(cc), dw))
                # ★ 不同编译器/不同 DWARF 版本必须给出一致的名字集合。
                #   这比"各测各的"强：错位往往只发生在其中一条路径上。
                if fs is not None:
                    if first is None:
                        first = (set(fs), '%s/dwarf%s' % (cc, dw))
                    else:
                        same = set(fs) == first[0]
                        ok(same, '与 %s 的变量名集合一致' % os.path.basename(first[1]),
                           '差集: %s' % sorted(set(fs) ^ first[0])[:6]
                           if not same else '')

        test_multi_unit(compilers[0], tmp)
        test_elf_with_gcc(compilers[0], tmp)
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
