#!/usr/bin/env node
/**
 * cn_path_session.js —— 「中文路径」回归：真的用编译产物跑一遍会话。
 *
 * ★ 为什么必须这么测（而不是断言源码里有某个函数）：
 *   这条缺陷的表现是【画面全黑、不报错】—— 只看代码永远看不出来，
 *   必须让真实后端在真实的中文路径下跑，再看拿到的像素是不是全 0。
 *
 * ★ 测的是什么：
 *   ① 帧输出目录落在【工程内】的 .scut/frames（不再是 %TEMP%）；
 *   ② TEMP 与工程路径都含中文时，帧仍能被读到、且不是全黑；
 *   ③ 顺带守住"帧文件名由插件自己推导"这条：把 JSON 里的 img 弄坏也不影响。
 *
 * 用法（由 run_all_tests.py 调用）：
 *   node tests/cn_path_session.js <extension 目录> <已构建的工程根>
 * 退出码 0 = 通过。
 */
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const EXT = process.argv[2];
const PROJ = process.argv[3];
if (!EXT || !PROJ) {
    console.error('用法: node cn_path_session.js <extension 目录> <工程根>');
    process.exit(2);
}

// ---- 需要 extension/out（编译产物）----
// ★ 不静默跳过：out/ 不在就现编一次；编不出来就【失败】并说清下一步。
//   "因为没编译所以这条不跑了"正是本项目最想避免的那种静默失效。
const compiled = path.join(EXT, 'out', 'simsession.js');
if (!fs.existsSync(compiled)) {
    console.log('  extension/out 不存在，先编译一次…');
    const tsc = spawnSync('npx', ['tsc', '-p', './'], {
        cwd: EXT, shell: true, encoding: 'utf8',
    });
    if (tsc.status !== 0 || !fs.existsSync(compiled)) {
        console.log('  ❌ 编译失败，无法跑中文路径回归。');
        console.log('     下一步：cd extension && npm install && npm run compile');
        console.log((tsc.stderr || tsc.stdout || '').slice(-800));
        process.exit(1);
    }
}

// ---- 最小 vscode 桩（simsession.js 只间接用到一点点）----
const stub = {
    window: { showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {} },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d, update() {} }) },
    Uri: { file: (p) => ({ fsPath: p }), joinPath: () => ({ fsPath: '' }) },
    Disposable: class { constructor(f) { this.dispose = f || (() => {}); } },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    ViewColumn: { One: 1 },
    TreeItem: class {},
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') { return 'vscode-stub'; }
    return origResolve.call(this, request, ...rest);
};
require.cache['vscode-stub'] = {
    id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub,
};

const { SimSessionImpl } = require(path.join(EXT, 'out', 'simsession.js'));

function fail(msg) {
    console.log('  ❌ ' + msg);
    process.exit(1);
}

(async () => {
    // ---- 造一个「账户名是中文」的机器：TEMP 里带中文 ----
    // ★ 这是关键：账户目录名用户改不了，所以插件不能把帧放进去。
    const cnTemp = path.join(os.tmpdir(), 'scut 中文用户', 'AppData', 'Local', 'Temp');
    fs.mkdirSync(cnTemp, { recursive: true });
    process.env.TEMP = cnTemp;
    process.env.TMP = cnTemp;

    // ---- 工程复制到中文路径下（模拟"工程目录名也是中文"）----
    const cnProj = path.join(cnTemp, '中文工程');
    fs.rmSync(cnProj, { recursive: true, force: true });
    fs.mkdirSync(cnProj, { recursive: true });
    // 只需要可执行文件与图集；不必整份拷 .scut（有几百 MB 的核心库）
    fs.mkdirSync(path.join(cnProj, '.scut', 'bin'), { recursive: true });
    const exeName = process.platform === 'win32' ? 'scut_sim.exe' : 'scut_sim';
    fs.copyFileSync(path.join(PROJ, '.scut', 'bin', exeName),
                    path.join(cnProj, '.scut', 'bin', exeName));
    const picSrc = path.join(PROJ, 'pic', '1');
    const picDst = path.join(cnProj, 'pic', '1');
    fs.mkdirSync(picDst, { recursive: true });
    if (fs.existsSync(picSrc)) {
        for (const f of fs.readdirSync(picSrc)) {
            if (/\.(bmp|png)$/i.test(f)) {
                fs.copyFileSync(path.join(picSrc, f), path.join(picDst, f));
            }
        }
    }
    // scut_project.json：后端会读它拿运行期参数
    const cfgSrc = path.join(PROJ, 'scut_project.json');
    if (fs.existsSync(cfgSrc)) {
        fs.copyFileSync(cfgSrc, path.join(cnProj, 'scut_project.json'));
    }

    const exe = path.join(cnProj, '.scut', 'bin', exeName);
    const s = new SimSessionImpl({
        exePath: exe,
        projectRoot: cnProj,
        picDir: picDst,
    });

    const frames = [];
    s.onFrame((f) => { frames.push(f); s.ack(f.index); });   // 必须 ACK，否则背压只放一帧
    await s.start();

    for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 400));
        s.step();
    }
    await new Promise((r) => setTimeout(r, 900));
    try { s.stop(); } catch { /* 已经退了 */ }

    // ---- 断言 ----
    const framesDir = path.join(cnProj, '.scut', 'frames');
    if (!fs.existsSync(framesDir)) {
        fail('帧没有落在工程的 .scut/frames 下：' + framesDir);
    }
    if (frames.length < 2) {
        fail('只收到 ' + frames.length + ' 帧（至少 2 帧）');
    }
    const black = frames.filter((f) => !f.rgb || !f.rgb.some((v) => v !== 0));
    if (black.length > 0) {
        fail(black.length + '/' + frames.length + ' 帧是全黑的'
             + '（中文路径下帧读不到，正是这条缺陷的表现）');
    }
    const wrongSize = frames.filter((f) => f.width !== 188 || f.height !== 120);
    if (wrongSize.length > 0) {
        fail('帧尺寸不对：' + wrongSize[0].width + 'x' + wrongSize[0].height);
    }
    console.log('  ✅ 中文用户名 + 中文工程路径：收到 ' + frames.length
                + ' 帧，全部非黑，帧目录在工程内');
    process.exit(0);
})().catch((e) => {
    console.log('  ❌ 异常：' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
