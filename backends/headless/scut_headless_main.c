/* ==========================================================================
 *  scut_headless_main.c —— headless 仿真宿主
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 代码松耦合   → 核心不知道「窗口」的存在；本文件只是它的一个消费者
 *    · 模拟单片机   → headless 与 GUI 走同一套核心调度，行为一致
 *    · 上手即用     → 支持命令行参数，可被 IDE/CI 直接驱动，无需人工操作
 *
 *  ★ 为什么 headless 要优先做：
 *      它是「核心不拥有窗口」这条原则的【证明】。如果连无窗口运行都做不到，
 *      说明核心仍然绑着某个图形库，Webview 后端也就无从谈起。
 *      同时它让「批量评测」这一高价值场景立刻可用。
 *
 *  ---------------------------------------------------------------------------
 *  输出协议（供 VsCode 插件 / CI 消费）
 *  ---------------------------------------------------------------------------
 *  每帧输出一行 JSON 到 stdout（--json 模式），格式：
 *    {"frame":1,"w":188,"h":120,"img":"<path to pgm>",
 *     "pic":"<path to source image>","timing":{...}}
 *  变量快照单独输出：
 *    {"vars":[{"name":"g_threshold","values":"128","truncated":false}, ...]}
 *
 *  ★ "pic" 是【本帧输入所用的测试图路径】，是本轮新增的追加字段：
 *    IDE 要在界面上显示「这一帧看的是哪张图」，否则批跑整组图时
 *    画面与文件对不上号，用户只能靠帧号去猜。除此之外，
 *    JSON 的形状、字段名、字段顺序一律未动（只增不改）。
 *
 *  ★ 关于 "pic" 的【取值格式】（本轮调整）：
 *    修复"测试图找不到"的 bug 之后，内部使用的图片路径变成了绝对路径
 *    （因为要由 exe 位置反推工程根）。但直接把这串绝对路径显示出来
 *    对用户毫无帮助 ——
 *      D:/22车队管理/.../scut71-project/pic/1/3.bmp
 *    会把插件界面撑开，而用户想知道的只是"第 3 张"。
 *    所以这里在【导出显示】时把它折回工程根的相对形式（pic/1/3.bmp）。
 *    字段名、字段类型都没变，变的只是字符串的内容更短更好读；
 *    万一图片真的在工程之外（--pic 指向别处），才保持绝对路径 ——
 *    那种情况下"看起来像工程的图"反而是误导。
 *
 *  ★ 测试图路径【怎么解析】（本轮修复的核心，详见 resolve_pic_set）：
 *    不再只按进程当前工作目录解析。改为按优先级尝试
 *    --pic（绝对路径直接用）/ exe 上一级 / exe 上两级 / CWD，
 *    第一个真的含 1.<ext> 的位置胜出。
 *    这样插件用 cwd=.scut/bin 启动、用户从 C:\ 启动、
 *    以及一直在工程根启动，三种情况下找到的都是同一组图。
 *
 *  ★ 为什么用文件传图像而不是 base64 内联：
 *      188x120 = 22560 字节，base64 后约 30 KB/帧。几十帧就会把
 *      管道塞满。写 PGM 文件让消费方按需读取更稳。
 *      文件通道也是计划书里「先用临时文件」决策的落实。
 * ========================================================================== */

#include "scut_sdk.h"
#include "scut_sched.h"
#include "scut_frame.h"
#include "scut_watch.h"
#include "scut_log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <inttypes.h>   /* PRIu64：可移植的 64 位无符号输出宏，见 on_frame 的说明 */
#include <time.h>

/* ★ 只有在 Windows 上才引入 <windows.h>，而且【只为】取自身可执行文件路径。
 *   理由有两条，都必须写清楚，否则后来的维护者很容易"顺手"把这个 ifdef 删掉：
 *
 *   1) 可移植性：本文件是 headless 后端，理论上要能在 POSIX 上编译
 *      （「核心零依赖」的目标里也包含"后端不绑死平台"）。
 *      <windows.h> 在非 Windows 平台上根本不存在，无条件 include
 *      会让本文件在别的平台上【直接编译失败】。
 *
 *   2) 污染面：<windows.h> 会定义 min/max 等一大批宏，把
 *      <stdlib.h> 之外的名字也一起改掉。每多包含一个翻译单元就多一份
 *      与其它头文件冲突的机会。所以能用 argv[0] 解决就不碰它——
 *      这里的 GetModuleFileNameA 只是【让推导更稳的加固】，不是唯一手段，
 *      下面的 scut_exe_dir() 在拿不到它时会完整回落到 argv[0]。
 *
 *   ★ WIN32_LEAN_AND_MEAN：只要 GetModuleFileNameA 一个函数，
 *     不需要 winsock / OLE 那一大堆；不定义它会让编译明显变慢。
 *   ★ 必须自己定义，且必须在 include 之前——所以这里用 #ifndef 包一层，
 *     万一将来有别的头已经定义过，也不会触发 macro redefined 警告。 */
#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#  include <direct.h>       /* _mkdir —— 建帧输出目录 */
#else
#  include <sys/stat.h>     /* mkdir */
#  include <sys/types.h>
#endif

/* --- 由 bind 单元提供（它是唯一知道编译期尺寸的地方） --- */
extern void    scut_bind_apply(void);
extern scut_u8 *scut_bind_input(void);
extern scut_u8 *scut_bind_output(void);
extern scut_u32 *scut_bind_overlay(void);
extern int      scut_bind_width(void);
extern int      scut_bind_height(void);

/* --------------------------------------------------------------------------
 *  建目录（可移植，不经 shell）
 *
 * ★ 为什么不用 system("mkdir ...")：
 *   旧实现用它建帧输出目录。system 会拉起一个子 shell，而且
 *   `2>nul` 是 Windows cmd 的语法 —— 在别的平台上是非法重定向。
 *   这个环境里本该只有"计时"和"取自身路径"两处平台相关代码，
 *   多一个 shell 依赖就多一处移植障碍，收益却只是省四行。
 *
 * 已存在（EEXIST）视为成功：调用方要的是"目录可用"，
 * 不是"这次真的创建了它"。 */
static void ensure_dir(const char *path)
{
    if (path == NULL || path[0] == '\0') {
        return;
    }
#ifdef _WIN32
    (void)_mkdir(path);
#else
    (void)mkdir(path, 0777);
#endif
}

/* --------------------------------------------------------------------------
 *  测试图集的编译期默认值
 *
 * ★ 为什么要放这个「三处兜底」：
 *   测试图目录/扩展名写在哪里，是这个环境里唯一一处「约定」而非「契约」。
 *   旧环境把 SCUT_PIC_DIR 定在 config.h 里，而 config.h 又被记录为
 *   「只有尺寸是必改项」——于是新版 config.h 一度把这两行删掉了。
 *   如果这里不做兜底，用户手上任何一份老 config.h 都会让宿主
 *   直接编译失败，而报错信息是「SCUT_PIC_DIR 未声明」，
 *   完全看不出「其实是你配置头文件版本旧了」。
 *   所以这里给出与 templates/starter/config.h 逐字一致的默认值：
 *   老工程能编译、新工程以 config.h 为准，两边都不需要改代码。
 *
 * ★ 用 #ifndef 而不是 #define 覆盖：
 *   宏在 include 链上已经定义过就是权威，绝不在这里重新定义 ——
 *   重定义会触发 'macro redefined' 警告，而本文件要求零警告。
 *   （头文件名两种约定由 scut_sdk.h / bind 的 __has_include 处理，
 *     这里只负责「没定义时给默认值」。）
 * -------------------------------------------------------------------------- */
#ifndef SCUT_PIC_DIR
#  define SCUT_PIC_DIR "pic/1"
#endif
#ifndef SCUT_PIC_EXT
#  define SCUT_PIC_EXT ".bmp"
#endif

/* 测试图编号探测上限。
 * ★ 为什么必须有上限：探测方式是从 1 开始逐个去问文件系统
 *   「N.bmp 存在吗」。若目录里恰好有一批**稀疏编号**的文件
 *   （例如只有 1.bmp 和 99999999.bmp），而缺失即停止的规则又没生效，
 *   循环就会一直空转下去。上限把「目录有病」的后果限制在
 *   「多花几百毫秒」而不是「进程挂死、用户以为仿真卡了」。
 *   100000 帧的批跑本身已经远超任何人工评审的规模。 */
#define SCUT_PIC_INDEX_MAX 100000

/* 路径相关缓冲区大小。
 * ★ 用 512 而不是 PATH_MAX：Windows 的路径上限是 260（含结尾 NUL），
 *   512 已经留了一倍余量；而 PATH_MAX 在部分平台上是 4096，
 *   两个这样的栈缓冲就接近 8KB，对「模拟单片机」的取向不合适。 */
#define SCUT_PATH_MAX 512

/* --- 命令行选项 --- */
typedef struct {
    int         frames;       /* 跑多少帧，0 = 无限（配合 --once 除外） */
    int         step_mode;    /* 每帧后等待 stdin 一行（供 IDE 单步） */
    int         json;         /* stdout 输出 JSON 协议 */
    int         quiet;        /* 不打印人类可读信息 */
    int         repeat;       /* PROCESS 重复次数 */
    int         list_vars;    /* 只列出变量后退出 */
    const char *pic_dir;      /* 测试图集目录 */
    const char *pic_ext;      /* 测试图扩展名（可逗号分隔多个） */
    const char *out_dir;      /* 帧 PGM 输出目录 */
    const char *select_vars;  /* 逗号分隔，只输出这些变量 */
    int         frame_index;  /* 起始图片编号（0 或 1 起，随图集探测结果） */
    int         advance;      /* 每帧前进到下一张图（末尾回绕） */
    /* ★ 为什么要单独记「用户给没给 --frame」：
     *   图集既可能从 0 起编号（存在 0.<ext>），也可能维持旧约定从 1 起。
     *   起始编号的【默认值】必须跟着探测结果走，而 options_t 一旦初始化
     *   就分不清"用户填的 1"和"默认填的 1"。这个标志让 main 能把
     *   默认值让位给探测结果、又绝不覆盖用户的显式选择。 */
    int         frame_index_given;
    /* ★ argv[0] 为什么要放进 options_t：
     *   "工程根在哪"这个问题，唯一可靠的线索就是"exe 自己在哪"，
     *   而 exe 的位置就藏在 argv[0] 里。resolve_pic_set() 拿的是
     *   const options_t *，如果不把它带上，就只能在 main 里另开一个
     *   全局变量传过去 —— 那等于把"一个输入"拆成两条通道，
     *   读代码的人要同时看两处才知道路径是怎么来的。
     *   放进这里，路径解析的全部输入就在同一个结构体里，一眼看得全。 */
    const char *argv0;        /* 程序自身的 argv[0]，用于反推 exe 所在目录 */
} options_t;

static void usage(void)
{
    fprintf(stderr,
        "SCUT-71 仿真宿主 (headless)\n"
        "用法: scut_sim [选项]\n"
        "  --frames N      运行 N 帧 (默认 1)\n"
        "  --step          每帧后等待回车 (供 IDE 单步)\n"
        "  --json          stdout 输出机器可读 JSON\n"
        "  --quiet         不输出人类可读信息\n"
        "  --repeat N      PROCESS 角色每帧重复 N 次 (默认 1)\n"
        "  --list-vars     列出自动发现的变量后退出\n"
        "  --select A,B    只输出这些变量的数值\n"
        "  --pic DIR       测试图集目录 (默认取自 config.h 的 SCUT_PIC_DIR)\n"
        "                  相对路径会依次在 exe 上一级 / exe 上两级 / 当前目录下查找，\n"
        "                  取第一个真的有 1.<ext> 的位置；绝对路径则直接使用。\n"
        "  --ext EXTS      测试图扩展名，逗号分隔 (默认取自 SCUT_PIC_EXT)\n"
        "  --frame N       从第 N 张图开始 (默认 = 图集第一张)\n"
        "                  ★ 编号基准随图集自动探测：目录里存在 0.<ext> 时\n"
        "                  图集按 0 起编号 (N=0 即第一张)，否则按旧约定 1 起。\n"
        "                  N 超出张数时自动夹回最后一张并给出警告。\n"
        "  --advance       每帧前进到下一张图 (跑到末尾自动回绕到第一张)\n"
        "  --out DIR       帧图像输出目录 (默认 ./scut_frames)\n"
        "  --help          显示本帮助\n");
}

/* --------------------------------------------------------------------------
 * 极简参数解析
 *
 * ★ 不用 getopt：MinGW 的 getopt 行为与 MSVC 不一致，
 *   而本项目要求「同一份代码在 gcc/clang/MSVC 下行为相同」。
 *   手写解析只有几十行，换来跨工具链的一致性，值得。
 * -------------------------------------------------------------------------- */
static int parse_args(int argc, char **argv, options_t *o)
{
    int i;

    o->frames     = 1;
    o->step_mode  = 0;
    o->json       = 0;
    o->quiet      = 0;
    o->repeat     = 1;
    o->list_vars  = 0;
    o->pic_dir    = 0;          /* 0 = 尚未指定，稍后回落到 SCUT_PIC_DIR */
    o->pic_ext    = 0;          /* 0 = 尚未指定，稍后回落到 SCUT_PIC_EXT */
    o->out_dir    = "scut_frames";
    o->select_vars = 0;
    /* ★ 起始编号的【默认值】在这里不能拍死成 1：
     *   图集的起始编号由 resolve_pic_set() 探测（0.<ext> 存在 → 0 起，
     *   否则维持旧约定 1 起），命令行给了 --frame 才以用户为准。
     *   先落一个 1 占位，探测后若用户未指定会按 s_pic_first 重设。 */
    o->frame_index = 1;
    o->frame_index_given = 0;
    o->advance     = 0;
    /* ★ 先把 argv[0] 收到默认值，再进解析循环：
     *   循环里的任何分支（包括"未知参数"提前返回）都不会影响它，
     *   于是"路径解析永远拿得到一个可用的 argv[0]（或 NULL）"成为不变量。
     *   若放在循环里按 --argv 之类去解析，反倒会多出一个"用户能覆盖它"
     *   的口子 —— 而这件事用户既无必要、也无从判断该填什么。 */
    o->argv0       = (argc > 0) ? argv[0] : NULL;

    for (i = 1; i < argc; i++) {
        const char *a = argv[i];

        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) {
            usage();
            return 1;
        } else if (strcmp(a, "--json") == 0) {
            o->json = 1;
        } else if (strcmp(a, "--quiet") == 0) {
            o->quiet = 1;
        } else if (strcmp(a, "--step") == 0) {
            o->step_mode = 1;
        } else if (strcmp(a, "--advance") == 0) {
            o->advance = 1;
        } else if (strcmp(a, "--list-vars") == 0) {
            o->list_vars = 1;
        } else if (strcmp(a, "--frames") == 0 && i + 1 < argc) {
            o->frames = atoi(argv[++i]);
        } else if (strcmp(a, "--repeat") == 0 && i + 1 < argc) {
            o->repeat = atoi(argv[++i]);
        } else if (strcmp(a, "--pic") == 0 && i + 1 < argc) {
            o->pic_dir = argv[++i];
        } else if (strcmp(a, "--ext") == 0 && i + 1 < argc) {
            o->pic_ext = argv[++i];
        } else if (strcmp(a, "--frame") == 0 && i + 1 < argc) {
            o->frame_index = atoi(argv[++i]);
            o->frame_index_given = 1;
        } else if (strcmp(a, "--out") == 0 && i + 1 < argc) {
            o->out_dir = argv[++i];
        } else if (strcmp(a, "--select") == 0 && i + 1 < argc) {
            o->select_vars = argv[++i];
        } else {
            fprintf(stderr, "未知参数: %s\n", a);
            usage();
            return -1;
        }
    }

    if (o->frames < 0) { o->frames = 0; }
    if (o->repeat < 1) { o->repeat = 1; }
    /* ★ 起始编号在这里只做「不能是负数」的下限夹取（0 是合法值 ——
     *   编号从 0 起的图集要靠它表达"从第一张开始"）；
     *   真正的「是否超出图集总数」要等探测完图片数量才知道，
     *   见 resolve_pic_set()。两处校验分工明确，不重复也不遗漏。 */
    if (o->frame_index < 0) { o->frame_index = 0; }
    return 0;
}

