/* ==========================================================================
 *  scut_sched.h —— 调度模型
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 上手即用     → 用户 main 里一行 SCUT_RunUntilQuit() 即可
 *    · 代码松耦合   → 核心不拥有窗口；呈现后端只负责「要一帧/显示一帧」
 *    · 模拟单片机   → headless 与 GUI 走同一调度，行为一致
 *
 *  ★ 为什么必须有三种调度：
 *      旧环境的渲染是【事件驱动】的（Present 清掉 need_redraw，
 *      之后只有按键/缩放/热重载才重新触发，其余时间 Sleep 空转）。
 *      这导致「帧率」概念不成立，headless 与 GUI 无法共享核心。
 *      所以把调度抽出来，让三种模式共存：
 *          RunOnce      单步（调试单步、变量逐帧观察）
 *          RunFrames    批量（headless / CI / 压力测试）
 *          RunUntilQuit 交互（GUI，直到用户退出）
 * ========================================================================== */
#ifndef SCUT_SCHED_H
#define SCUT_SCHED_H

#include "scut_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- 运行配置 ---
 *
 * ★ 三个字段都【有运行期入口】（见下面的 setter）：
 *   只在结构体里放一个恒为 1 的字段，会让读代码的人以为"能关"，
 *   实际却没有任何办法关掉 —— 那是"半死的配置"，比没有更误导。
 *   所以能设的就必须能改：与 repeat 一致，log/draw 也各给一个 setter。 */
typedef struct {
    int  repeat;          /* 每帧重复调用 PROCESS 的次数（复杂度测试用） */
    int  log_enabled;     /* 是否允许 DRAW 阶段写日志（SCUT_Log） */
    int  draw_enabled;    /* 是否允许 DRAW 阶段绘制与合成 */
} scut_run_config_t;

/* 初始化核心。必须在任何 Run* 之前调用。 */
void scut_core_init(const scut_image_desc_t *desc, const scut_run_config_t *cfg);

/* 释放核心资源。 */
void scut_core_shutdown(void);

/* --- 三种调度 --- */

/* --- 测速支持（b<N> 命令用，运行期生效，不需要重启进程） ---
 * 抬高 repeat 后【下一帧】会以 N 次重复执行 PROCESS，
 * 报出的 process_us / cycles 即"每次的平均值"。 */
int  scut_sched_get_repeat(void);
void scut_sched_set_repeat(int n);

/* --- 日志 / 绘制的运行期开关（与 repeat 同一套语义） ---
 *
 * ★ 为什么需要它们：这两个字段原先只有 scut_bind_apply() 写死成 1，
 *   全树没有任何入口能改 —— 于是"关闭日志""关闭绘制"两条分支永远走不到。
 *   结构体里留着一个改不了的字段，比没有这个字段更误导，
 *   所以补齐 setter，让它名实相符。
 *
 * 用途：
 *   · 关日志：压测时避免日志缓冲被刷满
 *   · 关绘制：做"纯算法"基准测试，去掉覆盖层写入与合成的开销
 *
 * ★ 语义差别（别混）：
 *   scut_sched_set_draw_enabled(0) 关的是【绘制与合成本身】；
 *   而 scut_enable_draw_timing(0) 关的只是【对 DRAW 的计时】。
 *   前者影响画面，后者只影响 draw_us 这个读数。 */
void scut_sched_set_log_enabled(int enable);
void scut_sched_set_draw_enabled(int enable);

/* 跑一帧。返回 0 = 正常，非 0 = 请求退出。 */
int scut_run_once(void);

/* 跑 n 帧。返回实际跑的帧数。 */
int scut_run_frames(int n);

/* 跑到用户/后端请求退出。返回 0 = 正常退出。 */
int scut_run_until_quit(void);

/* 请求退出（任何角色回调里都可调用，也供呈现后端调用）。 */
void scut_request_quit(void);
int  scut_quit_requested(void);

/* --- 每帧的阶段回调（供呈现后端插入） ---
 * 核心不直接知道「窗口」或「Webview」的存在，只暴露这两个钩子。
 * 这是「核心不拥有窗口」原则的落地方式。 */
typedef void (*scut_frame_sink_fn)(void *user);

/* 在一帧的 PROCESS 之后、DRAW 之前被调用（用于推送图像） */
void scut_set_frame_sink(scut_frame_sink_fn fn, void *user);

/* --- 计时查询 --- */
typedef struct {
    double process_us;    /* ★ 仅 PROCESS 角色（用户算法）—— 核心指标 */
    double draw_us;       /* DRAW 角色：搬运结果图 + 画标注 + 打日志，不计入上面 */
    double frame_us;      /* 整帧（不含呈现后端自身的开销） */
    scut_u64 process_cycles; /* 处理器周期数（若可用）—— 跨机器可比 */
    int    cycles_valid;     /* 周期数是否可信（TSC 可用性） */
} scut_timing_t;

const scut_timing_t *scut_timing_get(void);

/* 开关 DRAW 阶段计时（计时本身有微小开销，做精细测试时可关） */
void scut_enable_draw_timing(int enable);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_SCHED_H */
