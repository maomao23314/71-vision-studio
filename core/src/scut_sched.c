/* ==========================================================================
 *  scut_sched.c —— 调度模型实现（RunOnce / RunFrames / RunUntilQuit + 计时）
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 上手即用     → 用户 main 里一行 scut_run_until_quit() 即可
 *    · 代码松耦合   → 核心不拥有窗口，只暴露一个 frame sink 钩子
 *    · 模拟单片机   → headless 与 GUI 走同一调度，行为完全一致
 *
 *  ★ 为什么计时口径要写死在代码里（本文件最重要的设计约束）：
 *      性能数据只有在"两次测量口径一致"时才能比较。同一个人换个后端、
 *      换台机器，如果口径变了，历史数据全部作废。所以本文件把
 *      「什么计入 process_us、什么不计入」用代码固定下来，
 *      而不是留给调用方或文档去约定（旧实现里"文档说含显示、代码不含显示"
 *      造成过一次口径事故）。
 *
 *      PROCESS(取 repeat 次平均)  → process_us   ★ 算法性能的唯一指标
 *      DRAW（搬运结果图 + 画标注 + 打日志）→ draw_us（独立，不计入上面）
 *      frame sink（呈现后端抓帧）  → 从 frame_us 里扣除
 *
 *  ★ 帧内顺序（顺序本身是契约，不能重排）：
 *      PROCESS → DRAW → 合成覆盖层 → 清空覆盖层 → frame sink
 *
 *  ★★ DRAW 必须在「合成覆盖层」之前（历史缺陷的修复）★★
 *      绘制写进【覆盖层】，呈现后端抓帧读的是【输出图】，两者必须被
 *      合到一起才看得见。所以 DRAW 之后由本文件把覆盖层合成进灰度图，
 *      再让 sink 抓帧。
 *      旧实现把绘制注册成「REPORT」角色，而 REPORT 排在合成【之后】——
 *      后果是每帧画的标注都落到【下一帧】的画面上，且最后一帧的标注永远
 *      丢失。不报错、不崩溃，只是画面慢一帧，属于最难查的一类静默缺陷。
 *      现在绘制只有一个阶段（DRAW），调度器保证它在合成之前跑完。
 *
 *  ★ DRAW 阶段的收尾（合成 + 清屏）由本文件负责，见 run_one_frame 的第 4 段。
 *      这件事放在调度器而不是各个后端，是为了让每个后端都"免费"拿到
 *      正确的绘制：后端一旦忘记合成，用户的标注就会全部静默消失。
 *
 *  ★ 线程模型：本文件不引入任何锁。调度是单线程顺序推进的，
 *    scut_request_quit() 的语义就是"让同一个线程的循环退出"，
 *    它天然可以从任意角色回调里调用（回调本身就跑在调度线程上）。
 * ========================================================================== */
#include "scut_sched.h"
#include "scut_registry.h"
#include "scut_log.h"

/* ★ 这两个头是「DRAW 之后把 overlay 合成进 gray」所必需的。
 *   合成放在调度器而不是后端，是刻意的职责划分（理由见 run_one_frame）。 */
#include "scut_frame.h"   /* scut_composite_overlay */
#include "scut_draw.h"    /* scut_draw_get_target / scut_draw_clear_overlay */

/* ★ 内部头放在 src/ 下：阶段机与违规计数是核心各模块之间的协作细节，
 *   不属于给用户看的公开 API。物理位置本身就表达了这层边界。 */
#include "scut_internal.h"

#include <stddef.h>
#include <string.h>

/* --------------------------------------------------------------------------
 *  平台抽象：计时源
 *
 *  ★ 为什么必须分两条路：
 *      Windows 上 QueryPerformanceCounter 是唯一可信的高精度墙钟源
 *      （clock() 在 Windows 上只有 ~1ms 粒度，做算法计时完全不够用）。
 *      但核心库要保持"能编到别的平台"，所以非 Windows 走 clock() 兜底，
 *      并且【明确把 cycles_valid 置 0】——宁可不报精度，也不报假精度。
 * -------------------------------------------------------------------------- */
#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN   /* 不拉进 winsock 等无关头，缩短编译时间 */
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX              /* 防止 windows.h 定义 min/max 宏污染用户代码 */
#  endif
#  include <windows.h>
#else
#  include <time.h>
#endif

/* --------------------------------------------------------------------------
 *  TSC（__rdtsc）可用性
 *
 *  ★ 三道门都得过，缺一不可：
 *    1) 编译器必须认识 __rdtsc（<intrin.h>）—— 题目要求的编译器门。
 *    2) 必须是 Windows —— 因为周期数的【标定】要拿 QPC 当基准，
 *       非 Windows 路径上没有 QPC，标定不了就不该报周期数。
 *    3) 必须是 x86/x64 —— ARM 上 <intrin.h> 根本没有 __rdtsc，
 *       只加编译器门会在 ARM 上直接编译失败。
 *
 *  ★ 过了预编译门不代表能报数：还要过【运行期标定】。见 scut_tsc_calibrate()。
 * -------------------------------------------------------------------------- */
