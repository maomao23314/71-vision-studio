/**
 * second_session.js —— 第二张图在【会话层】的回归测试。
 *
 * ★ 为什么要单独一个文件：
 *   第二张图这条链路有四段：
 *     C 写缓冲  →  后端写 PPM + 帧 JSON  →  会话读 PPM 组装 FramePacket  →  面板画
 *   两头都有测试（test_outimage.py 测 C/后端，webview_render.js 测面板），
 *   中间那段「会话按开关决定读不读、组装成 rgb2」却没人盯 ——
 *   它坏了的表现是"后端明明写了，面板却永远没有第二张图"，
 *   而且日志里一条错都没有。
 *
 * ★ 怎么测：
 *   simsession.js 只依赖 fs/path/child_process 与 protocol，不碰 vscode
 *   的 API（只 import 类型），所以这里用最小桩顶掉 `vscode` 就能直接驱动
 *   真实会话，跑真实 exe。测的是 out/ 里的产物，不是复制品。
 *
 * 用法：
 *   node tests/second_session.js <工程目录> [with|without]
 *     with    = 算法写过图片2（应当收到 rgb2）
 *     without = 算法没写图片2（后端不发 img2，rgb2 为空）
 *
 * ★ 参数名从 on/off 改成 with/without：那两个词原来指"显示开关"，
 *   而开关已经删掉了。现在区别只在"算法写没写图片2"。
 *
 * 退出码 0 = 通过。
 */
const path = require('path');
const Module = require('module');

// ---- 1) 最小 vscode 桩（simsession 的静态类型 import 在运行时不需要它）----
const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') {
        return { workspace: { getConfiguration: () => ({ get: (k, d) => d }) } };
    }
    return origLoad.apply(this, arguments);
};

const { SimSessionImpl } = require(
    path.join(__dirname, '..', 'extension', 'out', 'simsession.js'));

/* ==========================================================================
 *  场景：with（算法写过图片2）/ without（算法这一帧没画）
 *
 *  ★ without 必须在【同一进程的第二帧】验证，不能换一个不写图片2 的工程 ——
 *    "图片2 被用过"是按【进程】记的账（用过就一直发 img2），
 *    换工程只能证明"另一个工程没发"，证明不了"这一帧没画"。
 *    真正的语义是：进程发 img2 是稳定的，而这一帧没画时那张图是全黑的。
 *    这就是用户会看到的样子 —— 一栏黑图，而不是那一栏消失。
 * ========================================================================== */

const proj = process.argv[2];
const mode = process.argv[3] || 'with';
if (!proj) {
    console.error('用法: node tests/second_session.js <工程目录> [with|without]');
    process.exit(2);
}

/* ★ 写法要兼容 3.x 之外的老 node 不需要 —— 这里用扩展宿主自带的 node。
 *   process.platform 只在 Windows 上 exe 带后缀，其它平台不需要。 */
const exe = path.join(proj, '.scut', 'bin', 'scut_sim.exe');
const session = new SimSessionImpl({ exePath: exe, projectRoot: proj });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const frames = [];
session.onFrame((f) => {
    frames.push(f);
    session.ack(f.index);       // 背压：webview 收到帧后必须回 ack
});

function finish() {
    session.stop();
    console.log('\n' + (fail === 0
        ? ('全部 ' + pass + ' 项通过')
        : (pass + '/' + (pass + fail) + ' 项通过，' + fail + ' 项失败')));
    process.exit(fail === 0 ? 0 : 1);
}

session.start().then(() => {
    /* 推进一步（协议空行 = 重跑当前图）。
     * ★ 这里曾经用 runFrames(1) —— 那个"连续播放"接口已经删掉了。
     *   现在一帧就是一帧，正好也是这一步需要的。 */
    session.step();
    setTimeout(() => {
        const f0 = frames[0] || null;
        ok('收到一帧', !!f0, f0 === null ? '没有帧' : '');
        if (!f0) { finish(); return; }

        ok('主画面有像素（回归：别把主图弄没了）',
           f0.rgb && f0.rgb.length === f0.width * f0.height * 3,
           f0.rgb && f0.rgb.length);

        if (mode === 'with') {
            ok('算法写过图片2 → 带 rgb2（会话真的去读了那张图）',
               !!f0.rgb2, f0.rgb2 ? '' : 'rgb2 为空');
            if (f0.rgb2) {
                ok('rgb2 尺寸与主图一致',
                   f0.rgb2.length === f0.rgb.length,
                   f0.rgb2.length + ' vs ' + f0.rgb.length);
                /* ★ 只验"它是一块独立的缓冲"，不验具体像素值 ——
                 *   画了什么由测试工程决定，写死成某个值会让这条断言
                 *   变成"夹具的镜像"，改夹具就得改这里。 */
                ok('rgb2 与主画面内容不同（是独立缓冲，不是把主图复制一份）',
                   f0.rgb2.some((v, i) => v !== f0.rgb[i]),
                   '前 3 字节: ' + Array.from(f0.rgb2.slice(0, 3)).join(','));
            }
            finish();
            return;
        }

        /* without：等第二帧（算法这一帧不画），看它是不是全黑。 */
        session.step();
        setTimeout(() => {
            const f1 = frames[1] || null;
            ok('第二帧也到了', !!f1, '只有 ' + frames.length + ' 帧');
            if (!f1) { finish(); return; }
            ok('第二帧仍然带 rgb2（对进程来说是"用过就一直发"）',
               !!f1.rgb2, f1.rgb2 ? '' : 'rgb2 为空');
            if (f1.rgb2) {
                ok('这一帧没画 → 图片2 全黑（每帧清空，不残留上一帧）',
                   f1.rgb2.every((v) => v === 0),
                   '非零像素数 ' + f1.rgb2.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0));
            }
            finish();
        }, 1200);
    }, 1200);
}).catch((e) => {
    console.error('会话启动失败：' + (e && e.message ? e.message : e));
    process.exit(1);
});
