/* ==========================================================================
 *  scut_frame.c —— 帧缓冲与图像解码实现
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 代码松耦合   → 只用 C 标准库；解码器自包含，不 vendor 任何第三方
 *    · 适应任意代码 → 尺寸全部运行时传入，本文件零编译期尺寸假设
 *    · 模拟单片机   → 无浮点、无 IO 依赖的算法核心；解码走整数运算
 *
 *  ★ 为什么解码器要自己写 BMP：
 *      目标是「static library 预编译一次，用户随便改 config」。
 *      一旦引入外部图像库，构建链就多一个必须能被交叉编译的依赖，
 *      单片机移植时也带不走。BMP 未压缩格式解析只需几十行整数代码，
 *      却能覆盖本项目最主要的用途：把现成的测试图喂进仿真。
 *      PNG/JPEG 交给后续的 stb_image 扩展（独立工作流），本文件只留接口。
 * ========================================================================== */

#include "scut_frame.h"
#include "scut_draw.h"   /* 释放缓冲时必须【撤销绘制绑定】，原因见 scut_frame_free */

#include <stdio.h>    /* FILE / fopen / fread / fseek / ftell */
#include <stdlib.h>   /* malloc / free */
#include <string.h>   /* memset */
#include <stdint.h>   /* SIZE_MAX */

/* ==========================================================================
 *  内部状态
 *  --------------------------------------------------------------------------
 *  全部零初始化 = 「未分配」。所有公开函数都必须在这个状态下安全返回，
 *  因为呈现后端有可能在 core_init 之前就被调用（顺序不保证）。
 * ========================================================================== */
static scut_u8  *s_gray    = NULL;
static scut_u32 *s_overlay = NULL;
static int       s_w       = 0;
static int       s_h       = 0;
static int       s_stride  = 0;   /* 行步长（字节 / u32 元素），当前恒等于 w */

/* ==========================================================================
 *  生命周期
 * ========================================================================== */

void scut_frame_free(void)
{
    /* ★★ 必须先撤销绘制模块的绑定，再 free ★★
     *
     * 这是本模块最重要的一处防御。绘制模块（scut_draw.c）是【静态变量】
     * 持有 gray/overlay 裸指针的，它没有、也不该有「帧缓冲生命周期」的概念。
     * 如果这里直接 free 而不解绑：
     *     用户调用顺序  alloc -> bind -> free -> SCUT_DrawPoint(...)
     *     就变成一次 use-after-free 堆写。它【不一定立刻崩】——
     *     取决于分配器是否已经把该块还给了别的代码，
     *     所以症状可能是「莫名其妙的数据被改坏」，而不是稳定崩溃，
     *     属于排查成本最高的一类缺陷。
     * 显式解绑把这个问题在源头消灭：free 之后所有绘制自动变成空操作。
     *
     * 注意这里【不需要】清理 frame 自己的指针 —— 紧接着的 free(NULL)
     * 是合法空操作，尺寸复位也在下面统一做。 */
    scut_draw_bind(NULL, NULL, 0, 0, 0);

    /* free(NULL) 是合法的空操作，所以这里不需要判断。
     * 复位尺寸同样重要：只释放指针却留着旧 w/h，
     * 会让「已释放」看起来像「还可用」，后续 composite 就会读野指针。 */
    free(s_gray);
    free(s_overlay);
    s_gray    = NULL;
    s_overlay = NULL;
    s_w       = 0;
    s_h       = 0;
    s_stride  = 0;
}

int scut_frame_alloc(int w, int h)
{
    scut_u8  *gray    = NULL;
    scut_u32 *overlay = NULL;
    size_t    pixels;

    /* ★ 先释放旧的，再分配新的。
     *   两个理由：
     *     (1) 反复 alloc 不泄漏 —— 用户改 config 里的尺寸后会重新 alloc；
     *     (2) 峰值内存更低 —— 不会同时持有新旧两块。 */
    scut_frame_free();

    if (w <= 0 || h <= 0) {
        return SCUT_FRAME_ERR_BADARG;
    }

    /* ★ 溢出防护（必须显式做，不能靠运气）：
     *   w * h 若在 size_t 上溢出，malloc 会拿到一个【很小】的尺寸并成功，
     *   随后按真实 w/h 写入就会越界堆写 —— 不崩溃、直接踩坏别的数据。
     *   这里用除法反向验证乘法，避免「先乘后查」（那个顺序已经错了）。 */
    if ((size_t)w > SIZE_MAX / sizeof(scut_u32)) {
        return SCUT_FRAME_ERR_BADARG;
    }
    pixels = (size_t)w * (size_t)h;
    if (pixels > SIZE_MAX / sizeof(scut_u32)) {
        return SCUT_FRAME_ERR_BADARG;
    }

    gray    = (scut_u8 *)malloc(pixels * sizeof(scut_u8));
    overlay = (scut_u32 *)malloc(pixels * sizeof(scut_u32));

    /* 任一失败都要把另一个也释放掉，并保持全局状态干净（不半分配）。 */
    if (gray == NULL || overlay == NULL) {
        free(gray);
        free(overlay);
        return SCUT_FRAME_ERR_BADARG;
    }

    /* 灰度清零：它是「输出结果图」，零 = 黑底，是符合直觉的初值，
     * 也让「源图比目标小」时未覆盖区域自然留黑。 */
    memset(gray, 0, pixels * sizeof(scut_u8));

    /* ★ 覆盖层【必须】初始化为透明哨兵，不能留 malloc 的垃圾值。
     *   哨兵高 8 位为 1，而合法颜色高 8 位恒为 0 —— 若这一层是未初始化内存，
     *   只要某个 u32 恰好不是 0xFFFFFFFF，合成时就会被当成「用户画的颜色」，
     *   在画面上撒出随机彩色噪点，而且随运行环境变化，极难复现。
     *   哨兵恰好全 1 字节，所以 memset 0xFF 既最快又语义正确。 */
    memset(overlay, 0xFF, pixels * sizeof(scut_u32));

    s_gray    = gray;
    s_overlay = overlay;
    s_w       = w;
    s_h       = h;
    /* 本模块的缓冲是紧凑排布的（二维数组语义），所以步长就是宽度。
     * 保留这个字段而不是到处写 s_w，是为了将来支持带 padding 的
     * 外部缓冲（对齐、DMA 友好）时只改一处。 */
    s_stride  = w;

    return SCUT_FRAME_OK;
}

scut_u8  *scut_frame_gray(void)    { return s_gray; }
scut_u32 *scut_frame_overlay(void) { return s_overlay; }
int       scut_frame_width(void)   { return s_w; }
int       scut_frame_height(void)  { return s_h; }

/* ==========================================================================
 *  亮度换算
 *
 *  ★ 系数沿用旧环境：0.299R + 0.587G + 0.114B（ITU-R BT.601 亮度）。
 *    保持一致性是刻意的：同一张图在旧新环境下灰度值接近，
 *    用户按旧环境调好的阈值/二值化参数不需要重调。
 *
 *  ★ 用整数定点实现（×1000）而不是浮点：
 *      - 单片机无 FPU 时浮点会拖慢甚至引入软浮点库；
 *      - 定点结果【逐像素确定】，不会因编译器/FPU 舍入模式不同而变，
 *        这样「仿真结果」与「车上结果」才具备可比性。
 *    +500 是四舍五入（而不是截断），避免整体偏暗半级。
 * ========================================================================== */
static scut_u8 scut_luma(scut_u32 r, scut_u32 g, scut_u32 b)
{
    /* 最大值 299*255 + 587*255 + 114*255 + 500 = 255500，
     * 远小于 u32 上限，无溢出风险。 */
    scut_u32 y = (299u * r + 587u * g + 114u * b + 500u) / 1000u;
    return (scut_u8)y;
}

/* ==========================================================================
 *  合成
 * ========================================================================== */