/* ==========================================================================
 *  测试图集：路径解析、数量探测、装配与逐帧推进
 *  --------------------------------------------------------------------------
 *  ★ 这一整块存在的理由（也就是本文件此前最大的功能缺口）：
 *      宿主早就解析了 --pic DIR，却【从来没有人调用过图像解码器】。
 *      于是 mt9v03x_image 永远保持全是 0，仿真是在一张黑图上跑完的。
 *      而这个缺口的表现形式极具误导性：直方图 22560 个像素全落在第 0 桶、
 *      丢线行数恰好等于图像高度、阈值塌缩到下限 1。
 *      三者看起来都像「用户的算法写错了」，实际上算法一行都没错。
 *      所以本模块不只是「加个功能」，它是把一类高成本的误诊从根上掐掉。
 *
 *  ★ 文件级状态放在这里，而不是塞进 options_t：
 *      options_t 的语义是「用户从命令行说了什么」，
 *      而「目录里到底有几张图」「现在用的是第几张」是运行时才发现的事实。
 *      两类信息混在一个结构体里，读代码的人就无法一眼看出
 *      「哪些是输入、哪些是探测结果」。分开之后各自职责单一。
 * ========================================================================== */

/* ★ 本块的一切（状态与函数）都保持【文件内可见】：
 *   图集是 headless 后端自己的实现细节 —— core 不认、bind 不认、
 *   用户算法也不该认。若把它们导出成全局符号，将来 window/webview
 *   后端写出同名实现时会在链接期报"符号重复定义"，
 *   而那个报错与真正的原因（它本不该全局可见）毫无关系。
 *   收紧可见性是最省事、也最准确的边界表达。
 *
 * 状态全部零初始化 = 「还没探测」，
 * 因此任何在 resolve_pic_set() 之前发生的调用都必须能安全地什么都不做。 */
static char s_pic_dir[SCUT_PATH_MAX];   /* 已解析的目录（可能是绝对路径） */
static char s_pic_ext[SCUT_PATH_MAX];   /* 扩展名列表原文，仅用于打印 */
static char s_pic_path[SCUT_PATH_MAX];  /* 当前图片的完整路径（可能超过 260） */
static int  s_pic_count;                /* 探测到的图片总数，0 = 一张都没有 */
static int  s_pic_index;                /* 当前图片编号（起点随图集：见 s_pic_first） */
static int  s_pic_first;                /* 图集起始编号：0（存在 0.<ext>）或 1（旧约定） */

/* 工程根（由 exe 位置推导出来的绝对路径）。
 *
 * ★ 为什么要单独留一个静态变量，而不是只在 resolve_pic_set 里当局部变量：
 *   它的用途有两个，而且分处两个函数：
 *     ① resolve_pic_set 里拿它去拼候选路径（探测用）；
 *     ② on_frame 里拿它把 "pic" 折成相对形式（显示用）。
 *   如果留在局部，第 ② 步就只能重新推导一遍 —— 而"推导"是
 *   有失败分支的（见 scut_exe_dir 的三级回退），两处推导理论上
 *   可能得到不同结果，于是"探测用的是 A 根、显示按 B 根折算"，
 *   显示出来的相对路径会指向一个不存在的地方。
 *   存成静态变量，从根上消灭"两次推导不一致"这个可能。
 *
 * ★ 为什么用相对形式显示时要【先确认它真的是这个根的子路径】：
 *   见 path_make_root_relative 的说明 —— 前缀相同不等于子路径。
 *   这里是显示层，绝不能凭空捏造一个看似合理却错误的路径。 */
static char s_proj_root[SCUT_PATH_MAX];

/* 上一次报告的加载失败信息。只用来【去重】：
 * --advance 批跑时同一张坏图会被每帧重复报一次，几十帧就是几十行同样的
 * 警告，把真正有用的输出淹没掉。内容相同的错误只报一次。
 * （内容变了仍会重报，因为那说明遇到的是另一个问题。）
 * ★ 原因短语也一并记住：它是本帧 JSON "loadError" 字段的内容，
 *   只要错误没变（即使帧在推进），字段值就能保持稳定。 */
static int  s_pic_err_code;
static char s_pic_err_path[SCUT_PATH_MAX];
static int  s_pic_err_reported;
static char s_pic_err_short[128];       /* 最近一次加载失败的短中文原因 */

/* 测速请求：收到了 b<N>，但【还没跑那一帧】。
 *
 * ★ 为什么需要这个标志（一条真实缺陷的修复）：
 *   b<N> 是在帧钩子 on_frame 内部被解析的，而 on_frame 本身就是被
 *   run_one_frame 调用的 —— 在"帧中途"再嵌套跑一整帧会引出两个问题：
 *     ① 递归调用 on_frame，于是又走到读 stdin 那段，
 *        把下一条协议命令【吃掉】；表现为 b3 之后再发命令会少生效一次；
 *     ② 内层帧覆盖了计时状态，而测速结果正是靠这一帧的读数。
 *   改成"挂起待用"之后，本帧正常结束，调度循环自然跑到下一帧，
 *   那一帧以 N 次重复执行 PROCESS。恰好一帧、无递归。
 *
 * 生命周期：on_frame 末尾收到 b<N> → 置 1；
 *           下一次 on_frame 开头读到 1 → 本帧就是测速帧，
 *           报 bench:true 并把 repeat 还原。 */
static int  s_bench_pending;
static int  s_repeat_before_bench = 1;

static int         scut_pic_count(void) { return s_pic_count; }
static int         scut_pic_index(void) { return s_pic_index; }
static const char *scut_pic_path(void)  { return s_pic_path; }

/* ==========================================================================
 *  「自身可执行文件在哪」—— 路径解析的地基
 *  --------------------------------------------------------------------------
 *  ★★ 这一段是「黑屏跑到底」这个 bug 的根因修复，也是本文件里最需要
 *     讲清"为什么"的一段。★★
 *
 *  问题：测试图目录（--pic 或 config.h 的 SCUT_PIC_DIR，默认 "pic/1"）
 *        是【相对路径】，而相对路径是按【进程当前工作目录（CWD）】
 *        解析的。CWD 是启动者决定的，不是工程决定的：
 *          · 用户在工程根目录敲命令  → CWD = 工程根 → pic/1 找得到
 *          · VS Code 插件 spawn 进程 → CWD = path.dirname(exePath)
 *                                    = <工程>/.scut/bin/ → 找【不到】
 *        于是同一份 exe、同一次运行，只因为启动者不同，就得到两种结果：
 *        一种是正常的 36 张图，另一种是"一张都找不到"，然后算法在
 *        【全零图像】上跑完 —— 表现就是界面上一帧永远不动。
 *
 *  为什么这个 bug 特别难查：
 *    它的现象与"算法算错了"几乎一模一样（直方图全在第 0 桶、阈值塌到下限），
 *    而它【不报错、不崩溃】，只是安静地降级成黑图。用户会先去怀疑自己的
 *    算法，而真正的原因只是"启动时的 CWD 差了三个目录层级"。
 *    经验数据也印证了这一点：从 C:\ 启动 → 警告 + "pic":""；
 *    从工程根启动 → "pic":"pic/1/1.bmp"。两次运行的唯一差别就是 CWD。
 *
 *  修法：把"工程根在哪里"从【启动者决定】改成【由 exe 自己的位置推导】。
 *    exe 的落点是固定的：<工程根>/.scut/bin/scut_sim.exe（旧布局同此）。
 *    所以我们能可靠地反推出工程根：
 *      exe 目录 = <工程根>/.scut/bin  → 上一级 ../  = <工程根>/.scut
 *                                    → 再上一级 ../.. = <工程根>
 *    然后按候选顺序逐个去试"这个根下面有没有图"，
 *    第一个真的含 1.<ext> 的根胜出。
 *    这样无论从哪个目录启动，结果都一样。
 *
 *  ★ 为什么仍然把 CWD 留在【最后一位】而不是彻底删掉：
 *    这是"不破坏既有用法"的硬要求。有些用户/CI 的既有习惯就是
 *    "在放图的目录里启动 exe"；如果改成只认 exe 相对路径，
 *    这些用法会在升级后【静默失效】—— 又是一次"看起来像算法问题"的假象。
 *    放在最后而不是最前，是因为 exe 相对路径才是这个环境的约定（契约），
 *    CWD 只是历史用法（兼容）。优先级体现的正是"哪个是契约"。
 *
 *  ★ 为什么用 candidates 数组 + 循环，而不是一串 if：
 *    三个候选根、两种取值来源（--pic 覆盖 vs 编译期默认），
 *    如果写成嵌套 if，就会得到 6 条几乎一样的分支，
 *    而"到底试过哪些路径"这件事反而散落在各处、无法一次性列给用户。
 *    摊平成循环之后，"试过什么"天然就是数组内容本身，
 *    警告里把同一份数组打出来即可 —— 提示与实际行为不可能不一致。
 * ========================================================================== */

/* 候选根最多几条：--pic（相对）/ --pic（绝对）/ exe/.. / exe/../.. / CWD。
 * 绝对 --pic 直接命中、不再前缀任何根，所以它不占"根"的名额；
 * 这里给 4 条相对根留足余量（exe/..、exe/../..、CWD，外加未来可能的
 * 一个约定目录），改这里只需同步 SCUT_PIC_TRY_MAX 一个数字。 */
#define SCUT_PIC_TRY_MAX 4

/* 去掉路径末尾的分隔符。返回是否改动了任何东西。
 * ★ 为什么必须去尾：
 *    pic_join() 用 "%s/%d%s" 拼接，如果把 "D:/proj/" 原样带进去，
 *    就会得到 "D:/proj//1.bmp"。这在文件系统层面通常仍然有效，
 *    但【打印给用户看】时会显得像 bug，而且两个候选根
 *    "D:/proj" 与 "D:/proj/" 会被当成不同字符串，去重就失效了。
 *    统一成"末位非分隔符"这一种形态，比较与显示才都干净。 */
static int path_strip_trailing_sep(char *p)
{
    size_t n;
    int    changed = 0;

    if (p == NULL) {
        return 0;
    }
    n = strlen(p);
    /* ★ 只剥"多余"的那个：盘符根 "C:/" 只剩 "C:" 就失去含义了，
     *   所以 n > 1 才继续。POSIX 的 "/" 同理（n == 1 时不动）。 */
    while (n > 1 && (p[n - 1] == '/' || p[n - 1] == '\\')) {
        p[n - 1] = '\0';
        n--;
        changed = 1;
    }
    return changed;
}

/* 取路径的目录部分，写进 out（不含末尾分隔符）。
 * 找不到分隔符（纯文件名，如 "scut_sim.exe"）时写成 ".", 表示"当前目录"。
 *
 * ★ 为什么返回 "." 而不是空串：
 *   空串会被上层拼成 "/scut_sim.exe" 这种"绝对但没盘符"的怪路径，
 *   在 Windows 上解析结果完全不可预期。而 "." 是语义正确的"此处"，
 *   拼出来是 "./.." —— 虽然没帮上什么忙，但至少不会指向莫名其妙的地方。
 *
 * ★ 为什么要同时认 '/' 与 '\'：
 *   argv[0] 在 Windows 上由启动者原样给出，斜杠方向完全不受我们控制
 *   （cmd 用 '\'、Node 的 spawn 可能用 '/'、用户手敲两种都可能）。
 *   只认一种的话，"另外一种写法"就会退化成"纯文件名"分支，
 *   白白丢掉一个本来可用的线索。 */
static int path_dir_of(const char *path, char *out, size_t cap)
{
    const char *slash;
    const char *back;
    const char *cut;
    size_t      len;

    if (path == NULL || out == NULL || cap == 0) {
        return -1;
    }

    slash = strrchr(path, '/');
    back  = strrchr(path, '\\');
    cut   = slash;
    if (back != NULL && (cut == NULL || back > cut)) {
        cut = back;
    }

    if (cut == NULL) {
        /* 没有分隔符：纯文件名，只能用"当前目录"来代替 exe 目录。
         * 这条分支在"从 PATH 里按名字启动"时就会走到。 */
        if (cap < 2) {
            return -1;
        }
        out[0] = '.';
        out[1] = '\0';
        return 0;
    }

    len = (size_t)(cut - path);
    if (len == 0) {
        /* 形如 "/scut_sim.exe"：分隔符就在开头。
         * 目录部分是根，保留那个分隔符本身，否则会退化成空串。 */
        len = 1;
    }
    if (len + 1 > cap) {
        return -1;              /* 放不下：宁可放弃，也不截断 */
    }
    memcpy(out, path, len);
    out[len] = '\0';
    return 0;
}

/* 把路径转成绝对路径，写进 out。
 *
 * ★ 用 _fullpath 而不是手写拼字符串：
 *    它由 CRT 提供，内部与 fopen 用的是【同一套】路径解析规则。
 *    手写拼接（先 getcwd 再按 "/.." 折叠）必须自己处理
 *    "." ".." 冗余分隔符、盘符、UNC，任何一条处理错都会得到
 *    "看起来对但其实不对"的路径 —— 正是本项目最想避免的那类 bug。
 *    用 CRT 自己的函数，就没有"我们的解析规则与它的不一致"这个可能。
 *
 * ★ 只在 _WIN32 下用：
 *    _fullpath 是 MSVCRT/UCRT 的扩展；POSIX 上对应的是 realpath，
 *    两者签名不同且 realpath 还要求路径【必须已存在】。
 *    非 Windows 分支退化为"原样拷贝"：路径不再是规范化的绝对路径，
 *    但下面的候选循环仍能正常工作（只是打印出来的路径会长一些）。
 *    功能不缺失，只有"好看程度"在别的平台上略降，这个取舍是值得的。 */
static void path_to_absolute(const char *in, char *out, size_t cap)
{
    if (in == NULL || out == NULL || cap == 0) {
        return;
    }
#ifdef _WIN32
    if (_fullpath(out, in, cap) == NULL) {
        /* 失败（路径过长、或盘不存在）：退化为原样拷贝。
         * 不当作致命错误 —— 连绝对化都做不了，至少还能拿原串去试一次，
         * 而"试一次"的代价只有一次 fopen。 */
        snprintf(out, cap, "%s", in);
    }
#else
    snprintf(out, cap, "%s", in);
#endif
}

/* 把路径向上走 n 级目录（等价于拼 n 个 "/.." 之后规范化）。
 *
 * ★ 为什么不用"拼上 ../.. 再 _fullpath"这种一步到位的写法：
 *   实测（本项目，clang -O2，Windows）—— `_fullpath("D:/proj/.scut/bin/../..")`
 *   并不会把 `..` 折叠掉，返回的字符串里仍然带着字面的 "bin\..\.."。
 *   这本身不影响 fopen（文件系统会自己解析），但它会让【字符串比较】
 *   全部失效：s_proj_root 变成 "D:\\proj\\.scut\\bin\\..\\.."，
 *   而图片路径是 "D:\\proj\\pic\\1\\1.bmp"，两者真正可比的公共前缀
 *   只有 "D:\\proj" —— 于是工程根相对化算出的是错的层级，
 *   甚至可能把路径剥成只剩盘符。这正是实测中 "pic":"C:" 那种
 *   荒谬输出的来源。
 *   一级一级地走、每次都调用 _fullpath 去规范化，得到的才是
 *   真正"没有 . 与 .."的绝对路径，字符串比较才有意义。
 *
 * ★ 为什么要判"走不动了"：
 *   已经在根上（"C:/" 的上一级还是 "C:/"）时，继续走只会得到
 *   同一个结果。这时必须【报告失败】而不是安静地返回当前值 ——
 *   否则调用方会拿着一个比预期浅的根去拼路径，拼出一堆不存在的
 *   候选，用户看到的警告清单会全是错的。
 *
 * 返回 0 成功；非 0 表示中途未能再向上（out 保持调用前的值）。 */
