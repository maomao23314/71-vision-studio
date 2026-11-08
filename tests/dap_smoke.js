/**
 * dap_smoke.js —— 真实的 DAP 调试会话验证（两条链路）
 *
 * 目的：证明「调试经 lldb-dap」这条路真的能工作，而不是只证明 debug.ts 能编译。
 *
 *   ① launch 链路：lldb-dap 自己启动 exe —— 适配器连通性、断点、变量、退出事件。
 *   ② attach 链路（★ 插件现在真正用的那条）：先起一个「会话进程」
 *      （`--json --step --frames 0`，与 SimSession 完全同一套参数），
 *      再让 lldb-dap 附着上去。守的是用户在真机上抱怨过的三件事：
 *        · 附着之后【没人下指令就不该产生新帧】（不能自己往下翻图）；
 *        · 点「下一张」之后才跑下一帧，并且断点命中在那张新图上；
 *        · 断开调试【不能】杀掉会话进程（它同时也是界面在用的那个进程）。
 *
 * 做法：直接以 lldb-dap 为子进程，按 DAP 规范用 Content-Length 分帧的 JSON
 *       通信 —— 与 VS Code 内部做的事完全一样，只是没有 UI 外壳。
 *
 * 用法：
 *   node tests/dap_smoke.js <lldb-dap.exe> <scut_sim.exe> [源文件] [图集目录]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lldbDap = process.argv[2];
const program = process.argv[3];
const sourceFile = process.argv[4] || '';
const picDirArg = process.argv[5] || '';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

if (!lldbDap || !fs.existsSync(lldbDap)) { console.log('SKIP: lldb-dap 不存在'); process.exit(0); }
if (!program || !fs.existsSync(program)) { console.log('SKIP: 目标程序不存在'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个 lldb-dap 客户端。
 *
 * ★ 为什么要工厂而不是几个模块级变量：本文件要跑两条链路
 *   （launch / attach），每条都要自己的一份 DAP 连接与事件流。
 *   共用一套状态会在第二条链路里读到第一条的残留事件，
 *   表现为"stopped 事件早就有了"这种假通过。
 */
