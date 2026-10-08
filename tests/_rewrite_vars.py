#!/usr/bin/env python3
"""
重写 simview.js 的变量渲染：合并 renderPickList / renderCatalog / renderSnapshots
为单一 renderVariables()，一次遍历同时产出勾选区与查看区，消灭时序竞态。

同时处理用户四条反馈：
  ① catalog handler 没调 renderPickList → 勾选区永远空
  ② 三个渲染函数分离导致时序竞态（修了两次都是补丁）
  ③ 勾选区与查看区"同一组件长得不一样" → 统一 CSS 类
  ④ 计时单位改 cycles（大数用 M），删掉那句"绘图与日志刻意不计入"的说明
"""
import io
import re

JS = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio\extension\media\simview.js"
TS  = r"D:\22车队管理\一轮考核\视觉组\SCUT-71-vision-studio\extension\src\simview.ts"

with io.open(JS, "r", encoding="utf-8") as f:
    js = f.read()

# ---- 1) 用单一 renderVariables() 替换三个渲染函数 ----
NEW = """  /* ==========================================================================
   *  变量渲染 —— 勾选区与查看区【一次遍历同时产出】
   *  --------------------------------------------------------------------------
   *  ★ 为什么合成一个函数（历史教训）：
   *    早期拆成 renderPickList / renderCatalog / renderSnapshots 三个函数，
   *    由 catalog 和 vars 两条消息分别触发。结果是时序竞态：
   *      · catalog handler 忘了调 renderPickList → 勾选区永远空白；
   *      · vars 先到 / catalog 后到 → 值刚填上就被重建清空；
   *      · 修了两次都是补丁，每次只堵住一条路径。
   *    根因是【同一份状态被三段代码各自渲染一遍】—— 只要消息顺序稍有变化，
   *    三者就不同步。现在一条消息进来只调这一个函数，状态→UI 一锤定音。
   *
   *  两个区块的职责（用户要求拆开，但样式要一致）：
   *    · 勾选区（pick-list）：配置 —— 决定观察哪些，改一次放着不动
   *    · 查看区（vars-list）：数据 —— 显示当前帧的值，每帧都变
   * ========================================================================== */
  function renderVariables() {
    var filter = (el.pickFilter && el.pickFilter.value || '').trim().toLowerCase();

    /* ---------- 勾选区 ---------- */
    if (el.pickList) {
      el.pickList.textContent = '';
      if (el.pickCount) {
        el.pickCount.textContent = catalog.length
          ? ('已勾 ' + selected.size + ' / ' + catalog.length) : '';
      }
      if (catalog.length === 0) {
        var e1 = document.createElement('li');
        e1.className = 'pick-empty dim';
        e1.textContent = '还没有变量清单 —— 先点「编译」。';
        el.pickList.appendChild(e1);
      } else {
        var shown = 0;
        for (var i = 0; i < catalog.length; i++) {
          var v = catalog[i];
          if (filter && v.name.toLowerCase().indexOf(filter) < 0) { continue; }
          shown++;
          var li = document.createElement('li');
          li.className = 'pick-item';
          var lab = document.createElement('label');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = selected.has(v.name);
          cb.addEventListener('change', (function (name) {
            return function (ev) {
              if (ev.target.checked) { selected.add(name); }
              else { selected.delete(name); }
              persist();
              notifySelection();
              renderVariables();
            };
          })(v.name));
          lab.appendChild(cb);
          var nm = document.createElement('span');
          nm.className = 'var-name';
          nm.textContent = v.name;
          lab.appendChild(nm);
          var meta = document.createElement('span');
          meta.className = 'var-meta';
          meta.textContent = varMeta(v);
          lab.appendChild(meta);
          li.appendChild(lab);
          el.pickList.appendChild(li);
        }
        if (filter && shown === 0) {
          var none = document.createElement('li');
          none.className = 'pick-empty dim';
          none.textContent = '没有匹配 "' + filter + '" 的变量。';
          el.pickList.appendChild(none);
        }
      }
    }

    /* ---------- 查看区 ---------- */
    if (el.varsList) {
      el.varsList.textContent = '';
      sparkCanvases = {};
      if (el.varsCount) {
        el.varsCount.textContent = catalog.length
          ? (selected.size + ' / ' + catalog.length) : '';
      }
      if (catalog.length === 0) {
        el.varsHint.textContent = '还没有变量清单。先点「编译」。';
        return;
      }
      var picked = [];
      for (var k = 0; k < catalog.length; k++) {
        if (selected.has(catalog[k].name)) { picked.push(catalog[k]); }
      }
      if (picked.length === 0) {
        el.varsHint.textContent = '没有勾选任何变量。展开上面的「选择要观察的变量」勾几个即可（不影响算法运行）。';
        return;
      }
      el.varsHint.textContent = '';

      for (var p = 0; p < picked.length; p++) {
        var cv = picked[p];
        var li2 = document.createElement('li');
        li2.className = 'var-item';
        li2.setAttribute('data-name', cv.name);

        var head = document.createElement('div');
        head.className = 'var-head';
        var nm2 = document.createElement('span');
        nm2.className = 'var-name';
        nm2.textContent = cv.name;
        head.appendChild(nm2);
        var meta2 = document.createElement('span');
        meta2.className = 'var-meta';
        meta2.textContent = varMeta(cv);
        head.appendChild(meta2);
        li2.appendChild(head);

        var body = document.createElement('div');
        body.className = 'var-body';

        var val = document.createElement('div');
        val.className = 'var-value';
        val.setAttribute('data-role', 'value');
        val.textContent = snapshotText(cv.name);
        body.appendChild(val);

        if (cv.kind === 'SCUT_T_STRUCT' || cv.kind === 'SCUT_T_PTR') {
          var det = document.createElement('div');
          det.className = 'struct-detail';
          det.style.display = 'none';
          body.appendChild(det);
          var btn = document.createElement('button');
          btn.className = 'ghost tiny';
          btn.textContent = '展开字段';
          btn.addEventListener('click', (function (node, button, vv) {
            return function () {
              var open = node.style.display !== 'none';
              node.style.display = open ? 'none' : '';
              button.textContent = open ? '展开字段' : '收起';
              if (!open) { renderStructDetail(node, vv); }
            };
          })(det, btn, cv));
          body.appendChild(btn);
        } else {
          var spark = document.createElement('canvas');
          spark.className = 'spark';
          spark.width = 240;
          spark.height = 40;
          spark.setAttribute('data-role', 'spark');
          body.appendChild(spark);
          sparkCanvases[cv.name] = spark;
        }

        li2.appendChild(body);
        el.varsList.appendChild(li2);
      }
      // 画曲线（在所有 <li> 都建好之后统一画，避免边建边查）
      for (var q = 0; q < picked.length; q++) {
        var cv2 = picked[q];
        var sk = sparkCanvases[cv2.name];
        if (!sk) { continue; }
        var snap = snapshotOf(cv2.name);
        var is1D = cv2.dims && cv2.dims.length === 1;
        if (snap && is1D) {
          sk.style.display = '';
          drawSpark(sk, parseNumbers(snap.values));
        }
      }
    }
  }

  function varMeta(v) {
    var dims = (v.dims && v.dims.length) ? v.dims.join('×') : '标量';
    var k = (v.kind || '').replace('SCUT_T_', '');
    return k + ' · ' + dims + (v.isStatic ? ' · static' : '');
  }

  function snapshotOf(name) {
    for (var i = 0; i < snapshots.length; i++) {
      if (snapshots[i].name === name) { return snapshots[i]; }
    }
    return null;
  }

  /** 取某个变量的显示文本；没有快照时返回占位符。 */
  function snapshotText(name) {
    var s = snapshotOf(name);
    if (!s) { return '(等待数据…)'; }
    return s.values.join(' ') + (s.truncated ? ' …（共 ' + s.total + ' 个，只显示前 24 个）' : '');
  }
"""

