/**
 * outpic.ts —— 把每帧的输出图落到工程根目录（OutPic_1 / OutPic_2）。
 *
 * 设计理念对照：
 *   · 上手即用     → 跑完就能在工程根看到图，不用去 .scut/frames 里翻 PPM
 *   · 可移植       → 只写工程根下的固定名字，路径相对、不含机器相关信息
 *   · 松耦合       → 本文件不认识仿真、不认识 webview，只认「一块 RGB + 尺寸」
 *
 * ★ 为什么不复用后端已经写好的 .scut/frames/*.ppm：
 *   PPM 在 Windows 上双击打不开（系统没有关联任何看图程序），
 *   而用户要的正是"跑完能直接看"。所以这里重新编码成 BMP / PNG。
 *   后端的 PPM 仍然保留 —— 它是会话的传输通道，两者职责不同。
 *
 * ★ 为什么编码自己写而不装依赖：
 *   BMP 是几十行的事；PNG 的压缩直接用 Node 自带的 zlib
 *   （`zlib.deflateSync` 产出的就是 deflate 流，PNG 的 IDAT 正是它）。
 *   装一个图像库只为了两个格式，会把「装上插件就能用」变成
 *   「装上插件还要联网装依赖」，与项目的取向相反。
 *
 * ★★ 为什么"每帧都写"而不是"会话结束时写一次" ★★
 *   用户的原话是「每运行完一次就保存」，而"一次运行"在这里就是
 *   "跑完一帧"。会话结束才写的话，跑到一半崩溃 / 用户点停止时
 *   一张图都没有；而每帧覆盖写，工程根里永远是【最新那一帧】。
 *   配合下面的「合并写入」，连续翻页时不会堆积写盘请求。
 *
 * ★ 本文件【不 import 'vscode'】：可以在普通 Node 进程里直接单测
 *   （见 tests/test_outpic.js），不需要起扩展宿主。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** 输出图在工程根下的固定文件名（不含后缀）。 */
export const OUT_PIC_NAMES = ['OutPic_1', 'OutPic_2'] as const;

/**
 * 把 rgb 编成 24 位 BMP。
 *
 * ★ BMP 的行序是【自下而上】的，且每行按 4 字节对齐。
 *   这两点写错了都不会报错，只会得到一张上下颠倒 / 斜切的图 ——
 *   所以下面每一处都标了为什么。
 */
export function encodeBmp(rgb: Uint8Array, w: number, h: number): Buffer {
    const rowBytes = w * 3;
    // 每行补齐到 4 的倍数。宽度是 3 的倍数时也可能需要补，
    // 例如 188*3=564 恰好是 4 的倍数，而 189*3=567 就要补 1 字节。
    const pad = (4 - (rowBytes % 4)) % 4;
    const stride = rowBytes + pad;
    const pixelBytes = stride * h;
    const out = Buffer.alloc(54 + pixelBytes);

    out.write('BM', 0, 'ascii');
    out.writeUInt32LE(54 + pixelBytes, 2);   // 整个文件大小
    out.writeUInt32LE(54, 10);               // 像素数据偏移
    out.writeUInt32LE(40, 14);               // DIB 头大小
    out.writeInt32LE(w, 18);
    out.writeInt32LE(h, 22);                 // 正数 = 自下而上
    out.writeUInt16LE(1, 26);                // planes
    out.writeUInt16LE(24, 28);               // 位深
    out.writeUInt32LE(0, 30);                // 不压缩
    out.writeUInt32LE(pixelBytes, 34);

    for (let y = 0; y < h; y++) {
        // 源数据的第 y 行（自上而下）要写到 BMP 的第 h-1-y 行（自下而上）
        const src = y * rowBytes;
        const dst = 54 + (h - 1 - y) * stride;
        for (let x = 0; x < w; x++) {
            const s = src + x * 3;
            const d = dst + x * 3;
            // BMP 是 BGR 序，与我们的 RGB 相反
            out[d] = rgb[s + 2];
            out[d + 1] = rgb[s + 1];
            out[d + 2] = rgb[s];
        }
        // 补齐字节保持 0（Buffer.alloc 已经清零，这里不需要再写）
    }
    return out;
}

