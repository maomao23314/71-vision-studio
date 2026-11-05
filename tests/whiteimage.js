#!/usr/bin/env node
/**
 * whiteimage.js —— 造一张"纯色替身图"（测试用，不是产品代码）。
 *
 * ★ 为什么单独拆出来：
 *   「把副本涂成纯白，看画面跟不跟着变」是两条测试共用的手法
 *   （mirror_decode.js 验"解码读的是副本"，hot_reload_e2e.js 验"重载读的是新内容"）。
 *   复制一份编码器，就会出现"两条测试各有一份，其中一份悄悄坏了"
 *   这种最难查的情况 —— 测试自己坏了却报通过。
 *
 * ★ 为什么自己写编码器，不用 extension/out/outpic.js：
 *   那是产品代码，拿它造测试输入等于"自己证明自己"。
 *
 * ★ 为什么必须按文件后缀选格式：
 *   副本的后缀跟着图集走（.png 图集 → Input_pic.png），解码器按后缀
 *   选解析器。把 PNG 字节写进 .bmp 文件必然解不开、画面变黑 ——
 *   那也会"变"，但证明不了任何事情。
 */
'use strict';

const zlib = require('zlib');

/** CRC32（PNG 每个 chunk 都要）。 */
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/** 8 位真彩 PNG（非交织，filter=0），整张填 value。 */
function encodeWhitePng(w, h, value) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;    /* bit depth */
    ihdr[9] = 2;    /* color type 2 = truecolor RGB */
    ihdr[10] = 0;   /* compression */
    ihdr[11] = 0;   /* filter */
    ihdr[12] = 0;   /* interlace = none */

    const stride = w * 3;
    const raw = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y++) {
        const base = y * (stride + 1);
        raw[base] = 0;  /* filter type 0 (None) */
        raw.fill(value, base + 1, base + 1 + stride);
    }

    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, 'ascii');
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
        return Buffer.concat([head, data, crcBuf]);
    };

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** 24 位 BMP（行序自下而上，每行补齐到 4 字节），整张填 value。 */
function encodeWhiteBmp(w, h, value) {
    const rowBytes = w * 3;
    const pad = (4 - (rowBytes % 4)) % 4;
    const stride = rowBytes + pad;
    const out = Buffer.alloc(54 + stride * h);
    out.write('BM', 0, 'ascii');
    out.writeUInt32LE(out.length, 2);
    out.writeUInt32LE(54, 10);
    out.writeUInt32LE(40, 14);
    out.writeInt32LE(w, 18);
    out.writeInt32LE(h, 22);
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(24, 28);
    out.writeUInt32LE(0, 30);
    out.writeUInt32LE(stride * h, 34);
    for (let y = 0; y < h; y++) {
        out.fill(value, 54 + y * stride, 54 + y * stride + rowBytes);
    }
    return out;
}

/** 按副本后缀生成同格式的纯色图；不认识的格式返回 undefined。 */
function whiteImageLike(file, w, h, value) {
    const ext = require('path').extname(file).toLowerCase();
    if (ext === '.png') {
        return encodeWhitePng(w, h, value);
    }
    if (ext === '.bmp') {
        return encodeWhiteBmp(w, h, value);
    }
    return undefined;
}

module.exports = { crc32, encodeWhitePng, encodeWhiteBmp, whiteImageLike };
