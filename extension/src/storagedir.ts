/**
 * storagedir.ts —— 「工具链下载到哪个目录」的决策逻辑（纯函数，可单测）。
 *
 * ★★ 为什么单独一个文件 ★★
 *
 *   这段逻辑有三条分支（见下面 pickStorageDir），而每一条走错都有实际代价：
 *     · 选错"官方目录" → Insiders / VSCodium 用户找不到自己的工具链
 *     · 切换时选错    → 老用户已下载的 165MB 失联，被迫重下
 *     · 兜底选错      → 干脆下不了
 *   而 toolchain.ts 里 import 了 vscode，普通 Node 进程加载不了它 ——
 *   于是那段分支逻辑【测不了】。把决策抽成本文件之后：
 *     · 它不 import 任何东西（连 node 内置模块都不用）
 *     · 目录"存不存在"由调用方以函数注入，所以测试可以任意构造场景
 *   这与 simargs.ts 是同一个思路：把"两处/多分支必须一致"的决定
 *   收成一个可独立验证的纯函数。
 *
 * ★ 为什么把 exists 做成回调参数而不是在本文件里调 fs.existsSync：
 *   那样本文件就要 import 'fs'，测试就跑不了内存场景了（要真建目录）。
 *   注入之后，测试可以用一个纯函数描述"哪些目录里有工具链"，
 *   覆盖"新装/老用户/两者都有/两者都无"四种组合，无需碰磁盘。
 */

/** 判断某个存储目录下是否已经有一份就绪的工具链。 */
export type HasToolchainFn = (storageDir: string) => boolean;

export interface StorageDirInput {
    /**
     * VS Code 官方给的存储目录（`context.globalStorageUri.fsPath`）。
     * undefined = 激活时没拿到（老版本 / 异常），此时回落到旧推导目录。
     */
    injected?: string;
    /**
     * 旧版手拼出来的目录（`<APPDATA>\Code\User\globalStorage\<扩展ID>`）。
     * 用于向后兼容：老用户已下载的工具链在这里。
     */
    legacy: string;
    /** 某个目录里是否已有就绪的工具链。 */
    hasToolchain: HasToolchainFn;
}

/**
 * 决定用哪个存储目录。
 *
 * 规则（顺序即优先级）：
 *   1. 官方目录里已有工具链        → 用它（新装用户走这条）
 *   2. 官方目录空、旧目录里有      → 用旧目录（老用户不重下）
 *   3. 两个都空                    → 用官方目录（新下载放这里）
 *
 * ★ 第 2 条是本函数存在的主要理由。从"手拼路径"切到"官方目录"时，
 *   老用户已经下好的工具链在【旧】目录里；若这里直接返回官方目录，
 *   他们会在毫不知情的情况下被要求重下 165MB
 *   （而且旧目录还占着磁盘）。所以"旧目录里有就继续用"必须显式判断。
 *
 * ★ 只判断"有没有"，不做搬迁：搬家意味着一次 1GB 级的目录移动，
 *   中途失败（磁盘满、被杀软拦截、跨盘慢）会留下半份目录 ——
 *   比"继续用旧目录"坏得多。宁可让旧目录继续服役。
 *
 * ★ 万一 injected 与 legacy 恰好相同（例如某天扩展 ID 没变、
 *   而 APPDATA 推导又正好命中官方位置），也不会有问题：
 *   第 2 条会因为两者相等而跳过，直接落到第 1 或第 3 条。
 */
export function pickStorageDir(input: StorageDirInput): string {
    const primary = (input.injected && input.injected.length > 0)
        ? input.injected
        : input.legacy;

    // 1) 主目录里已有 —— 最理想的情况，直接用。
    if (input.hasToolchain(primary)) {
        return primary;
    }

    // 2) 主目录空，但旧目录里有 —— 老用户，继续用旧目录，不搬不重下。
    if (primary !== input.legacy && input.hasToolchain(input.legacy)) {
        return input.legacy;
    }

    // 3) 都没有 —— 用主目录（新下载放这里）。
    return primary;
}