/* --------------------------------------------------------------------------
 *  通用合成：把【调用方指定的】覆盖层合成到 dst 上
 *
 *  ★★ 为什么这个函数必须显式接收 overlay，而不能去读本模块的 s_overlay ★★
 *
 *  本工程里覆盖层缓冲曾经（且当前仍然）在两处各自存在一份：
 *      · 本模块的 s_overlay（堆分配，由 scut_frame_overlay() 暴露）
 *      · bind 单元的 s_overlay（静态二维数组，由 scut_bind_overlay() 暴露）
 *  而 SCUT_DrawPoint 写的是【绘制模块当前绑定的那一块】，
 *  headless 宿主绑定的是 bind 那一块。于是「合成 s_overlay」这件事
 *  看起来天经地义，实际合成的却是一块【永远没人写过】的覆盖层 ——
 *  结果是所有标注静默消失：不报错、不崩溃、图像看着"正常"，
 *  只是空无一物。这正是本工程存在的意义所要消灭的那类缺陷。
 *
 *  所以这里刻意【不】读任何模块内部状态：
 *  两个缓冲都从参数进来，调用方必须明确说出"我要合成的是哪一对"。
 *  "合成了错误的 overlay" 因此在接口形状上就无从发生，
 *  而不是依赖读代码的人记得住有两块覆盖层。
 * -------------------------------------------------------------------------- */
void scut_composite_overlay(scut_u8 *dst, int dst_stride,
                            const scut_u32 *overlay, int w, int h)
{
    int x, y;

    /* ★ 参数校验：任一非法就【什么都不做】。
     *   本模块所有公开函数的契约都是「未准备好时安全空操作」，
     *   这样调用方（调度器）不必先判断一堆状态就能调用。 */
    if (dst == NULL || overlay == NULL) {
        return;
    }
    if (w <= 0 || h <= 0) {
        return;
    }
    /* ★ dst_stride < w 必须拒绝，不能"凑合按 w 用"：
     *   步长小于一行宽度意味着第 1 行起就与前一行重叠，
     *   写入不崩溃，只是画面错乱并互相覆盖 —— 又一类静默损坏。
     *   与 scut_draw_bind 的校验口径保持一致。 */
    if (dst_stride < w) {
        return;
    }

    for (y = 0; y < h; y++) {
        scut_u8        *dst_row = dst     + (size_t)y * (size_t)dst_stride;
        /* 覆盖层是紧凑排布的（二维数组语义），行步长恒等于 w。
         * ★ 与 dst 的 dst_stride 分开算：两者语义无关，
         *   若图省事共用一个步长，带 padding 的目标缓冲会逐行斜移。 */
        const scut_u32 *ovl_row = overlay + (size_t)y * (size_t)w;

        for (x = 0; x < w; x++) {
            scut_u32 c = ovl_row[x];

            if (c == SCUT_OVERLAY_NONE) {
                /* 透明：保留 dst 在该位置【原有】的灰度，不写。
                 *   不写而不是"从别处拷"是本函数的语义边界：
                 *   它只做合成，不搬移灰度 —— 灰度从哪来由调用方负责。 */
                continue;
            }

            /* 有色：按【亮度】折算成灰度。
             *
             * ★ 为什么不把颜色直接输出成彩色：
             *   输出缓冲是单通道 8 位，与 MT9V03X 灰度相机、
             *   车载 IPS 灰度屏一致。若这里输出彩色，
             *   仿真里鲜艳可辨的标注在真屏上根本无法显示 ——
             *   「仿真通过、上车抓瞎」正是要避免的一类问题。
             *   需要真彩预览时，呈现层可另读覆盖层单独渲染，
             *   本函数不承担这个职责。 */
            {
                scut_u32 r =  c        & 0xFFu;         /* 0x00BBGGRR */
                scut_u32 g = (c >>  8) & 0xFFu;
                scut_u32 b = (c >> 16) & 0xFFu;
                dst_row[x] = scut_luma(r, g, b);
            }
        }
    }
}

/* --------------------------------------------------------------------------
 *  兼容入口：把【本模块自己的】frame_overlay 合成到 dst
 *
 *  实现已在 scut_composite_overlay 之上重建，行为与历史版本逐像素一致：
 *      · 透明像素 → dst 取【本模块灰度图 src】的值（即先整体拷贝灰度）
 *      · 有色像素 → dst 取该颜色的亮度
 *  即语义 = 「把 s_gray 连同覆盖层一起输出到 dst」。
 *  因此这里的步骤刻意是「先搬灰度、再合成覆盖层」：
 *  通用合成函数本身【不搬移灰度】（它只保留 dst 原值），
 *  少了这一步，dst != s_gray 的调用方会拿到一张没被灰度填充的图。
 *
 *  ★ 再次强调本函数的局限：它只认本模块的 s_overlay。
 *    绘制若写在别处（bind 单元那份），必须直接用 scut_composite_overlay。
 * -------------------------------------------------------------------------- */
void scut_frame_composite(scut_u8 *dst, int dst_stride)
{
    int y;

    /* 未分配 / 参数非法：直接返回，不做任何事。
     * 这是「所有函数在 alloc 之前调用都安全」这条契约的体现。 */
    if (s_gray == NULL || s_overlay == NULL || dst == NULL) {
        return;
    }
    if (s_w <= 0 || s_h <= 0 || dst_stride < s_w) {
        return;
    }

    /* 第一步：把源灰度搬到目标缓冲。
     * 源与目标的步长【分开算】：目标可能是带 padding 的显示缓冲，
     * 其 stride != 帧的 stride。若图省事只用一个步长，
     * 画面会从第二行起整体斜移。 */
    for (y = 0; y < s_h; y++) {
        const scut_u8 *src_row = s_gray + (size_t)y * (size_t)s_stride;
        scut_u8       *dst_row = dst    + (size_t)y * (size_t)dst_stride;

        memcpy(dst_row, src_row, (size_t)s_w);
    }

    /* 第二步：把覆盖层合成上去（透明像素保留刚搬过来的灰度）。 */
    scut_composite_overlay(dst, dst_stride, s_overlay, s_w, s_h);
}

/* ==========================================================================
 *  BMP 解码
 *
 *  支持范围（刻意收窄，够用即可）：
 *      · BITMAPINFOHEADER 及更大的 DIB 头（>= 40 字节，前 40 字节兼容）
 *      · 24 位 BGR（BI_RGB）
 *      · 8 位调色板（BI_RGB）
 *      · 正高度 = 自下而上；负高度 = 自上而下
 *      · 行按 4 字节对齐（这是 BMP 最容易踩的坑之一）
 *
 *  不支持：RLE 压缩、BITFIELDS、BITMAPCOREHEADER(12)。
 *      这些在「导出一张测试图」的场景里极少出现；明确拒绝比
 *      悄悄解错要好 —— 解错的图会让人怀疑算法，浪费大量时间。
 * ========================================================================== */

/* BMP 固定偏移（相对于文件头 0 字节） */
#define BMP_OFF_SIGNATURE   0    /* 2 字节 "BM" */
#define BMP_OFF_FILESIZE    2
#define BMP_OFF_DATAOFF    10    /* bfOffBits：像素数据起始偏移 */
#define BMP_OFF_DIBSIZE    14    /* DIB 头大小 */

/* BITMAPINFOHEADER 字段（相对 DIB 头起点 14 字节） */
#define BMP_DIB_SIZE        0
#define BMP_DIB_WIDTH       4
#define BMP_DIB_HEIGHT      8
#define BMP_DIB_PLANES     12
#define BMP_DIB_BITCOUNT   14
#define BMP_DIB_COMPRESS   16
#define BMP_DIB_CLRUSED    32

#define BMP_MIN_DIB_HEADER 40    /* 只接受 BITMAPINFOHEADER 及以上 */

/* 小端读取辅助。
 *
 * ★ 为什么不用 #pragma pack 结构体直接映射：
 *   结构体映射依赖编译器的对齐/填充规则，且在大端平台上会静默读错字节序。
 *   显式逐字节组装没有任何平台假设，也不产生未对齐访问（在某些 ARM 上
 *   未对齐访问会硬件异常，而不是慢一点）。 */
static scut_u32 scut_rd_u32le(const scut_u8 *p)
{
    return  (scut_u32)p[0]
         | ((scut_u32)p[1] <<  8)
         | ((scut_u32)p[2] << 16)
         | ((scut_u32)p[3] << 24);
}

static scut_u16 scut_rd_u16le(const scut_u8 *p)
{
    return (scut_u16)((scut_u32)p[0] | ((scut_u32)p[1] << 8));
}

/* 带符号 32 位小端读取。
 * ★ 不写成 (scut_i32)scut_rd_u32le(p)：当数值 > INT32_MAX 时，
 *   该转换结果是实现定义行为。虽然现实中都是二补数回绕，
 *   但既然是好写的几行代码，就不留这个隐患。 */
