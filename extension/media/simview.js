/* ==========================================================================
 *  simview.js —— 仿真视图的 webview 端脚本（纯 JS，无依赖）
 *  --------------------------------------------------------------------------
 *  设计理念对照：
 *    · 模拟单片机 → 这是一个「屏幕」：拿到 RGB 字节就画，不做任何处理
 *    · 上手即用   → 变量勾选、曲线、计时都在一个面板里
 *
 *  ★ 为什么不用框架、不引依赖：
 *    这里的逻辑只有「画 canvas / 收消息 / 发消息」三件事。
 *    引一个打包器会带来构建步骤，而这个 webview 的资源是直接
 *    asWebviewUri 出去的，源码即产物 —— 少一层就少一处会坏的地方。
 *
 *  ★ 协议（权威在宿主侧：src/simview.ts + src/simsesion.ts 的推送点。
 *    本清单必须与那里逐字对齐 —— 它曾经漂移过，见下面两条更正。）
 *
 *    收到 {type:'frame',  index,width,height,rgb,timing,pic}
 *         ★ 曾漏写 pic（宿主 simview.ts 的 onFrame 会带它）。
 *    收到 {type:'vars',   snapshots:[{name,values[],truncated,total,
 *                                    dims,kind,manual}], frame, timing}
 *         ★ 曾漏写 dims/kind/manual（宿主 sendSnapshot 会补齐）。
 *    收到 {type:'catalog',variables:[...], selected:[...], hasManifest}
 *    收到 {type:'status', running, exePath}
 *    收到 {type:'log',    line}
 *
 *    发出 {type:'ack',    index}          ← 背压：必须发，否则会话会卡住
 *    发出 {type:'cmd',    cmd:'stop'|'build'|'debug'|'bench'
 *                             |'prevPic'|'nextPic'|'settings', n?}
 *         ★ 曾写 'run'|'step'|'stop'|'clearLog' —— 四个里三个是错的：
 *           run/step 从未发出（「运行」走宿主侧的 runFrames），
 *           clearLog 是本地清空（见下方 btn-clear 的绑定，不发消息）。
 *           真实取值以 src/simview.ts 的 handleMessage switch 为准。
 *    发出 {type:'select', names:[...]}
 *    发出 {type:'ready'}
 * ========================================================================== */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var KIND = document.body.getAttribute('data-kind') || 'sim';

  // ---- 持久化状态（替代 retainContextWhenHidden，见技术要点 §四）----
  var saved = vscode.getState() || {};
  var state = {
    selected: Array.isArray(saved.selected) ? saved.selected.slice() : null,
    /** 手动缩放系数（仅在 manualZoom=true 时生效）。 */
    zoom: typeof saved.zoom === 'number' ? saved.zoom : 1,
    /**
     * 是否处于手动缩放模式。
     * ★ 默认 false —— 也就是默认"自适应"。用户的三条要求里第一条就是
     *   "除非手动点击 +-，否则自动适应"，所以默认必须是不锁定缩放。
     */
    manualZoom: saved.manualZoom === true,
    /** 实际生效的缩放（自适应时由容器宽度算出，不是用户设的值）。 */
    effectiveZoom: 1,
    /** 平移（用滚动位置表示）。 */
    panX: typeof saved.panX === 'number' ? saved.panX : 0,
    panY: typeof saved.panY === 'number' ? saved.panY : 0,
    timingOpen: saved.timingOpen === true,
    pickOpen: saved.pickOpen === true,
    varsOpen: saved.varsOpen !== false,   // 变量查看默认展开
    logOpen: saved.logOpen === true       // 日志默认折叠（用户要求：别常驻）
  };
  function persist() {
    vscode.setState({
      selected: state.selected,
      zoom: state.zoom,
      manualZoom: state.manualZoom,
      panX: state.panX,
      panY: state.panY,
      timingOpen: state.timingOpen,
      pickOpen: state.pickOpen,
      varsOpen: state.varsOpen,
      logOpen: state.logOpen
    });
  }

  var el = {
    screen: document.getElementById('screen'),
    placeholder: document.getElementById('placeholder'),
    tProcess: document.getElementById('t-process'),
    tCycles: document.getElementById('t-cycles'),
    tIndex: document.getElementById('t-index'),
    timingHeader: document.getElementById('timing-header'),
    timingBody: document.getElementById('timing-body'),
    timingSummary: document.getElementById('timing-summary'),
    pickHeader: document.getElementById('pick-header'),
    pickBody: document.getElementById('pick-body'),
    pickList: document.getElementById('pick-list'),
    pickCount: document.getElementById('pick-count'),
    pickFilter: document.getElementById('pick-filter'),
    varsHeader: document.getElementById('vars-header'),
    varsBody: document.getElementById('vars-body'),
    logHeader: document.getElementById('log-header'),
    logBody: document.getElementById('log-body'),
    logCount: document.getElementById('log-count'),
    picInfo: document.getElementById('pic-info'),
    screenWrap: document.getElementById('screen-wrap'),
    status: document.getElementById('status'),
    varsList: document.getElementById('vars-list'),
    varsCount: document.getElementById('vars-count'),
    varsHint: document.getElementById('vars-hint'),
    log: document.getElementById('log'),
    screenSection: document.getElementById('screen-section'),
    toolbar: document.getElementById('toolbar')
  };

  var ctx = el.screen ? el.screen.getContext('2d', { alpha: false }) : null;
  var catalog = [];
  var snapshots = [];
  var selected = new Set(state.selected || []);
  var selectedInitialised = state.selected !== null;
  var knownNames = {};

  /* ------------------------------------------------------------ 日志 */

  var logLines = [];

  /**
   * 更新日志折叠标题上的行数。
   *
   * ★ 为什么即使折叠着也要更新（用户要求日志默认隐藏）：
   *   折叠起来看不见内容，但用户仍需要知道"有没有新日志"。
   *   标题上显示行数，就能在不展开的情况下判断要不要去看。
   *   否则日志被折起来 = 彻底失去存在感，出错时没人会想到去展开它。
   */
  function updateLogCount() {
    if (!el.logCount) { return; }
    el.logCount.textContent = logLines.length ? (logLines.length + ' 行') : '';
  }

  function log(msg) {
    var stamp = new Date().toLocaleTimeString();
    logLines.push('[' + stamp + '] ' + msg);
    if (logLines.length > 400) {
      logLines = logLines.slice(-300);
    }
    if (el.log) {
      el.log.textContent = logLines.join('\n');
      el.log.scrollTop = el.log.scrollHeight;
    }
    updateLogCount();
  }

  /* -------------------------------------------------------- 图像显示 */

  // ★ 复用同一份 ImageData 与 Uint8ClampedArray，避免每帧分配。
  //   188x120 = 22560 像素，60fps 下每秒分配 1.3 MB 垃圾虽然不算多，
  //   但扩展宿主到 webview 的每次分配都可能触发 GC 抖动，能省就省。
  var imageData = null;
  var rgba = null;
  var frameW = 0;
  var frameH = 0;

  function ensureBuffers(w, h) {
    if (imageData && frameW === w && frameH === h) {
      return;
    }
    frameW = w;
    frameH = h;
    el.screen.width = w;
    el.screen.height = h;
    imageData = ctx.createImageData(w, h);
    rgba = imageData.data;
  }

  /* 图像是 RGB 三通道（每像素 R/G/B 三字节）→ canvas 的 RGBA。
   *
   * ★ alpha 一次性置 255（只在缓冲区重建时做）：每帧都写一遍纯属浪费，
   *   而 alpha 恒为不透明，所以只写一次完全等价。
   * ★ RGB 三字节直接抄进 RGBA 的前三槽即可，不需要任何换算 ——
   *   这正是把输出缓冲从灰度改成真彩色之后最大的好处：
   *   从"灰度扩成三通道"变成了"原样搬运"。 */
  function drawRgb(rgb, w, h) {
    if (!ctx) {
      return;
    }
    ensureBuffers(w, h);
    var n = w * h;
    for (var i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
      rgba[j] = rgb[k];
      rgba[j + 1] = rgb[k + 1];
      rgba[j + 2] = rgb[k + 2];
      rgba[j + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    if (el.placeholder) {
      el.placeholder.style.display = 'none';
    }
    applyZoom();
  }

  /* ==========================================================================
   *  画面缩放 / 平移 / 自适应
   *
   *  ★ 三条行为规则（对应用户的三点要求）：
   *
   *   1) 【默认自适应】—— 不在"手动缩放"状态时，画面宽度始终填满可用宽度。
   *      用户不需要先点一次"适应"才能看清。
   *
   *   2) 【可拖动、可滚轮】—— 放大之后必须能移动视野，否则放大等于白放大
   *      （188×120 放大 6 倍是 1128 像素宽，侧边栏根本放不下）。
   *      拖动用鼠标拖拽；滚轮以【光标位置】为锚点缩放，这样"想细看哪里就
   *      把哪里滚大"，而不是缩放完还要再找位置。
   *
   *   3) 【拖边框后重新自适应】—— 只要用户没有手动缩放过，容器尺寸一变
   *      就重新算缩放。这是最自然的行为：窗口变宽，图跟着变大。
   *      一旦用户手动点过 +/-，就进入"手动模式"，不再自动改缩放
   *      （否则用户精心放大的视野会被一次窗口拖动毁掉）；
   *      但点「适应」或「1:1」可以退回自动模式。
   * ========================================================================== */

  /** 是否处于"手动缩放"模式（用户点过 +/- 或滚轮）。 */
  function isManualZoom() {
    return state.manualZoom === true;
  }

  /** 按当前容器宽度算出"填满"所需的缩放系数。 */
  function fitScale() {
    var wrap = el.screenWrap;
    if (!wrap || frameW <= 0) {
      return 1;
    }
    // 左右各留 10px（padding + 边框 + 可能的滚动条），避免出现横向滚动条
    var avail = Math.max(32, wrap.clientWidth - 20);
    return Math.max(0.2, avail / frameW);
  }

  /** 应用缩放与平移，并同步滚动位置。 */
  function applyZoom() {
    if (!el.screen) {
      return;
    }
    var z = isManualZoom() ? state.zoom : fitScale();
    state.effectiveZoom = z;
    el.screen.style.width = (frameW * z) + 'px';
    el.screen.style.height = (frameH * z) + 'px';
    // 平移通过滚动实现：拖动改 scrollLeft/scrollTop，
    // 这样浏览器原生处理边界，不需要自己钳制。
    if (el.screenWrap) {
      if (typeof state.panX === 'number') { el.screenWrap.scrollLeft = state.panX; }
      if (typeof state.panY === 'number') { el.screenWrap.scrollTop = state.panY; }
    }
  }

  /** 重新自适应（回到自动模式并重新计算）。 */
  function resetToFit() {
    state.manualZoom = false;
    state.zoom = fitScale();
    state.panX = 0;
    state.panY = 0;
    persist();
    applyZoom();
  }

  /** 设置手动缩放（以可选的光标位置为锚点）。 */
  function setZoom(newZoom, anchor) {
    var old = state.effectiveZoom || fitScale();
    var z = Math.max(0.2, Math.min(12, newZoom));
    state.manualZoom = true;
    state.zoom = z;

    // 以光标为锚点：让光标下的那个像素在缩放前后停在原地。
    // 不做锚点的话，滚轮放大时视野会往左上角跑，用户得反复拖回来。
    if (anchor && el.screenWrap) {
      var wrap = el.screenWrap;
      var rect = wrap.getBoundingClientRect();
      var cx = anchor.x - rect.left + wrap.scrollLeft;   // 光标在内容坐标系里的位置
      var cy = anchor.y - rect.top + wrap.scrollTop;
      var k = z / old;
      state.panX = cx * k - (anchor.x - rect.left);
      state.panY = cy * k - (anchor.y - rect.top);
    }
    persist();
    applyZoom();
  }

  /** 读取当前滚动位置，记进 state（供重建后恢复）。 */
  function rememberPan() {
    if (el.screenWrap) {
      state.panX = el.screenWrap.scrollLeft;
      state.panY = el.screenWrap.scrollTop;
    }
  }

  /* -------------------------------------------------------- 计时显示 */

  function fmtUs(v) {
    if (typeof v !== 'number' || !isFinite(v)) {
      return '–';
    }
    if (v >= 1000) {
      return (v / 1000).toFixed(2) + ' ms';
    }
    return v.toFixed(1) + ' µs';
  }

  /**
   * 周期数格式化（用户要求三遍：要 cycles 数，大数用 M 为单位）。
   *
   * ★ 为什么 cycles 才是主显示、µs 只是辅助：
   *   µs 是【墙钟时间】，每台电脑主频不同，同一个算法在不同机器上
   *   差好几倍 —— 没有横向可比性。
   *   周期数是【做了多少工作】的度量，不同机器之间至少量纲一致，
   *   学生横向比较算法优劣时才有参考意义。
   *   大数用 M（百万）为单位：339072 → 0.34 M，14957296 → 14.96 M，
   *   一眼能读，不会数零。
   */
  function fmtCycles(v) {
    if (typeof v !== 'number' || !isFinite(v) || v <= 0) {
      return '–';
    }
    if (v >= 1000000) {
      return (v / 1000000).toFixed(2) + ' M';
    }
    if (v >= 1000) {
      return (v / 1000).toFixed(1) + ' K';
    }
    return String(v);
  }

  function showTiming(t, index) {
    if (!t) {
      return;
    }
    // 周期数放第一位（跨机器可比）；µs 只是本机的参考值
    if (el.tCycles) {
      el.tCycles.textContent = t.cyclesValid && t.processCycles
        ? fmtCycles(t.processCycles)
        : '不可用';
    }
    if (el.tProcess) { el.tProcess.textContent = fmtUs(t.processUs); }
    if (el.tIndex && typeof index === 'number') {
      el.tIndex.textContent = String(index);
    }
    // 折叠状态下的摘要：优先显示周期数（可比），其次才是本机 µs
    if (el.timingSummary) {
      el.timingSummary.textContent =
        (t.cyclesValid && t.processCycles)
          ? (fmtCycles(t.processCycles) + ' cycles')
          : ('处理 ' + fmtUs(t.processUs));
    }
  }

  /* ------------------------------------------------- 通用折叠区块 */

  /**
   * 统一的折叠逻辑。
   *
   * ★ 为什么四个区块共用同一个函数（用户原话："计时菜单为什么要做的跟
   *   变量面版不是同一种组件？"）：
   *   它们本质是同一类东西 —— 可折叠的信息分区。各写一份的结果是
   *   行为不一致（有的记住状态、有的不记；有的标题显示摘要、有的不显示），
   *   用户会觉得"这个界面是拼出来的"。统一成一份，行为自然一致。
   */
  function setOpen(which) {
    var map = {
      timing: [el.timingBody, el.timingHeader, 'timingOpen'],
      pick:   [el.pickBody,   el.pickHeader,   'pickOpen'],
      vars:   [el.varsBody,   el.varsHeader,   'varsOpen'],
      log:    [el.logBody,    el.logHeader,    'logOpen']
    };
    var slot = map[which];
    if (!slot || !slot[0]) {
      return;
    }
    var open = state[slot[2]];
    slot[0].classList.toggle('collapsed', !open);
    if (slot[1]) {
      var chev = slot[1].querySelector('.chevron');
      if (chev) { chev.textContent = open ? '▾' : '▸'; }
    }
    persist();
  }

  function toggle(which) {
    var keys = { timing: 'timingOpen', pick: 'pickOpen', vars: 'varsOpen', log: 'logOpen' };
    state[keys[which]] = !state[keys[which]];
    setOpen(which);
  }

  function bindCollapsible(which) {
    var map = {
      timing: el.timingHeader, pick: el.pickHeader,
      vars: el.varsHeader, log: el.logHeader
    };
    var h = map[which];
    if (!h) { return; }
    h.addEventListener('click', function (ev) {
      // 标题里的按钮（例如"清空日志"）不该触发折叠
      if (ev.target && ev.target.tagName === 'BUTTON') { return; }
      toggle(which);
    });
  }

  /* -------------------------------------------------------- 变量面板 */

  function ensureSelectionInitialised() {
    if (selectedInitialised) {
      return;
    }
    // 第一次拿到清单：按生成器给的 defaultSelected 预勾选
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].defaultSelected) {
        selected.add(catalog[i].name);
      }
    }
    selectedInitialised = true;
    persist();
    notifySelection();
  }

  function notifySelection() {
    vscode.postMessage({ type: 'select', names: Array.from(selected) });
  }

  /* ==========================================================================
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
  function kindOf(name) {
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i].name === name) { return catalog[i]; }
    }
    // 不在清单里的（运行期才注册出来的）：兜底元信息，保证不崩、能显示。
    // manual 缺省 false —— 没在源码里扫到注册调用，就按自动捕获处理。
    return { dims: [], kind: 'SCUT_T_I32', isStatic: false, manual: false };
  }

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
        /* ★ 分组显示：主动暴露的排前面，自动捕获的排后面。
         *
         *   catalog 已经由宿主侧排好序（主动在前，见 build.ts 的
         *   augmentManifestFromRuntime），这里只需要在【分界处】插一个
         *   小标题，让用户一眼看出两类变量的界线。
         *
         *   为什么用"插标题"而不是"渲染两遍列表"：
         *     搜索过滤时同一段代码要同时作用于两组，渲染两遍会让过滤逻辑
         *     重复一遍（很容易只改一处，造成两组行为不一致）。 */
        var lastManual = null;
        for (var i = 0; i < catalog.length; i++) {
          var v = catalog[i];
          if (filter && v.name.toLowerCase().indexOf(filter) < 0) { continue; }
          var isManual = v.manual === true;
          if (lastManual === null || isManual !== lastManual) {
            if (shown > 0 || !filter) {
              var sep = document.createElement('li');
              sep.className = isManual ? 'pick-group manual' : 'pick-group auto';
              sep.textContent = isManual
                ? '主动暴露（代码里显式注册）'
                : '自动捕获（编译期扫描到）';
              el.pickList.appendChild(sep);
            }
            lastManual = isManual;
          }
          shown++;
          var li = document.createElement('li');
          li.className = 'pick-item' + (isManual ? ' is-manual' : ' is-auto');
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
      if (el.varsCount) {
        el.varsCount.textContent = catalog.length
          ? (selected.size + ' / ' + catalog.length) : '';
      }
      if (catalog.length === 0) {
        el.varsHint.textContent = '还没有变量清单。先点「编译」。';
        return;
      }
      var picked = [];
      for (var k = 0; k < snapshots.length; k++) {
        var s = snapshots[k];
        var km = kindOf(s.name);
        // ★ 显示规则：主动暴露的恒显示，自动捕获的看勾选。
        //   用户在代码里写了 SCUT_Watch 就等于已经表达过"我要看它"，
        //   不该再要求他去上面的列表里勾一遍。
        var isManual = km.manual === true || s.manual === true;
        if (!isManual && !selected.has(s.name)) { continue; }
        // ★ 遍历【快照】而不是 catalog：
        //   catalog 是自动发现的结果，但用户可以手动 SCUT_Watch 额外注册
        //   （例如结构体里的关键成员），这些不在 catalog 里 ——
        //   早期版本遍历 catalog，导致手动注册的变量【永远不显示】，
        //   即使后端每帧都输出了它们的值。
        //   catalog 里没有的用兜底元信息，保证不崩、能显示。
        picked.push({
          name: s.name,
          dims: km.dims, kind: km.kind, isStatic: false,
          total: s.total,
          manual: isManual
        });
      }
      if (picked.length === 0) {
        el.varsHint.textContent = '变量栏是空的：代码里没写 SCUT_Watch 主动注册，'
          + '也没在上面的「选择要观察的变量」里勾选。勾几个即可（不影响算法运行）。';
        return;
      }
      el.varsHint.textContent = '';

      // ★ 主动暴露的排前面。快照的顺序来自后端注册顺序（自动注册在先、
      //   手动 SCUT_Watch 在后），不排序的话"主动暴露"永远沉在最底下。
      //   排序稳定：同类内部保持原顺序。
      picked.sort(function (a, b) {
        return (b.manual ? 1 : 0) - (a.manual ? 1 : 0);
      });

      var lastGroup = null;
      for (var p = 0; p < picked.length; p++) {
        var cv = picked[p];
        // 分组标题：与勾选区同一套文案，让两个区一眼能对上
        if (lastGroup === null || cv.manual !== lastGroup) {
          var gsep = document.createElement('li');
          gsep.className = 'pick-group ' + (cv.manual ? 'manual' : 'auto');
          gsep.textContent = cv.manual
            ? '主动暴露（代码里显式注册）'
            : '自动捕获（编译期扫描到）';
          el.varsList.appendChild(gsep);
          lastGroup = cv.manual;
        }
        var li2 = document.createElement('li');
        li2.className = 'var-item' + (cv.manual ? ' is-manual' : ' is-auto');
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
        }

        li2.appendChild(body);
        el.varsList.appendChild(li2);
      }
    }
  }

  function varMeta(v) {
    var dims = (v.dims && v.dims.length) ? v.dims.join('×') : '标量';
    // ★ 必须 String(...) 兜底：kind 在两个来源里类型不同 ——
    //   编译期清单给的是字符串 "SCUT_T_I32"，而运行期注册表给的是数字。
    //   一旦某个变量走到运行期那一份（DWARF 解析不出来的结构体成员），
    //   (数字).replace 就会抛 TypeError，而它是在渲染【整个列表】的循环里
    //   抛的 —— 于是变量面板整块空白，连带上面已经渲染好的部分也没了。
    //   显示用的辅助函数不该有能力弄垮整个视图。
    var k = String(v.kind == null ? '' : v.kind).replace('SCUT_T_', '');
    return k + ' · ' + dims + (v.isStatic ? ' · static' : '');
  }

  /**
   * 渲染「结构体/指针」的详情区。
   *
   * ★★ 为什么需要这个函数（它曾被调用但【从未定义】）★★
   *
   *   第 12 轮评审发现：上面 618 行调用了 renderStructDetail，
   *   而整个仓库没有任何地方定义它 —— 用户点「展开字段」就是一次
   *   ReferenceError。集成工程没踩到只是因为它的全局量以标量/数组为主，
   *   "这套代码恰好避开"，不是环境防住了。
   *   而车载算法里指针/结构体全局量极常见（逆透视指针表、环形缓冲索引），
   *   任意一个即可触发 —— 直接违反"适应用户各种奇葩代码"这条设计理念。
   *
   * ★★ 为什么内容只是"地址 + 一句说明"，而不是字段列表 ★★
   *
   *   后端目前【不解析 DWARF 成员表】—— `SCUT_T_STRUCT` 的值在 C 侧
   *   就只是 `"<%dB>"`（见 core/src/scut_watch.c 的 default 分支），
   *   指针类更是只报地址不解引用（防野指针）。
   *   也就是说"字段名"这个信息【从来没送到前端】。
   *
   *   所以这里如实显示"能显示的部分"，并告诉用户下一步怎么办，
   *   而不是给一个点开是空的折叠区 —— 那是另一种形式的骗人。
   *
   *   ★ 想看具体字段的正确做法（也是环境文档推荐的做法）：
   *     在算法里把关心的字段单独存成标量变量，或用
   *     SCUT_WATCH_SCALAR 主动注册 —— 那样它就会正常出现在面板里。
   *
   * @param node  承载详情的容器元素
   * @param v     该变量的元信息（kind/dims/elemBytes/name…）
   */
  function renderStructDetail(node, v) {
    // 每次都重建内容：快照文本每帧会变。
    node.textContent = '';

    var line1 = document.createElement('div');
    line1.className = 'struct-note';

    if (v.kind === 'SCUT_T_PTR') {
      line1.textContent = '指针类型：为安全起见不解引用，只显示它自身。';
    } else {
      var size = (v.elemBytes != null) ? v.elemBytes : 0;
      line1.textContent = '结构体：当前环境不解析成员表，'
        + '因此只能显示整体大小（' + size + ' 字节）。';
    }
    node.appendChild(line1);

    var line2 = document.createElement('div');
    line2.className = 'struct-note dim';
    line2.textContent = '想看具体字段？在算法里把关心的字段存成标量变量，'
      + '或用 SCUT_WATCH_SCALAR 主动注册，它就会正常显示。';
    node.appendChild(line2);
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


  // 变量名来自 C 标识符，理论上是安全的；但这里是拼 CSS 选择器，
  // 用 CSS.escape 兜一层（老版本 VS Code 的 Chromium 可能没有，做个退化）。
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(s);
    }
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      return '\\' + ch;
    });
  }

  /* ---------------------------------------------------------- 工具栏 */

  function bind(id, fn) {
    var b = document.getElementById(id);
    if (b) {
      b.addEventListener('click', fn);
    }
  }

  bind('btn-stop', function () { vscode.postMessage({ type: 'cmd', cmd: 'stop' }); });
  bind('btn-build', function () { vscode.postMessage({ type: 'cmd', cmd: 'build' }); });