static int path_go_up(const char *in, int n, char *out, size_t cap)
{
    char cur[SCUT_PATH_MAX];
    int  i;

    if (in == NULL || out == NULL || cap == 0 || n < 0) {
        return -1;
    }
    if (strlen(in) >= sizeof(cur)) {
        return -1;
    }
    snprintf(cur, sizeof(cur), "%s", in);

    for (i = 0; i < n; i++) {
        char next[SCUT_PATH_MAX];
        char up[SCUT_PATH_MAX];
        int  m;

        /* 先拼出"上一级"的相对形式，再交给 _fullpath 去规范化。
         * 这里用 '/' 而不是 '\\'：Windows 与 POSIX 都认它，
         * 而 '\\' 在 C 字符串里还要写成四个反斜杠，可读性差。 */
        m = snprintf(up, sizeof(up), "%s/..", cur);
        if (m < 0 || (size_t)m >= sizeof(up)) {
            return -1;
        }
        path_to_absolute(up, next, sizeof(next));
        path_strip_trailing_sep(next);

        if (strcmp(next, cur) == 0) {
            return -1;          /* 走不动了：已在根上 */
        }
        snprintf(cur, sizeof(cur), "%s", next);
    }

    snprintf(out, cap, "%s", cur);
    return 0;
}

/* --------------------------------------------------------------------------
 *  判断路径是否为"绝对路径"
 *
 *  ★ 为什么不用 <direct.h> 的 _fullpath / isabs：
 *      它们是 MSVC/MinGW 特有的，POSIX 上没有；而本文件要求
 *      "同一份代码在两个编译器上都能编"。手写判据只有几行，
 *      而且判据本身是跨平台常识（POSIX 以 '/' 开头，
 *      Windows 上还可以是 "C:\" 或 UNC 的 "\\\\server\share"）。
 *
 *  ★ 为什么要判它：
 *      规格要求 --pic 给【绝对路径】时"直接用它，不前缀任何根"。
 *      如果拿绝对路径去拼 "D:/proj/..//D:/pics"，得到的必然是个
 *      不存在的路径，然后一路探测失败 —— 用户会觉得"我给了绝对路径
 *      反而用不了"，比相对路径还难理解。
 * -------------------------------------------------------------------------- */
static int path_is_absolute(const char *p)
{
    if (p == NULL || p[0] == '\0') {
        return 0;
    }
    if (p[0] == '/' || p[0] == '\\') {
        return 1;               /* POSIX 根，或 Windows 的 "\" / UNC 前缀 */
    }
    /* 盘符形式："C:" 或 "C:/..." / "C:\..."。
     * ★ 注意必须要求 p[2] 是分隔符（或字符串到此为止）：
     *   否则 "C:foo"（相对当前盘的相对路径）会被误判成绝对路径，
     *   而它不是 —— 这种形态极少见，但误判的代价是路径彻底失效。 */
    if (isalpha((unsigned char)p[0]) && p[1] == ':') {
        if (p[2] == '\0' || p[2] == '/' || p[2] == '\\') {
            return 1;
        }
    }
    return 0;
}

/* 取得"自身可执行文件所在目录"的绝对路径，写进 out。
 *
 * ★ 三级回退，每一级都比上一级弱，但都能给出一个可用的答案：
 *
 *   ① GetModuleFileNameA（仅 _WIN32）
 *      ★ 这是最可靠的一级，因为它取的是进程映像的【真实路径】，
 *        与启动方式无关：
 *          · 用户双击 exe            → 拿到完整路径
 *          · 从 PATH 里按名字启动    → 拿到完整路径（argv[0] 这时只有"scut_sim.exe"）
 *          · 用 8.3 短名 / 相对路径启动 → 拿到规范化后的完整路径
 *        argv[0] 在这三种情况下都会退化，而这一级不会。
 *      ★ size 用的是"字符数"而不是字节数：这个 API 同时存在 A/W 两版，
 *        A 版按【字符】计数，而我们的缓冲是 char[]（每字符 1 字节）。
 *        传 sizeof(buf) 恰好等于字符数，是安全的；传错只会在
 *        路径接近 512 时截断，那正是我们最不希望出问题的地方。
 *      ★ 拿到之后【必须】走 path_to_absolute：
 *        文档只保证"返回完整路径"，实践中在极少数启动方式下仍可能是
 *        相对形态。而我们后面要拿它拼 "../.."，相对形态会让整个推导
 *        建立在 CWD 之上 —— 那正是本 bug 的成因，不能在这里重新引入。
 *
 *   ② argv[0]（跨平台）
 *      把 argv[0] 当成路径去取目录，再绝对化。
 *      它可能是相对的（"..\build\scut_sim.exe"），绝对化之后一样能用。
 *
 *   ③ 最后的兜底："."
 *      连 argv[0] 都没有（理论上不可能，main 的契约保证 argv[0] 存在，
 *      但 argc == 0 在个别嵌入式 CRT 上确实出现过）。
 *      这时退化成"只试 CWD"，也就是【修复前的旧行为】。
 *      ★ 为什么这里不报错退出：路径推导失败不该让仿真跑不起来。
 *        "退化到旧行为"是一个可接受的降级，而"直接退出"会让一个
 *        本来还能用的环境彻底不可用。这跟本文件其它地方
 *        （坏图不中断、无图也继续）是同一种取向。
 *
 * 返回 0 = 拿到了 exe 目录；非 0 = 全部失败（out 被写成 "."）。
 * -------------------------------------------------------------------------- */
static int scut_exe_dir(const char *argv0, char *out, size_t cap)
{
    char tmp[SCUT_PATH_MAX];

    if (out == NULL || cap == 0) {
        return -1;
    }

#ifdef _WIN32
    {
        /* 先落进临时的绝对路径缓冲，再取目录 ——
         * 直接对 API 结果取目录也可以，但那会让"绝对化"这一步
         * 无处安放，而它是我们需要的（见上面的 ★）。 */
        DWORD n = GetModuleFileNameA(NULL, tmp, (DWORD)sizeof(tmp));

        if (n > 0 && (size_t)n < sizeof(tmp)) {
            path_to_absolute(tmp, out, cap);
            path_strip_trailing_sep(out);
            /* path_to_absolute 得到的是 exe 的完整路径，
             * 还要再退一级才是"目录"。这里复用同一个缓冲做原地收缩：
             * path_dir_of 从前往后读、只写更短的结果，原地安全。 */
            {
                char dir[SCUT_PATH_MAX];
                if (path_dir_of(out, dir, sizeof(dir)) == 0) {
                    snprintf(out, cap, "%s", dir);
                    path_strip_trailing_sep(out);
                    return 0;
                }
            }
        }
        /* n == 0：GetModuleFileNameA 失败；n >= sizeof(tmp)：被截断。
         * 两种都不能用 —— 截断的路径会指向一个错误的目录，
         * 而"错误的目录"比"没有目录"更危险（它可能真的存在）。 */
    }
#endif /* _WIN32 */

    if (argv0 != NULL && argv0[0] != '\0') {
        char dir[SCUT_PATH_MAX];

        if (path_dir_of(argv0, dir, sizeof(dir)) == 0) {
            path_to_absolute(dir, out, cap);
            path_strip_trailing_sep(out);
            return 0;
        }
        /* argv0 太长（>= SCUT_PATH_MAX）：绝对化也无从下手，
         * 退到第 ③ 级。不在这里打印警告，因为最终的"没找到图"警告
         * 会把试过的路径全列出来，那时用户能看到真正的问题所在。 */
    }

    snprintf(out, cap, ".");
    return -1;
}

/* ==========================================================================
 *  「工程根相对显示」—— 让报出去给用户看的路径尽量短
 *  --------------------------------------------------------------------------
 *  ★ 为什么必须做这件事（它不只是"好看"）：
 *      JSON 的 "pic" 字段是要显示在插件界面上的。修复路径解析之后，
 *      s_pic_dir 会变成一个绝对路径，于是界面上会出现
 *          D:/22车队管理/一轮考核/视觉组/集成仿真环境测试/scut71-project/pic/1/3.bmp
 *      这一长串把界面撑开、把真正有用的信息（第 3 张）挤到看不见的地方。
 *      用户需要的是"这一帧看的是哪张图"，而不是"这张图在磁盘的哪个角落"。
 *      所以显示层必须把它折回工程根的相对形式：pic/1/3.bmp。
 *
 *  ★ 为什么要独立成两个函数（一个负责"拼前缀"，一个负责"剥前缀"）：
 *      拼接与剥离用的是【同一条规则】：把根与相对部分用 '/' 接起来，
 *      或反过来把 "<根>/" 这一段前缀砍掉。规则写在一处、用在两处，
 *      将来只要有一处需要调整（例如根末尾带不带分隔符），
 *      两边不会各改一半 —— 那种"改了拼接忘了剥离"的错会静默地把
 *      所有路径都显示成绝对的，很难被发现。
 *
 *  ★ 大小写敏感性：
 *      Windows 的文件系统不区分大小写，`path_to_absolute` 得到的盘符
 *      可能是小写（实测 clang -O2 下 _fullpath 返回 "d:\..."），
 *      而我们拼出来的前缀用的是 exe 目录里原样的大写。
 *      直接 strncmp 会因此匹配失败、显示退回绝对路径 —— 功能不算坏，
 *      但用户看到的正是我们想消掉的那串长路径。
 *      所以在 _WIN32 上比较前缀时统一按 ASCII 小写比较。
 *      POSIX 上路径区分大小写，必须严格比较，否则会把
 *      "/Home/me/pic" 误当作 "/home/me/pic" 的前缀而砍错。
 * ========================================================================== */

/* 前缀比较：a 的前 n 个字符是否与 b 相同（按平台决定是否忽略大小写）。 */
static int path_prefix_eq(const char *a, const char *b, size_t n)
{
    size_t i;

    for (i = 0; i < n; i++) {
#ifdef _WIN32
        if (tolower((unsigned char)a[i]) != tolower((unsigned char)b[i])) {
            return 0;
        }
#else
        if (a[i] != b[i]) {
            return 0;
        }
#endif
    }
    return 1;
}

/* 把相对路径 rel 拼到绝对根 root 之下，结果写进 out。 */
static void path_relative_to_root(const char *root, const char *rel,
                                  char *out, size_t cap)
{
    size_t rl;

    if (root == NULL || rel == NULL || out == NULL || cap == 0) {
        return;
    }
    rl = strlen(root);

    /* 根为空 / 根就是 "." 时，相对形式【就是】rel 本身。
     * ★ "." 这一支是 scut_exe_dir 第 ③ 级兜底会走到的情况：
     *   此时我们连工程根都没推出来，唯一能确定的就是 CWD。
     *   如果还硬拼 "./pic/1"，用户看到的是一个带 "./" 的路径，
     *   反而会以为哪里有毛病。 */
    if (rl == 0 || (rl == 1 && root[0] == '.')) {
        snprintf(out, cap, "%s", rel);
        return;
    }
    /* 根末尾已经带分隔符时不要再加一个，否则出现 "D:/a//pic/1"。
     * （path_strip_trailing_sep 已经保证了这一点，这里是第二道防线：
     *   这个函数是通用的，不应该假设调用者一定剥过。） */
    if (root[rl - 1] == '/' || root[rl - 1] == '\\') {
        snprintf(out, cap, "%s%s", root, rel);
    } else {
        snprintf(out, cap, "%s/%s", root, rel);
    }
}

/* 如果 abs 确实位于 root 之下，就把它【改写】成相对 root 的形式；
 * 否则原样保留（规格要求：真的在工程外就保持绝对路径）。
 * 原地改写，因为调用点只想拿到"一行可打印的路径"。
 * 返回 1 表示确实改写了（即结果是相对形式）。 */
static int path_make_root_relative(char *abs, const char *root)
{
    size_t rl;
    size_t al;

    if (abs == NULL || root == NULL || root[0] == '\0') {
        return 0;
    }
    rl = strlen(root);
    al = strlen(abs);

    if (rl == 1 && root[0] == '.') {
        return 0;               /* 根未知，没有可剥离的前缀 */
    }
    /* ★ root 与 abs 完全相同（"图恰好就在工程根上"）时也不能剥：
     *   剥掉之后 abs 会变成空串，而空串在报告里显示为一个空的双引号，
     *   看起来像"没找到图"，而事实恰恰相反 —— 图找到了。
     *   保持不变（绝对路径）至少是诚实的，虽然长一点。 */
    if (al == rl) {
        return 0;
    }
    /* 必须要求 abs 比 root 【多出】"<分隔符><至少一个字符>"。
     * ★ 只判 al > rl 是不够的：root="pic/1"、abs="pic/12/1.bmp" 时
     *   al > rl 也成立，但 "pic/12" 并不是 "<pic/1>/" 的子路径。
     *   多判一个分隔符，就把这种"同名前缀"的误剥离堵死了。 */
    if (al <= rl + 1) {
        return 0;
    }
    if (!path_prefix_eq(abs, root, rl)) {
        return 0;
    }
    if (abs[rl] != '/' && abs[rl] != '\\') {
        return 0;
    }

    /* 原地左移：memmove 而不是 memcpy —— 源与目标在同一个缓冲区里重叠，
     * 用 memcpy 是未定义行为。这里重叠区一定是"目标在前、源在后"，
     * 用 memmove 语义明确且没有额外代价。 */
    memmove(abs, abs + rl + 1, al - rl - 1 + 1);   /* +1 把结尾 NUL 一起搬 */
    return 1;
}

/* --------------------------------------------------------------------------
 *  「文件是否存在」探测
 *
 *  ★ 为什么用 fopen 而不是 stat：
 *      本项目只保证标准 C 库可用。<sys/stat.h> 在 Windows/MinGW 与
 *      POSIX 上的结构体名（struct _stat / struct stat）、
 *      大文件变体（_stat64）、乃至可用性都不同，为了一次存在性判断
 *      引入一整套平台差异不划算。fopen 是标准 C，且对「目录」和
 *      「不存在的文件」都会失败——而这两种情况我们都只想当成「没有」。
 *      代价是每张图多一次真实打开（几十微秒），探测阶段完全可接受。
 *
 *  ★ 以二进制模式打开：文本模式在 Windows 上会做 CRLF 转换，
 *      虽然这里立刻关闭、不读内容，但保持"探测与读取用同一种模式"
 *      可以避免将来有人把这段代码改成顺带读几字节时踩坑。
 * -------------------------------------------------------------------------- */
static int pic_file_exists(const char *path)
{
    FILE *f = fopen(path, "rb");

    if (f == NULL) {
        return 0;
    }
    fclose(f);
    return 1;
}

/* --------------------------------------------------------------------------
 *  路径拼接
 *
 *  ★ 为什么要手写而不是拼字符串：
 *      工程路径里可能同时含【空格】与【中文】（本项目的硬要求，
 *      测试工程就叫 "scut proj 中文"）。手写的好处是：不做任何
 *      引号/转义处理——路径是直接交给 fopen 的，由 C 库拿到完整字节串，
 *      根本不存在"被 shell 拆成两个参数"的机会。
 *      反过来，如果用 system() 去拼命令，就必须处理引号；
 *      那正是"含空格的路径"翻车的经典位置，所以这里刻意绕开。
 *
 *  返回 0 成功，非 0 表示目标缓冲区放不下（此时不做任何截断写）。
 *  截断是绝对不能接受的：路径被截断后 fopen 只会报"文件不存在"，
 *  用户看着自己明明存在的文件，完全无从理解。
 * -------------------------------------------------------------------------- */
