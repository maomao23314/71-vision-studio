# SCUT-71 Vision Studio

> 智能车视觉仿真环境 · VS Code 插件 · 装上就能用

你只写视觉算法，编译、喂图、计时、变量观察、可视化都由环境接过去。
算法代码还能原样拷进车载工程。

---

# 第一部分 · 给用户

## 装好之后，五步跑起来

1. 装插件（VSIX）。
2. `Ctrl+Shift+P` 输入 `SCUT-71` → **新建仿真工程** → 选一个空目录。
3. 把你的测试图放进工程的 `pic/1/`，命名 `1.bmp`、`2.bmp`…（也支持 `0.png` 起的编号）。
4. 点侧边栏工具栏最右边的 **⚙**，在「钩子函数 › 每帧处理函数」里填你的图像处理函数名。
5. 按 `Ctrl+Shift+B` 编译，再按 `→` 看下一张图。

本机没有编译器也没关系。第一次编译时插件会问你要不要下载一份精简版 LLVM-MinGW
（约 165 MB，只下一次）；PATH 上已经有 clang 就不会重复下载。

> **Python 3.7+ 需要你自己装**（插件不代下载）。构建脚本只依赖标准库，
> python.org / Anaconda 装哪个都行；装完在配置面板的「工具链 › Python 解释器路径」
> 里指过去即可。没有它编译脚本跑不起来。

> **变量面板不需要额外装任何东西。** 变量自动发现是纯 Python 读 `.debug_info`
> 的字节，不调用 `objdump` 之类的外部程序 —— 编译能过，面板就有内容。
> 老教程里那句"必须装 binutils 的 objdump"已经作废了。

> **代码补全建议装 `clangd`**（可选）。插件自己不会起语言服务，只会在「环境自检」里
> 告诉你找没找到它；想让补全和跳转更准，就装 clangd 扩展。不装不影响编译与仿真。

---

## 写你的算法

就是一个普通的 C 函数，不需要任何注册宏：

```c
/* code/camera.c */
#include "scut_sdk.h"

int g_threshold = 0;                                  /* 会被自动发现，面板里勾选即可看 */
unsigned char g_binary[SCUT_IMAGE_H][SCUT_IMAGE_W];    /* 结果图 */

void camera_init(void)                                 /* 填进「开机函数」，不计时 */
{
    /* 建查找表、清缓冲 */
}

void camera_process(void)                              /* 填进「每帧处理函数」★ 计时段 */
{
    int x, y;
    for (y = 0; y < SCUT_IMAGE_H; y++) {
        for (x = 0; x < SCUT_IMAGE_W; x++) {
            g_binary[y][x] = (mt9v03x_image[y][x] > g_threshold) ? 255 : 0;
        }
    }
}

void camera_draw(void)                                 /* 填进「后处理函数」，不计时 */
{
    SCUT_DrawPoint(10, 10, SCUT_COLOR_RED);
}
```

然后在配置面板里填：

| 设置项 | 填什么 |
|---|---|
| 图像处理函数 | `camera_process` |
| 初始化函数 | `camera_init` |
| 后处理函数 | `camera_draw`（每行一个，按顺序调用） |
| 结果图数组名 | `g_binary` |

输入图是环境提供的全局数组 `mt9v03x_image`，**地址恒定**，像在车上那样直接按名字读。
它声明在生成的 `scut_config.h` 里，你不用自己写 `extern`，也不该再定义一份 ——
多一份副本会让逆透视那类指针表失效。

结果图写在**你自己的**数组里，环境每帧逐像素搬到显示缓冲。刻意不换指针，理由同上。

三个函数必须是**非 static** 的 `void f(void)`。这不是额外限制：
车上 `main()` 也要调它们，本来就得如此。正因为要求一致，`code/` 可以原样搬上车。

### 为什么用户代码里没有 `SCUT_INIT` / `SCUT_FRAME`

调用关系属于宿主，不属于算法。车上 `main()` 里同样要按顺序调
`ImagePerspective_Init()` → `image_process()`，这些信息本来就写在宿主里。
环境把这件事也接了过去：注册信息存在工程的 `scut_project.json`，
构建时生成一个接线单元去调用你的函数。

---

## 画调试标注

标注画在覆盖层上，由调度器合成进输出图，所以是彩色的。
把绘图放在「后处理函数」里 —— 它不计入处理时间。
车上没有屏幕，绘图算进算法耗时会让你去优化一段车上根本不存在的代码。

### 四个绘图函数

