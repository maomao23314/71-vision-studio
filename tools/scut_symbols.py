#!/usr/bin/env python3
"""
scut_symbols.py -- 从 DWARF 自动发现用户代码的全局变量，生成 Watch 注册包装单元。

================================================================================
为什么用「包装单元（wrapper TU）」而不是「独立绑定单元」：
================================================================================
用户代码里存在 static 全局变量（internal linkage）。独立的绑定编译单元
【无法引用】它们（链接期报 undefined reference）。

包装单元的做法是：
        user.wrapped.c:
            #include "user.c"      # 先展开用户源码 -> 声明全部可见
            #include "scut_watch.h" # 再注册 -> &name 合法，static 也可见
编译时【编译包装单元而非原文件】。

实测三种方案：
  · 独立绑定 TU       -> static 变量链接失败            ❌
  · -include 前置注入  -> 声明尚未出现，编译失败         ❌
  · 包装单元           -> 全部变量（含 static）注册成功  ✅

================================================================================
流水线（两遍编译用户 TU；用户代码很小，代价可忽略）：
================================================================================
    1) gcc -g -O0 -c user.c -o user.o                      # 探针编译，产出 DWARF
    2) python scut_symbols.py --obj user.o --src user.c \
              --out-c user.wrapped.c --out-json user.vars.json
    3) gcc -g -O0 -c user.wrapped.c -o user.o              # 真正的目标文件
    4) 链接
"""
import argparse
import json
import re
import subprocess
import sys
from collections import OrderedDict

# ---- DWARF 基础类型 -> SCUT 渲染类型 ----------------------------------------
BASE_TYPES = {
    'char':                   ('SCUT_T_I8',   1),
    'signed char':            ('SCUT_T_I8',   1),
    'unsigned char':          ('SCUT_T_U8',   1),
    'short int':              ('SCUT_T_I16',  2),
    'short unsigned int':     ('SCUT_T_U16',  2),
    'int':                    ('SCUT_T_I32',  4),
    'unsigned int':           ('SCUT_T_U32',  4),
    'long int':               ('SCUT_T_I32',  4),
    'long unsigned int':      ('SCUT_T_U32',  4),
    'long long int':          ('SCUT_T_I64',  8),
    'long long unsigned int': ('SCUT_T_U64',  8),
    'float':                  ('SCUT_T_F32',  4),
    'double':                 ('SCUT_T_F64',  8),
    'long double':            ('SCUT_T_F64',  8),
    '_Bool':                  ('SCUT_T_BOOL', 1),
}

# ---------------------------------------------------------------------------
# DIE 行匹配
#
# 目标格式（objdump --dwarf=info）：
#      <depth><offset>: Abbrev Number: N (DW_TAG_xxx)
#   例： ` <1><2a>: Abbrev Number: 2 (DW_TAG_variable)`
#
# ★ 三个必须容忍的差异（任何一个不兼容都会导致【一个 DIE 都匹配不上】，
#   表现为「构建成功、变量面板永远为空」——最严重的一类静默失败）：
#
#   1) 偏移的补零写法。binutils 习惯渲染成 `<2a>`，但某些版本/某些产物
#      会渲染成 `<0000002a>`。都用 [0-9a-f]+ 就能同时吃下。
#   2) 行首空格数。binutils 是 1 个空格 + `<depth>`；不同版本/不同平台
#      可能是 2 个。用 \s* 而不是写死 `^ `。
#   3) Abbrev Number 与括号之间的空白。宽松处理。
#
#   之前的版本写死了 `^ <...` 和不定长十六进制，只要 objdump 换一种渲染
#   就整条链路失效 —— 而失败是静默的（0 个变量，返回码仍为 0）。
#   所以这里刻意放宽，把「格式差异」这类环境噪音从失败原因里彻底排除。
#   ★ 必须带 re.MULTILINE：
#     同一个正则有两种用法 —— parse_dwarf() 逐行 match()，以及
#     main() 里对整个输出 search() 做"有没有解析到任何 DIE"的自检。
#     没有 MULTILINE 时 `^` 只匹配字符串开头，于是 search() 永远为假，
#     自检会把【正常】的输出误判成失败。这个 bug 被回归测试当场抓住。
DIE_RE = re.compile(
    r'^\s*<(\d+)><([0-9a-fA-F]+)>:\s*Abbrev Number:\s*\d+\s*\((DW_TAG_\w+)\)',
    re.MULTILINE)