static int pic_join(char *dst, size_t cap, const char *dir,
                    int index, const char *ext)
{
    int n;

    /* %s/%d%s —— 中间那个斜杠是刻意【只写一个】的：
     * Windows 与 POSIX 都把 '/' 当路径分隔符，正斜杠两边通用；
     * 而 '\' 在 Windows 上虽然是分隔符，却要处理"目录末尾已有斜杠"
     * 的去重问题。统一用 '/' 并容忍末尾多余的 '/'（Windows 上
     * "a//b" 与 "a/b" 等价），代码最短且行为正确。 */
    n = snprintf(dst, cap, "%s/%d%s", dir, index, ext);
    if (n < 0) {
        return -1;              /* 编码错误，标准里是负值 */
    }
    if ((size_t)n >= cap) {
        return -1;              /* 放不下：宁可报错，也不要截断出假路径 */
    }
    return 0;
}

/* 取扩展名列表里的第 k 项（k 从 0 起），写入 out。
 * 越界（没有第 k 项）返回 0，否则返回 1。
 *
 * ★ 为什么支持逗号分隔：
 *      config.h 里写明 SCUT_PIC_EXT 可以写成 ".bmp,.png"，
 *      旧环境也这么宣传过。既然文档承诺了，就必须真的实现——
 *      否则用户照着文档写 ".bmp,.png"，得到的是形如 "1.bmp,.png"
 *      的文件名，探测一张都找不到，然后一路黑屏跑完。
 *
 * ★ 为什么容忍空白与前后多余逗号：
 *      宏写成 ".bmp, .png"（逗号后带空格）在人眼里完全正常。
 *      如果解析器不容忍，用户会得到"文件明明存在却找不到"的怪现象，
 *      而这种输入错误在代码里根本看不出来。多写几行，换掉一整类困惑。
 * -------------------------------------------------------------------------- */
static int pic_ext_nth(const char *list, int k, char *out, size_t cap)
{
    int   seen = 0;
    size_t o;

    if (list == NULL || out == NULL || cap == 0) {
        return 0;
    }

    while (*list != '\0') {
        const char *comma;
        const char *seg;
        const char *end;
        size_t      len;

        comma = strchr(list, ',');
        seg   = list;
        end   = comma ? comma : (list + strlen(list));

        /* 跳过段首空白 */
        while (seg < end && isspace((unsigned char)*seg)) { seg++; }
        /* 回退段尾空白 */
        while (end > seg && isspace((unsigned char)end[-1])) { end--; }

        len = (size_t)(end - seg);
        if (len > 0) {
            if (seen == k) {
                if (len + 1 > cap) {
                    return 0;   /* 单个扩展名过长：当成没有这一项 */
                }
                for (o = 0; o < len; o++) {
                    out[o] = seg[o];
                }
                out[len] = '\0';
                return 1;
            }
            seen++;
        }
        /* 空段（"a,,b" / ",a"）直接跳过，不计入序号：
         * 它们显然是笔误，没有理由让它们把后面的有效扩展名顶掉。 */
        if (comma == NULL) {
            break;
        }
        list = comma + 1;
    }
    return 0;
}

/* --------------------------------------------------------------------------
 *  在给定目录下数一数"连续编号的测试图"有多少张
 *
 *  ★ first 参数是本轮新增的「起始编号」：
 *      用户的图片集既可能是 pic/0.png, pic/1.png, …（0 起，工具导出的
 *      常见形态），也可能是旧约定的 1.bmp, 2.bmp, …（1 起）。
 *      数数必须从各自的起点开始 —— 0 起的图集若从 1 数起，会把
 *      第一张漏掉、总数少一，且报出来的范围整体错位。
 *
 *  ★ 为什么把这段从 resolve_pic_set 里抽出来：
 *      候选根是【多个】，每个都要试一次"这个根下面有几张图"。
 *      如果探测逻辑内联在候选循环里，就会出现"探测写两遍"的局面
 *      （第一遍判断候选是否命中、第二遍数最终目录里的张数），
 *      而两遍的规则一旦有细微差别（例如一遍认逗号分隔的扩展名、
 *      另一遍只认第一个），就会出现"命中了 X 根、却在 X 根里数出 0 张"
 *      的自相矛盾。抽成函数之后规则只有一份，两处调用不可能不一致。
 *
 *  ★ 返回值的语义是"最多数到 limit 张"：
 *      resolve_pic_set 用 limit = SCUT_PIC_INDEX_MAX 得到真实张数；
 *      候选命中判断用 limit = 1，只关心"起点那张存不存在"。
 *      用同一个函数而不是写一个专门的 has_first_pic()，
 *      是因为"第一张存在"本来就是"张数 >= 1"，
 *      为它单独写一份判断等于把同一件事表达两遍。
 *
 *  ★ 为什么必须用【同一套扩展名规则】：
 *      规格写的是"第一个真的含 1.<ext> 的候选胜出"，其中的 <ext>
 *      就是这里用的 s_pic_ext（已含 --ext / SCUT_PIC_EXT 的逗号分隔多项）。
 *      若候选判断只看 ".bmp"、而正式计数看全部扩展名，
 *      一个只有 1.png 的图集就会"候选不命中 → 落到别的根"，
 *      用户会觉得"我明明给了 --ext .png 却说没图"。
 * -------------------------------------------------------------------------- */
static int pic_count_in_dir(const char *dir, int first, int limit)
{
    int found = 0;

    for (;;) {
        char ext_buf[64];
        int  k;
        int  num_exists = 0;

        if (found >= limit || found >= SCUT_PIC_INDEX_MAX) {
            /* 两个上限都要判：limit 是调用方给的"数到这儿就够了"，
             * SCUT_PIC_INDEX_MAX 是"目录有病"的全局保险，缺一不可。 */
            break;
        }

        for (k = 0; pic_ext_nth(s_pic_ext, k, ext_buf, sizeof(ext_buf)); k++) {
            char candidate[SCUT_PATH_MAX];

            if (pic_join(candidate, sizeof(candidate),
                         dir, first + found, ext_buf) != 0) {
                /* 拼不出路径（太长）：这一张当作不存在，继续。
                 * 不在这里刷屏——最终"找到 0 张"的警告里会带上目录与模式，
                 * 那条信息已经足够定位。 */
                continue;
            }
            if (pic_file_exists(candidate)) {
                num_exists = 1;
                break;      /* 已确认该编号存在，不必再试后面的扩展名 */
            }
        }

        if (!num_exists) {
            break;          /* 编号 first+found 不存在 => 图集到此为止 */
        }
        found++;
    }
    return found;
}

/* --------------------------------------------------------------------------
 *  探测图集的起始编号：0.<ext> 存在 → 0 起；否则维持旧约定 1 起。
 *
 *  ★ 为什么做成自动探测而不是加一个命令行开关：
 *      "编号从几起"是【图集的事实】，不是【用户的偏好】。
 *      做成开关，用户就必须先看清自己的图再回来改参数——
 *      忘了改的人会得到"第一张永远是黑的"（0 起图集被当 1 起数，
 *      编号 0 那张永远轮不到），而且毫无报错线索。
 *      自动探测让这个事实只看磁盘：有 0.<ext> 就按 0 起，
 *      没有（多半是旧的 BMP 集）就维持 1 起，两边都不破坏。
 * -------------------------------------------------------------------------- */
static int pic_detect_first_index(const char *dir)
{
    char ext_buf[64];
    int  k;

    for (k = 0; pic_ext_nth(s_pic_ext, k, ext_buf, sizeof(ext_buf)); k++) {
        char candidate[SCUT_PATH_MAX];

        if (pic_join(candidate, sizeof(candidate), dir, 0, ext_buf) == 0 &&
            pic_file_exists(candidate)) {
            return 0;               /* 0.<ext> 存在：图集从 0 起编号 */
        }
    }
    return 1;                       /* 没有 0.<ext>：维持旧约定的 1 起 */
}

/* --------------------------------------------------------------------------
 *  探测图集：确定目录、确定总数、夹取起始编号
 *
 *  目录优先级：--pic DIR > config.h 的 SCUT_PIC_DIR > "pic/1"
 *  扩展名优先级：--ext > config.h 的 SCUT_PIC_EXT > ".bmp"
 *
 *  ★ 目录【怎么解析】是本函数的核心，规则如下（顺序即优先级）：
 *
 *      情况 A：--pic 给的是【绝对路径】
 *              → 直接用它，不前缀任何根。用户已经把话说全了，
 *                我们再自作聪明地加前缀只会拼出一个不存在的路径。
 *
 *      情况 B：--pic 给的是【相对路径】（或没给，用 SCUT_PIC_DIR）
 *              → 依次尝试下面这些"根"，第一个根下真的含 1.<ext> 的胜出：
 *                  ① <exe 目录>/..          （.scut/bin → .scut）
 *                  ② <exe 目录>/../..       （.scut/bin → 工程根）★ 主命中路径
 *                  ③ 进程当前工作目录 CWD   （旧的、修复前唯一的行为）
 *
 *  ★ 为什么把 CWD 放在【最后】：
 *      ①②是"由 exe 位置推导出来的工程根"，它是这个环境的约定；
 *      ③是历史遗留的用法。让约定优先、历史兜底，既修好了
 *      "插件用 cwd=.scut/bin 启动"这个真正的 bug，又不会让
 *      "一直在放图目录里启动"的老用法在升级后静默失效。
 *      如果顺序反过来（CWD 优先），在极少数"CWD 下恰好有一组同名图"
 *      的场景里，用户会拿到 CWD 的那组而不是工程的，依然是个陷阱。
 *
 *  ★ 为什么"命中"的标准是【1.<ext> 真的存在】而不是"目录存在"：
 *      .scut/、.scut/bin/ 这些目录在任何工程里都【必然】存在
 *      （它们是构建产物目录）。如果用"目录存在"当判据，
 *      候选①②会在 .scut/ 上就命中并锁定，实际却一张图都没有 ——
 *      依然黑屏。只有"第一张图真的在"才算命中，
 *      才真正回答了"图集到底在哪里"这个问题。
 *
 *  ★ 为什么命中判断用的是编号 1（而不是 --frame 指定的编号）：
 *      探测规则本身就是"编号从 1 起且连续"，编号 1 是这套约定的锚点。
 *      用 --frame 指定的编号去判断会让结果依赖用户翻页的位置：
 *      用户翻到第 30 张时，一个只有 5 张图的目录会被判成"不命中"，
 *      于是根被换掉、张数变成 0 —— 翻页反而把图集翻没了。
 *      锚在 1 上，探测结果就与 --frame 完全无关，稳定且可预期。
 * -------------------------------------------------------------------------- */
