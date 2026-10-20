#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scut_dwarf.py —— 直接读目标文件里的 DWARF 调试信息（只用标准库）。

===============================================================================
为什么要有这个模块（以及为什么不再调 objdump）
===============================================================================
以前的做法是 `objdump --dwarf=info` 拿到一份【文本】，再用正则把它解析成树。
这条路有三个绕不开的问题：

  1) 不是每台机器都有能用的 objdump。
     · LLVM 21 把 llvm-objdump 的 --dwarf=info 删掉了（只剩 =frames）；
     · llvm-mingw 的 bin 里那个不带扩展名的 `objdump` 是个转发脚本，
       转给的正是 llvm-objdump —— 所以【插件自己下载的工具链】用不了；
     · 想用只能用 binutils 那一份（MinGW-w64 / MSYS2 / Git for Windows 里）。
     结果是：学生的纯净机器上变量面板恒空，而构建一切正常。

  2) 文本是人看的，格式随版本漂移。
     偏移补零位数、缩进空格数、间接字符串的写法都变过；解析器为了吃下这些
     差异只能一路放宽正则，放宽到某个程度就看不出到底是"格式变了"还是
     "文件里真没有变量"。

  3) 为了迁就第 2 点，构建脚本还额外做了一件事：
     用 objcopy 把 .debug_* 抽出来、正则改写偏移补零、再写回去。
     这是在【改用户的调试信息】以求一个外部工具能读 —— 方向本来就反了。

DWARF 的 .debug_info 是个【二进制格式】，字节布局由 DWARF 标准定死，
不随工具链版本漂移。所以这里直接读字节：只依赖 zlib（压缩调试段）和标准库，
不需要任何外部命令，clang / gcc / 以后换别的编译器都一样读。

===============================================================================
本模块的边界（刻意画得很窄）
===============================================================================
只做三件事：
    · load_die_tree(path)   把目标文件里的 DWARF 解析成 {offset: Die}
    · iter_variables(dies)  挑出【文件作用域】的变量 DIEs
    · resolve_type(dies, …) 把类型引用解析成「怎么把内存渲染成数值」
