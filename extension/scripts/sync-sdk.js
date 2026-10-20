#!/usr/bin/env node
/**
 * sync-sdk.js —— 把仓库里的 SDK 源码同步进 extension/sdk/，让它随 .vsix 一起分发。
 *
 * ============================================================================
 * 为什么需要这个脚本（改之前请先读）
 * ============================================================================
 *
 * 【一】要解决的问题
 * ----------------------------------------------------------------------------
 *   插件安装后的目录长这样：
 *       ~/.vscode/extensions/scut-racing.scut-71-vision-studio-0.3.0/
 *   这个目录里【只有 .vsix 里被打包进去的文件】。仓库根目录的
 *   core/ bind/ backends/ tools/ 根本不在磁盘上的任何地方 ——
 *   学生机器上不存在"那个仓库"。
 *
 *   而构建必须用到它们：
 *       core/include/**   → 编译用户算法时的 -I 头文件
 *       core/src/*.c      → 编出 libscut_core.a（见下：不能预编译分发）
 *       bind/scut_bind.c  → 唯一知道编译期图像尺寸的编译单元
 *       backends/headless/*.c → 提供 main() 的仿真宿主
 *       tools/*.py        → 官方构建脚本与符号发现脚本
 *
 *   所以必须把这些【拷进插件目录】，打进 .vsix。
 *
 * 【二】为什么核心库不直接预编译好放进去
 * ----------------------------------------------------------------------------
 *   静态库 .a 里是【目标文件】，与产生它的编译器/ABI/CRT 绑死。
 *   学生机器上的工具链版本、CRT（msvcrt vs ucrt）未必与我们这里相同。
 *   分发一个预编译的 .a，一旦不匹配就是一堆莫名其妙的链接错误，
 *   而且报错信息完全指不到"这是库和工具链不匹配"这个真实原因。
 *   所以分发【源码】，在用户机器上用他自己的工具链编一次。
 *   一次编译约 1.5 秒，且之后增量复用（改算法不重编环境）。
 *
 * 【三】为什么必须用脚本拷，不许手工拷（本文件存在的核心理由）
 * ----------------------------------------------------------------------------
 *   SDK 的【唯一真相来源】是仓库根目录的 core/ bind/ backends/ tools/。
 *   extension/sdk/ 只是它的一个【构建产物】—— 为分发而生的副本。
 *
 *   手工拷的后果是可预期的：某天有人在 core/src 里改了一个 bug、
 *   加了 bind 里的一个符号，却忘了同步副本。于是"仓库里跑得好好的，
 *   装出来的 vsix 却是坏的"，而且因为两边的文件看起来都对，
 *   这个 bug 极难定位。用脚本拷至少保证：同步是【一条命令、可重复、
 *   不会漏文件】的，并且每次运行都会先清空再拷，
 *   所以不可能残留上一次的陈旧文件。
 *
 *   本脚本还会在拷贝后做一次【完整性自检】（见 verify()）：
 *   缺任何一个必需文件就直接退出码非 0。
 *   宁可在这里把打包弄失败，也不要发出一个装上去就编不过的插件。
 *
 * 用法：
 *     node extension/scripts/sync-sdk.js          # 同步
 *     node extension/scripts/sync-sdk.js --check  # 只检查，不写入（CI 用）
 *
 * 由 extension/package.json 的 "sync-sdk" 脚本调用。
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** extension/scripts/ → extension/ */
const EXTENSION_DIR = path.resolve(__dirname, '..');

/** extension/ → 仓库根 */
const REPO_ROOT = path.resolve(EXTENSION_DIR, '..');

/** 同步根：extension/（sdk/ 与 templates/ 都在它下面）。 */
const SDK_DEST = path.join(EXTENSION_DIR, 'sdk');

/**
 * 要同步的清单。
 *
 * ★ 每条都是 { 源（相对仓库根）, 目标（相对 extension/sdk 或 extension/ 下） }。
 *   刻意【逐条列出】而不是"整个目录全拷"：这样打包进 vsix 的东西
 *   永远是明示的、可审计的。哪天 core/ 下多了一个 100MB 的测试数据目录，
 *   不会因为一句粗暴的递归拷贝就悄悄进了安装包。
 *
 * ★ core/src 连 scut_internal.h 一起拷：.c 里 #include 了它，
 *   少了它核心库根本编不过。
 *
 * ★★ 为什么【工程模板】也在这里同步（虽然它不叫 "sdk"）：
 *   同样的漂移问题。extension/package.json 的 files 打的是
 *   extension/templates/**，而源在仓库根 templates/。
 *   如果模板只手工拷，改了仓库根的 camera.c / config.h / README-pic.txt
 *   而忘了同步，学生新建出来的工程就会与仓库里的模板不一致 ——
 *   症状是"文档说的和实际生成的对不上"，同样极难查。
 *   所以模板走同一条同步命令、同一次自检。
 *   （曾经 README-pic.txt 就因为只存在于仓库根、
 *     没进 extension/templates/ 而漏出了 .vsix。本清单就是那次教训的修复。）
 */
