/* ==========================================================================
 *  scut_registry.c —— 角色化回调注册表实现
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 适应任意代码 → 用户函数放任意文件，靠构造函数自注册，环境零知识
 *    · 代码松耦合   → 用户代码不做集中清单，注册表是唯一的"名单"
 *
 *  ★ 为什么必须【显式排序】，不能靠"注册顺序"：
 *      SCUT_REGISTER 走构造函数。实测 GCC 下构造函数执行顺序与书写顺序
 *      【相反】（gamma→beta→alpha），且跨编译单元顺序标准未定义；
 *      MSVC 的 .CRT$XCU 语义与 GCC 也不等价。
 *      也就是说"注册顺序"这个概念在两个编译器上都不成立。
 *      唯一能复现的只有显式排序键： (role ↑, priority ↑, name ↑)。
 *
 *  ★ 线程模型（本文件不引入任何锁，这是刻意的）：
 *      注册发生在【构造函数执行期】，也就是 main 之前——此时进程只有
 *      一个线程，不可能有并发写，加锁纯属浪费并且会把锁原语拖进核心。
 *      读取/执行发生在 main 里的调度循环中，本项目【按设计是单线程】的：
 *      处理与呈现都在同一个线程顺序推进，没有跨线程共享该表。
 *      若将来真要跨线程读，应先由调用方在 main 开头把顺序"冻结"
 *      （scut_registry_sort 之后不再写），而不是在核心内部塞一把锁。
 * ========================================================================== */
#include "scut_registry.h"
#include "scut_registry_internal.h"

#include <string.h>
#include <stdint.h>

/* 表容量。1024 条足够覆盖一个人工智能视觉组的全部角色回调，同时
 * 让静态存储量可控（1024 × (公开条目 + 64 字节名字) ≈ 100 KB 以内）。 */
#define SCUT_REG_CAPACITY 1024

/* 名字缓冲区大小：64 字节 = 最多 63 个可见字符 + 结尾 '\0'。
 * 超出部分【安全截断】而不是报错——注册发生在构造期，此时没有任何
 * 输出通道可以报错，静默截断是唯一不会把事情搞得更糟的选择。 */
#define SCUT_REG_NAME_MAX 64

/* --------------------------------------------------------------------------
 *  存储
 *
 *  ★ 名字为什么必须【拷贝】而不是存调用方指针：
 *      注册发生在构造函数执行期。调用方传进来的字符串很可能住在
 *      "临时作用域"或某个即将被卸载的模块里（例如热重载时旧模块的
 *      只读段会被整段卸掉）。存指针的话，等 main 里真正执行回调时，
 *      那个地址指向的已经是垃圾——表现为"回调名乱码"或直接崩，
 *      而且崩在离现场很远的地方，极难排查。
 *
 *  ★ 为什么是【两个平行数组】而不是一个"条目+名字"的结构体数组：
 *      公开类型 scut_registry_entry_t 由冻结的 scut_registry.h 定义，
 *      我们不能改它、也不能在它里面加名字缓冲区。于是名字单独存一份，
 *      由 g_entries[i].name 指回 g_names[i]。
 *      关键约束：任何会移动记录的操作（注册、排序）之后都必须重新
 *      绑定指针，见 relink_names()。比较函数因此【只认 g_names[]】，
 *      不读 .name 字段（排序途中该字段可能是旧值）。
 * -------------------------------------------------------------------------- */
static scut_registry_entry_t g_entries[SCUT_REG_CAPACITY];
static char                  g_names[SCUT_REG_CAPACITY][SCUT_REG_NAME_MAX];
static int                   g_role_count[SCUT_ROLE_COUNT];
static int                   g_count;   /* 当前条目数（含所有角色） */

/* 该角色号是否合法。角色号可能由调用方从 int 强转而来，必须自己兜住。 */
static int role_valid(scut_role_t role)
{
    return ((int)role >= 0) && ((int)role < (int)SCUT_ROLE_COUNT);
}

/* 把 g_entries[i].name 重新绑定到 g_names[i]。
 * 注册/排序之后必须调用一次：这两个操作都会让记录与其名字缓冲区的
 * 下标对应关系发生变化。 */
static void relink_names(void)
{
    int i;
    for (i = 0; i < g_count; i++) {
        g_entries[i].name = g_names[i];
    }
}

