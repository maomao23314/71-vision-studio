/**
 * settingsview.ts —— 配置面板（WebviewPanel）。
 *
 * ★★ 为什么自己画，不用 VS Code 的 settings.json ★★
 *
 *   0.9.3 走的是 contributes.configuration，结果踩了三重坑：
 *     ① 嵌套 object 分组【不注册内层键】→ cfg.get 静默拿默认值，
 *        用户在设置页里填了工具链路径，插件完全读不到；
 *     ② cfg.update 直接抛「没有注册配置 scut71.toolchain.path」；
 *     ③ 用户为此重装过一次 VS Code。
 *   根因是配置被放在【用户设置】里，而它该跟着工程走。
 *
 *   现在：配置的唯一真值是工程里的 scut_project.json。
 *        这个面板只是它的编辑器 —— 读 JSON → 显示 → 改完写回 JSON。
 *        面板关闭不丢任何东西，因为它从不自己持有状态。
 *
 * ★ 与仿真面板的关系：共用 media/ 下的样式变量，视觉一致。
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import {
    ProjectConfig, defaultConfig, normalizeConfig, readConfig, writeConfig,
    CONFIG_FILENAME,
} from './projectconfig';
import { FIELDS, SectionKey, SECTIONS } from './configfields';
import { scanHookCandidates } from './hookscan';

/** 面板当前唯一实例。用户改完再点一次不会开出第二扇窗。 */
let current: vscode.WebviewPanel | undefined;

/**
 * 「自动保存」开关的存储键。
 *
 * ★★ 为什么它【不】放进 scut_project.json ★★
 *   工程 JSON 里放的是"这个工程怎么跑"（尺寸、钩子、图集）——
 *   那是能进 git、能发给同学、换台机器必须一样的**工程事实**。
 *   而"我要不要自动保存"是**我这个人**在**这台机器**上的操作习惯，
 *   和工程本身无关。把它塞进工程 JSON 会让别人 clone 下来
 *   莫名其妙多一个和他无关的开关，也让"配置只有一个真值"这句话变形。
 *   所以它进 context.globalState —— VS Code 给扩展自己的偏好存储。
 *
 * ★ 默认 true：用户原话"不方便的话就默认自动"。
 *   自动保存省掉的正是"改完忘了按保存、然后疑惑为什么没生效"这一步，
 *   而这一步是新手最常踩的。
 */
const AUTO_SAVE_KEY = 'settings.autoSave';

/** 自动保存的落盘延迟（毫秒）。见下方 flush 的说明。 */
const AUTO_SAVE_DELAY_MS = 600;

function readAutoSave(context: vscode.ExtensionContext): boolean {
    const v = context.globalState.get<boolean>(AUTO_SAVE_KEY);
    return v === undefined ? true : v === true;
}

