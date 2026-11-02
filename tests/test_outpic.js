#!/usr/bin/env node
/*
 * test_outpic.js —— 输出图编码（OutPic_1 / OutPic_2）的自测。
 *
 * ★ 为什么要单测"编码"这种看起来显然的东西：
 *   BMP 的行序是自下而上、每行按 4 字节对齐；PNG 的每个块要带 CRC32。
 *   这两处写错了【都不会报错】—— 文件照样生成、大小也对，
 *   只是打开是上下颠倒 / 斜切 / 打不开。而用户报障时只会说
 *   "图是坏的"，从那张图上完全看不出是哪一步错的。
 *   所以这里不比对字节，而是【真的把文件解回像素】，逐点核对。
 *
 * ★ 解码用的是本仓库自己的 C 解码器（core/src/scut_frame.c），
 *   不是第三方库 —— 环境能读的图，才是真正能用的图。
 *
 * 用法: node tests/test_outpic.js
 * 退出码 0 = 全部通过。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.dirname(__dirname);
const OUTPIC = path.join(ROOT, 'extension', 'out', 'outpic.js');

let checks = 0;
const failures = [];

function check(cond, msg, extra) {
    checks++;
    if (cond) {
        console.log('  [OK]   ' + msg);
    } else {
        failures.push(msg);
        console.log('  [FAIL] ' + msg + (extra ? '  -> ' + extra : ''));
    }
    return cond;
}

if (!fs.existsSync(OUTPIC)) {
    console.log('  [FAIL] 找不到 ' + OUTPIC + '（先跑 npx tsc -p extension）');
    process.exit(1);
}

const { encodeBmp, encodePng, encodeImage, OutPicSaver, OUT_PIC_NAMES } =
    require(OUTPIC);

/* ---------------------------------------------------------------- 工具 */

// 造一张有辨识度的测试图：每个像素都不一样，且故意让宽度不是 4 的倍数
// （189*3=567，BMP 每行要补 1 字节），这样"行对齐写错"一定会被抓到。
const W = 189;
const H = 41;
function makeRgb(w, h) {
    const b = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            b[i] = (x * 7 + y * 3) & 0xFF;
            b[i + 1] = (x * 5 + y * 11) & 0xFF;
            b[i + 2] = (x * 13 + y) & 0xFF;
        }
    }
    return b;
}

/* ---------------------------------------------------------------- BMP */

console.log('='.repeat(66));
console.log('  A) BMP 编码：文件头 + 行序 + 行对齐');
console.log('='.repeat(66));

const rgb = makeRgb(W, H);
const bmp = encodeBmp(rgb, W, H);

check(bmp.slice(0, 2).toString('ascii') === 'BM', 'BMP 签名是 "BM"');
check(bmp.readUInt32LE(2) === bmp.length, '文件头里写的大小 == 实际长度',
    bmp.readUInt32LE(2) + ' vs ' + bmp.length);
check(bmp.readUInt32LE(10) === 54, '像素数据偏移是 54');
check(bmp.readInt32LE(18) === W && bmp.readInt32LE(22) === H, '宽高写对了',
    bmp.readInt32LE(18) + 'x' + bmp.readInt32LE(22));
check(bmp.readUInt16LE(28) === 24, '位深 24');
check(bmp.readUInt32LE(30) === 0, '不压缩');

// 行对齐：189*3 = 567，补到 568
const stride = 568;
check(bmp.length === 54 + stride * H, '总长度 = 54 + 补齐后的行宽 × 高',
    bmp.length + ' vs ' + (54 + stride * H));

