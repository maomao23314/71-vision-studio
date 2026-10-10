/**
 * toolchainfetch.ts —— 「到手即用」：第一次用的时候，把精简版 LLVM-MinGW 自己下到插件目录里。
 *
 * 设计理念对照：
 *   · 上手即用     → 目标机器上【什么都没装】也能编译。用户不该为了跑一次仿真
 *                    先去官网翻 release、挑对包名、解压、配 PATH。
 *   · 代码松耦合   → 只往外给「工具链根目录 + 一句中文说明」，不认识 build/project 那些模块。
 *   · 部署可移植   → 全部落在插件自己的 globalStorage 里，删插件就跟着删干净。
 *
 * ★ 为什么不把工具链打进 vsix：
 *   这个包解压后接近 1 GB，而 vsix 目前只有 300 KB 左右。打进去包体积爆炸，
 *   而且每次 LLVM 发版都要重新打包上传，成本全由「只想写算法」的学生白付。
 *
 * ★ 为什么不引 zip 解压依赖：
 *   tar.exe 从 Windows 10 1803 起随系统提供，而且【能直接解 zip】；
 *   PowerShell 的 Expand-Archive 同样出厂即有。自己背一份 inflate 实现，
 *   打包体积、供应链风险、维护成本三样都不划算 —— 所以优先 tar，失败再退 PowerShell。
 *
 * ★ 为什么用 https.get 而不是 fetch：
 *   GitHub 的资产地址不是直接给文件的：实测先 302 到
 *   release-assets.githubusercontent.com（早先是 objects.githubusercontent.com），
 *   而我们需要自己控制重定向、超时和【流式进度】。
 *   https 模块跟着 Node 版本走，行为比各版本 undici 的 fetch 稳定。
 *
 * ★ 面向用户的字符串全部是中文，且必须是【可执行的下一步】，
 *   不是「下载失败」这种把问题丢回给用户的说法。
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { spawn, type ChildProcess } from 'child_process';
import type { IncomingMessage } from 'http';
import { URL } from 'url';
import { detectProject } from './project';
import { defaultConfig, readConfig } from './projectconfig';

export interface FetchProgress { (message: string, percent?: number): void; }

export interface EnsureToolchainResult {
    ok: boolean;
    /** 工具链根目录（成功时是解压后的目录，含 bin/clang.exe） */
    root?: string;
    /** 面向用户的中文说明（成功=已就绪；失败=下一步怎么办） */
    message: string;
    /** 是否本次真的下载了（false = 本来就存在，直接复用） */
    downloaded: boolean;
}

const DEFAULT_RELEASE_API = 'https://api.github.com/repos/mstorsjo/llvm-mingw/releases/latest';
const RELEASES_PAGE = 'https://github.com/mstorsjo/llvm-mingw/releases';

/**
 * 查 release 的 API 地址，**可被环境变量覆盖**。
 *
 * ★★ 为什么要可配置（校园网的现实）★★
 *   官方端点在校园网/国内网络下经常不可达，此时 autoDownload 形同虚设，
 *   用户只能自己手动下载解压 —— 而插件并没有给他别的选择。
 *   留一个环境变量出口，至少让有镜像的人（或 CI）能把它指过去，
 *   而不必改插件源码。
 *
 * ★ 用环境变量而不是配置项：
 *   "用哪个下载源"是**本机/本网络**的属性，不是工程的属性 ——
 *   与 SCUT71_TOOLCHAIN / SCUT71_PYTHON 同一类，都走环境变量
 *   （见 docs/架构设计.md §4.5 关于"本机环境不要进工程配置"的立场）。
 *
 * ★ 只接受 https：
 *   这是个会下载并【执行】二进制的地址，允许 http 等于允许中间人
 *   替换掉 clang.exe。宁可拒绝用户的 http 配置并说明原因，
 *   也不要默默接受一个可被篡改的下载源。
 */
