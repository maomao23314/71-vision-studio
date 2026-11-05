#!/usr/bin/env node
/**
 * test_hotreload.js —— 热重载的判据（extension/out/hotreload.js）。
 *
 * ★★ 这个文件要证明的两件事 ★★
 *
 *   ① 指纹两边一致：C（后端）与 JS（宿主）必须算出同一个 FNV-1a 64。
 *      两边各写一份实现是刻意的（后端不能依赖插件，插件也不该为
 *      一个哈希引一份 C 实现），代价就是"两份实现会不会漂"——
 *      所以这里钉死官方测试向量；跨语言的一致性由
 *      tests/hot_reload_e2e.js 用真实帧里的 inHash 再验一次。
 *
 *   ② "翻页不会多跑一帧"这条承诺真的是判据保证的，不是碰巧。
 *      这是整个功能最容易写错、也最难被发现的地方：
 *      后端翻页时【会重写 Input_pic】，于是文件变化事件必然出现；
 *      如果判据把它当成"用户改了图"，每翻一页就会多跑一帧 ——
 *      画面看不出任何异常，只是算法状态平白前进了一格。
 *      下面用一个"假后端"把这条时序跑一遍，数清楚到底跑了几帧。
 *
 * ★ 为什么要跑 out/ 里的 .js 而不是 src/ 里的 .ts：
 *   hotreload.ts 刻意不 import 'vscode'，编译产物能直接 require；
 *   跑产物还能顺带发现"tsc 漏编"。
 *
 * 用法：node tests/test_hotreload.js
 * 退出码 0 = 全部通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, 'extension', 'out', 'hotreload.js');
const SRC = path.join(ROOT, 'extension', 'src', 'hotreload.ts');
const SIMVIEW = path.join(ROOT, 'extension', 'src', 'simview.ts');

let checks = 0;
const failures = [];

function check(cond, msg, extra) {
    checks += 1;
    if (cond) {
        console.log('  [OK]   ' + msg);
    } else {
        failures.push(msg);
        console.log('  [FAIL] ' + msg + (extra ? '  -> ' + extra : ''));
    }
}

if (!fs.existsSync(OUT)) {
    console.error('找不到编译产物：%s' % OUT);
    console.error('  先跑：cd extension && npx tsc -p ./');
    process.exit(2);
}

const { fnv1a64Hex, decideReload, inputCopyPath } = require(OUT);

/* ======================================================================
 *  1) 指纹：必须与 FNV-1a 64 的官方测试向量逐位一致
 * ====================================================================== */
console.log('\n[1] FNV-1a 64 测试向量');
{
    /* ★ 这三组是 FNV 规范页面给出的 64 位向量。用它们而不是"自己算一遍
     *   再存进测试"：那样只是把实现抄两遍，实现错了测试跟着一起错。 */
    const vec = [
        ['', 'cbf29ce484222325'],
        ['a', 'af63dc4c8601ec8c'],
        ['foobar', '85944171f73967e8'],
    ];
    for (const [text, want] of vec) {
        const got = fnv1a64Hex(Buffer.from(text, 'utf8'));
        check(got === want, `FNV-1a64("${text}") = ${want}`, '实际 ' + got);
    }
    // 长度必须恒为 16（前导零不能丢：0x0abc… 变成 3 位就永远匹配不上）
    const zeroish = fnv1a64Hex(Buffer.from([0]));
    check(/^[0-9a-f]{16}$/.test(zeroish), '指纹恒为 16 位小写十六进制', zeroish);
    // 单字节差异必须改变指纹（判据的全部前提）
    const a = fnv1a64Hex(Buffer.from('picture-a'));
    const b = fnv1a64Hex(Buffer.from('picture-b'));
    check(a !== b, '内容不同 → 指纹不同');
    // 大一点的数据也要能算（真实图 20KB+，走的是另一条循环路径感受不到，
    // 但至少证明不会在长度边界上炸）
    const big = Buffer.alloc(64 * 1024, 7);
    check(/^[0-9a-f]{16}$/.test(fnv1a64Hex(big)), '64 KiB 输入也能算出指纹');
}

/* ======================================================================
 *  2) 副本路径：跟着源图后缀走，不能挑中陈旧的那个副本
 * ====================================================================== */
