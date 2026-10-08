/* ==========================================================================
 * scut_registry_internal.h —— 注册机制的内部实现（公开 API 之外的部分）
 * --------------------------------------------------------------------------
 * 谁可以 include：core/src 的注册表实现。
 * 用户代码【永远不需要也不应该】include 这个文件 ——
 * 移植用户面对的只有 scut_registry.h 里的三角色 API。
 * ========================================================================== */
#ifndef SCUT_REGISTRY_INTERNAL_H
#define SCUT_REGISTRY_INTERNAL_H

#include "scut_registry.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 登记一个回调（由各编译器的构造函数机制调用）。
 * role → 执行阶段；priority → 同角色内升序（内部稳定排序的排序键）；
 * name → 诊断显示用；fn → 回调本体。 */
void scut_register_internal(scut_role_t role, int priority,
                   const char *name, scut_callback_fn fn);


/* 构造函数自注册宏（GCC/Clang 的 __attribute__((constructor))、
 * MSVC 的 .CRT$XCU 段）。必须用构造函数：写成普通函数的话链接器不报错、
 * 但主程序不会调用它 —— 静默失败。
 * 三角色宏（SCUT_INIT/SCUT_FRAME/SCUT_POST）在公开头里包一层它，
 * 优先级写死 100 —— 那是内部排序键，不是用户选项。 */
#if defined(__GNUC__) || defined(__clang__)
#  define SCUT_REGISTER(role, prio, name, fn)                             \
      static void scut_reg_##fn(void) __attribute__((constructor));       \
      static void scut_reg_##fn(void) {                                   \
          SCUT_Register((role), (prio), (name), (fn));                    \
      }
#elif defined(_MSC_VER)
#  pragma section(".CRT$XCU", read)
#  define SCUT_REGISTER(role, prio, name, fn)                             \
      static void scut_reg_##fn(void);                                    \
      __declspec(allocate(".CRT$XCU")) static void (*scut_p_##fn)(void)   \
          = scut_reg_##fn;                                                \
      static void scut_reg_##fn(void) {                                   \
          SCUT_Register((role), (prio), (name), (fn));                    \
      }
#else
#  error "SCUT_REGISTER: 未支持的编译器。请为本编译器实现构造函数注册。"
#endif

#ifdef __cplusplus
}
#endif
#endif /* SCUT_REGISTRY_INTERNAL_H */