export function currentReleaseApi(): string {
    const raw = readApiOverride();
    if (!raw) {
        return DEFAULT_RELEASE_API;
    }
    return /^https:\/\//i.test(raw) ? raw : DEFAULT_RELEASE_API;
}

function readApiOverride(): string {
    return (process.env.SCUT71_TOOLCHAIN_API ?? '').trim().replace(/^"|"$/g, '');
}

/**
 * 用户给了覆盖值、但因为不是 https 被拒（供上层给出一条明确提示）。
 * ★ 静默退回官方是不行的：用户以为生效了，实际没有 —— 又是一次"配了没用"。
 */
export function toolchainApiOverrideRejected(): boolean {
    const raw = readApiOverride();
    return raw.length > 0 && !/^https:\/\//i.test(raw);
}


/** ★ 必须带 User-Agent：GitHub 对无 UA 的请求直接 403。 */
const USER_AGENT = 'scut71-vision-studio';
const ASSET_NAME_RE = /^llvm-mingw-.*-ucrt-x86_64\.zip$/;
/** 重定向上限。GitHub 通常只有一跳（→ release-assets），5 跳是安全余量。 */
const MAX_REDIRECTS = 5;
/** 单次网络操作的静默超时。卡住时宁可失败，也不能让扩展宿主一直转圈。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 解压超时。解 1 GB 在机械盘上可能要几分钟，所以给得很宽松。 */
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

/** 只查询、不下载：找到已就绪的工具链根就返回它。 */
export function findInstalledToolchain(storageDir: string): string | undefined {
    if (!storageDir) {
        return undefined;
    }
    const root = path.join(storageDir, 'toolchain');
    return isToolchainRoot(root) ? root : undefined;
}

/** 返回已就绪的工具链根；没有则下载后再返回。★ 永不抛异常，失败也返回结果对象。 */
export async function ensureToolchain(
    storageDir: string,
    progress: FetchProgress,
): Promise<EnsureToolchainResult> {
    // 调用方理论上一定传函数，但入口兜一下：进度回调崩了不该让「装工具链」跟着崩。
    const report: FetchProgress = typeof progress === 'function' ? progress : (): void => { /* 无回调时静默 */ };

    if (!storageDir) {
        return { ok: false, downloaded: false, message: failureMessage('没有拿到插件存储目录，无法自动下载工具链。') };
    }

    // ---- 快路径：已经有就不碰网络。放在 withProgress 之外，免得「秒过」还闪一个进度条 ----
    const existing = findInstalledToolchain(storageDir);
    if (existing) {
        report(`已找到现成的工具链：${existing}`, 100);
        return {
            ok: true,
            root: existing,
            downloaded: false,
            message: `编译工具链已就绪：${existing}\n    说明：这是之前下载好的，本次直接复用，没有重复下载。`,
        };
    }

    if (!autoDownloadEnabled()) {
        return {
            ok: false,
            downloaded: false,
            message: failureMessage('没有找到编译工具链，而且自动下载已被设置关掉（设置 › SCUT-71 › 工具链 › 允许自动下载）。'),
        };
    }

    try {
        return await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'SCUT-71：正在准备编译工具链', cancellable: false },
            (p) => run(storageDir, (message, percent) => {
                report(message, percent);
                p.report({ message: percent === undefined ? message : `${message} ${Math.round(percent)}%` });
            }),
        );
    } catch (e) {
        // withProgress 本身出问题（极罕见）也不能把异常抛给调用方 —— activate 期间抛异常会让插件「没反应」。
        return { ok: false, downloaded: false, message: failureMessage(`准备工具链时出现意外错误：${describeError(e)}`) };
    }
}