# 属性行同理：`    <2a>   DW_AT_name   : ...`，偏移可能补零。
ATTR_RE = re.compile(r'^\s*<[0-9a-fA-F]+>\s+(DW_AT_\w+)\s*:\s*(.*)$',
                     re.MULTILINE)

# objdump 每行 DIE 的第一个 <> 数字就是【树深度】：
#     <0> = DW_TAG_compile_unit
#     <1> = 文件作用域声明（全局变量、函数）
#     <2> = 函数内局部变量 / 结构体成员
# ★ 必须只取 depth == 1 的变量，否则会把【函数内的 static 局部变量】
#   也当成全局变量 —— 它在 DWARF 里有绝对地址，看起来完全合法，
#   但在文件作用域并不可见，生成的包装单元会编译失败：
#       error: 'c' undeclared (first use in this function)
FILE_SCOPE_DEPTH = 1

# objdump 对较长的字符串用间接引用，形如：
#     DW_AT_name : (indirect string, offset: 0xa4): int
# ★ 必须剥掉这个前缀，否则 'int' 会被当成未知类型名而退化为「按字节数猜」，
#   表现为 gcc 下是 I32、clang 下变成 U32 —— 符号性悄悄丢失，且完全静默。
INDIRECT_RE = re.compile(r'^\(indirect string, offset: 0x[0-9a-f]+\):\s*')


def clean_name(s):
    """剥掉 objdump 的 (indirect string, offset: ...) 前缀与首尾空白。"""
    return INDIRECT_RE.sub('', (s or '').strip()).strip()


class Die:
    __slots__ = ('off', 'tag', 'attrs', 'depth')

    def __init__(self, off, tag, depth=0):
        self.off, self.tag, self.attrs, self.depth = off, tag, {}, depth

    def __repr__(self):
        return '<Die d%d %s %s>' % (self.depth, self.off, self.tag)


def parse_dwarf(text):
    """解析 objdump --dwarf=info 的文本输出为 {offset: Die}。"""
    dies = OrderedDict()
    cur = None
    for raw in text.splitlines():
        m = DIE_RE.match(raw)
        if m:
            cur = Die(m.group(2), m.group(3), int(m.group(1)))
            dies[cur.off] = cur
            continue
        if cur is None:
            continue
        a = ATTR_RE.match(raw)
        if a:
            key, val = a.group(1), a.group(2).strip()
            if key == 'DW_AT_name':
                val = clean_name(val)
            cur.attrs.setdefault(key, val)
    return dies


def off_of(ref):
    m = re.search(r'<0x([0-9a-f]+)>', ref or '')
    return m.group(1) if m else None


def _collect_dims(dies, arr_die, base):
    """
    收集数组维度。

    objdump 的文本输出不显式给出父子关系，但 DW_TAG_subrange_type
    总是【紧跟】在其 array_type 之后、且缩进更深。据此按顺序收集。
    """
    keys = list(dies.keys())
    try:
        i = keys.index(arr_die.off) + 1
    except ValueError:
        return base
    dims = []
    while i < len(keys):
        d = dies[keys[i]]
        if d.tag != 'DW_TAG_subrange_type':
            break
        ub, cnt = d.attrs.get('DW_AT_upper_bound'), d.attrs.get('DW_AT_count')
        if ub is not None:
            dims.append(int(ub) + 1)
        elif cnt is not None:
            dims.append(int(cnt))
        i += 1
    out = dict(base)
    if dims:
        out['dims'] = dims
        total = 1
        for n in dims:
            total *= n
        out['total'] = total
    return out


