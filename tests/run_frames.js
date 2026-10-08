/**
 * run_frames.js —— 「运行 / 测速 / 翻页」三条会话路径的真实回归测试。
 *
 * ★ 为什么需要这一层：
 *   这三条路径都依赖【ACK 背压】：仿真进程每跑完一帧就停在 stdin 上，
 *   必须由 webview 确认"这一帧已经显示"（ack）之后，扩展宿主才写下一行。
 *   背压断在哪一环，表现都是"画面停在第 1 帧"——不报错、不崩溃，
 *   只是一动不动。所以这类缺陷必须专门盯住，不能靠"看起来能跑"判断。
 *
 * ★ 为什么要 stub `vscode`：
 *   simsession.js 只用到 vscode.workspace.getConfiguration。
 *   这里用一个最小实现把它顶掉，就能在 Node 里直接驱动真实的会话逻辑，
 *   而不需要开 VS Code。测的是 out/ 里的真实产物，不是复制品。
 *
 * 用法：
 *   node tests/run_frames.js <scut_sim.exe> [工程目录]
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

// ---------------------------------------------------------------------------
// 1) stub vscode：只实现 simsession 用到的那一个 API
// ---------------------------------------------------------------------------
const SETTINGS = {};              // 让测试可以临时改设置
const vscodeStub = {
    workspace: {
        getConfiguration(section) {
            return {
                get(key, dflt) {
                    const full = `${section}.${key}`;
                    return Object.prototype.hasOwnProperty.call(SETTINGS, full)
                        ? SETTINGS[full]
                        : dflt;
                },
            };
        },
    },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return vscodeStub;
    }
    return origLoad.apply(this, arguments);
};

const { SimSessionImpl } = require(
    path.join(__dirname, '..', 'extension', 'out', 'simsession.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/**
 * 启动一个会话，模拟 webview 收到每一帧后自动回 ACK。
 *
 * ★ 这正是 webview 做的事（simview.js 收到帧后 postMessage ack）。
 *   把它写在这里，就等于在 Node 里补齐了背压那一环 ——
 *   而背压断在哪一环，表现都是"画面停在第 1 帧"，不报错。
 *
 * 注意：--step 模式下进程【启动就先跑一帧】再停在 stdin 上，
 * 所以测「runFrames(N) 推进了几帧」必须先排掉那一帧，否则会算多。
 */
function collector(session) {
    const seen = [];
    session.onFrame((f) => {
        seen.push(f);
        session.ack(f.index);          // 模拟 webview 确认
    });

    // 轮询等待：简单且不依赖任何等待者注册的时机，测试里够用。
    async function waitAtLeast(target, timeoutMs) {
        const deadline = Date.now() + (timeoutMs || 15000);
        while (seen.length < target) {
            if (Date.now() > deadline) {
                return false;
            }
            await new Promise((r) => setTimeout(r, 25));
        }
        return true;
    }
    return { seen, waitAtLeast };
}

async function main() {
    const exe = process.argv[2];
    const proj = process.argv[3] || path.dirname(path.dirname(exe));
    if (!exe || !fs.existsSync(exe)) {
        console.log('  SKIP  找不到 scut_sim.exe：' + exe);
        return 0;
    }

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scut_run_'));

    // =====================================================================
    console.log('=== 1. 运行：runFrames(N) 应恰好推进 N 帧（ACK 背压逐帧放行） ===');
    {
        const s = new SimSessionImpl({ exePath: exe, frameOutDir: outDir });
        await s.start();

        const col = collector(s);
        await col.waitAtLeast(1);           // 排掉进程自己跑的第一帧
        await new Promise((r) => setTimeout(r, 300));
        const before = col.seen.length;

        const N = 5;
        s.runFrames(N);
        const reached = await col.waitAtLeast(before + N, 8000);
        // 再等一小会儿：如果多产出了帧，这里能看出来（下面的严格相等断言会失败）
        await new Promise((r) => setTimeout(r, 400));
        const produced = col.seen.length - before;

        ok(`runFrames(${N}) 恰好推进 ${N} 帧`,
            reached && produced === N,
            `实际 ${produced}（${before} -> ${col.seen.length}）`);
        ok('帧号严格递增',
            col.seen.every((f, i) => i === 0 || f.index > col.seen[i - 1].index),
            col.seen.map((f) => f.index).join(','));
        ok('每帧都有图像数据', col.seen.every((f) => f.rgb && f.rgb.length > 0));
        /* 每帧图像必须是 w*h*3 字节（RGB）。若按旧的单通道长度断言，
         * 改 RGB 之后会因为"少了两条通道"而悄悄通过 —— 这里写死 3 倍，
         * 让通道数本身就是被断言的内容。 */
        ok('每帧图像是 RGB 三通道（长度 = w*h*3）',
           col.seen.every((f) => f.rgb.length === f.width * f.height * 3),
           col.seen.map((f) => `${f.width}x${f.height}:${f.rgb.length}`).join(','));
        ok('每帧都带计时', col.seen.every((f) => f.timing && typeof f.timing.processUs === 'number'));
        // ★ drawUs 曾经恒为 0（计时在 sink 之后才发布），这里明确断言非零。
        ok('drawUs 非零（计时在 sink 之前发布）',
            col.seen.some((f) => f.timing.drawUs > 0),
            col.seen.map((f) => f.timing.drawUs).join(','));

        await s.stop();
    }

    // =====================================================================
    console.log('\n=== 2. 测速：b<N> 重复在帧内完成，只推进一帧 ===');
    {
        const s = new SimSessionImpl({ exePath: exe, frameOutDir: outDir });
        await s.start();
        const col = collector(s);
        await col.waitAtLeast(1);
        await new Promise((r) => setTimeout(r, 300));
        const before = col.seen.length;

        s.bench(50);
        await col.waitAtLeast(before + 1, 8000);
        await new Promise((r) => setTimeout(r, 400));
        const produced = col.seen.length - before;

        ok('b<50> 只推进 1 帧（重复在帧内完成）', produced === 1, `实际 ${produced}`);
        const last = col.seen[col.seen.length - 1];
        ok('测速帧带有效计时', last && last.timing && last.timing.processUs > 0,
            last && last.timing ? String(last.timing.processUs) : '无');
        await s.stop();
    }

    // =====================================================================
    console.log('\n=== 3. 翻页：n/p 不重启进程、算法状态保留 ===');
    {
        const s = new SimSessionImpl({ exePath: exe, frameOutDir: outDir });
        await s.start();
        const col = collector(s);
        await col.waitAtLeast(1);
        await new Promise((r) => setTimeout(r, 300));
        const before = col.seen.length;

        s.nextPic();
        await col.waitAtLeast(before + 1, 8000);
        ok('翻页后继续收到帧（进程未重启）', col.seen.length > before,
            `${before} -> ${col.seen.length}`);
        ok('会话仍在运行（没被翻页停掉）', s.running === true);
        await s.stop();
    }

    // =====================================================================
    console.log('\n=== 4. 停止：stop() 后进程确实退出 ===');
    {
        const s = new SimSessionImpl({ exePath: exe, frameOutDir: outDir });
        await s.start();
        ok('启动后 running 为真', s.running === true);
        await s.stop();
        await new Promise((r) => setTimeout(r, 300));
        ok('stop() 之后 running 为假', s.running === false);
    }

    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 临时目录，留着也无妨 */ }

    console.log(`\n${pass + fail} assertions, ${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
    console.error(e);
    process.exit(1);
});