/** 下载 + 解压 + 就位。异常在这里被转成中文结果，临时文件两个分支都会清掉。 */
async function run(storageDir: string, report: FetchProgress): Promise<EnsureToolchainResult> {
    let zip: string | undefined;
    let staging: string | undefined;
    try {
        fs.mkdirSync(storageDir, { recursive: true });
        staging = path.join(storageDir, 'toolchain-extracting');
        // 上次异常退出可能留下半个解压目录，先清干净，避免两次解压的结果混在一起。
        fs.rmSync(staging, { recursive: true, force: true });

        report('正在查询 LLVM-MinGW 最新版本…', 0);
        const asset = await resolveLatestAsset();

        // basename 是防目录穿越：名字虽然过了正则，拼路径前再取一次 basename 更稳。
        zip = path.join(os.tmpdir(), `scut71-${path.basename(asset.name)}`);
        fs.rmSync(zip, { force: true });

        report(`正在下载 ${asset.name}…`, 0);
        await downloadToFile(asset.url, zip, (got, total) => {
            const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
            report(
                total
                    ? `正在下载 ${asset.name}（${mb(got)}/${mb(total)} MB）…`
                    : `正在下载 ${asset.name}（已接收 ${mb(got)} MB）…`,
                total ? Math.floor((got * 100) / total) : undefined,
            );
        });

        report('正在解压（约 1 GB，第一次会慢一些）…', 100);
        await extractZip(zip, staging);

        const target = path.join(storageDir, 'toolchain');
        report('正在整理目录…');
        placeAsToolchain(locateExtractedRoot(staging), target);

        // 验证必须落在最终路径上：解压成功但目录结构不对的情况是有的（换个打包方式就会）。
        if (!isToolchainRoot(target)) {
            throw new Error(`解压完成，但没有找到编译器：期望的文件是 ${path.join(target, 'bin', 'clang.exe')}，它不存在。`);
        }

        report('工具链已就绪。', 100);
        return {
            ok: true,
            root: target,
            downloaded: true,
            message: `编译工具链已就绪：${target}\n    说明：本次已自动下载并解压，之后一直复用这个目录，不会重复下载。`,
        };
    } catch (e) {
        return { ok: false, downloaded: false, message: failureMessage(describeError(e)) };
    } finally {
        // 成功、失败都要清：留着 1 GB 的 zip 会把用户的磁盘慢慢吃满。
        if (zip) {
            removeQuietly(zip);
        }
        if (staging) {
            removeQuietly(staging);
        }
    }
}

// ---------------------------------------------------------------------------
// 找包 / 下载
// ---------------------------------------------------------------------------

interface ReleaseAsset { name: string; url: string; }

/** 查最新 release，挑出 Windows x86_64 的 ucrt 包。 */
async function resolveLatestAsset(): Promise<ReleaseAsset> {
    const text = await fetchText(currentReleaseApi());

    let json: { assets?: unknown };
    try {
        json = JSON.parse(text) as { assets?: unknown };
    } catch {
        throw new Error('GitHub 返回的不是合法 JSON（网络中间设备改写响应的可能性较大）。');
    }

    if (!Array.isArray(json.assets)) {
        throw new Error('GitHub 的 release 数据里没有 assets 字段，无法确定要下载哪个包。');
    }

    const candidates: ReleaseAsset[] = [];
    for (const raw of json.assets as unknown[]) {
        if (typeof raw !== 'object' || raw === null) {
            continue;
        }
        const rec = raw as Record<string, unknown>;
        if (typeof rec.name === 'string' && typeof rec.browser_download_url === 'string' && ASSET_NAME_RE.test(rec.name)) {
            candidates.push({ name: rec.name, url: rec.browser_download_url });
        }
    }

    if (candidates.length === 0) {
        throw new Error('最新的 release 里没有找到名字形如 llvm-mingw-*-ucrt-x86_64.zip 的资源。');
    }
    // 优先不带 -dbg 的包：带调试符号的那个体积翻倍，对学生写算法没有任何用处。
    return candidates.find((c) => !/-dbg/i.test(c.name)) ?? candidates[0];
}