static void resolve_pic_set(const options_t *o)
{
    const char *dir = (o->pic_dir != NULL) ? o->pic_dir : SCUT_PIC_DIR;
    const char *ext = (o->pic_ext != NULL) ? o->pic_ext : SCUT_PIC_EXT;
    char        exe_dir[SCUT_PATH_MAX];
    /* ★ 候选根与"试过的完整路径"为什么要分成两张表：
     *   候选根是给探测用的，"完整路径"是给用户看的。
     *   同一个根会因为扩展名不同而派出多条完整路径（pic/1/1.bmp、
     *   pic/1/1.png），用户真正需要核对的是后者 —— 他要拿着这个字符串
     *   去磁盘上按图索骥。"我试过 <根>/pic/1" 比只给一个根有用得多。 */
    char        roots[SCUT_PIC_TRY_MAX][SCUT_PATH_MAX];
    char        tried[SCUT_PIC_TRY_MAX][SCUT_PATH_MAX];
    int         root_cnt = 0;
    int         dir_is_abs;
    int         i;
    int         n;
    int         found = 0;

    /* 目录为空串（例如命令行写了 --pic ""）时回落到编译期默认值，
     * 而不是拿空串去拼出 "/1.bmp" 这种一定失败、且看着莫名其妙的路径。 */
    if (dir == NULL || dir[0] == '\0') {
        dir = SCUT_PIC_DIR;
    }
    if (ext == NULL || ext[0] == '\0') {
        ext = SCUT_PIC_EXT;
    }

    /* 扩展名要先落进 s_pic_ext：下面的候选探测要用它，所以顺序不能挪。 */
    n = snprintf(s_pic_ext, sizeof(s_pic_ext), "%s", ext);
    if (n < 0 || (size_t)n >= sizeof(s_pic_ext)) {
        /* 扩展名过长：这不是路径问题，直接截断观察（它只用于打印与探测），
         * 但必须给出提示，否则用户会以为扩展名写错了。 */
        fprintf(stderr,
            "警告: --ext / SCUT_PIC_EXT 过长，已截断到 %d 字节：%s\n",
            (int)sizeof(s_pic_ext) - 1, s_pic_ext);
    }

    /* ---- 0) 先求出 exe 目录与工程根 ----
     * ★ 这一步放在最前面，是因为后面两个候选根完全依赖它。
     *   它失败时（见 scut_exe_dir 的三级回退）只会退化成 ".",
     *   于是候选退化成"只试 CWD"，也就是修复前的旧行为 ——
     *   不会崩、不会误报，只是少了新能力。 */
    scut_exe_dir(o->argv0, exe_dir, sizeof(exe_dir));

    /* 工程根 = exe 目录的上一级再上一级（<工程>/.scut/bin → <工程>）。
     * ★ 用 path_go_up 一级一级走，而不是拼 "../.."：
     *   后者得到的字符串里会留着字面的 "bin/../.."，
     *   字符串比较就全失效了（详见 path_go_up 上方的实测说明）。
     *   走不通时 s_proj_root 保持为空串，后面的相对化会自动放弃，
     *   显示退回绝对路径 —— 难看，但正确。 */
    s_proj_root[0] = '\0';
    (void)path_go_up(exe_dir, 2, s_proj_root, sizeof(s_proj_root));

    /* ---- 1) 收集候选根 ----
     * ★ 用同一份数组既驱动探测、又驱动警告输出：
     *   用户看到的"我试过这些"与实际"程序试过这些"必然是同一批，
     *   不可能出现"警告里少列了一条、而程序其实试过"的错位。 */
    dir_is_abs = path_is_absolute(dir);

    if (dir_is_abs) {
        /* 情况 A：绝对 --pic，直接作为唯一候选，不前缀任何根。
         * ★ 必须先去掉末尾多余的分隔符（"D:/pics/1/" → "D:/pics/1"）。
         *   这不是审美问题，不去的后果是【真的找不到图】：
         *   pic_join 用 "%s/%d%s" 拼，末尾那个 '/' 会一直留在目录部分，
         *   而 s_pic_dir 随后会被当作【前缀】去做工程根相对化的比较。
         *   实测过：`--pic "D:/.../pic/1\"` 会得到 ".../pic/1/"，
         *   于是它和工程根 ".../scut71-project" 的前缀比较虽然能通过，
         *   剥出来的相对路径却多一层语义，最终 fprint 出来的
         *   与 pic_join 拼出来的不是同一个字符串 —— 一处不一致，
         *   后面所有基于字符串的推断都会跟着错。
         *   统一成"末位非分隔符"这一种形态，全流程只有一种写法。 */
        snprintf(roots[root_cnt], sizeof(roots[root_cnt]), "%s", dir);
        path_strip_trailing_sep(roots[root_cnt]);
        root_cnt++;
    } else {
        /* ① <exe 目录>/.. —— 旧布局 <工程>/.scut/bin/ 若图集在
         *    <工程>/.scut/pic/ 下，命中它的是这一条。
         * ② <exe 目录>/../.. —— 当前布局 <工程>/.scut/bin/ 的主命中路径。
         *    ★ 两条都用 path_go_up 一级级走，理由同上：拼 "../.."
         *      会留下未折叠的字面量，候选路径虽然还能被 fopen 打开，
         *      但打印给用户的清单会长得莫名其妙（".../bin/../.."），
         *      而那份清单正是用户用来核对的，越干净越好。
         *    ★ ①走不通时跳过而不是放弃②：走不通只说明 exe 已经在根上，
         *      这属于"环境异常"而非"用户输错"，没必要因此放弃另一个
         *      本来可能命中的候选。 */
        if (path_go_up(exe_dir, 1, roots[root_cnt], sizeof(roots[root_cnt])) == 0) {
            root_cnt++;
        }
        if (path_go_up(exe_dir, 2, roots[root_cnt], sizeof(roots[root_cnt])) == 0) {
            root_cnt++;
        }

        /* ③ 进程当前工作目录（旧行为，最后才试）。
         *    ★ 这里存 "." 而不是 getcwd() 的结果，理由有三：
         *      1) "." 在候选表里可读，用户一看就懂"这是当前目录"；
         *      2) 它天然就是"相对当前目录"的语义，不需要额外一次
         *         getcwd 调用，也就不需要处理"getcwd 失败"的分支；
         *      3) 探测用的 fopen 本来就按 CWD 解析相对路径，
         *         行为与修复前【逐字节一致】，兼容性最有保障。 */
        snprintf(roots[root_cnt], sizeof(roots[root_cnt]), ".");
        root_cnt++;
    }

    /* ---- 2) 逐个候选尝试，第一个真的有图的胜出 ----
     *
     * ★ 候选有两种语义，绝不能混：
     *     · 相对 --pic：roots[i] 是【根】，真正的目录是 <根>/<dir>。
     *     · 绝对 --pic：roots[i] 本身就是【目录】，不能再拼 dir。
     *   前一版在这里吃了个大亏：绝对 --pic 被当成根放进 roots[]，
     *   随后照样走 path_relative_to_root(roots[i], dir, ...)，
     *   结果拼出 "<绝对目录>/pic/1" 这样一个不存在的路径 ——
     *   而且它看起来"像个绝对路径"，下游的工程根相对化逻辑
     *   还会把字符串剥到只剩盘符（实测 "pic":"C:"）。
     *   于是用户传了正确的绝对路径，却得到一张黑图，毫无线索。 */
    s_pic_dir[0] = '\0';
    s_pic_count  = 0;

    for (i = 0; i < root_cnt; i++) {
        char full[SCUT_PATH_MAX];
        char ext_buf[64];
        char one[SCUT_PATH_MAX];
        int  first;

        /* 候选根是 "." 时，相对形式【就是】dir 本身（不带 "./" 前缀），
         * 免得用户看到一个"其实等价但看着奇怪"的路径。
         * ★ 绝对 --pic 分支里 roots[i] 存的是【目录本身】，
         *   这里必须原样拿来用，所以用 dir_is_abs 分流。 */
        if (dir_is_abs) {
            snprintf(full, sizeof(full), "%s", roots[i]);
        } else {
            path_relative_to_root(roots[i], dir, full, sizeof(full));
        }

        /* ★ 起始编号按【本候选目录】逐个探测：
         *   0 起与 1 起的图集可能同时存在于不同候选根（例如工程里既有
         *   pic/0.png 又有 pic/1/1.bmp）。候选命中与计数必须用同一个
         *   起点，否则"命中判据"与"张数"会各说各话。 */
        first = pic_detect_first_index(full);

        /* 记下"试过的完整路径"：不只看目录，还要按扩展名展开成具体文件名，
         * 因为用户真正需要核对的正是"1.bmp 到底在不在这个位置"。
         * ★ 0 起的图集锚点是 0.<ext>，报给用户看的也必须是 0.<ext>，
         *   否则清单与探测行为对不上。 */
        if (pic_ext_nth(s_pic_ext, 0, ext_buf, sizeof(ext_buf)) &&
            pic_join(one, sizeof(one), full, first, ext_buf) == 0) {
            snprintf(tried[i], sizeof(tried[i]), "%s", one);
        } else {
            snprintf(tried[i], sizeof(tried[i]), "%s", full);
        }

        /* ★ 命中判断：这个目录下至少要有【起点那张】图（first 张）。
         *   limit 传 1 —— 这里只关心"有没有"，不数总数。
         *   数总数要按 SCUT_PIC_INDEX_MAX 完整跑一遍（对稀疏编号的目录
         *   代价不小），只有胜出的那一个候选才值得付这个代价。 */
        if (pic_count_in_dir(full, first, 1) > 0) {
            snprintf(s_pic_dir, sizeof(s_pic_dir), "%s", full);
            /* 胜出之后再完整数一遍，得到真实张数（同一起点）。
             * 起始编号随之记下，供编号夹取与逐帧推进使用。 */
            s_pic_first = first;
            found = pic_count_in_dir(full, first, SCUT_PIC_INDEX_MAX);
            break;
        }
    }

    s_pic_count = found;

    /* ---- 3) 一个候选都没命中 ----
     * ★ 为什么不在这里直接 return、而要走到下面的"零张图"警告：
     *   那条警告是整段功能里信息量最大的一段（它解释了"为什么是黑图"），
     *   在这里提前返回就会把它整个跳过，用户又回到"只能自己猜"的状态。
     *   所以这里只把 s_pic_dir 设成一个"看得懂的占位值"，让警告照常输出。 */
    if (s_pic_count <= 0) {
        /* 目录字符串过长（>= 缓冲上限）时截断是不行的，见 pic_join 的说明。
         * 这里退化为"没有任何图"，并明确告知，而不是悄悄用半截路径去探测。 */
        n = snprintf(s_pic_dir, sizeof(s_pic_dir), "%s", dir);
        if (n < 0 || (size_t)n >= sizeof(s_pic_dir)) {
            s_pic_dir[0] = '\0';
            fprintf(stderr,
                "警告: 测试图目录路径过长（上限 %d 字节），已按「没有测试图」处理。\n"
                "      路径: %s\n"
                "      原因: 路径被截断后会指向一个不存在的文件，"
                "与其给出一个假路径，不如直接说明。\n"
                "      下一步: 把图集放到更短的路径下，或用 --pic 指定。\n",
                (int)sizeof(s_pic_dir) - 1, dir);
        }
    }

    /* ---- 起始编号夹取 ----
     * ★ 为什么这里必须夹而不是报错退出：
     *   IDE 用 --frame 实现"翻页看某一张图"。用户在上一次会话里
     *   翻到了第 20 张，而这次打开的工程只有 5 张图——这时
     *   「退出并报错」会让 IDE 直接打不开，用户完全不知道自己做错了什么。
     *   「夹到合法范围并说明」则让仿真照常可用，同时把事实讲清楚。
     *   这条与"没有测试图也要能跑"是同一种取向：证据可以少，
     *   但流程不能被一个可恢复的输入问题掐断。
     *
     * ★ 合法范围是 [first, first+count-1]，下限不再是写死的 1：
     *   0 起的图集里 first=0 是合法请求（"从第一张开始"），
     *   按旧规则夹到 1 反而会跳过第一张 —— 又是那种"不报错但错"。
     * ★ 用户没有给 --frame 时，默认值跟随探测结果（第一张），
     *   这样 0 起的图集【默认就从 0 号图开始跑】。 */
    if (o->frame_index_given) {
        s_pic_index = o->frame_index;
    } else {
        s_pic_index = s_pic_first;   /* 默认 = 图集第一张（编号基准随探测） */
    }
    if (s_pic_count > 0) {
        if (s_pic_index < s_pic_first) {
            fprintf(stderr,
                "警告: --frame %d 低于图集起始编号（本图集从 %d 起编号），"
                "已改用第 %d 张。\n"
                "      目录: %s\n",
                o->frame_index, s_pic_first, s_pic_first, s_pic_dir);
            s_pic_index = s_pic_first;
        } else if (s_pic_index > s_pic_first + s_pic_count - 1) {
            fprintf(stderr,
                "警告: --frame %d 超出图集范围（共 %d 张，编号 %d..%d），"
                "已改用第 %d 张。\n"
                "      目录: %s\n",
                o->frame_index, s_pic_count,
                s_pic_first, s_pic_first + s_pic_count - 1,
                s_pic_first + s_pic_count - 1, s_pic_dir);
            s_pic_index = s_pic_first + s_pic_count - 1;
        }
    } else {
        s_pic_index = 1;    /* 无图可加载，编号保持 1 以免后续拼出 "0.bmp" */
    }

    /* ---- 零张图：不是致命错误，但必须说清「为什么画面是黑的」 ----
     *
     * ★ 这条警告是整个功能里最重要的一段话。
     *   缺口修复之前，"画面全黑"是一个没有任何提示的默认行为，
     *   用户只能自己猜。所以这里刻意把几件事一次说全：
     *     ① 找不到图的【事实】；
     *     ② 搜的【每一个】候选位置（★ 这一段是本轮新增的重点）；
     *     ③ 期望的【文件名模式】；
     *     ④ 后果（黑图）与【下一步怎么做】。
     *   并把 SCUT_PIC_DIR / SCUT_PIC_EXT 两个宏名点出来——
     *   用户拿这两个名字才能在 config.h 里搜到该改哪一行。
     *
     * ★★ 为什么"把试过的路径全列出来"是必须的：
     *   修复前那条警告说"相对目录是相对进程当前工作目录解析的"。
     *   这在当时是事实，但它没有回答用户真正的问题 ——
     *   「我明明把图放在 pic/ 下了，你到底是去哪儿找的？」
     *   于是用户只能靠猜：猜 CWD 是什么、猜插件怎么启动进程、
     *   猜 --pic 有没有被传进来。这正是规格点名的"不能变成一场猜谜"。
     *   现在把试过的每一处连同"为什么去那里找"一起原样列出，
     *   用户对着这份清单逐个看一眼磁盘，就能直接指出
     *   "图应该在第二条，但那里没有" —— 从猜谜变成核对。
     *
     * ★ 每一条都标出【来源】，而不是只给路径：
     *   路径本身只说明"去了哪"，来源才说明"凭什么去那"。
     *   用户看到"exe 所在目录的上两级"才能反应过来
     *   "哦，它是按 exe 位置推工程根的，而我的图不在工程里"。 */
    if (s_pic_count <= 0) {
        fprintf(stderr,
            "警告: 没有找到任何测试图，仿真将在【全黑图像】上运行。\n"
            "      搜索目录: %s\n"
            "      期望文件名: <目录>/0%s, <目录>/1%s, ...（0.<ext> 存在则从 0 起编号；\n"
            "                  否则按旧约定 1%s, 2%s, ... 从 1 起）\n"
            "      配置来源: 目录取自 --pic，未指定时取 config.h 的 SCUT_PIC_DIR（当前 \"%s\"）；\n"
            "                扩展名取自 --ext，未指定时取 config.h 的 SCUT_PIC_EXT（当前 \"%s\"）。\n"
            "      已尝试的位置（按优先级，越靠前越优先，第一个真的含起始编号那张的会被采用）:\n",
            s_pic_dir, s_pic_ext, s_pic_ext, s_pic_ext, s_pic_ext,
            SCUT_PIC_DIR, SCUT_PIC_EXT);

        for (i = 0; i < root_cnt; i++) {
            const char *origin;

            if (dir_is_abs) {
                origin = "由 --pic 直接指定（绝对路径，未做任何前缀拼接）";
            } else if (i == 0) {
                origin = "exe 所在目录的上一级（<exe目录>/..）";
            } else if (i == 1) {
                origin = "exe 所在目录的上两级（<exe目录>/../..，通常就是工程根）";
            } else {
                origin = "进程当前工作目录 CWD（最后一级兜底候选）";
            }
            fprintf(stderr, "        %d) %s\n              ← %s\n",
                    i + 1, tried[i], origin);
        }

        fprintf(stderr,
            "      说明: 上面每一条都是「该位置 + 期望文件名」的展开形式"
            "（0 起图集为各处 0%s、1%s…；1 起图集为各处 1%s、2%s…），"
            "程序按 1) 2) 3) 的顺序逐个去看；\n"
            "            一条都没有找到，所以从本帧起输入全是黑图。\n"
            "      注意: 相对目录【不再】只按进程当前工作目录解析了 —— "
            "那正是修复前插件启动时找不到图的根因；\n"
            "            现在优先按 exe 自身的位置反推工程根，"
            "因此从任何目录启动都应该得到相同结果。\n"
            "      后果: 算法会在全零图像上运行 —— 直方图会全部堆在第 0 桶、\n"
            "            丢线计数会等于图像高度、阈值会掉到下限。\n"
            "            这些都是【没有输入图像】造成的，不是算法的问题。\n"
            "      下一步(任选其一):\n"
            "        1) 对着上面的清单一处处看一眼：把图集放到其中某一处，\n"
            "           文件名按上面的模式命名（多数工程的正确位置是第 2 条）；\n"
            "        2) 用 --pic 指定图集目录（推荐用绝对路径，避免工作目录歧义）；\n"
            "        3) 修改 config.h 里的 SCUT_PIC_DIR / SCUT_PIC_EXT 指到已有的图集。\n"
            "      另注: 当前版本的解码器支持 BMP（24 位与 8 位调色板）与 PNG\n"
            "            （8 位灰度/真彩/调色板，非交织）；JPEG 请先转成上述格式。\n",
            s_pic_ext, s_pic_ext, s_pic_ext, s_pic_ext);
    }
}

/* --------------------------------------------------------------------------
 *  把第 index 张图加载进输入缓冲
 *
 *  ★ 为什么每次都要「先清零再加载」：
 *      解码器的契约写明——源图比目标【小时】，未被覆盖的区域保留 dst 原值
 *      （它刻意不填黑，好让上层自行决定背景色）。于是如果我们不清零，
 *      上一张图残留的像素就会留在右侧/下方，得到一张"两张图叠在一起"
 *      的画面。这种拼贴图看起来完全不像 bug，更像算法把边缘搞错了，
 *      排查代价极高。清零一行 memset 就能彻底消灭它。
 *
 *  ★ 为什么失败时不 return 而是继续：
 *      一张坏图或一个不支持的格式，不该让整场仿真失败。继续跑，
 *      但把「这一帧的输入是黑的」讲清楚——安静地继续才是真正的坑。
 *
 *  返回 0 = 成功加载；非 0 = 未加载（输入缓冲已被清零，等价于黑图）。
 * -------------------------------------------------------------------------- */