/** CRC32 查表（PNG 每个数据块都要用）。表只算一次。 */
let crcTable: Uint32Array | undefined;

function crc32(buf: Buffer): number {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[n] = c >>> 0;
        }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 拼一个 PNG 数据块：长度 + 类型 + 数据 + CRC(类型+数据)。 */
function pngChunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
    return Buffer.concat([head, data, crc]);
}

/**
 * 把 rgb 编成 8 位真彩 PNG。
 *
 * ★ 滤波类型全部用 0（None）：滤波是为了提高压缩率，而这里的图只有
 *   一两百像素宽、单帧几十 KB，压不压得动对用户没有可感知差别；
 *   换成 Paeth 之类反而要逐像素做运算，写错了还查不出来。
 *   用 0 的唯一代价是文件略大，换来的是"肉眼可验证的正确性"。
 */
export function encodePng(rgb: Uint8Array, w: number, h: number): Buffer {
    const rowBytes = w * 3;
    // 每行前面要加一个滤波类型字节（0 = None）
    const raw = Buffer.alloc((rowBytes + 1) * h);
    for (let y = 0; y < h; y++) {
        const dst = y * (rowBytes + 1);
        raw[dst] = 0;
        for (let i = 0; i < rowBytes; i++) {
            raw[dst + 1 + i] = rgb[y * rowBytes + i];
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;        // 位深
    ihdr[9] = 2;        // 颜色类型 2 = 真彩 RGB
    ihdr[10] = 0;       // 压缩方法（只有 0 合法）
    ihdr[11] = 0;       // 滤波方法（只有 0 合法）
    ihdr[12] = 0;       // 非交织

    // ★ level 3 而不是默认 6：这是每帧都要跑的同步调用，
    //   跑在扩展宿主线程上。压缩率高一点对用户没有价值，
    //   卡一下主线程反而有感觉。
    const idat = zlib.deflateSync(raw, { level: 3 });

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/** 按后缀编码。未知后缀按 bmp 处理（配置被手改成别的值时不要崩）。 */
export function encodeImage(rgb: Uint8Array, w: number, h: number,
                            format: string): Buffer {
    return format === 'png' ? encodePng(rgb, w, h) : encodeBmp(rgb, w, h);
}

/** 一次待写的内容。 */
interface Pending {
    root: string;
    w: number;
    h: number;
    format: string;
    rgb: Uint8Array;
    rgb2?: Uint8Array;
}

/**
 * 输出图保存器：每帧喂进来，内部串行 + 合并。
 *
 * ★★ 为什么必须「串行」★★
 *   两次 writeFile 同时打到同一个文件，第二次的 truncate 可能夹在
 *   第一次的写之间，结果是半张新图 + 半张旧图。这种文件能打开、
 *   尺寸也对，只是内容错位 —— 极难看出是写入竞争造成的。
 *   串行化之后永远只有一个写者。
 *
 * ★★ 为什么还要「合并」★★
 *   串行只保证不打架，不保证不堆积：用户按住「下一张」连点二十下，
 *   队列里就会排二十个写请求，而前面十九个的结果早就过时了。
 *   所以只保留【最新一份】待写内容：写的时候取走，写完发现又有新的
 *   就再写一次。于是无论点多快，磁盘上的写次数都不超过"当前在写的
 *   那次 + 最后一次"。
 *
 * ★ 写盘失败只记一次日志：磁盘满 / 目录只读时，每帧一条日志会把
 *   输出面板刷爆，反而盖掉真正的原因。
 */
export class OutPicSaver {
    private pending: Pending | undefined;
    private writing = false;
    /** 已经排了一个微任务在等写，不必再排第二个（见 save）。 */
    private scheduled = false;
    /** 上一次写盘失败的原因（成功一次就清空，避免刷屏）。 */
    private lastError = '';

    /**
     * 登记一帧的输出图。
     *
     * @param root 工程根（输出图写在这里，路径相对工程根）
     * @param rgb 图片1（合成后的最终画面）
     * @param rgb2 图片2（算法没画时为 undefined）
     * @param onError 写盘失败时的回调（每换一种原因才调一次）
     */
    save(root: string, w: number, h: number, format: string,
         rgb: Uint8Array, rgb2: Uint8Array | undefined,
         onError?: (msg: string) => void): void {
        this.pending = { root, w, h, format, rgb, rgb2 };
        if (this.writing || this.scheduled) {
            return;                 /* 已有写者在跑：它写完会取走这一份 */
        }
        /* ★★ 必须延到微任务里再开始写，不能就地同步开始 ★★
         *   encodeImage 是【同步】的（PNG 要跑 deflate）。若在这里直接
         *   调 flush，第一个 await 之前的编码会立刻在调用方栈上跑完 ——
         *   于是"保存"插进了收帧路径中间，把一帧的墙钟时间拉长。
         *   排进微任务后，调用方（onFrame）先跑完、ACK 先发出去，
         *   编码才开始，两者才真的是并行的。
         *
         * ★ scheduled 与 writing 两个标记缺一不可：
         *   scheduled 防"同一个微任务周期里连续 save 两次"排出两个写者；
         *   writing   防"上一次写还没结束"时又开一个。
         *   少了任何一个，两个 flush 会同时往同一个文件写。 */
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            void this.flush(onError);
        });
    }

    private async flush(onError?: (msg: string) => void): Promise<void> {
        this.writing = true;
        try {
            while (this.pending) {
                const job = this.pending;
                this.pending = undefined;
                try {
                    await this.writeOne(job);
                    this.lastError = '';
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg !== this.lastError) {
                        this.lastError = msg;
                        onError?.(msg);
                    }
                }
            }
        } finally {
            this.writing = false;
        }
    }

    private async writeOne(job: Pending): Promise<void> {
        const ext = job.format === 'png' ? '.png' : '.bmp';
        const other = job.format === 'png' ? '.bmp' : '.png';

        await fs.promises.writeFile(
            path.join(job.root, OUT_PIC_NAMES[0] + ext),
            encodeImage(job.rgb, job.w, job.h, job.format));

        /* ★ 图片2：这一帧画了就写，没画就删。
         *
         *   留着旧文件的话，用户会对着一个"上次的"图片2 调参数，
         *   而画面上的图片2 是空的 —— 而且没有任何提示。
         *
         * ★★ 为什么"没画就删"是无条件的，不记"上一帧写过没" ★★
         *   记状态看起来省一次 syscall，实际会引入三个失准点：
         *     · 用户手删了文件，标记还是 true → 该重写的没重写；
         *     · 换了工程目录，标记跟着旧工程 → 新工程里的残留删不掉；
         *     · 重启插件后标记为 false → 上一轮留下的旧文件永远删不掉。
         *   而无条件删一次（ENOENT 静默、亚微秒），换来一条恒等式：
         *       「磁盘上有没有 OutPic_2」 == 「这一帧算法画了没有」
         *   这条恒等式不需要任何人维护，也就不会失效。 */
        const p2 = path.join(job.root, OUT_PIC_NAMES[1] + ext);
        if (job.rgb2) {
            await fs.promises.writeFile(
                p2, encodeImage(job.rgb2, job.w, job.h, job.format));
        } else {
            await this.removeQuietly(p2);
        }

        /* ★ 另一种后缀的两张图一并清掉 —— 换格式之后它们会永远停在
         *   切换前那一帧，而用户会以为那就是当前结果。
         *   同样不记"上次是什么格式"：换工程目录后格式没变的话，
         *   新工程里的残留就永远清不掉了。两次 ENOENT 换一条恒等式。 */
        await this.removeQuietly(path.join(job.root, OUT_PIC_NAMES[0] + other));
        await this.removeQuietly(path.join(job.root, OUT_PIC_NAMES[1] + other));
    }

    /** 删一个文件；不在就静默忽略（ENOENT 是正常情况，不是错误）。 */
    private async removeQuietly(p: string): Promise<void> {
        try {
            await fs.promises.unlink(p);
        } catch {
            /* 本来就没有 */
        }
    }
}
