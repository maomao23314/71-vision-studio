#!/usr/bin/env node
/**
 * check-version.js —— 打包前拦一道：同一个版本号只许打包一次。
 *
 * ============================================================================
 * 为什么需要这个脚本（这是 0.14.1 事故的直接教训）
 * ============================================================================
 *
 *   0.14.1 里 clean/rebuild 两个命令一上手就报错：
 *
 *       $ python <脚本> <脚本> --project … --json
 *       invalid choice: 'c:\...\scut_build.py'
 *
 *   代码当天就修好了，也重新打了一个 0.14.1 的 .vsix。但用户装上之后
 *   【还是同一个错误】—— 因为：
 *
 *     · 用户在 16:20 就打开了窗口，扩展宿主那时把旧的 build.js
 *       读进内存了（require 有缓存）；
 *     · 16:35 装上新包，磁盘上的文件确实被覆盖成了修好的版本；
 *     · 但版本号没变，VS Code 认为"没有更新"，【不提示重新加载窗口】；
 *     · 16:54 点编译，跑的还是 16:20 读进内存的那份旧代码。
 *
 *   也就是说：**改了代码、版本号不变，等于没改。** 磁盘上是对的，
 *   用户手里跑的是旧的，而且没有任何界面提示这件事发生过。
 *
 *   所以版本号在这里不是"发布仪式"，是【让新代码真的生效的唯一开关】。
 *   这个脚本把"忘了改版本号"从一个静默事故变成一次明确的失败。
 *
 * ============================================================================
 * 判定规则
 * ============================================================================
 *   extension/ 下已经有 scut-71-vision-studio-<当前 version>.vsix
 *   → 说明这个版本号已经发出去过，拒绝再打。
 *
 *   确认要覆盖（例如只改了 README、或本地反复试打包）：
 *       SCUT71_ALLOW_REPACK=1 npm run package
 *
 *   只检查、不打包：node scripts/check-version.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXT_DIR = path.dirname(__dirname);
const pkg = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));
const version = pkg.version;
const id = pkg.name || 'scut-71-vision-studio';
const target = path.join(EXT_DIR, `${id}-${version}.vsix`);

if (!fs.existsSync(target)) {
    console.log(`版本检查通过：${version} 还没有打过包。`);
    process.exit(0);
}

if (process.env.SCUT71_ALLOW_REPACK === '1') {
    console.log(`版本检查：${path.basename(target)} 已存在，但设置了 SCUT71_ALLOW_REPACK=1，继续。`);
    process.exit(0);
}

console.error('');
console.error(`打包被拦下：${path.basename(target)} 已经存在。`);
console.error('');
console.error('  同一个版本号重复打包，装到 VS Code 里【不会生效】：');
console.error('  版本号没变，编辑器认为没有更新，不会提示"重新加载窗口"，');
console.error('  正在运行的窗口继续用内存里的旧代码 —— 正是 0.14.1 出事的方式。');
console.error('');
console.error(`  下一步：把 extension/package.json 的 version 改成比 ${version} 更高的一位，`);
console.error('          再执行 npm run package。');
console.error('');
console.error('  确实要覆盖同一个版本号（例如只改了 README）：');
console.error('          SCUT71_ALLOW_REPACK=1 npm run package');
console.error('');
process.exit(1);
