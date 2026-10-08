/**
 * projectconfig.ts —— 工程配置（scut_project.json）的读写与 UI 编辑。
 *
 * 设计理念对照：
 *   · 上手即用     → 用户不需要知道任何文件格式，全部走 VS Code 设置界面
 *   · 松耦合       → 本文件是「配置」的唯一真值来源；构建脚本只读它
 *   · 可移植       → 用户代码里不留注册信息，钩子函数名存在这里
 *
 * ★★ 为什么配置放在工程的 JSON 里，而不是 VS Code 的 settings.json ★★
 *
 *   两者都"能被 UI 编辑"，但生命周期完全不同：
 *
 *     VS Code 用户设置  跟着【这台电脑 / 这个用户】走。
 *                        换台机器、发给同学、或者重装 VS Code，
 *                        配置全丢 —— 而配置里有"哪个函数是处理函数"
 *                        这种【工程固有信息】，丢了工程就跑不起来。
 *
 *     工程内的 JSON     跟着【这个工程】走，可以进 git，
 *                        换机器只要拷工程目录即可。这才是工程配置该待的地方。
 *
 *   VS Code 的用户设置里只留"这台机器的环境"类选项（工具链路径之类）。
 *
 * ★ 写入策略：读-改-写，保留用户手写的未知字段。
 *   直接用 JSON.stringify 整体覆盖会把用户加的注释性字段抹掉，
 *   而"我不知道的字段"可能是他自己加的备注 —— 抹掉别人的东西很失礼，
 *   而且不可恢复。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** 工程配置文件名（必须与 tools/scut_build.py 的 PROJECT_CONFIG_NAME 一致）。 */
export const CONFIG_FILENAME = 'scut_project.json';

/**
 * 工程配置。
 *
 * ★ 字段名必须与 tools/scut_build.py 的 DEFAULT_CONFIG 逐字一致 ——
 *   两边是同一份数据的两个视图，改名要同时改两处。
 */
export interface ProjectConfig {
    image: {
        /** 图像宽度（像素）。★ 编译期契约，改了要重编译。 */
        width: number;
        /** 图像高度（像素）。 */
        height: number;
    };
    /**
     * 输入图像数组名。
     *
     * 环境会定义一个【同名同形状、地址恒定】的全局数组，
     * 用户算法像在车上那样直接按名字访问它。
     * 默认 mt9v03x_image 是逐飞等主流车载库的惯例命名。
     */
    inputArray: string;
    /**
     * 结果图数组名（用户代码里的那个数组）。
     *
     * 留空 = 画面显示输入图本身。
     * 填了 = 每帧把它深拷贝到环境的输出图并显示。
     */
    outputArray: string;
    /**
     * 三个阶段的钩子函数名，按顺序执行。
     *
     * ★ 这些函数必须在用户代码里【非 static】（有外部链接），
     *   因为环境是另一个编译单元去调用它们。这恰好也是车载工程
     *   main() 对它们的要求，所以不是额外限制。
     */
    hooks: {
        /** 开机一次，不计时。典型：建查找表、清缓冲。 */
        init: string[];
        /** 每帧调用，★ 计时段。典型：图像处理主体。 */
        frame: string[];
        /** 每帧调用，不计时。典型：画标注、打日志。 */
        post: string[];
    };
    /** 测试图集（运行期设置，改完立即生效，不需要重编译）。 */
    pic: {
        dir: string;
        ext: string;
        start: number;
    };
}

/** 默认配置。新建工程或文件缺失时用它。 */
export function defaultConfig(): ProjectConfig {
    return {
        image: { width: 188, height: 120 },
        inputArray: 'mt9v03x_image',
        outputArray: '',
        hooks: { init: [], frame: [], post: [] },
        pic: { dir: '', ext: '', start: 1 },
    };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
    return (typeof v === 'object' && v !== null && !Array.isArray(v))
        ? v as Record<string, unknown>
        : undefined;
}