static scut_i32 scut_rd_i32le(const scut_u8 *p)
{
    scut_u32 u = scut_rd_u32le(p);
    if (u >= 0x80000000u) {
        /* -1 - (2^32 - 1 - u) 形式避免任何中间步骤溢出 */
        return -(scut_i32)(0xFFFFFFFFu - u) - 1;
    }
    return (scut_i32)u;
}

/* 读入整个文件。成功返回 0，`*out` 由 malloc 得到（调用方负责 free）。 */
static int scut_read_file(const char *path, scut_u8 **out, size_t *out_size)
{
    FILE  *fp;
    long   size;
    scut_u8 *buf;
    size_t got;

    fp = fopen(path, "rb");
    if (fp == NULL) {
        return SCUT_FRAME_ERR_OPEN;
    }

    if (fseek(fp, 0, SEEK_END) != 0) {
        fclose(fp);
        return SCUT_FRAME_ERR_READ;
    }
    size = ftell(fp);
    if (size <= 0) {
        /* 空文件 / ftell 失败：都当成读失败。
         * 空文件不可能是有效 BMP，早退可以少一层判断。 */
        fclose(fp);
        return SCUT_FRAME_ERR_READ;
    }
    if (fseek(fp, 0, SEEK_SET) != 0) {
        fclose(fp);
        return SCUT_FRAME_ERR_READ;
    }

    buf = (scut_u8 *)malloc((size_t)size);
    if (buf == NULL) {
        fclose(fp);
        return SCUT_FRAME_ERR_READ;
    }

    got = fread(buf, 1, (size_t)size, fp);
    fclose(fp);

    if (got != (size_t)size) {
        /* 短读：文件被截断或 IO 出错。必须检查 ——
         * 不检查的话后面会按声明的尺寸去读未初始化的堆内存。 */
        free(buf);
        return SCUT_FRAME_ERR_READ;
    }

    *out      = buf;
    *out_size = (size_t)size;
    return SCUT_FRAME_OK;
}

/* --------------------------------------------------------------------------
 *  判断已读入内存的数据是 PNG 还是 JPEG。
 *  返回 2 = PNG，1 = JPEG，0 = 都不是。
 *
 *  ★ 返回值从「非零即命中」改成 0/1/2，是本轮功能的需要：
 *      PNG 已由本文件自带的解码器原生支持，必须与「仍不支持的 JPEG」
 *      在 load_image 里走不同分支。原来那个布尔语义会让 PNG 与 JPEG
 *      混在同一条"不支持"路径上 —— 而正是那条分支要被替换。
 * -------------------------------------------------------------------------- */
static int scut_looks_like_png_or_jpeg(const scut_u8 *d, size_t n)
{
    if (n >= 8 && d[0] == 0x89u && d[1] == 0x50u &&   /* \x89 P */
        d[2] == 0x4Eu && d[3] == 0x47u) {             /* N G */
        return 2;
    }
    if (n >= 2 && d[0] == 0xFFu && d[1] == 0xD8u) {   /* JPEG SOI */
        return 1;
    }
    return 0;
}

/* 解码一个已读入内存的 BMP，写入 dst。 */
static int scut_bmp_decode(const scut_u8 *data, size_t size,
                           scut_u8 *dst, int w, int h, int stride)
{
    scut_u32 dib_size, data_off, compression, clr_used;
    scut_i32 width_i, height_i;
    /* ★ 局部名刻意【不】用 s_w / s_h：
     *   本文件的 static s_w/s_h 是「当前帧尺寸」的全局状态，
     *   而这里描述的是【源图】尺寸，两者语义完全不同。
     *   同名会让 -Wshadow 报警，更重要的是读代码的人极易把二者混淆，
     *   进而在适配逻辑里误用（比如用源宽去索引目标缓冲）。
     *   用 src_w/src_h 让「源」与「目标」在名字上就分得开。 */
    int      src_w, src_h, bottom_up, bits;
    size_t   row_size, palette_off, palette_bytes;
    int      copy_w, copy_h, x_off, y_off;
    int      x, y;

    if (size < 26) {
        return SCUT_FRAME_ERR_NOT_BMP;   /* 连文件头都放不下 */
    }
    if (data[BMP_OFF_SIGNATURE] != 'B' || data[BMP_OFF_SIGNATURE + 1] != 'M') {
        return SCUT_FRAME_ERR_NOT_BMP;
    }

    data_off   = scut_rd_u32le(data + BMP_OFF_DATAOFF);
    dib_size   = scut_rd_u32le(data + BMP_OFF_DIBSIZE);

    /* ★ 只认 >= 40 的 DIB 头。
     *   BITMAPCOREHEADER(12) 的字段宽度和偏移都不同（16 位宽高、
     *   3 字节调色板项），若按 40 字节的规则去解会读出完全错误的值 ——
     *   而且往往仍能"解出"一张乱七八糟的图，比直接报错恶劣得多。 */
    if (dib_size < BMP_MIN_DIB_HEADER) {
        return SCUT_FRAME_ERR_BMP_HEADER;
    }
    if (size < BMP_OFF_DIBSIZE + BMP_MIN_DIB_HEADER) {
        return SCUT_FRAME_ERR_BMP_TRUNCATED;
    }

    width_i  = scut_rd_i32le(data + BMP_OFF_DIBSIZE + BMP_DIB_WIDTH);
    height_i = scut_rd_i32le(data + BMP_OFF_DIBSIZE + BMP_DIB_HEIGHT);

    /* 宽度必须为正；高度为 0 无意义。负宽度不是任何合法 BMP 的写法。 */
    if (width_i <= 0 || height_i == 0) {
        return SCUT_FRAME_ERR_BMP_HEADER;
    }

    /* ★ 高度符号决定行序：正 = 自下而上（BMP 的历史默认），负 = 自上而下。
     *   搞反是最典型的 BMP bug：图像上下颠倒，但其他一切正常，
     *   很容易被误判成"相机装反了"或"坐标系错了"。 */
    bottom_up = (height_i > 0) ? 1 : 0;
    src_h     = (height_i > 0) ? (int)height_i : (int)(-height_i);
    src_w     = (int)width_i;

    if (scut_rd_u16le(data + BMP_OFF_DIBSIZE + BMP_DIB_PLANES) != 1u) {
        return SCUT_FRAME_ERR_BMP_HEADER;   /* planes 必须是 1 */
    }

    bits = (int)scut_rd_u16le(data + BMP_OFF_DIBSIZE + BMP_DIB_BITCOUNT);
    if (bits != 24 && bits != 8) {
        return SCUT_FRAME_ERR_BMP_HEADER;
    }

    compression = scut_rd_u32le(data + BMP_OFF_DIBSIZE + BMP_DIB_COMPRESS);
    if (compression != 0u) {
        /* 0 = BI_RGB（未压缩）。RLE(1,2) 与 BITFIELDS(3) 明确拒绝。
         * 尤其是 3：16/32 位图常见，若强行按 BI_RGB 解会得到花屏。 */
        return SCUT_FRAME_ERR_BMP_COMPRESSION;
    }

    /* ★ 行按 4 字节对齐：BMP 每行都要补齐到 4 的倍数。
     *   漏掉这一步的后果非常典型 —— 图像从第二行起逐行斜切，
     *   看起来像"扫描线错位"，而不是像"读错了格式"。
     *   188*3 = 564 恰好是 4 的倍数，所以 188 宽的 24 位图【看不出】
     *   这个 bug，一旦换成 189 宽就立刻暴露：这种"在默认尺寸下正常"
     *   的缺陷必须靠公式而不是测试图来保证。 */
    row_size = ((size_t)src_w * (size_t)bits + 31u) / 32u * 4u;

    palette_off   = BMP_OFF_DIBSIZE + (size_t)dib_size;
    palette_bytes = 0;
    if (bits == 8) {
        clr_used = scut_rd_u32le(data + BMP_OFF_DIBSIZE + BMP_DIB_CLRUSED);
        /* biClrUsed == 0 表示"用满 2^bpp 项"，即 256 项 */
        if (clr_used == 0u) {
            clr_used = 256u;
        }
        if (clr_used > 256u) {
            return SCUT_FRAME_ERR_BMP_PALETTE;
        }
        palette_bytes = (size_t)clr_used * 4u;   /* 每项 BGRA 共 4 字节 */
        if (palette_off + palette_bytes > size) {
            return SCUT_FRAME_ERR_BMP_PALETTE;
        }
    }

    /* 越界校验：像素区必须完整落在文件内。
     * 先做乘法的溢出检查，再看边界 —— 顺序反了等于没检查。 */
    if (src_h > 0 && row_size > (SIZE_MAX - data_off) / (size_t)src_h) {
        return SCUT_FRAME_ERR_BMP_TRUNCATED;
    }
    if (data_off > size || row_size * (size_t)src_h > size - data_off) {
        return SCUT_FRAME_ERR_BMP_TRUNCATED;
    }

    /* ------------------------------------------------------------------
     *  尺寸适配：居中裁剪 / 左上对齐
     * ------------------------------------------------------------------ */
    copy_w = (src_w < w) ? src_w : w;
    copy_h = (src_h < h) ? src_h : h;
    x_off  = (src_w - copy_w) / 2;   /* 源更大时居中；否则为 0（左上） */
    y_off  = (src_h - copy_h) / 2;

    for (y = 0; y < copy_h; y++) {
        int          src_row = y_off + y;
        const scut_u8 *row;

        /* 自下而上的图要翻转行号才能得到期望的视觉顺序 */
        if (bottom_up) {
            src_row = src_h - 1 - src_row;
        }
        row = data + data_off + (size_t)src_row * row_size;

        for (x = 0; x < copy_w; x++) {
            int    src_x = x_off + x;
            scut_u8 gray;

            if (bits == 24) {
                /* BMP 存的是 BGR，不是 RGB —— 顺序写反会让红蓝互换，
                 * 单看灰度图未必发现，但会导致"红色框灰度值不对"。 */
                const scut_u8 *px = row + (size_t)src_x * 3u;
                gray = scut_luma((scut_u32)px[2],   /* R */
                                 (scut_u32)px[1],   /* G */
                                 (scut_u32)px[0]);  /* B */
            } else {
                scut_u32 idx = (scut_u32)row[src_x];
                const scut_u8 *pal = data + palette_off + (size_t)idx * 4u;
                /* 调色板项也是 BGR 顺序（第 4 字节保留不用）。
                 * idx 已由 u8 保证 < 256，但仍要防止 clr_used < 256 时越界。 */
                if ((size_t)idx * 4u + 4u > palette_bytes) {
                    return SCUT_FRAME_ERR_BMP_PALETTE;
                }
                gray = scut_luma((scut_u32)pal[2],   /* R */
                                 (scut_u32)pal[1],   /* G */
                                 (scut_u32)pal[0]);  /* B */
            }

            /* 目标步长独立于源行步长：两者之间没有任何关系，
             * 混用会把图像写成斜的。 */
            dst[(size_t)y * (size_t)stride + (size_t)x] = gray;
        }
    }

    /* 源图比目标小的那些区域【刻意不动】：
     * 保留 dst 的原值，让调用方自行决定背景（例如填中灰而非黑），
     * 因为"用什么颜色当空白"是显示策略，不是解码器的职责。 */
    return SCUT_FRAME_OK;
}

