#!/usr/bin/env python3
"""
★ GUI 三函数注册（用户本轮核心需求）：
  用户代码里不再写任何 SCUT_INIT/SCUT_FRAME/SCUT_POST —— 代码必须保持
  【直接可移植】（车载工程原样拷进来就能用）。
  三个钩子在插件的设置里指定，支持两种写法：
    - 多行文本：一小段 C 代码，如 "my_init(); my_init2();"
    - 逐条添加：多行文本天然就是逐行的
  运行时环境按这些名字生成包装 TU（与现有 scut_symbols 的 wrapper 同机制），
  顺序执行。

实现路径（复用现有 wrapper 机制，最小侵入）：
  · 设置项 scut71.initCode / frameCode / postCode（多行 C 文本）
  · scut_build.py 接受 --init-fn / --frame-fn / --post-fn（逗号分隔多个名字）
  · 构建时生成 glue.c：包含用户 code/ 的头，定义三个固定入口
    scut_env_init/_frame/_post，按顺序调用户函数；环境注册的是这三个入口
  · 模板 camera.c 里的 SCUT_INIT 等【全部删掉】—— 用户代码零环境痕迹
"""
import io, re

ROOT = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio"
PKG  = ROOT + r"\extension\package.json"
PY   = ROOT + r"\tools\scut_build.py"

# ---------- 1) 设置项 ----------
with io.open(PKG, "r", encoding="utf-8") as f:
    raw = f.read()
if len(raw) > 0 and raw[0] == '\ufeff': raw = raw[1:]
import json as _json
j = _json.loads(raw)
props = j["contributes"]["configuration"]["properties"]

props["scut71.initFunctions"] = {
    "type": "string", "default": "",
    "editPresentation": "multilineText",
    "markdownDescription": (
        "**初始化函数**（启动时调用一次，不计时）。\n\n"
        "填用户代码里的函数名，每行一个，按顺序执行。例如：\n"
        "```\\nmy_init\\nPerspective_Init\\n```\n"
        "留空 = 没有初始化钩子。这些注册写在【插件设置】里而不是用户代码里，"
        "这样用户代码保持与车载工程完全一致、直接可移植。")
}
props["scut71.frameFunctions"] = {
    "type": "string", "default": "",
    "editPresentation": "multilineText",
    "markdownDescription": (
        "**图像处理函数**（每帧调用，★ 计时段 —— 测速测的就是它）。\n\n"
        "填用户代码里的函数名，每行一个，按顺序执行。例如：\n"
        "```\\nimage_process\\n```\n"
        "留空 = 没有处理钩子（画面只会显示输入图）。")
}
props["scut71.postFunctions"] = {
    "type": "string", "default": "",
    "editPresentation": "multilineText",
    "markdownDescription": (
        "**后处理函数**（每帧调用一次，不计时：覆盖层、日志等观测用）。\n\n"
        "填用户代码里的函数名，每行一个。例如：\n"
        "```\\nmy_draw\\nmy_report\\n```")
}

with io.open(PKG, "w", encoding="utf-8", newline="") as f:
    f.write(_json.dumps(j, ensure_ascii=False, indent=2) + "\n")
print("OK 设置项已加（initFunctions / frameFunctions / postFunctions）")

# ---------- 2) 构建脚本：--init-fn/--frame-fn/--post-fn + glue.c ----------
with io.open(PY, "r", encoding="utf-8") as f:
    py = f.read()

# 2a) 参数
if "--init-fn" not in py:
    py = py.replace(
        '    parser.add_argument("--no-watch"',
        '    parser.add_argument("--init-fn", default="",\n'
        '                        help="初始化函数名，逗号分隔（GUI 设置项传入）")\n'
        '    parser.add_argument("--frame-fn", default="",\n'
        '                        help="每帧处理函数名，逗号分隔")\n'
        '    parser.add_argument("--post-fn", default="",\n'
        '                        help="后处理函数名，逗号分隔")\n'
        '    parser.add_argument("--no-watch"')

# 2b) glue.c 生成：在链接前生成并编译
anchor = "    # objcopy 鐢ㄤ簬鎶婃帰閽?.o 鐨?DWARF"
if "--init-fn" not in py:
    raise SystemExit("anchor not found")

