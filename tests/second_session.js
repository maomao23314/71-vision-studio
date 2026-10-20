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
 *   node tests/second_session.js <工程目录> <on|off>
 *     on  = 开关打开（应当收到 rgb2）
 *     off = 开关关闭（应当【读都不读】，rgb2 为空）
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

const proj = process.argv[2];
const wantOn = (process.argv[3] || 'on') === 'on';
if (!proj) {
    console.error('用法: node tests/second_session.js <工程目录> <on|off>');
    process.exit(2);
}

const exe = path.join(proj, '.scut', 'bin', 'scut_sim.exe');
const session = new SimSessionImpl({
    exePath: exe,
    projectRoot: proj,
    wantSecondImage: () => wantOn,
});

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

let frame = null;
session.onFrame((f) => {
    /* ★ 只留【第一帧】。
     *   测试工程的算法只在第一帧往第二张图里写东西（之后什么都不画），
     *   用来验证"每帧清空"。而 runFrames(1) 会让进程再跑一帧 ——
     *   如果这里保留最后一帧，就永远读到那张被清黑的图，
     *   断言 123 会失败，而失败的原因跟本测试想验的事毫无关系。 */
    if (!frame) {
        frame = f;
    }
    session.ack(f.index);       // 背压：webview 收到帧后必须回 ack
});

session.start().then(() => {
    session.runFrames(1);
    setTimeout(() => {
        ok('收到一帧', !!frame, frame === null ? '没有帧' : '');
        if (frame) {
            ok('主画面有像素（回归：别把主图弄没了）',
               frame.rgb && frame.rgb.length === frame.width * frame.height * 3,
               frame.rgb && frame.rgb.length);
            if (wantOn) {
                ok('开关打开时带着 rgb2（会话真的去读了第二张图）',
                   !!frame.rgb2, frame.rgb2 ? '' : 'rgb2 为空');
                if (frame.rgb2) {
                    ok('rgb2 尺寸与主图一致',
                       frame.rgb2.length === frame.rgb.length,
                       frame.rgb2.length + ' vs ' + frame.rgb.length);
                    /* ★ 只验"它是一块独立的缓冲"，不验具体像素值 ——
                     *   具体画了什么由测试工程决定，写死成某个值会让这条
                     *   断言变成"夹具的镜像"，改夹具就得改这里。 */
                    ok('rgb2 与主画面内容不同（是独立缓冲，不是把主图复制一份）',
                       frame.rgb2.some((v, i) => v !== frame.rgb[i]),
                       '前 3 字节: ' + Array.from(frame.rgb2.slice(0, 3)).join(','));
                }
            } else {
                ok('开关关闭时没有 rgb2（连文件都没读）',
                   !frame.rgb2, frame.rgb2 ? ('长度 ' + frame.rgb2.length) : '');
            }
        }
        session.stop();
        console.log('\n' + (fail === 0
            ? ('全部 ' + pass + ' 项通过')
            : (pass + '/' + (pass + fail) + ' 项通过，' + fail + ' 项失败')));
        process.exit(fail === 0 ? 0 : 1);
    }, 1200);
}).catch((e) => {
    console.error('会话启动失败：' + (e && e.message ? e.message : e));
    process.exit(1);
});
