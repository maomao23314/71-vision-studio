/* ==========================================================================
 *  scut_draw.h —— 绘制接口（覆盖层）
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机   → 绘制是【主机侧调试设施】，车载工程给空实现即可
 *    · 代码松耦合   → 绘制落到【覆盖层】，不依赖任何图形库
 *
 *  ★ 为什么绘制必须下沉到核心（相对旧环境的关键修正）：
 *      旧实现把 SCUT_DrawPoint 直接写进 EasyX 的 DIB 缓冲。
 *      一旦换掉呈现后端（headless / Webview），用户所有绘制调用会
 *      【静默失效】——不报错，只是什么都不画，极难排查。
 *      现在改为写入【覆盖层】、由调度器合成进输出图，呈现层只负责「把数组变成图」。
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

/* --------------------------------------------------------------------------
 *  坐标量级上限
 *
 *  ★ 存在的唯一理由：让 SCUT_DrawLine 不会因坐标溢出而【无限循环】。
 *
 *    Bresenham 靠"走到端点"退出，而端点能否走到依赖 |dx|/|dy| 算得对。
 *    若坐标是 INT_MIN/INT_MAX 量级，`x1 - x0` 会【有符号溢出】成负数，
 *    于是步进方向与误差初值全部错乱 —— 主循环可能永远走不到端点。
 *    后果不是崩溃，而是 IDE 会话 CPU 100% 挂死，用户只能强杀插件宿主；
 *    而触发条件只要算法里一处坐标算错（除零得 INT_MIN、检测框算错、
 *    未初始化变量）。
 *
 *    阈值取 2^20（约 105 万）而不是 INT_MAX：
 *      · 图像坐标本来就在千级，2^20 留有巨额余量，正常绘制绝不受影响；
 *      · 它远小于 INT_MAX/2，可保证 dx/dy 的减法绝不溢出。
 *
 *  ★ 这是【常量】而非可调参数：改大就有溢出风险，改小会挡掉合法绘制。
 *    所以不暴露成配置项。
 * -------------------------------------------------------------------------- */
#define SCUT_DRAW_COORD_LIMIT (1 << 20)

/* 坐标越界【自动忽略】，用户不需要自己判断（沿用旧环境的良好设计）。
 * ★ 这条契约覆盖整个绘制家族：DrawLine 同样靠入口量级守卫实现它
 *   （见该函数实现里的说明），而不只是在端点判界。 */
void SCUT_DrawPoint(int x, int y, scut_u32 color);
void SCUT_DrawLine(int x0, int y0, int x1, int y1, scut_u32 color);
void SCUT_DrawRect(int x0, int y0, int x1, int y1, scut_u32 color);
void SCUT_DrawText(int x, int y, scut_u32 color, const char *fmt, ...);

/* --- 输出图像：见 scut_sdk.h ---
 *
 * ★ 这里原先声明了 SCUT_OutImageSet / SetRGB / OutImageGet。
 *   0.10.6 起它们带一个"选哪块图"的参数（SCUT_IMG_1 / SCUT_IMG_2），
 *   两块输出图共用一段写入代码，实现放在 core/src/scut_input.c，
 *   声明只留在 scut_sdk.h 一处 —— 用户包含的头只有一个，
 *   同一个函数却在两个头里各声明一遍，是改签名时最容易漏改的那种重复。
 *
 *   本头文件现在只管：绘制（点在覆盖层上）、绑定、覆盖层合成、以及
 *   「本帧算法有没有直接写过输出图」的记账（见文件末尾）。 */

/* --- 覆盖层尺寸查询（供绘制代码做自适应） ---
 *
 * ★ 这里【只有】输出图/覆盖层的尺寸，没有"输入图尺寸"的访问器。
 *   原因是原先那一对 SCUT_GetImageWidth/Height 的实现与本函数
 *   逐字相同（都返回同一组 s_w/s_h），名字却暗示输入图 —— 会骗人，已删除。
 *   需要输入图尺寸请用 SCUT_GetInputImage(&w, &h)：
 *   它回填的是真正的输入图宽高，且只在 PROCESS 阶段有效
 *   （其余阶段返回 NULL，并在【第一次】违规时往 stderr 打一条提示 ——
 *    计数每次都会累加，但提示只出现一次，避免刷屏）。
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

/* 标记"本帧算法已经直接写过输出图"（由 SCUT_OutImageSet / SCUT_EnvCopyOutput
 * 在真正写入后调用；写的是「图片2」时不碰这里 —— 那是另一块缓冲）。
 *
 * ★ 为什么要有这个"对外置位"的入口：
 *    SCUT_OutImageSet / SCUT_EnvCopyOutput 在 0.10.6 起带一个"选哪块图"的参数，
 *    两块图共用同一段写入代码（见 scut_input.c 的 out_store）。
 *    既然写入只有一处，记账也就该只有一处 —— 由那一处转告本模块，
 *    而不是让 draw 和 input 各自维护一半。
 * ★ 语义与原先一致：只有【真的写入了一个像素】才置位，越界调用不算。 */
void scut_draw_mark_output_written(void);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_DRAW_H */
