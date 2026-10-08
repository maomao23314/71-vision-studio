/* ==========================================================================
 *  scut_input.c —— 输入图像访问器与阶段门控
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机   → 输入图像就是摄像头数组，车载工程可换成自己的
 *    · 适应任意代码 → 算法用自己的数组名直接访问即可；访问器是给
 *                     需要"不关心缓冲从哪来"的代码用的
 *
 *  ★ 本文件的核心职责：把「当前处在哪个阶段」告诉需要知道的人。
 * ========================================================================== */

#include "scut_sdk.h"
#include "scut_internal.h"

#include <stdio.h>
#include <string.h>   /* memcpy —— 搬运结果图 */

/* --- 由 bind 单元提供 --- */
extern scut_u8 *scut_bind_input(void);
extern scut_u8 *scut_bind_output(void);
extern int      scut_bind_width(void);
extern int      scut_bind_height(void);

static scut_phase_t s_phase = SCUT_PHASE_IDLE;
static int          s_violations = 0;   /* 在非法阶段访问输入图像的次数 */

/* 供 scut_sched.c 调用。 */
void scut_input_set_phase(int phase)
{
    s_phase = (scut_phase_t)phase;
}

scut_phase_t scut_input_get_phase(void)
{
    return s_phase;
}

int scut_input_violations(void)
{
    return s_violations;
}

void scut_input_reset_violations(void)
{
    s_violations = 0;
}

/* --------------------------------------------------------------------------
 * 输入图像访问器
 *
 * ★ 行步长 = 宽度（单通道连续存放）：pixel(y, x) = img[y * w + x]
 * -------------------------------------------------------------------------- */
const scut_u8 *SCUT_GetInputImage(int *w, int *h)
{
    /* 只有 PROCESS 阶段允许访问输入图像。
     *
     * ★ 为什么 DRAW 阶段拒绝：
     *   DRAW 是不计时的阶段。若允许在那里读输入图，就等于提供了一个
     *   "把图像处理藏进不计时区域"的入口 —— 测出来的 process_us 会偏小，
     *   而这正是本环境最核心的指标。这条限制是机制性的，不是约定。
     *
     * ★ 诚实边界：用户仍可直接访问全局输入数组（那是可移植性要求的）。
     *   门控挡的是【无意误用】，不是蓄意绕过。 */
    if (s_phase != SCUT_PHASE_PROCESS) {
        s_violations++;

        /* 只在第一次违规时提示，避免刷屏。
         * ★ 走 stderr 而不是 SCUT_Log：日志门控在 DRAW 阶段才打开，
         *   而违规恰恰可能发生在 DRAW 阶段 —— 用 SCUT_Log 反而看不到提示。
         *   这是本项目里一处真实的"自指陷阱"。 */
        if (s_violations == 1) {
            fprintf(stderr,
                "[scut] 警告: 在非处理阶段调用了 SCUT_GetInputImage()。\n"
                "       输入图像只在 PROCESS 阶段可访问。\n"
                "       如果在绘制阶段做图像处理，算法耗时不会被计入，\n"
                "       性能数据将失去意义。\n");
        }
        return 0;
    }

    if (w != 0) { *w = scut_bind_width(); }
    if (h != 0) { *h = scut_bind_height(); }
    return scut_bind_input();
}

/* --------------------------------------------------------------------------
 *  把用户的结果图搬进环境输出图（由生成的接线单元调用）
 *
 *  ★★ 为什么是【逐像素深拷贝】而不是换个指针 ★★
 *
 *    用户算法通常把结果写进自己的二维数组，例如：
 *        uint8_t binary_image[H][W];
 *    环境要把这张图显示出来，最省事的做法似乎是"让输出图指向它"。
 *    但算法里往往还存在【逆透视指针表】这类结构：
 *        uint8_t *PerImg_ip[H][W];       每个元素指向原图某个像素
 *    一旦输出图换了目标，这类表里所有指针立刻悬空 —— 读到随机内存，
 *    不崩溃、不报错，只是画面诡异。所以只能按值拷贝内容。
 *
 *  ★ 为什么不用 SCUT_OutImageSet 逐点写：
 *    那是给"算法想直接产出显示图"的场景留的通用接口，每点一次要走
 *    边界检查与步长乘法。整块拷贝一次 memcpy 逐行做，既更快，
 *    也让"这是一次搬运"这件事在代码里看得见。
 *
 *  ★ 尺寸不匹配时按行裁剪而不是报错：
 *    用户数组尺寸来自它自己的宏，未必与本工程 config 完全一致。
 *    "少显示一部分"远好于"编译不过"或"越界写坏内存"。
 *
 *  参数：
 *      src   用户结果数组首地址（按 row-major，即 src[y*w + x]）
 *      src_w 源行宽（像素）；0 表示用环境的宽度
 *      src_h 源行数；0 表示用环境的高度
 * -------------------------------------------------------------------------- */
void SCUT_EnvCopyOutput(const scut_u8 *src, int src_w, int src_h)
{
    scut_u8 *dst;
    int w;
    int h;
    int row_bytes;
    int y;

    if (src == 0) {
        return;
    }

    dst = scut_bind_output();
    w   = scut_bind_width();
    h   = scut_bind_height();
    if (dst == 0 || w <= 0 || h <= 0) {
        return;
    }

    if (src_w <= 0) { src_w = w; }
    if (src_h <= 0) { src_h = h; }

    /* 只搬两边都有的那部分 */
    if (src_w < w) { row_bytes = src_w; } else { row_bytes = w; }
    if (src_h < h) { h = src_h; }

    for (y = 0; y < h; y++) {
        memcpy(dst + (size_t)y * (size_t)w,
               src + (size_t)y * (size_t)src_w,
               (size_t)row_bytes);
    }

    /* 源比目标小时，剩余区域填黑而不是留上一帧的残影 ——
     * 否则"换了张图反而看到旧内容"，属于最难解释的一类现象。 */
    if (row_bytes < w) {
        for (y = 0; y < h; y++) {
            memset(dst + (size_t)y * (size_t)w + (size_t)row_bytes, 0,
                   (size_t)(w - row_bytes));
        }
    }
}