/* ==========================================================================
 *  PNG 解码（自带 inflate）
 *  --------------------------------------------------------------------------
 *  ★ 为什么 PNG 也自己写：
 *      与 BMP 同一个理由 —— 环境必须「零第三方依赖」，交叉编译链上
 *      不允许出现一个必须一起搬的 zlib。PNG 的主体是
 *          zlib 包装（RFC 1950）+ deflate（RFC 1951）+ 逐行反滤波，
 *      全是整数算法，数百行 C 就能覆盖本项目实际会用到的子集：
 *          · bit depth 8
 *          · 颜色类型 0（灰度）/ 2（真彩色 RGB）/ 3（调色板，经 PLTE）
 *          · 非交织（interlace 0）
 *          · 滤波 0..4（None/Sub/Up/Average/Paeth）
 *          · 多个 IDAT（先拼接再解压 —— 这是 PNG 的常态而非例外）
 *      子集之外的变体（16 位色深、RGBA、Adam7 交织……）一律
 *      【带具体原因的中文报错】，绝不"猜着解"——
 *      解错的图会让人怀疑自己的算法，比直接报错恶劣得多（与 BMP 同一取向）。
 *
 *  ★ 压缩链路上的校验一个都不省：
 *      IHDR/PLTE/IDAT/IEND 的 CRC32、zlib 流尾的 Adler-32。
 *      坏图必须在这里被拦下，而不是变成半张花屏后静默输出。
 * ========================================================================== */

/* PNG 签名（89 50 4E 47 0D 0A 1A 0A） */
#define PNG_SIG_SIZE 8

/* 关键块类型（多字母码按大端打包成 u32） */
#define PNG_CK_IHDR 0x49484452u   /* "IHDR" */
#define PNG_CK_PLTE 0x504C5445u   /* "PLTE" */
#define PNG_CK_IDAT 0x49444154u   /* "IDAT" */
#define PNG_CK_IEND 0x49454E44u   /* "IEND" */

/* 支持的图像边长上限。PNG 规范允许到 2^31-1，但「模拟单片机」的取向
 * 决定了我们不接受GB 级的声明尺寸：过大的值多半是坏文件，
 * 与其让 malloc 失败后报"内存不足"，不如在这里就报"尺寸超出支持范围"。 */
#define PNG_MAX_DIM 32767

/* 大端读取辅助（PNG 的整数都是大端，与 BMP 的小端相反）。 */
static scut_u32 scut_rd_u32be(const scut_u8 *p)
{
    return ((scut_u32)p[0] << 24)
         | ((scut_u32)p[1] << 16)
         | ((scut_u32)p[2] <<  8)
         |  (scut_u32)p[3];
}

/* --------------------------------------------------------------------------
 *  CRC-32（ISO 3309 / ITU-T V.42，PNG 规范用的那张表）
 *  每字节查表，表在首次使用时生成 —— 避免手写 256 项常量表。
 * -------------------------------------------------------------------------- */
static scut_u32 png_crc_table[256];
static int      png_crc_ready = 0;

static void png_crc32_init(void)
{
    scut_u32 c;
    int      n, k;

    if (png_crc_ready) {
        return;
    }
    for (n = 0; n < 256; n++) {
        c = (scut_u32)n;
        for (k = 0; k < 8; k++) {
            c = (c & 1u) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        }
        png_crc_table[n] = c;
    }
    png_crc_ready = 1;
}

static scut_u32 png_crc32(scut_u32 crc, const scut_u8 *buf, size_t len)
{
    scut_u32 c = crc ^ 0xFFFFFFFFu;
    size_t   i;

    for (i = 0; i < len; i++) {
        c = png_crc_table[(c ^ buf[i]) & 0xFFu] ^ (c >> 8);
    }
    return c ^ 0xFFFFFFFFu;
}

/* --------------------------------------------------------------------------
 *  Adler-32（RFC 1950 的流尾校验）
 *  ★ 模 65521 逐字节做即可：本项目图像的解压结果最多几十万字节，
 *    性能不是问题；正确性优先于速度。
 * -------------------------------------------------------------------------- */
static scut_u32 png_adler32(const scut_u8 *buf, size_t len)
{
    scut_u32 a = 1u;
    scut_u32 b = 0u;
    size_t   i;

    for (i = 0; i < len; i++) {
        a = (a + buf[i]) % 65521u;
        b = (b + a) % 65521u;
    }
    return (b << 16) | a;
}

/* --------------------------------------------------------------------------
 *  位读取器（deflate 的位序：LSB 在前）
 *  ★ 用「位位置」而不是「字节位置 + 位缓冲」来记状态：
 *    这样"跳到字节边界"（存储块前）只是 bitpos 的对齐运算，
 *    不存在"缓冲里还剩半个字节没吐出来"的歧义 —— 那正是手写
 *    inflate 最常见的错位来源。逐位取值慢不了多少（本项目的图
 *    解压后只有几十 KB），换来的正确性是确定的。
 * -------------------------------------------------------------------------- */
typedef struct {
    const scut_u8 *data;
    size_t         size;      /* 字节数 */
    size_t         bitpos;    /* 当前位位置 */
    int            over;      /* 越界后置位：后续读取一律失败 */
} png_bitrd;