static int scut_pic_load(int index)
{
    scut_u8 *dst;
    int      w;
    int      h;
    char     path[SCUT_PATH_MAX];
    char     ext_buf[64];
    int      k;
    int      rc = SCUT_FRAME_ERR_OPEN;
    int      loaded = 0;

    /* ★ 先置空：下面的去重比较与错误打印都会读它。
     *   若扩展名列表为空（配置写错），拼路径的循环一次都不执行，
     *   不初始化就会读到栈垃圾并 strcmp —— 报出来的路径会是乱码，
     *   比不报还糟。一行初始化消掉这个可能。
     *   ★ 这里刻意不写"读栈垃圾"里那个百分号占位符的原文：
     *     fprintf 的格式串里 % 是转义引导符，一个孤立的 % 会变成
     *     未定义的转换说明，编译器会给出 -Wformat-extra-args 警告。
     *     注释里也一并避开，免得后来者复制粘贴时把警告带进代码。 */
    path[0] = '\0';

    w = scut_bind_width();
    h = scut_bind_height();
    dst = scut_bind_input();

    /* 尺寸或缓冲异常时什么都不做：这是"未准备好时安全空操作"的一贯契约。 */
    if (dst == NULL || w <= 0 || h <= 0) {
        return -1;
    }

    /* ★ 先清零：即使接下来一张图都找不到，输入也是干净的"黑"，
     *   而不是上一帧的残影。 */
    memset(dst, 0, (size_t)w * (size_t)h);

    /* 新的一次加载尝试开始：先清掉上一张图的失败记录。
     * ★ loadError 是【本帧】的状态，绝不能带着上一帧的旧值 ——
     *   否则"坏图之后换了好图"的那一帧会在 JSON 里报一个
     *   根本不属于它的错误。 */
    s_pic_err_code     = 0;
    s_pic_err_path[0]  = '\0';
    s_pic_err_reported = 0;
    s_pic_err_short[0] = '\0';

    s_pic_path[0] = '\0';

    if (s_pic_count <= 0) {
        /* ★ 无图集时也要填 loadError（这正是用户要的"弹通知"场景之一）：
         *   之前这里直接 return -1，只靠探测阶段的 stderr 解释 ——
         *   但扩展收不到 stderr，IDE 里就只是一张黑图，毫无线索。
         *   原因短语在探测阶段已经写好（见 resolve_pic_set 的警告段），
         *   这里只要把探测阶段记下的短句带出去即可。
         *   实测：--pic 指向不存在的目录时，帧 JSON 里会出现
         *   "loadError":"没有找到任何测试图…"，插件据此弹通知。 */
        snprintf(s_pic_err_short, sizeof(s_pic_err_short),
                 "没有找到任何测试图（图集为空），输入是全黑图像");
        return -1;
    }

    /* 编号回绕保护：调用方可能传入任何值，这里夹到图集的合法区间。
     * ★ 下限是 s_pic_first 而不是写死的 1：0 起编号的图集里，
     *   0 号是合法的第一张，按旧规则夹到 1 会把它静默跳过。 */
    if (index < s_pic_first)          { index = s_pic_first; }
    if (index > s_pic_first + s_pic_count - 1) {
        index = s_pic_first + s_pic_count - 1;
    }
    s_pic_index = index;

    for (k = 0; pic_ext_nth(s_pic_ext, k, ext_buf, sizeof(ext_buf)); k++) {
        if (pic_join(path, sizeof(path), s_pic_dir, index, ext_buf) != 0) {
            rc = SCUT_FRAME_ERR_BADARG;
            continue;
        }
        /* 探测阶段已确认该编号在某个扩展名下存在；这里按同样的优先级
         * 重新走一遍，是为了让"探测到的那一个"和"真正加载的那一个"
         * 用【同一套规则】，不会出现探测说有、加载却找不到的自相矛盾。 */
        if (!pic_file_exists(path)) {
            rc = SCUT_FRAME_ERR_OPEN;
            continue;
        }

        rc = scut_frame_load_image(path, dst, w, h, w);
        if (rc == SCUT_FRAME_OK) {
            snprintf(s_pic_path, sizeof(s_pic_path), "%s", path);
            loaded = 1;
            break;
        }
        /* 存在但解不开：记下这个具体错误，不再试后面的扩展名——
         * 同一个编号一般情况下只有一个扩展名对应一个真实文件。 */
        break;
    }

    if (loaded) {
        /* 成功后清掉"上次失败"的记忆，否则下次真出错时会被误判成重复而不报。
         * （loadError 已在本次尝试开头清零，这里不必再动。） */
        s_pic_err_code     = 0;
        s_pic_err_path[0]  = '\0';
        s_pic_err_reported = 0;
        /* ★ 把【成功加载的那张图】记进 s_pic_path —— 之前只有失败路径
         *   才写它，成功路径直接 return 0，导致 s_pic_path 停留在
         *   "上一张"甚至空值。后果：JSON 的 "pic" 字段与帧信息显示
         *   永远是旧图 —— 翻页命令（n/p/g）明明换了图，用户看到的
         *   却还是第一张的路径，以为命令没生效（实测就是这样）。
         *   变量 path 在上面的 for 循环里就是成功那张的完整路径。 */
        snprintf(s_pic_path, sizeof(s_pic_path), "%s", path);
        return 0;
    }

    /* ---- 失败：把具体的 SCUT_FRAME_ERR_* 翻译成人能读懂的中文 ----
     * ★ s_pic_path 在失败时也要指向【尝试过的那个文件】：
     *   on_frame 的 JSON "pic" 取自它。留空的话显示层会退化为
     *   "图集目录"甚至 CWD —— 用户看到的是目录名，完全对不上号；
     *   指到具体文件，"pic" 与 "loadError" 才是同一件事的两半
     *   （哪张图 + 为什么没加载成）。
     * ★ 为什么不直接把错误码打出来：
     *   错误码是给代码看的，用户看到 "-9" 学不到任何东西。
     *   每一条都要能回答「发生了什么 / 我该做什么」。
     *   PNG 系列的码与文案由 core 的 scut_frame_strerror 统一提供：
     *   错误码新增时只改 core 一处，宿主的 case 不会漏。
     * ★ 短句同时记入 s_pic_err_short —— on_frame 的 JSON 会原样取用，
     *   所以这里哪怕走到"重复错误不刷屏"的提前 return，字段也有值。 */
    snprintf(s_pic_path, sizeof(s_pic_path), "%s", path);
    snprintf(s_pic_err_short, sizeof(s_pic_err_short), "%s",
             scut_frame_strerror(rc));

    if (s_pic_err_reported && rc == s_pic_err_code &&
        s_pic_err_path[0] != '\0' && strcmp(s_pic_err_path, path) == 0) {
        return rc;          /* 同一张图、同一个原因：不重复刷屏 */
    }
    s_pic_err_code = rc;
    snprintf(s_pic_err_path, sizeof(s_pic_err_path), "%s", path);
    s_pic_err_reported = 1;

    {
        const char *why;
        const char *next;

        switch (rc) {
        case SCUT_FRAME_ERR_UNSUPPORTED_FORMAT:
            why  = "这个格式的图片【目前还不支持】：解码器当前认 BMP 与 PNG"
                   "（8 位灰度/真彩/调色板）。";
            next = "请先用画图/PS/Python(PIL) 等工具把它转成 24 位 .bmp 或 .png，"
                   "或把 config.h 的 SCUT_PIC_EXT 改成已有的格式。";
            break;
        case SCUT_FRAME_ERR_NOT_BMP:
            why  = "文件扩展名像是 BMP，但内容不是 BMP（文件头缺少 \"BM\" 标记）。"
                   "常见原因是文件其实是 PNG/JPEG 却被改了后缀名，或文件被损坏。";
            next = "请确认真实的图片格式；若不是 BMP，请转成 .bmp 后重试。";
            break;
        case SCUT_FRAME_ERR_BMP_HEADER:
            why  = "BMP 头不合法，或属于暂不支持的变体"
                   "（例如 OS/2 的 BITMAPCOREHEADER、16/32 位色深）。";
            next = "请用工具另存为「24 位位图 / 8 位调色板位图」，不要用 16/32 位或 OS/2 格式。";
            break;
        case SCUT_FRAME_ERR_BMP_TRUNCATED:
            why  = "BMP 像素数据不完整（文件被截断，或声明的尺寸与数据量对不上）。";
            next = "请重新导出这张图；若是从网上下载的，确认下载完整。";
            break;
        case SCUT_FRAME_ERR_BMP_COMPRESSION:
            why  = "BMP 使用了压缩编码（RLE）或位域（BITFIELDS），暂不支持。";
            next = "请另存为未压缩的 24 位 BMP。";
            break;
        case SCUT_FRAME_ERR_BMP_PALETTE:
            why  = "8 位 BMP 的调色板缺失或越界，文件很可能已损坏。";
            next = "请重新导出这张图，或改用 24 位 BMP。";
            break;
        case SCUT_FRAME_ERR_PNG_HEADER:
            why  = "PNG 文件头或 IHDR 块不合法（不是有效 PNG，"
                   "或 IHDR 不是第一个数据块）。";
            next = "请确认文件是完整的 PNG；若是从相机或工具导出的，请重新导出。";
            break;
        case SCUT_FRAME_ERR_PNG_TRUNCATED:
            why  = "PNG 数据不完整：文件被截断，或缺少 IDAT/IEND 收尾块。";
            next = "请重新导出/重新下载这张图，确认文件完整。";
            break;
        case SCUT_FRAME_ERR_PNG_CRC:
            why  = "PNG 数据块 CRC32 校验失败：文件在传输或保存过程中被损坏。";
            next = "请重新导出这张图；若反复出现，请检查拷贝/同步环节。";
            break;
        case SCUT_FRAME_ERR_PNG_ZLIB:
            why  = "PNG 的 zlib 流校验失败（流头非法，或 Adler-32 校验不符）。";
            next = "文件已损坏，请重新导出。";
            break;
        case SCUT_FRAME_ERR_PNG_INFLATE:
            why  = "PNG 压缩流不合法：deflate 解码失败（Huffman/距离数据越界）。";
            next = "文件已损坏或由非标准编码器产生，"
                   "请用常规工具（PIL / 画图）重新另存为 PNG。";
            break;
        case SCUT_FRAME_ERR_PNG_FILTER:
            why  = "PNG 行滤波类型超出 0..4 的合法范围，文件已损坏。";
            next = "请重新导出这张图。";
            break;
        case SCUT_FRAME_ERR_PNG_FORMAT:
            why  = "PNG 参数超出支持范围：当前仅支持 8 位色深的"
                   "灰度 / 真彩色 / 调色板 PNG（非交织）。"
                   "16 位色深、RGBA、灰度+Alpha、Adam7 交织均不支持。";
            next = "请用工具把图转成 8 位灰度 PNG（例如 PIL 的 convert(\"L\")），"
                   "或转成 24 位 BMP。";
            break;
        case SCUT_FRAME_ERR_OPEN:
            why  = "文件存在性探测与实际打开结果不一致（打开失败）："
                   "可能刚好被别的程序独占，或权限不足。";
            next = "请确认文件没有被其它程序占用，且当前用户有读取权限。";
            break;
        case SCUT_FRAME_ERR_READ:
            why  = "读取文件失败（IO 错误或文件为空）。";
            next = "请确认文件未损坏、且磁盘可读。";
            break;
        default:
            why  = "解码失败。";
            next = "请把这张图发给环境维护者，并附上下面的错误码。";
            break;
        }

        fprintf(stderr,
            "错误: 加载测试图失败，本帧将使用【全黑图像】。\n"
            "      文件: %s\n"
            "      原因: %s\n"
            "      错误码: %d（SCUT_FRAME_ERR_*，定义见 core/include/scut_frame.h）\n"
            "      下一步: %s\n"
            "      说明: 仿真会继续运行，不会因此中断——但这一帧的输入是黑的，\n"
            "            所看到的阈值/丢线等数值反映的是【没有图像】，不是算法的问题。\n"
            "            （本帧 JSON 的 loadError 字段 = %s）\n",
            path[0] ? path : "(路径无法构造)", why, rc, next,
            s_pic_err_short);
    }

    if (rc == 0) {
        rc = SCUT_FRAME_ERR_OPEN;   /* 兜底：不应出现，但保证返回非 0 语义 */
    }
    return rc;
}

/* 前进到下一张（末尾回绕到图集第一张）。只有一张图时不动，避免无意义的重复加载。
 * ★ 回绕目标与下限都跟 s_pic_first 走：0 起编号的图集要回到 0 号，
 *   按旧的"回 1"会把 0 号图永远排除在批跑之外。 */
static void scut_pic_next(void)
{
    if (s_pic_count <= 0) {
        return;
    }
    s_pic_index++;
    if (s_pic_index > s_pic_first + s_pic_count - 1) {
        s_pic_index = s_pic_first;  /* 回绕：批跑整组图时"跑满一轮"才有意义 */
    }
}

/* --------------------------------------------------------------------------
 * 变量名过滤
 *
 * ★ 为什么要过滤：
 *   自动发现会列出【所有】全局变量（可能有几十个）。UI 里用户
 *   只勾选了几个，没必要每帧把所有变量都格式化 + 传输。
 *   这直接对应需求方的「要允许用户自由选择绘制哪些/输出哪些」。
 * -------------------------------------------------------------------------- */
static int var_selected(const char *name, const char *select_csv)
{
    const char *p;
    size_t      n;

    if (select_csv == 0 || select_csv[0] == '\0') {
        return 1;                       /* 未指定 = 全选 */
    }

    n = strlen(name);
    p = select_csv;
    while (*p != '\0') {
        const char *comma = strchr(p, ',');
        size_t      len   = comma ? (size_t)(comma - p) : strlen(p);

        if (len == n && strncmp(p, name, n) == 0) {
            return 1;
        }
        if (comma == 0) {
            break;
        }
        p = comma + 1;
    }
    return 0;
}

/* --------------------------------------------------------------------------
 * JSON 字符串转义
 *
 * ★ 变量名来自 C 标识符，理论上不需要转义；但 --select 的内容
 *   可能来自用户输入，且未来变量名可能含用户自定义标签。
 *   宁可多写 20 行，也不要生成非法 JSON 让插件解析失败。
 * -------------------------------------------------------------------------- */
static void json_escape(const char *s, char *dst, size_t cap)
{
    size_t o = 0;

    if (cap == 0) { return; }
    for (; s != 0 && *s != '\0' && o + 2 < cap; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') {
            dst[o++] = '\\';
            dst[o++] = (char)c;
        } else if (c < 0x20) {
            o += (size_t)snprintf(dst + o, cap - o, "\\u%04x", c);
        } else {
            dst[o++] = (char)c;
        }
    }
    dst[o] = '\0';
}

/* --------------------------------------------------------------------------
 * 变量快照输出
 *
 * ★ 只传【格式化后的文本】而不是原始内存：
 *   前端不需要理解结构体布局，也不需要处理 22560 元素的大数组。
 *   C 侧按类型渲染，前端只负责显示 —— 职责边界清晰。
 * -------------------------------------------------------------------------- */
static void emit_variables(const options_t *o)
{
    char buf[1024];
    int  i;
    int  n = scut_watch_count();
    int  first = 1;

    if (!o->json) {
        printf("--- 变量 (%d 个) ---\n", n);
    } else {
        printf("{\"vars\":[");
    }

    for (i = 0; i < n; i++) {
        const scut_watch_entry_t *w = scut_watch_at(i);
        int  truncated = 0;
        int  shown;

        if (w == 0) { continue; }
        if (!var_selected(w->name, o->select_vars)) { continue; }

        shown = scut_watch_read(i, buf, (int)sizeof(buf), 24, &truncated);
        (void)shown;

        if (o->json) {
            char name_esc[256];
            char val_esc[2048];
            json_escape(w->name, name_esc, sizeof(name_esc));
            json_escape(buf, val_esc, sizeof(val_esc));
            printf("%s{\"name\":\"%s\",\"kind\":%d,\"dim\":%d,\"total\":%d,"
                   "\"values\":\"%s\",\"truncated\":%s}",
                   first ? "" : ",", name_esc, (int)w->t, w->dim, w->n,
                   val_esc, truncated ? "true" : "false");
            first = 0;
        } else {
            printf("  %-24s [%d] = %s%s\n", w->name, w->n, buf,
                   truncated ? " ..." : "");
        }
    }

    if (o->json) {
        printf("]}\n");
    } else {
        printf("\n");
    }
}

/* --------------------------------------------------------------------------
 *  把当前变量快照【构建成 JSON 片段】（不打印，写进调用方的缓冲）
 *
 *  ★ 为什么需要这个（用户实测抓到的时序 bug）：
 *    变量快照以前只在【进程退出时】发一次（main 的收尾 emit_variables）。
 *    但扩展的会话是常驻的 —— 进程不退出，快照就永远不来，
 *    变量面板的数值【永远停在会话启动那一刻】。用户看到的现象是
 *    "只有点测速（会重启进程）变量才更新"，其它时候全是不动的旧值。
 *
 *    现在把快照内嵌进【每帧】的 JSON 行（"vars" 字段，追加在 loadError
 *    之后、timing 之前），扩展每收一帧就更新一次面板 —— 数值与画面同步。
 *
 *  ★ 大小：--select 过滤后通常只有几个变量，每个值的显示上限 24 个元素
 *    （与 emit_variables 相同），4KB 缓冲足够；万一超长就截断并以 "…]"
 *    收尾——截断的是【显示用快照】，不是算法数据，安全。
 * -------------------------------------------------------------------------- */
