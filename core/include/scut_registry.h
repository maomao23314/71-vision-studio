/* ==========================================================================
 *  scut_registry.h —— 角色化回调注册表
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 适应任意代码 → 用户函数可放任意文件；靠构造函数自注册，环境零知识
 *    · 上手即用     → 一条 SCUT_INIT / SCUT_FRAME / SCUT_POST 搞定，不用改集中清单
 *
 *  ★ 顺序问题（实测结论）：
 *      GCC 下构造函数执行顺序为 gamma→beta→alpha，与书写顺序【相反】，
 *      且跨编译单元顺序未定义；MSVC 的 .CRT$XCU 语义与 GCC 不完全等价。
 *      因此环境【必须】显式排序，不能依赖构造顺序。
 *      排序键： (role, priority, name) 字典序，保证可复现。
 * ========================================================================== */
#ifndef SCUT_REGISTRY_H
#define SCUT_REGISTRY_H

#include "scut_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 * 角色
 *
 * 计时口径是本枚举存在的主要理由：把「算什么」和「不算什么」在类型层面分开，
 * 而不是靠文档约定。车载程序上没有「画点给屏幕看」这件事，
 * 把它算进算法耗时会让性能数据失真。
 * -------------------------------------------------------------------------- */
typedef enum {
    SCUT_ROLE_INIT       = 0,  /* 开机一次，【不计时】 */
    SCUT_ROLE_PRE_FRAME  = 1,  /* 每帧处理前，计时内 */
    SCUT_ROLE_PROCESS    = 2,  /* ★ 图像处理主体，计时内 */
    SCUT_ROLE_POST_FRAME = 3,  /* 每帧处理后，计时内 */
    SCUT_ROLE_DRAW       = 4,  /* ★ 绘制覆盖层，【不计时】 */
    SCUT_ROLE_REPORT     = 5,  /* ★ 输出 LOG/数据，【不计时】 */
    SCUT_ROLE_SHUTDOWN   = 6,  /* 退出清理，【不计时】 */
    SCUT_ROLE_COUNT
} scut_role_t;

typedef void (*scut_callback_fn)(void);


/* --- 供核心调度使用 --- */
int  scut_registry_count(scut_role_t role);          /* 某角色的回调数 */
void scut_registry_sort(void);                        /* 显式稳定排序 */
void scut_registry_invoke(scut_role_t role);          /* 按序执行该角色全部回调 */
void scut_registry_reset(void);                       /* 仅供测试 */

/* --- 内省（供插件/UI 展示"环境当前认识哪些回调"） --- */
typedef struct {
    scut_role_t       role;
    int               priority;
    const char       *name;
    scut_callback_fn  fn;
} scut_registry_entry_t;

int                        scut_registry_size(void);
const scut_registry_entry_t *scut_registry_at(int index);

/* --------------------------------------------------------------------------
 * 注册宏
 *
 * ★ 必须用 constructor：实测若写成普通函数，链接器不报错，
 *   但主程序不会调用它，表现为「回调从未执行」这一静默失败。
 *
 * ★ 同时必须防止被链接器整块丢弃。本项目的做法是
 *   【环境做静态库、用户代码做普通 .o】，用户 .o 是直接链接输入，
 *   不存在被丢弃的问题 —— 因此这里不需要 --whole-archive。
 * -------------------------------------------------------------------------- */