/* 读 need 位（0..16）。数据不足返回 -1（over 置位）。 */
static int png_bits(png_bitrd *br, int need)
{
    scut_u32 val = 0;
    int      got;

    if (need <= 0) {
        return 0;
    }
    if (br->over || br->bitpos + (size_t)need > br->size * 8u) {
        br->over = 1;
        return -1;
    }
    for (got = 0; got < need; got++) {
        size_t bit = br->bitpos + (size_t)got;
        if ((br->data[bit >> 3] >> (int)(bit & 7u)) & 1u) {
            val |= 1u << got;
        }
    }
    br->bitpos += (size_t)need;
    return (int)val;
}

/* --------------------------------------------------------------------------
 *  规范 Huffman（RFC 1951 3.2.2）
 *  ★ 解码用「逐位走 Kraft 边界」而不是查大表：
 *      表驱动解码要预分配 2^15 槽位或做二级表，代码量与出错面都大；
 *      逐位法每符号最多 15 次循环，对本项目的图完全够快。
 * -------------------------------------------------------------------------- */
typedef struct {
    scut_u16 count[16];      /* 各码长的符号个数 */
    scut_u16 sym[288];       /* 按码长排序的符号值 */
} png_huff;

/* 由码长表构造规范 Huffman。返回 0 成功；-1 = 超订阅（码空间已卖光）。
 * 不完整码（left>0）不算错：距离树只含 1 个符号时 RFC 1951 允许，
 * 空/残缺的表会在真正解码到它时以「读不出符号」自然失败。 */
static int png_huff_build(png_huff *h, const scut_u8 *lengths, int n)
{
    int i;
    int left;
    int offs[16];

    for (i = 0; i < 16; i++) {
        h->count[i] = 0;
    }
    for (i = 0; i < n; i++) {
        h->count[lengths[i]]++;
    }
    /* Kraft 不等式逐层验证：left<0 = 超订阅。这样的表会让同一个
     * 位串解出错误符号而不自知 —— 必须在这里拒绝。 */
    left = 1;
    for (i = 1; i < 16; i++) {
        left <<= 1;
        left -= h->count[i];
        if (left < 0) {
            return -1;
        }
    }
    offs[1] = 0;
    for (i = 1; i < 15; i++) {
        offs[i + 1] = offs[i] + h->count[i];
    }
    for (i = 0; i < n; i++) {
        if (lengths[i] != 0) {
            h->sym[offs[lengths[i]]++] = (scut_u16)i;
        }
    }
    return 0;
}

/* 解一个符号。失败（数据不足 / 码无效）返回 -1。 */
static int png_huff_decode(const png_huff *h, png_bitrd *br)
{
    int code  = 0;
    int first = 0;
    int index = 0;
    int len;

    for (len = 1; len <= 15; len++) {
        int b = png_bits(br, 1);
        int count;

        if (b < 0) {
            return -1;
        }
        code |= b;
        count = h->count[len];
        if (code - first < count) {
            return h->sym[index + (code - first)];
        }
        index += count;
        first  = (first + count) << 1;
        code <<= 1;
    }
    return -1;      /* 15 位都读满仍未命中：码长超限，流必是坏的 */
}

/* 静态 Huffman 表（BTYPE=01）。码长按 RFC 1951 3.2.6 的固定划分。 */
static int png_fixed_tables(png_huff *lit, png_huff *dist)
{
    scut_u8 lengths[288];
    int     i;

    for (i = 0;   i < 144; i++) { lengths[i] = 8; }
    for (;        i < 256; i++) { lengths[i] = 9; }
    for (;        i < 280; i++) { lengths[i] = 7; }
    for (;        i < 288; i++) { lengths[i] = 8; }
    if (png_huff_build(lit, lengths, 288) != 0) {
        return -1;
    }
    for (i = 0; i < 30; i++) { lengths[i] = 5; }
    if (png_huff_build(dist, lengths, 30) != 0) {
        return -1;
    }
    return 0;
}

/* 长度 / 距离码的基值与附加位（RFC 1951 3.2.5 的两张表）。 */
static const scut_u16 png_len_base[29] = {
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
};
static const scut_u8 png_len_extra[29] = {
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
};
static const scut_u16 png_dist_base[30] = {
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
    8193, 12289, 16385, 24577
};
static const scut_u8 png_dist_extra[30] = {
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
};

/* 码长字母表的传输顺序（RFC 1951 3.2.7） */
static const scut_u8 png_clc_order[19] = {
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
};

/* 动态 Huffman 表（BTYPE=10）：读 HLIT/HDIST/HCLEN + 码长 RLE。 */
static int png_dynamic_tables(png_bitrd *br, png_huff *lit, png_huff *dist)
{
    scut_u8  lengths[320];      /* 286 字面/长度 + 30 距离 的最大规模 */
    scut_u8  cl_lens[19];
    png_huff clh;
    int      hlit, hdist, hclen;
    int      i, n;

    hlit = png_bits(br, 5);
    if (hlit < 0) { return -1; }
    hlit += 257;
    if (hlit > 286) { return -1; }      /* RFC 1951：字面/长度符号最多 286 个 */

    hdist = png_bits(br, 5);
    if (hdist < 0) { return -1; }
    hdist += 1;
    if (hdist > 30) { return -1; }

    hclen = png_bits(br, 4);
    if (hclen < 0) { return -1; }
    hclen += 4;

    memset(cl_lens, 0, sizeof(cl_lens));
    for (i = 0; i < hclen; i++) {
        int v = png_bits(br, 3);
        if (v < 0) { return -1; }
        cl_lens[png_clc_order[i]] = (scut_u8)v;
    }
    if (png_huff_build(&clh, cl_lens, 19) != 0) {
        return -1;
    }

    /* 码长序列本身也做了 RLE（sym 16/17/18 = 复制/短零/长零串） */
    n = 0;
    while (n < hlit + hdist) {
        int sym = png_huff_decode(&clh, br);

        if (sym < 0) { return -1; }
        if (sym < 16) {
            lengths[n++] = (scut_u8)sym;
        } else {
            int rep, val;

            if (sym == 16) {
                if (n == 0) { return -1; }      /* 没有前值可复制 */
                val = lengths[n - 1];
                rep = png_bits(br, 2);
                if (rep < 0) { return -1; }
                rep += 3;
            } else if (sym == 17) {
                val = 0;
                rep = png_bits(br, 3);
                if (rep < 0) { return -1; }
                rep += 3;
            } else {                            /* sym == 18 */
                val = 0;
                rep = png_bits(br, 7);
                if (rep < 0) { return -1; }
                rep += 11;
            }
            if (n + rep > hlit + hdist) {
                return -1;                      /* 重复串越过表尾：流已坏 */
            }
            while (rep-- > 0) {
                lengths[n++] = (scut_u8)val;
            }
        }
    }

    /* 没有 EOB（符号 256）的字面表永远终止不了，必须拒绝。 */
    if (lengths[256] == 0) {
        return -1;
    }
    if (png_huff_build(lit, lengths, hlit) != 0) {
        return -1;
    }
    if (png_huff_build(dist, lengths + hlit, hdist) != 0) {
        return -1;
    }
    return 0;
}

/* 解一个 Huffman 块：字面量 / EOB / <长度,距离> 对，直到 EOB。 */
static int png_inflate_block(png_bitrd *br, const png_huff *lit,
                             const png_huff *dist,
                             scut_u8 *out, size_t out_cap, size_t *produced)
{
    for (;;) {
        int sym = png_huff_decode(lit, br);

        if (sym < 0) {
            return -1;
        }
        if (sym < 256) {
            /* 字面字节。输出空间在写入【前】检查：
             * 解压结果比声明的图像数据还大，说明流是伪造的。 */
            if (*produced >= out_cap) {
                return -1;
            }
            out[(*produced)++] = (scut_u8)sym;
        } else if (sym == 256) {
            return 0;                       /* 块结束 */
        } else {
            int length, dcode, distv, i;

            sym -= 257;
            if (sym >= 29) {
                return -1;                  /* 286/287 是 RFC 1951 禁用码 */
            }
            length = png_len_base[sym];
            if (png_len_extra[sym] != 0) {
                int e = png_bits(br, png_len_extra[sym]);
                if (e < 0) { return -1; }
                length += e;
            }

            dcode = png_huff_decode(dist, br);
            if (dcode < 0 || dcode >= 30) {
                return -1;                  /* 30/31 同样禁用 */
            }
            distv = png_dist_base[dcode];
            if (png_dist_extra[dcode] != 0) {
                int e = png_bits(br, png_dist_extra[dcode]);
                if (e < 0) { return -1; }
                distv += e;
            }

            /* ★ LZ77 三道边界检查，缺一不可：
             *   ① 引用不得早于输出起点（dist > 已产出 = 流损坏）；
             *   ② 拷贝不得越过输出容量（防越界写，与字面分支同理）；
             *   ③ 拷贝必须逐字节进行 —— 源与目标允许重叠（dist < length），
             *     这是 deflate 表达 RLE 的常态，绝不能用 memcpy。 */
            if ((size_t)distv > *produced) {
                return -1;
            }
            if ((size_t)length > out_cap - *produced) {
                return -1;
            }
            for (i = 0; i < length; i++) {
                out[*produced] = out[*produced - (size_t)distv];
                (*produced)++;
            }
        }
    }
}

