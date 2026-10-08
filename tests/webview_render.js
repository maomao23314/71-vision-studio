/**
 * webview_render.js —— 在真实浏览器里渲染 Webview 前端资源并截图
 *
 * 为什么需要它：
 *   Webview 的 DOM 无法从扩展宿主断言（沙箱 + 只能消息传递）。
 *   但我们可以在【真实 Chromium】里把同一份 media/simview.js + simview.css
 *   加载起来，用一个桩替掉 acquireVsCodeApi()，喂进真实的帧与变量数据，
 *   然后截图 —— 这就验证了渲染链路（画布绘制、变量面板、样式、主题变量），
 *   剩下唯一没覆盖到的只有"VS Code 宿主本身"。
 *
 * 用法：
 *   node tests/webview_render.js <工程目录的 .scut/frames>  <输出目录>
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const framesDir = process.argv[2];
const outDir = process.argv[3] || require('os').tmpdir();

// ★ 输出目录必须先建出来。
//   否则 readFileSync(simview.css) 会以 ENOENT 崩掉 —— 报错指向
//   simview.css 不存在，而真正的原因是"输出目录没建"，
//   属于会把人带偏的那类错误信息。
fs.mkdirSync(outDir, { recursive: true });

const root = path.join(__dirname, '..');
const mediaDir = path.join(root, 'extension', 'media');
const simviewJs = fs.readFileSync(path.join(mediaDir, 'simview.js'), 'utf8');
const simviewCss = fs.readFileSync(path.join(mediaDir, 'simview.css'), 'utf8');

/* ---- 从真实 PGM 里取一帧像素，喂给前端 ---- */
function loadPgm(file) {
    const buf = fs.readFileSync(file);
    // 解析 P5 头：P5\n<w> <h>\n255\n
    let pos = 0;
    const nextTok = () => {
        while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
        if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; return nextTok(); }
        let s = pos;
        while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
        return buf.slice(s, pos).toString('ascii');
    };
    nextTok();                       // magic
    const w = parseInt(nextTok(), 10);
    const h = parseInt(nextTok(), 10);
    nextTok();                       // maxval
    pos++;                           // 单个空白
    return { width: w, height: h, gray: Array.from(buf.slice(pos, pos + w * h)) };
}

/* ---- 组织一份"像仿真进程真的发过来"的消息序列 ---- */
const files = fs.existsSync(framesDir)
    ? fs.readdirSync(framesDir).filter((f) => f.endsWith('.pgm')).sort()
    : [];
if (!files.length) {
    console.log('SKIP: 没有 PGM 帧可喂（先跑一次仿真）');
    process.exit(0);
}
const img = loadPgm(path.join(framesDir, files[0]));

// ★ 消息契约以 media/simview.js 里的 switch(msg.type) 为准，
//   并且 values 的【类型】以 simsession.ts 为准：
//     scutsession.ts 里做的是  v.values.split(/\s+/)  ——
//     也就是说：C 侧发来的是空格分隔的【字符串】，
//     而扩展宿主转发给 webview 之前会把它切成【字符串数组】。
//   webview 端 renderSnapshots 用的是 s.values.join(' ')，即期待数组。
//
//   ★ 这一点最初写错过：我在 harness 里直接喂了 C 侧的原始字符串，
//     于是 s.values.join 不存在 → 抛异常 → 画布画不出来、
//     变量值永远停在"（等待数据…）"。
//     症状看着像前端坏了，其实是喂进去的类型不对。
const snapshots = [
    { name: 'g_threshold', values: ['75'], truncated: false, total: 1,
      dims: [], kind: 'SCUT_T_I32' },
    { name: 'g_lost_count', values: ['0'], truncated: false, total: 1,
      dims: [], kind: 'SCUT_T_I32' },
    { name: 'g_left_line', truncated: true, total: 120, kind: 'SCUT_T_I32',
      dims: [120],
      values: Array.from({ length: 24 }, (_, i) => String(i < 18 ? 30 + i * 4 : -1)) },
    { name: 'g_mid_line', truncated: true, total: 120, kind: 'SCUT_T_I32',
      dims: [120],
      values: Array.from({ length: 24 }, (_, i) => String(i < 18 ? 60 + i * 4 : -1)) }
];
const catalog = [
    { name: 'g_threshold', kind: 'SCUT_T_I32', dims: [], total: 1, elemBytes: 4,
      isStruct: false, isPtr: false, isStatic: false, defaultSelected: true },
    { name: 'g_lost_count', kind: 'SCUT_T_I32', dims: [], total: 1, elemBytes: 4,
      isStruct: false, isPtr: false, isStatic: false, defaultSelected: true },
    { name: 'g_left_line', kind: 'SCUT_T_I32', dims: [120], total: 120, elemBytes: 4,
      isStruct: false, isPtr: false, isStatic: false, defaultSelected: true },
    { name: 'g_mid_line', kind: 'SCUT_T_I32', dims: [120], total: 120, elemBytes: 4,
      isStruct: false, isPtr: false, isStatic: false, defaultSelected: true }
];