function newClient() {
    const child = spawn(lldbDap, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    const handlers = new Map();
    const events = [];
    let seq = 1;

    child.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = buf.slice(0, headerEnd).toString('ascii');
            const m = /Content-Length:\s*(\d+)/i.exec(header);
            if (!m) { buf = buf.slice(headerEnd + 4); continue; }
            const len = parseInt(m[1], 10);
            const start = headerEnd + 4;
            if (buf.length < start + len) return;      // 还没收全
            const body = buf.slice(start, start + len).toString('utf8');
            buf = buf.slice(start + len);
            let msg;
            try { msg = JSON.parse(body); } catch { continue; }
            if (msg.type === 'event') {
                events.push(msg);
            } else if (msg.type === 'response') {
                const h = handlers.get(msg.request_seq);
                if (h) { handlers.delete(msg.request_seq); h(msg); }
            }
        }
    });
    child.stderr.on('data', () => { /* lldb-dap 会往 stderr 说话，忽略 */ });

    function send(command, args) {
        const mySeq = seq++;
        const msg = JSON.stringify({ seq: mySeq, type: 'request', command, arguments: args || {} });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(msg, 'utf8')}\r\n\r\n${msg}`);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                handlers.delete(mySeq);
                reject(new Error('超时: ' + command));
            }, 25000);
            handlers.set(mySeq, (resp) => { clearTimeout(timer); resolve(resp); });
        });
    }

    function waitEvent(name, timeoutMs, from) {
        const deadline = Date.now() + (timeoutMs || 20000);
        const startAt = from || 0;
        return new Promise((resolve) => {
            const tick = () => {
                for (let i = startAt; i < events.length; i++) {
                    if (events[i].event === name) return resolve(events[i]);
                }
                if (Date.now() > deadline) return resolve(null);
                setTimeout(tick, 50);
            };
            tick();
        });
    }

    return { send, waitEvent, events, kill: () => { try { child.kill(); } catch { } } };
}

/**
 * 在源文件里找一行"每帧执行一次"的代码放断点。
 *
 * ★ 为什么要找"每帧一次"的那一行，而不是随便挑一行：
 *   断点下在循环体内（例如 `if (g_left_line[y] >= 0)` 那种）会被连续命中
 *   120 次/帧，测试里每 continue 一次就再停一次，看起来像"卡死"。
 *   所以优先挑「处理函数体的第一行」—— 它每帧只执行一次。
 *
 * ★ 为什么按函数名找而不是找 SCUT_OutImageSet：模板/用户工程的画图调用
 *   各不相同（SCUT_OutImageSet / SCUT_EnvCopyOutput / 直接画线）。
 *   "xxx_process 函数体的第一句"是唯一在所有工程里都成立的位置。
 */
function pickBreakpointLine() {
    if (!sourceFile || !fs.existsSync(sourceFile)) {
        return 0;
    }
    const lines = fs.readFileSync(sourceFile, 'utf8').split(/\r?\n/);

    // ① 处理函数体的第一行可执行语句
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*(?:void|int|static\s+void)\s+\w*process\w*\s*\(/i.test(lines[i])) {
            continue;
        }
        let j = i;
        while (j < lines.length && lines[j].indexOf('{') < 0) { j++; }
        for (j = j + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) {
                continue;
            }
            return j + 1;      // 1-based
        }
    }

    // ② 兜底：第一个 SCUT_ 调用
    for (let i = 0; i < lines.length; i++) {
        if (/SCUT_OutImageSet\s*\(/.test(lines[i])) { return i + 1; }
    }
    return 0;
}

/* ==========================================================================
 * ① launch 链路
 * ======================================================================== */
async function phase1Launch() {
    console.log('=== ① launch 链路（lldb-dap 自己起 exe）===');
    console.log('  适配器: ' + lldbDap);
    console.log('  目标  : ' + program + '\n');

    const cli = newClient();
    const init = await cli.send('initialize', {
        clientID: 'scut71-test', adapterID: 'scut71',
        pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
        supportsVariableType: true, supportsRunInTerminalRequest: false
    });
    ok('initialize 成功', init.success === true,
       init.message || JSON.stringify(init.body || {}).slice(0, 120));

    const launch = await cli.send('launch', {
        program: program,
        cwd: path.dirname(program),
        args: ['--frames', '3', '--advance', '--out', path.join(path.dirname(program), 'frames')],
        stopOnEntry: false,
        terminal: 'console'
    });
    ok('launch 成功（程序已启动）', launch.success === true, launch.message || '');

    const bpLine = pickBreakpointLine();
    let bpTotal = 0, bpVerified = 0;
    if (bpLine) {
        const bp = await cli.send('setBreakpoints', {
            source: { path: sourceFile },
            breakpoints: [{ line: bpLine }],
            sourceModified: false
        });
        const list = (bp.body && bp.body.breakpoints) || [];
        bpTotal = list.length;
        bpVerified = list.filter((b) => b.verified).length;
        ok('断点已下且被适配器接受', bpTotal === 1 && bpVerified === 1,
           JSON.stringify(list).slice(0, 200));
        console.log('        断点位置: ' + path.basename(sourceFile) + ':' + bpLine);
    } else {
        console.log('  SKIP  源文件里没找到合适的断点位置');
    }

    const cfgDone = await cli.send('configurationDone', {});
    ok('configurationDone 成功', cfgDone.success === true, cfgDone.message || '');

    const stopped = await cli.waitEvent('stopped', 20000);
    if (!stopped && bpTotal === 0) {
        console.log('        （未下断点，等程序自行结束）');
    } else {
        ok('命中断点（stopped 事件）', !!stopped,
           stopped ? 'reason=' + stopped.body.reason : '等待超时');
    }

    if (stopped) {
        const tid = stopped.body.threadId;
        const th = await cli.send('threads', {});
        ok('threads 返回线程列表', ((th.body && th.body.threads) || []).length > 0);
        const st = await cli.send('stackTrace', { threadId: tid, levels: 5 });
        const frames = (st.body && st.body.stackFrames) || [];
        ok('stackTrace 返回调用栈', frames.length > 0, String(frames.length));
        if (frames.length) {
            /* ★ 判据用【源文件路径】而不是函数名：
             *   用户工程的函数叫什么都可能（camera_process / image_process /
             *   my_process…），按名字猜会漏；而"栈里有一帧来自用户的 .c"
             *   正是"能调试用户代码"这件事本身。 */
            const want = path.resolve(sourceFile).toLowerCase();
            const inUser = frames.some((f) => f.source && f.source.path
                && path.resolve(f.source.path).toLowerCase() === want);
            ok('调用栈里能看到用户代码', inUser,
               frames.map((f) => f.name).join(' <- ').slice(0, 120));
            const sc = await cli.send('scopes', { frameId: frames[0].id });
            const scopes = (sc.body && sc.body.scopes) || [];
            ok('scopes 返回作用域', scopes.length > 0, String(scopes.length));
            let sawVars = false, sample = '';
            for (const s of scopes) {
                const vr = await cli.send('variables', { variablesReference: s.variablesReference });
                const vars = (vr.body && vr.body.variables) || [];
                if (vars.length) {
                    sawVars = true;
                    sample = vars.slice(0, 4).map((v) => v.name + '=' + v.value).join(', ');
                }
            }
            ok('variables 能读到变量值', sawVars, sample.slice(0, 140));
        }
        // 断点下在循环体里，删掉它才能一路跑完（删除同时也验证 setBreakpoints 语义）
        await cli.send('setBreakpoints', { source: { path: sourceFile }, breakpoints: [] });
        await cli.send('continue', { threadId: tid });
    }

    const exited = await cli.waitEvent('exited', 20000);
    const term = await cli.waitEvent('terminated', 5000);
    ok('程序正常结束（exited 事件）', !!exited,
       exited ? 'exitCode=' + exited.body.exitCode : '超时');
    ok('收到 terminated 事件', !!term);
    await cli.send('disconnect', { terminateDebuggee: true });
    cli.kill();
}

/* ==========================================================================
 * ② attach 链路 —— 插件现在真正用的那条
 * ======================================================================== */
async function phase2Attach() {
    console.log('\n=== ② attach 链路（附着到正在跑的会话进程）===');
    const projRoot = path.resolve(program, '..', '..', '..');   // .scut/bin/x.exe -> 工程根
    const srcPicDir = picDirArg || path.join(projRoot, 'pic', '1');
    const outDir = path.join(os.tmpdir(), 'scut_attach_frames');
    try { fs.mkdirSync(outDir, { recursive: true }); } catch { }

    /* ★ 自己准备一组【连续编号】的图。
     *
     *   后端数图集的方式是"从起始号往后数，遇到缺号就停"。而仓库自带的
     *   夹具按字典序取前几张会得到 1.bmp / 10.bmp / 11.bmp / 12.bmp ——
     *   在后端眼里这只有 1 张图（2.bmp 不存在），于是"上一张/下一张"
     *   根本没得测。这里按编号排序后重命名成 1..N，
     *   让"点下一张 → 真的换到下一张"这条断言有意义。 */
    const myPicDir = path.join(os.tmpdir(), 'scut_attach_pic');
    let picCount = 0;
    let picExt = '.bmp';
    try {
        fs.rmSync(myPicDir, { recursive: true, force: true });
        fs.mkdirSync(myPicDir, { recursive: true });
        const names = fs.readdirSync(srcPicDir)
            .filter((n) => /\.(bmp|png)$/i.test(n))
            .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        for (const n of names.slice(0, 4)) {
            picCount++;
            picExt = path.extname(n).toLowerCase();
            fs.copyFileSync(path.join(srcPicDir, n), path.join(myPicDir, picCount + picExt));
        }
    } catch { picCount = 0; }

    // --- 先起"会话进程"：参数与 SimSession 一字不差 ---
    const appArgs = ['--json', '--step', '--frames', '0', '--out', outDir];
    if (picCount > 0) { appArgs.push('--pic', myPicDir, '--ext', picExt); }
    const app = spawn(program, appArgs, { cwd: projRoot, stdio: ['pipe', 'pipe', 'pipe'] });

    const frames = [];
    let abuf = '';
    let appExit = null;
    app.stdout.on('data', (d) => {
        abuf += d.toString('utf8');
        for (;;) {
            const i = abuf.indexOf('\n');
            if (i < 0) break;
            const line = abuf.slice(0, i);
            abuf = abuf.slice(i + 1);
            if (line.startsWith('{')) {
                try {
                    const o = JSON.parse(line);
                    if (o && o.frame !== undefined) { frames.push(o); }
                } catch { /* 非帧行忽略 */ }
            }
        }
    });
    app.stderr.on('data', () => { });
    app.on('exit', (c) => { appExit = c; });

    const waitFrames = async (n, ms) => {
        const deadline = Date.now() + (ms || 20000);
        while (Date.now() < deadline) {
            if (frames.length >= n) return true;
            await sleep(30);
        }
        return false;
    };

    const got1 = await waitFrames(1);
    ok('会话进程跑完第 1 帧（随后停在 stdin 等命令）', got1, '帧数=' + frames.length);
    if (!got1) { try { app.kill(); } catch { } return; }

    const cli = newClient();
    const init = await cli.send('initialize', {
        clientID: 'scut71-attach-test', adapterID: 'scut71',
        pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
        supportsVariableType: true, supportsRunInTerminalRequest: false
    });
    ok('initialize 成功', init.success === true, init.message || '');

    const bpLine = pickBreakpointLine();
    const at = await cli.send('attach', { pid: app.pid, program: program, stopOnEntry: false });
    ok('attach 请求成功（附着到会话进程）', at.success === true,
       at.message || JSON.stringify(at.body || {}).slice(0, 120));

    if (bpLine) {
        const bp = await cli.send('setBreakpoints', {
            source: { path: sourceFile },
            breakpoints: [{ line: bpLine }],
            sourceModified: false
        });
        const list = (bp.body && bp.body.breakpoints) || [];
        ok('附着之后断点仍被接受', list.length === 1 && list[0].verified === true,
           JSON.stringify(list).slice(0, 160));
    } else {
        console.log('  SKIP  源文件里没找到合适的断点位置（attach 的断点断言跳过）');
    }
    await cli.send('configurationDone', {});

    // ★★ 核心断言 1：附着之后，没人下指令就不许产生新帧 ★★
    const n0 = frames.length;
    await sleep(1500);
    ok('附着之后不会自己往下翻图（没有指令就没有新帧）',
       frames.length === n0, n0 + ' -> ' + frames.length);

    if (bpLine) {
        // ★★ 核心断言 2：点「下一张」→ 才跑下一帧 → 断点命中在那张新图上 ★★
        app.stdin.write('n\n');
        const st = await cli.waitEvent('stopped', 20000);
        ok('点「下一张」之后命中断点（帧由用户驱动）', !!st,
           st ? 'reason=' + st.body.reason : '等待超时');
        if (st) {
            const bt = await cli.send('stackTrace', { threadId: st.body.threadId, levels: 3 });
            ok('断点处能取到调用栈', ((bt.body && bt.body.stackFrames) || []).length > 0);
            // 清掉断点再继续，让这一帧正常跑完（回到界面上）
            await cli.send('setBreakpoints', { source: { path: sourceFile }, breakpoints: [] });
            await cli.send('continue', { threadId: st.body.threadId });
        }
        const got2 = await waitFrames(n0 + 1, 15000);
        ok('继续之后这一帧跑完（画面回到界面）', got2, '帧数=' + frames.length);
        const pic2 = frames.length > n0 ? String(frames[frames.length - 1].pic || '') : '';
        if (picCount > 1) {
            ok('并且用的确实是下一张图', /(^|[\\/])2\.(bmp|png)$/i.test(pic2), pic2 || '(没有新帧)');
        } else {
            console.log('  SKIP  图集只有 ' + picCount + ' 张，"换成下一张"无从验证');
        }
    }

    // ★★ 核心断言 3：断开调试不能顺手杀掉会话进程 ★★
    const n1 = frames.length;
    const disc = await cli.send('disconnect', { terminateDebuggee: false });
    ok('disconnect 成功', disc.success === true, disc.message || '');
    await sleep(800);
    ok('断开调试后会话进程还活着（界面还在用那个进程）', appExit === null, 'exit=' + appExit);
    try { app.stdin.write('\n'); } catch { }
    ok('断开之后照样能继续跑帧', await waitFrames(n1 + 1, 10000),
       n1 + ' -> ' + frames.length);

    try { app.stdin.end(); } catch { }
    await sleep(300);
    try { app.kill(); } catch { }
    cli.kill();
}

async function main() {
    await phase1Launch();
    await phase2Attach();
    console.log('\n' + '='.repeat(52));
    console.log(pass + ' passed, ' + fail + ' failed');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.log('\n  ❌ 会话异常: ' + e.message);
    process.exit(1);
});