const ITEMS = [
    { from: 'core/include', to: 'sdk/core/include', kind: 'dir' },
    { from: 'core/src', to: 'sdk/core/src', kind: 'dir' },
    { from: 'bind/scut_bind.c', to: 'sdk/bind/scut_bind.c', kind: 'file' },
    {
        from: 'backends/headless/scut_headless_main.c',
        to: 'sdk/backends/headless/scut_headless_main.c',
        kind: 'file',
    },
    // ★ tools/ 整目录同步，而不是逐个文件列。
    //   原先这里是两条 `kind: 'file'` 的显式条目（scut_build.py /
    //   scut_symbols.py）。加了第三个脚本（scut_dwarf.py）之后它们没跟着改，
    //   于是 vsix 里的 sdk/tools/ 少了那一个文件 —— 装上去的表现是
    //   "变量面板永远是空的"，而本地仓库里跑测试全绿。列文件就等于
    //   每次新增都要记得回来改两处，早晚漏一次。
    { from: 'tools', to: 'sdk/tools', kind: 'dir' },
    // 工程模板（同样必须随 .vsix 分发，否则「新建工程」按钮是坏的）
    { from: 'templates/starter', to: 'templates/starter', kind: 'dir' },
    { from: 'templates/README-pic.txt', to: 'templates/README-pic.txt', kind: 'file' },
];

/**
 * 必需文件自检清单（相对 extension/）。
 *
 * ★ 这份清单必须覆盖 build.ts 的 locateSdkRoot() 判定所需的最小集合：
 *      sdk/core/include 目录 + sdk/bind/scut_bind.c
 *   少任何一个，locateSdkRoot() 就会返回 undefined，
 *   内置构建路径随即报"插件安装似乎不完整"。所以这里是硬性门槛。
 *
 * ★ 模板两项同样必须检查：少了 scut_project.json，locateTemplateDir() 返回
 *   undefined，「新建工程」直接报错；少了 README-pic.txt，新建出的工程里
 *   就没有放图说明。
 */
const REQUIRED = [
    'sdk/core/include/scut_sdk.h',
    'sdk/bind/scut_bind.c',
    'sdk/backends/headless/scut_headless_main.c',
    'sdk/tools/scut_build.py',
    'sdk/tools/scut_symbols.py',
    // ★ scut_symbols.py 现在 import 同目录的 scut_dwarf，少了它生成器
    //   一启动就 ImportError —— 构建会退化成"没有变量清单"，
    //   而且是在用户的机器上才发现。
    'sdk/tools/scut_dwarf.py',
    'templates/starter/scut_project.json',
    'templates/starter/code/camera.c',
    'templates/README-pic.txt',
];

/**
 * 递归收集一个目录下的全部文件（返回相对该目录的路径，正斜杠分隔）。
 *
 * ★ 跳过 `__pycache__`：`tools/` 是整目录同步的，而跑过一次 Python 之后
 *   那里就会冒出 `.pyc`。把它们打进 vsix 毫无意义，还会让"副本与源不一致"
 *   这条自检在每个人的机器上结果都不一样（.pyc 里带着绝对路径与时间戳）。
 */
function walkFiles(dir, base = dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__pycache__') {
                continue;
            }
            out.push(...walkFiles(abs, base));
        } else if (entry.isFile()) {
            out.push(path.relative(base, abs).replace(/\\/g, '/'));
        }
    }
    return out;
}

function copyItem(item, checkOnly) {
    const src = path.join(REPO_ROOT, item.from);
    // ★ item.to 是相对 extension/ 的路径（如 'sdk/core/include'、'templates/starter'）
    const dst = path.join(EXTENSION_DIR, item.to);

    if (!fs.existsSync(src)) {
        throw new Error(
            `源不存在：${src}\n` +
            `    原因：本脚本必须在完整仓库里运行（它从仓库根同步 SDK 与模板）。\n` +
            `    下一步：确认你在 <仓库>/extension/scripts/ 下运行，且仓库结构完整。`
        );
    }

    if (item.kind === 'file') {
        if (!checkOnly) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
        }
        return 1;
    }

    const files = walkFiles(src);
    if (!checkOnly) {
        // ★ 先删后拷：保证副本与源【完全一致】，不会残留已从源删除的陈旧文件。
        fs.rmSync(dst, { recursive: true, force: true });
        fs.mkdirSync(dst, { recursive: true });
        for (const rel of files) {
            const to = path.join(dst, rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(path.join(src, rel), to);
        }
    }
    return files.length;
}

