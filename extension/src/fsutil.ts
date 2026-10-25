/**
 * fsutil.ts —— 三个"问磁盘"的小函数。
 *
 * ★ 为什么值得单独一个文件（而不是各写一份）：
 *   本项目有 5 个文件各自写过 isFile / isDir，函数体一字不差：
 *       try { return fs.statSync(p).isFile(); } catch { return false; }
 *   它们的共同点是【吞掉一切异常并回答 false】—— 这恰恰是危险的地方：
 *   如果哪天有人把 catch 里的 false 改成 true，或者漏掉 catch，
 *   受影响的是五个模块，而每个模块的失败表现都不一样
 *   （工程识别不到 / 工具链说没装 / 构建脚本找不到）。
 *   一份实现、一处语义，是这类"到处都在问同一个问题"的唯一正确做法。
 *
 * ★ 为什么不用 fs.existsSync：
 *   它区分不了"文件"和"目录"。本项目有好几处判据必须是其中之一
 *   （例如 toolchain.ts 要确认路径是 clang.exe 而不是同名目录）。
 *
 * ★ 为什么这些函数不抛异常：
 *   调用点全是"探测"语义 —— 路径不存在、没权限、盘符没插，
 *   对调用方都是同一个答案："这条不行，换下一条"。
 *   抛异常会逼每个调用点包 try/catch，而那些 catch 最后都会写成
 *   "返回 false"，等于把同一段代码抄 N 遍。
 */

import * as fs from 'fs';

/** 是不是一个存在的【文件】（目录返回 false）。任何异常都当作"不是"。 */
export function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** 是不是一个存在的【目录】（文件返回 false）。任何异常都当作"不是"。 */
export function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}