/* 在已注册条目里找 (role, name) 是否已存在，返回下标，找不到返回 -1。
 * name 必须是【已经截断过】的本地副本，这样比较口径与存储口径一致：
 * 存进去的是什么，就去重什么，不会出现"存的是截断版、比的是全文"的不对称。 */
static int find_dup(scut_role_t role, const char *name)
{
    int i;
    for (i = 0; i < g_count; i++) {
        if (g_entries[i].role == role && strcmp(g_names[i], name) == 0) {
            return i;
        }
    }
    return -1;
}

/* --------------------------------------------------------------------------
 *  比较函数：必须是【全序】(total order)
 *
 *  ★ 为什么非要全序，而不能只比前两层：
 *      排序算法只要求"严格弱序"，当两条记录被判为相等时，它们的相对
 *      顺序就交给实现去决定。换编译器、换标准库、甚至同编译器换
 *      -O 级别都可能换出另一种顺序，于是出现"同一份代码跑出不同帧序"
 *      这种最难复现的 bug。这里一路比到第 4 层，让任意两条不同记录
 *      都有确定先后，顺序完全由数据决定，与编译器和构造顺序无关。
 *
 *  ★ 第 4 层为什么用 fn 指针兜底：
 *      正常情况下去重已保证 role 内 name 唯一，第 3 层就分出了胜负，
 *      第 4 层永远不会生效。它只是"未来如果有人放宽去重规则"的保险，
 *      让顺序依然确定。
 *
 *  ★ 第 4 层为什么转成 uintptr_t 比大小，而不是直接比 fn：
 *      C 标准只对函数指针定义了 == 和 !=，用 < 比较函数指针是
 *      【未定义行为】。转成整数再比是"实现定义"而非未定义，在
 *      gcc / clang / msvc 上都有确定结果，是本项目需要的可复现性。
 * -------------------------------------------------------------------------- */
static int slot_cmp(int i, int j)
{
    int c;

    if (g_entries[i].role != g_entries[j].role) {
        return (g_entries[i].role < g_entries[j].role) ? -1 : 1;
    }
    if (g_entries[i].priority != g_entries[j].priority) {
        return (g_entries[i].priority < g_entries[j].priority) ? -1 : 1;
    }
    c = strcmp(g_names[i], g_names[j]);
    if (c != 0) {
        return (c < 0) ? -1 : 1;
    }
    {
        uintptr_t fi = (uintptr_t)g_entries[i].fn;
        uintptr_t fj = (uintptr_t)g_entries[j].fn;
        if (fi != fj) {
            return (fi < fj) ? -1 : 1;
        }
    }
    return 0;
}

/* 交换两条记录。名字缓冲区必须跟着条目一起走，否则名字会"串位"；
 * 交换完由 relink_names() 统一把 .name 重新指对。 */
static void slot_swap(int i, int j)
{
    scut_registry_entry_t tmp_entry = g_entries[i];
    char                  tmp_name[SCUT_REG_NAME_MAX];

    memcpy(tmp_name, g_names[i], SCUT_REG_NAME_MAX);

    g_entries[i] = g_entries[j];
    memcpy(g_names[i], g_names[j], SCUT_REG_NAME_MAX);

    g_entries[j] = tmp_entry;
    memcpy(g_names[j], tmp_name, SCUT_REG_NAME_MAX);
}

/* --------------------------------------------------------------------------
 *  注册
 *
 *  四类输入直接【静默忽略】：角色号越界、fn 为 NULL、name 为 NULL、表满。
 *  为什么是静默而不是断言/报错：本函数在 main 之前被构造函数调用，
 *  那时既没有 UI 也没有日志通道，任何"报错"都只会变成崩溃或无声无息，
 *  反而把一次可用的运行毁掉。宁可少注册一条，也不要整个程序起不来。
 * -------------------------------------------------------------------------- */