| 函数 | 作用 |
|---|---|
| `SCUT_DrawPoint(x, y, color)` | 画一个像素 |
| `SCUT_DrawLine(x0, y0, x1, y1, color)` | 画直线 |
| `SCUT_DrawRect(x0, y0, x1, y1, color)` | 画空心矩形（四条边） |
| `SCUT_DrawText(x, y, color, fmt, ...)` | 画 ASCII 文字，用法同 `printf` |

坐标越界会自动忽略，不用自己判断。

`SCUT_DrawText` 只支持 ASCII（内置 8×8 字库）。别拿它显示读数，
要看数值请用 `SCUT_Log` 或变量面板。

### 预定义颜色（11 个）

```
SCUT_COLOR_BLACK    SCUT_COLOR_WHITE     SCUT_COLOR_RED      SCUT_COLOR_GREEN
SCUT_COLOR_BLUE     SCUT_COLOR_YELLOW    SCUT_COLOR_CYAN     SCUT_COLOR_MAGENTA
SCUT_COLOR_ORANGE   SCUT_COLOR_GRAY      SCUT_COLOR_LIGHTGRAY
```

挑几个高对比、彼此好区分的就够。

### 自建颜色

用 `SCUT_RGB(r, g, b)`，每个分量 0..255：

```c
scut_u32 my_orange = SCUT_RGB(255, 128, 0);
SCUT_DrawLine(0, 0, 10, 10, my_orange);

SCUT_DrawPoint(x, y, SCUT_RGB(g, g, g));   /* 灰度也用同一个宏 */
```

不要手写十六进制字面量。颜色内部是 `0x00BBGGRR`（跟 Windows `COLORREF` 一致，
方便老代码迁移），所以 `0xFF0000` 是**蓝色**不是红色，极容易记错。
一律用 `SCUT_RGB(r,g,b)` 或预定义名。

---

## 计时怎么读

| 阶段 | 何时调用 | 计时 |
|---|---|---|
| 初始化 | 开机一次 | 不计 |
| 图像处理 | 每帧 | 计 → `processUs`，这就是"算法耗时" |
| 后处理 | 每帧 | 不计（绘图/日志单独统计成 `drawUs`） |

绘图和日志不计时，是因为车上没有"画点给屏幕看"这件事 ——
`SCUT_Draw*` 和 `SCUT_Log` 在移植层里就是空实现。
把它算进处理时间，等于拿主机侧调试设施冒充车载算法。

**主要看周期数**（`cycles`）而不是微秒。周期数跨机器可比；
微秒是墙钟时间，换台电脑就没有参考意义。

---

## 变量面板

| 分组 | 来源 | 显示 |
|---|---|---|
| 主动暴露 | 代码里显式 `SCUT_Watch` 注册的（通常是结构体成员） | 排前面、蓝色高亮 |
| 自动捕获 | 构建时扫描调试信息发现的全部全局量（含 `static`） | 排后面、灰色 |

判据是客观的：运行期注册表里有、编译期清单里没有 → 主动暴露。不需要你额外标注。

勾选后不需要重新编译 —— 变量快照每帧全量发送，勾选只影响显示。

> 边界：从未被引用过的 `static` 变量会被编译器整个删掉，发现不了。
> 这与调试器的行为一致。

---

## 按钮与快捷键

侧边栏仿真视图的工具栏长这样：

![工具栏](docs/media/settings-button.png)

| 动作 | 键 | 说明 |
|---|---|---|
| 编译 | `Ctrl+Shift+B` | 编译前自动停掉运行中的仿真进程（否则 Windows 锁住 exe 会导致链接失败） |
| 调试 | 视图里的「调试」按钮 / `F5` | 起 lldb-dap 会话，可下断点、单步、看调用栈；不需要 `launch.json`。跑 1 帧就停，用的是与「运行」同一组图集 |
| 运行 | `F8`（视图内） | 连续跑 N 帧，不重启进程，算法状态保留 |
| 上一张 / 下一张 | `←` / `→` | 不重启进程，算法状态保留 |
| 跳到第 N 张 | 工具栏「跳到…」 | 图集大时比一张张点快 |
| 测速 | `F9` | 同一张图重复 N 次取平均周期数 |
| 停止 | `Shift+F5` | |
| 查看 `SCUT_Log` | — | 侧边栏「运行日志」折叠区，同时镜像到底部「SCUT-71 运行日志」输出通道（可搜索/复制） |

> 视图内的快捷键（`F8`/`←`/`→`/`F9`/`Shift+F5`）需要视图处于聚焦状态才生效。
> 命令面板里搜 `SCUT-71` 也能找到对应命令。

> `F5` 保持 VS Code 的标准含义（开始调试）。视图标题栏还有一枚「调试」图标，
> 它走插件自己的调试类型，不会和已装的 C/C++ 扩展抢 `F5`。