# 用正则删掉旧的三个函数（从 renderPickList 注释起到 parseNumbers 前的 renderCatalog 结束）
start = js.find('  /* ==========================================================================\n   *  勾选区（pick-list）')
if start < 0:
    start = js.find('  function renderPickList()')
end = js.find('  function parseNumbers(values)')
if start < 0 or end < 0:
    print("!! 找不到旧函数边界")
    sys.exit(1)

js = js[:start] + NEW + "\n" + js[end:]

# ---- 2) catalog handler 与 vars handler 统一调 renderVariables ----
js = js.replace(
    "        renderCatalog();\n        renderSnapshots();\n        return;\n      }\n\n      case 'status': {",
    "        renderVariables();\n        return;\n      }\n\n      case 'status': {")
js = js.replace(
    "        // ★ 必须先重建目录再填值，顺序是【契约】不是优化：\n"
    "//        （长注释段）",
    "        renderVariables();")
# 用正则把 vars case 里那段长注释+两个调用换成一次 renderVariables
js = re.sub(
    r"        // ★ 必须先重建目录再填值.*?renderCatalog\(\);\n        renderSnapshots\(\);\n        return;",
    "        renderVariables();\n        return;",
    js, flags=re.S)
# 清掉所有对旧函数的调用
js = js.replace("renderPickList();", "renderVariables();")
js = js.replace("renderCatalog();", "renderVariables();")
js = js.replace("renderSnapshots();", "renderVariables();")
# 同一行里连续两次 renderVariables 的去重
js = js.replace("renderVariables();\n        renderVariables();", "renderVariables();")
js = js.replace("renderVariables();\n          renderVariables();", "renderVariables();")

with io.open(JS, "w", encoding="utf-8", newline="") as f:
    f.write(js)
print("✅ simview.js 已重写变量渲染")

# ---- 3) TS：计时文案改 cycles、删掉那句说明 ----
with io.open(TS, "r", encoding="utf-8") as f:
    ts = f.read()

old_timing = """        <div class="timing">
          <span title="PROCESS + PRE_FRAME + POST_FRAME 的总耗时（用户算法主体）">处理 <b id="t-process">–</b></span>
          <span title="DRAW 角色耗时（不计入处理时间）">绘图 <b id="t-draw">–</b></span>
          <span title="REPORT 角色耗时（不计入处理时间）">日志 <b id="t-report">–</b></span>
          <span title="整帧耗时（不含呈现后端自身开销）">整帧 <b id="t-frame">–</b></span>
          <span title="处理器周期数">周期 <b id="t-cycles">–</b></span>
          <span title="当前帧号">帧 <b id="t-index">–</b></span>
        </div>
        <div class="timing-note dim">
          绘图与日志【刻意不计入】处理时间 —— 车载程序上没有"画点给屏幕看"这件事，
          算进去会让性能数据失真。
        </div>"""
new_timing = """        <div class="timing">
          <span title="用户算法在当前图上的平均耗时">处理 <b id="t-process">–</b></span>
          <span title="处理器周期数（跨机器可比）">周期 <b id="t-cycles">–</b></span>
          <span title="当前帧号">帧 <b id="t-index">–</b></span>
        </div>"""
if old_timing in ts:
    ts = ts.replace(old_timing, new_timing)
    print("✅ TS: 计时区已改为 周期数为主，删除说明文字")
else:
    print("  ⚠️ 未找到旧计时块（可能已改）")

with io.open(TS, "w", encoding="utf-8", newline="") as f:
    f.write(ts)