static void build_vars_json(const options_t *o, char *out, size_t cap)
{
    char buf[1024];
    size_t used = 0;
    int  i;
    int  n = scut_watch_count();
    int  first = 1;
    int  trunc_note = 0;

    out[0] = '\0';
    if (cap < 3) { return; }
    used += (size_t)snprintf(out + used, cap - used, "[");
    if (used >= cap) { return; }

    for (i = 0; i < n; i++) {
        const scut_watch_entry_t *w = scut_watch_at(i);
        int  truncated = 0;

        if (w == 0) { continue; }
        if (!var_selected(w->name, o->select_vars)) { continue; }

        (void)scut_watch_read(i, buf, (int)sizeof(buf), 24, &truncated);

        {
            char name_esc[256];
            char val_esc[2048];
            char one[2560];
            int  wl;
            json_escape(w->name, name_esc, sizeof(name_esc));
            json_escape(buf, val_esc, sizeof(val_esc));
            wl = snprintf(one, sizeof(one),
                          "%s{\"name\":\"%s\",\"kind\":%d,\"dim\":%d,\"total\":%d,"
                          "\"values\":\"%s\",\"truncated\":%s}",
                          first ? "" : ",", name_esc, (int)w->t, w->dim, w->n,
                          val_esc, truncated ? "true" : "false");
            if (wl < 0) { continue; }
            if (used + (size_t)wl + 2 >= cap) { trunc_note = 1; break; }
            memcpy(out + used, one, (size_t)wl);
            used += (size_t)wl;
            out[used] = '\0';
            first = 0;
        }
    }

    if (used + 2 < cap) {
        used += (size_t)snprintf(out + used, cap - used, "]");
        (void)trunc_note;   /* 截断时 out 已经合法（以 "]" 收尾前的部分），
                             * 但 used 未含 "]" —— 这里补上 */
        if (trunc_note) {
            /* 超长：回退到安全位置并强制收尾，保证 JSON 合法 */
            size_t k = (used > 0) ? used - 1 : 0;
            /* 去掉可能残缺的最后一个条目：向前找最后一个 '}' */
            while (k > 0 && out[k] != '}') { k--; }
            if (out[k] == '}') {
                out[k + 1] = ']';
                out[k + 2] = '\0';
            } else {
                snprintf(out, cap, "[]");
            }
        }
    }
}

/* --------------------------------------------------------------------------
 * 帧写出：PGM (P5) 格式
 *
 * ★ 为什么选 PGM：它是未压缩、无依赖、十几行就能写的灰度格式，
 *   而且几乎任何工具都能读（ImageMagick / PIL / VS Code 预览）。
 *   换成 PNG 就需要引入编码器（zlib），与「核心零依赖」冲突。
 *   由消费方按需转成 PNG 更合适。
 * -------------------------------------------------------------------------- */
static int write_pgm(const char *path, const scut_u8 *gray, int w, int h, int stride)
{
    FILE *f;
    int   y;

    f = fopen(path, "wb");
    if (f == 0) {
        return -1;
    }
    fprintf(f, "P5\n%d %d\n255\n", w, h);
    for (y = 0; y < h; y++) {
        if (fwrite(gray + (size_t)y * (size_t)stride, 1, (size_t)w, f) != (size_t)w) {
            fclose(f);
            return -1;
        }
    }
    fclose(f);
    return 0;
}

/* --------------------------------------------------------------------------
 *  给用户看的图片路径：能用工程根相对形式就用相对形式
 *
 *  ★ 为什么不直接返回 scut_pic_path()（绝对路径）：
 *      修复路径解析之后 s_pic_path 变成了绝对路径，而它要显示在
 *      插件的帧信息里。测试工程的实际路径长这样：
 *        D:/22车队管理/一轮考核/视觉组/集成仿真环境测试/scut71-project/pic/1/3.bmp
 *      这一长串会把界面撑开，把真正有用的"第 3 张"挤到看不见的地方。
 *      用户要看的是"这一帧用的是哪张图"，不是"这张图在磁盘的哪个角落"。
 *      折成 "pic/1/3.bmp" 之后，一眼就能对上号。
 *
 *  ★ 为什么"真的在工程外就保持绝对路径"：
 *      规格里写明了这一条，而且它有实际意义：用 --pic 指向工程外的
 *      共享图集时，只显示 "pic/1/1.bmp" 会让人误以为图来自本工程，
 *      从而去改一个根本没用上的目录。显示绝对路径反而才是诚实的。
 *
 *  ★ 为什么每次调用都重新折一遍，而不是在加载成功时就算好存起来：
 *      折算是纯函数（同样的 s_pic_path + s_proj_root 必然得到同样结果），
 *      而"什么时候加载成功"有两处（探测后首次加载、--advance 逐帧推进），
 *      存一份缓存就要在这两处都记得更新 —— 漏掉一处的表现是
 *      "显示的还是上一张图"，又是一个难以察觉的错位。
 *      重新算的代价是几十字节的字符串比较，完全不值得为它引入状态。
 *
 *  ★ 注意这个函数【必须】定义在 path_make_root_relative 之后：
 *      C 里没有"先调用后声明"这回事（C99 起隐式声明已经是错误，
 *      两个编译器都会直接报错）。所以它的位置不是随手放的。
 * -------------------------------------------------------------------------- */
static const char *scut_pic_path_display(void)
{
    static char disp[SCUT_PATH_MAX];
    char        pic_abs[SCUT_PATH_MAX];
    char        root_abs[SCUT_PATH_MAX];

    /* ★ 比较之前【两边都】再规范化一次，哪怕它们理论上已经是绝对路径了。
     *   这不是多余的防御，而是被实测逼出来的：
     *     ① 图片路径来自 --pic 时可能是相对的（用户写 --pic pic/1），
     *        直接拿去和绝对根比较永远匹配不上，显示就会退回长绝对路径；
     *     ② 工程根由 exe 位置推导，在 GetModuleFileNameA 失败、
     *        退到 argv[0] 分支时，规范化的结果与图片路径的规范化
     *        未必逐字节一致（大小写、短名、分隔符方向都可能不同）。
     *   两边都过一次 path_to_absolute + 去尾分隔符之后，形态才对齐。
     *   代价是两次字符串处理，换来的是"相对显示真的会生效"。 */
    path_to_absolute(s_pic_path,  pic_abs,  sizeof(pic_abs));
    path_strip_trailing_sep(pic_abs);
    path_to_absolute(s_proj_root, root_abs, sizeof(root_abs));
    path_strip_trailing_sep(root_abs);

    snprintf(disp, sizeof(disp), "%s", pic_abs);
    /* 折不动（路径在工程外 / 工程根未知 / 前缀只是同名巧合）时，
     * 保持绝对路径原样返回，绝不硬造一个看似合理却错误的相对路径。 */
    (void)path_make_root_relative(disp, root_abs);
    return disp;
}

/* 帧钩子：核心每跑完一帧就把结果交给这里。
 * 这是「核心不拥有窗口」的落地 —— 换成 Webview 后端时只需换掉这个函数。 */
static void on_frame(void *user)
{
    const options_t *o = (const options_t *)user;
    const scut_timing_t *t = scut_timing_get();
    static int   frame_no = 0;
    char         path[512];
    char         img_esc[1024];
    char         pic_esc[SCUT_PATH_MAX * 2];
    char         err_esc[256];      /* loadError 转义缓冲（短语，够用） */
    char        *vars_json;         /* 每帧变量快照（堆分配，见下） */
    int          load_error;
    int          is_bench;
    const scut_u8 *out;
    int          w, h;

    frame_no++;

    /* 测速帧的记账：本帧是不是"重复 N 次"的那一帧。
     * ★ 必须在读 stdin 之前定下来：下面的 b<N> 分支置的是 s_bench_pending，
     *   那是给【下一帧】用的，不能影响本帧的标记。
     * ★ 测速帧报完之后立刻还原 repeat，这样紧随其后的普通帧不受影响。 */
    is_bench = s_bench_pending;
    if (is_bench) {
        s_bench_pending = 0;
        scut_sched_set_repeat(s_repeat_before_bench);
    }

    /* 每帧变量快照：80KB 上限（--select 过滤后通常远小于此）。
     * ★ 为什么堆分配而不是栈：快照随勾选数量伸缩，栈上 80KB 在
     *   部分平台接近默认栈上限的警戒线；这里每帧一次 malloc/free
     *   的开销（微秒级）与算法本体（几十微秒起）相比可以忽略，
     *   却换来了"面板数值与画面同帧更新"。 */
    vars_json = (char *)malloc(81920);
    if (vars_json) {
        build_vars_json(o, vars_json, 81920);
    }

    /* 合成：输出图像 + 覆盖层 → 最终灰度图 */
    w = scut_frame_width();
    h = scut_frame_height();
    out = scut_bind_output();

    snprintf(path, sizeof(path), "%s/frame_%04d.pgm", o->out_dir, frame_no);
    write_pgm(path, out, w, h, w);

    /* 本帧真正用到的输入图路径，随帧一起报出去（JSON 的 "pic" 字段）。
     * ★ 为什么每帧都要报，而不是在开头报一次：
     *   开了 --advance 之后每帧的输入图都不同。只在开头报一次的话，
     *   IDE 界面上显示的永远是第一张图的名字，用户会以为推进没生效。
     * ★ 为什么要转义：路径里可能含空格与中文（本项目硬要求），
     *   也可能含反斜杠——反斜杠在 JSON 里是转义引导符，
     *   直接塞进字符串会生成非法 JSON，插件会解析失败。
     * ★ 为什么用 scut_pic_path_display() 而不是 scut_pic_path()：
     *   报给用户看的是"哪一张图"，不是"这张图在磁盘哪个角落"。
     *   s_pic_path 在本次修复后变成了绝对路径，直接报出去会是一长串
     *   D:/.../scut71-project/pic/1/3.bmp，把界面撑开还看不清重点。
     *   折成工程根相对形式（pic/1/3.bmp）之后一眼能对上号；
     *   真的在工程外（--pic 指到别处）时才回退成绝对路径。
     *   JSON 的字段集没变，"pic" 仍然是一个字符串，只是内容更短了。 */
    json_escape(scut_pic_path_display(), pic_esc, sizeof(pic_esc));

    /* ★ "img" 字段同样必须转义，这一条曾经是 bug：
     *   Windows 路径是 `C:\...\frames/frame_0001.pgm`，
     *   里面的 `\f` 是【换页符】转义、`\d` 是非法转义，
     *   于是整行输出不是合法 JSON，插件 JSON.parse 直接抛异常——
     *   表现为「插件莫名其妙收不到帧」，而仿真本身跑得好好的。
     *   实测：转义前 objdump 之外的任何严格 JSON 解析器都会拒绝该行。 */
    json_escape(path, img_esc, sizeof(img_esc));

    /* ★ loadError：本帧图片加载失败时的【短】中文原因（成功时不出现该字段）。
     *   为什么放 JSON 而不只靠 stderr：批跑整组图时，IDE 界面需要
     *   在每一帧的卡片上直接标出"这帧是黑图，因为 PNG 被截断了"，
     *   让用户把 stderr 翻出来看；没有这个字段，坏帧看起来和正常帧
     *   只差一个空 "pic"，极易被当成算法问题。
     * ★ 字段是【追加】的：JSON 的既有字段名、顺序、类型全部未动，
     *   老的解析端不认识它也照常工作。
     * ★ 为什么要经过 json_escape：错误短语是中文 + 可能有引号，
     *   直接内插会生成非法 JSON（与 "img" 那条历史 bug 同源）。
     * ★ 为什么帧【仍然要发】：协议靠每帧输出做 ACK/背压同步，
     *   这里少发一行，插件就会停在这里等一个永远不会来的帧 ——
     *   黑图帧 + 错误字段才是"报错但不卡死"的完整语义。 */
    if (s_pic_err_short[0] != '\0') {
        json_escape(s_pic_err_short, err_esc, sizeof(err_esc));
        load_error = 1;
    } else {
        err_esc[0] = '\0';
        load_error = 0;
    }

    if (o->json) {
        /* ★ 周期数用 PRIu64（即 I64u）而不是 "%llu"：
         *   MinGW 的 gcc 在 -std=c11（定义了 __STRICT_ANSI__）下
         *   不会启用 ANSI stdio，于是 msvcrt 的 %llu 不被识别，
         *   编译期直接报 "unknown conversion type character 'l'"。
         *   这不是本文件新引入的问题（原来的 JSON 格式串就是这样），
         *   但它确实是一条实打实的 -Wall -Wextra 警告，
         *   而本项目要求两个编译器都零警告。
         *   PRIu64 在 gcc 下展开成 "I64u"、在 MinGW 的 clang 下展开成
         *   "llu"，两边都是各自 CRT 真正认识的那个写法——
         *   用一个标准宏换掉平台差异，比 #ifdef 更干净。 */
        /* ★ loadError 的位置刻意放在 "pic" 之后、"timing" 之前：
         *   追加字段一律排在旧字段后面，保证老解析端看到的
         *   字段顺序与历史版本完全一致（只增不改的承诺）。
         *   三个 %s 分别是：字段名前半 / 已转义的原因 / 字段收尾引号。
         *   不用 snprintf 预拼整行，是为了保持与原来一样的
         *   「一个 printf 一行」结构，diff 最小。 */
        printf("{\"frame\":%d,\"w\":%d,\"h\":%d,\"img\":\"%s\","
               "\"pic\":\"%s\","
               "%s%s%s"
               "\"bench\":%s,"
               "\"vars\":%s,"
               "\"timing\":{\"processUs\":%.3f,\"drawUs\":%.3f,"
               "\"frameUs\":%.3f,\"cycles\":%" PRIu64 ","
               "\"cyclesValid\":%s}}\n",
               frame_no, w, h, img_esc, pic_esc,
               load_error ? "\"loadError\":\"" : "",
               load_error ? err_esc : "",
               load_error ? "\"," : "",
               is_bench ? "true" : "false",
               vars_json,
               t ? t->process_us : 0.0,
               t ? t->draw_us    : 0.0,
               t ? t->frame_us   : 0.0,
               (scut_u64)(t ? t->process_cycles : 0),
               (t && t->cycles_valid) ? "true" : "false");
        fflush(stdout);
    } else if (!o->quiet) {
        printf("[帧 %d] 处理 %.1f us | 绘图 %.1f us | 整帧 %.1f us | 周期 %" PRIu64 " | 图 %s\n",
               frame_no,
               t ? t->process_us : 0.0,
               t ? t->draw_us    : 0.0,
               t ? t->frame_us   : 0.0,
               (scut_u64)(t ? t->process_cycles : 0),
               (scut_pic_path_display()[0] != '\0')
                   ? scut_pic_path_display() : "(无，黑图)");
    }


    /* ----------------------------------------------------------------------
     *  ★ 把用户算法写的 SCUT_Log 行送到扩展（之前【没人取】，日志区永远空）
     *
     *  为什么放这里：REPORT 角色回调结束后，日志缓冲正好装着本帧的输出；
     *  核心的阶段门控在 REPORT 结束时会关闸，下一帧开始前不会有新行。
     *  送到 stderr 而不是 stdout：stdout 是 JSON 协议通道（扩展逐行解析），
     *  日志混进去会炸掉解析；扩展对 stderr 是【透传到日志区】的，
     *  用户在界面「日志」折叠区里就能看到。
     *  取完清空缓冲：不清的话旧日志会在下一帧被再次取出（重复刷屏）。
     * ---------------------------------------------------------------------- */
    {
        int ln = scut_log_line_count();
        int k;
        for (k = 0; k < ln; k++) {
            const char *s = scut_log_line_at(k);
            if (s != NULL && s[0] != '\0') {
                fprintf(stderr, "[LOG] %s\n", s);
            }
        }
        if (ln > 0) {
            SCUT_LogClear();
        }
    }

    free(vars_json);   /* 与上面的 malloc 配对；JSON 路径只在打印时引用它 */

    /* ----------------------------------------------------------------------
     *  ★★ 推进图片：必须放在【帧钩子的最后】，顺序本身是契约 ★★
     *
     *  这里是本功能最容易写错、且错了以后最难发现的地方，所以写清楚：
     *
     *  一帧的时间线是
     *      PRE_FRAME → PROCESS(读输入图) → POST_FRAME → frame sink(本函数)
     *                → DRAW → REPORT
     *  也就是说，本函数被调用时，第 N 帧的算法【已经跑完】、
     *  它的结果也已经写盘并报出去了。
     *
     *  于是：
     *    · 在【开头】推进 → 载入的是第 N+1 张图，但第 N 帧的结果
     *      已经是拿第 N 张算出来的。结果是「帧 1 的图像配帧 2 的文件名」，
     *      而文件名又来自 s_pic_path —— 报告与实际输入错开一位。
     *    · 在【结尾】推进 → 第 N 帧全程用第 N 张图，推进发生在它彻底
     *      结束之后。于是第 N+1 帧自然用第 N+1 张图。对。
     *
     *  ★ 为什么"错开一位"特别危险：
     *    帧 1 与帧 2 在报告里会显示成同一张图，用户看到的只是
     *    "推进好像没生效 / 少了一张"，而不报错、不崩溃。
     *    这种沉默的 off-by-one 可以潜伏几个月，所以这里宁可用一段
     *    长注释把理由钉死，也不让后来者"优化"掉这个顺序。
     *
     *  ★ 为什么放在写盘/打印【之后】而不是之前：
     *    本帧要报的 "pic" 必须是本帧【真正用过】的那张图。
     *    先打印、后推进，两者天然一致；反过来就必须额外缓存一份
     *    "上一张图路径"来对齐，多一个状态就多一处能写错的地方。
     *
     *  ----------------------------------------------------------------------
     *  ★★ 「单步 / 运行」的语义（本轮逐条核对过，结论：正确，不要改） ★★
     *
     *  插件（simsession）启动进程时用的参数是
     *      --json --step --frames 0 --advance
     *  然后【每帧喂一个换行】。于是两个按钮的行为是：
     *
     *    · 单步：喂一个 '\n'
     *        → 本函数（第 N 帧的 sink）走完 → 推进到 N+1 并预载
     *        → getchar() 返回，第 N+1 帧开始处理 N+1 号图
     *        也就是说「一次换行 = 前进一张并处理它」，既不多也不少。
     *
     *    · 运行：连续喂 '\n'
     *        → 每帧换下一张，到第 s_pic_count 张之后回绕到第 1 张，
     *          如此循环。这就是"播放整组图"的期望行为。
     *
     *  ★ 为什么"预载"这一步不能省（它是单步体验的关键）：
     *    推进与加载是【两步】：scut_pic_next() 只改编号，
     *    scut_pic_load() 才把像素搬进输入缓冲。如果这里只推进不加载，
     *    那么第 N+1 帧的 PROCESS 读到的仍然是第 N 张图的像素，
     *    只是报告里写着 N+1 —— 用户会看到"图号在变、画面不变"，
     *    与修复前的黑屏症状几乎分不清。两步必须成对出现。
     *
     *  ★ 关于【编号对齐】（也就是"有没有 off-by-one"）：
     *    第 N 帧的 PROCESS 读的是 s_pic_path 指向的那张图，
     *    而 s_pic_path 是在"第 N 帧开始之前"由 scut_pic_load 写好的。
     *    本函数是第 N 帧的最后一步，此刻打印 s_pic_path 得到的
     *    正是第 N 帧真正用过的那张 —— 帧 N 报告图 N，不早不晚。
     *    推进发生在打印【之后】，所以它影响的是第 N+1 帧，
     *    不会把第 N 帧的报告改掉。实测（--step --advance --frames 0，
     *    每次喂一个换行）得到 1.bmp, 2.bmp, 3.bmp, ... 严格递增。
     *
     *  ★ 会不会"第 1 帧就跳过第 1 张"：
     *    不会。加载起始图发生在 main 的 resolve_pic_set() 之后、
     *    scut_run_frames() 之前，第 1 帧用的必然是 --frame 指定的那张
     *    （默认第 1 张）。本函数里的推进是它【之后】才发生的。
     *
     *  ★★ 没有独立的 --loop 开关，也不应该有 ★★
     *    回绕行为已经写在 scut_pic_next() 里（越过最后一张就回到第 1 张），
     *    也就是说 --advance 本身就【自带循环】。
     *    再加一个 --loop 会立刻产生一个问题：--advance 不带 --loop 时
     *    到底该停在最后一张、还是继续停在那儿空转？两个开关的组合语义
     *    需要在文档、插件、命令行三处同时对齐，而它对用户的价值是零 ——
     *    "跑完一轮就停"完全可以用 --frames <张数> 表达，而且更直白。
     *    所以这里刻意【不】引入 --loop：一个行为只有一个开关控制，
     *    是这个环境"上手即用"取向的一部分。
     * -------------------------------------------------------------------- */
    if (o->advance) {
        scut_pic_next();
        scut_pic_load(scut_pic_index());
    }

    if (o->step_mode) {
        fflush(stdout);
        /* 等到消费方发一行（IDE 用它掌管节奏）。
         * 读到 EOF/错误就当作退出请求，避免 IDE 关闭后进程吊死。
         *
         * 协议（0.7.1 扩展）：
         *     空行        重跑当前这张图
         *     n           下一张图（相对当前位置 +1，回绕）
         *     p           上一张图（-1，回绕）
         *     g<N>        跳到第 N 张（N 按图集编号基准）
         *     其它行      当作推进一帧（宽容：未知命令不让会话卡死）
         *
         * 为什么要有跳转命令（用户原话："为什么我点上一张下一张
         *   会他妈重启仿真进程？这不有病吗？有的程序就是要前后图关联
         *   你没事重启干嘛？"）：
         *   图集编号曾经是【启动参数】—— 翻一页就得重启进程，
         *   算法的内部状态（环形缓冲、状态机、丢线计数、环岛冷却）
         *   全部清零。这对"前后帧关联"的算法（几乎所有真实巡线算法
         *   都有状态）是破坏性的：翻页看图 = 状态丢失 = 与车上行为不符。
         *   现在翻页只是【换一张输入图】，进程与算法状态都保留。
         *
         * 为什么换成真正的行读取：
         *   getchar() 只读一个字符，无法区分 "n
" 与 "
"。这里用
         *   fgets 读一行（缓冲 16 字节足够），首字符分发；
         *   空行 = 推进。读取失败/EOF = 退出请求。 */
        {
            char line[16];
            if (fgets(line, sizeof(line), stdin) == NULL) {
                scut_request_quit();       /* EOF / 错误 = 退出 */
            } else {
                switch (line[0]) {
                case 'n':                    /* next */
                    scut_pic_next();
                    scut_pic_load(scut_pic_index());
                    break;
                case 'p': {                  /* prev：next 的逆操作 */
                    if (s_pic_count > 0) {
                        int idx = scut_pic_index() - s_pic_first;
                        idx = (idx - 1 + s_pic_count) % s_pic_count;
                        scut_pic_load(s_pic_first + idx);
                    }
                    break;
                }
                case 'b': {                  /* bench：同图跑 N 次，只跑计时段 */
                    long nrep = strtol(line + 1, NULL, 10);
                    if (nrep < 1) { nrep = 1; }
                    if (nrep > 1000000) { nrep = 1000000; }
                    /* ★★ 这里【刻意不跑帧】，只把重复次数挂上，让它作用到
                     *    【下一帧】。理由是一条真实缺陷：
                     *
                     *    旧实现直接在这里调 scut_run_once()。但本函数
                     *    (on_frame) 本身就是被 run_one_frame 调用的 ——
                     *    也就是在「帧中途」再嵌套跑一整帧。后果有两层：
                     *      ① 递归调用 on_frame，于是又走到本段 fgets，
                     *         把下一条协议命令【吃掉】了。表现为
                     *         `b3` 之后再发命令会少生效一次，帧数对不上；
                     *      ② 内层帧覆盖了 s_timing，外层帧接着往下跑，
                     *         报给插件的计时可能来自内层，
                     *         而"测速结果"正是靠这一帧的计时读数。
                     *
                     *    改成"挂起待用"之后：本帧正常结束，调度循环自然
                     *    跑到下一帧，那一帧以 N 次重复执行 PROCESS，
                     *    平均耗时就是测速结果。恰好一帧、无递归。
                     *
                     * ★ 为什么不再需要"挂起后处理"：
                     *    process_us 只统计 PROCESS 阶段，绘制/日志在
                     *    draw_us 里单独计量、本就不计入。所以测速不需要
                     *    屏蔽后处理 —— 屏蔽它反而会让用户看不到标注。 */
                    if (!s_bench_pending) {
                        s_repeat_before_bench = scut_sched_get_repeat();
                    }
                    scut_sched_set_repeat((int)nrep);
                    s_bench_pending = 1;
                    break;
                }
                case 'g': {                  /* goto 第 N 张 */
                    long want = strtol(line + 1, NULL, 10);
                    if (s_pic_count > 0) {
                        int idx = (int)(want - s_pic_first);
                        if (idx < 0) { idx = 0; }
                        if (idx >= s_pic_count) { idx = s_pic_count - 1; }
                        scut_pic_load(s_pic_first + idx);
                    }
                    break;
                }
                default:                     /* 空行/未知 = 推进一帧 */
                    break;
                }
            }
        }
    }
}