export function showSettingsPanel(
    context: vscode.ExtensionContext,
    projectRoot: string,
    onChanged: (sections: SectionKey[]) => void,
): void {
    const extensionUri = context.extensionUri;
    // 已开着就把它拉回前面，而不是再开一扇。
    if (current) {
        current.reveal(vscode.ViewColumn.Active, true);
        void current.webview.postMessage({ type: 'refresh' });
        return;
    }

    const { config, error } = readConfig(projectRoot);
    if (error) {
        void vscode.window.showErrorMessage(`SCUT-71 ${error}`);
    }

    // 打开面板时顺手核对 .vscode/extensions.json（推荐 clangd）。
    ensureRecommendedExtensions(projectRoot);

    const panel = vscode.window.createWebviewPanel(
        'scut71.settings',
        'SCUT-71 配置',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            // ★ 只准读自己的 media/，别的一律不给。
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        },
    );
    current = panel;

    /**
     * 代码里真实存在的 void f(void) 函数（非 static），供钩子字段下拉选。
     *
     * ★ 为什么每次打开都重扫，不缓存：用户改完代码回来重新打开面板，
     *   正是"我刚加了个函数，想去填上"的时刻 —— 缓存会让新函数不出现。
     *   扫描只读 code/ 下几个 .c 文件，是毫秒级的事。
     */
    const hookCandidates = (): Array<{ name: string; file: string }> => {
        try {
            return scanHookCandidates(projectRoot);
        } catch {
            return [];   // 扫不出来就不给建议，面板照旧可手填
        }
    };

    panel.webview.html = html(panel.webview, extensionUri, projectRoot);

    /**
     * 自动保存的延迟计时器 + 挂起的那份配置。
     *
     * ★★ 为什么是"延迟合并"而不是"每次 input 立刻写盘" ★★
     *   用户在「图像宽度」里从 188 改成 1024，会触发 4 次 input
     *   （1 → 10 → 102 → 1024）。逐次写盘意味着：
     *     · 写 4 次文件（每次都 rename，杀毒软件会跟着扫 4 次）；
     *     · 中间态 `1` / `10` / `102` 也是合法配置，会各被写进去一次。
     *       如果这时恰好有一次构建在跑，它可能读到 `1` 这个宽度 ——
     *       构建出 1×120 的契约头，而用户想的是 1024。
     *   合并到 600ms 之后再写，等于"用户停手了才落盘"，
     *   中间态一次都不会被写出去。
     *
     * ★ 为什么 600ms 而不是更长：面板里改完一项，用户会立刻
     *   切去按「编译」。落盘必须在那之前完成，否则编译读到旧值。
     *   600ms 够合并连续按键，又短到用户来不及切窗口。
     */
    let autoSaveTimer: NodeJS.Timeout | undefined;
    /**
     * 挂起（还没落盘）的那份配置。
     *
     * ★ 必须存下来，不能只存计时器：面板被关掉时计时器会被取消，
     *   如果这时手里没有值，那次改动就永远丢了 ——
     *   这正是"自动保存"最典型的那种 bug：看起来保存了，最后一下没保存。
     */
    let pendingValue: unknown;
    let pendingSections: SectionKey[] = [];

    /** 把挂起的改动立刻落盘（没有挂起就什么也不做）。 */
    const flushPending = (): void => {
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = undefined;
        }
        if (pendingValue === undefined) {
            return;
        }
        const value = pendingValue;
        const sections = pendingSections;
        pendingValue = undefined;
        pendingSections = [];
        save(projectRoot, value);
        onChanged(sections);
    };

    panel.webview.onDidReceiveMessage((raw: unknown) => {
        const msg = raw as {
            type?: string; value?: unknown; path?: string[]; autoSave?: unknown;
        };
        if (msg?.type === 'save') {
            // 显式保存（按钮 / Ctrl+S）：先丢掉挂起的，避免写两遍。
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
                autoSaveTimer = undefined;
            }
            pendingValue = undefined;
            pendingSections = [];
            save(projectRoot, msg.value);
            onChanged(Array.isArray(msg.path) ? (msg.path as SectionKey[]) : []);
            return;
        }
        if (msg?.type === 'autoSave') {
            /* 自动保存的改动。value 是整份配置（面板不持有真值，
             * 每次都是全量发回），所以这里和显式保存走同一个 save()。
             *
             * ★★ 为什么宿主还要再判一次开关 ★★
             *   前端 queueAutoSave() 里已经有 `if (!autoSave) return`，
             *   但那只防"正常路径"。用户在关掉开关的同一瞬间改一项时，
             *   页面上的 autoSave 变量和宿主 globalState 的更新可能差一拍 ——
             *   前端以为还开着，消息照样发出来。
             *   实测过：关掉后改一项，磁盘仍被写入。
             *   偏好是宿主存的，就该由宿主把关；只在前端判等于把正确性
             *   押在"两个进程的状态永远同步"上，那不是能保证的事。 */
            if (!readAutoSave(context)) {
                return;
            }
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
            }
            pendingValue = msg.value;
            pendingSections = Array.isArray(msg.path) ? (msg.path as SectionKey[]) : [];
            autoSaveTimer = setTimeout(() => {
                autoSaveTimer = undefined;
                const value = pendingValue;
                const sections = pendingSections;
                pendingValue = undefined;
                pendingSections = [];
                if (value === undefined) {
                    return;
                }
                save(projectRoot, value);
                onChanged(sections);
                // 回一条确认，让底栏能显示"已自动保存"而不是一直挂着"未保存"
                void panel.webview.postMessage({ type: 'autoSaved' });
            }, AUTO_SAVE_DELAY_MS);
            return;
        }
        if (msg?.type === 'setAutoSave') {
            /* 开关本身：写进 globalState，并回显给面板。
             * ★ 关掉开关时【先把挂起的改动落盘】—— 否则用户刚改了一项
             *   立刻关掉自动保存，那一项就永远停在内存里了。 */
            const on = msg.autoSave === true;
            if (!on) {
                flushPending();
            }
            void context.globalState.update(AUTO_SAVE_KEY, on);
            void panel.webview.postMessage({ type: 'autoSaveState', on });
            return;
        }
        if (msg?.type === 'openJson') {
            openJson(projectRoot);
            return;
        }
        if (msg?.type === 'pickFolder') {
            void pickFolder(projectRoot, msg.path ?? [], panel);
            return;
        }
        if (msg?.type === 'reload') {
            /* ★★ 先落盘、再回读 —— 顺序不能反 ★★
             *
             *   面板会在窗口重新获得焦点时发 reload（为了让用户看到
             *   "在外部改了 JSON"的结果）。而自动保存的改动是延迟 600ms 写的。
             *   如果直接回读磁盘：用户改了一项、切出去、又切回来，
             *   这次 reload 拿到的是【改动之前】的配置 —— 界面上那一项
             *   变回旧值，而 600ms 后磁盘才被写成新值。
             *   用户看到的是"我改的东西自己变回去了"，然后多半会再改一遍。
             *
             *   先 flushPending() 保证磁盘已经是最新的，回读才和用户
             *   刚才的改动一致。这是"延迟写 + 定期回读"必须配对的那一步。
             */
            flushPending();
            void panel.webview.postMessage({
                type: 'config', config: loadFor(projectRoot), error,
                hooks: hookCandidates(), autoSave: readAutoSave(context),
            });
            return;
        }
        if (msg?.type === 'reset') {
            void vscode.window
                .showWarningMessage(
                    'SCUT-71 把所有配置项恢复为默认值？',
                    { modal: true },
                    '恢复默认')
                .then((ok) => {
                    if (!ok) {
                        return;
                    }
                    try {
                        // ★ 恢复默认之前先丢掉挂起的改动：
                        //   否则 600ms 后它会把刚恢复的默认值又盖回用户的改动。
                        if (autoSaveTimer) {
                            clearTimeout(autoSaveTimer);
                            autoSaveTimer = undefined;
                        }
                        pendingValue = undefined;
                        pendingSections = [];
                        writeConfig(projectRoot, defaultConfig());
                        void panel.webview.postMessage({
                            type: 'config', config: defaultConfig(),
                            autoSave: readAutoSave(context),
                        });
                        onChanged([]);
                        void vscode.window.showInformationMessage(
                            'SCUT-71 已恢复默认配置（已写入 scut_project.json）');
                    } catch (e) {
                        void vscode.window.showErrorMessage(
                            `SCUT-71 恢复失败：${msgText(e)}`);
                    }
                });
            return;
        }
        if (msg?.type === 'doctor') {
            void vscode.commands.executeCommand('scut71.doctor');
        }
    });

    panel.webview.postMessage({
        type: 'config', config: config ?? defaultConfig(), error,
        hooks: hookCandidates(), autoSave: readAutoSave(context),
    });

    /* ★ 面板被关掉 / 窗口切走时，把挂起的自动保存落盘。
     *
     *   为什么必须在这里做：webview 的延迟计时器只在【页面活着】时有效。
     *   用户改完一项立刻点右上角 ×，页面先被销毁，计时器根本不会触发 ——
     *   那一次改动就没了，而用户以为自动保存了。
     *   宿主侧的 onDidDispose 一定会触发，所以兜底放在这里，
     *   而且 pendingValue 让"落盘"是真的落，不是丢弃。 */
    panel.onDidDispose(() => {
        flushPending();
        current = undefined;
    });
}

