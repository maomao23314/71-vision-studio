/* ==========================================================================
 *  fixtures_all_types.c -- 自动符号发现的回归测试夹具
 *  --------------------------------------------------------------------------
 *  覆盖 scut_symbols.py 必须正确处理的【所有】类型形态。
 *  每一种形态在历史上都对应过一个真实的解析陷阱（见 4.5 节）。
 *
 *  ★ 本文件不参与实际仿真，仅供 tests/test_symbols.py 编译探针。
 * ========================================================================== */
#include <stdint.h>

/* --- 基础类型：全谱 --- */
char              v_char;
signed char       v_schar;
unsigned char     v_uchar;
short             v_short;
unsigned short    v_ushort;
int               v_int;
unsigned int      v_uint;
long              v_long;
unsigned long     v_ulong;
long long         v_llong;
unsigned long long v_ullong;
float             v_float;
double            v_double;
_Bool             v_bool;

/* --- 一维数组 --- */
int      a_int1[120];
float    a_float1[8];
uint8_t  a_u8_1[256];
double   a_double1[4];

/* --- 二维数组（★ 验证维度解析与扁平索引） --- */
uint8_t  a_2d[120][188];
int      a_2d_small[4][8];
float    a_2d_float[3][3];

/* --- 三维数组 --- */
int      a_3d[2][3][4];

/* --- ★ 数组 typedef（第 12 轮评审发现的测试盲区） ---
 *
 *   这一类不在 EXPECT 里，导致一个真实缺陷【对现有测试结构性不可见】：
 *   scut_symbols.py 用 `out['dims'] = dims` 【覆盖】了内层类型的 dims，
 *   而不是拼接。于是：
 *       typedef uint8_t Row[188];  → 内层解析出 dims=[188]
 *       Row g_row[120];            → 外层拿到 dims=[120] 后覆盖 → 只剩 [120]
 *                                   → total 算成 120（应为 22560）
 *   下游 `len(dims)==1` 分支据此认定"这是一行"，
 *   若它被填进「结果图数组名」→ 生成 SCUT_EnvCopyOutput(ptr, 120, 1)
 *   → 画面只搬 1 行，【静默、无报错】。
 *
 *   ★ 两种形态都要覆盖：
 *       td_row     一维 typedef 再包一层数组（dims=[120,188]）
 *       td_img     二维 typedef 直接用（dims 就是 [120,188]）
 *     前者走"外层覆盖"路径，后者走"直接解析"路径，错误表现不同。
 *
 *   ★ 命名刻意不用 '_' 开头：会被生成器的黑名单顺带过滤掉，
 *     导致这些探针失去意义（同 fixture_local_static 的理由）。 */
typedef uint8_t Row[188];
typedef uint8_t Img[120][188];

Row td_row[120];        /* 期望 dims=[120,188] total=22560 */
Img td_img;             /* 期望 dims=[120,188] total=22560 */
Row td_row_small[4];    /* 期望 dims=[4,188]   total=752    */

/* --- 结构体、嵌套结构体、结构体数组 --- */
typedef struct { int x, y; } point_t;
typedef struct {
    point_t p[2];
    float   len;
    int     status;
} track_t;

point_t  s_point;
track_t  s_track;
track_t  s_track_arr[4];

/* --- 联合 --- */
typedef union { int i; float f; uint8_t b[4]; } value_u;
value_u  u_value;

/* --- 枚举 --- */
typedef enum { LANE_STRAIGHT = 0, LANE_CROSS = 2, LANE_LEFT = 7 } lane_t;
lane_t   e_status;

/* --- 指针 --- */
point_t *p_point;
char    *p_str;

/* --- const --- */
const float c_calib[3] = { 1.5f, 2.5f, 3.5f };
const int   c_gain    = 42;

/* --- static（internal linkage，★ 必须靠包装单元才可见） --- */
static int    st_single = 7;
static int    st_array[16];
static float  st_float  = 0.5f;
static track_t st_track;

/* --- 用户入口（供链接，保证目标文件有效） --- */
int image_init(void)
{
    st_single = 100;
    a_2d[0][0] = 1;

    /* ★ 必须【引用】所有 static 变量，否则优化器/编译器可能把它们整个丢弃，
     *   DWARF 里也就不会有它们 —— 这不是生成器的 bug，而是 C 语义的必然：
     *   一个从未被使用的 static 对象本来就可以不存在。
     *
     *   实测：clang 21 会丢弃未被引用的 static（nm 里只剩 st_single），
     *   而 gcc 10 会保留全部。因此测试夹具必须引用它们，
     *   否则「跨工具链一致性」这条断言会误报。
     *
     *   对真实用户代码这不是问题：会被观察的变量必然是被算法使用的。 */
    st_array[0] = 1;
    st_array[15] = 2;
    st_float = 0.5f;
    st_track.len = 1.0f;
    st_track.p[0].x = 3;

    return st_single + st_array[0] + (int)st_float + st_track.p[0].x;
}

int image_process(void)
{
    /* ★ 陷阱 P-3 探针：函数内的 static 局部变量。
     *   它在 DWARF 里【同样有绝对地址】，看起来完全合法，
     *   但在文件作用域并不可见 —— 若被误当作全局变量注册，
     *   生成的包装单元会编译失败：
     *       error: 'fixture_local_static' undeclared
     *   因此生成器必须只取 DWARF 深度 == 1 的变量。
     *   注意：名字不能以 '_' 开头，否则会被黑名单顺带过滤掉，
     *   导致这个探针失去意义。 */
    static int fixture_local_static = 0;
    fixture_local_static++;

    /* ★ 验证静态变量每帧变化可被观察 */
    st_single++;
    a_2d_small[1][2] = 777;      /* 扁平索引 1*8+2 = 10 */
    e_status = LANE_CROSS;
    s_track.p[1].y = 1234;
    s_track.len = 3.25f;
    return st_single + fixture_local_static;
}
