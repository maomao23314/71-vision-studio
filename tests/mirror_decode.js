#!/usr/bin/env node
/*
 * mirror_decode.js —— 证明「环境解码的是 Input_pic 副本，不是 pic/ 原图」。
 *
 * ★ 为什么需要这条测试（一个容易假绿的地方）：
 *   "副本内容 == 原图" 只能说明【复制成功了】，
 *   完全说明不了解码器读的是哪一条路径 —— 只复制不解码时它同样是绿的。
 *   所以必须让两者【内容不同】，再看画面跟着谁变。
 *
 * 做法（同一次进程内完成，绕开"下次加载会重新复制"）：
 *   1) 起会话、跑一帧 → 副本生成，此刻 源路径+大小+mtime 已记入缓存；
 *   2) 把副本覆盖成【纯白图】；
 *   3) 发一次加载命令 —— 源文件三项都没变，pic_mirror_to_project 命中
 *      快路径【不重写副本】，于是副本保留我们写的纯白；
 *   4) 画面变成接近 255 → 解码读的是副本（正确）；
 *      画面仍是原图亮度 → 解码读的是原图（错误，正是要抓的）。
 *
 * ★★ 为什么用"纯白"而不是"图集里另一张" ★★
 *   试过换另一张：0.png → 1.png 只让平均亮度从 35.96 变到 41.05，
 *   差 5 点。这个差值取决于两张照片恰好多像，图集一换就可能变成 0.3，
 *   断言要么假失败、要么必须放宽到分不清"变了"和"没变"。
 *   纯白是 255，与任何真实路面照片都隔着 200 以上，没有歧义。
 *
 * ★★ 为什么自己写编码器，不用 extension/out/outpic.ts ★★
 *   那是我自己要验的代码，拿它造测试输入等于"自己证明自己"。
 *   这里的 PNG/BMP 编码是完全独立的一份最小实现。
 *
 * ★ 为什么按副本自己的后缀选格式：
 *   副本后缀跟着图集走（.png 图集 → Input_pic.png）。解码器按后缀
 *   选解析器，把 PNG 字节写进 .bmp 文件必然解不开、画面变黑 ——
 *   那也会"变"，但证明不了任何事情。所以格式必须与后缀一致。
 *
 * 用法: node tests/mirror_decode.js <工程目录> [图集目录]
 * 退出码 0 = 通过；非 0 = 未通过。成功时打印 DECODED_FROM_MIRROR。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.dirname(__dirname);
const { SimSessionImpl } = require(path.join(ROOT, 'extension', 'out', 'simsession.js'));

const proj = process.argv[2];
if (!proj) {
    console.error('用法: node tests/mirror_decode.js <工程目录> [图集目录]');
    process.exit(2);
}

/* ★ 图集目录默认 pic/（与 scut_project.json 的 pic.dir 一致）。
 *   有的工程把图摊在 pic/1/ 下，所以允许第二个参数覆盖。 */
const picDir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(proj, 'pic');

const exe = path.join(proj, '.scut', 'bin', 'scut_sim.exe');
const frames = path.join(proj, '.scut', 'frames');

if (!fs.existsSync(exe)) {
    console.error('找不到仿真程序: ' + exe);
    process.exit(2);
}

/** 一帧的平均亮度，用来判断画面是不是纯白。 */
function meanOf(rgb) {
    let sum = 0;
    for (let i = 0; i < rgb.length; i++) {
        sum += rgb[i];
    }
    return sum / rgb.length;
}

/**
 * 在工程根找那个副本。
 *
 * ★ 不写死后缀：副本后缀跟着图集走（.bmp 图集 → Input_pic.bmp）。
 *   写死就只能在一种图集上跑 —— 这正是上一版报"副本没有生成"的原因。
 */
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

/**
 * 发一条控制命令，并等它【真正生效后】那一帧。
 *
 * ★ 为什么用 waitFrame 而不是"数帧数"：
 *   后端在 --step 模式下是「跑完一帧 → fgets 等一行 → 处理命令 → 再跑一帧」。
 *   不写 stdin 就一帧都不来。所以"先挂等待者、再写命令、再等那一个帧"
 *   必然对应命令生效后的画面，不用去猜要等第几帧。
 *   之前按帧号硬数（等 3 帧），多算一帧就超时、少算一帧就拿到命令前的画面。
 */