/**
 * 在工程的 .vscode/extensions.json 里推荐 clangd（幂等，不动其它条目）。
 *
 * 插件自己不起语言服务，但可以把"建议装什么"写进工程 ——
 * VS Code 打开工程时会提示安装，这是成本最低的补全方案。
 * 推荐扩展属于锦上添花：读不到/写不进都不影响任何功能。
 */
export function ensureRecommendedExtensions(projectRoot: string): void {
    const dir = path.join(projectRoot, '.vscode');
    const file = path.join(dir, 'extensions.json');
    const CLANGD_ID = 'llvm-vs-code-extensions.vscode-clangd';
    try {
        let obj: { recommendations?: unknown } = {};
        if (fs.existsSync(file)) {
            const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
            obj = JSON.parse(text) as { recommendations?: unknown };
        }
        const cur = Array.isArray(obj.recommendations) ? (obj.recommendations as unknown[]) : [];
        if (cur.some((x) => typeof x === 'string' && x.toLowerCase() === CLANGD_ID)) {
            return;                       // 已经有了，不碰文件
        }
        obj.recommendations = [...cur, CLANGD_ID];
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    } catch {
        /* 忽略：与编译、仿真都无关 */
    }
}

function msgText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function loadFor(projectRoot: string): ProjectConfig {
    const { config } = readConfig(projectRoot);
    return config ?? defaultConfig();
}

