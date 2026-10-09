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

    const $ = (id) => document.getElementById(id);

    /* -------------------------------------------------------- 收消息 */

    window.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m) { return; }
        if (m.type === 'config') {
            cfg = m.config;
            showError(m.error || '');
            render();
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
            const body = document.querySelector(
                '.group[data-group="' + sec.key + '"] .group-body');
            if (!body) { continue; }
            body.innerHTML = '';
            for (const f of FIELDS) {
                if (f.path[0] !== sec.key) { continue; }
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
            const ta = document.createElement('textarea');
            ta.rows = 3;
            ta.spellcheck = false;
            ta.value = Array.isArray(v) ? v.join('\n') : String(v == null ? '' : v);
            ta.addEventListener('input', () => {
                setValue(cfg, f.path, splitLines(ta.value));
                markDirty();
            });
            return ta;
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

        if (f.kind === 'folder') {
            const box = document.createElement('div');
            box.className = 'row-inline';
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.spellcheck = false;
            inp.placeholder = '留空 = 自动探测';
            inp.value = String(v == null ? '' : v);
            inp.addEventListener('input', () => {
                setValue(cfg, f.path, inp.value.trim());
                markDirty();
            });
            const btn = document.createElement('button');
            btn.className = 'ghost';
            btn.textContent = '浏览…';
            btn.title = '打开系统目录选择器';
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
        $('foot-note').innerHTML =
            '有未保存的改动 · 按「保存」写入 <code>scut_project.json</code>';
    }

    function save() {
        vscode.postMessage({
            type: 'save',
            value: cfg,
            path: FIELDS.map((f) => f.path[0]),
        });
        $('foot-note').innerHTML =
            '已写入 <code>scut_project.json</code>';
        const foot = $('foot');
        foot.classList.remove('flash');
        void foot.offsetWidth;          // 强制回流，让动画能重放
        foot.classList.add('flash');
    }

    $('btn-save').addEventListener('click', save);
    $('btn-open').addEventListener('click',
        () => vscode.postMessage({ type: 'openJson' }));
    $('btn-doctor').addEventListener('click',
        () => vscode.postMessage({ type: 'doctor' }));
    $('btn-reset').addEventListener('click',
        () => vscode.postMessage({ type: 'reset' }));

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

    // 目录选择器在宿主里弹，会让 webview 失焦；回来时刷新一次，
    // 免得用户在外部改了 JSON 却看不到。
    window.addEventListener('focus', () => {
        if (cfg) { vscode.postMessage({ type: 'reload' }); }
    });
}());