/**
 * project.ts —— 仿真工程的识别与描述。
 *
 * 设计理念对照：
 *   · 代码松耦合   → 只依赖 types.ts 的 ScutProject，不 import 其它实现
 *   · 上手即用     → 「新建工程」把模板拷过去就能跑，不需要用户理解目录结构
 *   · 适应任意代码 → 尺寸从 config.h 用正则读，【不编译】，所以对任意工程都成立
 *
 * ★ 为什么尺寸要正则读而不是预处理器：
 *   读一次 config.h 是微秒级；跑一次 `clang -E -dM` 是几十毫秒起步，
 *   还要处理 include 路径、宏依赖。这里只需要两个整数，
 *   用一条正则足够，且失败了可以优雅降级（返回 undefined 而不是崩）。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ScutProject } from './types';
import { CONFIG_FILENAME, readConfig } from './projectconfig';
import { isDir, isFile } from './fsutil';

/** 编译期契约头文件的候选名（与 tools/scut_build.py 的 find_config_header 一致）。 */
const CONFIG_HEADER_NAMES = ['scut_config.h', 'config.h'];

/** 生成物目录名（与 tools/scut_build.py 的 SCUT_DIR 一致）。 */
const SCUT_DIR_NAME = '.scut';

export interface ImageSize {
    width: number;
    height: number;
    /** 尺寸是从哪个文件读到的（用于让用户确认自己改对了文件） */
    from: string;
}

/* ★ isDir / isFile 已抽到 fsutil.ts（原来四个文件各有一份）。 */

/**
 * 在一个目录下找工程配置，返回配置文件的绝对路径或 undefined。
 *
 * ★ 两种约定都认：
 *     scut_project.json —— 新约定（插件配置面板维护的真值来源）
 *     config.h          —— 老约定（迁移期不该让老工程突然认不出来）
 */
function findProjectConfig(root: string): string | undefined {
    const json = path.join(root, CONFIG_FILENAME);
    if (isFile(json)) {
        return json;
    }
    for (const name of CONFIG_HEADER_NAMES) {
        const p = path.join(root, name);
        if (isFile(p)) {
            return p;
        }
    }
    return undefined;
}

/** 老的契约头文件查找（保留：几条与"尺寸从哪来"相关的路径仍要用它）。 */
function findConfigHeader(root: string): string | undefined {
    for (const name of CONFIG_HEADER_NAMES) {
        const p = path.join(root, name);
        if (isFile(p)) {
            return p;
        }
    }
    return undefined;
}

/**
 * 判断一个目录「像不像」仿真工程根目录。
 *
 * 判定不用太严：有配置文件，或者有 code/ 目录，就算。
 * ★ 为什么刻意放宽：学生可能只拷了 code/ 过来（还没建配置文件），
 *   这时候直接报「不是工程」比「自动帮你补一份」体验差得多。
 */
function looksLikeProject(root: string): boolean {
    return findProjectConfig(root) !== undefined || isDir(path.join(root, 'code'));
}

/** 从 start 目录向上找工程根，最多上溯 maxUp 层。 */
function findRootUpwards(start: string, maxUp = 6): string | undefined {
    let cur = path.resolve(start);
    for (let i = 0; i <= maxUp; i++) {
        if (looksLikeProject(cur)) {
            return cur;
        }
        const parent = path.dirname(cur);
        if (parent === cur) {
            break;
        }
        cur = parent;
    }
    return undefined;
}

/**
 * 从 config.h / scut_config.h 里读 SCUT_IMAGE_W / SCUT_IMAGE_H。
 *
 * ★ 覆盖的写法（实测 templates/starter/config.h 用的是第一种）：
 *      #define SCUT_IMAGE_W            (188)
 *      #define SCUT_IMAGE_H 120
 *      #define SCUT_IMAGE_W  188   /* 注释 *\/
 *   ★ 刻意【不】求值表达式（如 (188+4)）：那种情况下宁可返回 undefined
 *     让上层降级，也不要猜错一个尺寸导致画面全花。
 */