/**
 * 完整性自检。
 * ★ 除了"文件在不在"，还检查【字节是否一致】—— 手工改过 sdk/ 副本、
 *   或同步中断留下半份文件，都会在这里被抓住。
 */
function verify(checkOnly) {
    const problems = [];

    for (const rel of REQUIRED) {
        const p = path.join(EXTENSION_DIR, rel);
        if (!fs.existsSync(p)) {
            problems.push(`缺少必需文件：extension/${rel}`);
        }
    }

    // core/src 至少要有一批 .c —— 核心库要靠它们现场编译
    const coreSrc = path.join(SDK_DEST, 'core', 'src');
    const coreCs = fs.existsSync(coreSrc)
        ? fs.readdirSync(coreSrc).filter((n) => n.endsWith('.c'))
        : [];
    if (coreCs.length === 0) {
        problems.push('extension/sdk/core/src 下一个 .c 都没有，核心库无法编译');
    }

    // 逐文件比对内容
    // ★★★ 必须【在 --check 模式下也做】★★★
    //   这正是 2026-10-10 踩的坑：副本 extension/sdk/ 停留在"改 RGB 之前"
    //   的版本，插件打出来的包构建用户工程时用的是旧核心（单通道输出 + PGM），
    //   而插件端已按 PPM 解析 —— 魔数对不上，画面全黑，**不报任何错**。
    //
    //   原来的写法是 `if (!checkOnly)` 才比对，于是 --check 永远只查"文件在不在"，
    //   内容漂移查不出来。这个条件必须去掉：两种模式都应该比对内容，
    //   区别只在于 --check 不写入。
    for (const item of ITEMS) {
        const src = path.join(REPO_ROOT, item.from);
        const dst = path.join(EXTENSION_DIR, item.to);
        const rels = item.kind === 'file' ? [''] : walkFiles(src);
        for (const rel of rels) {
            const s = rel ? path.join(src, rel) : src;
            const d = rel ? path.join(dst, rel) : dst;
            if (!fs.existsSync(d)) {
                problems.push(`副本缺失：extension/${item.to}${rel ? '/' + rel : ''}`);
                continue;
            }
            if (!fs.readFileSync(s).equals(fs.readFileSync(d))) {
                problems.push(`副本与源不一致：extension/${item.to}${rel ? '/' + rel : ''}`);
            }
        }
    }

    return { problems, coreCs: coreCs.length };
}

function main() {
    const checkOnly = process.argv.includes('--check');

    console.log('SCUT-71 SDK 同步');
    console.log(`  仓库根  : ${REPO_ROOT}`);
    console.log(`  目标    : ${EXTENSION_DIR}`);
    console.log(`  模式    : ${checkOnly ? '仅检查（--check，不写入）' : '同步'}`);
    console.log('');

    let total = 0;
    for (const item of ITEMS) {
        const n = copyItem(item, checkOnly);
        total += n;
        console.log(`  ${checkOnly ? '检查' : '拷贝'}  ${item.from}  →  ${item.to}  (${n} 个文件)`);
    }
    console.log('');

    const { problems, coreCs } = verify(checkOnly);
    if (problems.length > 0) {
        console.error('SDK 同步自检未通过：');
        for (const p of problems) {
            console.error(`  ✗ ${p}`);
        }
        console.error('');
        console.error('    影响：打出来的 .vsix 会缺少 SDK 或模板，学生装上去一点「编译」/「新建工程」就报错。');
        console.error('    下一步：确认仓库根目录的 core/ bind/ backends/ tools/ templates/ 完整，然后重新运行本脚本。');
        console.error('');
        console.error('  ★★ 若报的是「副本与源不一致」，那说明改了 core/ bind/ backends/ tools/ 之后');
        console.error('     忘了同步 —— 插件构建用户工程用的是 extension/sdk/ 这份副本，');
        console.error('     不是仓库里的源码。打出去的包会带着【旧核心】，症状是静默的（黑屏、');
        console.error('     画面不对），极难定位。修法：node scripts/sync-sdk.js');
        process.exit(1);
    }

    console.log(`  ✓ 自检通过：必需文件齐全，核心源码 ${coreCs} 个 .c，共同步 ${total} 个文件`);
    console.log('');
    console.log('  下一步：cd extension && npx tsc -p ./ && npx vsce package --allow-missing-repository --no-dependencies');
    console.log('  ★ 注意：extension/sdk/ 与 extension/templates/ 都是生成物，已被 extension/.gitignore 忽略；');
    console.log('    但 package.json 的 files 里有 "sdk/**" 与 "templates/**"，所以它们【仍然会】进 .vsix。');
    console.log('    .gitignore 与 files 是两套独立机制，互不影响。');
}

main();