// 逐点核对：第 0 行第 0 个像素必须出现在【文件最后一行】的开头（自下而上）
{
    const dst = 54 + (H - 1) * stride;
    const okR = bmp[dst + 2] === rgb[0];
    const okG = bmp[dst + 1] === rgb[1];
    const okB = bmp[dst] === rgb[2];
    check(okR && okG && okB, '像素 (0,0) 落在文件最后一行（自下而上）且是 BGR 序',
        [bmp[dst], bmp[dst + 1], bmp[dst + 2]] + ' vs ' +
        [rgb[2], rgb[1], rgb[0]]);
}
// 抽查中间一个像素
{
    const x = 100, y = 20;
    const src = (y * W + x) * 3;
    const dst = 54 + (H - 1 - y) * stride + x * 3;
    check(bmp[dst] === rgb[src + 2] && bmp[dst + 1] === rgb[src + 1]
          && bmp[dst + 2] === rgb[src],
        '像素 (100,20) 的 RGB 正确换序后落在正确位置');
}
// 补齐字节必须是 0
{
    let allZero = true;
    for (let y = 0; y < H; y++) {
        const base = 54 + y * stride + W * 3;
        if (bmp[base] !== 0) { allZero = false; }
    }
    check(allZero, '每行补齐的字节是 0（否则看图软件会显示脏边）');
}

/* ---------------------------------------------------------------- PNG */

console.log('');
console.log('='.repeat(66));
console.log('  B) PNG 编码：签名 + 块结构 + CRC');
console.log('='.repeat(66));

const png = encodePng(rgb, W, H);
const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
check(png.slice(0, 8).equals(SIG), 'PNG 签名正确');

// 走一遍所有块，校验 CRC 与长度自洽
{
    let off = 8;
    const types = [];
    let crcOk = true;
    let lenOk = true;
    while (off + 8 <= png.length) {
        const len = png.readUInt32BE(off);
        const type = png.slice(off + 4, off + 8).toString('ascii');
        types.push(type);
        if (off + 12 + len > png.length) { lenOk = false; break; }
        const data = png.slice(off + 8, off + 8 + len);
        const want = png.readUInt32BE(off + 8 + len);
        // 用同一种算法复算 CRC
        const zlib = require('zlib');
        // zlib.crc32 在新版 Node 才有；没有就跳过这一项比对
        if (typeof zlib.crc32 === 'function') {
            const got = zlib.crc32(Buffer.concat([
                png.slice(off + 4, off + 8), data])) >>> 0;
            if (got !== want) { crcOk = false; }
        }
        off += 12 + len;
    }
    check(lenOk, '所有块的声明长度与实际数据自洽');
    check(off === png.length, '块链正好走到文件末尾（没有多余/缺失字节）',
        off + ' vs ' + png.length);
    check(types.join(',') === 'IHDR,IDAT,IEND',
        '块顺序是 IHDR,IDAT,IEND', types.join(','));
    if (typeof require('zlib').crc32 === 'function') {
        check(crcOk, '每个块的 CRC32 都正确（写错的话任何软件都打不开）');
    } else {
        console.log('  [跳过] 本机 Node 没有 zlib.crc32，CRC 交给下面的真实解码验证');
    }
}

// IHDR 内容
{
    const ihdr = png.slice(16, 16 + 13);
    check(ihdr.readUInt32BE(0) === W && ihdr.readUInt32BE(4) === H,
        'IHDR 里的宽高正确');
    check(ihdr[8] === 8 && ihdr[9] === 2 && ihdr[10] === 0
          && ihdr[11] === 0 && ihdr[12] === 0,
        'IHDR：8 位 / 真彩 RGB / 压缩0 / 滤波0 / 非交织');
}

/* ------------------------------------------------- 用真实解码器读回来 */

console.log('');
console.log('='.repeat(66));
console.log('  C) 用仓库自带的 C 解码器把文件读回像素（真正的验收）');
console.log('='.repeat(66));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scut_outpic_'));
const bmpPath = path.join(tmp, 'probe.bmp');
const pngPath = path.join(tmp, 'probe.png');
fs.writeFileSync(bmpPath, bmp);
fs.writeFileSync(pngPath, png);