export function parseImageSizeFromFile(configHeader: string): ImageSize | undefined {
    let text: string;
    try {
        text = fs.readFileSync(configHeader, 'utf8');
    } catch {
        return undefined;
    }
    return parseImageSizeFromText(text, configHeader);
}

/** 纯文本版（便于单测；parseImageSizeFromFile 只是它加读盘）。 */
export function parseImageSizeFromText(text: string, from = '<text>'): ImageSize | undefined {
    const pick = (macro: string): number | undefined => {
        // 逐行匹配而不是写一条带 $ 的复杂正则：
        // 行内可能还有 /* 注释 */，用正则的回溯去猜容易出错，手工切更直白。
        const re = new RegExp(`^[ \\t]*#[ \\t]*define[ \\t]+${macro}(?![A-Za-z0-9_])[ \\t]+(.*)$`);
        for (const rawLine of text.split(/\r?\n/)) {
            const m = re.exec(rawLine);
            if (!m) {
                continue;
            }
            let v = m[1];
            const c = v.indexOf('/*');
            if (c >= 0) {
                v = v.slice(0, c);
            }
            v = v.replace(/[()\s]/g, '');
            // 只接受纯十进制字面量。出现 (188+4) 这类表达式时【宁可返回 undefined】
            // 让上层降级，也不要猜一个错的尺寸 —— 猜错的后果是画面整帧错位。
            if (!/^\d+$/.test(v)) {
                return undefined;
            }
            const n = Number(v);
            return Number.isSafeInteger(n) && n > 0 ? n : undefined;
        }
        return undefined;
    };

    const width = pick('SCUT_IMAGE_W');
    const height = pick('SCUT_IMAGE_H');
    if (width === undefined || height === undefined) {
        return undefined;
    }
    return { width, height, from };
}

/** 从 config.h 里读 SCUT_PIC_DIR（测试图集目录名，可选）。 */
export function parsePicDirFromFile(configHeader: string): string | undefined {
    try {
        const text = fs.readFileSync(configHeader, 'utf8');
        const m = /^[ \t]*#[ \t]*define[ \t]+SCUT_PIC_DIR[ \t]+"([^"]*)"/m.exec(text);
        return m ? m[1] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 识别并描述一个仿真工程。
 *
 * 查找顺序（★ 都是「就近优先」，避免多工程工作区里认错）：
 *   1) 传进来的目录本身
 *   2) 传进来的目录向上回溯
 *   3) 工作区第一个文件夹
 *   4) 当前打开文件所在目录向上回溯
 */
export function detectProject(explicitDir?: string): ScutProject | undefined {
    const candidates: string[] = [];
    if (explicitDir) {
        candidates.push(explicitDir);
    }
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(f.uri.fsPath);
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && active.scheme === 'file') {
        candidates.push(path.dirname(active.fsPath));
    }

    let root: string | undefined;
    for (const c of candidates) {
        if (!c || !isDir(c)) {
            continue;
        }
        root = findRootUpwards(c);
        if (root) {
            break;
        }
    }
    if (!root) {
        return undefined;
    }

    const configHeader = findConfigHeader(root) ?? path.join(root, 'config.h');

    // ★★ 0.9.4：配置只有一个真值，就是 scut_project.json ★★
    //   取值顺序反而缩短了：
    //     1) scut_project.json 的 pic.dir —— 真值来源
    //     2) config.h 里的 SCUT_PIC_DIR —— 老工程兼容
    //     3) 兜底 "pic"
    //
    //   以前这里第一优先是 VS Code 设置项 scut71.runtime.picDir
    //   （fromSettings ?? fromProjectConfig），后果有三个：
    //     · 工程 JSON 里配了图集目录却不生效
    //     · 而那个设置键本身因为 contributes.configuration 的
    //       嵌套 object 分组【没注册成功】，连设置里的值也读不到
    //     · 两头都落空，却一个字都不报
    //
    //   ★★ 另一个坑（现在只剩真值那一半）★★
    //   早期版本【写死了 path.join(root, 'pic')】，完全忽略 pic.dir ——
    //   这就是用户报的「pic/1 里的 BMP 也无法加载」的根因：
    //   图集约定是 pic/<组号>/<编号>.bmp，图片天生在 pic\1\ 子目录里，
    //   而插件却把 pic\ 这个【父目录】传给了仿真程序；
    //   仿真程序在 pic\ 下找 1.bmp 当然找不到（它在 pic\1\ 下），
    //   于是静默跑黑图，一个字都不提示。
    const fromProjectConfig = readConfig(root).config?.pic.dir || undefined;
    const fromLegacyConfig = parsePicDirFromFile(configHeader) ?? undefined;
    const rel = fromProjectConfig ?? fromLegacyConfig ?? 'pic';
    const picDir = path.isAbsolute(rel) ? rel : path.join(root, rel);

    return {
        root,
        codeDir: path.join(root, 'code'),
        configHeader,
        picDir,
        outDir: path.join(root, SCUT_DIR_NAME),
    };
}

