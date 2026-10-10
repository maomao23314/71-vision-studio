/* ==========================================================================
 *  scut_watch.h —— 变量观察注册表
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 适应任意代码 → 变量名/类型/尺寸全部【运行时发现】，环境零知识
 *    · 上手即用     → 用户默认【一个都不用手动注册】（靠自动发现）
 *
 *  ★ 本文件是「环境」与「自动生成的注册代码」之间的契约。
 *    生成代码是 C 文件，且可能被 C++ 编译单元包含，
 *    所以所有声明都必须包在 extern "C" 里。
 *
 *  ---------------------------------------------------------------------------
 *  两条使用路径（决策 D-7：两者共存）
 *  ---------------------------------------------------------------------------
 *  1) 自动发现（默认，零代码）
 *       构建时扫描目标文件 DWARF → 生成包装单元 → 自动调用下面的
 *       6 参数 SCUT_Watch。用户什么都不用写。
 *
 *  2) 手动注册（兜底）
 *       自动发现覆盖不到的场景：运行期 malloc 的缓冲、
 *       函数内 static 数组等。
 * ========================================================================== */
#ifndef SCUT_WATCH_H
#define SCUT_WATCH_H

#include "scut_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 * 渲染类型
 *
 * ★ 与 tools/scut_symbols.py 生成的 SCUT_T_xxx 字符串一一对应。
 *   改动这里必须同步改生成器，否则注册表里会出现未知类型。
 *   （tests/test_symbols.py 会捕获这类不一致。）
 *
 * ★★ 两类"不会被解引用"的类型：SCUT_T_PTR 与 SCUT_T_STR ★★
 *   它们的值只渲染成地址。原因：表里存的指针完全不可控，
 *   解引用可能指向已释放内存或任意地址 → 崩在变量面板的刷新路径上。
 *   SCUT_T_STR 曾经是例外（当成字符串读），已改为与 PTR 一致；
 *   详见 core/src/scut_watch.c 里该分支的说明。
 *
 *   ★ 顺带说明为什么 SCUT_T_STR 几乎用不到：
 *     scut_symbols.py 对 DW_TAG_pointer_type 一律产出 SCUT_T_PTR，
 *     【从不产出 SCUT_T_STR】。所以它只在手写 SCUT_Watch 时才可能出现。
 *     保留这个枚举值是为了让"我想显示一个字符串"这件事有地方表达
 *     （将来若要支持读字符串，正是在这里扩展）。
 * -------------------------------------------------------------------------- */
typedef enum {
    SCUT_T_I8 = 0, SCUT_T_U8,
    SCUT_T_I16,    SCUT_T_U16,
    SCUT_T_I32,    SCUT_T_U32,
    SCUT_T_I64,    SCUT_T_U64,
    SCUT_T_F32,    SCUT_T_F64,
    SCUT_T_BOOL,
    SCUT_T_PTR,    SCUT_T_STR,
    SCUT_T_ENUM,   SCUT_T_STRUCT
} scut_watch_type_t;

typedef struct {
    const char        *name;   /* 变量名（UI 显示用） */
    const void        *p;      /* 变量地址（由链接器解析，非硬编码数值） */
    scut_watch_type_t  t;      /* 渲染类型 */
    int                n;      /* 元素个数 */
    int                es;     /* 元素字节数 */
    int                dim;    /* 维度：0=标量，1=一维，2=二维… */
} scut_watch_entry_t;

/* --------------------------------------------------------------------------
 * 注册一个可观测量。由自动生成的 constructor 调用。
 *
 * ★ 为什么传【变量地址】而不是数值：
 *     变量地址 = 运行期加载地址，生成期不可知（ASLR / 重定位）。
 *     生成 `&g_left_line` 由加载器自动解析，天然正确。
 *     所以包装单元必须与用户目标文件【一起链接】。
 *
 * ★ 去重：同名重复注册时保留第一个。用于兜住
 *   「同一个符号被多个编译单元注册」的情况。
 * -------------------------------------------------------------------------- */
void SCUT_Watch(const char *name, const void *p, scut_watch_type_t t,
                int count, int elem_size, int dim);

/* --- 供呈现后端/UI 遍历 --- */
int                          scut_watch_count(void);
const scut_watch_entry_t    *scut_watch_at(int index);

/* 清空观察表。供【会话重建】与测试使用。
 *
 * ★ 为什么保留它（2026-10-11 复核：它当前零调用）：
 *   与 scut_registry_reset 同理 —— 注册发生在 main 之前、只增不减，
 *   运行期不需要清空。但"同进程重开会话"的场景（软复位、多工程切换、
 *   单元测试）需要它，而它是公开接口。
 *   tests/test_mem_safety.py 的驱动就是靠这类 reset 反复建表验越界的。 */
void                         scut_watch_reset(void);

/* --- 读值 ---
 * 把第 index 个变量的前 max_values 个元素格式化进 buf。
 * 返回实际写入的元素个数；*truncated 置 1 表示值太多被截断。
 *
 * ★ 为什么只传文本不传原始内存：
 *   避免把任意大小的缓冲（可能是 22560 字节的图像）塞进
 *   webview 消息通道。UI 只关心「显示什么」，不关心布局。 */
int scut_watch_read(int index, char *buf, int buf_size,
                    int max_values, int *truncated);

#ifdef __cplusplus
}
#endif
#endif /* SCUT_WATCH_H */
