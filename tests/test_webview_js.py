#!/usr/bin/env python3
"""
test_webview_js.py -- 在真实 Node 里跑 webview 脚本，证明前端缺陷【真的会发生】。

★★ 为什么需要这一层 ★★

`tests/test_cleanup.py` §13 做的是【静态】检查（"被调用但未定义"的差集）。
静态检查能证明"有个函数没定义"，但不能证明"用户点了按钮会发生什么"。

本次要修的三个前端缺陷，后果都只在【真实执行】时可见：
  B1(a)  renderStructDetail 未定义  → 点「展开字段」ReferenceError
  B1(b)  vars 分支无 try/catch     → 一次抛错让变量区永久停更

所以这里用一个最小 Node 桩（stub）把 `simview.js` 加载起来：
  · 提供 document / window / vscode 的最薄实现；
  · 触发 `case 'vars'` 消息，看 renderVariables 抛错时会发生什么。

★ 为什么不用真实 Chromium（tests/webview_render.js 那么做）：
  那个测试需要完整帧数据和渲染环境，成本高、且只在 run_all_tests 里跑。
  这里要验的是"异常兜底"这一条逻辑，一个桩就够，成本几乎为零。

退出码 0 = 全部通过。
"""
import json
import os
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, ValueError):
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MEDIA = os.path.join(ROOT, 'extension', 'media')

checks = 0
failures = []


def check(cond, msg, extra=''):
    global checks
    checks += 1
    if cond:
        print('  [OK]   %s' % msg)
    else:
        failures.append(msg)
        print('  [FAIL] %s%s' % (msg, ('  -> ' + str(extra)) if extra else ''))