def resolve_type(dies, ref, depth=0):
    """
    递归解析类型引用，返回:
        kind       SCUT_T_xxx
        elem_bytes 元素字节数
        dims       [d0, d1, ...]  从外到内
        total      总元素数
        is_struct  是否结构体/联合/类
        ptr        是否指针
    """
    if depth > 24:
        return None
    off = off_of(ref)
    if not off or off not in dies:
        return None
    die = dies[off]

    if die.tag == 'DW_TAG_typedef':
        return resolve_type(dies, die.attrs.get('DW_AT_type'), depth + 1)

    if die.tag == 'DW_TAG_pointer_type':
        return dict(kind='SCUT_T_PTR', elem_bytes=8, dims=[], total=1,
                    is_struct=False, ptr=True)

    if die.tag == 'DW_TAG_base_type':
        name = clean_name(die.attrs.get('DW_AT_name'))
        size = int(die.attrs.get('DW_AT_byte_size', '0') or 0)
        if name in BASE_TYPES:
            k, b = BASE_TYPES[name]
            return dict(kind=k, elem_bytes=b, dims=[], total=1,
                        is_struct=False, ptr=False)
        # 未知基础类型：优先用 encoding 判断符号性，再按字节数猜，
        # 避免把 signed 误判成 unsigned。
        enc = (die.attrs.get('DW_AT_encoding') or '').lower()
        unsigned = 'unsigned' in enc
        guess = {
            (1, False): 'SCUT_T_I8',  (1, True): 'SCUT_T_U8',
            (2, False): 'SCUT_T_I16', (2, True): 'SCUT_T_U16',
            (4, False): 'SCUT_T_I32', (4, True): 'SCUT_T_U32',
            (8, False): 'SCUT_T_I64', (8, True): 'SCUT_T_U64',
        }
        return dict(kind=guess.get((size, unsigned), 'SCUT_T_U8'),
                    elem_bytes=size or 1, dims=[], total=1,
                    is_struct=False, ptr=False)

    if die.tag == 'DW_TAG_enumeration_type':
        size = int(die.attrs.get('DW_AT_byte_size', '0') or 4)
        return dict(kind='SCUT_T_ENUM', elem_bytes=size, dims=[], total=1,
                    is_struct=False, ptr=False)

    # ★ 类型限定符必须【透明穿透】。
    #   `const int x` 的类型引用指向 DW_TAG_const_type，它自身没有
    #   DW_AT_name / DW_AT_byte_size，只有 DW_AT_type 指向真实类型。
    #   早期版本未处理这几个 tag，导致所有 const 变量被静默丢弃
    #   （表现为「面板里看不到 const 数组」），且不报任何错。
    #   const / volatile / restrict / _Atomic 在语义上都只是限定符，
    #   对「如何把内存渲染成数值」毫无影响，因此直接穿透。
    if die.tag in ('DW_TAG_const_type', 'DW_TAG_volatile_type',
                   'DW_TAG_restrict_type', 'DW_TAG_atomic_type'):
        return resolve_type(dies, die.attrs.get('DW_AT_type'), depth + 1)

    if die.tag in ('DW_TAG_structure_type', 'DW_TAG_union_type',
                   'DW_TAG_class_type'):
        size = int(die.attrs.get('DW_AT_byte_size', '0') or 0)
        return dict(kind='SCUT_T_STRUCT', elem_bytes=size or 1, dims=[],
                    total=1, is_struct=True, ptr=False)

    if die.tag == 'DW_TAG_array_type':
        base = resolve_type(dies, die.attrs.get('DW_AT_type'), depth + 1)
        if base is None:
            return None
        return _collect_dims(dies, die, base)

    return None


