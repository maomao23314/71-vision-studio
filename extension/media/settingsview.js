/* settingsview.js —— 配置面板前端
 *
 * ★ 职责边界：这个脚本【不持有配置】★
 *   它只在收到宿主推来的 config 时渲染，改完把整份配置 post 回去。
 *   配置的真值始终在 scut_project.json。
 *   所以即使面板被重建、窗口被重载，也不会丢任何东西 ——
 *   这是"JSON 是唯一真值"带来的直接好处。
 *
 * ★ 字段表不写在这里：随 settingsview.html 一起由宿主注入（FIELDS_JSON），
 *   与 configfields.ts 同源，避免两边写歪。
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    const FIELDS = window.__SCUT_FIELDS__ || [];
    const SECTIONS = window.__SCUT_SECTIONS__ || [];

    /** 当前配置的可写副本。改这个，不动别的。 */
    let cfg = null;

    /**
     * 代码里扫出来的候选钩子函数（宿主随 config 一起发过来）。
     *
     * ★ 空数组是正常情况（用户用了宏、或函数在别的文件里）——
     *   那时下拉框不出现，输入框照旧可以手打函数名。
     */
    let hooks = [];

    /**
     * 是否开启自动保存。真值在宿主侧的 globalState 里，这里只是镜像。
     *
     * ★ 默认 true：用户原话"不方便的话就默认自动"。
     *   自动保存省掉的正是"改完忘了按保存、然后疑惑为什么没生效"——
     *   这是新手最常踩的一步。
     */
    let autoSave = true;

    /**
     * 这一侧有没有"改了但还没落盘"的东西。
     *
     * ★ 只用于一件事：窗口重新获得焦点时，决定要不要向宿主请求 reload。
     *   有未落盘改动时 reload 会把界面刷回磁盘上的旧值 ——
     *   用户会觉得"我改的东西自己变回去了"。
     *   （宿主侧 flushPending 兜了另一头，两边都要防。）
     */
    let dirtyPending = false;

    const $ = (id) => document.getElementById(id);

    /* -------------------------------------------------------- 收消息 */

    window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m) { return; }
        if (m.type === 'config') {
            cfg = m.config;
            hooks = Array.isArray(m.hooks) ? m.hooks : [];
            if (typeof m.autoSave === 'boolean') {
                autoSave = m.autoSave;
            }
            // 宿主刚推来一份"磁盘上的真值"→ 这一侧不再有未落盘的改动
            dirtyPending = false;
            showError(m.error || '');
            render();
            renderAutoSave();
        } else if (m.type === 'autoSaveState') {
            autoSave = m.on === true;
            renderAutoSave();
        } else if (m.type === 'autoSaved') {
            // 宿主确认已经落盘 → 底栏从"未保存"切成"已自动保存"
            dirtyPending = false;
            if (autoSave) {
                noteSaved(true);
            }
        } else if (m.type === 'refresh') {
            vscode.postMessage({ type: 'reload' });
        } else if (m.type === 'folderPicked' && cfg) {
            setValue(cfg, m.path, m.value);
            render();
            markDirty();
        }
    });

    /* -------------------------------------------------------- 渲染 */

    function render() {
        renderTop();
        for (const sec of SECTIONS) {
            const el = document.querySelector(
                '.group[data-group="' + sec.key + '"]');
            const body = el && el.querySelector('.group-body');
            if (!body) { continue; }
            body.innerHTML = '';
            // ★ 按分组声明的 keys 过滤，而不是拿 sec.key 去比 path[0]。
            //   两者曾经是同一个值，于是"一个分组只能装一个一级键"，
            //   结果图数组名（outputArray）因此【从来没有显示过】——
            //   它和 inputArray 同属「图像数组」，却只能有一个被装进去。
            const owns = sec.keys || [sec.key];
            for (const f of FIELDS) {
                if (owns.indexOf(f.path[0]) < 0) { continue; }
                body.appendChild(rowOf(f));
            }
        }
    }

    function renderTop() {
        $('cfg-path').textContent =
            (window.__SCUT_CONFIG_PATH__ || 'scut_project.json');
    }

    function rowOf(f) {
        const row = document.createElement('div');
        row.className = 'field';

        const label = document.createElement('div');
        label.className = 'field-label';
        label.innerHTML =
            '<span class="name"></span>'
            + '<span class="path"></span>';
        label.querySelector('.name').textContent = f.label;
        if (f.rebuild) {
            const b = document.createElement('span');
            b.className = 'badge';
            b.textContent = '需重编译';
            b.title = '改动后要重新「编译」才生效';
            label.querySelector('.name').appendChild(b);
        }
        label.querySelector('.path').textContent = f.path.join('.');
        row.appendChild(label);

        const ctrl = document.createElement('div');
        ctrl.className = 'field-control';
        const v = getValue(cfg, f.path);
        ctrl.appendChild(controlOf(f, v));

        if (f.hint) {
            const h = document.createElement('div');
            h.className = 'field-hint';
            h.textContent = f.hint;
            ctrl.appendChild(h);
        }
        row.appendChild(ctrl);
        return row;
    }

    function controlOf(f, v) {
        if (f.kind === 'bool') {
            const wrap = document.createElement('label');
            wrap.className = 'switch';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!v;
            const st = document.createElement('span');
            st.className = 'state';
            st.textContent = cb.checked ? '开' : '关';
            cb.addEventListener('change', () => {
                st.textContent = cb.checked ? '开' : '关';
                setValue(cfg, f.path, cb.checked);
                markDirty();
            });
            wrap.appendChild(cb);
            wrap.appendChild(st);
            return wrap;
        }

        if (f.kind === 'lines') {
            const wrap = document.createElement('div');
            const ta = document.createElement('textarea');
            ta.rows = 3;
            ta.spellcheck = false;
            ta.value = Array.isArray(v) ? v.join('\n') : String(v == null ? '' : v);
            ta.addEventListener('input', () => {
                setValue(cfg, f.path, splitLines(ta.value));
                markDirty();
            });
            wrap.appendChild(ta);

            /* ★ 候选函数下拉框（钩子字段专用）。
             *
             * 为什么要有它：钩子函数名是这个环境【唯一】必须人工填的东西，
             * 而手填有两个看不见的坑 ——
             *   · 名字必须逐字对上，错一个字母，构建期只报
             *     "undefined reference to xxx"，看不出是配置写错了；
             *   · 必须是非 static 的，从车载工程拷过来的函数带 static 时，
             *     光看代码完全看不出来，也是链接期才炸。
             * 下拉里列的全是【真的存在且非 static】的 void f(void)，
             * 选一个就等于同时避开了这两个坑。
             *
             * ★ 扫不出来（用户用了宏/函数指针/别的文件）时不显示下拉，
             *   输入框照旧手填 —— 猜错比不猜更糟。 */
            if (hooks.length > 0) {
                const pick = document.createElement('select');
                pick.className = 'hook-pick';
                const cur = splitLines(ta.value);
                const opt0 = document.createElement('option');
                opt0.value = '';
                opt0.textContent = '从代码里选一个…（' + hooks.length + ' 个候选）';
                pick.appendChild(opt0);
                for (const h of hooks) {
                    const o = document.createElement('option');
                    o.value = h.name;
                    // 已经填过的显示成"当前值"，否则用户不知道现在用的是哪个
                    o.textContent = h.name + (cur.indexOf(h.name) >= 0 ? '（当前）' : '')
                        + '   ' + h.file;
                    pick.appendChild(o);
                }
                pick.addEventListener('change', () => {
                    if (!pick.value) { return; }
                    // 追加到末尾而不是替换：一个阶段可以填多个函数。
                    const list = splitLines(ta.value);
                    if (list.indexOf(pick.value) < 0) {
                        list.push(pick.value);
                    }
                    ta.value = list.join('\n');
                    setValue(cfg, f.path, list);
                    markDirty();
                    pick.value = '';
                });
                wrap.appendChild(pick);
            }
            return wrap;
        }

        if (f.kind === 'number') {
            const box = document.createElement('div');
            box.className = 'row-inline';
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = '1';
            inp.value = String(v == null ? '' : v);
            inp.addEventListener('input', () => {
                const bad = !isFinite(inp.valueAsNumber);
                inp.classList.toggle('bad', bad);
                if (!bad) {
                    setValue(cfg, f.path, inp.valueAsNumber);
                    markDirty();
                }
            });
            box.appendChild(inp);
            if (f.unit) {
                const u = document.createElement('span');
                u.className = 'unit';
                u.textContent = f.unit;
                box.appendChild(u);
            }
            return box;
        }

        // ★ 'file' 必须与 'folder' 合并判断（一条真实缺陷的修复）：
        //   本函数的分支顺序是 bool → lines → number → folder → 兜底 text。
        //   原先这里只判 'folder'，而 configfields.ts 里 pythonPath 的
        //   kind 是 'file' —— 于是它永远落到 text 兜底，
        //   下面两句针对 'file' 写的 placeholder / 按钮 title 成了不可达代码，
        //   用户看到的是目录版的提示（"留空 = 自动探测"），
        //   而宿主点开的是文件选择器。功能对、提示错。
        if (f.kind === 'folder' || f.kind === 'file') {
            const box = document.createElement('div');
            box.className = 'row-inline';
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.spellcheck = false;
            inp.placeholder = (f.kind === 'file')
                ? '留空 = 自动探测（装了多个 Python 时建议手动指定）'
                : '留空 = 自动探测';
            inp.value = String(v == null ? '' : v);
            inp.addEventListener('input', () => {
                setValue(cfg, f.path, inp.value.trim());
                markDirty();
            });
            const btn = document.createElement('button');
            btn.className = 'ghost';
            btn.textContent = '浏览…';
            btn.title = (f.kind === 'file')
                ? '选择解释器文件（python.exe）'
                : '打开系统目录选择器';
            btn.addEventListener('click', () => {
                vscode.postMessage({ type: 'pickFolder', path: f.path });
            });
            box.appendChild(inp);
            box.appendChild(btn);
            return box;
        }

        // text
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.spellcheck = false;
        inp.value = String(v == null ? '' : v);
        inp.addEventListener('input', () => {
            setValue(cfg, f.path, inp.value.trim());
            markDirty();
        });
        return inp;
    }

    function splitLines(s) {
        return String(s)
            .split(/[\n,;]/)
            .map((x) => x.trim())
            .filter((x) => x.length > 0);
    }

    function getValue(obj, p) {
        let cur = obj;
        for (const k of p) {
            if (cur === null || typeof cur !== 'object') { return undefined; }
            cur = cur[k];
        }
        return cur;
    }

    function setValue(obj, p, v) {
        let cur = obj;
        for (let i = 0; i < p.length - 1; i++) {
            cur = cur[p[i]];
        }
        cur[p[p.length - 1]] = v;
    }

    /* -------------------------------------------------------- 交互 */

    function showError(msg) {
        const h = $('hint');
        h.textContent = msg || '';
        h.classList.toggle('show', !!msg);
        h.classList.toggle('err', true);
    }

    /** 底栏提示"有未保存的改动"。不发消息 —— 用户可能正在改。 */
    function markDirty() {
        dirtyPending = true;
        if (autoSave) {
            /* ★ 开着自动保存时【不显示"未保存"】。
             *   那句话会让用户以为必须去按「保存」，而他刚改的东西
             *   600ms 后就会自己落盘 —— 显示"未保存"是在骗他按一次多余的按钮。
             *   底栏改成"正在自动保存…"，落盘后由 autoSaved 消息切成"已自动保存"。 */
            $('foot-note').innerHTML =
                '正在自动保存…（改动写入 <code>scut_project.json</code>）';
            queueAutoSave();
            return;
        }
        $('foot-note').innerHTML =
            '有未保存的改动 · 按「保存」写入 <code>scut_project.json</code>';
    }

    /**
     * 把当前配置发给宿主，让它延迟落盘。
     *
     * ★ 为什么不在前端自己做 debounce：
     *   前端的计时器在页面被销毁时（关面板）直接消失，最后那一次改动就丢了。
     *   宿主侧有 onDidDispose 兜底，所以延迟与落盘都必须由宿主做，
     *   这里【每次改动都发】—— 多发几条消息的代价远小于丢改动。
     */
    function queueAutoSave() {
        if (!autoSave || !cfg) { return; }
        vscode.postMessage({
            type: 'autoSave',
            value: cfg,
            path: FIELDS.map((f) => f.path[0]),
        });
    }

    /** 底栏状态：已保存 / 已自动保存。 */
    function noteSaved(auto) {
        $('foot-note').innerHTML = auto
            ? '已自动保存到 <code>scut_project.json</code>'
            : '已写入 <code>scut_project.json</code>';
    }

    function save() {
        vscode.postMessage({
            type: 'save',
            value: cfg,
            path: FIELDS.map((f) => f.path[0]),
        });
        dirtyPending = false;
        noteSaved(false);
        const foot = $('foot');
        foot.classList.remove('flash');
        void foot.offsetWidth;          // 强制回流，让动画能重放
        foot.classList.add('flash');
    }

    /* ---- 自动保存开关 ---- */

    /**
     * 底栏那个开关的显示状态。
     *
     * ★ 关掉自动保存时，按钮必须重新变得显眼（primary）——
     *   否则用户会以为"我关了自动保存，但它还在自己存"，
     *   或者反过来"我关了，所以我的改动已经存好了"。
     *   开关本身要说清当前是哪一档。
     */
    function renderAutoSave() {
        const cb = $('chk-autosave');
        if (cb) { cb.checked = autoSave; }
        const tip = $('autosave-tip');
        if (tip) {
            tip.textContent = autoSave
                ? '改完自动写入（约 0.6 秒后）'
                : '改完需点「保存」或按 Ctrl+S';
        }
        const btn = $('btn-save');
        if (btn) {
            btn.classList.toggle('primary', !autoSave);
            btn.classList.toggle('ghost', autoSave);
            btn.title = autoSave
                ? '立即写入（其实已经在自动保存了，这个按钮只是保险）'
                : '写入 scut_project.json (Ctrl+S)';
        }
        /* ★ 底栏文字只在"当前没有未落盘改动"时才改成"需要手动保存"。
         *
         *   这里踩过一个坑：关掉自动保存的那一刻会调 renderAutoSave()，
         *   而它无条件把底栏改成"改动需按保存"—— 如果用户刚改完一项
         *   （dirtyPending 为真），那句"有未保存的改动"就被盖掉了，
         *   用户以为已经存好了，切去编译却读到旧值。
         *   两种状态不能互相覆盖：优先显示"有未保存的改动"。 */
        if (!autoSave && !dirtyPending) {
            $('foot-note').innerHTML =
                '自动保存已关 · 改动需按「保存」写入 <code>scut_project.json</code>';
        }
    }

    $('btn-save').addEventListener('click', save);
    $('btn-open').addEventListener('click',
        () => vscode.postMessage({ type: 'openJson' }));
    $('btn-doctor').addEventListener('click',
        () => vscode.postMessage({ type: 'doctor' }));
    $('btn-reset').addEventListener('click',
        () => vscode.postMessage({ type: 'reset' }));

    /* ---- 自动保存开关 ----
     * 改变时把新状态告诉宿主（它负责存进 globalState 并回显），
     * 同时把"当前这份配置"一起发过去 —— 关掉开关的瞬间，
     * 宿主会先把挂起的改动落盘，不能让刚改的东西停在内存里。 */
    const chk = $('chk-autosave');
    if (chk) {
        chk.addEventListener('change', () => {
            vscode.postMessage({
                type: 'setAutoSave',
                autoSave: chk.checked,
                value: cfg,
                path: FIELDS.map((f) => f.path[0]),
            });
        });
    }

    for (const head of document.querySelectorAll('.group-head')) {
        head.addEventListener('click', () => {
            head.parentElement.classList.toggle('open');
        });
    }

    // Ctrl+S 与文件保存保持一致的手感：在这个面板里按它就是保存配置。
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            save();
        }
    });

    /* 目录选择器在宿主里弹，会让 webview 失焦；回来时刷新一次，
     * 免得用户在外部改了 JSON 却看不到。
     *
     * ★★ 自动保存之后这条必须加条件 ★★
     *   原来无条件 reload。自动保存开着时，用户改一项 → 600ms 内
     *   点一下浏览器外面（比如去按「编译」）→ 立刻触发 focus →
     *   reload 把界面上【刚改但还没落盘】的值刷回旧值。
     *   宿主侧虽然会先 flushPending 再回读（见 settingsview.ts），
     *   但那份 flush 用的是"上一次发给宿主的配置"；如果用户此刻
     *   正在输入框里打字（输入法组合中），中间态还没发出去，
     *   刷新就会把他正在打的字冲掉。
     *   所以：只有【这一侧没有未发送的改动】时才允许刷新。 */
    window.addEventListener('focus', () => {
        if (!cfg) { return; }
        if (dirtyPending) { return; }
        vscode.postMessage({ type: 'reload' });
    });
}());