/** 发一次 GET，把响应流交回调用方。调用方必须消费或 resume，否则连接不释放。 */
function openStream(url: string, accept: string): Promise<IncomingMessage> {
    return new Promise<IncomingMessage>((resolve, reject) => {
        let settled = false;
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: accept }, timeout: REQUEST_TIMEOUT_MS }, (res) => {
            settled = true;
            resolve(res);
        });
        req.on('timeout', () => req.destroy(new Error('连接 github.com 超时，网络可能很慢或被代理挡住。')));
        // 已经拿到响应之后的错误由响应流自己报，这里只处理「连响应都没拿到」的情况。
        req.on('error', (e) => {
            if (!settled) {
                reject(e);
            }
        });
    });
}

/** 取重定向目标；不是重定向就返回 undefined。★ 必须自己跟，GitHub 资产地址是 302 出去的。 */
function redirectTarget(res: IncomingMessage, baseUrl: string): string | undefined {
    const code = res.statusCode ?? 0;
    if (code !== 301 && code !== 302 && code !== 303 && code !== 307 && code !== 308) {
        return undefined;
    }
    const location = res.headers.location;
    if (!location) {
        return undefined;
    }
    try {
        return new URL(location, baseUrl).toString();
    } catch {
        return undefined;
    }
}

/** 发请求并手动跟完重定向，返回最终响应（调用方负责检查状态码并消费流）。 */
async function getFinal(url: string, accept: string, hops: number = MAX_REDIRECTS): Promise<IncomingMessage> {
    const res = await openStream(url, accept);
    const next = redirectTarget(res, url);
    if (!next) {
        return res;
    }
    res.resume();
    if (hops <= 0) {
        throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次，已中止。`);
    }
    return getFinal(next, accept, hops - 1);
}

/** 取一段文本（GitHub API 的 JSON）。 */
async function fetchText(url: string): Promise<string> {
    const res = await getFinal(url, 'application/vnd.github+json');
    if (res.statusCode !== 200) {
        res.resume();
        throw new Error(httpErrorText(res.statusCode ?? 0));
    }
    return await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
    });
}

/** 流式下载到临时文件，边下边报百分比。 */
async function downloadToFile(url: string, dest: string, onProgress: (got: number, total?: number) => void): Promise<void> {
    const res = await getFinal(url, 'application/octet-stream');
    if (res.statusCode !== 200) {
        res.resume();
        throw new Error(httpErrorText(res.statusCode ?? 0));
    }

    const declared = Number(res.headers['content-length'] ?? '');
    const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;

    await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        let got = 0;
        let lastTick = 0;
        let lastPct = -1;
        let done = false;

        const fail = (e: unknown): void => {
            if (!done) {
                done = true;
                out.destroy();
                // ★ 也要把响应流断掉：只 destroy 文件流的话，浏览器那侧仍会把剩下的
                //   上百 MB 推完，白占带宽（用户手机上开热点时这很要命）。
                try {
                    res.destroy();
                } catch { /* 已经关掉的流再 destroy 会报错，忽略 */ }
                reject(e);
            }
        };

        out.on('error', fail);
        res.on('error', fail);
        res.on('data', (chunk: Buffer) => {
            got += chunk.length;
            const now = Date.now();
            const pct = total === undefined ? -1 : Math.floor((got * 100) / total);
            // ★ 节流：不节流的话 100 MB 会发出上万次进度回调，把调用方的 UI 刷到卡死。
            if (now - lastTick >= 200 || (pct >= 0 && pct !== lastPct)) {
                lastTick = now;
                lastPct = pct;
                onProgress(got, total);
            }
        });
        out.on('finish', () => {
            if (done) {
                return;
            }
            // 声明了长度却没收全，说明连接中途断了；这种包解压出来必然是坏的，直接判失败。
            if (total !== undefined && got !== total) {
                fail(new Error(`下载不完整：声明 ${total} 字节，实际只收到 ${got} 字节。`));
                return;
            }
            done = true;
            resolve();
        });
        res.pipe(out);
    });
}

// ---------------------------------------------------------------------------
// 解压 / 就位
// ---------------------------------------------------------------------------

/**
 * 解压 zip 到指定目录。
 *
 * 先用系统自带 tar（Windows 10 1803+ 起提供，且能解 zip），失败再退 PowerShell 的
 * Expand-Archive。两者都随 Windows 10+ 出厂，所以插件不带任何解压依赖。
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
    fs.mkdirSync(destDir, { recursive: true });

    const tarCode = await runQuiet('tar', ['-xf', zipPath, '-C', destDir]);
    if (tarCode === 0) {
        return;
    }

    // ★ tar 是被超时杀掉的（而不是报错退出）就别再试 PowerShell 了：
    //   它做的是同一件事，只会让用户再等一个超时（两个十分钟），没有任何收益。
    if (tarCode === TIMED_OUT) {
        throw new Error(
            `解压超过 ${Math.round(EXTRACT_TIMEOUT_MS / 60000)} 分钟仍未完成，已中止。\n`
            + `    zip 文件位于：${zipPath}\n`
            + '    下一步：这台机器的磁盘可能太慢或空间不足；'
            + '手动把该 zip 解压开，再把里面的目录（有 bin\\clang.exe 的那一层）在设置「工具链根目录」里指过去。',
        );
    }

    const ps = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`;
    const psCode = await runQuiet('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    if (psCode !== 0) {
        throw new Error(
            `系统自带的解压工具没能解开这个包（tar 退出码 ${tarCode}，PowerShell 退出码 ${psCode}）。\n`
            + `    zip 文件位于：${zipPath}\n`
            + '    下一步：手动把该 zip 解压开，再把解压出来的目录（里面有 bin\\clang.exe）在设置「工具链根目录」里指过去。',
        );
    }
}

/** runQuiet 的超时哨兵值：和普通非零退出码区分开。 */
const TIMED_OUT = -2;

/**
 * 跑一个进程，只要退出码。
 *
 * ★ 这里刻意用 stdio: 'ignore'：受限沙箱下把子进程 stdio 接成管道会 EPERM，
 *   而解压的成败只看退出码，输出对我们没有任何价值。
 */
function runQuiet(exe: string, args: string[]): Promise<number> {
    return new Promise<number>((resolve) => {
        let child: ChildProcess;
        try {
            child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
        } catch {
            resolve(-1);
            return;
        }
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                child.kill();
            } catch { /* 已退出的进程 kill 会报错，忽略 */ }
        }, EXTRACT_TIMEOUT_MS);
        child.on('error', () => {
            clearTimeout(timer);
            resolve(-1);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve(timedOut ? TIMED_OUT : (code ?? -1));
        });
    });
}

