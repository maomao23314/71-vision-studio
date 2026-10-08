/* ==========================================================================
 *  scut_bind.c —— 绑定编译单元（Bind TU）
 *  --------------------------------------------------------------------------
 *  ★★ 这是整个架构里最关键、也最容易被误解的一个文件 ★★
 *
 *  设计理念对照：
 *    · 代码松耦合   → 环境库编译期不知道图像尺寸，尺寸只在这里出现
 *    · 上手即用     → 用户不需要理解这里；尺寸与数组名由插件自动生成
 *    · 模拟单片机   → 这里的缓冲就是「摄像头数组」，与车载工程同构
 *
 *  ---------------------------------------------------------------------------
 *  为什么需要这个文件？
 *  ---------------------------------------------------------------------------
 *  目标是把环境预编译成静态库（libscut_core.a），于是：
 *      · 用户改算法时，环境不需要重新编译
 *      · 用户不需要看到环境的任何实现
 *
 *  但 C 语言里数组大小【必须是编译期常量】。用户算法里到处是：
 *      uint8_t frame_buf[SCUT_IMAGE_H][SCUT_IMAGE_W];
 *  这些不可能"搬到运行时"。所以必须有一个【唯一知道编译期尺寸】的
 *  编译单元，把尺寸信息在运行时通过描述符交给核心库。这个文件就是它。
 *
 *  ---------------------------------------------------------------------------
 *  ★ 图像缓冲的所有权（本文件最重要的一条设计）
 *  ---------------------------------------------------------------------------
 *  输入图与输出图都由【环境】拥有，且地址恒定：
 *
 *      mt9v03x_image[H][W]   输入：后端每帧把测试图解码进来
 *      output_image[H][W]    输出：呈现层读它
 *
 *  用户算法直接按名字访问（与车载工程一致），环境负责填充与呈现。
 *
 *  ★★ 为什么地址必须恒定（一个真实踩过的坑）★★
 *      视觉算法里常见「逆透视指针表」：一张 [H][W] 的 uint8_t* 表，
 *      每个元素指向输入图里的某个像素。这张表在开机时建一次、长期使用。
 *      如果输入图每帧换一块内存（例如从访问器拿一个"只在处理阶段有效"的
 *      临时缓冲），表里所有指针立刻悬空 —— 读到随机内存，且不报错。
 *
 *      旧实现正是这样：用户代码自己声明一份 static 副本、再加一份给指针表
 *      用的 local 副本、再加一份访问器缓冲，一共三份拷贝 + 一次每帧 memcpy。
 *      现在只有一份：地址恒定，指针表天然长期有效。
 * ========================================================================== */

/* ★ 配置头（由 tools/scut_build.py 从 scut_project.json 生成）。
 *   两种命名都支持，便于老工程迁移。 */
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

#ifndef SCUT_IMAGE_W
#  error "配置头里缺少 SCUT_IMAGE_W"
#endif
#ifndef SCUT_IMAGE_H
#  error "配置头里缺少 SCUT_IMAGE_H"
#endif

/* 输入数组的名字由插件配置决定（默认 mt9v03x_image，沿用逐飞/车载惯例）。
 * 构建脚本会在 scut_config.h 里生成 SCUT_INPUT_ARRAY。
 * ★ 用宏做数组名是刻意的：同一个符号名在车载工程里也这么叫，
 *   算法代码因此不需要任何改名就能两边通用。 */
#ifdef SCUT_INPUT_ARRAY
#  define SCUT_IN_NAME SCUT_INPUT_ARRAY
#else
#  define SCUT_IN_NAME mt9v03x_image
#endif

/* --------------------------------------------------------------------------
 *  图像缓冲
 * -------------------------------------------------------------------------- */
scut_u8 SCUT_IN_NAME[SCUT_IMAGE_H][SCUT_IMAGE_W];   /* 输入（摄像头） */
scut_u8 output_image[SCUT_IMAGE_H][SCUT_IMAGE_W];   /* 输出（呈现层读它） */

