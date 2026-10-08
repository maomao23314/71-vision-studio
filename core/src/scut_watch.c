/* ==========================================================================
 *  scut_watch.c —— 变量观察注册表实现
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 适应任意代码 → 只存放「名字 + 地址 + 类型 + 形状」，对用户变量零假设
 *    · 上手即用     → 生成代码只需一次调用；UI 只读文本，不碰原始内存
 *
 *  ★ 生命周期：注册发生在【构造函数期】（main 之前），
 *    读取发生在 main 里的每帧。因此：
 *      · 表必须是静态数组 —— 注册时 malloc 不保证可用
 *        （C 运行库可能尚未完全初始化）
 *      · 不能用动态分配
 * ========================================================================== */

#include "scut_watch.h"

#include <stdio.h>
#include <string.h>
#include <inttypes.h>   /* PRId64 / PRIu64 —— 跨运行库的 64 位整数格式宏 */

/* 容量：488 个变量足够任何教学级视觉算法。 */
#define SCUT_WATCH_MAX 488

static scut_watch_entry_t s_watch[SCUT_WATCH_MAX];
static int                s_count = 0;

/* --------------------------------------------------------------------------
 * 注册
 * -------------------------------------------------------------------------- */
void SCUT_Watch(const char *name, const void *p, scut_watch_type_t t,
                int count, int elem_size, int dim)
{
    int i;

    if (name == 0 || name[0] == '\0' || p == 0) {
        return;                                  /* 静默忽略非法注册 */
    }
    if (count <= 0)    { count     = 1; }
    if (elem_size <= 0){ elem_size = 1; }
    if (dim < 0)       { dim       = 0; }

    if (s_count >= SCUT_WATCH_MAX) {
        return;                                  /* 表满：丢弃而不是覆盖 */
    }

    /* 去重：同名保留第一个。
     * 用 O(n) 线性扫描而不是哈希——注册总量小（几十~几百），
     * 且只发生一次，不值得引入哈希表的复杂度与内存。 */
    for (i = 0; i < s_count; i++) {
        if (strcmp(s_watch[i].name, name) == 0) {
            return;
        }
    }

    s_watch[s_count].name = name;
    s_watch[s_count].p    = p;
    s_watch[s_count].t    = t;
    s_watch[s_count].n    = count;
    s_watch[s_count].es   = elem_size;
    s_watch[s_count].dim  = dim;
    s_count++;
}

int scut_watch_count(void)
{
    return s_count;
}

const scut_watch_entry_t *scut_watch_at(int index)
{
    if (index < 0 || index >= s_count) {
        return 0;
    }
    return &s_watch[index];
}

void scut_watch_reset(void)
{
    s_count = 0;
}

/* --------------------------------------------------------------------------
 * 读值并格式化
 *
 * ★ 为什么只输出【文本】而不把原始内存交给 UI：
 *   变量可能是 120x188 的图像缓冲（22560 字节）。把原始内存
 *   经 webview 消息通道传输会浪费带宽，且让前端承担类型解释责任。
 *   这里在 C 侧按类型渲染成人类可读文本，前端只负责显示。
 *
 * ★ 为什么要 max_values：
 *   一个 22560 元素的数组不可能全塞进 UI。调用方给出上限，
 *   通过 *truncated 告知前端「还有更多」。
 * -------------------------------------------------------------------------- */