#if (defined(_MSC_VER) || defined(__GNUC__)) && defined(_WIN32) && \
    (defined(_M_X64) || defined(_M_IX86) || defined(__x86_64__) || defined(__i386__))
#  define SCUT_TSC_ENABLED 1
#  include <intrin.h>
#endif

/* --------------------------------------------------------------------------
 *  运行返回值
 *
 *  头文件只承诺"0 = 正常，非 0 = 退出"，不暴露具体数值。
 *  这里显式区分两种非 0，是为了让 RunUntilQuit 能回答
 *  "用户主动退出（正常）"还是"描述符非法（错误）"——
 *  头文件写明它返回 0 = 正常退出，两种情况不能混为一谈。
 * -------------------------------------------------------------------------- */
#define SCUT_RUN_OK       0   /* 正常 */
#define SCUT_RUN_QUIT     1   /* 退出请求导致的结束，属于正常路径 */
#define SCUT_RUN_INVALID  2   /* 未初始化 / 描述符非法，属于错误 */

/* TSC 标定的采样时长。20ms 足够让 QPC 的相对误差降到可忽略，
 * 又不至于让程序启动变慢（人眼可感的阈值大约在 100ms 以上）。 */
#define SCUT_TSC_CALIBRATE_US 20000.0

/* 标定出的主频合理性区间（周期/微秒），等价于 1MHz ~ 10GHz。
 * 超出这个范围说明测到的两个计数器之间发生了诡异的事
 * （被抢占几十毫秒、TSC 未同步、QPC 异常），此时必须判定标定失败。 */
#define SCUT_CYCLES_PER_US_MIN 1.0
#define SCUT_CYCLES_PER_US_MAX 10000000.0

/* --------------------------------------------------------------------------
 *  文件级状态
 *
 *  全部是"进程生命周期内的会话状态"，没有堆分配、没有锁。
 *  未初始化时它们全为 0，因此"没初始化就调用 RunOnce"是安全的。
 * -------------------------------------------------------------------------- */
static scut_image_desc_t  s_desc;              /* 描述符的值拷贝 */
static scut_run_config_t  s_cfg;               /* 配置的值拷贝 */
static int                s_initialized;       /* 是否调用过 scut_core_init */
static int                s_init_ran;          /* INIT 回调是否已执行过（保证"恰好一次"） */
static int                s_quit;              /* 退出请求标志（见 scut_request_quit） */
static scut_frame_sink_fn s_sink;              /* 呈现后端抓帧钩子，NULL = headless */
static void              *s_sink_user;         /* 钩子的透传参数 */
static int                s_draw_timing = 1;   /* 是否测量 DRAW（默认开） */
static int                s_timing_ready;      /* 计时源是否可用（QPF 成功） */
static double             s_us_per_tick;       /* 1 个计数单位 = 多少微秒 */
static int                s_cycles_valid;      /* TSC 标定是否成功 */
static scut_timing_t      s_timing;            /* 最近一帧的计时结果 */

/* 描述符非法时的原因。用【静态字面量】而不是缓冲区：
 *   - 写入发生在 init 里，读取可能发生在很后面的 RunOnce 里，
 *     生命周期必须覆盖整个进程；
 *   - 它同时就是"描述符是否合法"的唯一判据（NULL == 合法），
 *     这样"记录错误"这件事不会变成一段没人读的死状态。
 * 将来若要在头文件里加 getter，直接返回这个指针即可。 */
static const char *s_error;

/* --------------------------------------------------------------------------
 *  低层计时
 * -------------------------------------------------------------------------- */

/* 读一次原始计数（不做任何解释，单位由 s_us_per_tick 决定）。 */
static scut_u64 scut_tick_now(void)
{
#ifdef _WIN32
    LARGE_INTEGER li;
    /* 先归零：QPC 理论上不会失败，但失败时读未初始化内存是 UB，
     * 清零的代价是零，属于纯赚的防御。 */
    li.QuadPart = 0;
    (void)QueryPerformanceCounter(&li);
    return (scut_u64)li.QuadPart;
#else
    /* 兜底路径：clock() 给出的是【进程 CPU 时间】而不是墙钟时间。
     * 单线程跑满一帧时两者接近，但这确实是近似——
     * 因此这条路径下 cycles_valid 恒为 0，不给任何"看起来精确"的数字。 */
    return (scut_u64)clock();
#endif
}

/* 两个计数之间的微秒数（b - a）。
 * b < a 只可能来自计数器回绕或异常，此时返回 0：
 * 报一个负的时间比报 0 更危险，因为它会污染后续所有统计。 */
static double scut_tick_delta_us(scut_u64 a, scut_u64 b)
{
    if (!s_timing_ready || b < a) {
        return 0.0;
    }
    return (double)(b - a) * s_us_per_tick;
}

/* 读 TSC。未启用时恒返回 0 —— 让调用点的代码无需 #ifdef，
 * 同时 0 与 0 比较必然不产生 "cb > ca"，周期累加自然为 0。 */
static scut_u64 scut_tsc_now(void)
{
#ifdef SCUT_TSC_ENABLED
    return (scut_u64)__rdtsc();
#else
    return 0;
#endif
}

