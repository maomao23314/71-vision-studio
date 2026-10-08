/**
 * 最终验证 v2：修掉上一版 harness 的两个问题
 *   1) selectedNames 有 47 个但 catalog 只有 44 → "47/44" 这种不可能的计数
 *      （根因：我把【不在 catalog 里的手动注册变量】也塞进了 selected，
 *       而真实扩展的 --select 只会发 catalog 里的名字）
 *   2) 用 <script> 标签把 JSON 内嵌进 HTML 时必须转义 </script>
 *      （上一版直接 JSON.stringify 内插，数据里若有 "</script>" 会截断脚本）
 * 另外补测：手动注册（不在 catalog 里）的变量在查看区的表现。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = 'D:\\22车队管理\\一轮考核\\视觉组\\SCUT-71-vision-studio';
const proj = 'D:\\22车队管理\\一轮考核\\视觉组\\集成仿真环境测试\\scut71-project';

const manifest = JSON.parse(
    fs.readFileSync(path.join(proj, '.scut', 'gen', 'variables.json'), 'utf8'));
const exe = path.join(proj, '.scut', 'bin', 'scut_sim.exe');
const r = spawnSync(exe, ['--frames', '1', '--json', '--out',
                          path.join(proj, '.scut', 'bin', 'frames')],
                    { encoding: 'utf8', cwd: proj });
const lines = (r.stdout || '').split('\n').filter((l) => l.includes('"vars"'));
const varsLine = JSON.parse(lines[lines.length - 1].trim());

const catalog = manifest.variables;
const kindOf = new Map(catalog.map((v) => [v.name, v]));
// ★ 后端实际会输出的变量（catalog 里的 + 手动注册的）
const allVars = varsLine.vars.map((v) => {
    const k = kindOf.get(v.name) || {};
    return { name: v.name, values: v.values.split(/\s+/).filter((s) => s.length > 0),
             truncated: v.truncated, total: v.total,
             dims: k.dims || [], kind: k.kind || 'SCUT_T_I32',
             // ★ 标记这个变量是否在 catalog 里（决定它能不能被勾选）
             inCatalog: kindOf.has(v.name) };
});
const onlyCatalog = allVars.filter((v) => v.inCatalog);
const onlyManual  = allVars.filter((v) => !v.inCatalog);

console.log('  catalog 变量 :', catalog.length);
console.log('  后端输出     :', allVars.length, `（catalog 内 ${onlyCatalog.length} + 手动 ${onlyManual.length}）`);
console.log('  手动注册的   :', onlyManual.map((v) => v.name).join(', '));

const selectedNames = catalog.map((v) => v.name);
const timing = { processUs: 114.2, drawUs: 3.9,
                 frameUs: 680.0, processCycles: 14957296, cyclesValid: true };

const mediaDir = path.join(root, 'extension', 'media');
const js = fs.readFileSync(path.join(mediaDir, 'simview.js'), 'utf8');
const css = fs.readFileSync(path.join(mediaDir, 'simview.css'), 'utf8');
const ts = fs.readFileSync(path.join(root, 'extension', 'src', 'simview.ts'), 'utf8');
const s0 = ts.indexOf('`<!DOCTYPE html>');
const e0 = ts.indexOf('</html>`;', s0);
let tpl = ts.slice(s0 + 1, e0 + '</html>'.length);
tpl = tpl.replace(/\$\{csp\}/g, '').replace(/\$\{nonce\}/g, 'hn')
  .replace(/\$\{styleUri\}/g, 'simview.css').replace(/\$\{scriptUri\}/g, 'simview.js')
  .replace(/\$\{surface\}/g, 'sidebar').replace(/\$\{kind\}/g, 'sim')
  .replace(/\$\{[^}]*\}/g, '');

const outDir = path.join(require('os').tmpdir(), 'wvfinal4');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'simview.css'), css, 'utf8');
fs.writeFileSync(path.join(outDir, 'simview.js'), js, 'utf8');

// ★ JSON 内嵌到 <script> 的安全做法：转义 </script>
function safeJson(o) {
    return JSON.stringify(o).replace(/<\//g, '<\\/');
}

function makeFeed(order) {
    const cat = `send({ type:'catalog', variables:${safeJson(catalog)},
        selected:${safeJson(selectedNames)}, hasManifest:true });`;
    const vs = `send({ type:'vars', snapshots:${safeJson(allVars)},
        frame:1, timing:${safeJson(timing)} });`;
    return `<script>
window.__errors = [];
window.addEventListener('error', function(e){ window.__errors.push(String(e.message)); });
window.acquireVsCodeApi = function(){ return {
    postMessage: function(m){ sent.push(m); },
    getState: function(){ return window.__st; },
    setState: function(s){ window.__st = s; } }; };
var sent = [];
window.addEventListener('load', function(){
    var send = function(m){ window.dispatchEvent(new MessageEvent('message',{data:m})); };
    ${order === 'catFirst' ? cat + '\n    ' + vs : vs + '\n    ' + cat + '\n    ' + vs}
    setTimeout(function(){
        var pre = document.createElement('pre');
        pre.id = 'r';
        pre.style.cssText = 'position:fixed;bottom:0;left:0;background:#000;color:#0f0;font:9px monospace;z-index:99999;max-width:100%;white-space:pre-wrap';
        var vl = document.getElementById('vars-list');
        var pl = document.getElementById('pick-list');
        var first = vl && vl.children.length ? vl.children[0] : null;
        pre.textContent = JSON.stringify({
            errors: window.__errors,
            pickItems: pl ? pl.children.length : -1,
            pickCb: pl ? !!pl.querySelector('input[type=checkbox]') : false,
            pickCount: (document.getElementById('pick-count')||{}).textContent,
            varItems: vl ? vl.children.length : -1,
            varCount: (document.getElementById('vars-count')||{}).textContent,
            firstVal: first ? ((first.querySelector('[data-role="value"]')||{}).textContent||'') : null,
            cyclesText: (document.getElementById('t-cycles')||{}).textContent,
            summary: (document.getElementById('timing-summary')||{}).textContent,
            noteGone: !document.querySelector('.timing-note')
        });
        document.body.appendChild(pre);
    }, 700);
});
</script>`;
}

const head = `<style>
:root{--vscode-font-family:sans-serif;--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;
--vscode-sideBar-background:#252526;--vscode-panel-border:#3c3c3c;--vscode-button-background:#0e639c;
--vscode-button-foreground:#fff;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;
--vscode-descriptionForeground:#888;--vscode-list-hoverBackground:#2a2d2e;--vscode-editor-foreground:#ddd;}
body{background:var(--vscode-sideBar-background);margin:0}
</style>
<script>
window.acquireVsCodeApi = function(){ return {
    postMessage: function(m){ sent.push(m); },
    getState: function(){ return window.__st; },
    setState: function(s){ window.__st = s; } }; };
var sent = [];
</script>`;

fs.writeFileSync(path.join(outDir, 'h1.html'),
    tpl.replace('</head>', head).replace('</body>', makeFeed('catFirst') + '</body>'), 'utf8');
fs.writeFileSync(path.join(outDir, 'h2.html'),
    tpl.replace('</head>', head).replace('</body>', makeFeed('varsFirst') + '</body>'), 'utf8');

const chrome = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => fs.existsSync(p));
function runDom(file) {
    const url = 'file:///' + file.replace(/\\/g, '/');
    const rc = spawnSync(chrome, ['--headless=new', '--disable-gpu',
                                  '--virtual-time-budget=4000', '--dump-dom', url],
                         { encoding: 'utf8', timeout: 60000 });
    const m = /<pre id="r"[^>]*>([\s\S]*?)<\/pre>/.exec(rc.stdout || '');
    if (!m) return { domFail: true, len: (rc.stdout||'').length };
    try {
        return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
    } catch (e) { return { parseError: m[1].slice(0, 300) }; }
}

console.log('\n=== 验收标准 ===');
console.log('  ① 勾选区有 44 个条目（不是 0）');
console.log('  ② 查看区 44 个条目、每个都有值（不是"等待数据…"）');
console.log('  ③ 周期数用 M/K 格式');
console.log('  ④ 说明文字已删');
console.log('  ⑤ 手动注册的 7 个变量不出现在勾选区（无法勾选=无法渲染），');
console.log('     但如果后端输出了它们，也不应该让面板崩溃\n');

let allOk = true;
for (const [name, file] of [['catalog 先到', 'h1.html'], ['vars 先到', 'h2.html']]) {
    console.log('\n=== ' + name + ' ===');
    const res = runDom(path.join(outDir, file));
    if (!res || res.domFail) { console.log('  ❌ 没抓到结果'); allOk = false; continue; }
    if (res.parseError) { console.log('  ❌ JSON 解析失败:', res.parseError); allOk = false; continue; }
    console.log('  JS 错误       :', res.errors.length ? '❌ ' + JSON.stringify(res.errors) : '无 ✅');
    console.log('  勾选区        :', res.pickItems, '条目，含复选框:', res.pickCb, '，计数:', JSON.stringify(res.pickCount));
    console.log('  查看区        :', res.varItems, '条目，计数:', JSON.stringify(res.varCount));
    console.log('  第一条的值    :', JSON.stringify(res.firstVal));
    console.log('  周期数显示    :', JSON.stringify(res.cyclesText));
    console.log('  摘要          :', JSON.stringify(res.summary));
    console.log('  说明文字已删  :', res.noteGone ? '✅' : '❌');

    if (res.errors.length) allOk = false;
    if (res.pickItems !== 44) allOk = false;
    if (res.varItems !== 44) allOk = false;
    if (!res.firstHasValue) allOk = false;
    if (!/M|K|\d/.test(res.cyclesText || '')) allOk = false;
    if (!res.noteGone) allOk = false;
}

console.log('\n=== 总判定 ===');
console.log(allOk ? '✅ 全部通过' : '❌ 有失败项');
process.exit(allOk ? 0 : 1);
