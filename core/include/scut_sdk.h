/* ==========================================================================
 *  scut_sdk.h —— 用户唯一需要包含的头文件
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 上手即用     → 一个头文件，看懂就能用
 *    · 代码松耦合   → 只暴露「移植契约」，主机侧调试设施单独分区
 *    · 模拟单片机   → 标注【移植契约】的接口在车载工程里提供实现即可
 * ========================================================================== */
#ifndef SCUT_SDK_H
#define SCUT_SDK_H

#include "scut_types.h"
#include "scut_registry.h"
#include "scut_draw.h"
#include "scut_log.h"
#include "scut_watch.h"

/* ★ 编译期契约（尺寸等）。
 *   用 __has_include 探测而不是无条件包含：
 *   把 code/ 拷到车载工程时没有这个文件，必须仍能编译。 */
#if defined(__has_include)
#  if __has_include("scut_config.h")
#    include "scut_config.h"
#  elif __has_include("config.h")
#    include "config.h"
#  endif
#else
#  include "config.h"
#endif

/* 万一配置文件缺失，给出兜底尺寸，避免算法文件整片报 undeclared。
 * ★ 兜底值必须与 config.h 的写法【逐字一致】，否则会报 redefined 警告。 */
#ifndef SCUT_IMAGE_W
#  define SCUT_IMAGE_W (188)
#endif
#ifndef SCUT_IMAGE_H
#  define SCUT_IMAGE_H (120)
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ==========================================================================
 *  【移植契约】—— 这些接口在车载工程里必须提供实现
 *
 *  把 code/ 目录拷到单片机工程时，只需提供下面这两个符号的实现，
 *  算法代码一个字都不用改。
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * 输入图像。返回指向灰度缓冲的指针，同时回填宽高。
 *
 * ★ 行步长 = 宽度（单通道连续存放），即 pixel(y,x) = img[y * w + x]。
 *
 * ★ 只在 PROCESS 阶段返回有效指针；在 DRAW / REPORT 阶段返回 NULL
 *   并记一次违规。这是刻意的防呆：防止把图像处理写进绘制回调里
 *   从而逃避计时。
 *
 * ★ 诚实边界：C 语言里无法 100% 阻止蓄意绕过（用户可以直接访问
 *   全局数组），但换成访问器能挡住绝大多数【无意】误用。
 * -------------------------------------------------------------------------- */
const scut_u8 *SCUT_GetInputImage(int *w, int *h);

/* 输出图像写入（结果图，灰度）。坐标越界自动忽略。 */
void SCUT_OutImageSet(int x, int y, scut_u8 value);

/* 读取输出图像（调试用） */
scut_u8 SCUT_OutImageGet(int x, int y);

/* ==========================================================================
 *  【主机侧调试设施】—— 车载工程里给空实现即可，或直接删掉调用
 *
 *  绘制：见 scut_draw.h（SCUT_DrawPoint / DrawLine / DrawRect / DrawText）
 *  日志：见 scut_log.h（SCUT_Log）
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * 手动变量观察的便捷宏（★ 绝大多数情况不需要）
 *
 * ★ 默认你【什么都不用写】：构建时环境会自动扫描全局变量，
 *   并在 IDE 的变量面板里列出来让你勾选。
 *
 * 只有自动发现覆盖不到的场景才需要手动注册，典型是：
 *   · 运行期 malloc 出来的缓冲（不在 .data/.bss 里，DWARF 无绝对地址）
 *   · 你想给某个变量起一个更友好的显示名
 * -------------------------------------------------------------------------- */
#define SCUT_WATCH_SCALAR(name, p, t) \
    SCUT_Watch((name), (const void *)(p), (t), 1, (int)sizeof(*(p)), 0)

#define SCUT_WATCH_ARRAY(name, p, count, t) \
    SCUT_Watch((name), (const void *)(p), (t), (count), \
               (int)sizeof(*(p)), 1)

#ifdef __cplusplus
}
#endif
#endif /* SCUT_SDK_H */