/* --------------------------------------------------------------------------
 *  TSC 标定
 *
 *  ★ 为什么必须"标定"而不能直接相信 __rdtsc：
 *      __rdtsc 只是一个递增计数器，它不承诺单位，也不承诺与墙钟同步。
 *      虚拟机上 TSC 可能不递增、多核间可能不同步、
 *      某些平台会随频率调节而变速。用它算出的周期数如果和真实耗时
 *      脱钩，就是一个【看起来很专业但完全错误】的数字。
 *      错的周期数比没有周期数更糟——用户会照着它做优化决策。
 *
 *  ★ 为什么标定结果【不保存成常驻比值】：
 *      头文件的 scut_timing_t 里只有 process_cycles，没有任何字段能消费
 *      "周期/微秒"这个比值。存一个没人读的全局量违反本项目的
 *      "无多余全局可变状态"约束，而且会随编译器产生 set-but-unused 警告。
 *      所以标定的产物只有两个：一个"能不能信"的结论（s_cycles_valid），
 *      以及一次合理性检查。周期数本身由 __rdtsc 差值直接得到，不需要换算。
 * -------------------------------------------------------------------------- */
#ifdef SCUT_TSC_ENABLED
static int scut_tsc_calibrate(void)
{
    scut_u64 c0;
    scut_u64 c1;
    scut_u64 t0;
    scut_u64 t1;
    double   elapsed_us;
    double   cycles_per_us;

    if (!s_timing_ready) {
        return 0;   /* 没有可信墙钟基准，谈不上标定 */
    }

    c0 = scut_tsc_now();
    t0 = scut_tick_now();
    do {
        t1 = scut_tick_now();
        elapsed_us = scut_tick_delta_us(t0, t1);
    } while (elapsed_us < SCUT_TSC_CALIBRATE_US);
    c1 = scut_tsc_now();

    /* 单调性：TSC 必须真的在往前走。 */
    if (c1 <= c0) {
        return 0;
    }
    if (elapsed_us <= 0.0) {
        return 0;
    }

    cycles_per_us = (double)(c1 - c0) / elapsed_us;
    if (!(cycles_per_us >= SCUT_CYCLES_PER_US_MIN &&
          cycles_per_us <= SCUT_CYCLES_PER_US_MAX)) {
        return 0;   /* 主频荒谬 => 两个计数器不同源或期间发生了长抢占 */
    }
    return 1;
}
#endif

/* 初始化计时源与周期计数。可重复调用（每次 init 都重新标定：
 * 进程可能被迁移到不同频率的核心上，旧标定未必仍然成立）。 */
static void scut_timing_init(void)
{
    s_timing_ready  = 0;
    s_cycles_valid  = 0;
    s_us_per_tick   = 0.0;

#ifdef _WIN32
    {
        LARGE_INTEGER freq;
        freq.QuadPart = 0;
        if (QueryPerformanceFrequency(&freq) && freq.QuadPart > 0) {
            s_us_per_tick  = 1000000.0 / (double)freq.QuadPart;
            s_timing_ready = 1;
        }
    }
#else
    /* CLOCKS_PER_SEC 在 POSIX 上是 1000000，在 Windows CRT 上是 1000。
     * 这条兜底路径只在外平台编译，粒度问题已在上面的注释里说明。 */
    s_us_per_tick  = 1000000.0 / (double)CLOCKS_PER_SEC;
    s_timing_ready = 1;
#endif

#ifdef SCUT_TSC_ENABLED
    if (scut_tsc_calibrate()) {
        s_cycles_valid = 1;
    }
#endif

    /* 计时不可用时把整块结果清零：让"没有数据"表现为 0，
     * 而不是留下上一次运行的残值被误读成本次测量结果。 */
    if (!s_timing_ready) {
        memset(&s_timing, 0, sizeof(s_timing));
    }
}