> `Ctrl+Shift+B` 被本插件占用为「编译仿真程序」，会覆盖 VS Code 默认的「运行生成任务」。
> 需要原来那个的话，在 `keybindings.json` 里改掉这条绑定。

---

## 配置放在哪

只有一个真值来源：工程根目录的 `scut_project.json`，由插件自己的配置面板维护。
它跟着工程走，能进 git、能发给同学。

`.scut/gen/*` 是构建脚本生成的契约头与接线单元，不要手改。

**改完立即生效**（运行期）：图集目录/后缀/起始编号、每帧重复次数、
「运行」连跑帧数、「测速」重复次数、工具链路径、Python 解释器、
是否自动下载工具链、是否自动发现变量。

**改完要重编译**（编译期）：图像宽高、输入/结果图数组名、三个钩子函数名。

图像尺寸之所以必须留在编译期：C 里数组大小必须是常量，
而算法里到处是 `int line[SCUT_IMAGE_H];`。这是语言的硬约束。

> 0.9.4 起不再使用 VS Code 的 `settings.json`。早期版本把配置拆成
> "工程 JSON + 用户设置"两处，结果互相覆盖 —— 工程里配的图集目录不生效，
> 而且不报错。现在配置不经过 VS Code 那套机制，也就没有"注册不上"这种失败模式。
>
> 代价说清楚：工具链是**本机环境**，跟着工程走意味着换机器要重填一次，
> 而且**没打开工程时读不到它**。需要"按机器的全局工具链"就用
> `SCUT71_TOOLCHAIN` 环境变量，不要再把配置拆成两处。

> 没有「编译模式」开关。优化等级是固定约定：用户代码恒为 `-g -O0`
> （断点不漂移、变量看得见），环境自身恒为 `-O2`。

---

## 已知边界

1. **中文标注不支持**：内置 8×8 ASCII 字库，非 ASCII 画占位方框。
2. **JPEG 不支持**：BMP + PNG（8 位、非交织、自带 inflate）。
3. **结构体字段名不可知**：不解析 DWARF 成员表，只能整体报大小。
   要看具体字段就用 `SCUT_Watch` 主动注册该成员。
4. **从未被引用的 static 发现不了**：被编译器删掉了。
5. **仿真 ≠ 真机性能**：用户代码恒为 `-O0`，所以 `process` 耗时会比真机（通常 `-O2`）偏大。
6. **阶段门控是防呆不是防护**：C 语言无法阻止直接访问全局数组。

---

## 出问题先做这两件事

```
SCUT-71: 环境自检          # 命令面板里执行，逐项报告工具链/工程结构/核心库
python tests/run_all_tests.py   # 跑一遍回归（15 个套件）
```

---

# 第二部分 · 给 AI / 维护者

> 改代码前先读 [`docs/架构设计.md`](docs/架构设计.md)（唯一权威说明）。
> 本文这部分只讲清**是什么、怎么接、怎么跑**；设计动机与踩坑记录在那份文档里。

## 一句话

把「用户算法不需要知道仿真环境存在」这件事做到极致：
用户写普通 C 函数，环境负责调用、喂图、计时、收集变量、呈现。

## 三层与依赖方向

```
① extension/        插件显示层（TypeScript + webview）      只管 UI
      ↕  scut_project.json  +  stdin/stdout JSON 协议
② core/ bind/ backends/ tools/   仿真环境层                喂图/计时/采集/呈现
      ↕  构建时生成的接线单元 (glue)
③ code/*.c          用户代码                               只有算法
```

依赖**单向**：①→②→③。用户代码不知道 ① ② 存在。

**「可移植」的准确定义**：只有 ③ 需要上车。① ② 是主机侧仿真设施，不上车 ——
所以 `core/` 里用 `QueryPerformanceCounter`、`scut_frame.c` 里带 PNG 解码器，
都不构成移植障碍。

## 各层接口

### ③ → ② 唯一契约：`core/include/scut_sdk.h`

用户仅需包含这一个头。它拉进的头文件链**零平台依赖**（只有 `<stddef.h>`），
这是"算法能原样上车"的机制保证。

| 分区 | 内容 |
|---|---|
| 移植契约 | `SCUT_GetInputImage`、`SCUT_OutImageSet`/`SetRGB`/`Get`、`SCUT_EnvCopyOutput` |
| 主机侧调试设施 | `SCUT_Draw*`、`SCUT_Log`、`SCUT_Watch` 及 `SCUT_WATCH_SCALAR`/`ARRAY` |
| 编译期契约 | `SCUT_IMAGE_W/H`、`SCUT_INPUT_ARRAY`（由 `scut_project.json` 生成） |

