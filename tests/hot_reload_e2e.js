#!/usr/bin/env node
/**
 * hot_reload_e2e.js —— 用【真实的仿真进程】验证热重载的两块地基：
 *
 *   ① 帧 JSON 里的 inHash 就是磁盘上那份 Input_pic 的指纹（两边算法一致）；
 *   ② 发 'r'（协议 reload）之后，进程重读的是【当前磁盘内容】，
 *      而不是"重新从图集复制一遍"。
 *
 * ★ 为什么这条测试必须用真进程：
 *   "发一个命令，进程重新解码"这件事没法在宿主侧脑补出来 ——
 *   它取决于后端怎么处理 'r'、pic_mirror_to_project 会不会把用户改动
 *   覆盖掉、解码器读的是哪条路径。单元测试（test_hotreload.js）只证明
 *   "判据对不对"，证明不了"后端真的照做了"。
 *
 * ★ 判据用"纯白"而不是"图集里另一张"：
 *   换另一张时平均亮度可能只差几个点（真实路面照片彼此都很像），
 *   断言就会在"假失败"和"分不清变没变"之间摇摆。纯白 255 与任何
 *   真实路面都隔着 200 以上，没有歧义。
 *   （这个选择与 mirror_decode.js 同源，那边的头部注释写了完整理由。）
 *
 * 用法: node tests/hot_reload_e2e.js <工程目录> [图集目录]
 * 退出码 0 = 通过；成功时打印 HOT_RELOAD_OK。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.dirname(__dirname);
const { SimSessionImpl } = require(path.join(ROOT, 'extension', 'out', 'simsession.js'));
const { fnv1a64Hex } = require(path.join(ROOT, 'extension', 'out', 'hotreload.js'));
const { whiteImageLike } = require('./whiteimage');

const proj = process.argv[2];
if (!proj) {
    console.error('用法: node tests/hot_reload_e2e.js <工程目录> [图集目录]');
    process.exit(2);
}
const picDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(proj, 'pic');

const exe = path.join(proj, '.scut', 'bin', 'scut_sim.exe');
const frames = path.join(proj, '.scut', 'frames');
if (!fs.existsSync(exe)) {
    console.error('找不到仿真程序: ' + exe);
    process.exit(2);
}

function meanOf(rgb) {
    let sum = 0;
    for (let i = 0; i < rgb.length; i++) {
        sum += rgb[i];
    }
    return sum / rgb.length;
}

/** 在工程根找那份副本（后缀跟着图集走，不写死）。 */
function findMirror() {
    let names;
    try {
        names = fs.readdirSync(proj);
    } catch {
        return undefined;
    }
    const hit = names.filter((n) => /^Input_pic\.[^.]+$/i.test(n));
    return hit.length > 0 ? path.join(proj, hit[0]) : undefined;
}

/** 发一条命令，等它生效后的那一帧。 */
async function frameAfter(s, cmd) {
    const p = s.waitFrame(15000);
    await cmd();
    const f = await p;
    if (!f) {
        throw new Error('等待命令生效后的帧超时');
    }
    return f;
}

function hashOfFile(file) {
    return fnv1a64Hex(fs.readFileSync(file));
}

(async () => {
    const s = new SimSessionImpl({
        exePath: exe,
        projectRoot: proj,
        picDir,
        frameOutDir: frames,
    });
    s.onFrame((f) => { s.ack(f.index); });

    const firstP = s.waitFrame(20000);
    await s.start();
    const f0 = await firstP;
    if (!f0) {
        console.error('启动后没有收到任何帧');
        await s.stop();
        process.exit(1);
    }

    const mirror = findMirror();
    if (!mirror) {
        console.error('副本没有生成：工程根下找不到 Input_pic.*');
        console.error('  .scut/bin/scut_sim.exe 可能是旧版环境编出来的，先在插件里点一次「编译」。');
        await s.stop();
        process.exit(1);
    }
    console.log('副本 = ' + path.basename(mirror));

    let failed = 0;
    function check(cond, msg, extra) {
        console.log((cond ? '  [OK]   ' : '  [FAIL] ') + msg + (cond || !extra ? '' : '  -> ' + extra));
        if (!cond) { failed += 1; }
    }

    /* ---- ① 指纹必须与磁盘内容一致 ---- */
    check(typeof f0.inHash === 'string' && f0.inHash.length === 16,
        '帧 JSON 里带 inHash（16 位十六进制）', String(f0.inHash));
    const disk0 = hashOfFile(mirror);
    check(f0.inHash === disk0,
        'inHash 等于磁盘上 Input_pic 的 FNV-1a 64（C 与 JS 实现一致）',
        'JSON=' + f0.inHash + ' 磁盘=' + disk0);

    const before = meanOf(f0.rgb);
    console.log('第一帧平均亮度 = ' + before.toFixed(2));

    /* ---- ② 改写副本 → 'r' → 画面必须跟着变 ---- */
    const white = whiteImageLike(mirror, f0.width, f0.height, 255);
    if (!white) {
        console.error('副本后缀不认识，无法造同格式的替身: ' + path.basename(mirror));
        await s.stop();
        process.exit(1);
    }
    const original = fs.readFileSync(mirror);
    const picBefore = String(f0.pic || '');

    try {
        fs.writeFileSync(mirror, white);
        const hashWhite = hashOfFile(mirror);
        const f1 = await frameAfter(s, () => s.reloadPic());
        const after = meanOf(f1.rgb);
        console.log('改写副本后 → 平均亮度 ' + after.toFixed(2));

        check(after > 200,
            "发 'r' 之后画面读的是改写后的副本（不是重新从图集复制）",
            before.toFixed(1) + ' -> ' + after.toFixed(1));
        check(f1.inHash === hashWhite,
            '重载那一帧报回的指纹 = 改写后的内容',
            'JSON=' + f1.inHash + ' 磁盘=' + hashWhite);
        check(String(f1.pic || '') === picBefore,
            '重载没有换图（pic 字段不变）',
            picBefore + ' -> ' + String(f1.pic || ''));

        /* ---- ③ 什么都没改时再发 'r'：画面与指纹都不该变 ----
         * ★ 这条防的是"每次重载都重新复制"，那种实现下白图会被
         *   源图覆盖回去 —— 上面那条 check 已经能抓到，但这里再确认
         *   "重复重载是幂等的"，因为热重载按钮会被用户连点。 */
        const f2 = await frameAfter(s, () => s.reloadPic());
        check(Math.abs(meanOf(f2.rgb) - after) < 1,
            '同一内容重复重载，画面不变（幂等）',
            after.toFixed(2) + ' -> ' + meanOf(f2.rgb).toFixed(2));
        check(f2.inHash === hashWhite, '重复重载指纹不变', String(f2.inHash));
    } finally {
        // 还原副本：测试不该把它留成白图。
        try {
            fs.writeFileSync(mirror, original);
        } catch {
            /* 还原失败不影响结论：源文件一变就会自动重写 */
        }
        await s.stop();
    }

    if (failed === 0) {
        console.log('HOT_RELOAD_OK');
        process.exit(0);
    }
    console.error('FAIL 有 ' + failed + ' 项未通过');
    process.exit(1);
})().catch((e) => {
    console.error('异常: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