/* --------------------------------------------------------------------------
 *  一帧的执行序列
 *
 *  ★★ 顺序是契约，不要重排 ★★
 *
 *      PROCESS  → 计时（process_us）    ★ 图像处理主体，重复 repeat 次
 *      DRAW     → 独立计时（draw_us）   接线单元：搬运结果图 + 画标注 + 打日志
 *      合成      → 覆盖层 → 输出图
 *      清空      → 覆盖层复位
 *      frame sink → 不计入处理时间      呈现后端抓走这一帧
 *
 *  ★★★ 绘图与日志【刻意不计入】处理时间 ★★★
 *      车载程序上没有"画点给屏幕看"这件事：CH32 上既没有屏幕也没有日志文件，
 *      SCUT_Draw* / SCUT_Log 在移植层里就是空实现。
 *      把它算进 process_us，等于拿"主机侧调试设施"的耗时去冒充"车上算法"的
 *      耗时——性能数据会直接失真。而且是最坏的那种失真：主机上看起来变慢，
 *      车上根本没有这段开销，于是用户会去优化一段不存在的代码。
 *
 *  ★★ 为什么 DRAW 必须在「合成」之前（历史缺陷的修复）★★
 *      旧实现把「绘制」注册为 REPORT 角色，而 REPORT 排在合成【之后】。
 *      后果：任何在 post 钩子里画的标注，都落到【下一帧】的画面上，
 *      本帧什么都没有；并且最后一帧的标注永远丢失。
 *      它不报错、不崩溃，只是画面慢一帧 —— 属于最难查的一类静默缺陷。
 *      现在绘制只有一个阶段（DRAW），且调度器保证它在合成之前跑完。
 *
 *  ★ 日志门控与 DRAW 同一阶段：
 *      日志由 post 钩子产生，post 钩子在 DRAW 阶段执行，
 *      所以门控必须与它一致。旧实现把门控绑在 REPORT 上，而 REPORT 与
 *      产生日志的钩子【不是同一个阶段】，属于自相矛盾的设计。
 *
 *  ★ frame sink 放在合成【之后】：
 *      后端读的是输出图，标注是在合成时才进入它的。
 *      若 sink 排在合成之前，用户看到的图永远不含标注 —— 且不报任何错。
 *
 *  ★ frame_us 用"整帧跨度 减去 sink 耗时"来算：
 *      用跨度相减而不是把各阶段相加，可以顺带把核心自身的调度开销
 *      （注册表遍历、循环、时间读数）也如实算进整帧时间；
 *      而 sink 属于呈现后端，必须扣掉，否则后端的画图时间会污染帧率读数。
 *
 *  ★ 帧内请求退出时不提前返回：
 *      即使 PROCESS 里调用了 scut_request_quit()，也要把 DRAW / 合成 /
 *      sink 走完。否则呈现后端会漏掉最后一帧，
 *      用户看到的现象是"点了退出，画面停在上一帧"。
 * -------------------------------------------------------------------------- */
