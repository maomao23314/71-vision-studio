/**
 * dap_smoke.js —— 真实的 DAP 调试会话验证
 *
 * 目的：证明「调试经 lldb-dap 自动配置」这条链路真的能工作，
 *       而不是只证明 debug.ts 能编译通过。
 *
 * 做法：直接以 lldb-dap 为子进程，按 DAP 规范用
 *       Content-Length 分帧的 JSON 与它通信，走一遍完整流程：
 *         initialize → launch → setBreakpoints → configurationDone
 *         → threads/stackTrace/scopes/variables → 断开
 *
 * 这与 VS Code 内部做的事【完全一样】，只是没有 UI 外壳。
 * 所以它验证的是真正的适配器连通性，而不是我们对 API 的用法。
 *
 * 用法：
 *   node tests/dap_smoke.js <lldb-dap.exe> <scut_sim.exe> [源文件绝对路径]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const lldbDap = process.argv[2];
const program = process.argv[3];
const sourceFile = process.argv[4] || '';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

if (!lldbDap || !fs.existsSync(lldbDap)) { console.log('SKIP: lldb-dap 不存在'); process.exit(0); }
if (!program || !fs.existsSync(program)) { console.log('SKIP: 目标程序不存在'); process.exit(0); }

const child = spawn(lldbDap, [], { stdio: ['pipe', 'pipe', 'pipe'] });

/* ---- DAP 分帧解析：Content-Length: N\r\n\r\n<JSON> ---- */
let buf = Buffer.alloc(0);
const handlers = new Map();   // request_seq -> {resolve, reject}
let seq = 1;
const events = [];

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
        } else if (msg.type === 'response') {            const h = handlers.get(msg.request_seq);
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

function waitEvent(name, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    return new Promise((resolve) => {
        const tick = () => {
            const e = events.find(x => x.event === name);
            if (e) return resolve(e);
            if (Date.now() > deadline) return resolve(null);
            setTimeout(tick, 50);
        };
        tick();
    });
}

async function main() {
    console.log('=== DAP 真实会话（lldb-dap）===');
    console.log('  适配器: ' + lldbDap);
    console.log('  目标  : ' + program + '\n');

    // 1) initialize
    const init = await send('initialize', {
        clientID: 'scut71-test', adapterID: 'scut71',
        pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
        supportsVariableType: true, supportsRunInTerminalRequest: false
    });
    ok('initialize 成功', init.success === true,
       init.message || JSON.stringify(init.body || {}).slice(0, 120));
    const caps = init.body || {};
    console.log('        适配器能力: supportsConfigurationDoneRequest=' +
                caps.supportsConfigurationDoneRequest +
                ', supportsSetBreakpoints=' + (caps.supportsSetBreakpointsRequest !== false));

    // 2) launch —— 关键：只跑 1 帧，避免停在交互循环里出不来
    const launch = await send('launch', {
        program: program,
        cwd: path.dirname(program),
        args: ['--frames', '3', '--advance', '--out', path.join(path.dirname(program), 'frames')],
        stopOnEntry: false,
        terminal: 'console'
    });
    ok('launch 成功（程序已启动）', launch.success === true,
       launch.message || '');

    // 3) setBreakpoints —— 在用户算法里下断点（这是"能不能调试"的实质）
    let bpVerified = 0, bpTotal = 0;
    if (sourceFile && fs.existsSync(sourceFile)) {
        const lines = fs.readFileSync(sourceFile, 'utf8').split(/\r?\n/);
        // 找 SCUT_OutImageSet 或 image_process 所在行，下在真实代码上
        let lineNo = 0;
        for (let i = 0; i < lines.length; i++) {
            if (/SCUT_OutImageSet\s*\(/.test(lines[i])) { lineNo = i + 1; break; }
        }
        if (!lineNo) {
            for (let i = 0; i < lines.length; i++) {
                if (/SCUT_Register\s*\(\s*SCUT_ROLE_PROCESS/.test(lines[i])) { lineNo = i + 1; break; }
            }
        }
        if (lineNo) {
            const bp = await send('setBreakpoints', {
                source: { path: sourceFile },
                breakpoints: [{ line: lineNo }],
                sourceModified: false
            });
            const list = (bp.body && bp.body.breakpoints) || [];
            bpTotal = list.length;
            bpVerified = list.filter(b => b.verified).length;
            ok('断点已下且被适配器接受', bpTotal === 1 && bpVerified === 1,
               JSON.stringify(list).slice(0, 200));
            console.log('        断点位置: ' + path.basename(sourceFile) + ':' + lineNo);
        } else {
            console.log('  SKIP  源文件里没找到合适的断点位置');
        }
    } else {
        console.log('  SKIP  未提供源文件，跳过断点测试');
    }

    // 4) configurationDone —— 放行运行
    const cfgDone = await send('configurationDone', {});
    ok('configurationDone 成功', cfgDone.success === true, cfgDone.message || '');

    // 5) 等断点命中（证明调试器真的能停住用户代码）
    let stopped = await waitEvent('stopped', 20000);
    if (!stopped && bpTotal === 0) {
        // 没下断点就直接等 exited
        console.log('        （未下断点，等程序自行结束）');
    } else {
        ok('命中断点（stopped 事件）', !!stopped,
           stopped ? 'reason=' + stopped.body.reason : '等待超时');
    }

    if (stopped) {
        const tid = stopped.body.threadId;

        // 6) threads
        const th = await send('threads', {});
        const threads = (th.body && th.body.threads) || [];
        ok('threads 返回线程列表', threads.length > 0, String(threads.length));

        // 7) stackTrace —— 读调用栈
        const st = await send('stackTrace', { threadId: tid, levels: 5 });
        const frames = (st.body && st.body.stackFrames) || [];
        ok('stackTrace 返回调用栈', frames.length > 0, String(frames.length));
        if (frames.length) {
            console.log('        栈顶: ' + frames[0].name + '  @ ' +
                        path.basename(frames[0].source ? frames[0].source.path : '?') +
                        ':' + frames[0].line);
            const inUser = frames.some(f => /image_process|my_process|main/.test(f.name));
            ok('调用栈里能看到用户代码', inUser,
               frames.map(f => f.name).join(' <- ').slice(0, 120));

            // 8) scopes + variables —— 这是"像调试器一样看变量"的基础
            const sc = await send('scopes', { frameId: frames[0].id });
            const scopes = (sc.body && sc.body.scopes) || [];
            ok('scopes 返回作用域', scopes.length > 0, String(scopes.length));

            let sawVars = false, sample = '';
            for (const s of scopes) {
                const vr = await send('variables', { variablesReference: s.variablesReference });
                const vars = (vr.body && vr.body.variables) || [];
                if (vars.length) {
                    sawVars = true;
                    sample = vars.slice(0, 4).map(v => v.name + '=' + v.value).join(', ');
                    // 关键：能不能看到我们的全局变量
                    const hit = vars.find(v => /^g_|^s_/.test(v.name));
                    if (hit) {
                        console.log('        在作用域 "' + s.name + '" 里看到: ' + hit.name + ' = ' + hit.value);
                    }
                }
            }
            ok('variables 能读到变量值', sawVars, sample.slice(0, 140));
        }

        // 9) 变通方式证明程序能正常跑完
        //
        // ★ 为什么不能简单地「continue 到底」：
        //   断点下在 `if (g_left_line[y] >= 0)` 上，它在循环体内、每帧执行 120 次。
        //   于是每 continue 一次就立刻再次命中，要放行 240+ 次才跑完 2 帧。
        //   实测确认这不是卡死（lldb CLI 下连续 6 次 continue → 6 次命中，
        //   stop reason 全是 breakpoint 1.1，行为完全正常）。
        //
        //   正确做法：把断点【删掉】再 continue，这样它就能一路跑完。
        //   这同时也验证了 setBreakpoints 的"删除"语义。
        let removed = false;
        if (sourceFile) {
            const clr = await send('setBreakpoints', {
                source: { path: sourceFile }, breakpoints: []
            });
            removed = clr.success === true &&
                      ((clr.body && clr.body.breakpoints) || []).length === 0;
            ok('可以删除断点（setBreakpoints 空列表）', removed,
               JSON.stringify((clr.body && clr.body.breakpoints) || []).slice(0, 120));
        }
        const cont = await send('continue', { threadId: tid });
        ok('continue 成功', cont.success === true, cont.message || '');
    }

    // 10) 等程序结束
    const exited = await waitEvent('exited', 20000);
    const term = await waitEvent('terminated', 5000);
    ok('程序正常结束（exited 事件）', !!exited,
       exited ? 'exitCode=' + exited.body.exitCode : '超时');
    if (exited) { console.log('        退出码: ' + exited.body.exitCode); }
    ok('收到 terminated 事件', !!term);

    // 11) disconnect
    const disc = await send('disconnect', { terminateDebuggee: true });
    ok('disconnect 成功', disc.success === true, disc.message || '');

    console.log('\n' + '='.repeat(52));
    console.log(pass + ' passed, ' + fail + ' failed');
    try { child.kill(); } catch { }
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.log('\n  ❌ 会话异常: ' + e.message);
    try { child.kill(); } catch { }
    process.exit(1);
});