function save(projectRoot: string, raw: unknown): void {
    try {
        writeConfig(projectRoot, normalizeConfig(raw));
    } catch (e) {
        void vscode.window.showErrorMessage(`SCUT-71 保存失败：${msgText(e)}`);
    }
}

/** 打开 JSON 源文件。面板与文件双向都能改，谁后改谁生效。 */
function openJson(projectRoot: string): void {
    const p = path.join(projectRoot, CONFIG_FILENAME);
    if (!fs.existsSync(p)) {
        writeConfig(projectRoot, defaultConfig());
    }
    void vscode.commands.executeCommand(
        'vscode.open', vscode.Uri.file(p));
}

/**
 * 目录选择。
 *
 * ★ 为什么面板要问"工程内还是工程外"：
 *   图集目录通常是工程内的相对路径（pic/1），工具链则是工程外的绝对路径。
 *   宿主不知道用户要选哪种，而同一个 OpenDialog
 *   用在不同场景下，"相对工程还是绝对"是要分别处理的。
 */
async function pickFolder(
    projectRoot: string,
    fieldPath: string[],
    panel: vscode.WebviewPanel,
): Promise<void> {
    const outside = fieldPath[0] === 'toolchain';
    // ★ 工程外：defaultUri 直接省略（VS Code 会记住上次的位置）。
    //   原本这里硬编码了 'C:\\' —— 那是【猜用户的机器】，
    //   而这正是本项目反复栽过的跟头（详见 toolchain.ts 的
    //   ROOT_CANDIDATES 注释：猜目录被证伪过两次）。
    //   不指定起点，让浏览器自己做默认比猜一个盘符安全。
    if (outside) {
        if (fieldPath[1] === 'pythonPath') {
            // 选的是【文件】不是目录 —— 解释器要选到 python.exe 那一层。
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
                filters: { 'Python 解释器': ['exe', 'py'] },
                openLabel: '选择 python.exe',
                title: '选择 Python 解释器（3.7+，无需第三方库）',
            });
            if (!picked || picked.length === 0) {
                return;
            }
            await panel.webview.postMessage({
                type: 'folderPicked', path: fieldPath, value: picked[0].fsPath,
            });
            return;
        }
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
            openLabel: '选择工具链根目录（内含 bin\\clang.exe）',
            title: '选择工具链根目录',
        });
        if (!picked || picked.length === 0) {
            return;
        }
        await panel.webview.postMessage({
            type: 'folderPicked', path: fieldPath, value: picked[0].fsPath,
        });
        return;
    }
    const inner = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        defaultUri: vscode.Uri.file(path.join(projectRoot, 'pic')),
        openLabel: '选择图集目录',
        title: '选择图集目录（工程内的 pic\\组号\\图）',
    });
    if (!inner || inner.length === 0) {
        return;
    }
    // 图集是工程内的【相对路径】：跟着工程走、能进 git、换机器不用改。
    const value = path.relative(projectRoot, inner[0].fsPath).replace(/\\/g, '/');
    await panel.webview.postMessage({ type: 'folderPicked', path: fieldPath, value });
}

