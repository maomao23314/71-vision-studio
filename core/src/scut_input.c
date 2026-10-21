/* ==========================================================================
 *  scut_input.c —— 输入图像访问器、阶段门控、输出图写入
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机   → 输入图像就是摄像头数组，车载工程可换成自己的
 *    · 适应任意代码 → 算法用自己的数组名直接访问即可；访问器是给
 *                     需要"不关心缓冲从哪来"的代码用的
 *
 *  ★ 本文件的职责：
 *    1) 把「当前处在哪个阶段」告诉需要知道的人；
 *    2) 输出图的【写入/搬运】—— 两块图（图片1 / 图片2）共用一段代码，
 *       由第一个参数选图。写「图片1」时还要告诉绘制模块"本帧被写过"，
 *       那块记账决定调度器要不要铺默认底图。
 *    （写入收拢在这里：以前 SCUT_OutImageSet 在 scut_draw.c、
 *      图片2 的一套在本文件，同一件"往输出图写一个像素"的事写了两遍。）
 * ========================================================================== */

#include "scut_sdk.h"
#include "scut_draw.h"     /* scut_draw_get_target / scut_draw_mark_output_written */
#include "scut_internal.h"
/* ★ 像素缓冲的访问器由 bind 单元提供。契约声明在 scut_bind.h 里，
 *   本文件原先【手写 extern】这 4 个函数 —— 与后端那份重复，
 *   且改签名不会有任何编译错误。已收口到单一头文件。 */
#include "scut_bind.h"

#include <stdio.h>
#include <string.h>   /* memcpy —— 搬运结果图 */

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
 *  默认底图：输入图 → 输出图
 *
 *  ★ 为什么需要它（这条曾经只是文档里的承诺，代码里并不存在）：
 *    「结果图数组名留空 = 画面显示输入图本身」写在 README / 设置说明里，
 *    但此前没有任何地方把输入拷进输出，于是留空时输出永远是全黑 ——
 *    "我明明没设结果图，画面却是一片黑"里没有任何线索指向真实原因。
 *    现在由调度器在 PROCESS 之后、DRAW 之前调用本函数，把摄像头画面
 *    作为默认底图；DRAW 里的 scut_env_copy_output() 与覆盖层都叠在它上面。
 *
 *  ★ 为什么必须在 DRAW 之前：DRAW 阶段会「合成覆盖层」，若在那之后再拷，
 *    用户画的所有标注会被这一拷贝抹掉（静默消失）。
 * -------------------------------------------------------------------------- */
void scut_env_seed_output_from_input(void)
{
    scut_u8 *in;
    scut_u8 *out;
    int      w;
    int      h;
    int      x, y;

    in  = scut_bind_input();
    out = scut_bind_output();
    w   = scut_bind_width();
    h   = scut_bind_height();
    if (in == 0 || out == 0 || w <= 0 || h <= 0 || in == out) {
        return;
    }
    /* ★ 输出图是 RGB 三通道，而输入是单通道灰度，
     *   所以不能整块 memcpy —— 必须逐像素把灰度扩成等值三通道。
     *   直接 memcpy(w*h) 会只填满前三分之一，后两通道全是上一帧的残留，
     *   症状是"画面像被撕掉一条"，而且不报错。 */
    for (y = 0; y < h; y++) {
        const scut_u8 *src = in  + (size_t)y * (size_t)w;
        scut_u8       *dst = out + (size_t)y * (size_t)w * 3u;
        for (x = 0; x < w; x++) {
            dst[(size_t)x * 3u + 0] = src[x];
            dst[(size_t)x * 3u + 1] = src[x];
            dst[(size_t)x * 3u + 2] = src[x];
        }
    }
}

/* --------------------------------------------------------------------------
 *  输出图：选图、写入、搬运
 *  --------------------------------------------------------------------------
 *  两块输出图（参数 img = 1 / 2）在这里收成【一条通路】：
 *  由 out_buffer(img) 统一回答"哪一块"，下面每个函数都只写一遍。
 *
 *  ★ 用户看到的就是数字 1 和 2，没有 SCUT_IMG_* 之类的宏
 *    （理由写在 scut_sdk.h：这一层用户一辈子只会填这两个数之一，
 *      宏挡不住写错，只会多一个要记的名字）。
 *    本文件的 OUT_IMG_MAIN / OUT_IMG_SECOND 是【实现自己的】常量：
 *    代码里再出现裸 1 / 2 就分不清是"图号"还是"x 坐标"了。
 * -------------------------------------------------------------------------- */