async function frameAfter(s, cmd) {
    const p = s.waitFrame(15000);
    await cmd();
    const f = await p;
    if (!f) {
        throw new Error('等待命令生效后的帧超时');
    }
    return f;
}

/* ---------------------------------------------------------------- 编码器 */
/* ★ 造替身图的那几个函数已经搬到 tests/whiteimage.js —— 热重载的端到端测试
 *   要用同一套编码器。测试自己复制一份，就会出现"两份实现坏了一份"的
 *   情况，而那种坏法是【假绿】，比失败更糟。 */
const { whiteImageLike } = require('./whiteimage');

(async () => {
    const s = new SimSessionImpl({
        exePath: exe,
        projectRoot: proj,
        picDir,
        frameOutDir: frames,
    });

    s.onFrame((f) => {
        s.ack(f.index);
    });

    // ★ 等待者在 start() 之前挂上：第一帧是启动后自动跑出来的，
    //   挂晚了就错过它，只能靠超时收场。
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
        console.error('');
        console.error('  如果你刚升级过插件，最常见的原因是【可执行文件还是旧的】：');
        console.error('  .scut/bin/scut_sim.exe 是上一版环境编出来的，里面没有这段代码。');
        console.error('  下一步：在插件里点一次「编译仿真程序」，再运行。');
        await s.stop();
        process.exit(1);
    }
    console.log('副本 = ' + path.basename(mirror));

    const before = meanOf(f0.rgb);
    console.log('第一帧平均亮度 = ' + before.toFixed(2));

    if (before > 200) {
        console.error('原图本身接近纯白，无法用"变白"做判据（换一个工程跑这条测试）');
        await s.stop();
        process.exit(1);
    }

    const white = whiteImageLike(mirror, f0.width, f0.height, 255);
    if (!white) {
        console.error('副本后缀不认识，无法造同格式的替身: ' + path.basename(mirror));
        await s.stop();
        process.exit(1);
    }

    const original = fs.readFileSync(mirror);
    const m = /(\d+)\.\w+$/.exec(path.basename(String(f0.pic || '')));
    const idx = m ? Number(m[1]) : 0;

    let after = before;
    let err = null;
    try {
        fs.writeFileSync(mirror, white);
        const f = await frameAfter(s, () => s.gotoPic(idx));
        after = meanOf(f.rgb);
        console.log('副本换成纯白 → 平均亮度 ' + after.toFixed(2));
    } catch (e) {
        err = e;
    } finally {
        // 还原：副本本该是当前这张图的拷贝，测试不该把它留成白图。
        try {
            fs.writeFileSync(mirror, original);
        } catch {
            /* 还原失败不影响结论，下次源文件变化时会自动重写 */
        }
        await s.stop();
    }

    if (err) {
        throw err;
    }

    /* ★ 判据是"白到不可能是真实路面"，不是"正好 255"：
     *   画面是【合成后】的最终图，算法会在上面画绿色标注
     *   （这个工程里是 hi 标记），所以纯白输入得到的平均亮度
     *   实测 244.19，而不是 255。把阈值定在 255 会假失败。
     *   真实路面照片实测 35.96，两者隔着 200 以上，没有歧义。 */
    if (after > 200) {
        console.log('DECODED_FROM_MIRROR');
        console.log('  → 把副本涂白后画面变成 ' + after.toFixed(1)
            + '（原图 ' + before.toFixed(1) + '），解码读的是 Input_pic，不是 pic/ 原图');
        process.exit(0);
    }
    if (Math.abs(after - before) < 1) {
        console.error('FAIL 涂白副本后画面完全没变（' + before.toFixed(2)
            + '）—— 解码读的不是副本');
        process.exit(1);
    }
    console.error('FAIL 画面变了但没变白（' + before.toFixed(2) + ' → '
        + after.toFixed(2) + '）—— 副本没能被解成那张白图');
    process.exit(1);
})().catch((e) => {
    console.error('异常: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