int scut_watch_read(int index, char *buf, int buf_size,
                    int max_values, int *truncated)
{
    const scut_watch_entry_t *w;
    int used  = 0;      /* buf 中已用字节 */
    int shown = 0;      /* 已输出的元素个数 */
    int limit;
    int i;

    if (truncated != 0) {
        *truncated = 0;
    }
    if (buf == 0 || buf_size <= 0) {
        return 0;
    }
    buf[0] = '\0';

    w = scut_watch_at(index);
    if (w == 0) {
        return 0;
    }

    limit = (max_values > 0 && max_values < w->n) ? max_values : w->n;

    for (i = 0; i < limit; i++) {
        char  tmp[64];
        int   wrote;
        const char *cursor = (const char *)w->p + (size_t)i * (size_t)w->es;

        /* 结构体与指针不做解引用：
         *   · 结构体需要 DWARF 成员偏移才能逐字段解释
         *   · 指针解引用可能指向非法地址而崩溃
         * 只报告大小/地址。需要看字段时，建议在代码里把关心的
         * 字段单独存成标量变量（自动发现会一并列出）。 */
        switch (w->t) {
        case SCUT_T_I8:   wrote = snprintf(tmp, sizeof(tmp), "%d",  (int)(*(const signed char *)cursor)); break;
        case SCUT_T_U8:   wrote = snprintf(tmp, sizeof(tmp), "%u",  (unsigned)(*(const unsigned char *)cursor)); break;
        case SCUT_T_I16:  wrote = snprintf(tmp, sizeof(tmp), "%d",  (int)(*(const short *)cursor)); break;
        case SCUT_T_U16:  wrote = snprintf(tmp, sizeof(tmp), "%u",  (unsigned)(*(const unsigned short *)cursor)); break;
        case SCUT_T_I32:  wrote = snprintf(tmp, sizeof(tmp), "%d",  *(const int *)cursor); break;
        case SCUT_T_U32:  wrote = snprintf(tmp, sizeof(tmp), "%u",  *(const unsigned int *)cursor); break;
        /* ★ 64 位整数刻意【不用 %lld / %llu】：
         *   MinGW 默认链接的 msvcrt 是老式 CRT，它不认识 'll' 长度修饰符，
         *   gcc 会报 "unknown conversion type character 'l' in format"，
         *   运行期更是直接打印错值。这是跨工具链的经典坑。
         *   实测：clang(llvm-mingw, UCRT) 通过，gcc 8.1(msvcrt) 报警告。
         *
         *   因此改用 inttypes.h 的 PRId64/PRIu64 宏 —— 它会按当前
         *   运行库自动展开成正确的修饰符（msvcrt 下是 "I64d"）。
         *   scut_i64/scut_u64 已保证就是 64 位，所以这里安全。 */
        case SCUT_T_I64:  wrote = snprintf(tmp, sizeof(tmp), "%" PRId64, (scut_i64)(*(const scut_i64 *)cursor)); break;
        case SCUT_T_U64:  wrote = snprintf(tmp, sizeof(tmp), "%" PRIu64, (scut_u64)(*(const scut_u64 *)cursor)); break;
        case SCUT_T_F32:  wrote = snprintf(tmp, sizeof(tmp), "%.6g", (double)(*(const float *)cursor)); break;
        case SCUT_T_F64:  wrote = snprintf(tmp, sizeof(tmp), "%.6g", *(const double *)cursor); break;
        case SCUT_T_BOOL: wrote = snprintf(tmp, sizeof(tmp), "%s", (*(const unsigned char *)cursor) ? "true" : "false"); break;
        case SCUT_T_PTR:  wrote = snprintf(tmp, sizeof(tmp), "%p", *(void *const *)cursor); break;
        case SCUT_T_STR:  wrote = snprintf(tmp, sizeof(tmp), "%s", (*(char *const *)cursor) ? *(char *const *)cursor : "(null)"); break;
        case SCUT_T_ENUM: wrote = snprintf(tmp, sizeof(tmp), "%d", *(const int *)cursor); break;
        case SCUT_T_STRUCT:
        default:
            wrote = snprintf(tmp, sizeof(tmp), "<%dB>", w->es);
            break;
        }

        if (wrote < 0) {
            break;
        }

        /* 空间不足就停在这里，并标记截断（而不是写出半截数字）。 */
        if (used + wrote + 2 > buf_size) {
            if (truncated != 0) { *truncated = 1; }
            break;
        }

        if (i > 0) {
            buf[used++] = ' ';
        }
        memcpy(buf + used, tmp, (size_t)wrote);
        used += wrote;
        buf[used] = '\0';
        shown++;
    }

    if (shown < w->n && truncated != 0) {
        *truncated = 1;
    }
    return shown;
}