#define OUT_IMG_MAIN   1   /* 图片1：最终画面（参与覆盖层合成） */
#define OUT_IMG_SECOND 2   /* 图片2：算法自己的中间结果 */

/* img → 缓冲首地址。非法编号返回 NULL（调用方一律当"什么都不做"处理）。 */
static scut_u8 *out_buffer(int img)
{
    if (img == OUT_IMG_MAIN) {
        scut_u8 *rgb = 0;
        int      w = 0;
        int      h = 0;
        /* 输出参数都能安全传 NULL（见 scut_draw_get_target 的契约），
         * 这里只要那块缓冲和尺寸，不要覆盖层。 */
        scut_draw_get_target(&rgb, 0, &w, &h);
        /* 未绑定（环境还没跑起来）时返回 NULL，后续按"静默忽略"处理。 */
        return (rgb != 0 && w > 0 && h > 0) ? rgb : 0;
    }
    if (img == OUT_IMG_SECOND) {
        return scut_bind_output2();
    }
    return 0;
}

/* 这一块是不是"最终画面"。只有它参与覆盖层合成、也只有它要记账
 * 「本帧是否被算法直接写过」（那个记账用来决定要不要铺默认底图）。 */
static int out_is_main(int img)
{
    return img == OUT_IMG_MAIN;
}

/* 写入一个像素。越界 / 未绑定一律静默忽略（与 DrawPoint 同一套约定）。 */
static void out_store(int img, int x, int y, scut_u8 r, scut_u8 g, scut_u8 b)
{
    scut_u8 *dst = out_buffer(img);
    int      w   = scut_bind_width();
    int      h   = scut_bind_height();
    scut_u8 *p;

    if (dst == 0 || w <= 0 || h <= 0) {
        return;
    }
    if (x < 0 || x >= w || y < 0 || y >= h) {
        return;
    }
    p = dst + (size_t)y * (size_t)w * 3u + (size_t)x * 3u;
    p[0] = r;
    p[1] = g;
    p[2] = b;

    if (out_is_main(img)) {
        /* 「本帧算法直接写过图片1」——调度器据此跳过铺默认底图，
         * 否则这里写的东西会在同一帧稍后被整幅输入图覆盖掉。
         * 记账只由 draw 模块做（它拥有那块缓冲），这里只是转告。 */
        scut_draw_mark_output_written();
    } else {
        /* 「图片2 被用过」——后端据此决定要不要每帧多写一张 PPM。
         * ★ 注意"被用过"只认【图片2】：参数非法（比如填了 3）时
         *   out_buffer 早已返回 NULL，上面那句 return 就把流程掐掉了，
         *   走不到这里。所以这里可以放心按"不是图片1 就是图片2"处理。 */
        scut_bind_output2_mark();
    }
}

void SCUT_OutImageSet(int img, int x, int y, scut_u8 value)
{
    /* 灰度值写成等值三通道即为"灰"。 */
    out_store(img, x, y, value, value, value);
}

void SCUT_OutImageSetRGB(int img, int x, int y, scut_u8 r, scut_u8 g, scut_u8 b)
{
    out_store(img, x, y, r, g, b);
}

scut_u8 SCUT_OutImageGet(int img, int x, int y)
{
    const scut_u8 *dst = out_buffer(img);
    int            w   = scut_bind_width();
    int            h   = scut_bind_height();
    const scut_u8 *p;

    if (dst == 0 || w <= 0 || h <= 0) {
        return 0;
    }
    if (x < 0 || x >= w || y < 0 || y >= h) {
        return 0;   /* 越界读返回 0，不返回未定义值 */
    }
    p = dst + (size_t)y * (size_t)w * 3u + (size_t)x * 3u;
    /* 灰度算法读取时给【亮度】（三通道不等时才有区别；
       等值时就是它自己，所以绝大多数调用方察觉不到这个选择）。 */
    return (scut_u8)(((scut_u32)p[0] * 299u + (scut_u32)p[1] * 587u
                      + (scut_u32)p[2] * 114u + 500u) / 1000u);
}