bind('btn-debug', function () { vscode.postMessage({ type: 'cmd', cmd: 'debug' }); });
  // 图集翻页：上一张 / 下一张（走扩展侧，进程不重启、算法状态保留）
  bind('btn-prev', function () { vscode.postMessage({ type: 'cmd', cmd: 'prevPic' }); });
  bind('btn-next', function () { vscode.postMessage({ type: 'cmd', cmd: 'nextPic' }); });
  // 跳到指定编号：图集很大时（实测工程 60+ 张）比一张张点快得多。
  // ★ 后端一直实现了 g<N> 命令、协议注释里也写着，但插件从不发送它 ——
  //   这里补上唯一缺的入口。走扩展主命令，让按钮/标题栏/命令面板
  //   共用同一份实现（含输入框与校验）。
  bind('btn-goto', function () { vscode.postMessage({ type: 'cmd', cmd: 'gotoPic' }); });
  // 测速：同一张图重复 N 次取平均（旧环境 R 键的做法）
  bind('btn-bench', function () { vscode.postMessage({ type: 'cmd', cmd: 'bench' }); });
  // 设置入口：直接跳到本插件的设置页（扩展侧会展开最常用的「工具链」子栏目）
  bind('btn-settings', function () { vscode.postMessage({ type: 'cmd', cmd: 'settings' }); });
  bind('btn-clear', function () {
    logLines = [];
    if (el.log) { el.log.textContent = ''; }
    updateLogCount();
  });

  // ---- 四个折叠区块（统一组件） ----
  bindCollapsible('timing');
  bindCollapsible('pick');
  bindCollapsible('vars');
  bindCollapsible('log');

  // ---- 变量勾选区的过滤框 ----
  if (el.pickFilter) {
    el.pickFilter.addEventListener('input', function () { renderVariables(); });
  }

  // ---- 画面缩放 ----
  bind('btn-zoom-in', function () {
    setZoom((state.effectiveZoom || 1) * 1.25);
  });
  bind('btn-zoom-out', function () {
    setZoom((state.effectiveZoom || 1) / 1.25);
  });
  bind('btn-fit', function () { resetToFit(); });
  bind('btn-zoom-reset', function () {
    // 1:1 = 一个像素一个像素，看边缘细节时最准
    state.manualZoom = true;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    persist();
    applyZoom();
  });

  // ---- 滚轮缩放（以光标为锚点） ----
  if (el.screenWrap) {
    el.screenWrap.addEventListener('wheel', function (ev) {
      // 只在画面区滚轮时接管；Ctrl 与否都生效，符合"看大图"的直觉
      ev.preventDefault();
      var factor = ev.deltaY < 0 ? 1.15 : (1 / 1.15);
      setZoom((state.effectiveZoom || 1) * factor, { x: ev.clientX, y: ev.clientY });
    }, { passive: false });

    // ---- 拖动平移 ----
    //
    // ★ 为什么不直接用 scrollLeft 而要做拖拽：
    //   放大后视野比容器大，用户需要"抓住图往想看的方向拖"。
    //   滚动条能用但很别扭（尤其图比容器大很多时）。
    //   按住左键拖动是最符合直觉的交互。
    var dragging = false, dragStart = null;
    el.screenWrap.addEventListener('mousedown', function (ev) {
      // 只有内容溢出时才需要拖；否则拖动没有意义
      if (el.screenWrap.scrollWidth <= el.screenWrap.clientWidth + 1 &&
          el.screenWrap.scrollHeight <= el.screenWrap.clientHeight + 1) {
        return;
      }
      if (ev.button !== 0) { return; }
      dragging = true;
      dragStart = {
        x: ev.clientX, y: ev.clientY,
        left: el.screenWrap.scrollLeft, top: el.screenWrap.scrollTop
      };
      el.screenWrap.classList.add('dragging');
      ev.preventDefault();
    });
    window.addEventListener('mousemove', function (ev) {
      if (!dragging || !dragStart) { return; }
      el.screenWrap.scrollLeft = dragStart.left - (ev.clientX - dragStart.x);
      el.screenWrap.scrollTop = dragStart.top - (ev.clientY - dragStart.y);
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) { return; }
      dragging = false;
      dragStart = null;
      el.screenWrap.classList.remove('dragging');
      rememberPan();
      persist();
    });
  }

  // ---- 容器尺寸变化 → 未手动缩放时自动重新适应 ----
  //
  // ★ 这是用户第 3 条要求的落点："就算手动点击 +- 后，重新拖动边框
  //   （加宽/变窄）之后也自动适应"。
  //   实现上用 ResizeObserver 监听容器本身，比监听 window.resize 更准 ——
  //   拖动侧边栏边框时窗口尺寸【不变】，只有容器变，window.resize 根本不触发。
  if (typeof ResizeObserver !== 'undefined' && el.screenWrap) {
    var ro = new ResizeObserver(function () {
      // 手动缩放模式下不动用户设置的缩放，但要记住滚动位置
      if (isManualZoom()) {
        rememberPan();
        return;
      }
      applyZoom();
    });
    ro.observe(el.screenWrap);
  } else if (el.screenWrap) {
    // 兜底：老 Chromium 没有 ResizeObserver 时用轮询
    var lastW = el.screenWrap.clientWidth;
    setInterval(function () {
      if (!el.screenWrap) { return; }
      var w = el.screenWrap.clientWidth;
      if (w !== lastW) { lastW = w; if (!isManualZoom()) { applyZoom(); } }
    }, 400);
  }

  // Ctrl+= / Ctrl+- 缩放（与 VS Code 自身的缩放快捷键一致的直觉）
  window.addEventListener('keydown', function (e) {
    if (!e.ctrlKey && !e.metaKey) { return; }
    if (e.key === '=' || e.key === '+') {
      setZoom((state.effectiveZoom || 1) * 1.25);
      e.preventDefault();
    } else if (e.key === '-' || e.key === '_') {
      setZoom((state.effectiveZoom || 1) / 1.25);
      e.preventDefault();
    } else if (e.key === '0') {
      resetToFit();
      e.preventDefault();
    }
  });
  bind('btn-all', function () {
    for (var i = 0; i < catalog.length; i++) {
      selected.add(catalog[i].name);
    }
    persist();
    notifySelection();
    renderVariables();
  });
  bind('btn-none', function () {
    selected.clear();
    persist();
    notifySelection();
    renderVariables();
  });


  // 滚轮缩放已在上面的画面区绑定里统一处理（带光标锚点）。
  // ★ 这里曾经还有一份"只在 Ctrl/Shift 时缩放"的旧实现，
  //   两份同时存在会导致滚轮行为取决于哪个先绑定 —— 已删除。
  //   现在的规则很简单：在画面区滚轮就是缩放，不需要按修饰键。

  /* ------------------------------------------------------- 消息接收 */

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg !== 'object') {
      return;
    }

    switch (msg.type) {
      case 'frame': {
        try {
          var rgb = msg.rgb;
          // 结构化克隆过来的是 Uint8Array；个别情况下可能是 ArrayBuffer
          if (rgb instanceof ArrayBuffer) {
            rgb = new Uint8Array(rgb);
          }
          drawRgb(rgb, msg.width, msg.height);
          showTiming(msg.timing, msg.index);
          // 显示本帧用的是哪张输入图 —— 逐帧推进时这是用户最先想知道的信息
          if (el.picInfo) {
            el.picInfo.textContent = msg.pic
              ? ('第 ' + msg.index + ' 帧 · ' + msg.pic)
              : ('第 ' + msg.index + ' 帧 · （无测试图，黑图）');
          }
          if (el.status) {
            el.status.textContent = '运行中 · 第 ' + msg.index + ' 帧 · '
              + msg.width + '×' + msg.height;
          }
        } catch (e) {
          log('绘制第 ' + msg.index + ' 帧失败：' + e);
        }
        // ★ 必须发 ACK：扩展宿主靠它放行下一帧（postMessage 返回值不可信，见技术要点 §四）
        vscode.postMessage({ type: 'ack', index: msg.index });
        return;
      }

      case 'vars': {
        snapshots = Array.isArray(msg.snapshots) ? msg.snapshots : [];
        if (msg.timing) {
          showTiming(msg.timing, msg.frame);
        }
        /* ★★ try/catch 是必需的（第 12 轮评审修复）★★
         *
         *   vars 是【每帧】都会走的高频路径。此前这里没有兜底，
         *   一旦 renderVariables 因任何原因抛错（畸形数据、类型不符、
         *   未来改渲染逻辑时引入的 bug），异常会逃出 message 监听器 ——
         *   webview 的后续消息全部丢失，变量面板【永久停更】，
         *   而画面还在动。用户看到的是"数值不动了"，不报任何错。
         *
         *   ★ 为什么不像 frame 分支那样只包一层：frame 分支早有 try，
         *     但 vars/catalog/status/log 四个分支都没有。这次补齐 ——
         *     失败时保留上一次的内容 + 往日志区报一条，而不是静默。 */
        try {
          renderVariables();
        } catch (e) {
          log('[视图] 变量刷新失败（保留上次内容）：'
              + (e && e.message ? e.message : e));
        }
        return;
      }

      case 'catalog': {
        catalog = Array.isArray(msg.variables) ? msg.variables : [];
        // ★ 勾选的唯一权威来源是 webview 自己的 setState()（getState 已在上面的
        //   初始化里读过）。宿主下发的 msg.selected 只用于【首次】初始化，
        //   之后一律以本地为准，否则用户刚点的勾选会被回来的 catalog 覆盖掉。
        var hadSaved = state.selected !== null;
        ensureSelectionInitialised();
        if (!hadSaved && Array.isArray(msg.selected) && msg.selected.length > 0) {
          // 本地没有持久化状态，但宿主有一份（例如 webview 被销毁重建、
          // 而宿主进程还活着）→ 以宿主为准。
          selected = new Set(msg.selected);
          selectedInitialised = true;
          persist();
        }
        try {
          renderVariables();
        } catch (e) {
          // ★ 渲染失败不能让整个视图停摆：变量面板是"附加信息"，
          //   算法本身还在跑。失败时保留上一次的内容，并说清发生了什么。
          log('[视图] 变量清单渲染失败：' + (e && e.message ? e.message : e));
        }
        return;
      }

      case 'status': {
        try {
          if (el.status) {
            el.status.textContent = msg.running
              ? ('运行中' + (msg.exePath ? ' · ' + msg.exePath : ''))
              : ('未运行' + (msg.exePath ? ' · 可执行：' + msg.exePath : ' · 尚未编译'));
          }
        } catch (e) {
          log('[视图] 状态更新失败：' + (e && e.message ? e.message : e));
        }
        return;
      }

      case 'log': {
        try {
          log(msg.line === '' ? '——' : msg.line);
        } catch (e) {
          // 日志区本身失败时无处可报，只能静默 —— 但不能让它冒出去
          // 把整个 message 监听器打断（后续消息会全部丢失）。
        }
        return;
      }

      default:
        return;
    }
  });

  // ---- 启动：把持久化的 UI 状态应用到 DOM ----
  //
  // ★ 为什么要在最后统一 apply 一次，而不是在 HTML 里写死：
  //   四个区块的开合状态是【用户上次的选择】，存在 setState 里。
  //   如果 HTML 写死，用户每次打开都被重置，等于没记住。
  setOpen('timing');
  setOpen('pick');
  setOpen('vars');
  setOpen('log');
  applyZoom();

  // ★ 刻意不往日志区写"视图已就绪"这类环境消息：
  //   那一区现在只放【用户算法 SCUT_Log 的输出】，混进环境噪声会让
  //   "日志区到底有没有我的输出"变得难判断。
  vscode.postMessage({ type: 'ready' });
})();
