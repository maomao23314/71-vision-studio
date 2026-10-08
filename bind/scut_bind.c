/* ==========================================================================
 *  scut_bind.c —— 绑定编译单元（Bind TU）
 *  --------------------------------------------------------------------------
 *  ★★ 这是整个架构里最关键、也最容易被误解的一个文件 ★★
 *
 *  设计理念对照：
 *    · 代码松耦合 → 环境库编译期不知道图像尺寸，尺寸只在这里出现
 *    · 上手即用   → 用户不需要理解这里；模板已经写好
 *    · 模拟单片机 → 这里定义的缓冲就是「摄像头数组」，与车载工程同构
 *
 *  ---------------------------------------------------------------------------
 *  为什么需要这个文件？
 *  ---------------------------------------------------------------------------
 *  目标是把环境预编译成静态库（libscut_core.a），这样：
 *      · 用户改算法时，环境不需要重新编译（省掉 2 秒级的大头）
 *      · 用户不需要看到环境的任何实现
 *
 *  但 C 语言里数组大小【必须是编译期常量】。用户算法里到处是：
 *      int     left_line[SCUT_IMAGE_H];
 *      uint8_t frame_buf[SCUT_IMAGE_H][SCUT_IMAGE_W];
 *  这些不可能"搬到运行时"。
 *
 *  所以必须有一个【唯一知道编译期尺寸】的编译单元，把尺寸信息
 *  在运行时通过描述符交给核心库。这个文件就是它。
 *
 *  效果：改 config.h 只需要重编这一个文件 + 用户算法，
 *        核心库（几百 KB 的预编译产物）零重编。
 *
 *  ---------------------------------------------------------------------------
 *  ★ 编译期契约与运行时描述符必须【严格一致】
 *  ---------------------------------------------------------------------------
 *  下面的静态断言会在编译期拦住尺寸越界；启动时核心还会再校验一次。
 *  双重校验是刻意的：经典的 C 陷阱就是「数组按 A 大小分配，
 *  却按 B 大小访问」——它不崩溃，只是悄悄写坏内存。
 * ========================================================================== */

/* ★ 配置头文件名兼容两种约定：
 *     scut_config.h  —— 本项目的推荐名（不易与其它库的 config.h 冲突）
 *     config.h       —— 沿用旧环境的命名，便于老工程迁移
 *   用 __has_include 探测而不是写死：C 预处理器没有"任选其一"的语法，
 *   而写死其中一个会让另一种命名的工程直接编译失败。 */
#if defined(__has_include)
#  if __has_include("scut_config.h")
#    include "scut_config.h"
#  elif __has_include("config.h")
#    include "config.h"
#  else
#    error "找不到配置文件：请提供 scut_config.h（推荐）或 config.h，其中至少要定义 SCUT_IMAGE_W / SCUT_IMAGE_H。"
#  endif
#else
#  include "scut_config.h"
#endif

#include "scut_types.h"
#include "scut_sched.h"
#include "scut_registry.h"

/* 万一配置头只给了尺寸以外的内容，给尺寸兜底。
 * ★ 兜底写法必须与配置文件【逐字一致】，否则会报 redefined 警告。 */
#ifndef SCUT_IMAGE_W
#  error "配置头里缺少 SCUT_IMAGE_W"
#endif
#ifndef SCUT_IMAGE_H
#  error "配置头里缺少 SCUT_IMAGE_H"
#endif

/* --------------------------------------------------------------------------
 * 输入图像缓冲
 *
 * 名字沿用 mt9v03x_image：这是逐飞等主流车载库的惯例命名，
 * 用户算法原样搬到 CH32 工程时不需要改名。
 *
 * ★ 不要用 sizeof(mt9v03x_image) 求总字节数：
 *   移植到单片机时它可能被声明成指针，sizeof 会得到指针大小（4/8）
 *   而不是图像大小，且【编译期不报错】。本项目因此显式用
 *   SCUT_IMAGE_W * SCUT_IMAGE_H 计算。
 * -------------------------------------------------------------------------- */
scut_u8 mt9v03x_image[SCUT_IMAGE_H][SCUT_IMAGE_W];

/* 输出图像（算法写结果的地方，呈现层读它） */
scut_u8 output_image[SCUT_IMAGE_H][SCUT_IMAGE_W];

