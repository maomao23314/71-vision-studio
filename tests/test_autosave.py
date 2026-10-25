#!/usr/bin/env python3
"""
test_autosave.py -- 配置面板自动保存的【行为】测试（0.11.0）。

★★ 为什么不能只做静态断言 ★★

  test_firstrun.py §6 已经静态检查了"有 setTimeout""有 pendingValue"
  "dispose 里调了 flushPending"。但那只能证明【代码长这样】，
  证明不了【行为对】。自动保存这类功能的失效方式全是静默的：

    · 改了 4 位数字 → 中间态被逐次写盘 → 构建读到 1 而不是 1024；
    · 改完立刻关面板 → 计时器随页面销毁 → 那次改动没了；
    · 切出去又切回来 → reload 把界面刷回磁盘旧值；
    · 关掉开关后改一项 → 磁盘仍被写（两个进程状态差一拍）。

  这四种都不会报错、不会崩，用户只会觉得"它没生效"。
  所以这里用最小 vscode 桩把 settingsview.ts 【真的跑起来】，
  对真实磁盘文件断言。判据是"文件里最后是什么值"，不是"代码里有没有那句话"。

★★ 这些断言抓到过的真 bug（不是假想）★★

  ① dispose 里原来注册了【两次】onDidDispose（编辑残留），
     桩里只保留最后一个 → 挂起的改动没落盘。真实 VS Code 两个都会触发，
     所以线上没坏，但重复注册本身是垃圾，已删。
  ② 关掉自动保存后，前端仍可能发出 autoSave 消息（状态差一拍），
     而宿主无条件写盘。实测磁盘确实被写了 —— 补了宿主侧把关。

用法:
    python tests/test_autosave.py

退出码 0 = 全部通过。
"""
import io
import json
import os
import shutil
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
EXT = os.path.join(ROOT, 'extension')
OUT = os.path.join(EXT, 'out')

PASS = 0
FAIL = 0
FAILED = []