/* --------------------------------------------------------------------------
 *  把用户的结果图搬进环境输出图（图片1 由生成的接线单元调用，图片2 用户自己调）
 *
 *  ★ 为什么要单独提供它（而不是让用户用 SCUT_OutImageSet 逐点写）：
 *    逐点写每画一个像素都要一次边界检查与一次步长乘法；整幅搬运时这一圈
 *    纯属重复劳动。逐行搬运既更快，也让"这是一次搬运"这件事在代码里看得见。
 *    （两块图共用这一份：搬进图片1 顺便记账"本帧被写过"，
 *      搬进图片2 记账"这个功能被用过"，除此之外一模一样。）
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
 *  ★★ 为什么必须逐像素、不能 memcpy ★★
 *    用户的 src 是单通道灰度，而环境输出图是 RGB 三通道。
 *    memcpy 会把灰度字节当成 RGB 连续排下去，颜色通道全是错的；
 *    直接按 w*h 拷贝又只能填满前 1/3。两者都"看起来跑通了"，
 *    所以这里显式把每个灰度扩成等值三通道。
 *
 *  ★ 尺寸不匹配时按行裁剪而不是报错：
 *    用户数组尺寸来自它自己的宏，未必与本工程 config 完全一致。
 *    "少显示一部分"远好于"编译不过"或"越界写坏内存"。
 *
 *  ★ 两块图走同一段代码：搬到图片1 要额外记账"本帧被写过"（决定要不要铺
 *    默认底图），搬到图片2 要记账"这个功能被用过"（决定要不要多写一张图）。
 *    除了这两行，其余完全一样 —— 所以不给图片2 再抄一份循环。
 *
 *  参数：
 *      img    1 = 图片1，2 = 图片2
 *      src    用户结果数组首地址（按 row-major，即 src[y*w + x]）
 *      src_w  源行宽（像素）；0 表示用环境的宽度
 *      src_h  源行数；0 表示用环境的高度
 * -------------------------------------------------------------------------- */
void SCUT_EnvCopyOutput(int img, const scut_u8 *src, int src_w, int src_h)
{
    scut_u8 *dst;
    int w;
    int h;
    int cols;
    int x, y;

    if (src == 0) {
        return;
    }

    dst = out_buffer(img);
    w   = scut_bind_width();
    h   = scut_bind_height();
    if (dst == 0 || w <= 0 || h <= 0) {
        return;
    }

    if (src_w <= 0) { src_w = w; }
    if (src_h <= 0) { src_h = h; }

    /* 只搬两边都有的那部分 */
    if (src_w < w) { cols = src_w; } else { cols = w; }
    if (src_h < h) { h = src_h; }

    for (y = 0; y < h; y++) {
        const scut_u8 *src_row = src + (size_t)y * (size_t)src_w;
        scut_u8       *dst_row = dst + (size_t)y * (size_t)w * 3u;
        for (x = 0; x < cols; x++) {
            scut_u8 v = src_row[x];
            dst_row[(size_t)x * 3u + 0] = v;
            dst_row[(size_t)x * 3u + 1] = v;
            dst_row[(size_t)x * 3u + 2] = v;
        }
        /* 源比目标窄时，剩余区域填黑而不是留上一帧的残影 ——
         * 否则"换了张图反而看到旧内容"，属于最难解释的一类现象。 */
        for (x = cols; x < w; x++) {
            dst_row[(size_t)x * 3u + 0] = 0;
            dst_row[(size_t)x * 3u + 1] = 0;
            dst_row[(size_t)x * 3u + 2] = 0;
        }
    }

    /* 记账：搬进图片1 = 本帧算法直接写过最终画面（调度器据此不铺默认底图）；
     *       搬进图片2 = 这个功能被用过（后端据此多写一张图）。
     * ★ 搬运一定动了像素（哪怕只是填黑），所以两处都算"写过"。 */
    if (out_is_main(img)) {
        scut_draw_mark_output_written();
    } else {
        scut_bind_output2_mark();
    }
}

/* --------------------------------------------------------------------------
 *  图片2 每帧清黑（调度器在帧开头调用）
 *
 *  ★ 为什么每帧要清（而不是像车载显示缓冲那样自己维护）：
 *      残留比空白更容易误导 —— 算法这一帧没画，画面却还留着上一帧的内容，
 *      看起来就像"这一帧也算出了同样的结果"。清黑之后，"黑"只有一个含义：
 *      这一帧什么都没写。
 *  ★ 从没被写过的进程直接返回 —— 不必为一个用不到的功能每帧 memset 67 KB。
 *    一旦写过，之后每帧都清（"用过这项功能"不可逆）。
 * -------------------------------------------------------------------------- */
void scut_env_clear_second_output(void)
{
    scut_u8 *dst;
    int      w;
    int      h;

    if (!scut_bind_output2_used()) {
        return;
    }
    dst = scut_bind_output2();
    w   = scut_bind_width();
    h   = scut_bind_height();
    if (dst == 0 || w <= 0 || h <= 0) {
        return;
    }
    memset(dst, 0, (size_t)w * (size_t)h * 3u);
}
