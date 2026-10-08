/* ==========================================================================
 *  scut_types.h —— 基础类型与图像描述符
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 代码松耦合   → 本文件零平台依赖，单片机可直接用
 *    · 模拟单片机   → 用固定宽度类型，不用 int 假设
 *    · 适应任意代码 → 尺寸走【运行时描述符】，核心不编译期依赖配置
 * ========================================================================== */
#ifndef SCUT_TYPES_H
#define SCUT_TYPES_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned char      scut_u8;
typedef signed char        scut_i8;
typedef unsigned short     scut_u16;
typedef signed short       scut_i16;
typedef unsigned int       scut_u32;
typedef signed int         scut_i32;
typedef unsigned long long scut_u64;
typedef signed long long   scut_i64;
typedef float              scut_f32;
typedef double             scut_f64;

/* --------------------------------------------------------------------------
 * 图像描述符
 *
 * ★ 这是「环境预编译成库」与「配置可改」两种诉求的交汇点。
 *   核心库【编译期完全不知道】图像尺寸，所有尺寸信息通过本结构在
 *   运行时传入。这样改 config.h 只影响 bind 单元，不触发核心重编。
 * -------------------------------------------------------------------------- */
typedef struct {
    int      width;        /* 图像宽（列数） */
    int      height;       /* 图像高（行数） */
    int      stride;       /* 行步长（字节）。单通道灰度时 == width */
    scut_u8 *gray;         /* 输入灰度缓冲，height*stride 字节 */
    const char *name;      /* 来源名（如 "mt9v03x"），仅用于 UI 显示 */
} scut_image_desc_t;

/* 像素格式。当前仅灰度，保留 RGB565 等扩展位。 */
typedef enum {
    SCUT_PIXFMT_GRAY8 = 0,
    SCUT_PIXFMT_RGB565,
    SCUT_PIXFMT_RGB888
} scut_pixfmt_t;

#ifdef __cplusplus
}
#endif
#endif /* SCUT_TYPES_H */