/** zip 顶层是 llvm-mingw-<日期>-ucrt-x86_64/ 一个目录，把它认出来。 */
function locateExtractedRoot(staging: string): string {
    if (isToolchainRoot(staging)) {
        return staging;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(staging, { withFileTypes: true });
    } catch (e) {
        throw new Error(`解压目录 ${staging} 读不出来：${describeError(e)}`);
    }
    for (const e of entries) {
        const cand = path.join(staging, e.name);
        if (e.isDirectory() && isToolchainRoot(cand)) {
            return cand;
        }
    }
    throw new Error(
        `解压完成，但 ${staging} 下面没有哪个目录里有 bin\\clang.exe。\n`
        + '    原因：下载到的包结构不符合预期（可能被换成了别的发行包）。',
    );
}

/** 把解压出来的根目录搬到 <storageDir>/toolchain。 */
function placeAsToolchain(source: string, target: string): void {
    // 清掉上次失败留下的半成品：rename 到已存在的目录会直接失败，而半成品留着也没用。
    fs.rmSync(target, { recursive: true, force: true });
    try {
        fs.renameSync(source, target);
    } catch {
        // 极端情况下（目录被占用、跨卷）rename 会失败，退回递归拷贝 + 删源。
        fs.cpSync(source, target, { recursive: true });
        removeQuietly(source);
    }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 工具链根目录的判定：bin 下有 clang 就算数。 */
function isToolchainRoot(root: string): boolean {
    return isFile(path.join(root, 'bin', 'clang.exe')) || isFile(path.join(root, 'bin', 'clang'));
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** 清理是尽力而为：删不掉也不能让整个流程失败。 */
function removeQuietly(target: string): void {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch { /* 故意忽略 */ }
}

/**
 * 用户是否允许自动下载。
 *
 * ★ 默认允许，但不能因此把「到手即用」卡住 ★
 *   读不到工程配置（还没打开工程、文件坏了）时按允许处理 ——
 *   这个默认值让插件在"什么都不知道"时依然能用，
 *   而不是抛错或卡住。真正要拦下载的场合不多，
 *   而误拦一次的代价（用户以为插件坏了）比多下一个 165MB 更大。
 */
function autoDownloadEnabled(): boolean {
    try {
        const project = detectProject();
        if (!project) {
            return true;
        }
        const { config } = readConfig(project.root);
        return (config ?? defaultConfig()).toolchain.autoDownload;
    } catch {
        return true;
    }
}

/** PowerShell 单引号字符串：内部的单引号要写两遍。 */
function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** HTTP 状态码 → 中文原因（403/429 在 GitHub 上几乎总是限流，值得单独说清楚）。 */
function httpErrorText(code: number): string {
    if (code === 403 || code === 429) {
        return `GitHub 拒绝了本次请求（HTTP ${code}），通常是同一网络出口的匿名请求太多被限流了。`;
    }
    if (code === 404) {
        return `GitHub 上没有找到这个地址（HTTP 404），可能是 release 里的资源名变了。`;
    }
    return `GitHub 返回了 HTTP ${code}。`;
}

/** 把各种异常翻译成人能看懂的中文。我们自己抛的都是中文，所以默认原样透传。 */
function describeError(e: unknown): string {
    if (!(e instanceof Error)) {
        return String(e);
    }
    switch ((e as NodeJS.ErrnoException).code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return '连不上 github.com（域名解析失败），这台机器目前访问不了外网。';
        case 'ECONNREFUSED':
            return '连接 github.com 被拒绝，可能被防火墙或代理拦下了。';
        case 'ETIMEDOUT':
            return '连接 github.com 超时，网络可能很慢或被代理挡住。';
        case 'ECONNRESET':
            return '传输过程中连接被重置，网络不稳定（代理中断也会这样）。';
        case 'EPERM':
        case 'EACCES':
            return '没有写权限，工具链写不进插件目录。';
        case 'ENOSPC':
            return '磁盘空间不足，装不下这个工具链（解压后约 1 GB）。';
        case 'EBUSY':
            return '工具链目录被别的程序占用（杀毒软件实时扫描也会这样），关掉它再重试。';
        case 'EEXIST':
            // 走到这里说明「存储目录」这个路径上已经有一个同名文件了，怎么说都指不到工具链上。
            return '插件存储目录的位置被一个同名文件占了，建不出目录来。';
        default: {
            // ★ 我们自己抛的（网络、解压结构、下载不完整）已经是中文说明，必须原样透传。
            //   否则会把「GitHub 返回了 HTTP 403」改写成「写目录出错」，把用户带到完全错误的方向。
            if (/[\u4e00-\u9fa5]/.test(e.message)) {
                return e.message;
            }
            // 剩下的才是 Node 的系统错误：剥掉 "CODE: " 前缀，且不能把英文原文直接甩给用户。
            const stripped = e.message.replace(/^([A-Z]+):\s*/, '');
            return `读写插件目录时出错：${stripped || '未知原因'}（多半是权限或磁盘问题，不是网络问题）。`;
        }
    }
}

/** 失败说明的固定收尾：永远给出一条【不依赖网络】的退路。 */
function failureMessage(reason: string): string {
    return `${reason}\n`
        + `    下一步：也可以从 ${RELEASES_PAGE} 手动下载 `
        + 'llvm-mingw-*-ucrt-x86_64.zip，解压到任意目录，'
        + '再把设置里的「工具链根目录」指向那个目录（里面有 bin\\clang.exe 的那一层），'
        + '然后重新执行「SCUT-71: 环境自检」。';
}