调试设施上车时给空实现即可 —— 车上本来就有 IPS 屏和串口，这两类调用的实现在车载工程里自然存在。

### ② 内部

| 模块 | 职责 |
|---|---|
| `bind/scut_bind.c` | **唯一**知道编译期尺寸的 TU；持有输入图、输出图、覆盖层三块缓冲 |
| `core/src/scut_sched.c` | 调度与计时；帧内顺序的唯一定义点 |
| `core/src/scut_registry.c` | 回调注册表（role + priority 排序，插入排序保证全序） |
| `core/src/scut_input.c` | 阶段门控、默认底图、结果图搬运 |
| `core/src/scut_draw.c` | 绘制到覆盖层；8×8 ASCII 字库 |
| `core/src/scut_frame.c` | BMP/PNG 解码、覆盖层合成（**唯一带文件 IO 的核心 TU**） |
| `core/src/scut_watch.c` | 变量观察表（定长 488 项，构造期注册） |
| `core/src/scut_log.c` | 日志环形缓冲（256 行 × 192 字节） |
| `backends/headless/` | 提供 `main()`；命令行解析、图集探测、帧 JSON 输出 |
| `tools/scut_build.py` | 构建编排、生成契约头与 glue、并行编译 |
| `tools/scut_dwarf.py` | 读目标文件里的 DWARF（纯标准库，PE/COFF + ELF） |
| `tools/scut_symbols.py` | 变量发现：DWARF 类型 → 注册代码 + 变量清单 |

### ① ↔ ② 协议

配置：工程根 `scut_project.json`（唯一真值）。
帧数据：后端 stdout 每帧一行 JSON，`timing` 内嵌；图像走临时目录的 PPM(P6)。
日志：C 侧环形缓冲 → 后端每帧抽干 → **stderr**（保持 stdout 是纯 JSON 通道）。

关键点：**帧行必须先于变量行判断**（帧行有 `frame` 字段）。顺序反了会导致帧被变量解析器抢走，
表现是"图片全没了"。

## 帧内顺序（契约，不可重排）

```c
scut_draw_clear_output_written();        // 新一帧的记账
for (r = 0; r < repeat; r++)
    scut_registry_invoke(SCUT_ROLE_PROCESS);   // ★ 计时 → process_us
// 发布 process_us（必须在 sink 之前，否则后端的计时慢一拍）
if (!scut_draw_output_written())
    scut_env_seed_output_from_input();   // 默认底图：输入 → 输出
scut_input_set_phase(SCUT_PHASE_DRAW);
scut_registry_invoke(SCUT_ROLE_DRAW);    // 不计时 → draw_us（绘图 + 日志）
scut_composite_overlay(...);             // 覆盖层 → 输出图
scut_draw_clear_overlay();               // 必须在合成之后
scut_input_set_phase(SCUT_PHASE_IDLE);
s_sink(s_sink_user);                     // 后端抓帧（不计入任何指标）
```

三个阶段：`IDLE` / `PROCESS` / `DRAW`。**只有 PROCESS 计时**，
绘制与日志都不计入 —— 否则等于拿主机侧调试设施冒充车载算法。

## 构建流程

```
scut_project.json
   ├─→ .scut/gen/scut_config.h     编译期契约（尺寸、输入数组名）
   └─→ .scut/gen/scut_env_glue.c   接线单元（调用用户的三个钩子）
用户每个 .c：
   [1] clang -g -O0 -gdwarf-4 -c  → 探针 .o
   [2] scut_symbols.py            → 包装单元 .c（#include 用户源码 + constructor 注册）
   [3] clang -g -O0 -c 包装单元    → 真正的 .o
链接：核心库 .a（-O2）+ bind（-O2）+ 后端（-O2）+ 用户 .o（-O0）+ glue（-O2）
```

包装单元是唯一能触及 `static` 变量的办法（`#include` 展开源码后注册）。
注册必须是 `constructor`，否则没人调用它，表现是"变量面板永远是空的"。

**核心库是源码分发、在用户机器上现编**，不预编译 —— 预编译的 `.a` 与编译器/ABI/CRT 绑死，
不匹配时是一堆指不到病根的链接错误。

## 关键约束与理由