GLUE = r'''
    # ---- GUI 三函数注册：生成 glue.c 并编译 ------------------------------
    # 用户原话："前面提到的初始化、图片处理、后处理函数都在用户代码里，
    #   不应该有，删掉！用户代码要直接能移植的" —— 所以钩子在插件设置里
    #   指定（scut71.initFunctions 等），构建时在这里生成包装源文件。
    #
    # 为什么生成 C 而不是命令行宏：函数可能重载/重命名/带参（无参回调），
    # C 代码的表达能力最直接，也和用户在设置里写的"一小段 C 代码"一致。
    def _split_names(s: str) -> List[str]:
        # 支持逗号/换行/分号分隔；去空；去 // 注释
        out = []
        for tok in re.split(r"[,\n;]", s or ""):
            tok = tok.split("//")[0].strip()
            if tok:
                out.append(tok)
        return out

    init_names  = _split_names(args.init_fn)
    frame_names = _split_names(args.frame_fn)
    post_names  = _split_names(args.post_fn)

    if not (init_names or frame_names or post_names):
        reporter.error(
            "没有配置任何环境钩子。\n"
            "    下一步：打开 VS Code 设置，搜索 \"SCUT-71\"，在\n"
    "        「初始化函数」「图像处理函数」「后处理函数」里填你代码里的函数名\n"
    "        （每行一个）。用户代码里【不需要】写任何 SCUT_INIT/SCUT_FRAME ——\n"
    "        那样代码才能保持与车载工程一致、直接可移植。")
        return finish(2)

    glue_lines = [
        "/* 本文件由 SCUT-71 构建脚本自动生成 —— 不要手工编辑，也不要提交进版本库。",
        " * 内容：把插件设置里指定的用户函数接进环境的三个固定入口。",
        " * 用户的 code/ 里【没有】任何 SCUT_ 痕迹，保持直接可移植。 */",
        '#include "scut_sdk.h"',
        "",
    ]
    # 声明用户函数（无参回调原型）
    all_names = list(dict.fromkeys(init_names + frame_names + post_names))
    for n in all_names:
        glue_lines.append("void %s(void);" % n)
    glue_lines.append("")
    glue_lines.append("void scut_env_init(void) {")
    for n in init_names:
        glue_lines.append("    %s();" % n)
    glue_lines.append("}")
    glue_lines.append("void scut_env_frame(void) {")
    for n in frame_names:
        glue_lines.append("    %s();" % n)
    glue_lines.append("}")
    glue_lines.append("void scut_env_post(void) {")
    for n in post_names:
        glue_lines.append("    %s();" % n)
    glue_lines.append("}")
    glue_lines.append("/* 环境注册（内部宏，用户不接触） */")
    glue_lines.append('#include "scut_registry_internal.h"')
    glue_lines.append('SCUT_REGISTER(SCUT_ROLE_INIT,    100, "env_init",  scut_env_init)')
    glue_lines.append('SCUT_REGISTER(SCUT_ROLE_PROCESS, 100, "env_frame", scut_env_frame)')
    glue_lines.append('SCUT_REGISTER(SCUT_ROLE_REPORT,  100, "env_post",  scut_env_post)')
    glue_lines.append("")

    glue_path = os.path.join(proj.gen_dir, "scut_env_glue.c")
    with open(glue_path, "w", encoding="utf-8") as gf:
        gf.write("\n".join(glue_lines))
    glue_obj = os.path.join(proj.obj_dir, "scut_env_glue.o")
    rc = run_cmd([tc.cc, "-std=c11", "-O0", "-Wall", "-Wextra", "-c",
                  glue_path, "-o", glue_obj]
                 + include_dirs)
    if rc != 0:
        reporter.error(
            "环境接线（glue）编译失败 —— 通常是设置里的函数名与代码不一致。\n"
            "    检查：设置里填的名字在 code/ 里存在且是 void f(void) 签名。")
        return finish(1)
    link_extra = [glue_obj]
'''
py = py.replace(anchor, GLUE + "\n" + anchor)

with io.open(PY, "w", encoding="utf-8", newline="") as f:
    f.write(py)
print("OK 构建脚本：glue 生成已加")

print("DONE part4")