def collect_variables(dies):
    """提取所有【文件作用域】的全局/静态变量。"""
    out = []
    for die in dies.values():
        if die.tag != 'DW_TAG_variable':
            continue
        # 只取文件作用域（depth==1）。depth>=2 的是函数内 static 局部变量：
        # 它们在 DWARF 里同样有绝对地址，但生成的包装单元引用不到它们。
        if die.depth != FILE_SCOPE_DEPTH:
            continue
        name = clean_name(die.attrs.get('DW_AT_name'))
        if not name or not re.match(r'^[A-Za-z_]\w*$', name):
            continue
        # 必须有 DW_AT_location 且是绝对地址 —— 这样才是实例化对象，
        # 而不是仅有声明的 extern 引用（那些注册了也没有意义）。
        loc = die.attrs.get('DW_AT_location')
        if not loc or ('DW_OP_addr' not in loc and 'DW_OP_addrx' not in loc):
            continue
        ty = resolve_type(dies, die.attrs.get('DW_AT_type'))
        if ty is None:
            continue
        out.append(dict(
            name=name, kind=ty['kind'], dims=ty['dims'], total=ty['total'],
            elem_bytes=ty['elem_bytes'], is_struct=ty['is_struct'],
            ptr=ty['ptr'], external=die.attrs.get('DW_AT_external') == '1',
            decl_line=die.attrs.get('DW_AT_decl_line'),
        ))
    return out


HEADER = '''/* ==========================================================================
 *  {fname}
 *  --------------------------------------------------------------------------
 *  AUTO-GENERATED by tools/scut_symbols.py -- DO NOT EDIT BY HAND.
 *
 *  本文件是【包装编译单元】：先展开用户源码，再把其中的全局变量
 *  登记到仿真环境的 Watch 注册表。
 *
 *  用户【不需要写任何代码】，即可在 IDE 的变量面板里看到并绘制这些变量。
 *
 *  源文件  : {src}
 *  变量数量: {count}
 *
 *  ★ 为什么必须这样包装（而不是独立绑定单元）：
 *      用户代码里有 static 全局变量（internal linkage），
 *      独立的编译单元无法引用它们。先 #include 用户源码，
 *      可让所有声明（含 static）在本文件内可见。
 *
 *  ★ 为什么注册函数必须是 constructor：
 *      实测若写成普通函数，链接器不报错，但主程序不会调用它，
 *      表现为「变量面板永远是空的」这一静默失败。
 * ========================================================================== */
#include "{src}"
#include "scut_watch.h"

__attribute__((constructor))
static void scut_autoreg(void)
{{
{regs}
}}
'''