# ---------------------------------------------------------------------------
# Node 侧驱动脚本：加载 simview.js，注入桩，按场景触发
# ---------------------------------------------------------------------------
DRIVER = r'''
const fs = require('fs');
const path = require('path');
const MEDIA = process.argv[2];
const SCENARIO = process.argv[3];

/* ---- 最小 DOM 桩 ----
 * 只实现 simview.js 实际用到的部分。刻意【不】实现 renderStructDetail
 * 相关的任何东西 —— 因为我们要验的就是"它没定义"时的行为。 */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    style: {}, children: [], attrs: {}, _listeners: {},
    _text: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return {left:0, top:0, width:320, height:240}; },
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    getContext() {
      return {
        createImageData(w, h) { return {width:w, height:h, data:new Uint8ClampedArray(w*h*4)}; },
        putImageData() {}, drawImage() {}, clearRect() {},
        fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {},
        lineTo() {}, stroke() {}, fill() {}, arc() {}, closePath() {},
        set fillStyle(v) {}, get fillStyle() { return ''; },
        set strokeStyle(v) {}, get strokeStyle() { return ''; },
        set lineWidth(v) {}, get lineWidth() { return 1; },
        set imageSmoothingEnabled(v) {}, get imageSmoothingEnabled() { return true; }
      };
    },
    click() { (this._listeners.click || []).forEach(fn => fn({preventDefault(){}, target:this})); }
  };
  return el;
}

const registry = {};
function getEl(id) {
  if (!registry[id]) { registry[id] = makeEl('div'); }
  return registry[id];
}

/* 让 getElementById 对未知 id 也返回一个可用元素（脚本会对大量 id 取值） */
const documentStub = {
  body: makeEl('body'),
  getElementById: getEl,
  createElement: makeEl,
  querySelector: () => makeEl('div'),
  querySelectorAll: () => [],
  addEventListener: () => {},
  documentElement: makeEl('html')
};

const listeners = {};
const windowStub = {
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: () => {},
  postMessage: () => {},
  devicePixelRatio: 1,
  innerWidth: 320, innerHeight: 240
};

/* vscode 桥：把 postMessage 记录到 outbox，方便驱动脚本检查 */
const outbox = [];
const vscodeStub = {
  postMessage: (m) => { outbox.push(m); },
  getState: () => null,
  setState: () => {}
};

const sandbox = {
  document: documentStub,
  window: windowStub,
  vscode: vscodeStub,
  acquireVsCodeApi: () => vscodeStub,
  console: console,
  setTimeout: (fn, ms) => setTimeout(fn, 0),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  Uint8Array, Uint8ClampedArray, ArrayBuffer, Math, JSON, Date, String,
  Number, Boolean, Array, Object, Error, RegExp, Map, Set, Promise,
  isFinite, isNaN, parseInt, parseFloat, ResizeObserver: function () {
    this.observe = function () {};
    this.unobserve = function () {};
    this.disconnect = function () {};
  }
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

/* ---- 加载 simview.js ---- */
const src = fs.readFileSync(path.join(MEDIA, 'simview.js'), 'utf8');
const vm = require('vm');
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(src, ctx, {filename: 'simview.js'});
} catch (e) {
  console.log('LOAD_ERROR ' + e.message);
  process.exit(3);
}

/* ---- 工具：往 window 的 message 监听器派发一条消息 ----
 * ★ 刻意【不】在这里 catch：
 *   我们要区分"脚本自己兜住了"和"我的桩兜住了"。
 *   若在桩里 catch，就无法证明缺陷存在 —— 那正是本项目反复强调的
 *   "测试没报错 ≠ 缺陷不存在"。所以这里让异常原样抛出，
 *   由 driver 顶层统一处理并如实报告。 */
function fireMessage(msg) {
  const ls = listeners.message || [];
  ls.forEach(fn => { fn({data: msg}); });
}

/* ---- 场景 ---- */
if (SCENARIO === 'vars_throw') {
  /* 让 renderVariables 内部【真的】抛错。
   *
   * ★ 为什么不能靠"覆盖 sandbox.renderVariables"：
   *   simview.js 整体包在 IIFE 里，`function renderVariables(){}` 是
   *   【闭包内绑定】，不是 sandbox 的属性 —— 覆盖 sandbox 上的同名属性
   *   对内部调用毫无影响。第一版就这么做的，driver 显示"没抛"，
   *   于是下面两条断言全是假绿色。
   *
   * ★ 现在的做法：让 renderVariables 真正会用到的一个 DOM 操作抛错。
   *   `el.varsList.textContent = ''` 是它每次执行的第一行，
   *   所以把这个 setter 换成抛错版本，就能精确命中。
   *   ★ 先确认 renderVariables 真的会碰 varsList（若它为空则本场景失效，
   *     那时必须报"假绿色"而不是安静通过）。
   */
  const VL = getEl('vars-list');
  let touched = false;
  Object.defineProperty(VL, 'textContent', {
    get() { return ''; },
    set(v) { touched = true; throw new TypeError('boom-from-stub'); }
  });

  const msg = {
    type: 'vars', frame: 1,
    timing: {processUs: 1, drawUs: 1, frameUs: 1, processCycles: 1, cyclesValid: true},
    snapshots: [{name: 'g_a', values: ['1'], truncated: false, total: 1}]
  };
  /* ★ 这里【不 catch】：异常要么被脚本自己的 try/catch 吃掉（= 有兜底），
   *   要么一路抛到顶层（= 没有兜底，缺陷存在）。driver 顶层会分别报告。 */
  let escaped = null;
  try {
    fireMessage(msg);
  } catch (e) {
    escaped = e;
  }
  console.log('VARS_ESCAPED ' + JSON.stringify(escaped ? String(escaped).split('\n')[0] : ''));
  console.log('TOUCHED ' + touched);

  /* 另外确认：即使抛了，后续消息仍能被处理（不会永久停摆）。 */
  let after = 'ok';
  try {
    fireMessage({type: 'status', running: false, exePath: null});
  } catch (e) { after = 'blocked: ' + e; }
  console.log('AFTER_STATUS ' + after);
  process.exit(0);
}

if (SCENARIO === 'struct_button') {
  /* 先喂一条 catalog（含一个 SCUT_T_STRUCT 变量），再喂 vars，
   * 然后【点】展开字段按钮 —— 这就是用户真实操作序列。 */
  fireMessage({
    type: 'catalog',
    variables: [{name: 'g_s', kind: 'SCUT_T_STRUCT', dims: [], total: 1,
                 isStatic: false, manual: false, defaultSelected: true,
                 elemBytes: 104, isPtr: false, isStruct: true, declLine: ''}],
    selected: [], hasManifest: true
  });
  fireMessage({
    type: 'vars', frame: 1,
    timing: {processUs: 1, drawUs: 1, frameUs: 1, processCycles: 1, cyclesValid: true},
    snapshots: [{name: 'g_s', values: ['<104B>'], truncated: false, total: 1}]
  });

  /* 找出「展开字段」按钮。renderVariables 会给 SCUT_T_STRUCT/PTR 渲染它。 */
  const found = [];
  function walk(el, depth) {
    if (depth > 8) { return; }
    (el.children || []).forEach(c => {
      if (c.tagName === 'BUTTON' &&
          /展开字段|收起/.test(c.textContent || '')) {
        found.push(c);
      }
      walk(c, depth + 1);
    });
  }
  Object.keys(registry).forEach(id => walk(registry[id], 0));

  if (found.length === 0) {
    console.log('NO_BUTTON');
    process.exit(0);
  }
  /* 点第一个 */
  const btn = found[0];
  let caught = null;
  try {
    btn.click();
  } catch (e) {
    caught = e;
  }
  console.log('CLICK_CAUGHT ' + JSON.stringify(caught ? String(caught).split('\n')[0] : ''));
  process.exit(0);
}

if (SCENARIO === 'pane_toggle') {
  /* 两块画面的折叠。
   *
   * ★ 为什么要专门测：p0/p1 走的是【同一份】setOpen/toggle，但开关存在
   *   panes[i].open 里而不是顶层 state 上。索引写错（点第二块却动了第一块）
   *   时，界面表现是"点第二张图的标题，第一块收起来了"——
   *   只在一块画面上点一次是看不出来的。
   */
  const b0 = getEl('pane-0-body');
  const b1 = getEl('pane-1-body');
  console.log('INIT ' + b0.classList.contains('collapsed'));
  getEl('pane-0-head').click();
  console.log('AFTER ' + b0.classList.contains('collapsed'));
  getEl('pane-0-head').click();
  console.log('BACK ' + b0.classList.contains('collapsed'));
  /* 再点第二块的标题：只该动第二块 */
  getEl('pane-1-head').click();
  console.log('P1 ' + b1.classList.contains('collapsed')
              + ' P0 ' + b0.classList.contains('collapsed'));
  process.exit(0);
}
'''