static void run_one_frame(void)
{
    scut_u64 frame_begin;
    scut_u64 frame_end;
    scut_u64 t0;
    scut_u64 t1;
    double   draw_us         = 0.0;
    double   process_total_us = 0.0;   /* repeat 次 PROCESS 的【总和】 */
    double   process_avg_us;           /* 除以 repeat 得到的每次平均 */
    double   frame_us;
    scut_u64 process_total_cycles = 0;
    int      repeat;
    int      r;
    /* 用于「DRAW 之后把 overlay 合成进 gray」——见下方说明。
     * 局部变量刻意初始化为 NULL/0：即便某条路径没有赋值，
     * 合成函数也会因参数非法而安全空操作，不会误写随机地址。 */
    scut_u8  *cmp_gray    = NULL;
    scut_u32 *cmp_overlay = NULL;
    int       cmp_w       = 0;
    int       cmp_h       = 0;

    /* 防御：理论上 init 已把 repeat 夹到 >=1，但 shutdown 后可能归零，
     * 而这里要做除数。多一次判断换掉一个除零崩溃，非常划算。 */
    repeat = (s_cfg.repeat >= 1) ? s_cfg.repeat : 1;

    frame_begin = scut_tick_now();

    /* 新的一帧：清掉"算法是否直接写过输出图"的记账。
     * ★ 必须在 PROCESS 之前清 —— 这一帧的 PROCESS 里如果调用了
     *   SCUT_OutImageSet，下面第 2b 步就会据此跳过"铺默认底图"。
     *   放在帧开头（而不是 PROCESS 之后）是为了让"每帧恰好清一次"
     *   这件事与其它每帧状态一样，有一个明确的、单一的位置。 */
    scut_draw_clear_output_written();

    /* --- 1. PROCESS（重复 repeat 次） ---
     * 复杂度测试时把 repeat 调大，观察 process_us 是否随规模线性增长。
     * 因此这里报的是【每次调用的平均值】：repeat 变大时这个数字应当
     * 基本不变；如果它跟着变大，说明测到的是"系统噪声"而不是算法复杂度。 */
    scut_input_set_phase(SCUT_PHASE_PROCESS);
    for (r = 0; r < repeat; r++) {
        scut_u64 c0;
        scut_u64 c1;

        t0 = scut_tick_now();
        c0 = scut_tsc_now();
        scut_registry_invoke(SCUT_ROLE_PROCESS);
        c1 = scut_tsc_now();
        t1 = scut_tick_now();

        process_total_us += scut_tick_delta_us(t0, t1);
        if (s_cycles_valid && c1 > c0) {
            process_total_cycles += (c1 - c0);
        }
    }
    process_avg_us = process_total_us / (double)repeat;

    /* --- 2. 先发布算法侧计时 ---
     *
     * ★ 先把 process_us 写进 s_timing，再继续往下走：
     *   这样 BACKEND 在 sink 内部调用 scut_timing_get() 拿到的是【本帧】数据，
     *   而不是上一帧的残值（先发布、后回调，消除"慢一拍"）。
     *   draw_us 此刻尚未发生，所以不在这里写。 */
    s_timing.process_us     = process_avg_us;
    s_timing.process_cycles = s_cycles_valid
                            ? (process_total_cycles / (scut_u64)repeat)
                            : 0;
    s_timing.cycles_valid   = s_cycles_valid;

    /* --- 2b. 默认底图：输入图 → 输出图（不计入 process_us） ---
     *
     * ★ 位置同样有语义：必须在 PROCESS 之后（此时输入图已由后端填好）、
     *   在 DRAW 之前（DRAW 里若配了结果图数组会覆盖它，覆盖层再叠上去）。
     *   这一拷贝不受 --repeat 影响 —— 它是"呈现"的事，不是算法的事。
     *
     * ★★ 但若算法【本帧已经自己写过输出图】，就必须跳过这一步 ★★
     *   scut_sdk.h 把 SCUT_OutImageSet / SetRGB 宣传为"算法直接产出显示图"
     *   的路径。可那一铺默认底图是【全量】覆盖 —— 会把算法刚画的像素
     *   整幅冲掉，用户看到的是"写了 OutImageSet 却还是原始灰度图"，
     *   不报错、不崩溃，只是他写的东西没了。
     *   所以这里改为：本帧有人写过就不铺，没人写才铺（保持默认行为）。
     *
     *   ★ 为什么这样判断是安全的：标志只由 SCUT_OutImageSet / SetRGB
     *     的【成功写入】置位，越界调用不算。没配 outputArray 且没调
     *     OutImageSet 的最常见路径 → 标志为 0 → 行为与改动前完全相同。
     *     配了 outputArray 的路径 → 算法通常不调 OutImageSet，
     *     标志为 0 → 仍铺底图，随后 glue 的 SCUT_EnvCopyOutput 照旧覆盖它，
     *     语义也不变。 */
    if (!scut_draw_output_written()) {
        scut_env_seed_output_from_input();
    }

    /* --- 3. DRAW（独立计时，绝不并入 process_us） ---
     *
     * draw_enabled == 0 时整个 DRAW 阶段不执行：配置里写的
     * "是否允许 DRAW 阶段绘制"只有核心能兑现（核心是 cfg 的唯一消费者），
     * 若不在这里生效，这个字段就是一段死配置。
     * 关闭时 draw_us 归 0 而不是保留上次的值——避免读到陈旧数据。
     *
     * ★ 这里把阶段设为 DRAW 之后，SCUT_GetInputImage() 会返回 NULL
     *   并记一次违规。这是「防止把图像处理写进绘制里逃避计时」的
     *   机制性保障，而不是文档约定。
     *
     * ★ 日志门控与 DRAW 同阶段开启：
     *   产生日志的 post 钩子就在本阶段执行，门控必须与它一致。 */
    scut_input_set_phase(SCUT_PHASE_DRAW);
    if (s_cfg.log_enabled) {
        scut_log_begin_draw_phase();
    }
    if (s_cfg.draw_enabled) {
        if (s_draw_timing) {
            t0 = scut_tick_now();
            scut_registry_invoke(SCUT_ROLE_DRAW);
            t1 = scut_tick_now();
            draw_us = scut_tick_delta_us(t0, t1);
        } else {
            /* 精细测试时关掉计时：QPC 调用本身也是开销，
             * 会混进相邻阶段的测量里。 */
            scut_registry_invoke(SCUT_ROLE_DRAW);
        }
    }
    if (s_cfg.log_enabled) {
        scut_log_end_draw_phase();
    }

    if (s_cfg.draw_enabled) {
        /* --- 4. DRAW 收尾：合成 overlay → gray，然后清空 overlay ---
         *
         * ★★ 顺序是本块的全部要点：先【合成】，再【清空】。两者都不能省 ★★
         *      · 只清空不合成 → 本帧画的东西直接被抹掉，标注永远不出现；
         *      · 只合成不清空 → 标注跨帧累积，第 N 帧会带着前 N-1 帧的残影，
         *        表现为"画面越来越乱"，且没有任何报错。
         *      两种都是【静默】的：不崩溃、不报错，只是画面不对。
         *      所以这里的顺序必须靠代码固定，而不是靠调用方记得。
         *
         * ★ 为什么合成必须由【调度器】做，而不是交给各个呈现后端：
         *      后端抓帧读的是输出图，而标注画在覆盖层上，
         *      两者必须被合到一起才看得见。如果这件事由后端负责，
         *      那么每个后端都得自己记得做一遍 —— 只要有一个后端忘了，
         *      用户的标注就在那个后端上【全部静默消失】。
         *      旧环境正是栽在这里：绘制写进 EasyX 的 DIB，换成 headless 后
         *      标注凭空不见。把合成放进调度器，则所有后端都【免费】获得
         *      正确的绘制，新增后端时无需知道覆盖层的存在。
         *
         * ★ 绘制目标通过 scut_draw_get_target() 取回，而不是各自读模块内部
         *   状态：调度器并不知道绘制模块当前绑定了哪一对缓冲，只有绘制模块
         *   自己知道。若这里猜错，合成的就是一张永远为空的覆盖层 ——
         *   不报错、不崩溃，标注全部不见。让绘制模块把它交出来，
         *   这类错误在接口形状上就无从发生。 */
        scut_draw_get_target(&cmp_gray, &cmp_overlay, &cmp_w, &cmp_h);
        if (cmp_gray != NULL && cmp_overlay != NULL &&
            cmp_w > 0 && cmp_h > 0) {
            /* 目标步长传 w*3：输出图是 RGB 三通道，每像素 3 字节，
         * 所以行步长（字节）= 宽度 × 3。
         * ★ 这里曾传 cmp_w，那是灰度输出图时代的写法。
         *   少传的那个 3 不会被任何地方检查到 —— 合成函数的
         *   「dst_stride < w*3 则直接返回」会让它【整帧什么都不做】，
         *   于是画面是正常的底图、标注全部消失、不报任何错。
         *   改 RGB 时这行必须一起改，否则颜色永远出不来。 */
            scut_composite_overlay(cmp_gray, cmp_w * 3, cmp_overlay, cmp_w, cmp_h);
        }
        /* ★ 合成【之后】才清空：清空了本帧的绘制就没了。 */
        scut_draw_clear_overlay();
    }

    /* --- 4. 汇总本帧计时（★ 必须在 sink 之前发布） ---
     *
     * ★ frame_us 的定义是「整帧，不含呈现后端的开销」。
     *   实现方式是【在调用 sink 之前读一次表】—— 此时已经跑完了
     *   全部算法与绘制阶段，而呈现还没开始，所以这个跨度恰好就是定义。
     *
     * ★ 为什么不再用「整帧跨度 减去 sink 耗时」那种写法：
     *   那要求先跑 sink 再相减，于是 s_timing 只能在 sink【之后】填 ——
     *   而后端正是在 sink 内部读 scut_timing_get() 上报计时的。
     *   结果是每帧报出去的 draw_us / frame_us 都是【上一帧】的数字
     *   （第一帧干脆是 0）。实测确认过：drawUs 恒为 0.000，
     *   而绘制其实一直在跑。
     *   直接在 sink 前读表，既准确又消除了这个"慢一拍"。
     *
     * ★ 顺带说明为什么不需要再减什么：
     *   跨度里已经天然包含了核心自身的调度开销（注册表遍历、循环、
     *   读表），那些是真实存在的开销，本来就该算进整帧时间。
     *   而 sink 属于呈现层，发生在读表之后，自然不会被计入。 */
    frame_end = scut_tick_now();
    frame_us  = scut_tick_delta_us(frame_begin, frame_end);
    if (frame_us < 0.0) {
        frame_us = 0.0;   /* 时间不可能倒退，钳一下防御读数抖动 */
    }

    s_timing.draw_us   = draw_us;
    s_timing.frame_us  = frame_us;

    /* --- 5. frame sink：把这一帧交给呈现后端 ---
     * ★★ 必须排在 DRAW + 合成【之后】★★
     *   后端（headless 写 PPM）读的就是输出图。
     *   标注是在上一步才被合成进去的，若 sink 排在它前面，
     *   用户看到的图就永远不含标注 —— 而且不报任何错。
     *
     * ★ 先把阶段切回 IDLE 再回调 sink（与 scut_internal.h 里
     *   "SCUT_PHASE_IDLE = 帧外（含 frame sink 期间）"的语义一致）：
     *   后端属于呈现层，不属于任何算法阶段。若让它停留在 DRAW 阶段里，
     *   后端一旦顺手调用 SCUT_GetInputImage() 就会被记成"用户违规"，
     *   把后端自身的行为算到用户头上，误导排查方向。
     *
     * ★ 这里【不再】为 sink 单独计时：
     *   frame_us 已在上面读过表，sink 的开销按定义就不该计入任何指标
     *   （它属于呈现层）。原先还算了 sink_begin/sink_end/sink_us
     *   却只用一句 (void)sink_us 丢掉 —— 那是一段"算了但没人要"的死代码，
     *   已删除。真要诊断后端耗时，应该由后端自己上报，
     *   而不是在核心的帧路径上留下三个没人读的变量。 */
    scut_input_set_phase(SCUT_PHASE_IDLE);
    if (s_sink != NULL) {
        s_sink(s_sink_user);
    }
}