/* --------------------------------------------------------------------------
 * 主函数
 *
 * ★ 环境拥有 main()：用户不写 main，只注册回调。
 *   这比「用户写 main 调 SCUT_Run」更符合「把环境藏起来」的目标，
 *   也少一个用户可改坏的入口。
 * -------------------------------------------------------------------------- */
int main(int argc, char **argv)
{
    options_t o;
    int       rc;

    rc = parse_args(argc, argv, &o);
    if (rc != 0) {
        return (rc > 0) ? 0 : 2;        /* --help 返回 0，参数错返回 2 */
    }

    /* --- 1) 分配帧缓冲并绑定绘制目标 ---
     * ★ 这一步把「绘制」从「图形库」解耦：绘制写进覆盖层，
     *   呈现由后端负责。旧环境把绘制直接写进 EasyX 的 DIB，
     *   换后端时会静默失效 —— 这里刻意不再犯。 */
    if (scut_frame_alloc(scut_bind_width(), scut_bind_height()) != 0) {
        fprintf(stderr, "错误: 无法分配 %dx%d 帧缓冲\n",
                scut_bind_width(), scut_bind_height());
        return 3;
    }

    scut_draw_bind(scut_bind_output(), scut_bind_overlay(),
                   scut_bind_width(), scut_bind_height(), scut_bind_width());

    /* --- 2) 解析测试图集并加载第一张图 ---
     *
     * ★★ 位置是刻意的：必须在 scut_bind_apply() 【之前】★★
     *
     *    scut_bind_apply() 内部会调 scut_core_init()，而 core_init 会执行
     *    INIT 角色的用户回调。用户的初始化代码极可能直接访问输入数组
     *    （例如为第一帧预建逆透视查找表、或读取第一张图做统计）。
     *    如果我们在 INIT 之后才加载，那些回调看到的全是零缓冲 ——
     *    "第一张图"这件事在 INIT 阶段就已经是错的，而且不报任何错。
     *
     *    旧实现把加载放在 INIT 之后，并且专门写了一段注释解释
     *    "INIT 反正读不到图" —— 那个理由是错的：它只在"用访问器读图"
     *    这一种写法下成立，而绝大多数车载算法是直接访问数组的。
     *    把顺序摆正，两种写法都正确。
     *
     * ★ 为什么加载不放进 INIT 回调：
     *    INIT 属于用户算法域，而"从测试图集喂图"是【呈现后端】的职责 ——
     *    真机上这件事是摄像头的 DMA 在干，不是算法。把它塞进 INIT
     *    会让算法依赖后端的存在，破坏「代码松耦合」。 */
    resolve_pic_set(&o);

    /* 加载起始图片。失败也继续（输入保持零填充 = 黑图），
     * 具体原因由 scut_pic_load 打印成可操作的中文提示。
     * ★ 传 scut_pic_index() 而不是 o.frame_index：
     *   没给 --frame 时，resolve_pic_set 已把 s_pic_index 设成
     *   图集第一张（编号基准随探测，可能是 0）。若这里改传 o.frame_index，
     *   会把那个"占位默认 1"重新带进来 —— 0 起的图集就永远从 1 号跑起，
     *   第一张被静默跳过。探测结果在这里是唯一权威。 */
    scut_pic_load(scut_pic_index());

    /* --- 3) 绑定：把编译期尺寸与配置交给核心（这一步会跑 INIT 回调） --- */
    scut_bind_apply();

    /* ★ 运行期覆盖 PROCESS 重复次数（--repeat）。
     *   bind 里给的是编译期默认值（SCUT_PROCESS_REPEAT），
     *   这里用命令行/设置给的值覆盖它。
     *   旧实现解析了 --repeat 却从未应用，属于"设置项是死的"那类缺陷。 */
    if (o.repeat >= 1) {
        scut_sched_set_repeat(o.repeat);
    }

    /* --- 4) 只列变量就退出（供 IDE 的变量面板初始化） ---
     *
     * ★ 为什么这条提前返回【之前】要先打一行 stderr 的"自检"信息：
     *   这条路径是 IDE 启动时第一个跑的（变量面板初始化），
     *   而它跑的时机比任何一帧都早。如果路径解析在这里就是错的，
     *   用户看到的第一个症状是"变量面板空白/图像对不上"，
     *   完全联想不到"图集目录没找到"。把这一行打在这里，
     *   最早上来的那次调用就会把事实摆出来。
     *
     * ★ 为什么用 stderr 而不是 stdout：
     *   stdout 在 --json 模式下是【机器协议】，一个字节都不能多
     *   （插件按行 JSON.parse）。诊断信息走 stderr，
     *   既不污染协议，又会被插件原样转发到日志面板里。 */
    if (!o.quiet) {
        fprintf(stderr,
            "信息: 工程根推定 %s（由 exe 位置反推）；"
            "测试图集 %s，共 %d 张，起始第 %d 张。\n",
            s_proj_root[0] ? s_proj_root : "(未知)",
            (s_pic_count > 0) ? s_pic_dir : "(未找到)",
            scut_pic_count(), scut_pic_index());
    }

    if (o.list_vars) {
        emit_variables(&o);
        scut_frame_free();
        scut_core_shutdown();
        return 0;
    }

    /* --- 5) 装帧钩子并运行 --- */
    scut_set_frame_sink(on_frame, &o);

    /* 帧输出目录（PGM 落盘处）。失败不致命：写文件时会报具体错误。
     * ★ 必须在第一帧之前建好：sink 每帧都会往这里写。 */
    ensure_dir(o.out_dir);

    if (!o.quiet && !o.json) {
        printf("SCUT-71 仿真宿主\n");
        printf("图像 %dx%d，变量 %d 个，准备跑 %d 帧\n",
               scut_bind_width(), scut_bind_height(),
               scut_watch_count(), o.frames);

        /* 报告「图集从哪来、一共有几张、这一帧用的是哪一张」。
         * ★ 为什么非要说这三个数字：
         *   以前画面全黑的时候，用户手上没有任何线索能判断
         *   究竟是"图没找到"还是"算法把图算黑了"。
         *   把目录/张数/当前文件名打在开头，一眼就能分辨。 */
        if (scut_pic_count() > 0) {
            /* ★ 为什么用 scut_pic_path_display()：与人可读的逐帧输出、
             *   JSON 的 "pic" 字段保持【同一个口径】。
             *   三处显示同一个东西却给出两种格式，用户会以为
             *   "开头的这张图"和"每帧那张图"是两回事。 */
            printf("测试图集 %s（共 %d 张），本帧使用 %d：%s\n",
                   s_pic_dir, scut_pic_count(), scut_pic_index(),
                   (scut_pic_path()[0] != '\0')
                       ? scut_pic_path_display()
                       : "(该图加载失败，本帧为黑图，原因见上方提示)");
            if (o.advance) {
                printf("逐帧推进: 开启（每帧切换到下一张，到第 %d 张后回到第 1 张）\n",
                       scut_pic_count());
            }
        } else {
            printf("测试图集 %s（共 0 张）—— 本帧输入为全黑图像，"
                   "原因见上方警告\n", s_pic_dir);
        }
    }

    if (o.frames > 0) {
        scut_run_frames(o.frames);
    } else {
        scut_run_until_quit();
    }

    /* --- 6) 每帧变量快照（放在最后输出一次，避免刷屏） --- */
    if (o.json) {
        emit_variables(&o);
    }

    scut_frame_free();
    scut_core_shutdown();
    return 0;
}