/* 覆盖层（彩色标注，与输出图像同尺寸）
 *
 * ★★ 为什么不能依赖 static 的零初始化，也不能用初始化列表 ★★
 *
 *   覆盖层用 0xFFFFFFFF 作"本像素没有标注"的哨兵值（SCUT_OVERLAY_NONE），
 *   而 0x00000000 是【合法的黑色】，不是哨兵。
 *
 *   static 数组默认全零 —— 如果不显式填哨兵，合成阶段会认为
 *   "整幅图都盖了一层不透明的黑色标注"，于是第一帧被整帧涂黑。
 *   这个 bug 只在"合成真正生效"之后才显形，极容易被误判成
 *   "第一帧的初始化没跑"而查错方向。
 *
 *   ★ 为什么不用 `= { { 0xFFFFFFFFu } }`：C 的初始化列表会把其余元素
 *     补 0，于是只有 [0][0] 是哨兵、剩下 22559 个仍被当成黑色。
 *     实测确认过这一点。要全填哨兵只有两种办法：运行时循环，
 *     或者 GNU 的指定区间初始化（不可移植）。这里用【构造函数】在 main
 *     之前填，与项目其它地方"构造期完成初始化"的约定一致。 */
static scut_u32 s_overlay[SCUT_IMAGE_H][SCUT_IMAGE_W];

static void overlay_fill_sentinel(void)
{
    size_t i;
    size_t n = (size_t)SCUT_IMAGE_H * (size_t)SCUT_IMAGE_W;
    scut_u32 *p = &s_overlay[0][0];
    for (i = 0; i < n; i++) {
        p[i] = 0xFFFFFFFFu;
    }
}

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

/* --------------------------------------------------------------------------
 * 运行期描述符
 *
 * ★ stride 必须取【整幅宽度】而不是任何 ROI 宽度：
 *   输出数组是整幅大小的二维数组，ROI 只是在上面开的一个"窗口"，
 *   行与行并不连续。用 ROI 宽度当步长会从第 1 行起就定位错，
 *   画面错位、写入越界——而且不一定崩，属于最难查的一类 bug。
 * -------------------------------------------------------------------------- */
static const scut_image_desc_t s_desc = {
    SCUT_IMAGE_W,           /* width  */
    SCUT_IMAGE_H,           /* height */
    SCUT_IMAGE_W,           /* stride = 整幅宽度 */
    &SCUT_IN_NAME[0][0],    /* gray   */
    "mt9v03x"               /* name   */
};

/* 核心的绑定入口。main() 之前由构造函数注册好描述符，
 * 这样核心在初始化时（main 里）就能拿到正确的尺寸。
 *
 * ★ repeat 的初值来自编译期配置（SCUT_PROCESS_REPEAT）；
 *   运行期的 --repeat 会在 init 之后覆盖它（见后端）。 */
#ifdef SCUT_PROCESS_REPEAT
#  define SCUT_BIND_REPEAT SCUT_PROCESS_REPEAT
#else
#  define SCUT_BIND_REPEAT 1
#endif

void scut_bind_apply(void)
{
    scut_run_config_t cfg;
    cfg.repeat       = (SCUT_BIND_REPEAT >= 1) ? SCUT_BIND_REPEAT : 1;
    cfg.log_enabled  = 1;
    cfg.draw_enabled = 1;

    scut_core_init(&s_desc, &cfg);
}

/* --------------------------------------------------------------------------
 * 暴露给后端 / 绘制模块
 *
 * ★ 输入缓冲通过函数而不是让后端直接引用数组符号：
 *   数组名是可配置的（SCUT_INPUT_ARRAY），后端不该知道它叫什么。
 *   多一层间接换来"改配置不用改后端"。
 * -------------------------------------------------------------------------- */
scut_u8 *scut_bind_input(void)    { return &SCUT_IN_NAME[0][0]; }
scut_u8 *scut_bind_output(void)   { return &output_image[0][0]; }
scut_u32 *scut_bind_overlay(void) { return &s_overlay[0][0]; }
int scut_bind_width(void)  { return SCUT_IMAGE_W; }
int scut_bind_height(void) { return SCUT_IMAGE_H; }