/* 描述符与初始化状态是否允许跑帧。
 * s_error == NULL 就是"描述符合法"——见 s_error 的注释。 */
static int core_present(void)
{
    return s_initialized && (s_error == NULL);
}

/* --------------------------------------------------------------------------
 *  初始化 / 释放
 * -------------------------------------------------------------------------- */
void scut_core_init(const scut_image_desc_t *desc, const scut_run_config_t *cfg){
    scut_run_config_t local;

    /* --- 配置：整体值拷贝 ---
     * 调用方（scut_bind.c）传的往往是栈上临时量，存指针必然悬空。 */
    if (cfg != NULL) {
        local = *cfg;
    } else {
        local.repeat       = 1;
        local.log_enabled  = 1;
        local.draw_enabled = 1;
    }
    /* repeat 会作为除数求每次 PROCESS 的平均耗时，0 会直接除零崩溃。
     * 这里夹到 1：把一次明显是笔误的输入变成"跑一次"，比崩掉合理。 */
    if (local.repeat < 1) {
        local.repeat = 1;
    }

    /* --- 描述符：整体值拷贝 --- */
    if (desc != NULL) {
        s_desc = *desc;
    } else {
        memset(&s_desc, 0, sizeof(s_desc));
    }
    s_cfg = local;

    /* --- 描述符校验 ---
     * ★ 为什么这里必须校验，而不是"相信调用方"：
     *   经典的 C 失败模式是【静默越界】——数组按 A 大小分配、
     *   却按 B 大小访问。它不崩溃，只是悄悄写坏相邻内存，
     *   然后在离现场十万八千里的地方崩掉，或者更糟：什么都不崩，
     *   只是图像莫名其妙地错位。宽高来自 config.h 的编译期常量，
     *   而描述符是运行时传进来的，两者的不一致【只有在这里】能拦住。
     *   stride < width 是最隐蔽的一条：第 0 行正常，第 1 行起整体错位。
     *   校验失败时不崩、不打印，只记下原因并让 RunOnce 立刻返回非 0。 */
    s_error = NULL;
    if (desc == NULL) {
        s_error = "图像描述符为空";
    } else if (s_desc.width <= 0) {
        s_error = "图像宽度必须为正";
    } else if (s_desc.height <= 0) {
        s_error = "图像高度必须为正";
    } else if (s_desc.stride < s_desc.width) {
        s_error = "行步长不得小于宽度（会导致逐行错位）";
    } else if (s_desc.gray == NULL) {
        s_error = "灰度缓冲指针为空";
    }

    s_initialized = 1;
    s_quit        = 0;   /* 新会话从"未请求退出"开始 */

    scut_timing_init();

    /* --- 排序：这里是【唯一】固定顺序的地方 ---
     * 顺序一旦定下就不再变（注册表在 main 之前写完，运行期只读），
     * 所以整个进程只需要排这一次。放在 init 而不是每次 invoke，
     * 是因为 invoke 在每帧的热路径上，不能承担排序开销。 */
    scut_registry_sort();

    /* --- INIT 回调：不计时，且【每次会话恰好一次】 ---
     * ★ 不计时的理由：开机初始化（分配缓冲、加载标定表、读图集）
     *   是一次性成本，混进任何每帧指标都会污染第一批样本。
     * ★ "恰好一次"由 s_init_ran 保证：重复调用 scut_core_init
     *   （例如后端重建、用户手动重配）不应该让用户的初始化逻辑
     *   再跑一遍——那可能重复分配内存或重复累加全局量。
     *   scut_core_shutdown 会复位该标志，于是"init→shutdown→init"
     *   构成两个独立会话，各自跑一次 INIT。
     * ★ 描述符非法时【不执行】INIT 回调：用户初始化代码极可能去读
     *   图像宽高（SCUT_GetInputImage 或直接访问输入数组）。
     *   在描述符已知不可用的前提下还把它放进去跑，
     *   等于故意制造越界——正是上面要防的那件事。
     *   ★ 这里原先举的例子是 SCUT_GetImageWidth，那个函数已删除
     *     （它返回的其实是输出图宽高，名字会骗人；见 scut_draw.h）。 */
    if ((s_error == NULL) && !s_init_ran) {
        scut_registry_invoke(SCUT_ROLE_INIT);
        s_init_ran = 1;
    }

    if (s_error != NULL) {
        /* 非法描述符下不允许留下"看起来像测量结果"的数字。 */
        memset(&s_timing, 0, sizeof(s_timing));
    }
}