MANIFEST_NOTE = ('AUTO-GENERATED -- UI 变量面板的元数据来源。'
                 '用户可在 IDE 面板里勾选要绘制/输出 LOG 的变量。')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--obj', required=True, help='探针目标文件 (.o)')
    ap.add_argument('--src', required=True, help='原始源文件名（用于 #include）')
    ap.add_argument('--out-c', required=True, help='输出的包装 .c 文件')
    ap.add_argument('--out-json', help='输出的变量清单 JSON')
    ap.add_argument('--objdump', default='objdump')
    ap.add_argument('--exclude', default='', help='逗号分隔的黑名单')
    ap.add_argument('--max-elems', type=int, default=0,
                    help='元素数超过该值的变量不注册 (0=不限)')
    args = ap.parse_args()

    r = subprocess.run([args.objdump, '--dwarf=info', args.obj],
                       capture_output=True, text=True, errors='replace')
    if r.returncode != 0:
        print('[scut_symbols] objdump 失败: %s' % r.stderr[:300], file=sys.stderr)
        return 2

    # -----------------------------------------------------------------------
    # ★ 静默失败检测：命令成功、但一个 DIE 都没解析出来
    #
    # 这是本项目最危险的一类失败：构建整体成功，用户以为一切正常，
    # 只是变量面板永远空的。已知两种成因：
    #
    #   1) DWARF 版本不被 objdump 支持（实测：clang/llvm-mingw 显式加
    #      -gdwarf-5 时，binutils 2.30/2.37 的 objdump 输出里
    #      DW_TAG_variable 条目一个都没有，退出码仍是 0）
    #   2) objdump 的渲染格式与解析正则不符（偏移补零、缩进差异等）
    #
    # 两种情况都无法从返回码区分，所以这里主动检查并【明确报错】。
    # 注意：完全不报错也可以"工作"（生成一个没有变量的文件），
    # 但那正是我们要消灭的失败模式，所以宁可吵闹。
    # -----------------------------------------------------------------------
    if not DIE_RE.search(r.stdout):
        has_debug = '.debug_info' in r.stdout or 'DW_TAG_' in r.stdout
        hint = (
            "objdump 没有输出任何可解析的 DWARF DIE。\n"
            "  可能原因一：调试信息版本不被 objdump 支持。\n"
            "    实测 clang 显式使用 -gdwarf-5 时，binutils 的 objdump\n"
            "    会输出空章节且退出码为 0。\n"
            "    解决办法：去掉 -gdwarf-5（clang 21 默认就是 DWARF 4），\n"
            "    或换用支持 DWARF 5 的 binutils。\n"
            "  可能原因二：objdump 的输出格式与解析器不匹配。\n"
            "    请运行 `doctor` 做功能探测。\n"
            "  已确认：该目标文件%s调试信息。"
            % ("包含" if has_debug else "不包含"))
        print('[scut_symbols] %s' % hint, file=sys.stderr)
        return 3

    variables = collect_variables(parse_dwarf(r.stdout))

    black = {s.strip() for s in args.exclude.split(',') if s.strip()}
    variables = [v for v in variables
                 if v['name'] not in black and not v['name'].startswith('_')]
    if args.max_elems > 0:
        variables = [v for v in variables if v['total'] <= args.max_elems]
    variables.sort(key=lambda v: v['name'])      # 稳定可复现

    regs = []
    for v in variables:
        dim = len(v['dims']) if v['dims'] else 0
        regs.append('    SCUT_Watch("%s", (const void*)&%s, '
                    '%s, %d, %d, %d);'
                    % (v['name'], v['name'], v['kind'],
                       v['total'], v['elem_bytes'], dim))

    fname = args.out_c.replace('\\', '/').split('/')[-1]
    with open(args.out_c, 'w', encoding='utf-8-sig', newline='\r\n') as f:
        f.write(HEADER.format(fname=fname, src=args.src, count=len(variables),
                              regs='\n'.join(regs) or '    /* (无全局变量) */'))

    if args.out_json:
        manifest = {
            'note': MANIFEST_NOTE,
            'source': args.src,
            'count': len(variables),
            'variables': [
                {
                    'name': v['name'],
                    'kind': v['kind'],
                    'dims': v['dims'],
                    'total': v['total'],
                    'elemBytes': v['elem_bytes'],
                    'isStruct': v['is_struct'],
                    'isPtr': v['ptr'],
                    'isStatic': not v['external'],
                    'declLine': v['decl_line'],
                    # 默认勾选策略：标量与小数组默认看，巨大缓冲默认不看，
                    # 避免一上来就把 22560 字节的图像缓冲塞进 UI。
                    'defaultSelected': v['total'] <= 512,
                }
                for v in variables
            ],
        }
        with open(args.out_json, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

    print('[scut_symbols] %s: 发现 %d 个全局变量 -> %s'
          % (args.src, len(variables), args.out_c))
    for v in variables:
        d = 'x'.join(str(n) for n in v['dims']) or 'scalar'
        tag = 'static' if not v['external'] else 'global'
        print('    %-22s %-12s %-14s elems=%-7d %dB  %s'
              % (v['name'], v['kind'], d, v['total'], v['elem_bytes'], tag))
    return 0


if __name__ == '__main__':
    sys.exit(main())
