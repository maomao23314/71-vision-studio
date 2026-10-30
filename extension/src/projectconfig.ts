/**
 * projectconfig.ts —— 工程配置（scut_project.json）的读写与编辑。
 *
 * 设计理念对照：
 *   · 上手即用     → 用户不需要知道任何文件格式，插件的设置面板维护它
 *   · 松耦合       → 本文件是「配置」的唯一真值来源；构建脚本只读它
 *   · 可移植       → 用户代码里不留注册信息，钩子函数名存在这里
 *
 * ★★ 为什么配置全部放在工程 JSON 里，而不是 VS Code 的 settings.json ★★
 *
 *   0.9.4 之前有两处真值：settings.json 的 scut71.* 和本文件。
 *   两个都保留着，结果互相覆盖 —— project.ts 里写的是
 *       fromSettings ?? fromProjectConfig
 *   也就是【设置页压过工程配置】。于是工程 JSON 里配了图集目录
 *   却不生效，不报错，只是"配了没用"，排查极难。
 *
 *   更要命的是 VS Code 那套 contributes.configuration 有真实缺陷：
 *   它把 "scut71.toolchain": {"type":"object","properties":{...}}
 *   注册成【一个名叫 scut71.toolchain 的对象型设置】，
 *   内层 properties 只是 JSON Schema，【不是注册项】。后果：
 *       cfg.get('path')      读不到 → 静默返回默认值
 *       cfg.update('path')   直接抛「没有注册配置 scut71.toolchain.path」
 *   用户为了这个问题排查了很久，重装了 VS Code。
 *
 *   所以现在：settings.json 不再参与，全部搬到这里。
 *   工程配置跟着工程走，能进 git、发给同学、换机器不丢；
 *   用户打开 scut_project.json 就能看到全部配置，所见即所得。
 *
 *   唯一留在 settings.json 的是 VS Code 自己的设置（如主题、字体），
 *   与本插件无关。
 *
 * ★ 写入策略：读-改-写，保留用户手写的未知字段。
 *   直接用 JSON.stringify 整体覆盖会把用户加的注释性字段抹掉，
 *   而"我不知道的字段"可能是他自己加的备注 —— 抹掉别人的东西很失礼，
 *   而且不可恢复。
 */

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
    /** 测试图集。dir 空 = 用工程下的 pic/；ext 空 = 后端按实际文件探测。 */
    pic: {
        dir: string;
        ext: string;
        /** 图集起始编号，允许 0（后端会自己夹回合法值）。 */
        start: number;
    };
    /** 运行期行为。改完立即生效，不需要重新编译。 */
    run: {
        /** 每帧把算法跑几遍取平均（>1 时结果更稳，耗时也成倍）。 */
        processRepeat: number;
        /* 这里原本还有 runFrames（「运行」连着跑几帧），已随该功能删除；
         * 老工程里残留的这个键由 DEPRECATED_KEYS 负责清掉。
         * 来龙去脉见 docs/AI交接.md「已删除的概念」。 */
        /** 「测速」按钮对同一张图重复几遍取平均。 */
        benchRepeat: number;
    };
    // ★ 这里【故意】没有旧的 view 段 ★
    //   0.9.4 曾加了 showTiming / showVariables / showLog / pickPersist
    //   四项，但全项目没有任何代码读取它们 —— 面板一直按自己的方式显示。
    //   留着就是骗人的死界面：用户勾了「不显示日志」，日志照旧出现，
    //   于是反过来怀疑"是不是我用的方式不对"。
    //   勾选变量的持久化也已由面板自己的 setState 完成，
    //   不需要再在这里存一份 —— 两份数据就是两个真值。
    //
    //   教训：把字段名写进 UI 很容易，难的是确认有人真的读它。
    //   ★ 后来加过一版"要不要显示图片2"的开关，用户一句话又把它删了：
    //     「不要选择开启」—— 两栏就摆在那里，开合由画面标题控制，
    //     配置里不该出现第二个开关。这条和上面 view 段是同一类教训。
    //
    /** 本机工具链。path 空 = 依次探测环境变量 → 已下载的目录 → PATH。 */
    toolchain: {
        /** 工具链根目录（里面应有 bin/clang.exe）。 */
        path: string;
        /**
         * 跑构建脚本的 Python 解释器。
         *
         * ★ 只要求 3.7+，【不依赖任何第三方库】——
         *   scut_build.py / scut_symbols.py 的 import 全部是标准库
         *   （argparse/json/re/subprocess/typing…，逐个核对过），
         *   所以 conda、python.org、Windows 商店版都能用。
         *
         * 留空 = 自动探测。机器上装了多个 Python 时探测可能挑中
         * 旧的那个（实测发生过：`py -3` 反查到 3.6.2），所以装了
         * 多个的话建议在这里写死。
         */
        pythonPath: string;
        // ★ 没有 autoDownload 字段：要不要下载由弹窗当场问，不再另存一个开关。
        /** 编译时自动发现全局变量（关闭可加快构建，但变量面板会是空的）。 */
        autoWatch: boolean;
        /**
         * 变量名黑名单（逗号分隔）。这些全局量不进变量面板。留空 = 不排除。
         *
         * ★ 用途：算法里常有体积大又不想看的缓冲（整幅中间图之类），
         *   它们在面板里占位置、还容易被误勾选。
         * ★ 与 watchMaxElems 的区别：本项按【名字】排除，
         *   那一项按【元素数】排除。要两个都限就都配上。
         */
        watchExclude: string;
        /**
         * 只把元素数 ≤ N 的变量放进面板（0 = 不限制）。
         *
         * ★ 与 defaultSelected 的区别（别混）：
         *   defaultSelected 是"默认不勾选"—— 变量仍在列表里，用户想看自己勾。
         *   本项是"根本不出现在列表里"—— 从清单生成阶段就过滤掉。
         *   所以它适合"我确定这些大缓冲这辈子都不看"的场景。
         */
        watchMaxElems: number;
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
        run: { processRepeat: 1, benchRepeat: 1000 },
        toolchain: { path: '', pythonPath: '', autoWatch: true,
                     watchExclude: '', watchMaxElems: 0 },
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
    const run = asRecord(root.run) ?? {};
    const tc = asRecord(root.toolchain) ?? {};

    const str = (v: unknown, fb: string): string =>
        (typeof v === 'string' ? v.trim() : fb);
    const bool = (v: unknown, fb: boolean): boolean =>
        (typeof v === 'boolean' ? v : fb);
    // 运行次数至少 1；用户写 0 或负数按 1 处理，否则后端会跑 0 帧。
    const count = (v: unknown, fb: number): number =>
        Math.max(1, asInt(v, fb));

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
            // ★ 允许 0：后端支持 0 起的图集，早期版本钳到 >=1
            //   导致 pic/0.png 永远看不到。
            start: Math.max(0, asInt(pic.start, 1)),
        },
        run: {
            processRepeat: count(run.processRepeat, 1),
            benchRepeat: count(run.benchRepeat, 1000),
        },
        toolchain: {
            path: str(tc.path, ''),
            pythonPath: str(tc.pythonPath, ''),
            autoWatch: bool(tc.autoWatch, true),
            // 黑名单：字符串原样留着（逗号分隔），空串 = 不排除。
            watchExclude: str(tc.watchExclude, ''),
            // 元素数上限：>=0 的整数；负数按 0 处理（0 = 不限制）。
            watchMaxElems: Math.max(0, asInt(tc.watchMaxElems, 0)),
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
                + '    这个文件由配置面板维护；若手改坏了，'
                + '删掉它再打开一次配置面板即可（会重建一份默认配置）。',
        };
    }
}

