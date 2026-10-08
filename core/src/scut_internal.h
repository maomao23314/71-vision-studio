/* ==========================================================================
 *  scut_internal.h —— 核心内部共享声明（★ 不属于公开 API）
 *  --------------------------------------------------------------------------
 *  ★ 为什么单独开一个内部头文件：
 *      阶段机、违规计数这类东西是「核心各模块之间」的协作细节，
 *      不应该出现在 scut_sdk.h 里给用户看。
 *      放在 src/ 下（而不是 include/）从物理上表明它不对外。
 *
 *  ★ 用什么阶段模型
 *      用一个【枚举】表达当前阶段，而不是若干个布尔标志：
 *      布尔方案允许「同时处于两个阶段」这种非法状态，
 *      而阶段机本质是严格线性的。枚举从类型上就排除了非法组合。
 *
 *  ★ 为什么只有三个阶段（相对旧实现的重要简化）
 *      旧实现有 IDLE/INIT/PRE_FRAME/PROCESS/POST_FRAME/DRAW/REPORT 七个，
 *      但其中四个没有任何实际作用，反而制造了两处真实缺陷：
 *        · PRE_FRAME / POST_FRAME 从未被任何用户可见的钩子用到；
 *        · REPORT 在「合成覆盖层」之后才跑，于是注册到 REPORT 的绘制
 *          会落到下一帧的画面上（标注慢一帧 + 最后一帧丢失）。
 *      现在阶段与公开角色一一对应，顺序由调度器固定，不再有歧义。
 * ========================================================================== */
#ifndef SCUT_INTERNAL_H
#define SCUT_INTERNAL_H

#include "scut_sdk.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 *  帧内阶段
 *
 *  顺序即调度顺序，见 scut_sched.c 的 run_one_frame()：
 *      （开机一次）INIT
 *      每帧： PROCESS → DRAW → [合成覆盖层] → [清空覆盖层] → [呈现]
 *
 *  ★ 这个顺序是有语义的，不是随手排的：
 *      · input 访问器只在 PROCESS 放行 —— 绘制阶段读输入图做图像处理
 *        会把耗时藏进不计时的区域，让性能数据失去意义；
 *      · log 门控只在 DRAW 放行 —— 与调用日志的 post 钩子同一阶段；
 *      · DRAW 必须在合成之前 —— 否则本帧画的标注落到下一帧。
 * -------------------------------------------------------------------------- */
typedef enum {
    SCUT_PHASE_IDLE = 0,     /* 帧外（含 frame sink 期间） */
    SCUT_PHASE_PROCESS,      /* ★ 唯一"正统"的图像处理阶段，计时 */
    SCUT_PHASE_DRAW          /* 绘制标注 + 打日志，不计时，在合成之前 */
} scut_phase_t;

/* --- 阶段机（实现在 scut_input.c） --- */
void scut_input_set_phase(int phase);
scut_phase_t scut_input_get_phase(void);

/* --- 防呆违规计数 ---
 * 用户在设计外的阶段访问输入图像时递增。
 * 目前只用于 stderr 的一次性提示（见 scut_input.c）。 */
int  scut_input_violations(void);
void scut_input_reset_violations(void);

/* --- 输出图像的写入门控 ---
 * 与输入图对称：只有在 DRAW 阶段（呈现接线所在处）才允许写输出图。
 * 算法阶段直接写输出图属于误用 —— 正确做法是写自己的结果数组，
 * 由接线单元在 DRAW 阶段搬运。 */
int  scut_output_write_allowed(void);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_INTERNAL_H */
