#!/usr/bin/env python3
"""构建脚本：--init-fn/--frame-fn/--post-fn 参数 + glue.c 生成。"""
import io

PY = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio\tools\scut_build.py"

with io.open(PY, "r", encoding="utf-8") as f:
    py = f.read()

# ---- 1) 参数 ----
if '"--init-fn"' not in py:
    anchor = '    parser.add_argument("--no-watch"'
    if anchor not in py:
        raise SystemExit("!! args anchor not found")
    args_add = '''    parser.add_argument("--init-fn", default="",
                        help="初始化函数名，逗号/换行分隔（GUI 设置传入）")
    parser.add_argument("--frame-fn", default="",
                        help="每帧处理函数名，逗号/换行分隔")
    parser.add_argument("--post-fn", default="",
                        help="后处理函数名，逗号/换行分隔")
'''
    py = py.replace(anchor, args_add + anchor, 1)
    print("OK args added")

# ---- 2) glue 生成（插在 include_dirs 定义之后）----
if "scut_env_glue.c" not in py:
    anchor2 = "    objcopy = _find_objcopy(tc.cc)"
    if anchor2 not in py:
        raise SystemExit("!! glue anchor not found")
    glue = '''    # ------------------------------------------------------------------
    # GUI 三函数注册：生成 glue.c 并编译
    #
    # 用户原话："初始化、图片处理、后处理函数都在用户代码里，不应该有，
    #   删掉！用户代码要直接能移植的。"
    # → 钩子在插件设置里指定（scut71.initFunctions/frameFunctions/postFunctions），
    #   构建时扩展把它们以 --init-fn/--frame-fn/--post-fn 传进来，
    #   这里生成一个包装源文件，定义环境固定入口 scut_env_init/frame/post，
    #   按顺序调用户函数。用户 code/ 里【零】SCUT_ 痕迹。
    # ------------------------------------------------------------------
    def _split_names(s):
        out = []
        for tok in re.split(r"[,\\n;]", s or ""):
            tok = tok.split("//")[0].strip()
            if tok:
                out.append(tok)
        return out

    init_names = _split_names(args.init_fn)
    frame_names = _split_names(args.frame_fn)
    post_names = _split_names(args.post_fn)

    if not (init_names or frame_names or post_names):
        reporter.error(
            "没有配置任何环境钩子。\\n"
            "    下一步：VS Code 设置 → 搜索 \\"SCUT-71\\"，在\\n"
            "    「初始化函数」「图像处理函数」「后处理函数」里填你代码里的函数名\\n"
            "    （每行一个）。用户代码里【不需要】写任何 SCUT_INIT/SCUT_FRAME ——\\n"
            "    那样代码才能保持与车载工程一致、直接可移植。")
        return finish(2)

    glue_lines = [
        "/* 本文件由 SCUT-71 构建脚本生成于 .scut/gen/ —— 不要手工编辑。",
        " * 作用：把插件设置里指定的用户函数接进环境的三个固定入口。",
        " * 用户 code/ 里没有任何 SCUT_ 痕迹，保持直接可移植。 */",
        '#include "scut_sdk.h"',
        "",
    ]
    for n in dict.fromkeys(init_names + frame_names + post_names):
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
    glue_lines.append("")
    glue_lines.append('/* 环境注册（内部宏，用户不接触） */')
    glue_lines.append('#include "scut_registry_internal.h"')
    glue_lines.append('SCUT_REGISTER(SCUT_ROLE_INIT,    100, "env_init",  scut_env_init)')
    glue_lines.append('SCUT_REGISTER(SCUT_ROLE_PROCESS, 100, "env_frame", scut_env_frame)')
    glue_lines.append('SCUT_REGISTER(SCUT_ROLE_REPORT,  100, "env_post",  scut_env_post)')
    glue_lines.append("")

    glue_path = os.path.join(proj.gen_dir, "scut_env_glue.c")
    with open(glue_path, "w", encoding="utf-8") as gf:
        gf.write("\\n".join(glue_lines))
    glue_obj = os.path.join(proj.obj_dir, "scut_env_glue.o")
    rc = run_cmd([tc.cc, "-std=c11", "-O0", "-Wall", "-Wextra", "-c",
                  glue_path, "-o", glue_obj] + include_dirs)
    if rc != 0:
        reporter.error(
            "环境接线（glue）编译失败 —— 通常是设置里的函数名与代码不一致。\\n"
            "    检查：设置里填的名字在 code/ 里存在，签名是 void f(void)。")
        return finish(1)
    glue_objs = [glue_obj]

'''
    py = py.replace(anchor2, glue + anchor2, 1)
    print("OK glue generation added")

with io.open(PY, "w", encoding="utf-8", newline="") as f:
    f.write(py)
print("DONE")
