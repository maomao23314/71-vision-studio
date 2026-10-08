/* ==========================================================================
 *  scut_log.c —— 日志缓冲实现
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机   → 日志是主机侧设施；车载工程给空实现即可
 *    · 上手即用     → 用法同 printf，零学习成本
 *    · 代码松耦合   → 只存文本行，呈现层决定怎么显示
 *
 *  ★ 为什么日志要在 C 侧缓冲、而不是直接 printf：
 *      printf 会污染 stdout，而 stdout 是给 VsCode 插件用的
 *      JSON 协议通道。必须把「给机器看的协议」与「给人看的日志」
 *      分开，否则插件解析 JSON 会失败。
 *      所以这里缓冲，由呈现后端决定送往哪里（面板 / 文件 / 终端）。
 * ========================================================================== */

#include "scut_log.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

/* 环形缓冲：行数固定，避免动态分配。
 * 视觉算法调试日志不会超过几百行，256 行足够；
 * 超出时覆盖最旧的（环形），保证不会因为日志爆掉内存。 */
#define SCUT_LOG_MAX_LINES 256
#define SCUT_LOG_LINE_LEN  192

static char s_lines[SCUT_LOG_MAX_LINES][SCUT_LOG_LINE_LEN];
static int  s_head   = 0;    /* 下一个写入位置 */
static int  s_count  = 0;    /* 当前有效行数（<= MAX） */
static int  s_enabled = 1;

/* ★ 阶段门控：只有「绘制/后处理」阶段允许写日志。
 *   在 PROCESS 阶段写日志会污染性能测量（printf 很慢）——
 *   而 process_us 正是本环境的核心指标。这里用门控从机制上阻止，
 *   而不是靠文档约定。
 *   门控与产生日志的钩子（post）是同一个阶段，不会自相矛盾。 */
static int  s_phase_allows_log = 0;

void scut_log_set_enabled(int enabled)
{
    s_enabled = enabled ? 1 : 0;
}

int scut_log_enabled(void)
{
    return s_enabled;
}

/* 供调度器在进入/离开 DRAW 阶段时调用（见 scut_sched.c）。 */
void scut_log_begin_draw_phase(void) { s_phase_allows_log = 1; }
void scut_log_end_draw_phase(void)   { s_phase_allows_log = 0; }

void SCUT_LogClear(void)
{
    s_head  = 0;
    s_count = 0;
}

void SCUT_Log(scut_log_level_t level, const char *fmt, ...)
{
    char    buf[SCUT_LOG_LINE_LEN];
    const char *tag;
    va_list ap;
    int     n;

    if (!s_enabled || !s_phase_allows_log || fmt == 0) {
        return;
    }

    switch (level) {
    case SCUT_LOG_WARN:  tag = "[warn] ";  break;
    case SCUT_LOG_ERROR: tag = "[error] "; break;
    case SCUT_LOG_INFO:
    default:             tag = "";         break;
    }

    va_list ap2;
    /* 先格式化正文，再把 tag 拼到前面。
     * 分两步是因为 vsnprintf 不支持在格式串前缀里插入可变 tag。 */
    va_start(ap, fmt);
    va_copy(ap2, ap);
    n = vsnprintf(buf, sizeof(buf), fmt, ap2);
    va_end(ap2);
    va_end(ap);

    if (n < 0) {
        return;                                  /* 格式化失败：丢弃 */
    }
    /* vsnprintf 返回「本该写入的长度」，超长时说明被截断了。
     * 这里显式把最后一个字符替换成终止符，保证永远是合法 C 字符串
     * （老式 msvcrt 在截断时不写 '\0'，是个著名的坑）。 */
    if (n >= (int)sizeof(buf)) {
        buf[sizeof(buf) - 1] = '\0';
    }

    {
        char line[SCUT_LOG_LINE_LEN];
        snprintf(line, sizeof(line), "%s%s", tag, buf);
        line[sizeof(line) - 1] = '\0';
        memcpy(s_lines[s_head], line, sizeof(line));
    }
    s_lines[s_head][SCUT_LOG_LINE_LEN - 1] = '\0';

    s_head = (s_head + 1) % SCUT_LOG_MAX_LINES;
    if (s_count < SCUT_LOG_MAX_LINES) {
        s_count++;
    }
}

int scut_log_line_count(void)
{
    return s_count;
}

const char *scut_log_line_at(int index)
{
    int pos;

    if (index < 0 || index >= s_count) {
        return 0;
    }
    /* 环形缓冲里最旧的一行位置：
     * 如果还没绕圈，从 0 开始；绕圈后从 head 开始。 */
    if (s_count < SCUT_LOG_MAX_LINES) {
        pos = index;
    } else {
        pos = (s_head + index) % SCUT_LOG_MAX_LINES;
    }
    return s_lines[pos];
}