/* --------------------------------------------------------------------------
 *  inflate 主体：逐块解 BFINAL/BTYPE，分发到 存储/静态/动态 三种块。
 *  返回 SCUT_FRAME_OK 或 PNG_* 错误码（直接带原因，调用方不用再猜）。
 * -------------------------------------------------------------------------- */
static int png_inflate(const scut_u8 *in, size_t in_size,
                       scut_u8 *out, size_t out_cap, size_t *out_len)
{
    png_bitrd br;
    size_t    produced = 0;
    int       bfinal;

    br.data   = in;
    br.size   = in_size;
    br.bitpos = 0;
    br.over   = 0;

    do {
        int      type;
        png_huff lit;
        png_huff dist;

        bfinal = png_bits(&br, 1);
        type   = png_bits(&br, 2);
        if (bfinal < 0 || type < 0) {
            return SCUT_FRAME_ERR_PNG_INFLATE;      /* 流提前结束 */
        }
        if (type == 3) {
            return SCUT_FRAME_ERR_PNG_INFLATE;      /* RFC 1951 禁用的块类型 */
        }

        if (type == 0) {
            /* ---- 存储块：对齐到字节边界后是 LEN/NLEN + 原文 ---- */
            size_t len, nlen;

            br.bitpos = (br.bitpos + 7u) & ~(size_t)7u;
            if ((br.size * 8u) - br.bitpos < 32u) {
                return SCUT_FRAME_ERR_PNG_TRUNCATED;    /* 连 LEN/NLEN 都放不下 */
            }
            {
                size_t p = br.bitpos >> 3;
                len  = (size_t)in[p]     | ((size_t)in[p + 1] << 8);
                nlen = (size_t)in[p + 2] | ((size_t)in[p + 3] << 8);
            }
            br.bitpos += 32u;
            if ((len ^ 0xFFFFu) != nlen) {
                return SCUT_FRAME_ERR_PNG_INFLATE;      /* LEN/NLEN 互校验失败 */
            }
            if (len > (br.size * 8u - br.bitpos) / 8u ||
                produced + len > out_cap) {
                return SCUT_FRAME_ERR_PNG_TRUNCATED;
            }
            memcpy(out + produced, in + (br.bitpos >> 3), len);
            br.bitpos += len * 8u;
            produced  += len;
        } else {
            int ok;

            if (type == 1) {
                ok = png_fixed_tables(&lit, &dist);
            } else {
                ok = png_dynamic_tables(&br, &lit, &dist);
            }
            if (ok != 0) {
                return SCUT_FRAME_ERR_PNG_INFLATE;
            }
            if (png_inflate_block(&br, &lit, &dist, out, out_cap, &produced) != 0) {
                return SCUT_FRAME_ERR_PNG_INFLATE;
            }
        }
    } while (!bfinal);

    *out_len = produced;
    return SCUT_FRAME_OK;
}

/* --------------------------------------------------------------------------
 *  chunk 遍历。返回 1 = 取到一个块；0 = 干净地走到文件尾；
 *  -1 = 块被截断（声明长度越界）。边界全部用减法判断，
 *  避免「极大的 chunk_len 回绕成一个看起来合法的小值」。
 * -------------------------------------------------------------------------- */
typedef struct {
    const scut_u8 *data;
    size_t         size;
    size_t         pos;         /* 下一个块头（长度字段）的位置 */
    scut_u32       chunk_len;
    scut_u32       chunk_type;
    size_t         chunk_data;  /* 数据区起始下标 */
} png_chunk;

static int png_chunk_next(png_chunk *ck)
{
    size_t avail;

    if (ck->size < ck->pos) {
        return 0;
    }
    avail = ck->size - ck->pos;
    if (avail < 8u) {
        return 0;               /* 剩余不足一个块头：当作文件结束 */
    }
    ck->chunk_len  = scut_rd_u32be(ck->data + ck->pos);
    ck->chunk_type = scut_rd_u32be(ck->data + ck->pos + 4u);
    ck->chunk_data = ck->pos + 8u;
    if (avail < 12u) {
        return -1;              /* 连「空数据块 + CRC」都放不下 */
    }
    if (ck->chunk_len > avail - 12u) {
        return -1;              /* 数据区 + CRC 超出文件：块被截断 */
    }
    ck->pos = ck->chunk_data + (size_t)ck->chunk_len + 4u;
    return 1;
}

/* 校验当前块的 CRC32（覆盖「类型 + 数据」）。仅在边界已验证的块上调用。 */
static int png_chunk_crc_ok(const png_chunk *ck)
{
    scut_u32 crc, want;

    png_crc32_init();
    crc  = png_crc32(0u, ck->data + ck->chunk_data - 4u,
                     (size_t)ck->chunk_len + 4u);
    want = scut_rd_u32be(ck->data + ck->chunk_data + ck->chunk_len);
    return crc == want;
}

/* --------------------------------------------------------------------------
 *  PNG 解码入口：签名 → IHDR → 收集 PLTE/IDAT → IEND →
 *  zlib 头检查 → inflate → Adler-32 → 逐行反滤波+灰度化 → 尺寸适配。
 *  任何一步不成立都以【具体原因】返回，绝不输出半张图。
 * -------------------------------------------------------------------------- */