console.log('\n[2] 副本路径推导');
{
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scut-hot-'));
    try {
        // 源图后缀优先：目录里同时有 .bmp（旧）与 .png（新），
        // 传了 pic 就必须拿 .png —— 否则会一直读那个没人再写的旧文件。
        fs.writeFileSync(path.join(tmp, 'Input_pic.bmp'), 'old');
        fs.writeFileSync(path.join(tmp, 'Input_pic.png'), 'new');
        const p1 = inputCopyPath(tmp, 'pic/1/3.png');
        check(path.basename(p1 || '') === 'Input_pic.png',
            '有源图后缀时按它推导（bmp 与 png 并存也选对）', p1);

        // 没给源图（会话刚开始）→ 扫描兜底，不能崩
        const p2 = inputCopyPath(tmp, undefined);
        check(typeof p2 === 'string' && /Input_pic\.(bmp|png)$/.test(p2),
            '没有源图信息时扫描兜底', p2);

        // 什么都没有 → undefined（判据里"读不到"= 什么都不做）
        const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scut-hot2-'));
        check(inputCopyPath(empty, undefined) === undefined, '目录里没有副本 → undefined');
        fs.rmSync(empty, { recursive: true, force: true });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/* ======================================================================
 *  3) 判据真值表
 * ====================================================================== */
console.log('\n[3] decideReload 判据');
{
    const base = {
        enabled: true,
        running: true,
        framesInFlight: 0,
        loadedHash: 'aaaa',
        fileHash: 'bbbb',
    };
    const D = (patch) => decideReload(Object.assign({}, base, patch));

    check(D({}) === 'reload', '文件真的变了 → reload');
    check(D({ fileHash: 'aaaa' }) === 'ignore', '指纹相同（自己写的回声）→ ignore');
    check(D({ enabled: false }) === 'ignore', '开关关着 → ignore');
    check(D({ running: false }) === 'ignore', '进程没跑 → ignore');
    check(D({ fileHash: undefined }) === 'ignore', '文件读不到（保存到一半/被删）→ ignore');
    check(D({ framesInFlight: 1 }) === 'wait', '有命令在途 → wait（不是 ignore）');
    check(D({ loadedHash: undefined }) === 'ignore',
        '后端没报过指纹（工程根写不了）→ ignore，不无限重载');
    /* ★ 'wait' 与 'ignore' 的区别是【语义】，不是风格：
     *   wait 表示"这次判断不算数，等那一帧落地再判一次"，
     *   ignore 表示"这次判断完成了，什么都不用做"。
     *   把 wait 写成 ignore，用户在那条命令执行期间的编辑会被静默吃掉。 */
    check(D({ framesInFlight: 1, fileHash: 'aaaa' }) === 'wait',
        '在途时即使指纹相同也返回 wait（等落地后再确认）');
}

/* ======================================================================
 *  4) 时序：翻页 vs 外部编辑，数清楚到底跑了几帧
 * ====================================================================== */
console.log('\n[4] 时序模拟（假后端）');
{
    /* 这个"假后端"照着真实的时序走，而且把【事件与帧的先后】显式写出来：
     *   · 收命令 → 后端先重写 Input_pic（写盘发生在跑帧之前）；
     *   · 帧要等算法跑完才回，所以"文件变化事件比帧先到"是常态，
     *     不是边缘情况 —— 这正是最容易写错的那个顺序。
     * 数帧的方式：一次翻页应当正好 1 帧，一次外部保存应当正好 1 帧。 */
    class FakeBackend {
        constructor() {
            this.hash = 'h0';        // 磁盘上副本的内容
            this.loaded = undefined; // 后端上一帧读到的内容
            this.frames = 0;
            this.inFlight = 0;
            this.pendingEvent = false; // 有没有"文件变了"待核对
            this.reloads = 0;
        }
        /** 启动帧。 */
        boot() {
            this.loaded = this.hash;
            this.frames += 1;
        }
        /** 后端收到命令：先重写副本，帧稍后才到（调用 deliverFrame）。 */
        command(newHash) {
            this.inFlight += 1;
            this.hash = newHash;        // ← 写盘
            this.pendingEvent = true;   // ← watcher 随之报一次变化
        }
        /** 命令的帧到达（读的是写完之后的内容）。 */
        deliverFrame() {
            this.loaded = this.hash;
            this.frames += 1;
            if (this.inFlight > 0) { this.inFlight -= 1; }
        }
        /** 外部编辑器保存：只改文件，没有任何命令。 */
        externalEdit(newHash) {
            this.hash = newHash;
            this.pendingEvent = true;
        }
        /** 宿主侧核对一次（真实实现是防抖定时器 + 每帧落地）。返回判据结论。 */
        reconcile() {
            if (!this.pendingEvent) { return 'ignore'; }
            const d = decideReload({
                enabled: true,
                running: true,
                framesInFlight: this.inFlight,
                loadedHash: this.loaded,
                fileHash: this.hash,
            });
            if (d === 'wait') { return d; }   // 保持 pending，等帧落地再判
            this.pendingEvent = false;
            if (d === 'reload') {
                this.reloads += 1;
                this.inFlight += 1;
                this.loaded = this.hash;    // 'r' 命令：重读同一张图 → 一帧
                this.frames += 1;
                if (this.inFlight > 0) { this.inFlight -= 1; }
            }
            return d;
        }
        /**
         * 推演到静止：核对 → 判成 wait 就把在途的那一帧送到 → 再核对。
         *
         * ★ 这里【不能】无脑先送一帧：真实世界里一帧只会来一次，
         *   测试里多送一帧会让"翻页跑了几帧"这个计数变得毫无意义。
         */
        settle() {
            for (let i = 0; i < 10 && this.pendingEvent; i++) {
                const d = this.reconcile();
                if (d === 'wait' && this.inFlight > 0) {
                    this.deliverFrame();
                } else if (d === 'wait') {
                    break;                  // 没有在途帧却在等：判据有问题，别死循环
                }
            }
        }
    }

    // 场景 A：翻页一次，且【文件变化事件比帧先到】（真实顺序）→ 只能 1 帧
    {
        const b = new FakeBackend();
        b.boot();
        const before = b.frames;
        b.command('h1');        // 点「下一张」：后端立刻重写了副本
        b.reconcile();          // 事件先到 —— 此刻帧还没回
        check(b.reloads === 0,
            '翻页时事件先于帧到达，也不会被当成外部编辑（判成等待）');
        b.deliverFrame();       // 「下一张」的帧落地
        b.settle();             // 再核对一次
        check(b.frames - before === 1,
            '翻页总共只跑 1 帧（没有被自己的写入触发第二次加载）',
            '实际跑了 ' + (b.frames - before) + ' 帧');
        check(b.reloads === 0, '翻页不产生热重载');
    }

    // 场景 B：外部编辑器保存 → 正好重载 1 次
    {
        const b = new FakeBackend();
        b.boot();
        const before = b.frames;
        b.externalEdit('h2');
        b.reconcile();
        check(b.reloads === 1, '外部编辑触发 1 次热重载', '实际 ' + b.reloads + ' 次');
        check(b.frames - before === 1, '外部编辑只追加 1 帧',
            '实际 ' + (b.frames - before) + ' 帧');
        check(b.loaded === 'h2', '重载后后端读到的就是新内容');
    }

    // 场景 C：连存两次（两次独立保存）→ 各算一次
    {
        const b = new FakeBackend();
        b.boot();
        b.externalEdit('h3');
        b.settle();
        b.externalEdit('h4');
        b.settle();
        check(b.reloads === 2, '两次独立保存各触发一次', '实际 ' + b.reloads + ' 次');
        check(b.loaded === 'h4', '最终读到的是最后一次保存的内容');
    }

    // 场景 D：帧落地之后才发生的保存 —— 不能被吃掉
    {
        const b = new FakeBackend();
        b.boot();
        b.command('hN');
        b.deliverFrame();       // 翻页这一帧已经处理完了
        b.reconcile();          // 这一帧顺带把副本写完了 → 判成"已加载"
        check(b.reloads === 0, '翻页自己的写入不算热重载');

        b.externalEdit('hAFTER');   // 帧处理完之后用户又保存了一次
        b.reconcile();
        check(b.reloads === 1, '帧落地之后发生的保存会被补上（不会被吃掉）',
            '实际 ' + b.reloads + ' 次');
        check(b.loaded === 'hAFTER', '补上的那次读到了最新内容');
    }

    // 场景 E：保存发生在"命令在途"期间，但后端随后读到的正是这份新内容
    {
        const b = new FakeBackend();
        b.boot();
        b.command('hX');
        b.externalEdit('hY');   // 命令写完之后、帧回来之前，用户又存了一次
        b.reconcile();          // 在途 → wait
        check(b.reloads === 0, '在途期间的保存先判成等待');
        b.deliverFrame();       // 这一帧读到的恰好是 hY
        b.settle();             // 文件与已加载一致 → 不需要再重载
        check(b.reloads === 0, '那一帧已经读到了新内容，不重复加载');
        check(b.loaded === 'hY', '那一帧用的确实是新内容');
    }
}

/* ======================================================================
 *  5) 结构守护：判据只有一处实现
 * ====================================================================== */
console.log('\n[5] 结构守护');
{
    const hot = fs.readFileSync(SRC, 'utf8');
    check(!/from ['"]vscode['"]/.test(hot) && !/require\(['"]vscode['"]\)/.test(hot),
        'hotreload.ts 不依赖 vscode（所以能用普通 Node 测）');
    check(/export function decideReload/.test(hot), 'decideReload 在 hotreload.ts 里导出');

    const sv = fs.readFileSync(SIMVIEW, 'utf8');
    check(/decideReload\(/.test(sv), 'simview.ts 调用 decideReload（没有另写一套判据）');
    check(/hashInputCopy\(/.test(sv), 'simview.ts 用 hashInputCopy 算指纹');
    /* ★ 防止将来有人"顺手"在宿主里再写一份比较：
     *   simview 里不应该出现直接拿两个指纹比较的代码 ——
     *   那种写法会把"在途/开关/读不到"这些分支悄悄漏掉。 */
    check(!/lastInputHash\s*===/.test(sv),
        'simview.ts 不自己比较指纹（判据只在 hotreload.ts 一处）');
    check(/framesInFlight/.test(sv), 'simview.ts 维护在途计数');
    check(/classList\.toggle\('on'/.test(fs.readFileSync(
        path.join(ROOT, 'extension', 'media', 'simview.js'), 'utf8')),
        'webview 按宿主回推的状态高亮按钮（页面不自己记状态）');
}

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
    console.log('全部 %d 项通过', checks);
} else {
    console.log('%d/%d 项通过，%d 项失败：', checks - failures.length, checks, failures.length);
    for (const f of failures) {
        console.log('  - ' + f);
    }
}
console.log('='.repeat(60));
process.exit(failures.length === 0 ? 0 : 1);
