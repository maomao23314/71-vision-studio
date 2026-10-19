# SCUT-71 Vision Studio · 构建脚本（tools/）

本目录下有两个脚本，**用户只需要知道这一份说明**。

| 文件 | 作用 |
|---|---|
| `scut_build.py` | **构建编排**：把用户算法编成 `scut_sim.exe`（就是你平时用的那个） |
| `scut_symbols.py` | **自动符号发现**：从调试信息里找出你的全局变量。由 `scut_build.py` 自动调用，你一般不用自己跑 |

---

## 一、三个命令，够用了

```bat
:: 构建（最常用）
python tools\scut_build.py --project .

:: 自检：先说清楚"环境到底能不能用"，再决定要不要构建
python tools\scut_build.py doctor --project .

:: 清理生成物（只删 .scut/，绝不动你的代码）
python tools\scut_build.py clean --project .
```

`--project` 指向你的工程目录（那个装着 `code/` 与 `scut_project.json` 的目录）。
老工程用 `config.h` 承载尺寸契约，也仍然支持。

### 全部选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `--toolchain <根目录>` | 自动探测 | 例：`--toolchain D:\TOOLS\llvm-mingw`。探测顺序见下 |
| `--core-lib <路径>` | `<工程>/.scut/lib/libscut_core.a` | 环境核心静态库的位置 |
| `--no-watch` | 关 | **跳过自动符号发现**。构建更快，但变量面板会是空的 |
| `--jobs N` | CPU 核数 | 并行编译的文件数 |
| `--json` | 关 | 给 VS Code 插件用的机器可读输出，见第四节 |
| `-v` / `--verbose` | 关 | 打印每一条实际执行的命令行（排查问题时很有用） |

工具链探测顺序：`--toolchain` → 环境变量 `SCUT71_TOOLCHAIN` → `PATH` → 问用户。

> **刻意【没有】内置的"常见安装位置"候选目录。** 每个人的安装位置都不一样，
> 猜目录在本项目上被证伪过两次（详见 `docs/架构设计.md` §4.5）。
> 找不到时就弹窗让用户选「指定已有的」或「帮我下载」，而不是替他决定。

---

## 二、它是怎么工作的（三段，都值得知道）

### 1. 库方向是「反」的：环境是静态库，你的代码是普通 `.o`

```
旧做法：main(环境) + libuser.a   →  必须 -Wl,--whole-archive，
                                   否则用户构造函数被【静默丢弃】
本环境：libscut_core.a + user.o  →  不需要任何特殊链接选项
```

为什么？静态库是**按需拉取**的。你的 `.o` 是**直接链接输入**、不是库成员，不存在被丢弃的问题；而 `libscut_core.a` 里的 `main` 被 C 运行时引用，必然被拉取进来。

**所以本脚本刻意不传 `--whole-archive`。** 传了不会更正确，只会把这个架构上的优点掩盖掉。

（如果你的算法哪天要打包成自己的 `.a`，那时才需要 `--whole-archive`。`code/*.c` 保持普通源码就没这个问题。）

**好处**：你改算法时，只有你的代码重编，环境（几百 KB 的预编译产物）**零重编**。

### 2. 每个 `.c` 编译两遍：探针 → 生成包装单元 → 编译包装单元

```
[1] clang -g -O0 -c main.c -o main.probe.o          ← 探针：产出调试信息
[2] python tools/scut_symbols.py --obj main.probe.o --src main.c \
        --out-c main.wrapped.c --out-json main.vars.json   ← 生成
[3] clang ... -c main.wrapped.c -o main.o           ← 编译【包装单元】，不是原文件
```

**为什么必须编译「包装单元」而不是你的原文件？**

你的代码里有 `static` 全局变量（internal linkage）。一个独立的注册单元**引不到它们**（链接期报 undefined reference）。实测三条路线：

