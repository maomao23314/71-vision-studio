/* ==========================================================================
 *  scut_log.h —— 日志接口
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机   → 日志是主机侧设施，车载可接到串口或直接留空
 *    · 上手即用     → 用法同 printf，零学习成本
 * ========================================================================== */
#ifndef SCUT_LOG_H
#define SCUT_LOG_H

#include "scut_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    SCUT_LOG_INFO = 0,
    SCUT_LOG_WARN,
    SCUT_LOG_ERROR
} scut_log_level_t;

/* 输出一行日志。仅在 REPORT 阶段有效（其余阶段调用会被忽略并记录）。 */
void SCUT_Log(scut_log_level_t level, const char *fmt, ...);

/* 清空日志缓冲。切换图片/重跑时环境会自动调用。 */
void SCUT_LogClear(void);

/* --- 核心内部使用：供呈现后端取出日志行 --- */
int         scut_log_line_count(void);
const char *scut_log_line_at(int index);
int         scut_log_enabled(void);
void        scut_log_set_enabled(int enabled);

/* --- 核心内部使用：阶段门控 ---
 * ★ 只有 REPORT 阶段允许写日志。
 *   在 PROCESS 阶段写日志会污染性能测量（printf 很慢），
 *   在 DRAW 阶段写会打乱绘制顺序。
 *   用门控从【机制】上阻止，而不是靠文档约定。 */
void scut_log_begin_report_phase(void);
void scut_log_end_report_phase(void);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_LOG_H */
