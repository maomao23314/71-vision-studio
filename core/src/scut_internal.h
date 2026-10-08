/* ==========================================================================
 *  scut_internal.h —— 核心内部共享声明（★ 不属于公开 API）
 *  --------------------------------------------------------------------------
 *  ★ 为什么单独开一个内部头文件：
 *      阶段机、违规计数这类东西是「核心各模块之间」的协作细节，
 *      不应该出现在 scut_sdk.h 里给用户看。
 *      放在 src/ 下（而不是 include/）从物理上表明它不对外。
 *
 *  ★ 用什么阶段模型（本文件最重要的设计决策）
 *  ---------------------------------------------------------------------------
 *  用一个【枚举】表达当前阶段，而不是若干个布尔标志。
 *  原因：多个布尔会出现「同时处于两个阶段」的非法状态，
 *  而阶段机本质是严格线性的。枚举从类型上就排除了非法组合，
 *  这类 bug 在布尔方案里只能靠"记得同步改两处"来避免。
 * ========================================================================== */
#ifndef SCUT_INTERNAL_H
#define SCUT_INTERNAL_H

#include "scut_sdk.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 * 帧内阶段
 *
 * 顺序即调度顺序，见 scut_sched.c 的 run_one_frame()。
 * ★ 这个顺序是有语义的，不是随手排的：
 *      INIT → (每帧) PRE_FRAME → PROCESS → POST_FRAME → DRAW → REPORT
 *    input 访问器只在 PRE_FRAME / PROCESS 放行，
 *   log 只在 REPORT 放行 —— 两者都靠本枚举判定。
 * -------------------------------------------------------------------------- */
typedef enum {
    SCUT_PHASE_IDLE = 0,     /* 帧外（含 frame sink 期间） */
    SCUT_PHASE_INIT,
    SCUT_PHASE_PRE_FRAME,
    SCUT_PHASE_PROCESS,      /* ★ 唯一"正统"的图像处理阶段 */
    SCUT_PHASE_POST_FRAME,
    SCUT_PHASE_DRAW,         /* ★ 输入图像在此阶段被拒（防逃避计时） */
    SCUT_PHASE_REPORT
} scut_phase_t;

/* --- 阶段机（实现在 scut_input.c） --- */
void scut_input_set_phase(int phase);

/* --- 防呆违规计数 ---
 * 用户在设计外的阶段访问输入图像时递增。
 * 暴露出来是为了让 UI 能显示「违规 N 次」，
 * 从而把"把处理写进绘制里"这种行为变成可见的，而不是悄悄发生。 */
int  scut_input_violations(void);
void scut_input_reset_violations(void);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_INTERNAL_H */