/* 释放核心资源。
 * ★ 不解除 frame sink：sink 属于呈现后端，后端的生命周期【包住】
 *   核心会话（后端先建好、再 init，退出时先 shutdown、再销毁后端）。
 *   如果这里擅自把 sink 摘掉，"shutdown 后重新 init"这个流程会
 *   静默失去送帧能力，表现为画面卡死且毫无线索。 */
void scut_core_shutdown(void)
{
    /* 退出清理只在"确实初始化过并且真的跑过 INIT"时才值得回调：
     * 否则会出现"没初始化却收到 SHUTDOWN"的不对称调用。 */
    if (s_initialized && (s_error == NULL) && s_init_ran) {
        scut_registry_invoke(SCUT_ROLE_SHUTDOWN);   /* 与 INIT 对称：不计时 */
    }

    memset(&s_desc, 0, sizeof(s_desc));
    s_cfg.repeat       = 1;
    s_cfg.log_enabled  = 0;
    s_cfg.draw_enabled = 0;

    s_initialized = 0;
    s_init_ran    = 0;
    s_quit        = 0;
    s_error       = NULL;

    memset(&s_timing, 0, sizeof(s_timing));
}

/* --------------------------------------------------------------------------
 *  三种调度
 * -------------------------------------------------------------------------- */

int scut_run_once(void)
{
    /* 未初始化或描述符非法：立刻返回非 0，绝不带着坏描述符往下跑。
     * 这正是"静默越界"防线最后一环——用户即使忘了处理 init 错误，
     * 也只会在 RunOnce 上拿到非 0，而不是内存被写坏。 */
    if (!core_present()) {
        return SCUT_RUN_INVALID;
    }
    if (s_quit) {
        return SCUT_RUN_QUIT;   /* 已请求退出，不再跑新帧 */
    }

    run_one_frame();

    /* 帧内（任意角色回调里）请求退出也在这里体现。 */
    if (s_quit) {
        return SCUT_RUN_QUIT;
    }
    return SCUT_RUN_OK;
}