static int scut_png_decode(const scut_u8 *data, size_t size,
                           scut_u8 *dst, int w, int h, int stride)
{
    png_chunk  ck;
    scut_u32   ihdr_w, ihdr_h;
    int        bit_depth, color_type, interlace;
    int        channels;
    int        src_w, src_h;
    size_t     row_bytes, filtered_size, gray_size;
    size_t     idat_len = 0, idat_cap = 0, raw_len = 0;
    scut_u8   *idat = NULL;
    scut_u8   *raw  = NULL;
    scut_u8   *gray = NULL;
    scut_u8    palette[256][3];
    int        pal_count = 0;
    int        seen_iend = 0;
    int        seen_idat = 0;
    int        cks, rc;
    int        x, y;
    int        copy_w, copy_h, x_off, y_off;

    /* ---- 1) 签名（load_image 已经认过魔数，这里独立再查一遍：
     *         本函数自己的契约是「入参必须自称 PNG」） ---- */
    if (size < PNG_SIG_SIZE ||
        data[0] != 0x89u || data[1] != 0x50u || data[2] != 0x4Eu ||
        data[3] != 0x47u || data[4] != 0x0Du || data[5] != 0x0Au ||
        data[6] != 0x1Au || data[7] != 0x0Au) {
        return SCUT_FRAME_ERR_PNG_HEADER;
    }

    /* ---- 2) IHDR 必须是第一个块且恰好 13 字节 ---- */
    ck.data = data;
    ck.size = size;
    ck.pos  = PNG_SIG_SIZE;
    cks = png_chunk_next(&ck);
    if (cks != 1 || ck.chunk_type != PNG_CK_IHDR || ck.chunk_len != 13u) {
        return SCUT_FRAME_ERR_PNG_HEADER;
    }
    if (!png_chunk_crc_ok(&ck)) {
        return SCUT_FRAME_ERR_PNG_CRC;      /* IHDR 的 CRC：文件头就已损坏 */
    }

    ihdr_w     = scut_rd_u32be(data + 16);
    ihdr_h     = scut_rd_u32be(data + 20);
    bit_depth  = data[24];
    color_type = data[25];
    interlace  = data[28];
    /* data[26] 压缩方法 / data[27] 滤波方法：PNG 规范只定义了 0 */
    if (data[26] != 0u || data[27] != 0u) {
        return SCUT_FRAME_ERR_PNG_FORMAT;
    }
    if (bit_depth != 8) {
        return SCUT_FRAME_ERR_PNG_FORMAT;   /* 1/2/4/16 位色深不在子集内 */
    }
    if (color_type != 0 && color_type != 2 && color_type != 3) {
        return SCUT_FRAME_ERR_PNG_FORMAT;   /* 4(灰度+α)/6(RGBA) 不在子集内 */
    }
    if (interlace != 0) {
        return SCUT_FRAME_ERR_PNG_FORMAT;   /* Adam7 交织不在子集内 */
    }
    if (ihdr_w == 0u || ihdr_h == 0u ||
        ihdr_w > (scut_u32)PNG_MAX_DIM || ihdr_h > (scut_u32)PNG_MAX_DIM) {
        return SCUT_FRAME_ERR_PNG_FORMAT;   /* 尺寸为 0 或超出支持范围 */
    }

    channels  = (color_type == 2) ? 3 : 1;  /* 8 位深：每像素 channels 字节 */
    src_w     = (int)ihdr_w;
    src_h     = (int)ihdr_h;
    row_bytes = (size_t)ihdr_w * (size_t)channels;

    /* 溢出防护：row_bytes*ihdr_h 若在 size_t 上回绕，后面的 malloc 会
     * 拿到一个小尺寸成功、随后按真实尺寸越界写 —— 与 scut_frame_alloc
     * 是同一条纪律：先除法反向验证，再看边界。 */
    if (row_bytes > (SIZE_MAX / 2u - 1u) / (size_t)ihdr_h) {
        return SCUT_FRAME_ERR_PNG_FORMAT;
    }
    filtered_size = (row_bytes + 1u) * (size_t)ihdr_h;
    gray_size     = row_bytes * (size_t)ihdr_h;

    /* ---- 3) 扫块：收集 PLTE 与全部 IDAT，直到 IEND ----
     * ★ IDAT 必须先拼接再解压：PNG 允许（且常见编码器默认）把压缩流
     *   切成多个 8K 的块，把每一块当独立流去解会直接失败。 */
    for (;;) {
        cks = png_chunk_next(&ck);
        if (cks < 0) {
            rc = SCUT_FRAME_ERR_PNG_TRUNCATED;
            goto fail;
        }
        if (cks == 0) {
            break;                          /* 文件干净地结束了（没有 IEND） */
        }

        switch (ck.chunk_type) {
        case PNG_CK_IHDR:
            /* IHDR 只允许一个且已被消费；再来就是结构损坏 */
            rc = SCUT_FRAME_ERR_PNG_HEADER;
            goto fail;

        case PNG_CK_PLTE:
            if (!png_chunk_crc_ok(&ck)) {
                rc = SCUT_FRAME_ERR_PNG_CRC;
                goto fail;
            }
            if (ck.chunk_len == 0u || (ck.chunk_len % 3u) != 0u ||
                ck.chunk_len > 768u) {
                rc = SCUT_FRAME_ERR_PNG_FORMAT;     /* 调色板长度不合法 */
                goto fail;
            }
            pal_count = (int)(ck.chunk_len / 3u);
            memcpy(palette, data + ck.chunk_data, (size_t)ck.chunk_len);
            break;

        case PNG_CK_IDAT: {
            size_t need = idat_len + (size_t)ck.chunk_len;

            if (!png_chunk_crc_ok(&ck)) {
                rc = SCUT_FRAME_ERR_PNG_CRC;
                goto fail;
            }
            if (need < idat_len) {
                rc = SCUT_FRAME_ERR_PNG_FORMAT;     /* 长度加法回绕：流是伪造的 */
                goto fail;
            }
            if (need > idat_cap) {
                size_t  ncap = (idat_cap == 0) ? need + 256u : idat_cap;
                scut_u8 *nid;

                while (ncap < need) {
                    if (ncap > SIZE_MAX / 2u) {
                        rc = SCUT_FRAME_ERR_PNG_FORMAT;   /* IDAT 总量大得反常 */
                        goto fail;
                    }
                    ncap *= 2u;
                }
                nid = (scut_u8 *)realloc(idat, ncap);
                if (nid == NULL) {
                    rc = SCUT_FRAME_ERR_PNG_FORMAT;       /* 内存不足 */
                    goto fail;
                }
                idat     = nid;
                idat_cap = ncap;
            }
            memcpy(idat + idat_len, data + ck.chunk_data, (size_t)ck.chunk_len);
            idat_len  = need;
            seen_idat = 1;
            break;
        }

        case PNG_CK_IEND:
            if (!png_chunk_crc_ok(&ck)) {
                rc = SCUT_FRAME_ERR_PNG_CRC;
                goto fail;
            }
            seen_iend = 1;
            goto end_chunks;                /* IEND 之后按规范不应再有块 */

        default:
            /* 辅助块（tRNS/gAMA/…）与未知块：跳过。我们不消费其内容，
             * 因此也不必校验其 CRC（规范允许忽略辅助块）。 */
            break;
        }
    }
end_chunks:
    if (!seen_iend) {
        rc = SCUT_FRAME_ERR_PNG_TRUNCATED;  /* 没有正常收尾：文件被截断 */
        goto fail;
    }
    if (!seen_idat || idat_len < 6u) {
        rc = SCUT_FRAME_ERR_PNG_TRUNCATED;  /* 没有 IDAT，或 zlib 流连头带尾都放不下 */
        goto fail;
    }
    if (color_type == 3 && pal_count == 0) {
        rc = SCUT_FRAME_ERR_PNG_FORMAT;     /* 调色板图却缺失 PLTE */
        goto fail;
    }

    /* ---- 4) zlib 包装（RFC 1950）：CMF FLG + deflate + Adler-32 ---- */
    if ((idat[0] & 0x0Fu) != 8u) {
        rc = SCUT_FRAME_ERR_PNG_ZLIB;       /* CM != 8：不是 deflate */
        goto fail;
    }
    if ((idat[0] >> 4) > 7u) {
        rc = SCUT_FRAME_ERR_PNG_ZLIB;       /* CINFO > 7：窗口大于 32K，不合规范 */
        goto fail;
    }
    if (((scut_u32)idat[0] * 256u + (scut_u32)idat[1]) % 31u != 0u) {
        rc = SCUT_FRAME_ERR_PNG_ZLIB;       /* FCHECK 校验失败 */
        goto fail;
    }
    if ((idat[1] & 0x20u) != 0u) {
        rc = SCUT_FRAME_ERR_PNG_ZLIB;       /* FDICT：预设字典不在子集内 */
        goto fail;
    }

    raw = (scut_u8 *)malloc(filtered_size);
    if (raw == NULL) {
        rc = SCUT_FRAME_ERR_PNG_FORMAT;     /* 内存不足：按「数据无效」归因 */
        goto fail;
    }

    /* 流尾 4 字节是 Adler-32，不参与 inflate */
    rc = png_inflate(idat + 2u, idat_len - 2u - 4u, raw, filtered_size, &raw_len);
    if (rc != SCUT_FRAME_OK) {
        goto fail;
    }
    if (raw_len != filtered_size) {
        rc = SCUT_FRAME_ERR_PNG_TRUNCATED;  /* 解压结果铺不满声明的图像 */
        goto fail;
    }
    if (png_adler32(raw, filtered_size) != scut_rd_u32be(idat + idat_len - 4u)) {
        rc = SCUT_FRAME_ERR_PNG_ZLIB;       /* 解压数据校验失败：内容已损坏 */
        goto fail;
    }

    gray = (scut_u8 *)malloc(gray_size);
    if (gray == NULL) {
        rc = SCUT_FRAME_ERR_PNG_FORMAT;
        goto fail;
    }

    /* ---- 5) 逐行：校验滤波类型 → 反滤波 → 折算灰度 ----
     * ★ 反滤波直接在 raw 上就地做：滤波只依赖「当前行 + 上一行」，
     *   从左到右、自上而下处理时改写自己的行不会影响后续行
     *   （上一行此时已经是反滤波完成的最终值）。 */
    for (y = 0; y < src_h; y++) {
        const scut_u8 *line = raw + (size_t)y * (row_bytes + 1u);
        scut_u8       *cur  = raw + (size_t)y * (row_bytes + 1u) + 1u;
        const scut_u8 *prev = (y > 0)
                            ? raw + (size_t)(y - 1) * (row_bytes + 1u) + 1u
                            : NULL;
        scut_u8 *grow = gray + (size_t)y * row_bytes;
        int      ft   = line[0];
        int      xb;

        if (ft > 4) {
            rc = SCUT_FRAME_ERR_PNG_FILTER;     /* 滤波类型不在 0..4 */
            goto fail;
        }

        switch (ft) {
        case 0:                                 /* None：原样 */
            break;
        case 1:                                 /* Sub：左 bpp 字节处 */
            for (xb = (int)channels; xb < (int)row_bytes; xb++) {
                cur[xb] = (scut_u8)(cur[xb] + cur[xb - channels]);
            }
            break;
        case 2:                                 /* Up：正上方（首行上方视为 0） */
            if (prev != NULL) {
                for (xb = 0; xb < (int)row_bytes; xb++) {
                    cur[xb] = (scut_u8)(cur[xb] + prev[xb]);
                }
            }
            break;
        case 3:                                 /* Average：左与上之和的下半 */
            for (xb = 0; xb < (int)row_bytes; xb++) {
                int a = (xb >= (int)channels) ? cur[xb - channels] : 0;
                int b = (prev != NULL) ? prev[xb] : 0;

                cur[xb] = (scut_u8)(cur[xb] + ((a + b) >> 1));
            }
            break;
        default: {                              /* 4 = Paeth 预测器 */
            for (xb = 0; xb < (int)row_bytes; xb++) {
                int a  = (xb >= (int)channels) ? cur[xb - channels] : 0;
                int b  = (prev != NULL) ? prev[xb] : 0;
                int c  = (prev != NULL && xb >= (int)channels)
                                    ? prev[xb - channels] : 0;
                int pa = (b - c) < 0 ? (c - b) : (b - c);
                int pb = (a - c) < 0 ? (c - a) : (a - c);
                int pc = (a + b - 2 * c) < 0 ? (2 * c - a - b) : (a + b - 2 * c);
                int pr = (pa <= pb && pa <= pc) ? a : ((pb <= pc) ? b : c);

                cur[xb] = (scut_u8)(cur[xb] + pr);
            }
            break;
        }
        }

        /* 灰度折算必须与 BMP 路径同一个 scut_luma（整数 BT.601）：
         * 测试会用「同一张图的 BMP 与 PNG」对数字，两路一旦用了
         * 不同系数，用户会看到阈值莫名漂移却无从解释。 */
        if (color_type == 0) {
            memcpy(grow, cur, row_bytes);       /* 本来就是 8 位灰度 */
        } else if (color_type == 2) {
            for (xb = 0; xb < src_w; xb++) {
                size_t o = (size_t)xb * 3u;
                grow[xb] = scut_luma((scut_u32)cur[o],
                                     (scut_u32)cur[o + 1u],
                                     (scut_u32)cur[o + 2u]);
            }
        } else {
            for (xb = 0; xb < src_w; xb++) {
                unsigned idx = cur[xb];

                if ((int)idx >= pal_count) {
                    rc = SCUT_FRAME_ERR_PNG_FORMAT;   /* 索引越出调色板：图已坏 */
                    goto fail;
                }
                grow[xb] = scut_luma((scut_u32)palette[idx][0],
                                     (scut_u32)palette[idx][1],
                                     (scut_u32)palette[idx][2]);
            }
        }
    }

    /* ---- 6) 尺寸适配：与 BMP 完全同一套「居中裁剪 / 左上对齐」 ----
     * 源大 → 居中裁剪；源小 → 左上对齐、其余保持 dst 原值。
     * 两路行为必须一致，否则「同一张图存成 BMP 与 PNG」跑出来的
     * 算法结果不同 —— 那是比解码错误更隐蔽的坑。 */
    copy_w = (src_w < w) ? src_w : w;
    copy_h = (src_h < h) ? src_h : h;
    x_off  = (src_w - copy_w) / 2;
    y_off  = (src_h - copy_h) / 2;

    for (y = 0; y < copy_h; y++) {
        const scut_u8 *row = gray + (size_t)(y_off + y) * row_bytes;

        for (x = 0; x < copy_w; x++) {
            dst[(size_t)y * (size_t)stride + (size_t)x] = row[x_off + x];
        }
    }

    free(idat);
    free(raw);
    free(gray);
    return SCUT_FRAME_OK;

fail:
    free(idat);
    free(raw);
    free(gray);
    return rc;
}