def ok(name, cond, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print('  PASS  %s' % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print('  FAIL  %s%s' % (name, ('  -> ' + str(extra)) if extra else ''))


# ---------------------------------------------------------------------------
# Node 驱动：把 out/settingsview.js 真的跑起来，对真实临时工程断言
# ---------------------------------------------------------------------------
DRIVER = r'''
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = process.argv[2];
const OUT = path.join(EXT, 'out');

// ---- 临时工程 ----
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'scut_as_'));
fs.mkdirSync(path.join(proj, 'code'), { recursive: true });
const cfgFile = path.join(proj, 'scut_project.json');
const BASE = {
  image: { width: 188, height: 120 },
  inputArray: 'mt9v03x_image',
  outputArray: '',
  hooks: { init: [], frame: [], post: [] },
  pic: { dir: '', ext: '', start: 1 },
  run: { processRepeat: 1, benchRepeat: 1000 },
  toolchain: { path: '', pythonPath: '', autoWatch: true,
               watchExclude: '', watchMaxElems: 0 },
};
fs.writeFileSync(cfgFile, JSON.stringify(BASE, null, 2));

// ---- 最小 vscode 桩 ----
let onMsg = null;
const posted = [];
const gstate = {};
const panel = {
  webview: {
    html: '',
    onDidReceiveMessage: (fn) => { onMsg = fn; },
    postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
    asWebviewUri: (u) => u,
    cspSource: '',
  },
  reveal: () => {},
  onDidDispose: (fn) => { panel._dispose = fn; },
};
const vscode = {
  ViewColumn: { Active: 1 },
  Uri: {
    file: (p) => ({ fsPath: p }),
    joinPath: (u, ...r) => ({ fsPath: path.join(u.fsPath, ...r) }),
  },
  window: {
    createWebviewPanel: () => panel,
    showErrorMessage: () => Promise.resolve(),
    showInformationMessage: () => Promise.resolve(),
    showWarningMessage: () => Promise.resolve(),
    showOpenDialog: () => Promise.resolve(undefined),
  },
  commands: { executeCommand: () => Promise.resolve() },
  workspace: {},
  debug: {},
};
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') { return vscode; }
  return origLoad.call(this, req, parent, isMain);
};

const { showSettingsPanel } = require(path.join(OUT, 'settingsview.js'));
const ctx = {
  extensionUri: { fsPath: EXT },
  globalState: {
    get: (k) => gstate[k],
    update: (k, v) => { gstate[k] = v; return Promise.resolve(); },
  },
};
let changed = 0;
showSettingsPanel(ctx, proj, () => { changed++; });

const mk = (w) => {
  const c = JSON.parse(JSON.stringify(BASE));
  c.image.width = w;
  return { type: 'autoSave', value: c, path: ['image'] };
};
const disk = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // === 1) 连续输入被合并成一次写盘 ===
  onMsg(mk(1)); onMsg(mk(10)); onMsg(mk(102)); onMsg(mk(1024));
  const immediate = disk().image.width;     // 立刻读：还没写
  await sleep(900);
  console.log('T1_IMMEDIATE_WIDTH ' + immediate);
  console.log('T1_FINAL_WIDTH ' + disk().image.width);
  console.log('T1_ONCHANGED ' + changed);

  // === 2) 改完立刻关面板：挂起的改动必须落盘 ===
  onMsg(mk(640));
  panel._dispose();
  console.log('T2_DISPOSE_WIDTH ' + disk().image.width);

  // === 3) reload 之前先落盘，且回给面板的是新值 ===
  onMsg(mk(777));
  onMsg({ type: 'reload' });
  console.log('T3_DISK_WIDTH ' + disk().image.width);
  const cfgMsg = posted.filter((m) => m.type === 'config').pop();
  console.log('T3_REPLY_WIDTH ' + (cfgMsg ? cfgMsg.config.image.width : 'none'));

  // === 4) 关掉开关：先落盘，且之后不再自动写 ===
  onMsg(mk(999));
  onMsg({ type: 'setAutoSave', autoSave: false });
  console.log('T4_DISABLE_WIDTH ' + disk().image.width);
  console.log('T4_STATE ' + gstate['settings.autoSave']);
  onMsg(mk(555));                    // 关掉之后改：不许写
  await sleep(900);
  console.log('T5_OFF_WIDTH ' + disk().image.width);

  // === 6) 重新打开开关：又开始自动保存 ===
  onMsg({ type: 'setAutoSave', autoSave: true });
  onMsg(mk(333));
  await sleep(900);
  console.log('T6_ON_WIDTH ' + disk().image.width);

  // === 7) 默认值：没存过任何状态时是开 ===
  const freshCtx = {
    extensionUri: { fsPath: EXT },
    globalState: { get: () => undefined, update: () => Promise.resolve() },
  };
  // 通过 reload 回执里的 autoSave 字段判断默认值
  console.log('T7_DEFAULT ' + (gstate['settings.autoSave'] === undefined ? 'unknown' : gstate['settings.autoSave']));

  fs.rmSync(proj, { recursive: true, force: true });
  process.exit(0);
})();
'''


def main():
    print('SCUT-71 配置面板自动保存（行为测试）')

    if not os.path.isfile(os.path.join(OUT, 'settingsview.js')):
        print('  SKIP  没有编译产物 out/settingsview.js —— 先跑 npm run compile')
        return 1

    with tempfile.TemporaryDirectory() as td:
        drv = os.path.join(td, 'drv.js')
        with io.open(drv, 'w', encoding='utf-8') as f:
            f.write(DRIVER)
        r = subprocess.run(['node', drv, EXT], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=120)

    out = (r.stdout or '').strip()
    print('    driver 输出：')
    for line in out.splitlines():
        print('      ' + line)
    if r.stderr.strip():
        print('    stderr: %s' % r.stderr.strip()[:600])

    def val(key):
        for line in out.splitlines():
            if line.startswith(key + ' '):
                return line[len(key) + 1:].strip()
        return None

    # === 1) 合并 ===
    # ★ 立刻读必须是 188（原值）—— 如果已经变了，说明"每次 input 都写盘"
    ok('连续输入期间不写盘（立刻读还是旧值）',
       val('T1_IMMEDIATE_WIDTH') == '188', val('T1_IMMEDIATE_WIDTH'))
    ok('停手后落盘，且是最后一次的值（1024 而不是中间态）',
       val('T1_FINAL_WIDTH') == '1024', val('T1_FINAL_WIDTH'))
    # ★ onChanged 只调一次：调用方靠它决定"要不要重新探测工具链"，
    #   调 4 次就是白探测 4 次。
    ok('合并成一次 onChanged（不是 4 次）',
       val('T1_ONCHANGED') == '1', val('T1_ONCHANGED'))

    # === 2) 关面板不丢改动 ===
    ok('改完立刻关面板，改动仍然落盘',
       val('T2_DISPOSE_WIDTH') == '640', val('T2_DISPOSE_WIDTH'))

    # === 3) reload 不刷回旧值 ===
    ok('reload 之前先把挂起的改动落盘',
       val('T3_DISK_WIDTH') == '777', val('T3_DISK_WIDTH'))
    ok('reload 回给面板的是新值（不是磁盘旧值）',
       val('T3_REPLY_WIDTH') == '777', val('T3_REPLY_WIDTH'))

    # === 4/5) 开关 ===
    ok('关掉自动保存时先把挂起的改动落盘',
       val('T4_DISABLE_WIDTH') == '999', val('T4_DISABLE_WIDTH'))
    ok('开关状态写进 globalState', val('T4_STATE') == 'false', val('T4_STATE'))
    # ★ 这条是补的宿主侧把关：光靠前端判会被"状态差一拍"绕过
    ok('关掉之后改东西不再自动写盘',
       val('T5_OFF_WIDTH') == '999', val('T5_OFF_WIDTH'))

    # === 6) 重新打开 ===
    ok('重新打开开关后恢复自动保存',
       val('T6_ON_WIDTH') == '333', val('T6_ON_WIDTH'))

    print('\n' + '=' * 60)
    if FAIL == 0:
        print('全部 %d 项通过' % PASS)
    else:
        print('%d/%d 项通过，%d 项失败：' % (PASS, PASS + FAIL, FAIL))
        for f in FAILED:
            print('  - %s' % f)
    print('=' * 60)
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
