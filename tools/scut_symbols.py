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
    1) clang -g -O0 -c user.c -o user.o                    # 探针编译，产出 DWARF
    2) python scut_symbols.py --obj user.o --src user.c \
              --out-c user.wrapped.c --out-json user.vars.json
    3) clang -g -O0 -c user.wrapped.c -o user.o            # 真正的目标文件
    4) 链接

★ DWARF 由 scut_dwarf.py 直接读字节，不经过任何外部命令。
  所以 clang / gcc / 以后的编译器都一样能读，不再要求机器上装着
  哪一家的 objdump。

★ 本脚本【不设版本闸门】：它只 import 标准库（argparse/json/re/sys 与同目录的
  scut_dwarf），语法在 Python 3.6 上也能跑。
  调用方 scut_build.py 有 3.7 闸门（因为那边用了 __future__ annotations），
  而且它会把【同一个解释器】同时用于两个脚本 —— 所以实际下限由那边决定，
  这里重复设一道闸门只会制造"两个脚本下限不一致"的困惑。
"""
import argparse
import json
import os
import re
import sys

# ★ 同目录的兄弟模块。用 sys.path 而不是相对导入：本脚本是被
#   `python tools/scut_symbols.py` 直接当文件跑的，没有包上下文。
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scut_dwarf as dwarf  # noqa: E402  （必须在 sys.path 调整之后）

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
# 从 DWARF 到「这是什么类型的变量」
#
# ★ 这一段只关心【怎么把内存渲染成数值】，读字节的活在 scut_dwarf 里。
# ---------------------------------------------------------------------------

# 文件作用域的变量在 DWARF 树里的深度。
#     depth 0 = 编译单元根
#     depth 1 = 文件作用域的声明（全局变量、函数）
#     depth 2 = 函数内的局部变量 / 结构体成员
# ★ 只取 depth == 1：函数内的 static 局部变量在 DWARF 里【同样有绝对地址】，
#   看起来完全合法，但它在文件作用域并不可见，生成的包装单元会编译失败
#   （error: 'xxx' undeclared）。
FILE_SCOPE_DEPTH = 1

# DWARF 的基本类型编码（DW_ATE_*）。只用来判断"有符号还是无符号"。
DW_ATE_BOOLEAN = 0x02
DW_ATE_SIGNED = 0x05
DW_ATE_SIGNED_CHAR = 0x06
DW_ATE_UNSIGNED = 0x07
DW_ATE_UNSIGNED_CHAR = 0x08

# 图像尺寸的【展示用】副本，由 --image-size 传入（格式 "188x120"）。
#
# ★ 为什么让构建脚本传进来、而不在这里重新解析 config.h：
#   尺寸的真值来源是 scut_project.json，而构建脚本已经读过它了。
#   在这里再解析一遍等于把"同一件事有多个权威"引入进来 ——
#   将来改了配置格式就会有一处漏改，而漏改的表现是错误提示里的数字不对，
#   比不显示数字更误导人。
#   它只用于错误信息，不参与任何生成逻辑，所以缺省值是安全的。
IMAGE_SHAPE = "由工程配置决定的整幅图像尺寸"


class CopyShapeError(Exception):
    """结果图数组的形状不对（不是数组）。

    ★ 单独开一个异常类型（而不是复用通用 Exception）是为了让
      scut_build.py 能把它和"生成器内部出错"区分开：
      前者是【用户配置问题】，要给可执行的下一步；
      后者是脚本 bug，要给调用栈。两类问题的措辞完全不同。"""


def _children(dies, die):
    """直接子节点（按 DWARF 里的出现顺序）。

    ★ 用 parent 指针而不是"按偏移相邻"去推父子关系：父子关系是
      DWARF 用 NULL 条目显式表达的，按相邻推会在兄弟节点自己也带
      子节点时错位。"""
    return [d for d in dies.values() if d.parent == die.off]


def _subrange_count(d):
    """一个 DW_TAG_subrange_type 表示多少元素。算不出来返回 None。

    ★ 上界可能是"引用到一个常量 DIE"（gcc 对 VLA 就这么写），
      这时算不出固定长度 —— 返回 None 表示"这一维未知"，
      由调用方决定怎么降级，不要拿个猜出来的数糊弄过去。"""
    ub = dwarf.attr_int(d, 'DW_AT_upper_bound')
    if ub is not None:
        lb = dwarf.attr_int(d, 'DW_AT_lower_bound', 0) or 0
        return ub - lb + 1
    cnt = dwarf.attr_int(d, 'DW_AT_count')
    if cnt is not None:
        return cnt
    return None


def _collect_dims(dies, arr_die, base):
    """
    收集数组维度。从 arr_die 顺着子节点找 DW_TAG_subrange_type，
    每个子节点贡献一维。

    ★★ dims 必须【拼接】而不是覆盖（第 12 轮评审修复）★★

        typedef uint8_t Row[188];
        Row g_row[120];        →  期望 dims=[120,188] total=22560

    gcc 会把 typedef 拍平，DWARF 里看不到 DW_TAG_typedef，所以旧写法
    （`out['dims'] = dims` 直接覆盖）在 gcc 上一直是"对的"——
    这也是它潜伏至今的原因：本项目的测试长期用 gcc 跑 primary。

    而 llvm-mingw 的 clang 原样发出类型链：

        array_type[120] → DW_TAG_typedef(Row) → array_type[188] → uint8_t

    于是 resolve_type 在外层 array_type 上递归，内层解析返回
    base['dims']=[188]，随后本函数用外层的 [120] 【覆盖】它 →
    dims=[120] total=120。

    下游 `len(dims)==1` 的分支据此认定"这是一行"。若这个数组被填进
    「结果图数组名」，生成的就是 SCUT_EnvCopyOutput(SCUT_IMG_1, &g_row[0], 120, 1)
    —— 只搬 1 行，画面是上面一条，且【不报任何错】。

    ★ 拼接顺序是【从外到内】：外层维度在前，内层在后。
      与 C 的语义一致（g_row[i][j] 的 i 是外层、j 是内层），
      也和朴素二维数组 a[H][W] 的 [H, W] 一致 ——
      下游 `dims[0]` 当行数、`dims[1]` 当列数的约定才不会错。
    """
    dims = []
    for d in _children(dies, arr_die):
        if d.tag != 'DW_TAG_subrange_type':
            continue
        n = _subrange_count(d)
        if n is not None:
            dims.append(n)
    out = dict(base)
    # ★ 外层 + 内层。内层是数组 typedef 时才非空。
    merged = dims + list(base.get('dims') or [])
    if merged:
        out['dims'] = merged
        total = 1
        for n in merged:
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

    ref 是 scut_dwarf 给出的偏移号（dwarf.attr_ref 的返回值）。
    """
    if depth > 24:
        return None
    if not ref or ref not in dies:
        return None
    die = dies[ref]

    if die.tag == 'DW_TAG_typedef':
        return resolve_type(dies, dwarf.attr_ref(die, 'DW_AT_type'), depth + 1)

    if die.tag in ('DW_TAG_pointer_type', 'DW_TAG_reference_type',
                   'DW_TAG_rvalue_reference_type'):
        return dict(kind='SCUT_T_PTR', elem_bytes=8, dims=[], total=1,
                    is_struct=False, ptr=True)

    if die.tag == 'DW_TAG_base_type':
        name = dwarf.attr_str(die, 'DW_AT_name')
        size = dwarf.attr_int(die, 'DW_AT_byte_size', 0) or 0
        if name in BASE_TYPES:
            k, b = BASE_TYPES[name]
            return dict(kind=k, elem_bytes=b, dims=[], total=1,
                        is_struct=False, ptr=False)
        # 未知基础类型：先看 encoding 判符号性，再按字节数猜 ——
        # 否则会把 signed 误判成 unsigned，那是静默错值。
        enc = dwarf.attr_int(die, 'DW_AT_encoding', 0) or 0
        unsigned = enc in (DW_ATE_UNSIGNED, DW_ATE_UNSIGNED_CHAR,
                           DW_ATE_BOOLEAN)
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
        size = dwarf.attr_int(die, 'DW_AT_byte_size', 0) or 4
        return dict(kind='SCUT_T_ENUM', elem_bytes=size, dims=[], total=1,
                    is_struct=False, ptr=False)

    # ★ 类型限定符必须【透明穿透】。
    #   `const int x` 的类型引用指向 DW_TAG_const_type，它自身没有
    #   DW_AT_name / DW_AT_byte_size，只有 DW_AT_type 指向真实类型。
    #   早期版本未处理这几个 tag，导致所有 const 变量被静默丢弃
    #   （表现为「面板里看不到 const 数组」），且不报任何错。
    if die.tag in ('DW_TAG_const_type', 'DW_TAG_volatile_type',
                   'DW_TAG_restrict_type', 'DW_TAG_atomic_type'):
        return resolve_type(dies, dwarf.attr_ref(die, 'DW_AT_type'), depth + 1)

    if die.tag in ('DW_TAG_structure_type', 'DW_TAG_union_type',
                   'DW_TAG_class_type'):
        size = dwarf.attr_int(die, 'DW_AT_byte_size', 0) or 0
        return dict(kind='SCUT_T_STRUCT', elem_bytes=size or 1, dims=[],
                    total=1, is_struct=True, ptr=False)

    if die.tag == 'DW_TAG_array_type':
        base = resolve_type(dies, dwarf.attr_ref(die, 'DW_AT_type'), depth + 1)
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
        name = dwarf.attr_str(die, 'DW_AT_name')
        if not name or not re.match(r'^[A-Za-z_]\w*$', name):
            continue
        # 必须有 DW_AT_location 且是绝对地址 —— 这样才是实例化对象，
        # 而不是仅有声明的 extern 引用（那些注册了也没有意义）。
        if not dwarf.has_absolute_address(die):
            continue
        ty = resolve_type(dies, dwarf.attr_ref(die, 'DW_AT_type'))
        if ty is None:
            continue
        out.append(dict(
            name=name, kind=ty['kind'], dims=ty['dims'], total=ty['total'],
            elem_bytes=ty['elem_bytes'], is_struct=ty['is_struct'],
            ptr=ty['ptr'],
            external=dwarf.attr_int(die, 'DW_AT_external', 0) == 1,
            decl_line=dwarf.attr_int(die, 'DW_AT_decl_line'),
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

/* ★ 重新锚定行号：用户源码末尾若是未闭合的注释/条件编译，
 *   没有这一行时下面的构造函数会被一起吞掉（编译失败或静默少注册）。 */
#line 1 "<scut_autoreg>"

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

      SCUT_EnvCopyOutput(SCUT_IMG_1, ptr, 0, 0) 的约定是"用环境的宽高"，
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
        "    SCUT_EnvCopyOutput(SCUT_IMG_1, (const unsigned char *)%s, %d, %d);\n"
        "}\n"
        % (w, h, src, w, h))


def _emit_wrapper(args, variables, all_variables=None):
    """写出包装编译单元。

    ★ 这个文件承担两件事，都用同一个 #include 用户源码的技巧完成：
        1) 把用户代码里的全局变量（含 static）注册进观察表；
        2) 若配置指定了"结果图数组名"，且它就声明在本文件里，
           生成搬运函数（由环境接线单元调用）。

    ★ 为什么要有 all_variables 这个参数（默认等于 variables）：
      第 2) 件事需要看到结果图数组的【声明形状】，而它可能被
      --exclude / --max-elems 从注册列表里滤掉了（见 main() 的说明）。
      所以"注册用哪个列表"与"找数组形状用哪个列表"必须分开传：
        variables     —— 过滤后，进注册表（用户在面板里看得到的）
        all_variables —— 过滤前，只用来生成搬运函数
      不分开的话，用户一排除结果图数组，搬运函数就没了，
      构建随即报"数组找不到"（而它明明存在）。
    """
    if all_variables is None:
        all_variables = variables
    regs = []
    for v in variables:
        dim = len(v['dims']) if v['dims'] else 0
        regs.append('    SCUT_Watch("%s", (const void*)&%s, '
                    '%s, %d, %d, %d);'
                    % (v['name'], v['name'], v['kind'],
                       v['total'], v['elem_bytes'], dim))
        # 来源标签：宿主据此把它和"用户在 code/ 里手写的注册"区分开。
        regs.append('    scut_watch_tag("%s", SCUT_WATCH_TAG_AUTO);'
                    % v['name'])

    fname = args.out_c.replace('\\', '/').split('/')[-1]
    body = HEADER.format(fname=fname, src=args.src, count=len(variables),
                         regs='\n'.join(regs) or '    /* (无全局变量) */',
                         copy_fn=_copy_fn_text(args.output_array, all_variables))
    with open(args.out_c, 'w', encoding='utf-8-sig', newline='\r\n') as f:
        f.write(body)


def scan_manual_watches(src_path):
    """找出【用户手写】的变量注册调用，返回一组变量名。

    ================================================================================
    为什么必须扫源码，而不是靠"运行期注册表 - 编译期 DWARF"
    ================================================================================
    曾经用差集判定"主动暴露"：运行期注册表里有、编译期 DWARF 里没有的，就是
    用户手写的。实测在真实工程上这个判据【恒为空】：
    运行期注册表 42 个，编译期 DWARF 也 42 个，完全重合。

    原因是自动发现生成的包装单元调用的也是 SCUT_Watch，
    和用户手写的 SCUT_WATCH_SCALAR 进的是同一个注册表、同一张表。
    注册表只记录"名字/地址/类型"，没有"这行代码是谁写的"这个信息 ——
    到了这一步已经分不出来了。

    唯一可靠的区分点是【源码】：用户手写的调用出现在 code/ 下的文件里，
    自动生成的只出现在 .scut/gen/ 的包装单元里。所以扫源码。

    ================================================================================
    为什么要把"主动/自动"这个区分做对
    ================================================================================
    用户的手工注册是"我想让你看见这几个量"，语义上等同于"勾选"，
    不该再要求他去变量列表里重新勾一遍。所以面板必须恒定显示它们。

    覆盖 SCUT_Watch 本身、SCUT_WATCH_SCALAR、SCUT_WATCH_ARRAY，以及用户自己
    包一层、名字里带 SCUT_Watch 的宏（例如 MY_SCUT_Watch）。
    """
    names = set()
    try:
        with open(src_path, 'r', encoding='utf-8', errors='replace') as f:
            text = f.read()
    except OSError:
        return names

    # 只去注释；【不要】去字符串字面量 ——
    # 因为要抓的恰恰就是 SCUT_Watch("名字", ...) 里的那个字符串。
    # （曾经在这里把字符串字面量也剥掉，结果连要匹配的参数一起没了，
    #   扫出来恒为空：7 个手写变量一个都没认出来。）
    text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
    text = re.sub(r'//[^\n]*', ' ', text)

    # 宏名 + 左括号 + 可空白 + 引号 + 名字。名字到收尾引号为止，
    # 中间不允许出现引号或换行，保证不会跨调用误抓。
    # ★ 覆盖所有以 SCUT_Watch 开头的调用名：SCUT_Watch 本身、
    #   SCUT_WATCH_SCALAR / SCUT_WATCH_ARRAY，以及用户自己包一层的
    #   MY_SCUT_Watch 之类（只要名字里带着 SCUT_Watch）。
    pat = r'\b[A-Za-z_]\w*SCUT_Watch\w*\s*\(\s*"([^"\n]+)"'
    for m in re.finditer(pat, text):
        names.add(m.group(1))

    # 用户给宏起了与自己里层调用不同的名字时（例如 WATCH_F(x)），
    # 内层调用的名字是参数而不是字面量，上面那条抓不到 ——
    # 退回按"本文件里出现过的字符串字面量"收集候选。
    for m in re.finditer(r'"([A-Za-z_]\w*)"', text):
        names.add(m.group(1))
    return names


def _emit_manifest(args, variables):
    if not args.out_json:
        return
    # 扫描用哪个路径：优先 --src-abs（绝对、可靠），退回 --src。
    # ★ 为什么需要 --src-abs：--src 会被原样写进生成文件里的
    #   `#include "{src}"`，所以它必须是相对 code/ 的路径。
    #   而本脚本的工作目录不保证是工程根，按 --src 相对路径去 open()
    #   可能失败 —— 曾经就是这样：失败被 except 吞掉、静默返回空集。
    hand = scan_manual_watches(args.src_abs or args.src)

    manifest = {
        'note': MANIFEST_NOTE,
        'source': args.src,
        'count': len(variables),
        # ★★ 手写注册的名单由宿主用【运行期标签】补全，这里只留空表。
        #
        #   手写注册最常见的是结构体成员，它在 DWARF 里没有独立条目，
        #   编译期根本看不到。所以"哪些是手写的"只能到运行期问：
        #   生成的注册会给自动发现的变量带上 SCUT_WATCH_AUTO 来源标签，
        #   宿主取"注册表里有、但不带标签"的名字，就是用户手写的集合。
        'manualWatches': [],
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
                # 编译期的初值：本文件里出现过这个名字的字面量。
                # ★ 生成器自己写的那行注册也算在内，所以最终判定在运行期，
                #   见上面 manualWatches 的说明。
                'manual': v['name'] in hand,
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
    ap.add_argument('--src', required=True, help='原始源文件名（用于 #include，必须相对 code/）')
    ap.add_argument('--src-abs', default='',
                    help='原始源文件的绝对路径，仅用于扫描用户手写的 '
                         'SCUT_Watch/SCUT_WATCH_SCALAR 调用；留空则退回 --src')
    ap.add_argument('--out-c', required=True, help='输出的包装 .c 文件')
    ap.add_argument('--out-json', help='输出的变量清单 JSON')
    # ★ 兼容参数：旧版靠 objdump 读 DWARF，现在不用了。
    #   保留它是为了让还在传这个参数的调用方不报「不认识的参数」——
    #   构建脚本、插件、用户自己写的脚本都可能带着它。传进来的值会被忽略。
    ap.add_argument('--objdump', default='', help=argparse.SUPPRESS)
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

    # ---- 读 DWARF（纯 Python，不调任何外部命令） --------------------------
    #
    # ★ 静默失败检测：读不出任何 DIE 时【明确报错】。
    #   这是本项目最危险的一类失败：构建整体成功，用户以为一切正常，
    #   只是变量面板永远空的。已知成因：
    #     1) 探针编译没带 -g（没调试信息）；
    #     2) 调试信息是 CodeView 而不是 DWARF（MSVC 的 cl.exe 就是）；
    #     3) 目标文件被 strip 过。
    #   三种都读不出 DIE，但给用户的话完全不同，所以按证据分开说。
    try:
        reader, dies = dwarf.load_die_tree(args.obj)
    except dwarf.DwarfError as exc:
        print('[scut_symbols] 读不了调试信息：%s' % exc, file=sys.stderr)
        return 2

    if not dies:
        if not reader.ok():
            hint = ("目标文件里没有 DWARF 调试信息（.debug_info 段不存在）。\n"
                    "  最常见的原因：探针编译没带 -g。\n"
                    "  已确认：%s" % args.obj)
            if '.debug$S' in reader._obj.sections:
                hint += ("\n  另外：这个文件里是 CodeView 调试信息（.debug$S），"
                         "\n    那是 MSVC 的格式，不是 DWARF —— "
                         "请用 clang/mingw 的编译器。")
        else:
            hint = ("目标文件里有调试信息，但解析不出任何条目。\n"
                    "  说明：这是 scut_dwarf 的兼容性缺口，不是你的代码问题。\n"
                    "  请把 %s 保留下来反馈（它不含源码正文）。" % args.obj)
        print('[scut_symbols] %s' % hint, file=sys.stderr)
        return 3

    variables = collect_variables(dies)

    # ★★ 结果图数组要先单独留下来（豁免于下面两个过滤器）★★
    #
    # 为什么：本生成器除了注册变量，还要为 `--output-array` 生成搬运函数
    # scut_env_copy_output()，而那个函数的形状（逐像素深拷贝 + 尺寸适配）
    # 靠【看得见该数组的声明】推导出来。
    # 若结果图数组被 --exclude 点名、或因元素数超过 --max-elems 被滤掉
    # （而结果图恰恰通常是 22560 元素的大数组！），它就会消失 →
    # 搬运函数不被生成 → 构建脚本随即报
    #     "设置里指定的「结果图数组名」在 code/ 里找不到"
    # 而那个数组明明存在。用户会去改配置里的数组名 —— 越改越错。
    #
    # ★ 留两份而不是"强行塞回注册列表"：
    #   用户点名排除它，就是不想在面板里看到它（那是他的权利）。
    #   所以只把它喂给搬运函数的生成逻辑，不注册进观察表。
    all_vars = variables
    black = {s.strip() for s in args.exclude.split(',') if s.strip()}
    variables = [v for v in variables
                 if v['name'] not in black and not v['name'].startswith('_')]
    if args.max_elems > 0:
        variables = [v for v in variables if v['total'] <= args.max_elems]
    variables.sort(key=lambda v: v['name'])      # 稳定可复现

    try:
        _emit_wrapper(args, variables, all_vars)
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
