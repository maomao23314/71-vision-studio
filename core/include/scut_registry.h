/* ==========================================================================
 *  scut_registry.h —— 回调注册表
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 代码松耦合   → 环境只认「四个阶段 + 一个函数指针」，不认任何业务概念
 *    · 上手即用     → 用户【完全不接触本文件】：钩子由插件设置指定，
 *                     构建脚本生成接线单元，这里只提供接线单元用的落点
 *    · 模拟单片机   → 与车载 main() 的调用序列一一对应
 *
 *  ★★ 为什么用户代码里不该出现 SCUT_INIT / SCUT_FRAME / SCUT_POST ★★
 *
 *    加了这些宏，用户代码就带上了仿真环境的痕迹；把 code/ 拷到车载工程
 *    时会因为找不到 scut_registry.h 而编译失败。而车载工程本来就有
 *    自己的 main()，它自己会按顺序调用 init / 处理 / 后处理 ——
 *    也就是说，这些注册信息【本来就属于宿主，不属于算法】。
 *
 *    所以现在：注册只发生在【构建时生成的接线单元】里，
 *    用户只需要保证三个函数是普通的外部链接函数（非 static），
 *    这恰好也是车载 main() 对它们的要求。
 *
 *  ★ 顺序问题（实测结论，仍然成立）：
 *      GCC 下构造函数执行顺序与书写顺序相反，且跨编译单元顺序未定义。
 *      因此环境【必须】显式排序，不能依赖构造顺序。
 *      排序键：(role, priority, name) 字典序，保证可复现。
 *      同一角色内的多个回调按 priority 升序执行。
 * ========================================================================== */
#ifndef SCUT_REGISTRY_H
#define SCUT_REGISTRY_H

#include "scut_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
 *  阶段
 *
 *  四个角色各对应调度里的一个调用点；只有 PROCESS 计时：
 *      PROCESS 是唯一计入 process_us 的阶段 —— 它就是「算法耗时」。
 *      DRAW 不计时，因为它做的是「给人看的事」，车上没有对应开销；
 *      但绘图本身仍是真实成本，所以单独统计成 draw_us。
 *
 *  ★ 为什么 DRAW 必须在「合成覆盖层」之前执行：
 *      合成是每帧一次性的收尾动作。若某个回调在合成之后才画，它的标注
 *      会落到【下一帧】的画面上，而本帧什么都没有 —— 不报错、不崩溃，
 *      只是所有标注慢一帧、且最后一帧的标注永远丢失。
 *      这是本项目历史上真实发生过的缺陷，所以顺序由调度器固定，
 *      并且这里是唯一能表达「绘制」的阶段。
 * -------------------------------------------------------------------------- */
typedef enum {
    SCUT_ROLE_INIT     = 0,  /* 开机一次，【不计时】 */
    SCUT_ROLE_PROCESS  = 1,  /* ★ 图像处理主体，计时 → process_us */
    SCUT_ROLE_DRAW     = 2,  /* 绘制标注 + 打日志，【不计时】，在合成之前 */
    SCUT_ROLE_SHUTDOWN = 3,  /* 退出清理，【不计时】 */
    SCUT_ROLE_COUNT
} scut_role_t;

typedef void (*scut_callback_fn)(void);

/* --- 供核心调度使用 --- */
int  scut_registry_count(scut_role_t role);
void scut_registry_sort(void);
void scut_registry_invoke(scut_role_t role);

/* 清空全表。供【会话重建】与测试使用。
 *
 * ★ 为什么保留它（2026-10-11 复核：它当前零调用）：
 *   正常流程里注册表是"开机一次、只增不减"的（注册发生在 main 之前），
 *   所以运行期确实不需要它。但只要出现"同一个进程里重开一次会话"
 *   的需求（嵌入式上的软复位、将来做多工程切换、单元测试要重置状态），
 *   没有它就只能重启进程。
 *   它是【公开头文件里的接口】，不是内部死代码 —— 删掉会让将来
 *   重新加回来时再冒一次"改了签名没人报错"的风险。保留并在测试里用它。
 */
void scut_registry_reset(void);

/* --- 内省（供插件/UI 展示「环境当前认识哪些回调」） ---
 *
 * ★ 为什么保留这三个（2026-10-11 复核：当前只有 --list-vars 在用 watch 表，
 *   注册表这组还没被消费）：
 *   它们回答的是"环境到底注册了哪些回调、按什么顺序执行"——
 *   排查"用户的 init 没跑""两个钩子顺序不对"这类问题时，
 *   这是唯一的内省入口。当前没有消费者，是因为界面还没做到那一步，
 *   不是这个能力没价值。删掉它等于把这类问题的排查手段一起删了。 */
typedef struct {
    scut_role_t       role;
    int               priority;
    const char       *name;
    scut_callback_fn  fn;
} scut_registry_entry_t;

int                          scut_registry_size(void);
const scut_registry_entry_t *scut_registry_at(int index);

/* --------------------------------------------------------------------------
 *  注册入口 —— ★ 只给「构建时生成的接线单元」用，用户代码不调用
 *
 *  必须用构造函数自注册：实测写成普通函数时链接器不报错，
 *  但主程序不会调用它，表现为「回调从未执行」这一静默失败。
 *
 *  接线单元（.scut/gen/scut_env_glue.c）由 tools/scut_build.py 生成，
 *  内容形如：
 *      void scut_env_frame(void) { image_process(); }
 *      ENV_REGISTER(SCUT_ROLE_PROCESS, 100, "env_frame", scut_env_frame)
 * -------------------------------------------------------------------------- */
void scut_register_internal(scut_role_t role, int priority, const char *name,
                            scut_callback_fn fn);

#if defined(__GNUC__) || defined(__clang__)
#  define ENV_REGISTER(role, prio, name, fn)                              \
      static void scut_reg_##fn(void) __attribute__((constructor));       \
      static void scut_reg_##fn(void) {                                   \
          scut_register_internal((role), (prio), (name), (fn));           \
      }
#elif defined(_MSC_VER)
#  pragma section(".CRT$XCU", read)
#  define ENV_REGISTER(role, prio, name, fn)                              \
      static void scut_reg_##fn(void);                                    \
      __declspec(allocate(".CRT$XCU")) static void (*scut_p_##fn)(void)   \
          = scut_reg_##fn;                                                \
      static void scut_reg_##fn(void) {                                   \
          scut_register_internal((role), (prio), (name), (fn));           \
      }
#else
#  error "ENV_REGISTER: 未支持的编译器。请为该编译器实现构造函数注册。"
#endif

#ifdef __cplusplus
}
#endif
#endif /* SCUT_REGISTRY_H */
