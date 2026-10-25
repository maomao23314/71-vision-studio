/**
 * hookscan.ts —— 从用户代码里【猜】哪些函数可以当钩子用。
 *
 * 设计理念对照：
 *   · 到手即用     → "每帧处理函数填什么"是这个环境唯一必填的一项，
 *                    而它恰好能从代码里读出来 —— 不该让用户手打函数名
 *   · 适应任意代码 → 只认 C 的语法形态（`void f(void)` 且非 static），
 *                    不假设任何命名习惯、不要求任何注册宏
 *   · 松耦合       → 不 import 'vscode'、不读全局状态，可以在普通 Node 里单测
 *
 * ★★ 为什么这件事值得做（用户原话："目前工程到手的配置还是有点麻烦"）★★
 *   新建工程之后，唯一必须人工填的就是钩子函数名。而手填有两个坑：
 *     ① 名字必须【逐字】对得上，填错一个字母，构建期只会得到
 *        "undefined reference to xxx"，看不出是配置写错了；
 *     ② 必须是非 static 的 —— 用户从车载工程拷过来的函数如果带 static，
 *        手填时完全看不出来，链接期才报错。
 *   所以让它变成一个下拉框：列出代码里真实存在的候选，点一下就填好。
 *
 * ★ 这里刻意【只做建议、不做决定】：扫不出来（用户用了宏、函数指针、
 *   或者函数在别的文件里）时返回空表，面板照旧可以手填。
 *   猜错比不猜更糟 —— 静默填一个错的函数名，用户会以为环境坏了。
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * 判断一个名字是不是"可能被当作钩子"的函数定义。
 *
 * ★ 判据只有三条，全部来自 C 的硬事实：
 *    1) 返回类型是 void（钩子函数的签名约定就是 void f(void)）；
 *    2) 形参是 void（同上）；
 *    3) 前面没有 static（static 函数在另一个编译单元里调不到）。
 *
 * ★ 为什么用正则而不是真解析 C：
 *   这里只要"候选列表"，用户在面板上还能自己改。为此引入一个 C 解析器
 *   （或调 clang -Xclang -ast-dump）会让这一项从"点一下"变成"等半秒"，
 *   而且失败时的降级路径更长。正则漏掉一些写法是可接受的，
 *   因为它【不会给出错误答案】—— 只会少给几个候选。
 */
const FN_RE = /(^|\n)[ \t]*(?!static\b)([A-Za-z_][\w \t*]*?)[ \t]+([A-Za-z_]\w*)[ \t]*\([ \t]*void[ \t]*\)[ \t]*\r?\n?[ \t]*\{/g;

/**
 * 从一段 C 源码里找出所有 `void name(void) {` 形态的函数名。
 *
 * ★ 先剥注释再扫：注释里常写着 `/* void old_process(void) 已废弃 *\/`，
 *   不剥的话会把废弃函数也列进候选 —— 用户选了它，链接期才报错。
 *   （字符串字面量里出现这种形态的概率极低，为简单起见不处理。）
 *
 * @param source 源码文本
 * @returns 函数名（保持出现顺序、已去重）
 */
export function findVoidFunctions(source: string): string[] {
    const code = stripComments(source);
    const out: string[] = [];
    const seen = new Set<string>();
    FN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FN_RE.exec(code)) !== null) {
        const ret = m[2].replace(/\s+/g, ' ').trim();
        const name = m[3];
        // 返回类型必须是裸 void：`void *f(void)` 或 `int f(void)` 都不是钩子。
        // ★ 这里必须比对【整个返回类型串】，不能只看它"含 void"——
        //   `void *` 是指针返回，签名与钩子不符。
        if (ret !== 'void') {
            continue;
        }
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        out.push(name);
    }
    return out;
}

/** 去掉 C 的块注释与行注释（保持换行，避免把两行粘成一行）。 */
function stripComments(text: string): string {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const d = text[i + 1];
        if (c === '/' && d === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
                if (text[i] === '\n') {
                    out += '\n';      // 保住行号与行边界
                }
                i++;
            }
            i += 2;
            continue;
        }
        if (c === '/' && d === '/') {
            while (i < n && text[i] !== '\n') {
                i++;
            }
            continue;
        }
        // 字符串字面量原样跳过（里面的 // 不是注释）
        if (c === '"' || c === '\'') {
            const quote = c;
            out += c;
            i++;
            while (i < n) {
                if (text[i] === '\\') {
                    out += text[i] + (text[i + 1] ?? '');
                    i += 2;
                    continue;
                }
                out += text[i];
                if (text[i] === quote) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** 扫描结果：候选函数名 + 它们各自来自哪个文件（面板上用来消歧）。 */
export interface HookCandidate {
    name: string;
    /** 相对工程根的文件路径（正斜杠） */
    file: string;
}

/**
 * 扫一个目录下的 .c 文件，汇总候选钩子函数。
 *
 * ★ 只扫 .c 不扫 .h：钩子的定义在 .c 里，头文件里的声明没有 `{`，
 *   正则本来就匹配不到 —— 但跳过它们能省掉无谓的读盘。
 * ★ 递归但限深度：用户可能把算法放在 code/ 的子目录里；
 *   而无限递归会在"工程根恰好选成 C:\"时把整个盘扫一遍。
 *
 * @param root 工程根（扫它的 code/ 子目录）
 * @param maxDepth 递归深度上限
 */
export function scanHookCandidates(root: string, maxDepth = 3): HookCandidate[] {
    const codeDir = path.join(root, 'code');
    const out: HookCandidate[] = [];
    const seen = new Set<string>();
    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === '.scut' || e.name === 'node_modules') {
                    continue;
                }
                walk(p, depth + 1);
                continue;
            }
            if (!/\.(c|cc|cpp)$/i.test(e.name)) {
                continue;
            }
            let text: string;
            try {
                text = fs.readFileSync(p, 'utf8');
            } catch {
                continue;
            }
            const rel = path.relative(root, p).replace(/\\/g, '/');
            for (const name of findVoidFunctions(text)) {
                if (seen.has(name)) {
                    continue;
                }
                seen.add(name);
                out.push({ name, file: rel });
            }
        }
    };
    walk(codeDir, 0);
    return out;
}