/** 工程描述的一行摘要（用于状态栏/提示）。 */
export function describeProject(p: ScutProject): string {
    // 尺寸优先从 scut_project.json 读（新约定），回落到 config.h（老工程）。
    const cfg = readConfig(p.root).config;
    const size = cfg
        ? { width: cfg.image.width, height: cfg.image.height }
        : parseImageSizeFromFile(p.configHeader);
    const sizeText = size
        ? `${size.width}x${size.height}`
        : '尺寸未知（工程里没有 scut_project.json，config.h 里也没读到）';
    return `${path.basename(p.root)} · 图像 ${sizeText} · ${p.root}`;
}

/* ==========================================================================
 *  从模板新建工程
 * ========================================================================== */

/**
 * 定位模板目录。
 *
 * ★ 为什么要查两个位置：
 *   插件安装后运行在 ~/.vscode/extensions/scut-racing.scut-71-vision-studio-x.y.z/，
 *   模板必须在 VSIX 里（package.json 的 files 里带了 templates/**）。
 *   而在仓库里直接 F5 调试时，扩展根目录是 <repo>/extension/，
 *   模板在 <repo>/templates/ —— 所以两个都查。
 */
export function locateTemplateDir(extensionUri: vscode.Uri): string | undefined {
    const candidates = [
        vscode.Uri.joinPath(extensionUri, 'templates', 'starter').fsPath,
        vscode.Uri.joinPath(extensionUri, '..', 'templates', 'starter').fsPath,
    ];
    for (const c of candidates) {
        // ★ 判据跟着模板的实际内容走：新模板带 scut_project.json，
        //   老模板带 config.h。两个都认，这样升级插件时不会因为
        //   "模板改了名"就让「新建工程」整个失效。
        if (isDir(c) && (isFile(path.join(c, 'scut_project.json'))
                         || isFile(path.join(c, 'config.h')))) {
            return path.resolve(c);
        }
    }
    return undefined;
}

/**
 * 定位「测试图集放法说明」文件 README-pic.txt。
 *
 * ★ 它刻意放在 templates/ 下而不是 templates/starter/ 里：
 *   它是给【新建工程后】用的说明（会被拷进工程的 pic/1/），
 *   不是工程模板自身的组成部分 —— 放进 starter/ 就会被当成模板文件
 *   一起拷到工程根目录，位置不对。
 */
export function locatePicReadme(extensionUri: vscode.Uri): string | undefined {
    const candidates = [
        vscode.Uri.joinPath(extensionUri, 'templates', 'README-pic.txt').fsPath,
        vscode.Uri.joinPath(extensionUri, '..', 'templates', 'README-pic.txt').fsPath,
    ];
    for (const c of candidates) {
        if (isFile(c)) {
            return path.resolve(c);
        }
    }
    return undefined;
}

export interface CreateProjectResult {
    ok: boolean;
    root?: string;
    /** 中文说明，成功或失败都给出「下一步」 */
    message: string;
}