它不知道 SCUT 的数据类型枚举、不知道什么该注册、不生成任何代码 ——
那些都在 scut_symbols.py 里。这样任何一个用得上 DWARF 的地方
（测试、诊断工具、以后可能的独立检查器）都能直接复用本模块。
"""
import os
import struct
import zlib

# ---------------------------------------------------------------------------
# DWARF 常量
# ---------------------------------------------------------------------------
# 属性/标签的数值编码。只列本模块要用到的，免得把几百个常量抄进来没人看。

# DW_AT 的编号（按 DWARF 5 标准）。只列本模块用得上的。
# ★ 别按"看起来顺"去推编号：type 是 0x49、name 是 0x03、encoding 是 0x3E，
#   它们之间没有任何规律，猜错一个整棵树的属性名就会错位。
AT_NAME = 0x03
AT_BYTE_SIZE = 0x0B
AT_LOCATION = 0x02
AT_CONST_VALUE = 0x1C
AT_EXTERNAL = 0x3F
AT_DECL_FILE = 0x3A
AT_DECL_LINE = 0x3B
AT_COUNT = 0x37
AT_UPPER_BOUND = 0x2F
AT_LOWER_BOUND = 0x22
AT_ENCODING = 0x3E
AT_TYPE = 0x49
AT_LOW_PC = 0x11
AT_HIGH_PC = 0x12
AT_DATA_MEMBER_LOCATION = 0x38
AT_PRODUCER = 0x25
AT_LANGUAGE = 0x13

# 标签编号：编号 -> 名字。同样按 DWARF 5 标准，不靠记忆拼。
TAG = {
    0x01: 'DW_TAG_array_type',
    0x02: 'DW_TAG_class_type',
    0x03: 'DW_TAG_entry_point',
    0x04: 'DW_TAG_enumeration_type',
    0x05: 'DW_TAG_formal_parameter',
    0x08: 'DW_TAG_imported_declaration',
    0x0A: 'DW_TAG_label',
    0x0B: 'DW_TAG_lexical_block',
    0x0D: 'DW_TAG_member',
    0x0F: 'DW_TAG_pointer_type',
    0x10: 'DW_TAG_reference_type',
    0x11: 'DW_TAG_compile_unit',
    0x12: 'DW_TAG_string_type',
    0x13: 'DW_TAG_structure_type',
    0x15: 'DW_TAG_subroutine_type',
    0x16: 'DW_TAG_typedef',
    0x17: 'DW_TAG_union_type',
    0x18: 'DW_TAG_unspecified_parameters',
    0x19: 'DW_TAG_variant',
    0x1A: 'DW_TAG_common_block',
    0x1B: 'DW_TAG_common_inclusion',
    0x1C: 'DW_TAG_inheritance',
    0x1D: 'DW_TAG_inlined_subroutine',
    0x1E: 'DW_TAG_module',
    0x1F: 'DW_TAG_ptr_to_member_type',
    0x20: 'DW_TAG_set_type',
    0x21: 'DW_TAG_subrange_type',
    0x22: 'DW_TAG_with_stmt',
    0x23: 'DW_TAG_access_declaration',
    0x24: 'DW_TAG_base_type',
    0x25: 'DW_TAG_catch_block',
    0x26: 'DW_TAG_const_type',
    0x27: 'DW_TAG_constant',
    0x28: 'DW_TAG_enumerator',
    0x29: 'DW_TAG_file_type',
    0x2A: 'DW_TAG_friend',
    0x2B: 'DW_TAG_namelist',
    0x2C: 'DW_TAG_namelist_item',
    0x2D: 'DW_TAG_packed_type',
    0x2E: 'DW_TAG_subprogram',
    0x2F: 'DW_TAG_template_type_parameter',
    0x30: 'DW_TAG_template_value_parameter',
    0x31: 'DW_TAG_thrown_type',
    0x32: 'DW_TAG_try_block',
    0x33: 'DW_TAG_variant_part',
    0x34: 'DW_TAG_variable',
    0x35: 'DW_TAG_volatile_type',
    0x36: 'DW_TAG_dwarf_procedure',
    0x37: 'DW_TAG_restrict_type',
    0x38: 'DW_TAG_interface_type',
    0x39: 'DW_TAG_namespace',
    0x3A: 'DW_TAG_imported_module',
    0x3B: 'DW_TAG_unspecified_type',
    0x3C: 'DW_TAG_partial_unit',
    0x3D: 'DW_TAG_imported_unit',
    0x3F: 'DW_TAG_condition',
    0x40: 'DW_TAG_shared_type',
    0x41: 'DW_TAG_type_unit',
    0x42: 'DW_TAG_rvalue_reference_type',
    0x43: 'DW_TAG_template_alias',
    0x44: 'DW_TAG_coarray_type',
    0x45: 'DW_TAG_generic_subrange',
    0x46: 'DW_TAG_dynamic_type',
    0x47: 'DW_TAG_atomic_type',
    0x48: 'DW_TAG_call_site',
    0x49: 'DW_TAG_call_site_parameter',
    0x4A: 'DW_TAG_skeleton_unit',
    0x4B: 'DW_TAG_immutable_type',
}

# 表达式操作码：只关心"这个变量在内存的某个绝对地址上"这一件事。
OP_ADDR = 0x03
OP_ADDRX = 0xA1
OP_ADDDRX = 0xA2

# 压缩调试段名字（clang 的 -gz / -gz=zlib 会用到）
COMPRESSED_SUFFIXES = ('.zdebug_info', '.zdebug_abbrev', '.zdebug_str',
                       '.zdebug_line', '.zdebug_str_offsets',
                       '.zdebug_addr', '.zdebug_rnglists',
                       '.zdebug_loclists')


class DwarfError(Exception):
    """目标文件不是可识别的格式，或调试信息损坏。

    ★ 单独开一个异常类型，是为了让调用方能把"文件本身不对"
      和"解析器自己的 bug"分开：前者给用户可执行的下一步，
      后者给调用栈。"""


class Die(object):
    """一个调试信息条目（DIE）。

    depth 是【树深度】，不是文件里的字段 —— DWARF 用"NULL 条目"表示
    "回退一层"（abbrev code == 0），本模块在解析时顺带算出深度。
    调用方靠它区分"文件作用域的变量"（depth 1）和"函数内的局部静态"（depth ≥ 2）。
    """
    __slots__ = ('off', 'tag', 'attrs', 'depth', 'parent')

    def __init__(self, off, tag, depth=0, parent=None):
        self.off = off          # 在本编译单元内的偏移（十进制，便于排序/比较）
        self.tag = tag          # 标签名，如 'DW_TAG_variable'
        self.attrs = {}         # 属性名 -> 原始值（int / str / bytes / list）
        self.depth = depth
        self.parent = parent    # 父 DIE 的 off（根为 None）

    def __repr__(self):
        return '<Die d%d %s %s>' % (self.depth, self.off, self.tag)


# ===========================================================================
# LEB128
# ===========================================================================

def _uleb128(buf, pos):
    """无符号变长整数。返回 (值, 新位置)。"""
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise DwarfError('读取 ULEB128 时越界（调试信息可能被截断）')
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 70:
            raise DwarfError('ULEB128 长度异常（调试信息损坏）')


def _sleb128(buf, pos):
    """有符号变长整数。返回 (值, 新位置)。"""
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise DwarfError('读取 SLEB128 时越界（调试信息可能被截断）')
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            if b & 0x40:
                result -= (1 << shift)
            return result, pos


# ===========================================================================
# 目标文件：取段
# ===========================================================================

# COFF（Windows .obj/.o）里认得的机器码。x86_64 与 i386 是实际会遇到的两种，
# aarch64/arm 一并收下，免得将来换架构时这里又成了一道新门槛。
COFF_MACHINES = {
    0x8664: 'x86_64', 0x014C: 'i386',
    0xAA64: 'aarch64', 0xA641: 'aarch64ec',
    0x01C4: 'armnt', 0x01C0: 'arm',
}


class _ObjFile(object):
    """最小化的目标文件读取器：只认 PE/COFF 与 ELF 的节表。

    ★ 为什么不引第三方库：本项目的构建脚本全程只用标准库
      （用户装个 Python 就能跑，不需要 pip）。读节表几十行就能写完，
      没有理由为此引入依赖。"""

    def __init__(self, path):
        self.path = path
        try:
            with open(path, 'rb') as f:
                self.data = f.read()
        except OSError as exc:
            raise DwarfError('读不了目标文件 %s：%s' % (path, exc))
        if len(self.data) < 8:
            raise DwarfError('目标文件太小，不是有效的 .o/.obj：%s' % path)
        self.kind = None
        self.sections = {}   # 名字 -> (偏移, 长度)
        # 名字集合：这些节的字节前面带 ELF 压缩块头（SHF_COMPRESSED）
        self._compressed = set()
        if self.data[:4] == b'\x7fELF':
            self.kind = 'elf'
            self.is64 = self.data[4] == 2
            self._read_elf()
        elif self._looks_like_coff():
            # ★ Windows 的 .o/.obj 开头【不带】MZ —— 那是 exe/dll 才有的。
            #   .obj 直接从 COFF 文件头开始（Machine 两字节打头）。
            self.kind = 'coff'
            self._read_pe_coff()
        else:
            raise DwarfError(
                '不认识的文件格式（既不是 ELF 也不是 PE/COFF）：%s\n'
                '    本模块只支持 Windows 的 .o/.obj 与 Linux 的 .o。' % path)

    def _looks_like_coff(self):
        """按 COFF 头判断：机器码是已知值，且节表长度合理。

        ★ 加两道判据而不是只看机器码：随便一个文件的头两个字节碰巧
          等于 0x8664 并不罕见，光看它会把无关文件当成功解析，
          然后在一堆莫名其妙的地方报错。"""
        d = self.data
        if len(d) < 24:
            return False
        machine, nsect = struct.unpack_from('<HH', d, 0)
        if machine not in COFF_MACHINES:
            return False
        # 节表必须落在文件里（给一个宽松上界，别让截断文件走进更深的解析）
        return 20 + nsect * 40 <= len(d)

    # ---- ELF -----------------------------------------------------------
    def _read_elf(self):
        d = self.data
        if len(d) < 52:
            raise DwarfError('ELF 头被截断')
        is64 = d[4] == 2
        endian = '<' if d[5] == 1 else '>'
        self.is64 = is64
        self._endian = endian
        if is64:
            shoff, = struct.unpack_from(endian + 'Q', d, 0x28)
            shentsize, shnum, shstrndx = struct.unpack_from(endian + 'HHH', d, 0x3A)
        else:
            shoff, = struct.unpack_from(endian + 'I', d, 0x20)
            shentsize, shnum, shstrndx = struct.unpack_from(endian + 'HHH', d, 0x2E)
        if shoff == 0 or shoff + shentsize * shnum > len(d):
            raise DwarfError('ELF 的节表位置不合法（文件损坏）')

        def hdr(i):
            """返回 (名字偏移, 类型, 标志, 文件偏移, 长度, link, info, entsize)。"""
            base = shoff + i * shentsize
            if is64:
                name, typ, flags, addr, off, size = struct.unpack_from(
                    endian + 'IIQQQQ', d, base)
                link, info, _align, entsize = struct.unpack_from(
                    endian + 'IIQQ', d, base + 40)
            else:
                name, typ, flags, addr, off, size = struct.unpack_from(
                    endian + 'IIIIII', d, base)
                link, info, _align, entsize = struct.unpack_from(
                    endian + 'IIII', d, base + 24)
            return name, typ, flags, off, size, link, info, entsize

        if shstrndx >= shnum:
            raise DwarfError('ELF 的节名表索引越界（文件损坏）')
        _, _, _, str_off, str_size, _, _, _ = hdr(shstrndx)
        strtab = d[str_off:str_off + str_size]

        def sname(name_off):
            if name_off >= len(strtab):
                return ''
            end = strtab.find(b'\0', name_off)
            return strtab[name_off:end if end >= 0 else len(strtab)].decode(
                'ascii', 'replace')

        self._shdrs = [hdr(i) for i in range(shnum)]
        self._sec_index = {}
        for i, sh in enumerate(self._shdrs):
            name_off, typ, flags, off, size = sh[0], sh[1], sh[2], sh[3], sh[4]
            name = sname(name_off)
            if not name or typ == 8:        # SHT_NOBITS：没有文件内容
                continue
            if off + size > len(d):
                continue
            self.sections[name] = (off, size)
            self._sec_index[name] = i
            if flags & 0x800:               # SHF_COMPRESSED：按 ELF 压缩块处理
                self._compressed.add(name)

    def relocate(self, name, raw):
        """把 ELF 的可重定位引用【就地解出来】。

        ★ 为什么必须做这件事（不做就会静默读到错的东西）：
          在【可重定位】的 .o 里，DWARF 属性中"指向 .debug_str 的偏移"
          在文件里通常还是 0 —— 真实值放在 .rela.debug_info 里。
          不做这一步，每个变量都会拿到 .debug_str 的第一个字符串
          （实测：所有变量的名字都变成编译器版本号），而且不报任何错。
        ★ PE/COFF 的 .o 不需要这一步：那边的调试段引用已经是最终偏移。
        """
        if getattr(self, 'kind', '') != 'elf':
            return raw
        target_idx = getattr(self, '_sec_index', {}).get(name)
        if target_idx is None:
            return raw
        # 补丁的偏移是相对【未压缩】内容的，所以这里拿到的 raw 必须已经是
        # 解压后的字节（_section_bytes 负责），顺序反了会把补丁写进压缩流。
        out = bytearray(raw)
        for sh in self._shdrs:
            typ, link, info, entsize = sh[1], sh[5], sh[6], sh[7]
            if typ not in (4, 9) or info != target_idx:      # SHT_RELA / SHT_REL
                continue
            if link >= len(self._shdrs):
                continue
            _, _, _, symoff, symsize, _, _, _ = self._shdrs[link]
            n = sh[4] // entsize if entsize else 0
            for k in range(n):
                base = sh[3] + k * entsize
                if typ == 4:            # RELA：偏移 + 信息 + 显式加数
                    if self.is64:
                        r_off, r_info, r_add = struct.unpack_from(
                            self._endian + 'QQq', self.data, base)
                    else:
                        r_off, r_info, r_add = struct.unpack_from(
                            self._endian + 'IIi', self.data, base)
                else:                   # REL：加数在目标位置里
                    if self.is64:
                        r_off, r_info = struct.unpack_from(
                            self._endian + 'QQ', self.data, base)
                    else:
                        r_off, r_info = struct.unpack_from(
                            self._endian + 'II', self.data, base)
                    r_add = 0
                rtype = r_info & 0xFFFFFFFF
                sym_idx = r_info >> 32
                # 符号在它自己那个节里的偏移。对 .debug_str 这类节符号通常是 0，
                # 但非 0 时会算错 —— 所以真的去读一下。
                shndx = 0
                st_value = 0
                if self.is64 and symoff + (sym_idx + 1) * 24 <= len(self.data):
                    shndx, st_value = struct.unpack_from(
                        self._endian + 'HQ', self.data, symoff + sym_idx * 24 + 6)
                elif not self.is64 and symoff + (sym_idx + 1) * 16 <= len(self.data):
                    shndx, st_value = struct.unpack_from(
                        self._endian + 'HI', self.data, symoff + sym_idx * 16 + 8)
                value = st_value + r_add
                # 只管我们关心的两种位宽（32 位偏移 / 64 位地址）。
                width = 8 if rtype in (1, 18) else 4
                if r_off + width > len(out):
                    continue
                mask = (1 << (width * 8)) - 1
                out[r_off:r_off + width] = (value & mask).to_bytes(
                    width, 'little' if self._endian == '<' else 'big')
        return bytes(out)

    # ---- PE/COFF -------------------------------------------------------
    def _read_pe_coff(self):
        d = self.data
        # PE/COFF：先看是不是 PE 映像，取 COFF 头的位置
        if len(d) >= 0x40:
            pe_off, = struct.unpack_from('<I', d, 0x3C)
        else:
            pe_off = 0
        if pe_off + 24 <= len(d) and d[pe_off:pe_off + 4] == b'PE\0\0':
            # 映像文件：COFF 头紧跟签名
            coff = pe_off + 4
        else:
            # 普通 .obj：COFF 头在文件开头
            coff = 0
        if coff + 20 > len(d):
            raise DwarfError('COFF 头被截断')
        machine, nsect, _ts, symoff, nsyms, optsize, _ch = struct.unpack_from(
            '<HHIIIHH', d, coff)
        head_end = coff + 20
        sect_base = head_end + optsize

        # 节名字可能在 COFF 字符串表里（"/4" 这种写法）
        strtab = b''
        if symoff and symoff + nsyms * 18 + 4 <= len(d):
            base = symoff + nsyms * 18
            total, = struct.unpack_from('<I', d, base)
            strtab = d[base + 4:base + max(4, total)]

        for i in range(nsect):
            base = sect_base + i * 40
            if base + 40 > len(d):
                raise DwarfError('COFF 节表被截断')
            raw = d[base:base + 8]
            if raw[:1] in (b'/', b'\\'):
                # 长名："/4"、"\4" 或 "//<base64>"（LLVM 的写法）指向 COFF 字符串表
                tag = raw[1:2]
                if tag in (b'/', b'\\'):
                    name = _coff_base64_name(raw[2:].split(b'\0')[0], strtab)
                else:
                    try:
                        idx = int(raw[1:].split(b'\0')[0])
                        end = strtab.find(b'\0', idx)
                        name = strtab[idx:end].decode('ascii', 'replace')
                    except (ValueError, IndexError):
                        name = ''
                if not name:
                    name = '?sect%d' % i
            else:
                name = raw.split(b'\0')[0].decode('ascii', 'replace')
            _vsize, _vaddr, rawsize, rawptr = struct.unpack_from('<IIII', d, base + 8)
            if rawsize == 0 or rawptr + rawsize > len(d):
                continue
            self.sections[name] = (rawptr, rawsize)


def _coff_base64_name(b64, strtab):
    """解析 LLVM 的长节名写法 "//<base64>"（指向字符串表里的偏移）。

    LLVM 的 llvm-mc 输出用这种写法代替 MSVC 的 "/<十进制偏移>"。
    解不出来时返回空串，由调用方给个占位名 —— 绝不因为一个节名而中断解析。"""
    alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    val = 0
    for ch in b64.decode('ascii', 'replace'):
        if ch not in alphabet:
            return ''
        val = val * 64 + alphabet.index(ch)
    end = strtab.find(b'\0', val)
    if val >= len(strtab) or end < 0:
        return ''
    return strtab[val:end].decode('ascii', 'replace')


# ===========================================================================
# 段：解压缩、拼成逻辑段
# ===========================================================================

# ★ COFF 的节名只有 8 字节，放不下 ".debug_info"（11 个字符）。
#   MinGW 的 GCC 用"去掉点、只留后 8 个字符"（.debug_info -> "ug_info"），
#   长名写进字符串表；LLVM 则用 "//<base64>" 指过去、名字是完整的。
#   下面这张表是"残缺名 -> 完整名"，让两种写法都能认出来。
_COFF_SECTION_ALIASES = {
    'ug_info': '.debug_info',
    'ug_abbrev': '.debug_abbrev',
    'ug_str': '.debug_str',
    'ug_str_offsets': '.debug_str_offsets',
    'ug_addr': '.debug_addr',
    'ug_line': '.debug_line',
    'ug_aranges': '.debug_aranges',
    'ug_rnglists': '.debug_rnglists',
    'ug_loclists': '.debug_loclists',
    'ug_frame': '.debug_frame',
    'debug$S': '.debug$S',      # CodeView，不是 DWARF，列出来只为文档完整
}


def _canonical_section_name(name):
    if name.startswith('.debug_') or name.startswith('.zdebug_'):
        return name
    return _COFF_SECTION_ALIASES.get(name, name)


def _section_bytes(sec, name, obj):
    """取一个逻辑段的完整字节。name 是【完整名】（.debug_info 这种）。

    参数顺序（sec, name, obj）是刻意的：sec 是"节名 -> (偏移, 长度)"的表，
    obj 提供文件字节。两者分开传，调用方就不必先算好一堆切片。

    三种压缩形态都能解：
        · GNU 的 .zdebug_*（段头 4 字节 "ZLIB" + 8 字节长度）
        · ELF 的 SHF_COMPRESSED（Elf*_Chdr 头 + zlib 数据）
        · 不压缩（绝大多数情况）
    """
    if name in sec:
        off, size = sec[name]
        raw = obj.data[off:off + size]
        if name in getattr(obj, '_compressed', ()):
            return _decompress_elf_chdr(raw, name, obj)
        return raw
    zname = '.zdebug_' + name[len('.debug_'):]
    if name.startswith('.debug_') and zname in sec:
        off, size = sec[zname]
        raw = obj.data[off:off + size]
        if raw[:4] != b'ZLIB':
            raise DwarfError('%s 的压缩段头不是 "ZLIB"，无法解压' % zname)
        try:
            return zlib.decompress(raw[12:])
        except zlib.error as exc:
            raise DwarfError('%s 解压失败：%s' % (zname, exc))
    return None


def _decompress_elf_chdr(raw, name, obj):
    """解 ELF 的 SHF_COMPRESSED 节。

    头部长这样（64 位 24 字节 / 32 位 12 字节）：
        ch_type(4) · ch_reserved(4)[仅 64 位] · ch_size · ch_addralign
    ch_type == 1 表示 zlib。其他算法（zstd）不支持 —— 本模块只用标准库，
    不想为此加依赖，所以遇到就明确报错而不是给出垃圾数据。"""
    is64 = getattr(obj, 'is64', True)
    if is64:
        if len(raw) < 24:
            raise DwarfError('%s 的压缩头被截断' % name)
        ch_type, _res, _size, _align = struct.unpack_from('<IIQQ', raw, 0)
        body = raw[24:]
    else:
        if len(raw) < 12:
            raise DwarfError('%s 的压缩头被截断' % name)
        ch_type, _size, _align = struct.unpack_from('<III', raw, 0)
        body = raw[12:]
    if ch_type != 1:
        raise DwarfError(
            '%s 用了不支持的压缩算法（ch_type=%d）。\n'
            '    只支持 zlib（1）。下一步：编译时改用 -gz=zlib，或不压缩。'
            % (name, ch_type))
    try:
        return zlib.decompress(body)
    except zlib.error as exc:
        raise DwarfError('%s 解压失败：%s' % (name, exc))


# ===========================================================================
# 读取 DWARF
# ===========================================================================

class DwarfReader(object):
    """一个目标文件里的全部调试信息。

    用法：
        rd = DwarfReader(path)
        rd.ok()                   # 有没有读到 .debug_info
        rd.dies()                 # {offset: Die}（跨编译单元用全局偏移编号）
        rd.addr_size              # 指针长度（用于解析 DW_OP_addr）
    """

    def __init__(self, path):
        self.path = path
        self._obj = _ObjFile(path)
        # ★ COFF 的节名会被截断（.debug_info → ug_info），所以统一先换成
        #   完整名再查。ELF 的名字本来就是完整的，换算是个空操作。
        self._sec = {_canonical_section_name(k): v
                     for k, v in self._obj.sections.items()}
        self._info = self._load('.debug_info')
        self._abbrev = self._load('.debug_abbrev')
        self._str = self._load('.debug_str') or b''
        self._str_offsets = self._load('.debug_str_offsets') or b''
        self._addr = self._load('.debug_addr') or b''
        self.addr_size = 8
        self.units = []          # 每个元素是一个编译单元元信息 dict
        self._dies = None
        self._uid_base = 0

    def _load(self, name):
        """取一个调试段的字节：解压缩 + （ELF 时）应用重定位。"""
        raw = _section_bytes(self._sec, name, self._obj)
        if raw is None:
            return None
        return self._obj.relocate(name, raw)

    # ---- 是否可用 -------------------------------------------------------
    def ok(self):
        return bool(self._info) and bool(self._abbrev)

    def die_tree(self):
        """{offset: Die}。这里的 offset 是【全局唯一】编号：

        ★ 为什么要编号而不是直接用文件里的偏移：一个目标文件可以有多个
          编译单元（例如用户 .c 又 include 了另一个 .c），每个 CU 的偏移
          都从 0 开始算，直接用偏移当键会互相覆盖，表现为"变量少了一半"。
          所以这里给每个 CU 加一个基数，把偏移抬成全局唯一。
          对调用方来说它只是个键，不需要关心基数怎么来的。"""
        if self._dies is not None:
            return self._dies
        self._dies = {}
        if not self.ok():
            return self._dies
        units = self._split_units()
        base = 0
        for i, u in enumerate(units):
            dies = self._parse_unit(u, base)
            self._dies.update(dies)
            u['dieCount'] = len(dies)
            self.units.append(u)
            base += 1 << 32          # 每个 CU 拉开 4G，够放任何真实 CU
        return self._dies

    def dies(self):
        return self.die_tree()

    # ---- 编译单元切分 ---------------------------------------------------
    def _split_units(self):
        info = self._info
        pos = 0
        units = []
        while pos < len(info):
            start = pos
            if pos + 4 > len(info):
                break
            length, = struct.unpack_from('<I', info, pos)
            pos += 4
            is64 = False
            if length == 0xFFFFFFFF and pos + 8 <= len(info):
                length, = struct.unpack_from('<Q', info, pos)
                pos += 8
                is64 = True
            elif length >= 0xFFFFFFF0:
                # 保留值（0xFFFFFFF0 是 .debug_types 的标记）
                break
            end = pos + length
            if end > len(info):
                raise DwarfError(
                    '编译单元长度越界（声明到 %d，实际只有 %d 字节）—— '
                    '.debug_info 可能被截断' % (end, len(info)))
            if pos + 2 > len(info):
                break
            version, = struct.unpack_from('<H', info, pos)
            pos += 2
            u = {
                'start': start, 'body': pos - (8 if is64 else 4),
                'bodyEnd': end, 'version': version, 'is64': is64,
                'addrSize': self.addr_size, 'strOffsetsBase': 0,
                'addrBase': 0,
            }
            if version >= 5:
                # ★ v5 的编译单元头（DWARF 5 标准 7.5.1.2 节），字段顺序是：
                #     unit_length(u32/u64，已在上面读过) · version(u16) ·
                #     unit_type(u8) · address_size(u8) ·
                #     abbrev_offset【4 或 8 字节，跟 unit_length 的宽度走】
                #   这之后【直接就是根 DIE】。
                #
                # ★ 两个曾经写错的地方（都表现为"变量莫名其妙少一半"）：
                #   ① 这里【没有】dwo_id。只有 skeleton / split_compile /
                #      split_type / type 这几种 unit 才有额外的签名与偏移，
                #      普通 compile_unit 一个字节都没有。按印象加 8 字节的
                #      dwo_id，整条流从此错位。
                #   ② 这里【没有】属性表。str_offsets_base / addr_base 仍然
                #      是根 DIE 的属性，和 v4 一样，由 _apply_root_bases 回填。
                if pos + 2 > len(info):
                    break
                unit_type = info[pos]
                addr_size = info[pos + 1]
                pos += 2
                abbrev_off, pos = self._read_offset(pos, is64)
                u['addrSize'] = addr_size or 8
                u['type'] = unit_type
                if unit_type in (2, 4, 5, 6):
                    # type_unit / skeleton / split_compile / split_type：
                    # 8 字节签名 + 8 字节偏移。普通 compile_unit(1) 与
                    # partial_unit(3) 没有这一段。
                    pos += 16
                    if pos > end:
                        break
            else:
                if pos + 4 > len(info):
                    break
                abbrev_off, = struct.unpack_from('<I', info, pos)
                pos += 4
                if pos + 1 > len(info):
                    break
                u['addrSize'] = info[pos]
                pos += 1
            # v5 里 str_offsets_base / addr_base 是【根 DIE 的属性】，
            # 而属性里恰有 strx 形式的字符串要按它们换算 ——
            # 所以先记下位置，解析根 DIE 时再回填（见 _parse_unit）。
            u['abbrevOff'] = abbrev_off
            u['dieStart'] = pos
            units.append(u)
            pos = end
        if not units:
            raise DwarfError('.debug_info 里没有任何编译单元')
        self._units_raw = units
        return units

    def _read_offset(self, pos, is64):
        if is64:
            return struct.unpack_from('<Q', self._info, pos)[0], pos + 8
        return struct.unpack_from('<I', self._info, pos)[0], pos + 4

    # ---- 属性缩写（abbrev） --------------------------------------------
    def _load_abbrevs(self, off):
        if not hasattr(self, '_abbrev_cache'):
            self._abbrev_cache = {}
        if off in self._abbrev_cache:
            return self._abbrev_cache[off]
        buf = self._abbrev
        table = {}
        pos = off
        while pos < len(buf):
            code, pos = _uleb128(buf, pos)
            if code == 0:
                break
            tag, pos = _uleb128(buf, pos)
            has_children = buf[pos]
            pos += 1
            attrs = []
            while True:
                at, pos = _uleb128(buf, pos)
                form, pos = _uleb128(buf, pos)
                if at == 0 and form == 0:
                    break
                implicit = 0
                if form == 0x21:                 # DW_FORM_implicit_const
                    implicit, pos = _sleb128(buf, pos)
                attrs.append((at, form, implicit))
            table[code] = (tag, has_children, attrs)
        self._abbrev_cache[off] = table
        return table

    # ---- 解析一个 CU ----------------------------------------------------
    def _parse_unit(self, u, uid_base):
        info = self._info
        abbrev = self._load_abbrevs(u['abbrevOff'])
        dies = {}
        pos = u['dieStart']
        end = u['bodyEnd']
        stack = []                 # 每层是当前 DIE（父）
        while pos < end:
            die_off = pos
            code, pos = _uleb128(info, pos)
            if code == 0:
                # NULL 条目：上一层结束
                if stack:
                    stack.pop()
                continue
            ab = abbrev.get(code)
            if ab is None:
                raise DwarfError(
                    '编译单元引用了不存在的缩写码 %d（.debug_abbrev 与 '
                    '.debug_info 不匹配）' % code)
            tag_num, has_children, attr_spec = ab
            tag = TAG.get(tag_num, 'DW_TAG_unknown_0x%x' % tag_num)
            depth = len(stack)
            parent = stack[-1].off if stack else None
            die = Die(uid_base + die_off, tag, depth, parent)
            for at, form, implicit in attr_spec:
                val, pos = self._read_form(u, form, pos, implicit)
                name = _ATTR_NAMES.get(at, 'DW_AT_0x%x' % at)
                # ★ 同名属性保留【第一个】：DWARF 里同名重复只出现在
                #   畸形输入，取第一个比取最后一个更接近原意。
                die.attrs.setdefault(name, val)
            # v4 里 str_offsets_base / addr_base 是根 DIE 的属性，
            # 而属性里恰有 strx 形式的字符串要按它们换算 —— 根 DIE 一读完
            # 就回填，并把刚才按 0 基址解错的那几个字符串重算一次。
            if tag_num == 0x11 or tag_num == 0x41:      # compile_unit / partial_unit
                self._apply_root_bases(u, die)
            dies[die.off] = die
            if has_children:
                stack.append(die)
        return dies

    def _apply_root_bases(self, u, root):
        """根 DIE 里的 str_offsets_base / addr_base 生效后，补算已经解出的 strx。"""
        base = root.attrs.get('DW_AT_str_offsets_base')
        if isinstance(base, int):
            u['strOffsetsBase'] = base
            for k, v in list(root.attrs.items()):
                if isinstance(v, tuple) and v and v[0] == 'strx':
                    s = self._strx(v[1], base)
                    if s is not None:
                        root.attrs[k] = s
        abase = root.attrs.get('DW_AT_addr_base')
        if isinstance(abase, int):
            u['addrBase'] = abase

    def _strx(self, idx, base=None):
        off = (base if base is not None else 0) + idx * 4
        if off + 4 > len(self._str_offsets):
            return None
        target, = struct.unpack_from('<I', self._str_offsets, off)
        return self._cstring(target)

    def _cstring(self, off, buf=None):
        buf = self._str if buf is None else buf
        if off >= len(buf):
            return None
        end = buf.find(b'\0', off)
        if end < 0:
            end = len(buf)
        return buf[off:end].decode('utf-8', 'replace')

    # ---- 一个属性值 -----------------------------------------------------
    def _read_form(self, u, form, pos, implicit):
        """按 form 读一个值。返回 (值, 新位置)。

        ★ 这张表必须与 DWARF 标准的 form 编号【逐一对上】。曾经凭印象
          拼过一张"定长整数"表，把 strp(0x0E) 当成 data4 读，整棵树的
          偏移从第二个 DIE 起全部错位 —— 现象却是"报一个不存在的缩写码"，
          离真正的原因很远。所以下面按编号顺序逐个写，不合并。
        ★ 宽度随格式变的（strp / sec_offset / addr）：64 位 DWARF 里是 8 字节，
          其余 4 字节。判据是编译单元头（is64），不是指针长度。"""
        info = self._info
        w = 8 if u.get('is64') else 4
        if form == 0x01:                        # addr（宽度 = 目标机指针宽度）
            n = u['addrSize']
            val = struct.unpack_from({4: '<I', 8: '<Q'}.get(n, '<Q'), info, pos)[0]
            return ('addr', val), pos + n
        if form == 0x03:                        # block2
            ln, = struct.unpack_from('<H', info, pos)
            return ('block', info[pos + 2:pos + 2 + ln]), pos + 2 + ln
        if form == 0x04:                        # block4
            ln, = struct.unpack_from('<I', info, pos)
            return ('block', info[pos + 4:pos + 4 + ln]), pos + 4 + ln
        if form == 0x05:                        # data2
            return struct.unpack_from('<H', info, pos)[0], pos + 2
        if form == 0x06:                        # data4
            return struct.unpack_from('<I', info, pos)[0], pos + 4
        if form == 0x07:                        # data8
            return struct.unpack_from('<Q', info, pos)[0], pos + 8
        if form == 0x08:                        # string（直接写在字节流里）
            end = info.find(b'\0', pos)
            if end < 0:
                end = len(info)
            return info[pos:end].decode('utf-8', 'replace'), end + 1
        if form == 0x09:                        # block
            ln, pos = _uleb128(info, pos)
            return ('block', info[pos:pos + ln]), pos + ln
        if form == 0x0A:                        # block1
            ln = info[pos]
            return ('block', info[pos + 1:pos + 1 + ln]), pos + 1 + ln
        if form == 0x0B:                        # data1
            return info[pos], pos + 1
        if form == 0x0C:                        # flag（一字节布尔）
            return info[pos], pos + 1
        if form == 0x0D:                        # sdata（有符号变长）
            return _sleb128(info, pos)
        if form == 0x0E:                        # strp（指向 .debug_str 的偏移）
            off = struct.unpack_from('<Q' if w == 8 else '<I', info, pos)[0]
            return self._cstring(off) or '', pos + w
        if form == 0x0F:                        # udata（无符号变长）
            return _uleb128(info, pos)
        if form == 0x10:                        # ref_addr
            val = struct.unpack_from('<Q' if w == 8 else '<I', info, pos)[0]
            return ('ref', val), pos + w
        if form == 0x11:                        # ref1
            return ('ref', info[pos]), pos + 1
        if form == 0x12:                        # ref2
            return ('ref', struct.unpack_from('<H', info, pos)[0]), pos + 2
        if form == 0x13:                        # ref4
            return ('ref', struct.unpack_from('<I', info, pos)[0]), pos + 4
        if form == 0x14:                        # ref8
            return ('ref', struct.unpack_from('<Q', info, pos)[0]), pos + 8
        if form == 0x15:                        # ref_udata
            val, pos = _uleb128(info, pos)
            return ('ref', val), pos
        if form == 0x16:                        # indirect：真实 form 写在值前面
            nf, pos = _uleb128(info, pos)
            return self._read_form(u, nf, pos, implicit)
        if form == 0x17:                        # sec_offset
            return struct.unpack_from('<Q' if w == 8 else '<I', info, pos)[0], pos + w
        if form == 0x18:                        # exprloc
            ln, pos = _uleb128(info, pos)
            return ('block', info[pos:pos + ln]), pos + ln
        if form == 0x19:                        # flag_present（等于 true）
            return 1, pos
        if form == 0x1A:                        # strx
            idx, pos = _uleb128(info, pos)
            return self._read_strx(u, idx), pos
        if form == 0x1B:                        # addrx
            idx, pos = _uleb128(info, pos)
            return self._read_addrx(u, idx), pos
        if form == 0x1C:                        # ref_sup4
            return ('ref', struct.unpack_from('<I', info, pos)[0]), pos + 4
        if form == 0x1D:                        # strp_sup
            off = struct.unpack_from('<I', info, pos)[0]
            return self._cstring(off) or '', pos + 4
        if form == 0x1E:                        # data16
            return struct.unpack_from('<H', info, pos)[0], pos + 2
        if form == 0x1F:                        # line_strp
            off = struct.unpack_from('<Q' if w == 8 else '<I', info, pos)[0]
            return self._cstring(off) or '', pos + w
        if form == 0x20:                        # ref_sig8
            return ('ref', struct.unpack_from('<Q', info, pos)[0]), pos + 8
        if form == 0x21:                        # implicit_const（值在缩写表里）
            return implicit, pos
        if form == 0x22:                        # loclistx
            idx, pos = _uleb128(info, pos)
            return ('loclistx', idx), pos
        if form == 0x23:                        # rnglistx
            idx, pos = _uleb128(info, pos)
            return ('rnglistx', idx), pos
        if form == 0x24:                        # ref_sup8
            return ('ref', struct.unpack_from('<Q', info, pos)[0]), pos + 8
        if form in (0x25, 0x26, 0x27, 0x28):    # strx1 / strx2 / strx3 / strx4
            n = form - 0x24
            val = int.from_bytes(info[pos:pos + n], 'little')
            return self._read_strx(u, val), pos + n
        if form in (0x29, 0x2A, 0x2B, 0x2C):    # addrx1 / addrx2 / addrx3 / addrx4
            n = form - 0x28
            val = int.from_bytes(info[pos:pos + n], 'little')
            return self._read_addrx(u, val), pos + n
        raise DwarfError('不认识的属性编码 DW_FORM_0x%x' % form)

    def _read_strx(self, u, idx):
        base = u.get('strOffsetsBase') or 0
        s = self._strx(idx, base)
        # base 还没解析到时先记下原始下标，等根 DIE 处理完再补算
        return s if s is not None else ('strx', idx)

    def _read_addrx(self, u, idx):
        """DW_FORM_addrx：下标 -> .debug_addr 里的地址。

        ★ 宽度用【编译单元】的 addrSize，不是 self.addr_size：
          后者只是文件级的默认值（8），而 CU 头里可能写 4。
        ★ DWARF 5 的 .debug_addr 每段开头有 8 字节头（unit_length 4 +
          version 2 + addr_size 1 + seg_sel_size 1），而根 DIE 的
          DW_AT_addr_base 通常正好指向头之后。所以这里只做 base + idx*宽度，
          不额外跳头 —— 跳了就重复扣了一次。
        """
        n = u.get('addrSize') or self.addr_size
        base = u.get('addrBase') or 0
        off = base + idx * n
        if n not in (4, 8) or off + n > len(self._addr):
            return ('addr', 0)
        val = struct.unpack_from('<Q' if n == 8 else '<I', self._addr, off)[0]
        return ('addr', val)


# 属性名表：编号 -> 名字。
# ★ 只放【会用到的】和【出问题时值得看见的】。其余属性没有名字，
#   解析时会带成 DW_AT_0xNN 照样留在 attrs 里 —— 但名字表里一个都不能猜，
#   猜错一个就会让下游读到另一个属性的值（静默、且很难怀疑到这里）。
_ATTR_NAMES = {
    0x02: 'DW_AT_location',
    0x03: 'DW_AT_name',
    0x0B: 'DW_AT_byte_size',
    0x10: 'DW_AT_stmt_list',
    0x11: 'DW_AT_low_pc',
    0x12: 'DW_AT_high_pc',
    0x13: 'DW_AT_language',
    0x1C: 'DW_AT_const_value',
    0x25: 'DW_AT_producer',
    0x2F: 'DW_AT_upper_bound',
    0x37: 'DW_AT_count',
    0x38: 'DW_AT_data_member_location',
    0x3A: 'DW_AT_decl_file',
    0x3B: 'DW_AT_decl_line',
    0x3E: 'DW_AT_encoding',
    0x3F: 'DW_AT_external',
    0x49: 'DW_AT_type',
    # ★ 这两个是 DWARF 5 的调试段基址，编号在 0x7x 段而不是按语义紧挨着
    #   其他属性。写错的话 strx/addrx 全部按 0 基址换算 ——
    #   现象是"每个变量都拿到了隔壁变量的名字"，且完全不报错。
    0x72: 'DW_AT_str_offsets_base',
    0x73: 'DW_AT_addr_base',
}


# ===========================================================================
# 便捷接口（调用方用这几个就够）
# ===========================================================================

def load_die_tree(path):
    """读取目标文件，返回 (DwarfReader, {offset: Die})。

    ★ 拿不到调试信息时【不抛异常】，返回 (reader, {})：
      调用方据此走"没有变量清单"的降级路径，而不是让构建失败。
      文件不是可识别的格式时才抛 DwarfError（那说明路径给错了）。"""
    rd = DwarfReader(path)
    if not rd.ok():
        return rd, {}
    return rd, rd.die_tree()


def attr_str(die, name):
    """取字符串属性（名字这类）。缺失或不是字符串时返回 ''。"""
    v = die.attrs.get(name)
    return v if isinstance(v, str) else ''


def attr_int(die, name, default=None):
    """取整数属性（字节数、行号、上界这类）。"""
    v = die.attrs.get(name)
    if isinstance(v, int):
        return v
    if isinstance(v, tuple):
        return default
    return default


def attr_ref(die, name):
    """取类型引用（的偏移号）。没有时返回 None。

    ★ 偏移号是【文件内】的偏移，和 die_tree() 的键不直接相等：
      后者带每单元基数（见 DwarfReader.die_tree）。要跳转类型用 die_tree
      里的同名逻辑 —— 调用方拿到偏后按"同一编译单元内"换算。
      这里给的是原始值，换算函数见 scut_symbols.resolve_type 的说明。"""
    v = die.attrs.get(name)
    if isinstance(v, tuple) and len(v) == 2 and v[0] == 'ref':
        return v[1]
    return None


def attr_block(die, name):
    """取表达式字节块（location 这类）。没有时返回 b''。"""
    v = die.attrs.get(name)
    if isinstance(v, tuple) and len(v) == 2 and v[0] == 'block':
        return v[1]
    return b''


def has_absolute_address(die):
    """这个变量的 location 是不是"内存里的某个绝对地址"。

    ★ 只有这种变量才值得注册：别的形式（栈上、寄存器里、常数）在
      文件里没有稳定的存储位置，观察它没有意义。
    ★ DWARF 4 的地址是 DW_OP_addr(0x03) + 地址；DWARF 5 变成
      DW_OP_addrx(0xA1) + ULEB128 下标。两种都认。"""
    return is_address_expr(attr_block(die, 'DW_AT_location'))


def is_address_expr(expr):
    """表达式是不是"绝对地址"（DW_OP_addr / DW_OP_addrx）。"""
    if not expr:
        return False
    if expr[0] == OP_ADDR:
        return len(expr) >= 2
    if expr[0] == OP_ADDRX:
        return len(expr) >= 2
    return False
