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

# 图像尺寸的【展示用】副本，由 --image-size 传入（格式 "188x120"）。
#
# ★ 为什么让构建脚本传进来、而不在这里重新解析 config.h：
#   尺寸的真值来源是 scut_project.json，而构建脚本已经读过它了。
#   在这里再解析一遍等于把"同一件事有多个权威"引入进来 ——
#   将来改了配置格式就会有一处漏改，而漏改的表现是错误提示里的数字不对，
#   比不显示数字更误导人。
#   它只用于错误信息，不参与任何生成逻辑，所以缺省值是安全的。
IMAGE_SHAPE = "由工程配置决定的整幅图像尺寸"

# objdump 对较长的字符串用间接引用，形如：
#     DW_AT_name : (indirect string, offset: 0xa4): int
# ★ 必须剥掉这个前缀，否则 'int' 会被当成未知类型名而退化为「按字节数猜」，
#   表现为 gcc 下是 I32、clang 下变成 U32 —— 符号性悄悄丢失，且完全静默。
INDIRECT_RE = re.compile(r'^\(indirect string, offset: 0x[0-9a-f]+\):\s*')


def clean_name(s):
    """剥掉 objdump 的 (indirect string, offset: ...) 前缀与首尾空白。"""
    return INDIRECT_RE.sub('', (s or '').strip()).strip()


class CopyShapeError(Exception):
    """结果图数组的形状不对（不是数组）。

    ★ 单独开一个异常类型（而不是复用通用 Exception）是为了让
      scut_build.py 能把它和"生成器内部出错"区分开：
      前者是【用户配置问题】，要给可执行的下一步；
      后者是脚本 bug，要给调用栈。两类问题的措辞完全不同。"""


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
 *  登记到仿真环境的变量观察表。
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
#include "scut_sdk.h"
#include "{src}"