/* ------------------------------------------------------------------ HTML */

function html(webview: vscode.Webview, extensionUri: vscode.Uri,
              projectRootPath: string): string {
    const nonce = nonce32();
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'settingsview.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'settingsview.js'));
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource} 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');

    // 分组外壳由脚本填，静态部分只留骨架 —— 字段表在 configfields.ts 里，
    // TS 和 webview 共用同一份定义，不会两边写歪。
    // ★ data-keys 把"这个分组负责哪几个一级键"一并交出去：脚本按它过滤字段，
    //   而不是自己猜"path[0] 等于分组名"。这两者不是一回事（见 SectionDef.key）。
    const groups = SECTIONS.map((s, i) => `
      <section class="group${i === 0 ? ' open' : ''}" data-group="${s.key}"
               data-keys="${s.keys.join(',')}">
        <header class="group-head">
          <span class="chevron">▸</span>
          <span class="group-title">${s.title}</span>
          <span class="group-note">${s.note}</span>
        </header>
        <div class="group-body"></div>
      </section>`).join('');

    // 字段表以 JSON 注入，脚本读它渲染。
    // ★ 为什么不写成静态 HTML ★
    //   字段表在 configfields.ts 里定义（TypeScript 侧的唯一真值），
    //   注入比在 HTML 里手写一遍可靠：手写就会两边写歪，
    //   而"面板上有、代码读不到"正是 0.9.3 踩的坑。
    //   JSON.stringify 出来的串要转义 < 和 &，否则脚本内容会提前闭合 script 标签。
    const fieldsJson = JSON.stringify(FIELDS).replace(/</g, '\\u003c')
        .replace(/&/g, '\\u0026');
    const sectionsJson = JSON.stringify(SECTIONS).replace(/</g, '\\u003c')
        .replace(/&/g, '\\u0026');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>SCUT-71 配置</title>
</head>
<body>
  <header id="top">
    <div id="top-main">
      <div class="top-title">配置</div>
      <div class="top-sub" id="cfg-path"></div>
    </div>
    <div class="top-actions">
      <button id="btn-open"   class="ghost" title="打开 scut_project.json（可直接改文本）">查看 JSON</button>
      <button id="btn-doctor" class="ghost" title="运行一次环境自检">环境自检</button>
      <button id="btn-reset"   class="ghost danger-ghost" title="全部恢复默认">恢复默认</button>
    </div>
  </header>

  <div id="hint" class="hint"></div>

  <main id="groups">${groups}</main>

  <footer id="foot">
    <label id="autosave-box" title="开着时改完自动写入 scut_project.json；关掉则需点「保存」或按 Ctrl+S">
      <input id="chk-autosave" type="checkbox" checked>
      <span>自动保存</span>
    </label>
    <span id="autosave-tip" class="dim"></span>
    <span class="spacer"></span>
    <span id="foot-note" class="dim">改动写入 <code>${CONFIG_FILENAME}</code>；文件不存在会自动创建</span>
    <button id="btn-save" class="ghost" title="写入 scut_project.json (Ctrl+S)">保存</button>
  </footer>

  <script nonce="${nonce}">
    window.__SCUT_FIELDS__ = ${fieldsJson};
    window.__SCUT_SECTIONS__ = ${sectionsJson};
    window.__SCUT_CONFIG_PATH__ = ${JSON.stringify(projectRootPath)};
  </script>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

function nonce32(): string {
    // 用 crypto 拿真随机；webview 的 CSP nonce 必须每次不同。
    return crypto.randomBytes(16).toString('base64');
}