// 写一个小 C 程序，调 scut_frame_load_image 解码，把像素按 RGB 打出来。
// 这样"环境能读"这件事就被真的验证了，而不是靠本文件里的假设。
const cSrc = `
#include "scut_frame.h"
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv)
{
    int w = ${W}, h = ${H};
    scut_u8 *buf = (scut_u8 *)malloc((size_t)w * h);
    int rc, y, x;
    if (argc < 2 || buf == NULL) { return 2; }
    rc = scut_frame_load_image(argv[1], buf, w, h, w);
    if (rc != 0) {
        fprintf(stderr, "load failed rc=%d\\n", rc);
        return 3;
    }
    /* 灰度图：把 RGB 三个通道按 0.299/0.587/0.114 折回一个亮度值 */
    for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
            printf("%d%c", buf[y * w + x], (x == w - 1) ? '\\n' : ' ');
        }
    }
    free(buf);
    return 0;
}
`;

function tryDecode(file) {
    const cc = findClang();
    if (!cc) { return null; }
    const exe = path.join(tmp, 'probe.exe');
    const cFile = path.join(tmp, 'probe.c');
    fs.writeFileSync(cFile, cSrc);
    execFileSync(cc, ['-std=c11', '-O1', '-o', exe, cFile,
        path.join(ROOT, 'core', 'src', 'scut_frame.c'),
        path.join(ROOT, 'core', 'src', 'scut_draw.c'),
        '-I', path.join(ROOT, 'core', 'include')],
        { stdio: 'pipe' });
    const out = execFileSync(exe, [file], { encoding: 'utf8' });
    return out.trim().split('\n').map((l) => l.split(' ').map(Number));
}

function findClang() {
    const cands = [
        process.env.SCUT71_TOOLCHAIN &&
            path.join(process.env.SCUT71_TOOLCHAIN, 'bin', 'clang.exe'),
        'D:/TOOLS/llvm-mingw/bin/clang.exe',
    ].filter(Boolean);
    for (const c of cands) {
        if (fs.existsSync(c)) { return c; }
    }
    return undefined;
}

// 期望的灰度（与 scut_frame.c 的灰度化公式对齐：这里只要求"能读、尺寸对、
// 不是全黑、且亮暗分布与原图一致"，不逐像素比 RGB —— 因为解码器输出是灰度）。
function luminance(r, g, b) {
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

const expect = [];
for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        row.push(luminance(rgb[i], rgb[i + 1], rgb[i + 2]));
    }
    expect.push(row);
}

for (const [name, file] of [['BMP', bmpPath], ['PNG', pngPath]]) {
    let got;
    try {
        got = tryDecode(file);
    } catch (e) {
        check(false, name + ' 解码器读取失败', e.message);
        continue;
    }
    if (got === null) {
        console.log('  [跳过] 找不到 clang，跳过 ' + name + ' 的真实解码验证');
        continue;
    }
    if (!check(got.length === H && got[0].length === W,
            name + ' 解码出的尺寸正确', got.length + 'x' + (got[0] || []).length)) {
        continue;
    }
    // 逐像素比灰度，允许 ±2 的舍入差（不同实现的分母细节可能差 1）
    let worst = 0;
    let bad = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const d = Math.abs(got[y][x] - expect[y][x]);
            if (d > worst) { worst = d; }
            if (d > 2) { bad++; }
        }
    }
    check(bad === 0, name + ' 逐像素灰度与原图一致（最大偏差 ' + worst + '）',
        bad + ' 个像素超差');
    // 上下颠倒的话，第 0 行会等于期望的最后一行 —— 单独指出这种坏法
    const flipped = got[0][0] === expect[H - 1][0] && got[0][0] !== expect[0][0];
    check(!flipped, name + ' 没有上下颠倒');
}

/* ------------------------------------------------------ OutPicSaver */

console.log('');
console.log('='.repeat(66));
console.log('  D) OutPicSaver：文件名、覆盖、以及图片2 的清理');
console.log('='.repeat(66));