/**
 * 把模板拷到 targetDir，并补出空的 pic/1/ 图集目录。
 *
 * ★ 安全约束：目标目录若已存在【且有内容】就直接拒绝，绝不覆盖用户文件。
 *   学生把算法写在 code/ 里，误覆盖一次就是灾难。宁可多问一句。
 *
 * ★ 为什么 pic/ 目录要由插件补出来，而不是放进模板里：
 *   模板里【不该有图片】—— 用哪些图是用户自己的数据，不是环境能替他决定的。
 *   但目录结构本身要能被发现：留一个空的 pic/1/ 加上一份 README-pic.txt，
 *   用户一眼就知道"图放这儿、怎么编号"，而不会被塞一组别人的图误导。
 *   （曾经的模板带 36 张 BMP，831 KB，既占了安装包体积，
 *     又暗示"这组图才是标准"，实际上换台车就完全不适用。）
 *
 * @param picReadme 可选：README-pic.txt 的路径。给了就拷进 pic/1/，没给就跳过。
 */
export function createProjectFromTemplate(
    templateDir: string,
    targetDir: string,
    picReadme?: string,
): CreateProjectResult {
    const dst = path.resolve(targetDir);
    if (fs.existsSync(dst)) {
        let entries: string[] = [];
        try {
            entries = fs.readdirSync(dst);
        } catch (e) {
            return {
                ok: false,
                message: `无法读取目标目录 ${dst}：${e instanceof Error ? e.message : String(e)}\n`
                    + '    下一步：换一个目录，或先关掉占用它的程序。',
            };
        }
        if (entries.length > 0) {
            return {
                ok: false,
                message: `目标目录不是空的，已中止，没有覆盖任何文件：${dst}\n`
                    + '    原因：工程目录里可能有你已经写好的算法，覆盖掉就找不回来了。\n'
                    + '    下一步：换一个空目录，或者手动把模板里的 code/ 与 config.h 拷过去。',
            };
        }
    }

    try {
        fs.mkdirSync(dst, { recursive: true });
        const copied: string[] = [];
        const walk = (srcDir: string, outDir: string): void => {
            for (const name of fs.readdirSync(srcDir)) {
                const s = path.join(srcDir, name);
                const d = path.join(outDir, name);
                if (isDir(s)) {
                    fs.mkdirSync(d, { recursive: true });
                    walk(s, d);
                } else {
                    fs.copyFileSync(s, d);
                    copied.push(path.relative(dst, d).replace(/\\/g, '/'));
                }
            }
        };
        walk(templateDir, dst);

        // 补出空的图集目录 pic/1/，并放一份放法说明。
        // ★ 先建空目录再放说明：即使 README-pic.txt 缺失（理论上不该发生），
        //   pic/1/ 这个结构本身也要在，否则用户不知道该往哪放图。
        const picGroupDir = path.join(dst, 'pic', '1');
        fs.mkdirSync(picGroupDir, { recursive: true });
        copied.push('pic/1/');
        if (picReadme && isFile(picReadme)) {
            fs.copyFileSync(picReadme, path.join(picGroupDir, 'README-pic.txt'));
            copied.push('pic/1/README-pic.txt');
        }

        return {
            ok: true,
            root: dst,
            message: `工程已创建：${dst}\n`
                + `    已复制：${copied.join('、')}\n`
                + '    下一步：打开这个文件夹，按 Ctrl+Shift+B 编译，再按 → 看下一张；'
                + '图像尺寸、钩子函数等在侧边栏的 ⚙ 配置面板里改。'
                + '把【你自己的】测试图按连续编号放进 pic/1/（放法见 pic/1/README-pic.txt）。',
        };
    } catch (e) {
        return {
            ok: false,
            message: `复制模板失败：${e instanceof Error ? e.message : String(e)}\n`
                + `    源目录：${templateDir}\n`
                + `    目标目录：${dst}\n`
                + '    下一步：确认目标路径可写（不要放在 C:\\Program Files 之类需要管理员权限的位置）。',
        };
    }
}
