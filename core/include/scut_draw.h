/* ==========================================================================
 *  scut_draw.h —— 绘制接口（覆盖层）
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机   → 绘制是【主机侧调试设施】，车载工程给空实现即可
 *    · 代码松耦合   → 绘制落到【输出数组】，不依赖任何图形库
 *
 *  ★ 为什么绘制必须下沉到核心（相对旧环境的关键修正）：
 *      旧实现把 SCUT_DrawPoint 直接写进 EasyX 的 DIB 缓冲。
 *      一旦换掉呈现后端（headless / Webview），用户所有绘制调用会
 *      【静默失效】——不报错，只是什么都不画，极难排查。
 *      现在改为写入 SCUT_OUT_IMAGE_ARRAY，呈现层只负责「把数组变成图」。
 * ========================================================================== */
#ifndef SCUT_DRAW_H
#define SCUT_DRAW_H

#include "scut_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --- 颜色：0x00BBGGRR（与 Windows COLORREF 一致，便于既有代码迁移） --- */
#define SCUT_RGB(r, g, b) \
    ((scut_u32)(((scut_u8)(r)) | (((scut_u32)(scut_u8)(g)) << 8) | \
                (((scut_u32)(scut_u8)(b)) << 16)))

#define SCUT_COLOR_BLACK      SCUT_RGB(0x00, 0x00, 0x00)
#define SCUT_COLOR_WHITE      SCUT_RGB(0xFF, 0xFF, 0xFF)
#define SCUT_COLOR_RED        SCUT_RGB(0xFF, 0x00, 0x00)
#define SCUT_COLOR_GREEN      SCUT_RGB(0x00, 0xFF, 0x00)
#define SCUT_COLOR_BLUE       SCUT_RGB(0x00, 0x00, 0xFF)
#define SCUT_COLOR_YELLOW     SCUT_RGB(0xFF, 0xFF, 0x00)
#define SCUT_COLOR_CYAN       SCUT_RGB(0x00, 0xFF, 0xFF)
#define SCUT_COLOR_MAGENTA    SCUT_RGB(0xFF, 0x00, 0xFF)
#define SCUT_COLOR_ORANGE     SCUT_RGB(0xFF, 0x80, 0x00)
#define SCUT_COLOR_GRAY       SCUT_RGB(0x80, 0x80, 0x80)
#define SCUT_COLOR_LIGHTGRAY  SCUT_RGB(0xC0, 0xC0, 0xC0)

/* 坐标越界【自动忽略】，用户不需要自己判断（沿用旧环境的良好设计）。 */
void SCUT_DrawPoint(int x, int y, scut_u32 color);
void SCUT_DrawLine(int x0, int y0, int x1, int y1, scut_u32 color);
void SCUT_DrawRect(int x0, int y0, int x1, int y1, scut_u32 color);
void SCUT_DrawText(int x, int y, scut_u32 color, const char *fmt, ...);

/* --- 输出图像（RGB 三通道结果图，PROCESS 阶段写） ---
 * ★ 输出缓冲每像素 3 字节（R/G/B 紧凑排列，行步长 = 宽度 × 3）。 */
void  SCUT_OutImageSet(int x, int y, scut_u8 value);
void  SCUT_OutImageSetRGB(int x, int y, scut_u8 r, scut_u8 g, scut_u8 b);
scut_u8 SCUT_OutImageGet(int x, int y);

/* --- 覆盖层尺寸查询（供绘制代码做自适应） ---
 *
 * ★ 这里【只有】输出图/覆盖层的尺寸，没有"输入图尺寸"的访问器。
 *   原因是原先那一对 SCUT_GetImageWidth/Height 的实现与本函数
 *   逐字相同（都返回同一组 s_w/s_h），名字却暗示输入图 —— 会骗人，已删除。
 *   需要输入图尺寸请用 SCUT_GetInputImage(&w, &h)：
 *   它回填的是真正的输入图宽高，且只在 PROCESS 阶段有效
 *   （其余阶段返回 NULL 并记一次违规，防止把图像处理藏进不计时的阶段）。
 *
 * 未绑定时返回 0，因此 `for (x = 0; x < SCUT_GetOutputWidth(); x++)`
 * 在未绑定时自然退化成空循环。 */
int SCUT_GetOutputWidth(void);
int SCUT_GetOutputHeight(void);

/* --- 核心内部使用：由 frame 模块绑定实际缓冲 ---
 * gray_stride 单位是【字节】（RGB 下 = 宽度 × 3）；
 * ovl_stride  单位是【u32 元素数】（= 宽度）。两者必须分别传。 */
void scut_draw_bind(scut_u8 *gray, scut_u32 *overlay, int w, int h,
                    int gray_stride, int ovl_stride);
void scut_draw_clear_overlay(void);

/* --------------------------------------------------------------------------
 *  取回当前绑定的绘制目标
 *
 *  ★ 存在的理由：
 *      调度器在 DRAW 阶段结束后，必须把 overlay 合成进 gray（否则用户的
 *      标注全部静默丢失），并且必须在合成【之后】清空 overlay（否则标注会
 *      跨帧累积）。但它自己并不知道绘制模块当前绑定的是【哪一对缓冲】——
 *      本工程里覆盖层缓冲存在两份，调度器若猜错就会合成出一张空覆盖层。
 *      只有绘制模块知道答案，所以由它把这一对缓冲取回来。
 *
 *  参数语义（★ 每个输出参数都必须能安全地传 NULL）：
 *      gray    : 当前绑定的灰度输出图；未绑定时写 NULL
 *      overlay : 当前绑定的覆盖层；未绑定时写 NULL
 *      w / h   : 当前绑定尺寸；未绑定时写 0
 *
 *  ★ 未绑定时也必须把参数【写出】（NULL / 0），不能"什么都不做"：
 *      调用方的局部变量往往是栈垃圾，若不解引用就会被当成有效指针使用。
 *      这正是「未初始化即使用」的经典静默失败，必须在源头堵死。
 * -------------------------------------------------------------------------- */
void scut_draw_get_target(scut_u8 **gray, scut_u32 **overlay, int *w, int *h);

/* --------------------------------------------------------------------------
 *  「本帧算法是否已直接写过输出图」记账
 *
 *  ★ 解决的缺口：SCUT_OutImageSet / SetRGB 是"算法直接产出显示图"的路径
 *    （见 scut_sdk.h 的说明），但调度器每帧在 PROCESS 之后会把输入图
 *    铺满输出图当默认底图 —— 那一铺会把算法刚写的像素【全量冲掉】。
 *    用户的现象是"我写了 OutImageSet，画面却还是原始灰度图"，不报错。
 *
 *  用法（调度器）：
 *      每帧开头  scut_draw_clear_output_written();
 *      PROCESS 之后、铺底图之前：
 *          if (!scut_draw_output_written()) { scut_env_seed_output_from_input(); }
 *
 *  ★ 为什么判断权交给调度器，而不是让本模块自己决定：
 *    帧内顺序是调度器的契约（哪一步在前、哪一步在后），
 *    "默认底图该不该铺"属于顺序问题，所以由调度器读标志、自己决定。
 *    本模块只负责如实记录"有没有人写过"。
 * -------------------------------------------------------------------------- */
int  scut_draw_output_written(void);
void scut_draw_clear_output_written(void);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_DRAW_H */