int scut_run_frames(int n)
{
    int done = 0;

    if (n <= 0) {
        return 0;   /* 小于等于 0 帧是合法请求，跑 0 帧 */
    }

    /* ★ 为什么这里不写成 while (done < n && scut_run_once() == SCUT_RUN_OK)：
     *   scut_run_once 遇到退出请求会返回非 0，而那一帧【确实已经执行完
     *   并已经推送给呈现后端】。按前一种写法会把它漏掉，
     *   于是 CI 校验"跑 100 帧"时可能只得到 99 —— 差 1 帧的 bug
     *   最难查，因为日志里什么都看不出来。所以这里显式统计真正执行过的帧。 */
    for (;;) {
        if (!core_present() || s_quit) {
            break;
        }
        if (done >= n) {
            break;
        }
        run_one_frame();
        done++;
    }
    return done;
}

/* repeat 的运行期读写：b<N> 命令临时抬高 N、跑一帧、还原。
 * 直接改 s_cfg.repeat（调度器每帧都从它取值），不需要重启进程。 */
int  scut_sched_get_repeat(void)      { return s_cfg.repeat; }
void scut_sched_set_repeat(int n)     { s_cfg.repeat = (n >= 1) ? n : 1; }

/* 日志 / 绘制的运行期开关。
 *
 * ★ 与 set_repeat 同一种写法：直接改 s_cfg，调度器每帧从它取值 ——
 *   所以"改完立即生效、不需要重启进程"是自然结果，不需要额外机制。
 * ★ run_one_frame 里已经处理了"关掉时不留陈旧读数"：
 *   draw_enabled 为 0 时 draw_us 会被写成 0（而不是保留上次的值）。 */
void scut_sched_set_log_enabled(int enable)  { s_cfg.log_enabled  = (enable != 0) ? 1 : 0; }
void scut_sched_set_draw_enabled(int enable) { s_cfg.draw_enabled = (enable != 0) ? 1 : 0; }

int scut_run_until_quit(void)
{
    int rc;

    if (!core_present()) {
        return SCUT_RUN_INVALID;
    }

    /* ★ 这里【刻意不设帧数上限】。
     *   一个永不请求退出的后端（或 headless 批处理里忘了设退出条件）
     *   就应该一直跑下去——那是调用方的选择，核心没有资格替它决定
     *   "跑够多少帧就算完"。加一个"保险帧数上限"看似稳妥，实际会制造
     *   更坏的问题：长跑测试会在某个魔数处静默停止，而用户完全不知道
     *   为什么。sink 为 NULL 也完全合法（headless 批处理就是这样用的），
     *   此时不记录任何东西、不做任何假设，直接继续下一帧。
     *   需要限制帧数的场景应该用 scut_run_frames(n)。 */
    for (;;) {
        rc = scut_run_once();
        if (rc != SCUT_RUN_OK) {
            /* 退出请求导致的结束是正常退出（头文件承诺返回 0）；
             * 只有"描述符非法"这类错误才把非 0 透传出去。 */
            return (rc == SCUT_RUN_QUIT) ? SCUT_RUN_OK : rc;
        }
    }
}

/* --------------------------------------------------------------------------
 *  退出请求
 *
 *  ★ 只置一个标志，【不做任何其他事】，这是它能从任意回调里安全调用的原因：
 *      - 不改动注册表、不释放内存，因此不会在别人遍历到一半时拆掉结构；
 *      - 不 longjmp、不抛异常，因此不破坏调用栈上任何对象的生命周期；
 *      - 真正"停下来"这件事由调度循环在帧边界完成，
 *        回调本身总是跑完（这正是 run_one_frame 里那条
 *        "帧内请求退出也要走完整帧"约定的另一面）。
 *    也正因为只是置标志，从呈现后端（同线程）调用同样安全。
 * -------------------------------------------------------------------------- */
void scut_request_quit(void)
{
    s_quit = 1;
}

int scut_quit_requested(void)
{
    return s_quit;
}

/* --------------------------------------------------------------------------
 *  呈现后端钩子
 * -------------------------------------------------------------------------- */
void scut_set_frame_sink(scut_frame_sink_fn fn, void *user)
{
    /* 允许在 init 之前或之后设置：本函数不依赖任何已初始化的状态，
     * 后端可以在 main 开头先挂钩子，再由 scut_bind_apply 触发 init。 */
    s_sink      = fn;
    s_sink_user = user;
}

/* --------------------------------------------------------------------------
 *  计时查询
 * -------------------------------------------------------------------------- */
const scut_timing_t *scut_timing_get(void)
{
    /* 返回的是最近一帧的结果，每帧被覆盖写。
     * 指针本身恒定有效（静态存储），调用方可以长期持有。 */
    return &s_timing;
}

/* 开关 DRAW 阶段计时。
 * ★ 语义是"是否【测量】"，不是"是否【绘制】"——后者由
 *   scut_run_config_t.draw_enabled 控制。两个开关分开是有必要的：
 *   关掉计时是为了做精细测量（去掉 QPC 调用本身的开销），
 *   关掉绘制是为了做 headless 性能测试（去掉覆盖层写入的开销），
 *   它们对应两种完全不同的测试目的。
 * 关闭后 draw_us 会被写成 0（在 run_one_frame 里），不留陈旧值。 */
void scut_enable_draw_timing(int enable)
{
    s_draw_timing = (enable != 0) ? 1 : 0;
}