/* --------------------------------------------------------------------------
 * 【给移植用户】
 * 早期的 SCUT_REGISTER(role, 优先级, 名字, fn) 已从公开 API 移除。
 * 现在只有三个词：SCUT_INIT / SCUT_FRAME / SCUT_POST（见文件末尾）。
 * 优先级是环境内部保证稳定排序的实现细节，不该让移植代码做选择。
 * -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
 * 【三角色简单 API】—— 给移植用户用的唯一入口
 *
 * 用户原话："就只有初始化、每一帧的函数和一个后处理函数，
 *   初始化只在启动时调用一次，剩下每一帧都调用，
 *   后处理和初始化不参与计时，哪来的优先级需要设置！"
 *
 * 完全正确 —— 移植者面对的车载工程就是这三个钩子，让他在优先级数字上
 * 做选择只会添乱：写错数字轻则乱序、重则依赖错误顺序的隐式契约。
 * 所以这里把优先级【收进环境内部】，用户面前只有三个词：
 *
 *     SCUT_INIT(fn)    启动时调用一次（不计时）
 *     SCUT_FRAME(fn)   每一帧调用（★ 计时 —— 这是算法性能的测量点）
 *     SCUT_POST(fn)    每帧末尾调用（不计时：覆盖层、日志等观测）
 *
 * 多个同角色回调按【注册的先后】执行（环境内部保证稳定排序），
 * 用户不需要也不可能控制顺序 —— 需要顺序就把调用写进同一个函数里。
 * -------------------------------------------------------------------------- */
/*
 * ★ 三角色宏自带完整的构造注册展开（不再经过已移出公开头的
 *   SCUT_REGISTER —— 用户代码只 include 本头，内部头对用户不可见）。
 *   name 传 #fn（字符串化的函数名，注册表拿它做诊断显示）；
 *   内部注册函数名用 fn##\_reg 拼接，同一函数注册多个角色也不冲突。
 */
/* 内部函数：三角色宏展开的落点。用户【不直接调用】——
 * 声明在公开头是因为宏需要可见的原型；名字带 internal，
 * 明确它不是给移植代码用的 API。 */
void scut_register_internal(scut_role_t role, int priority, const char *name,
                            scut_callback_fn fn);
#if defined(__GNUC__) || defined(__clang__)
#  define SCUT_INIT(fn)                                                   \
      static void fn##_reg(void) __attribute__((constructor));            \
      static void fn##_reg(void) {                                        \
          scut_register_internal(SCUT_ROLE_INIT, 100, #fn, fn);                    \
      }
#  define SCUT_FRAME(fn)                                                  \
      static void fn##_reg(void) __attribute__((constructor));            \
      static void fn##_reg(void) {                                        \
          scut_register_internal(SCUT_ROLE_PROCESS, 100, #fn, fn);                 \
      }
#  define SCUT_POST(fn)                                                   \
      static void fn##_reg(void) __attribute__((constructor));            \
      static void fn##_reg(void) {                                        \
          scut_register_internal(SCUT_ROLE_REPORT, 100, #fn, fn);                  \
      }
#elif defined(_MSC_VER)
#  pragma section(".CRT$XCU", read)
#  define SCUT_INIT(fn)                                                   \
      static void fn##_reg(void);                                         \
      __declspec(allocate(".CRT$XCU")) static void (*fn##_p)(void) = fn##_reg; \
      static void fn##_reg(void) {                                        \
          scut_register_internal(SCUT_ROLE_INIT, 100, #fn, fn);                    \
      }
#  define SCUT_FRAME(fn)                                                  \
      static void fn##_reg(void);                                         \
      __declspec(allocate(".CRT$XCU")) static void (*fn##_p)(void) = fn##_reg; \
      static void fn##_reg(void) {                                        \
          scut_register_internal(SCUT_ROLE_PROCESS, 100, #fn, fn);                 \
      }
#  define SCUT_POST(fn)                                                   \
      static void fn##_reg(void);                                         \
      __declspec(allocate(".CRT$XCU")) static void (*fn##_p)(void) = fn##_reg; \
      static void fn##_reg(void) {                                        \
          scut_register_internal(SCUT_ROLE_REPORT, 100, #fn, fn);                  \
      }
#else
#  error "SCUT_INIT/SCUT_FRAME/SCUT_POST: 未支持的编译器。请为该编译器实现构造函数注册。"
#endif
#ifdef __cplusplus
}
#endif
#endif /* SCUT_REGISTRY_H */