| 做法 | 结果 |
|---|---|
| 独立注册单元 | ❌ `static` 变量链接失败 |
| 编译时 `-include` 前置注入 | ❌ 声明还没出现，编译失败 |
| **包装单元**（本环境采用） | ✅ 全部变量（含 `static`）注册成功 |

包装单元长这样——先展开你的源码，再注册：

```c
#include "main.c"          /* ① 先展开：所有声明（含 static）都可见了 */
#include "scut_watch.h"
__attribute__((constructor))
static void scut_autoreg(void)
{
    SCUT_Watch("g_threshold", (const void*)&g_threshold, SCUT_T_I32, 1, 4, 0);
    /* ... 其余变量 ... */
}
```

**为什么注册函数必须是 `constructor`**：写成普通函数时链接器不报错，但**没人调用它**——表现为「变量面板永远是空的」这种静默失败。

**没有 `--mode` 选项。** 优化等级是固定约定，不是让用户选的开关：
- **用户代码恒为 `-g -O0`**（`user_flags`）：-O2 会重排语句、把变量优化进寄存器，逐行调试时断点漂移、变量看不到值。
- **环境自身恒为 `-O2`**（`env_flags` / `core_flags`）：核心库、bind 单元、呈现后端、接线单元都不是算法，优化只影响环境开销。
- **探针编译恒用 `-g -O0`**，两个原因：
  - `-O2` 会把**从未被引用的 `static` 整个删掉**（这是 C 语言的正常行为，不是 bug）。探针阶段保持 `-O0` 才能把变量都看见。
- 没有 `-g` 就没有调试信息，自动发现无从下手。

> **诚实边界**：只有**被使用过**的变量才会出现在变量面板里。一个从未被任何代码引用的 `static`，编译器有权把它整个删除——这时它在目标文件里根本不存在。这与调试器的行为一致。
>
> **另一个边界**：`code/` 里**不要写 `main()`**——`main` 由呈现后端提供（`backends/headless/` 等），你写一个会撞车（`duplicate symbol: main`）。你也**不需要**（也不应该）写任何注册宏：环境调用哪几个函数由 `scut_project.json` 的 `hooks` 指定，构建时自动生成接线单元。这是本项目的核心设计——用户代码零注册、可原样拷进车载工程。

### 3. 自动发现失败**不会**让构建失败

符号发现是**锦上添花**。哪一步不顺利（生成器报错、包装单元编不过），脚本都会**自动退回直接编译你的原文件**，并打一条警告。

理由很简单：**「变量面板少几个变量」和「算法根本跑不起来」是严重性完全不同的两件事**，绝不能让前者导致后者。构建完你会看到警告，照着做即可。

---

## 三、它能自动处理的事（以及为什么）

| 情况 | 脚本怎么做 |
|---|---|
| **路径含空格与中文** | 全程用列表形式调用进程，**绝不**拼接命令字符串、**绝不** `shell=True`。这是"能用"的唯一可靠做法 |
| 工程用 `config.h`，而 `bind` 里 `#include "scut_config.h"` | 在 `.scut/gen/` 生成一个**只做转发的** `scut_config.h`。**bind 源码一行都不用改**，两种命名都能用 |
| 工程用 `scut_config.h` | 什么都不做，直接用你的 |
| 两个都没有 | 可用环境变量 `SCUT_IMAGE_W` / `SCUT_IMAGE_H` 通过 `-D` 注入，但会**警告**你：IDE 里会满屏红波浪线，建议补 `config.h` |
| `objdump` 是 LLVM 的 `llvm-objdump` | **警告并自动关闭符号发现**（仍能构建）。原因：自动发现依赖 `objdump --dwarf=info`，而 **LLVM 21 已移除该选项** |
| 生成文件写到一半被插件读到 | 先写同盘临时文件，再 `os.replace` **原子替换**。绝不会留下半截 JSON |
| 编译出错 | 解析成结构化诊断（文件/行/列/严重级），并**把第一个错误单独醒目地讲一遍** |