def run_node(scenario):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False,
                                     encoding='utf-8') as f:
        f.write(DRIVER)
        drv = f.name
    try:
        r = subprocess.run(['node', drv, MEDIA, scenario],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=60)
        return r.stdout.strip(), r.stderr.strip(), r.returncode
    finally:
        os.unlink(drv)


def main():
    print('SCUT-71 webview JS 真实执行测试（最小 DOM 桩）')

    # ---- 场景 1：vars 分支在 renderVariables 抛错时的行为 ----
    print('\n[1] vars 消息分支：renderVariables 抛错时会发生什么')
    out, err, rc = run_node('vars_throw')
    print('    driver: %s' % (out or '(no output)'))
    if err:
        print('    stderr : %s' % err[:400])

    # ★ 先证明这个场景【真的抛了】。若 driver 显示"没抛"，
    #   说明桩没走到那一步 —— 此时下面那条断言是假绿色，必须报失败。
    #
    # ★★ 判据只能是 TOUCHED，不能用 'boom-from-stub' 出现在 stdout 里 ★★
    #   TOUCHED 由 textContent 的 setter 置位，只有 renderVariables
    #   真的执行到那一行才会为 true。
    #   而报错文字【在修好之后就永远打不出来了】—— 它被 simview.js
    #   自己的 try/catch 吃掉，不会冒到桩的顶层。
    #   拿报错文字当判据会造成"修好后反而红"，
    #   于是测试逼着人把兜底拆掉才能变绿 —— 又是一种假信号。
    really_threw = 'TOUCHED true' in out
    check(really_threw,
          '该场景确实让 renderVariables 抛错了（否则本项是假绿色）', out)

    # ★ 再断言"异常被兜住"：没有逃出 message 处理器。
    #   VARS_ESCAPED 为空 = 脚本自己 catch 住了 = 有兜底。
    #   非空 = 一路抛到桩顶层 = 没有 try/catch，缺陷存在。
    check(really_threw and 'VARS_ESCAPED ""' in out,
          '异常没有逃出 message 处理器（有 try/catch 兜底）',
          'rc=%s out=%s' % (rc, out))

    # ★ 最后断言"抛过之后还能继续工作"—— 这是 (b) 的真正价值：
    #   没有兜底时，一次抛错会让后续所有消息都走不到。
    check('AFTER_STATUS ok' in out,
          '抛错后仍能处理后续消息（不会永久停摆）', out)

    # ---- 场景 2：点「展开字段」按钮 ----
    print('\n[2] 点击「展开字段」按钮（B1a 的真实触发路径）')
    out, err, rc = run_node('struct_button')
    print('    driver: %s' % (out or '(no output)'))
    if err:
        print('    stderr : %s' % err[:400])
    if 'NO_BUTTON' in out:
        print('    SKIP  没有渲染出展开按钮（变量清单为空？）')
    else:
        check('CLICK_CAUGHT ""' in out or 'CLICK_CAUGHT null' in out,
              '点击「展开字段」不抛 ReferenceError', out)

    # ---- 场景 3：两块画面的折叠 ----
    print('\n[3] 画面折叠：p0/p1 各自独立')
    out, err, rc = run_node('pane_toggle')
    print('    driver: %s' % (out or '(no output)'))
    if err:
        print('    stderr : %s' % err[:400])
    # ★ 默认【收起】（用户要求）：body 带 collapsed
    check('INIT true' in out, '两块画面默认收起', out)
    check('AFTER false' in out, '点标题后正文展开', out)
    check('BACK true' in out, '再点一次收起（是可切换，不是单向）', out)
    # ★ 关键：点第二块只该动第二块
    check('P1 false P0 true' in out,
          '折叠互不串台（点图片2不会展开图片1）', out)

    print('\n' + '=' * 60)
    if failures:
        print('%d/%d 项通过，%d 项失败：' % (checks - len(failures), checks,
                                            len(failures)))
        for f in failures:
            print('  - %s' % f)
    else:
        print('全部 %d 项通过' % checks)
    print('=' * 60)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