/* 把 SCUT_FRAME_ERR_* 翻译成一行【短】中文原因（给宿主的 JSON loadError 用）。
 *
 * ★ 为什么做成「一行短句」而不是 scut_pic_load 里那种「原因+下一步」长文：
 *   loadError 塞进每帧的 JSON 行，消费方是 IDE 界面的一个字段 ——
 *   它要的是能看懂的一句，不是一篇教程；完整的人类指引仍由宿主
 *   打到 stderr，两条通道各司其职。
 *
 * ★ 为什么每个 PNG 码都有独立文案：
 *   「截断」和「CRC 错」的下一步完全不同（重新下载 vs 重新导出），
 *   文案合一就会把用户往错误的方向指 —— 与错误码分立的初衷自相矛盾。 */
const char *scut_frame_strerror(int code)
{
    switch (code) {
    case SCUT_FRAME_OK:                   return "成功";
    case SCUT_FRAME_ERR_BADARG:           return "参数非法";
    case SCUT_FRAME_ERR_OPEN:             return "文件打不开";
    case SCUT_FRAME_ERR_READ:             return "文件读取失败（截断或 IO 错误）";
    case SCUT_FRAME_ERR_NOT_BMP:          return "不是 BMP 文件（文件头魔数不符）";
    case SCUT_FRAME_ERR_BMP_HEADER:       return "BMP 头不合法或不支持的变体";
    case SCUT_FRAME_ERR_BMP_TRUNCATED:    return "BMP 像素数据不完整";
    case SCUT_FRAME_ERR_BMP_COMPRESSION:  return "BMP 使用了不支持的压缩格式";
    case SCUT_FRAME_ERR_BMP_PALETTE:      return "BMP 调色板缺失或越界";
    case SCUT_FRAME_ERR_UNSUPPORTED_FORMAT:
        return "图片格式暂不支持（JPEG 等未解码格式），请转成 BMP 或 PNG";
    case SCUT_FRAME_ERR_PNG_HEADER:       return "PNG 头或 IHDR 块不合法";
    case SCUT_FRAME_ERR_PNG_TRUNCATED:    return "PNG 数据不完整（文件被截断）";
    case SCUT_FRAME_ERR_PNG_CRC:          return "PNG 数据块 CRC 校验失败（文件已损坏）";
    case SCUT_FRAME_ERR_PNG_ZLIB:         return "PNG 的 zlib 流校验失败（头或 Adler-32 不对）";
    case SCUT_FRAME_ERR_PNG_INFLATE:      return "PNG 压缩流不合法（deflate 解码失败）";
    case SCUT_FRAME_ERR_PNG_FILTER:       return "PNG 行滤波类型不合法";
    case SCUT_FRAME_ERR_PNG_FORMAT:       return "PNG 色深/颜色类型/交织方式不在支持范围内";
    default:                              return "未知错误码";
    }
}

int scut_frame_load_image(const char *path, scut_u8 *dst, int w, int h, int stride)
{
    scut_u8 *data = NULL;
    size_t   size = 0;
    int      rc;

    /* 参数校验放在最前面：不必打开文件就能拒绝的错误，早点拒绝。 */
    if (path == NULL || dst == NULL || w <= 0 || h <= 0 || stride < w) {
        return SCUT_FRAME_ERR_BADARG;
    }

    rc = scut_read_file(path, &data, &size);
    if (rc != SCUT_FRAME_OK) {
        return rc;
    }

    /* ★ JPEG：仍然交给 UNSUPPORTED_FORMAT（见 scut_looks_like_png_or_jpeg）。
     *   PNG 已自持解码，必须先于该分支识别 —— 否则一张合法 PNG
     *   会被误报成"请转成 BMP"。 */
    if (scut_looks_like_png_or_jpeg(data, size) == 2) {
        rc = scut_png_decode(data, size, dst, w, h, stride);
        free(data);
        return rc;
    }
    if (scut_looks_like_png_or_jpeg(data, size) == 1) {
        free(data);
        return SCUT_FRAME_ERR_UNSUPPORTED_FORMAT;
    }

    rc = scut_bmp_decode(data, size, dst, w, h, stride);
    free(data);
    return rc;
}