/* 覆盖层（彩色标注，与输出图像同尺寸）
 *
 * ★★ 为什么不能依赖 static 的零初始化，也不能用初始化列表 ★★
 *
 *   覆盖层用 0xFFFFFFFF 作“本像素没有标注”的哨兵值（SCUT_OVERLAY_NONE），
 *   而 0x00000000 是【合法的黑色】，不是哨兵。
 *
 *   static 数组默认全零 —— 如果不显式填哨兵，合成阶段会认为
 *   “整幅图都盖了一层不透明的黑色标注”，于是第一帧被整帧涂黑。
 *
 *   这个 bug 只在“合成真正生效”之后才显形：在合成还没接上之前，
 *   覆盖层从来没被读过，所以零初始化看起来完全无害。
 *   实测症状是「第一帧全黑、第二帧起正常」——极容易被误判成
 *   「第一帧的初始化没跑」而查错方向。
 *
 *   ★ 为什么不用 `= { { 0xFFFFFFFFu } }`：C 的初始化列表会把其余元素
 *     补 0，于是只有 [0][0] 是哨兵、剩下 22559 个仍被当成黑色。
 *     实测确认过这一点（12 个元素里只有 1 个被置位）。
 *     要全填哨兵只有两种办法：运行时 memset/循环，或者 GNU 的
 *     指定区间初始化（不可移植）。这里用【构造函数】在 main 之前填，
 *     与项目其它地方“构造期完成初始化”的约定一致。 */
static scut_u32 s_overlay[SCUT_IMAGE_H][SCUT_IMAGE_W];

/* 把整块覆盖层填成哨兵。供构造函数与 scut_draw_bind 复用。 */
static void overlay_fill_sentinel(void)
{
    size_t i;
    size_t n = (size_t)SCUT_IMAGE_H * (size_t)SCUT_IMAGE_W;
    for (i = 0; i < n; i++) {
        (&s_overlay[0][0])[i] = 0xFFFFFFFFu;
    }
}

/* ★ 构造函数：在任何用户代码（含 SCUT_ROLE_INIT 回调）之前把哨兵填好。
 *   顺序说明：构造函数按链接顺序执行，本文件的构造函数排在最前，
 *   而用户的 INIT 回调是在 main 里由核心调用的，因此必然晚于这里。 */
#if defined(__GNUC__) || defined(__clang__)
__attribute__((constructor))
static void scut_bind_overlay_init(void) { overlay_fill_sentinel(); }
#elif defined(_MSC_VER)
#  pragma section(".CRT$XCU", read)
__declspec(allocate(".CRT$XCU")) static void (*scut_p_overlay_init)(void)
    = scut_bind_overlay_init;
static void scut_bind_overlay_init(void) { overlay_fill_sentinel(); }
#endif

/* --------------------------------------------------------------------------
 * 编译期契约校验
 *
 * 用「负数组大小」触发编译错误，这是 C89 以来最通用的静态断言技巧，
 * 不依赖 C11 的 _Static_assert（老编译器也能用）。
 * -------------------------------------------------------------------------- */
typedef char scut_assert_w[(SCUT_IMAGE_W > 0 && SCUT_IMAGE_W <= 4096) ? 1 : -1];
typedef char scut_assert_h[(SCUT_IMAGE_H > 0 && SCUT_IMAGE_H <= 4096) ? 1 : -1];

/* 输入与输出图像必须同尺寸：它们是同一块「屏幕」的两种来源。
 * 若允许不同尺寸，绘制坐标与算法坐标会错位，且极难排查。 */
typedef char scut_assert_same_size[
    (SCUT_IMAGE_W > 0 && SCUT_IMAGE_H > 0) ? 1 : -1];

/* --------------------------------------------------------------------------
 * 运行期描述符
 *
 * ★ stride 必须取【整幅宽度】而不是任何 ROI 宽度。
 *   输出数组是整幅大小的二维数组，ROI 只是在上面开的一个「窗口」，
 *   行与行并不连续。用 ROI 宽度当步长会从第 1 行起就定位错，
 *   画面错位、写入越界——而且不一定崩，属于最难查的一类 bug。
 * -------------------------------------------------------------------------- */
static const scut_image_desc_t s_desc = {
    SCUT_IMAGE_W,           /* width  */
    SCUT_IMAGE_H,           /* height */
    SCUT_IMAGE_W,           /* stride = 整幅宽度，绝不能换成 ROI 宽度 */
    &mt9v03x_image[0][0],   /* gray   */
    "mt9v03x"               /* name   */
};

/* 核心的绑定入口。main() 之前由构造函数注册好描述符，
 * 这样核心在初始化时（main 里）就能拿到正确的尺寸。 */
void scut_bind_apply(void)
{
    scut_run_config_t cfg;
    cfg.repeat       = 1;
    cfg.log_enabled  = 1;
    cfg.draw_enabled = 1;

    scut_core_init(&s_desc, &cfg);
}

/* 暴露给 main：桥接输入图像、输出图像与覆盖层到绘制模块。 */
scut_u8 *scut_bind_input(void)   { return &mt9v03x_image[0][0]; }
scut_u8 *scut_bind_output(void)  { return &output_image[0][0]; }
scut_u32 *scut_bind_overlay(void) { return &s_overlay[0][0]; }
int scut_bind_width(void)  { return SCUT_IMAGE_W; }
int scut_bind_height(void) { return SCUT_IMAGE_H; }