| 约束 | 为什么 |
|---|---|
| 输入图地址恒定 | 逆透视指针表开机建一次长期使用；换缓冲会让指针集体悬空 |
| 结果图深拷贝 | 同上 |
| 尺寸是编译期常量 | C 数组大小必须是常量，算法里到处是 `int x[SCUT_IMAGE_H]` |
| 三个钩子非 static | glue 是独立 TU，只能调外部链接函数（车载 `main` 同样要求） |
| 合成由调度器做 | 后端各自记得合成 → 漏一个后端就标注静默消失 |
| 覆盖层哨兵为 `0xFFFFFFFF` | `0` 是合法黑色；用 0 清屏会把整幅图涂黑 |
| `snprintf` 返回值不是写入量 | 它"本该写入的长度"，可大于缓冲。全项目规矩见 `scut_types.h` |

## 测试

```
python tests/run_all_tests.py                        # 15 个套件
python tests/run_all_tests.py --toolchain <根目录>    # 工具链不在默认位置时
python tests/run_all_tests.py --also-cn              # 额外跑一遍中文路径端到端
```

在终端里直接跑构建脚本时，`Ctrl+C` 会走一条"已中断"的收尾分支；
但在 VS Code 里点取消，插件发的是终止信号，脚本可能来不及打印任何提示
就被结束——这不影响正确性：`.scut` 里的目标是先写临时文件再原子替换的，
重新构建即可。

工具链定位顺序（实现在 `tests/toolchain.py`，与产品代码 `extension/src/toolchain.ts` 一致）：
`--toolchain` → `SCUT71_TOOLCHAIN` 环境变量 → `PATH` 上的 clang →（仅测试用）常见位置兜底。
找不到时给出可执行的提示而不是后续一堆莫名报错。

**测试材料全部在仓库内**：`tests/fixtures/pic/1`（36 张 BMP）。
它们不依赖任何仓库外的目录，也不需要你机器上有特定的工程。

### 各套件守什么

| 套件 | 文件 | 守的是 |
|---|---|---|
| e2e | `test_e2e_pipeline.py` | **设计理念本身**：模板建工程 → 零注册 → 构建 → 运行 → 输出图非黑/计时非零/日志可达 |
| glue-edges | `test_glue_edges.py` | 接线单元三条"静默算错"（同函数填两阶段、`--no-watch` 重复定义、结果图指向标量） |
| outimage | `test_outimage.py` | 算法直接写输出图 × 默认底图，**两侧都测**（只测一侧的话条件写反也照样绿） |
| cleanup | `test_cleanup.py` | 死代码与过时注释**双向**守护（防回潮 + 防误删） |
| webview-js | `test_webview_js.py` | 前端在最小 DOM 桩里**真的执行**（曾抓到 `renderStructDetail` 从未定义） |
| symbols | `test_symbols.py` | DWARF 符号发现（clang 主 + gcc 副，跨工具链） |
| json | `check_json_protocol.py` | 帧 JSON 的必需字段齐全 |
| mem-safety | `test_mem_safety.py` | ASan + 金丝雀抓栈越界（曾抓到 `json_escape` 越界写、`scut_watch_read` 越界读） |
| settings | `test_extension_settings.py` | 配置一致性：TS 的 `ProjectConfig` 与 Python 的 `DEFAULT_CONFIG` 字段逐字对齐 |
| extension | `extension_smoke.js` | 插件纯逻辑（协议解析 / PPM / 诊断）—— 不依赖 VS Code |
| session | `run_frames.js` | 运行/测速/翻页的 **ACK 背压链路**（曾抓到 `runFrames(N)` 多跑一帧） |
| manual-vars | `manual_vars.js` | 主动暴露变量：源码扫描 → 分组 → 恒显示 |
| dap | `dap_smoke.js` | 真实 lldb-dap DAP 会话（缺 lldb-dap 时**明确跳过**，不判失败） |
| webview | `webview_render.js` | 真实 Chromium 渲染真实帧数据并截图 |
| cn-e2e | `extension_smoke.js` | 同上，但在含中文与空格的工程路径上 |

判据要精确到"代码行"而非"文件里出现过关键词"——本项目多次因判据太粗而误报。

打包：

```
cd extension && npx vsce package --no-dependencies --allow-missing-repository
```

`prepackage` 会自动 `sync-sdk`（把仓库 SDK 同步进 `extension/sdk/`）再编译。
**改了 `core/ bind/ backends/ tools/` 必须同步**，否则打出的包带旧核心，症状是静默黑屏。

## 文档

- **[docs/架构设计.md](docs/架构设计.md)** —— 架构基线 + 逐轮修正记录，改代码前先读
- [docs/改动流水账.md](docs/改动流水账.md) —— 逐轮追加的流水账（含踩坑记录，新旧内容都有价值）

## 许可

GPL-3.0（沿用原仓库）。LLVM 相关组件为 Apache-2.0 WITH LLVM-exception。
