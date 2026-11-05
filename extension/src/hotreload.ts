/**
 * hotreload.ts —— 「热重载」的判据与指纹。
 *
 * 用户要的功能（原话）：
 *   「我想要用户可以外接图片编辑器，这个编辑器可以对一个文件进行写入……
 *     通过一个按钮选择由『检测到文件替换』来触发加载，还是关闭热重载的时候，
 *     只能由按钮触发。」
 *
 * 也就是说：工程根下的 Input_pic.<ext>（环境真正解码的那份副本）被外部
 * 改写时，自动重新加载并跑一帧；关掉之后，只有「上一张 / 下一张 / 跳到…」
 * 这些按钮会换图。
 *
 * ★★ 为什么本文件不 import vscode ★★
 *   判据本身（"这次文件变化该不该触发重载"）是纯逻辑，与编辑器 API 无关。
 *   放在这里就能用普通 Node 直接跑测试（tests/test_hotreload.js），
 *   而不是只能靠人点面板试。宿主侧（simview.ts）只负责
 *   "什么时候问、拿到 reload 之后发命令"这些脏活。
 *
 * ★★ 为什么判据是【内容指纹】而不是「命令发出去后 N 毫秒内的事件忽略掉」★★
 *   时间窗口是最容易写、也最容易错的那种实现：
 *   帧的往返时间取决于机器负载和图片大小，快的时候 3 ms、慢的时候几百毫秒。
 *   窗口开小了 → 自己的写入被当成外部改动，多跑一帧（算法状态平白前进一格，
 *   界面上完全看不出原因）；开大了 → 用户真改的图被忽略，改了不出图。
 *   两种错都是"偶发、不可复现"，正是这个项目最忌讳的故障类型。
 *
 *   内容指纹把时间彻底排除在判据之外：
 *     · 后端每帧把它【解码时读到的】副本指纹报回来（JSON 的 inHash）；
 *     · 这里算出【此刻】磁盘上副本的指纹；
 *     · 相同 → 这个变化早已经被加载过了（大概率就是后端自己写的），什么都不做；
 *       不同 → 文件确实变了，该重载。
 *   无论事件来得多早、多晚、重复几次，结论都一样。
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * FNV-1a 64 位哈希，返回 16 位小写十六进制。
 *
 * ★ 为什么必须是它（而不是随手换个 sha256）：
 *   后端（C）也要算同一个值，两边必须逐位一致。SHA-256 在 C 里要引入
 *   一份不小的实现，而这里判错的代价只是"漏掉一次重载"。
 *   FNV-1a 只需一个乘法循环，C 与 JS 各十行，公式在两边各自独立实现，
 *   靠【同一组测试向量】保证一致（见 tests/test_hotreload.js）。
 *
 * ★ 用 BigInt 而不是拆成高低 32 位：
 *   23 KB 的图一次约 2 万次乘法，BigInt 版本实测几毫秒，只在"用户保存了文件"
 *   这一刻跑一次 —— 换成手写 32 位乘法只会让"两个实现是否一致"变得难验证。
 */
export function fnv1a64Hex(buf: Uint8Array): string {
    const PRIME = 0x100000001b3n;
    const MASK = 0xffffffffffffffffn;
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < buf.length; i++) {
        h ^= BigInt(buf[i]);
        h = (h * PRIME) & MASK;
    }
    return h.toString(16).padStart(16, '0');
}

/**
 * 副本的完整路径：`<工程根>/Input_pic<源图后缀>`。
 *
 * ★ 为什么由【源图路径】推出来，而不是在目录里扫 `Input_pic.*`：
 *   副本的后缀跟着源图走（.bmp 图集 → Input_pic.bmp）。用户换过图集之后，
 *   工程根下可能同时躺着一个旧后缀的副本；扫目录一旦挑中那个陈旧的，
 *   算出来的指纹永远对不上，热重载就会变成"每 150 毫秒重载一次"的死循环。
 *   用本帧 JSON 里的 "pic"（源图）推，拿到的必然是后端真正在读的那一个。
 *
 * ★ 也接受"扫描"作为兜底（picPath 缺失时）：
 *   会话刚开始、还没收到任何帧时，宿主并不知道源图后缀。
 *   这时扫到哪个就用哪个 —— 判据里"文件不在/没有指纹"本来就是"什么都不做"，
 *   不会因为挑错而误触发。
 */
export function inputCopyPath(root: string, picPath: string | undefined): string | undefined {
    const ext = picPath ? path.extname(picPath) : '';
    if (ext) {
        return path.join(root, 'Input_pic' + ext);
    }
    let names: string[];
    try {
        names = fs.readdirSync(root);
    } catch {
        return undefined;
    }
    const hit = names.filter((n) => /^Input_pic\.[^.\\/]{1,10}$/i.test(n)).sort();
    return hit.length > 0 ? path.join(root, hit[0]) : undefined;
}

/**
 * 此刻磁盘上副本的内容指纹。
 *
 * ★ 读不到就返回 undefined（不抛）：保存到一半、被编辑器改名、
 *   同步盘临时锁文件 —— 这些都是"这一刻读不到"，不是错误。
 *   调用方据此【什么都不做】，等下一次事件。
 */
export function hashInputCopy(root: string, picPath: string | undefined): string | undefined {
    const p = inputCopyPath(root, picPath);
    if (!p) {
        return undefined;
    }
    try {
        return fnv1a64Hex(fs.readFileSync(p));
    } catch {
        return undefined;
    }
}

/** 判据结论：重载 / 等一下再判 / 什么都不做。 */
export type HotReloadDecision = 'reload' | 'wait' | 'ignore';

export interface HotReloadState {
    /** 开关是否打开（用户点的那个按钮） */
    enabled: boolean;
    /** 仿真进程是否在跑（不跑就没有"重新加载"这回事） */
    running: boolean;
    /**
     * 已发出、还没收到对应帧的命令数。
     *
     * ★ 为什么需要它：后端在【执行命令的过程中】才会重写副本，
     *   此时它报回来的指纹还是上一帧的。若不等这一帧落地就比对，
     *   会稳定地判成"文件变了"，于是每次翻页都多跑一帧。
     */
    framesInFlight: number;
    /** 后端上一帧报回来的副本指纹（undefined = 那一帧没从副本解码） */
    loadedHash: string | undefined;
    /** 此刻磁盘上副本的指纹（undefined = 读不到） */
    fileHash: string | undefined;
}

/**
 * 这次文件变化该不该触发重载。
 *
 * 判据顺序是有意义的，改动前请先读每一条后面的理由：
 *   ① 开关关 / 进程没跑 → 不关我的事；
 *   ② 文件读不到 → 什么都不做（保存到一半、被删除的中间态，
 *      紧接着的 create 事件会再来一次）；
 *   ③ 有命令在途 → 等那一帧落地再判（理由见 framesInFlight）；
 *   ④ 后端没报过指纹 → 判不了：
 *      它意味着"本帧不是从副本解码的"（工程目录写不了、镜像失败），
 *      这时热重载本来就不可能生效，反复重载只是白烧 CPU；
 *   ⑤ 指纹相同 → 这次变化已经被加载过了（后端自己写的），忽略；
 *   ⑥ 其余 → 重载。
 */
export function decideReload(s: HotReloadState): HotReloadDecision {
    if (!s.enabled || !s.running) {
        return 'ignore';
    }
    if (s.fileHash === undefined) {
        return 'ignore';
    }
    if (s.framesInFlight > 0) {
        return 'wait';
    }
    if (s.loadedHash === undefined) {
        return 'ignore';
    }
    return s.loadedHash === s.fileHash ? 'ignore' : 'reload';
}