/**
 * 已知的、已经废弃的配置键 —— 写入时顺手清掉。
 *
 * ★ 为什么必须有一张表（而不是"留着也无害"）：
 *   writeConfig 是"读-改-写、保留未知键"，这个设计本身是对的
 *   （将来加字段不会因为老版本插件写一次就丢）。但它有个副作用：
 *   **已废弃的键永远不会消失**。实测一个 0.8 时代的工程里，
 *   run.runFrames / toolchain.autoDownload / display.secondImage
 *   在代码里被删了三轮，却仍然躺在 scut_project.json 里 ——
 *   用户看得见、以为是配置项、去面板里找不到对应的开关。
 *
 * ★ 为什么按"块 + 键"两级描述而不是一条 JSON 路径字符串：
 *   读代码的人要能一眼看出"哪个块里的哪个键没了"，而不是去解析点号。
 *   嵌套只有两层，不值得引入路径解析。
 */
const DEPRECATED_KEYS: Record<string, string[]> = {
    // 「运行（连续跑 N 帧）」已删：功能与「测速」重复又给不出结论。
    run: ['runFrames'],
    // 「要不要自动下载工具链」已删：改成第一次编译时当场问，不再存开关。
    toolchain: ['autoDownload'],
    // 「要不要显示图片2」已删：两栏恒在，开合交给面板标题。
    display: ['secondImage'],
};

/**
 * 删掉已废弃的键。返回删掉的个数（只用于日志/测试）。
 *
 * ★ 只删【表里列出的】键，其余未知键一律保留 —— 那是 writeConfig
 *   "向前兼容"的承诺，不能因为加了清理就顺手把用户的自定义字段也抹了。
 */
function pruneDeprecated(merged: Record<string, unknown>): number {
    let removed = 0;
    for (const [block, keys] of Object.entries(DEPRECATED_KEYS)) {
        const obj = asRecord(merged[block]);
        if (!obj) {
            continue;
        }
        for (const k of keys) {
            if (Object.prototype.hasOwnProperty.call(obj, k)) {
                delete obj[k];
                removed++;
            }
        }
        // 整个块只剩空壳时也一并删掉（display 块就是这种情况：
        // 它唯一的键 secondImage 已废弃，留着 `"display": {}` 更让人困惑）。
        if (Object.keys(obj).length === 0 && block !== 'run' && block !== 'toolchain') {
            delete merged[block];
        }
    }
    return removed;
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
    merged.run = { ...(asRecord(merged.run) ?? {}), ...cfg.run };
    merged.toolchain = { ...(asRecord(merged.toolchain) ?? {}), ...cfg.toolchain };
    merged.inputArray = cfg.inputArray;
    merged.outputArray = cfg.outputArray;

    // ★ 合并之后、落盘之前清一次：先合并是为了让"本次要写的键"都在，
    //   再删废弃键就不会把刚写进去的值又删掉（表里列的都是已废弃的，
    //   与 ProjectConfig 的字段没有交集 —— 有交集就说明表写错了）。
    pruneDeprecated(merged);

    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
}

/** 判断配置里是否已经填过钩子（用来自动决定要不要弹首次配置引导）。 */
export function hasHooks(cfg: ProjectConfig): boolean {
    return cfg.hooks.frame.length > 0 || cfg.hooks.init.length > 0;
}