async function testSaver() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scut_saver_'));
    const saver = new OutPicSaver();
    const small = makeRgb(8, 4);
    const small2 = makeRgb(8, 4).map((v) => (v + 100) & 0xFF);

    // 第一次：只有图片1
    saver.save(dir, 8, 4, 'bmp', Buffer.from(small), undefined);
    await waitIdle(saver);
    check(fs.existsSync(path.join(dir, 'OutPic_1.bmp')),
        '生成了 OutPic_1.bmp（名字与用户要求一致）');
    check(!fs.existsSync(path.join(dir, 'OutPic_2.bmp')),
        '没有图片2 时不生成 OutPic_2.bmp');

    // 第二次：两张都有
    saver.save(dir, 8, 4, 'bmp', Buffer.from(small), Buffer.from(small2));
    await waitIdle(saver);
    check(fs.existsSync(path.join(dir, 'OutPic_2.bmp')), '有图片2 时生成 OutPic_2.bmp');

    // 第三次：图片2 又没了 → 必须把旧文件删掉
    saver.save(dir, 8, 4, 'bmp', Buffer.from(small), undefined);
    await waitIdle(saver);
    check(!fs.existsSync(path.join(dir, 'OutPic_2.bmp')),
        '图片2 消失时旧文件被删掉（否则用户会对着上次的图调参）');

    // 覆盖而不是堆积：连存 5 帧后目录里仍然只有两个文件
    for (let i = 0; i < 5; i++) {
        saver.save(dir, 8, 4, 'png', Buffer.from(small), Buffer.from(small2));
    }
    await waitIdle(saver);
    const files = fs.readdirSync(dir).sort();
    check(files.join(',') === 'OutPic_1.png,OutPic_2.png',
        '换格式后只留 png 两个文件（不累积、不产生 _1_2 之类）', files.join(','));
    check(!fs.existsSync(path.join(dir, 'OutPic_1.bmp')),
        '换格式不会把旧后缀的文件留在工程根');

    // 串行 + 合并：连点二十次，最终内容必须是最后一次
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'scut_saver2_'));
    const s2 = new OutPicSaver();
    for (let i = 0; i < 20; i++) {
        const v = Buffer.alloc(8 * 4 * 3, i);
        s2.save(dir2, 8, 4, 'bmp', v, undefined);
    }
    await waitIdle(s2);
    const finalBmp = fs.readFileSync(path.join(dir2, 'OutPic_1.bmp'));
    // 第 19 次的值是 19，解出来第一行第一点应是 19
    const stride2 = 8 * 3;   // 24 已是 4 的倍数，无需补齐
    const firstPixel = finalBmp[54 + (4 - 1) * stride2];
    check(firstPixel === 19, '连发 20 帧后磁盘上是最后一帧（合并写生效）',
        String(firstPixel));

    // 目录不存在 → 报错而不是崩
    let errMsg = '';
    const s3 = new OutPicSaver();
    s3.save(path.join(dir2, '不存在的子目录'), 8, 4, 'bmp', Buffer.from(small),
        undefined, (m) => { errMsg = m; });
    await waitIdle(s3);
    check(errMsg.length > 0, '写盘失败会回调一次错误（不静默、也不抛异常）');
    check(OUT_PIC_NAMES[0] === 'OutPic_1' && OUT_PIC_NAMES[1] === 'OutPic_2',
        '文件名常量就是 OutPic_1 / OutPic_2');
}

function waitIdle(saver) {
    // saver 的写盘是异步的；轮询它的私有 writing 标记直到空转。
    // ★ 用轮询而不是暴露一个 Promise：这是测试，不该为了测试改生产代码的形状。
    return new Promise((resolve) => {
        const tick = () => {
            if (!saver.writing && !saver.pending) {
                resolve();
            } else {
                setTimeout(tick, 5);
            }
        };
        setTimeout(tick, 5);
    });
}

testSaver().then(() => {
    console.log('');
    console.log('='.repeat(66));
    if (failures.length) {
        for (const f of failures) { console.log('  ❌ ' + f); }
        console.log('='.repeat(66));
        console.log('  ❌ 失败  输出图编码（' + checks + ' 项，' + failures.length + ' 项未通过）');
        process.exit(1);
    }
    console.log('  ✅ 通过  输出图编码（' + checks + ' 项）');
    process.exit(0);
});
