/* ==========================================================================
 *  scut_log.h —— 日志接口
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机   → 日志是主机侧设施，车载可接到串口或直接留空
 *    · 上手即用     → 用法同 printf，零学习成本
 *    · 代码松耦合   → 只存文本行，呈现层决定怎么显示
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

/* 输出一行日志。
 *
 * ★ 只在「绘制/后处理」阶段有效（其余阶段调用会被静默忽略）。
 *   原因：PROCESS 阶段是被计时的那一段，在里面 printf 会把格式化与 IO
 *   的开销算进算法耗时 —— 而这个数字正是本环境存在的核心意义。
 *   这条限制由机制保证，不靠文档约定。
 *
 * ★ 形式与 printf 完全一致（含 %d/%f/%s 与可变参数），零学习成本。 */
void SCUT_Log(scut_log_level_t level, const char *fmt, ...);

/* 清空日志缓冲。切换图片/重跑时环境会自动调用。 */
void SCUT_LogClear(void);

/* --- 核心内部使用：供呈现后端取出日志行 --- */
int         scut_log_line_count(void);
const char *scut_log_line_at(int index);
int         scut_log_enabled(void);
void        scut_log_set_enabled(int enabled);

/* --- 核心内部使用：阶段门控 ---
 * 只有「绘制/后处理」阶段允许写日志，与产生日志的钩子同一阶段。
 * 由调度器在进入/离开 DRAW 阶段时调用。 */
void scut_log_begin_draw_phase(void);
void scut_log_end_draw_phase(void);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_LOG_H */