__attribute__((constructor))
static void scut_autoreg(void)
{{
{regs}
}}
{copy_fn}'''

MANIFEST_NOTE = ('AUTO-GENERATED -- UI 变量面板的元数据来源。'
                 '用户可在 IDE 面板里勾选要绘制/输出 LOG 的变量。')


def _copy_fn_text(out_array, variables):
    """生成「把结果图搬进环境输出图」的函数。

    ★ 为什么生成在【包装单元】里（而不是统一的环境接线单元）：
      结果图数组的类型与作用域只有展开用户源码之后才知道 ——
      它可能是 static。放在包装单元里，这点不是问题。

    ★★ 为什么一定要在这里做「形状检查」★★

      SCUT_EnvCopyOutput(ptr, 0, 0) 的约定是"用环境的宽高"，
      于是环境会按 H 行 × W 列去 memcpy。

      如果用户填的是一个【标量】（例如 int g_threshold），
      那么 `(const unsigned char *)g_threshold` 仍然是合法 C ——
      编译通过、链接通过、运行不崩，只是每帧从那 4 字节的变量后面
      越界读走约 22 KB，然后显示一张垃圾图。

      这类错误【没有任何报错】，所以必须在生成期用 DWARF 里的维度信息
      拦下来。代价是"DWARF 解析失败时无法生成搬运函数"，
      但那条路径本来就已经降级为"不要变量清单"了，
      而且此时生成的错误信息比越界读好得多。

    ★ 尺寸传 0（=用环境尺寸）而不是写死维度：
      结果图与输入图同尺寸是最常见的情况，交给环境统一处理更稳。
      形状检查【单独做】，不靠传参兜底 —— 这样一维数组也不会被
      当成 W×H 去越界读。
    """
    if not out_array:
        return ""

    # 找到这个数组在本文件里的声明
    v = None
    for cand in variables:
        if cand['name'] == out_array:
            v = cand
            break

    if v is None:
        # 不在本文件里：要么是别的 TU 声明它（那由那个 TU 生成），
        # 要么用户填错了名字（构建脚本最后会给出明确报错）。
        return ("\n/* `%s` 不在本文件里声明 —— 搬运函数由声明它的那个\n"
                " * 编译单元生成（全局只能有一份定义）。 */\n" % out_array)

    dims = v['dims']
    if len(dims) < 1:
        raise CopyShapeError(
            "「结果图数组名」指向的不是数组，而是一个标量：%s\n"
            "    为什么必须拦住：环境要按【整幅图像】（%s）去读它，\n"
            "    但这个变量只有 %d 个字节 —— 于是每帧都会越界读走一大片内存，\n"
            "    得到一个垃圾画面，而且【不报错、不崩溃】，极难查到根因。\n"
            "    下一步（任选其一）：\n"
            "      1) 把它改成你代码里真正存放结果图的数组"
            "（例如 unsigned char g_binary[SCUT_IMAGE_H][SCUT_IMAGE_W]）；\n"
            "      2) 或者把这个设置留空 —— 画面将显示输入图本身。"
            % (out_array, IMAGE_SHAPE, v['elem_bytes']))

    # 元素个数：总元素数 / 元素字节数 = 元素个数
    if len(dims) == 1:
        # 一维数组：当作"一行"处理（高度 1）。不能当成 W×H 读，
        # 那会越界；也不能拒绝，因为一维结果图是合理用法。
        src = "&%s[0]" % out_array
        w, h = dims[0], 1
    else:
        # 二维及更高：取【最后两维】当宽高，与 C 的 [行][列] 一致。
        src = "&%s[0][0]" % out_array
        w, h = dims[-1], dims[-2]

    return (
        "\n/* ------------------------------------------------------------------\n"
        " *  把结果图搬进环境输出图（逐像素深拷贝）。\n"
        " *\n"
        " *  ★ 为什么是深拷贝而不是换个指针：算法里往往还建立了\n"
        " *    指向图像像素的指针表（逆透视等）。那些表的元素是地址，\n"
        " *    换掉目标缓冲会让它们集体悬空 —— 读随机内存、不报错。\n"
        " *\n"
        " *  ★ 尺寸来自 DWARF 里的真实声明（%d x %d），\n"
        " *    不是猜的 —— 填错形状会越界读，而那种错误不会报错。\n"
        " * ------------------------------------------------------------------ */\n"
        "void scut_env_copy_output(void)\n"
        "{\n"
        "    SCUT_EnvCopyOutput((const unsigned char *)%s, %d, %d);\n"
        "}\n"
        % (w, h, src, w, h))


def _emit_wrapper(args, variables):
    """写出包装编译单元。

    ★ 这个文件承担两件事，都用同一个 #include 用户源码的技巧完成：
        1) 把用户代码里的全局变量（含 static）注册进观察表；
        2) 若配置指定了"结果图数组名"，且它就声明在本文件里，
           生成搬运函数（由环境接线单元调用）。
    """
    regs = []
    for v in variables:
        dim = len(v['dims']) if v['dims'] else 0
        regs.append('    SCUT_Watch("%s", (const void*)&%s, '
                    '%s, %d, %d, %d);'
                    % (v['name'], v['name'], v['kind'],
                       v['total'], v['elem_bytes'], dim))

    fname = args.out_c.replace('\\', '/').split('/')[-1]
    body = HEADER.format(fname=fname, src=args.src, count=len(variables),
                         regs='\n'.join(regs) or '    /* (无全局变量) */',
                         copy_fn=_copy_fn_text(args.output_array, variables))
    with open(args.out_c, 'w', encoding='utf-8-sig', newline='\r\n') as f:
        f.write(body)


def _emit_manifest(args, variables):
    if not args.out_json:
        return
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
    ap.add_argument('--output-array', default='',
                    help='结果图数组名。若它声明在本文件里，则生成'
                         'scut_env_copy_output() 供环境接线单元调用')
    ap.add_argument('--image-size', default='',
                    help='图像尺寸（"188x120"），只用于错误提示的措辞')
    args = ap.parse_args()

    # 只影响错误信息的措辞，所以解析失败也不报错。
    if args.image_size:
        global IMAGE_SHAPE
        IMAGE_SHAPE = args.image_size.replace('x', ' 行 × ') + " 列"

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

    try:
        _emit_wrapper(args, variables)
    except CopyShapeError as exc:
        # 用户配置问题：把中文说明原样打到 stderr 并给出专用退出码，
        # 由 scut_build.py 转成构建错误（而不是让它冒成调用栈）。
        print('[scut_symbols] %s' % exc, file=sys.stderr)
        return 4
    _emit_manifest(args, variables)

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