/* ==========================================================================
 *  取【真实的 HTML 外壳】
 *
 *  ★ 这一点最初踩了坑：simview.js 并不是自己 createElement 出整个界面，
 *    而是按 id 去绑定 simview.ts 生成的那段 HTML 里的元素
 *    （#screen / #vars-list / #toolbar ...）。
 *    只加载 JS+CSS 的"瘦"外壳会让脚本绑到一堆 null，
 *    表现为「发得出 ready，但一个 canvas 都没有」——
 *    看着像渲染坏了，其实是测试没有提供宿主页面。
 *
 *    所以这里调用 simview.ts 里那个真正的 html() 函数来拿外壳，
 *    保证测的是真实产物，而不是我手搓的近似品。
 * ========================================================================== */
function buildShell() {
    // simview.ts 编译后导出了构建 HTML 的类；这里直接读源文件里那段模板字符串
    // 更稳妥的做法是调用编译产物，但它依赖 vscode 模块，无法在纯 Node 下 require。
    // 因此从源码里抽取模板，并把 ${...} 占位替换成 file:// 可用的值。
    const ts = fs.readFileSync(path.join(root, 'extension', 'src', 'simview.ts'), 'utf8');
    const start = ts.indexOf('`<!DOCTYPE html>');
    const end = ts.indexOf('</html>`;', start);
    if (start < 0 || end < 0) {
        throw new Error('没能从 simview.ts 里抽出 HTML 模板');
    }
    let tpl = ts.slice(start + 1, end + '</html>'.length);
    // 占位替换
    tpl = tpl.replace(/\$\{csp\}/g, '');
    tpl = tpl.replace(/\$\{nonce\}/g, 'harness-nonce');
    tpl = tpl.replace(/\$\{styleUri\}/g, 'simview.css');
    tpl = tpl.replace(/\$\{scriptUri\}/g, 'simview.js');
    tpl = tpl.replace(/\$\{surface\}/g, 'panel');
    // 其余未知占位（如 ${webview.cspSource}）清空
    tpl = tpl.replace(/\$\{[^}]*\}/g, '');
    return tpl;
}

let shell;
try {
    shell = buildShell();
    console.log('  ✅ 已从 simview.ts 抽取真实 HTML 外壳 (' + shell.length + ' 字符)');
} catch (e) {
    console.log('  ❌ ' + e.message);
    process.exit(1);
}

// 把资源与外壳落地到同一目录，file:// 下相对引用才有效
fs.writeFileSync(path.join(outDir, 'simview.css'), simviewCss, 'utf8');
fs.writeFileSync(path.join(outDir, 'simview.js'), simviewJs, 'utf8');

const harness = shell.replace(
    '</head>',
    `<style>
  /* 模拟 VS Code 主题变量（真实 webview 里由宿主注入 --vscode-*） */
  :root{
    --vscode-font-family:"Segoe UI",sans-serif;
    --vscode-foreground:#cccccc;
    --vscode-editor-background:#1e1e1e;
    --vscode-sideBar-background:#252526;
    --vscode-panel-border:#3c3c3c;
    --vscode-button-background:#0e639c;
    --vscode-button-foreground:#ffffff;
    --vscode-button-hoverBackground:#1177bb;
    --vscode-input-background:#3c3c3c;
    --vscode-input-foreground:#cccccc;
    --vscode-descriptionForeground:#8b8b8b;
    --vscode-list-hoverBackground:#2a2d2e;
    --vscode-editor-foreground:#d4d4d4;
  }
  body{background:var(--vscode-sideBar-background);margin:0}
</style>
<script>
  // ---- 桩：替掉 VS Code 注入的 API ----
  window.__sent = [];
  window.acquireVsCodeApi = function () {
      return {
          postMessage: function (m) { window.__sent.push(m); },
          getState: function () { return window.__state; },
          setState: function (s) { window.__state = s; }
      };
  };
  window.__errors = [];
  window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
</script></head>`);