关于 `objdump` 这条要多说一句，因为它是个**静默失败**：LLVM 21 的 `llvm-objdump` 只支持 `--dwarf=frames`，用它会拿不到任何变量，而构建**照常成功**。所以：

> **自动符号发现必须用 binutils 的 `objdump`**（例如 MinGW-w64 里的那个），不能用 `llvm-objdump`。
> `doctor` 会真的拿一个小目标文件跑一遍来做**功能探测**，而不是只看版本号。

---

## 四、给 VS Code 插件用：`--json`

```bat
python tools\scut_build.py --project . --json
```

**`--json` 时，所有人类可读的进度都走 stderr，stdout 只有一段 JSON**，可以直接 `JSON.parse`：

```json
{
  "ok": true,
  "exePath": "C:\\...\\.scut\\bin\\scut_sim.exe",
  "output": "（编译器/链接器的原始输出）",
  "elapsedMs": 1234,
  "errors": [
    { "file": "C:\\...\\code\\camera.c", "line": 23, "column": 5,
      "severity": "error", "message": "use of undeclared identifier 'foo'" }
  ],
  "manifest": { "source": "main.c", "count": 8, "variables": [ /* ... */ ] }
}
```

- `severity` 取 `error` / `warning` / `info`（`note` 会降级成 `info`）。
- `manifest` 在 `--no-watch` 时是 `null`。
- 多文件工程时 `manifest.source` 是逗号分隔的来源列表，`variables` 是汇总后的全部变量。
- 变量清单也会落盘到 `<工程>/.scut/gen/variables.json`。

退出码：`0` 成功 · `1` 编译/链接失败 · `2` 环境或工程结构有致命问题 · `3` 脚本自身出错。

---

## 五、逃生舱：`scut.extra.mk`

算法要用到第三方库时，在工程根放一个 `scut.extra.mk`：

```make
# 只接受 -l<库名> 与 -L<目录> 两种选项
LIBS = -lmyalgo -L./third_party/libs

# 路径含空格请用引号包起来
LIBS += -L"../我的 库目录"
```

- 相对 `-L` 路径**按 `scut.extra.mk` 所在目录**解析，不用写绝对路径。
- **其余内容一律被拒绝并告警**（包括 `$(shell ...)`、通配符、反引号）。

第二条是**刻意**的，不是偷懒：允许任意命令会立刻破坏「路径含空格与中文也能构建」这条硬要求（字符串拼接、shell 展开都会出问题）。所以这个逃生舱只走**安全的 token 白名单**。

---

## 六、出问题时

**先跑 `doctor`**，它会把工具链、工程结构、核心库逐项报给你，并给出「下一步做什么」：

```bat
python tools\scut_build.py doctor --project .
```

脚本里**每一条错误信息都包含三件事**：**什么失败了** → **可能的原因** → **你该做什么**。看到看不懂的报错，那是脚本的 bug，请反馈。

常见的三条：

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `找不到环境核心静态库` | 环境核心还没构建/没放对位置 | 把 `libscut_core.a` 放到 `<工程>/.scut/lib/`，或 `--core-lib <路径>` |
| 变量面板**空的**，但构建成功 | `objdump` 不是 binutils 版本 | 跑 `doctor` 看第 `[1/3]` 节；装上 MinGW-w64 或把 binutils 加进 PATH |
| `duplicate symbol: main` | `code/` 里写了 `main()` | 删掉它。`main` 由呈现后端提供；你只需在 `scut_project.json` 的 `hooks` 里填函数名 |

---

## 七、给维护者

- 脚本只用 **Python 标准库**，目标 **Python 3.7+**（低于此版本会在启动时直接给人话提示 + 一份 JSON，而不是抛语法错误）。
- 非直观的地方都有**中文注释解释「为什么」**，改之前请先读文件头的设计说明。
- `scut_symbols.py` 的回归测试在 `tests/test_symbols.py`，改动生成器后务必跑一遍。