function asStringArray(v: unknown): string[] {
    if (Array.isArray(v)) {
        return v.filter((x): x is string => typeof x === 'string');
    }
    // 容忍手写成 "a, b" 或 "a\nb" 的字符串
    if (typeof v === 'string') {
        return v.split(/[\n,;]/).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    return [];
}

function asInt(v: unknown, fallback: number): number {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * 把任意 JSON 归一化成 ProjectConfig。
 *
 * ★ 为什么每一步都做类型检查而不是直接 as ProjectConfig：
 *   这个文件用户可能手改坏（少个括号、把数字写成字符串）。
 *   归一化之后，坏字段退回默认值，好字段照常生效 ——
 *   比"整个配置读不出来"的体验好得多，也让错误提示能指到具体字段。
 */
export function normalizeConfig(raw: unknown): ProjectConfig {
    const d = defaultConfig();
    const root = asRecord(raw);
    if (!root) {
        return d;
    }
    const img = asRecord(root.image) ?? {};
    const hooks = asRecord(root.hooks) ?? {};
    const pic = asRecord(root.pic) ?? {};

    const str = (v: unknown, fb: string): string =>
        (typeof v === 'string' ? v.trim() : fb);

    return {
        image: {
            width: asInt(img.width, d.image.width),
            height: asInt(img.height, d.image.height),
        },
        inputArray: str(root.inputArray, d.inputArray) || d.inputArray,
        outputArray: str(root.outputArray, ''),
        hooks: {
            init: asStringArray(hooks.init),
            frame: asStringArray(hooks.frame),
            post: asStringArray(hooks.post),
        },
        pic: {
            dir: str(pic.dir, ''),
            ext: str(pic.ext, ''),
            start: asInt(pic.start, 1),
        },
    };
}

/** 配置文件的绝对路径。 */
export function configPath(projectRoot: string): string {
    return path.join(projectRoot, CONFIG_FILENAME);
}

/**
 * 读取工程配置。
 *
 * 文件不存在【不是错误】：返回 undefined，调用方据此走"首次配置"流程
 * （提示用户填钩子函数）。把"没配置"当成错误会让新工程一打开就报红。
 */
export function readConfig(projectRoot: string): { config?: ProjectConfig; error?: string } {
    const p = configPath(projectRoot);
    if (!fs.existsSync(p)) {
        return {};
    }
    try {
        const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
        return { config: normalizeConfig(JSON.parse(text)) };
    } catch (e) {
        return {
            error: `${CONFIG_FILENAME} 解析失败：${e instanceof Error ? e.message : String(e)}\n`
                + '    这个文件由设置界面维护；若手改坏了，'
                + '删掉它再重新打开设置界面即可（会重建一份默认配置）。',
        };
    }
}

/**
 * 写入工程配置（读-改-写，保留未知字段）。
 *
 * ★ 原子写：先写临时文件再 rename。
 *   构建脚本随时可能读这个文件，读到半截 JSON 会直接报解析失败。
 */
export function writeConfig(projectRoot: string, cfg: ProjectConfig): void {
    const p = configPath(projectRoot);
    let merged: Record<string, unknown> = {};
    if (fs.existsSync(p)) {
        try {
            merged = asRecord(JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))) ?? {};
        } catch {
            merged = {};   // 原文件坏了：以本次写入为准覆盖它
        }
    }
    // 逐块合并，保留 merged 里的未知键
    merged.image = { ...(asRecord(merged.image) ?? {}), ...cfg.image };
    merged.hooks = { ...(asRecord(merged.hooks) ?? {}), ...cfg.hooks };
    merged.pic = { ...(asRecord(merged.pic) ?? {}), ...cfg.pic };
    merged.inputArray = cfg.inputArray;
    merged.outputArray = cfg.outputArray;

    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
}

/* ==========================================================================
 *  设置界面的字段定义
 *
 *  用 VS Code 的 settings.json 作为「编辑 UI」——它自带多行文本框、
 *  数字校验、按工程覆盖等功能，而且用户已经很熟悉。
 *
 *  ★ 为什么走 workspace 级设置而不是自己画一个 webview 表单：
 *    自画表单要处理校验、保存、撤销、多根工作区……这些 VS Code 已经做好了。
 *    我们只需要把 workspace 设置当成"这个工程的配置草稿"，
 *    变更时落盘到 scut_project.json。
 *
 *  ★ 键名与 ProjectConfig 的对应关系集中在下面这一个映射表里，
 *    加字段只需要改这里 + ProjectConfig。
 * ========================================================================== */

const NS = 'scut71';

/** 把配置写进 VS Code 的 workspace 设置（作为编辑界面）。 */
export async function pushConfigToSettings(cfg: ProjectConfig): Promise<void> {
    const c = vscode.workspace.getConfiguration(NS);
    const t = vscode.ConfigurationTarget.Workspace;
    await c.update('imageWidth', cfg.image.width, t);
    await c.update('imageHeight', cfg.image.height, t);
    await c.update('inputArray', cfg.inputArray, t);
    await c.update('outputArray', cfg.outputArray, t);
    await c.update('initFunctions', cfg.hooks.init.join('\n'), t);
    await c.update('frameFunctions', cfg.hooks.frame.join('\n'), t);
    await c.update('postFunctions', cfg.hooks.post.join('\n'), t);
}

/** 从 VS Code 的 workspace 设置读出配置。 */
export function pullConfigFromSettings(): ProjectConfig {
    const c = vscode.workspace.getConfiguration(NS);
    return normalizeConfig({
        image: {
            width: c.get<number>('imageWidth', 188),
            height: c.get<number>('imageHeight', 120),
        },
        inputArray: c.get<string>('inputArray', 'mt9v03x_image'),
        outputArray: c.get<string>('outputArray', ''),
        hooks: {
            init: c.get<string>('initFunctions', ''),
            frame: c.get<string>('frameFunctions', ''),
            post: c.get<string>('postFunctions', ''),
        },
    });
}

/** 判断设置里是否已经填过钩子（用来自动决定要不要弹首次配置引导）。 */
export function hasHooks(cfg: ProjectConfig): boolean {
    return cfg.hooks.frame.length > 0 || cfg.hooks.init.length > 0;
}