// 在真实脚本之后追加喂数据与自检
const feed = `
<script>
  window.__feed = function () {
      var send = function (m) {
          window.dispatchEvent(new MessageEvent('message', { data: m }));
      };
      // 顺序与真实宿主一致：先给变量目录（含勾选状态），再给帧与快照
      send({ type: 'catalog', variables: ${JSON.stringify(catalog)},
             selected: ${JSON.stringify(catalog.map((c) => c.name))} });
      send({ type: 'frame', index: 1,
             width: ${img.width}, height: ${img.height},
             gray: new Uint8Array(${JSON.stringify(img.gray)}),
             timing: { processUs: 258.7, drawUs: 4.2, reportUs: 1.1, frameUs: 295.9,
                       processCycles: 825600, cyclesValid: true } });
      send({ type: 'vars', snapshots: ${JSON.stringify(snapshots)}, frame: 1,
             timing: { processUs: 258.7, drawUs: 4.2, reportUs: 1.1, frameUs: 295.9,
                       processCycles: 825600, cyclesValid: true } });
  };
  window.__result = function () {
      var cs = Array.prototype.slice.call(document.querySelectorAll('canvas'));
      var out = { errors: window.__errors, sent: window.__sent,
                  canvases: cs.length, painted: [] };
      cs.forEach(function (c, i) {
          var rec = { size: c.width + 'x' + c.height, nonzero: 0 };
          try {
              var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
              for (var k = 0; k < d.length; k += 4)
                  if (d[k] || d[k+1] || d[k+2]) rec.nonzero++;
          } catch (e) { rec.err = String(e); }
          out.painted.push(rec);
      });
      var vl = document.getElementById('vars-list');
      out.varItems = vl ? vl.children.length : -1;
      var tp = document.getElementById('t-process');
      out.tProcessText = tp ? tp.textContent : null;
      out.bodyLen = (document.body.innerText || '').length;
      return out;
  };
  window.addEventListener('load', function () {
      try { window.__feed(); } catch (e) { window.__errors.push('feed: ' + e.message); }
      setTimeout(function () {
          var pre = document.createElement('pre');
          pre.id = 'harness-result';
          pre.style.cssText = 'position:fixed;bottom:0;left:0;background:#000;color:#0f0;' +
                              'font:9px monospace;z-index:100000;max-width:100%;white-space:pre-wrap';
          pre.textContent = JSON.stringify(window.__result());
          document.body.appendChild(pre);
      }, 700);
  });
</script>`;
const harnessFull = harness.replace('</body>', feed + '</body>');

const harnessPath = path.join(outDir, 'webview_harness.html');
fs.writeFileSync(harnessPath, harnessFull, 'utf8');
console.log('  harness 写入: ' + harnessPath + '  (' + harnessFull.length + ' 字符)');

/* ---- 用无头 Chrome 真正渲染并截图 ---- */
const chrome = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));
if (!chrome) { console.log('SKIP: 找不到浏览器'); process.exit(0); }

const shot = path.join(outDir, 'webview_shot.png');
const url = 'file:///' + harnessPath.replace(/\\/g, '/');

// 让页面在加载后自动喂数据（DOMContentLoaded 里已挂 __feed）
const rc = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--window-size=420,900',
    '--virtual-time-budget=4000',
    '--screenshot=' + shot,
    url
], { encoding: 'utf8', timeout: 60000 });

console.log('  浏览器退出码: ' + rc.status);
if (fs.existsSync(shot)) {
    console.log('  ✅ 截图生成: ' + shot + '  (' + fs.statSync(shot).size + ' 字节)');
} else {
    console.log('  ❌ 截图未生成');
    if (rc.stderr) console.log('     ' + rc.stderr.slice(0, 400));
}

/* ---- 再用 --dump-dom 抓自检结果（画布是否真的画上了）---- */
const rc2 = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--virtual-time-budget=4000',
    '--dump-dom', url
], { encoding: 'utf8', timeout: 60000 });
const dom = rc2.stdout || '';
const m = /<pre id="harness-result"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
console.log('\n=== 自检结果 ===');
if (!m) {
    console.log('  ❌ 没抓到自检结果（页面脚本可能抛异常）');
    const errs = /HARNESS/.test(dom);
    console.log('     DOM 长度: ' + dom.length + '  含 HARNESS: ' + errs);
} else {
    let r;
    try { r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); }
    catch (e) { console.log('  原始文本: ' + m[1].slice(0, 600)); r = null; }
    if (r) {
        console.log('  JS 错误          : ' + (r.errors && r.errors.length ? JSON.stringify(r.errors) : '无'));
        console.log('  canvas 数量      : ' + r.canvases);
        (r.painted || []).forEach(function (p, i) {
            console.log('  canvas[' + i + ']      : ' + p.size +
                        '  非零像素=' + p.nonzero + (p.err ? '  错误=' + p.err : ''));
        });
        console.log('  变量面板条目数   : ' + r.varItems);
        console.log('  处理时间显示     : ' + JSON.stringify(r.tProcessText));
        console.log('  前端主动发的消息 : ' + JSON.stringify(r.sent).slice(0, 200));

        // 判定
        const painted = (r.painted || []).some((p) => p.nonzero > 0);
        console.log('\n  ==> 渲染判定: ' +
            (r.canvases > 0 && painted && r.varItems > 0 ? '✅ 画面已绘制且变量面板有条目'
                                                          : '❌ 未通过'));
    }
}