void scut_register_internal(scut_role_t role, int priority,
                   const char *name, scut_callback_fn fn)
{
    char local[SCUT_REG_NAME_MAX];
    int  n;

    if (!role_valid(role) || fn == NULL || name == NULL) {
        return;
    }
    if (g_count >= SCUT_REG_CAPACITY) {
        return;
    }

    /* --- 安全截断到本地副本 --- */
    n = 0;
    while (n < SCUT_REG_NAME_MAX - 1 && name[n] != '\0') {
        local[n] = name[n];
        n++;
    }
    local[n] = '\0';

    /* --- 按 (role, name) 去重 ---
     * 这条不是可选项：一个头文件被多个编译单元包含时，同一个回调会被
     * 注册多次。执行期表现为"同一段算法跑 N 遍"，性能数据直接翻倍，
     * 而且用户完全看不出为什么。保留【先注册的那条】（后到的忽略），
     * 与本项目 scut_watch.c 的口径一致。 */
    if (find_dup(role, local) >= 0) {
        return;
    }

    memcpy(g_names[g_count], local, SCUT_REG_NAME_MAX);

    g_entries[g_count].role     = role;
    g_entries[g_count].priority = priority;
    g_entries[g_count].name     = g_names[g_count];
    g_entries[g_count].fn       = fn;

    g_role_count[(int)role]++;
    g_count++;
}

/* --------------------------------------------------------------------------
 *  排序：插入排序
 *
 *  为什么不用 qsort：
 *    1) qsort 不保证稳定。本表虽然被全序比较函数变成"顺序唯一"，
 *       从而稳定与否不影响结果，但显式写成稳定插入排序，
 *       让"顺序由数据决定"这件事在代码里一眼可见，不依赖读者去推演。
 *    2) 表很小（上限 1024，实际几十条），插入排序在近有序输入上
 *       是 O(n)，比 qsort 的函数指针间接调用更快，且不需要引入
 *       qsort 的比较函数签名转换（那是另一个容易踩的坑）。
 *    3) 无递归、无额外内存、行为完全可预测——符合"模拟单片机"的取向。
 * -------------------------------------------------------------------------- */
void scut_registry_sort(void)
{
    int i;

    for (i = 1; i < g_count; i++) {
        int j = i;
        /* 只有严格大于才交换 => 相等元素保持原有相对次序 => 稳定。
         * 本表的比较函数是全序，实际上不会出现"相等"，这行注释是为了
         * 说明即便将来比较键变少，这个实现也不会退化成不稳定排序。 */
        while (j > 0 && slot_cmp(j - 1, j) > 0) {
            slot_swap(j - 1, j);
            j--;
        }
    }

    relink_names();
}

/* --------------------------------------------------------------------------
 *  执行
 *
 *  表在排序后是按 role 分块的（全局按 role 升序），所以同角色回调天然
 *  连续且已按 priority/name 排好。这里直接全表扫描而不是用
 *  g_role_count 算区间：省掉一处"计数与内容失配"的隐患，代价是
 *  O(总条目数) 而不是 O(该角色条目数)。上限 1024，每帧一次，可忽略。
 *
 *  零条目时循环体不执行，天然安全——不需要任何特判。
 * -------------------------------------------------------------------------- */
void scut_registry_invoke(scut_role_t role)
{
    int i;

    if (!role_valid(role)) {
        return;
    }
    for (i = 0; i < g_count; i++) {
        if (g_entries[i].role == role && g_entries[i].fn != NULL) {
            g_entries[i].fn();
        }
    }
}

/* --------------------------------------------------------------------------
 *  内省与维护
 * -------------------------------------------------------------------------- */

int scut_registry_count(scut_role_t role)
{
    if (!role_valid(role)) {
        return 0;
    }
    return g_role_count[(int)role];
}

int scut_registry_size(void)
{
    return g_count;
}

/* 按下标取条目（排序后的顺序）。
 * 返回的地址在整个进程生命周期内稳定，但【内容/顺序】会被
 * scut_registry_sort() 改变：调用方拿到指针后不要在排序前后交叉使用。
 * 越界返回 NULL 而不是断言——UI 侧遍历时更容易写出越界访问。 */
const scut_registry_entry_t *scut_registry_at(int index)
{
    if (index < 0 || index >= g_count) {
        return NULL;
    }
    return &g_entries[index];
}

/* 清空全表。仅供测试使用：正常流程里注册表是"开机一次、只增不减"的，
 * 因为注册发生在 main 之前，运行期没有删除回调的需求。 */
void scut_registry_reset(void)
{
    memset(g_entries, 0, sizeof(g_entries));
    memset(g_names, 0, sizeof(g_names));
    memset(g_role_count, 0, sizeof(g_role_count));
    g_count = 0;
}
