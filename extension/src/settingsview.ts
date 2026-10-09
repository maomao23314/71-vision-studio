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

/** 面板当前唯一实例。用户改完再点一次不会开出第二扇窗。 */
let current: vscode.WebviewPanel | undefined;

export function showSettingsPanel(
    extensionUri: vscode.Uri,
    projectRoot: string,
    onChanged: (sections: SectionKey[]) => void,
): void {
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

    panel.webview.html = html(panel.webview, extensionUri, projectRoot);

    panel.webview.onDidReceiveMessage((raw: unknown) => {
        const msg = raw as { type?: string; value?: unknown; path?: string[] };
        if (msg?.type === 'save') {
            save(projectRoot, msg.value);
            onChanged(Array.isArray(msg.path) ? (msg.path as SectionKey[]) : []);
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
            void panel.webview.postMessage({
                type: 'config', config: loadFor(projectRoot), error,
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
                        writeConfig(projectRoot, defaultConfig());
                        void panel.webview.postMessage({
                            type: 'config', config: defaultConfig(),
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
    });

    panel.onDidDispose(() => {
        current = undefined;
    });
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
    const groups = SECTIONS.map((s, i) => `
      <section class="group${i === 0 ? ' open' : ''}" data-group="${s.key}">
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
    <span id="foot-note" class="dim">改动写入 <code>${CONFIG_FILENAME}</code>；文件不存在会自动创建</span>
    <span class="spacer"></span>
    <button id="btn-save" class="primary" title="写入 scut_project.json (Ctrl+S)">保存</button>
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