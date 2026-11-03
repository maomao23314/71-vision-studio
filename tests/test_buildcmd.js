#!/usr/bin/env node
/**
 * test_buildcmd.js —— 在真实 Node 里跑 extension/out/buildcmd.js，检查插件
 * 实际拼出来的命令行。
 *
 * ★★ 这个测试存在的理由（它补的是一个真实事故的缺口）★★
 *
 *   0.14.1 发布版里，`scut71.clean` 一上手就失败：
 *
 *       $ python clean --project <工程> --json
 *       python: can't open file '...\clean': [Errno 2] No such file or directory
 *
 *   漏的是【排在第一位的脚本路径】。python 的第一个位置参数是要执行的脚本，
 *   不是子命令 —— 于是 python 去找一个叫 `clean` 的文件。
 *   编译那条路同一个 bug，一起坏。
 *
 *   为什么既有测试全都没红？因为**所有测试都是直接调用 python 脚本**：
 *
 *       subprocess.run([sys.executable, BUILD, 'clean', '--project', proj])
 *
 *   也就是说，"脚本路径排第一"这件事是测试【自己写对】的，被测代码
 *   （插件拼 argv 的那段）从来没被一条测试执行过。
 *
 *   这个文件补的就是那一段：加载编译产物 buildcmd.js，断言 argv 的形状。
 *
 * ★ 为什么跑 out/ 里的 .js 而不是 src/ 里的 .ts：
 *   buildcmd.ts 刻意不 import 'vscode'，所以它的编译产物可以直接 require。
 *   跑【产物】而不是【源码】还有一个好处：tsc 漏编 / 输出目录不对
 *   这类问题也会被这条测试发现。
 *
 * ★ 前置条件：extension/out/buildcmd.js 必须存在。
 *   不存在就让本测试【失败】而不是跳过 —— 跳过会让"忘了编译"
 *   看起来像"通过"。（run_all_tests.py 里跑 extension 之前会先 tsc。）
 *
 * 用法：node tests/test_buildcmd.js
 * 退出码 0 = 全部通过。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const OUT = path.join(ROOT, 'extension', 'out', 'buildcmd.js');

let checks = 0;
const failures = [];

function check(cond, msg, extra) {
    checks += 1;
    if (cond) {
        console.log('  [OK]   ' + msg);
    } else {
        failures.push(msg);
        console.log('  [FAIL] ' + msg + (extra ? '  -> ' + extra : ''));
    }
}

if (!fs.existsSync(OUT)) {
    console.error('找不到编译产物：%s' % OUT);
    console.error('  下一步：先在 extension/ 下执行 npx tsc -p ./');
    process.exit(1);
}

const { buildScriptArgs } = require(OUT);

const SCRIPT = 'C:\\ext\\sdk\\tools\\scut_build.py';
const PROJ = 'D:\\proj';
const TC = 'D:\\TOOLS\\llvm-mingw';

/* ------------------------------------------------------------------ */
/* 1. 脚本路径必须是第 0 项                                            */
/* ------------------------------------------------------------------ */
console.log('\n[1] 脚本路径排第一（python 的第一个位置参数是脚本，不是子命令）');

for (const cmd of ['build', 'clean', 'doctor']) {
    const a = buildScriptArgs(SCRIPT, cmd, { projectRoot: PROJ, autoWatch: true });
    // ★ 这一条就是那个事故的判据。写成"参数里包含脚本路径"是不够的：
    //   它必须【恰好排第一】，因为 python 只认第一个位置参数。
    check(a[0] === SCRIPT,
          cmd + '：argv[0] 是脚本路径',
          JSON.stringify(a));
}

/* ------------------------------------------------------------------ */
/* 2. 子命令的位置                                                     */
/* ------------------------------------------------------------------ */
console.log('\n[2] build 是默认子命令（不写出来），clean/doctor 必须显式且排在脚本之后');

const aBuild = buildScriptArgs(SCRIPT, 'build', { projectRoot: PROJ, autoWatch: true });
check(!aBuild.includes('build'),
      'build 不显式写出（它是脚本的默认子命令）',
      JSON.stringify(aBuild));
check(aBuild[1] === '--project',
      'build 的 argv[1] 直接是 --project（中间没有子命令）',
      JSON.stringify(aBuild));

const aClean = buildScriptArgs(SCRIPT, 'clean', { projectRoot: PROJ, autoWatch: true });
check(aClean[1] === 'clean',
      'clean 排在脚本之后（argv[1]）',
      JSON.stringify(aClean));

const aDoctor = buildScriptArgs(SCRIPT, 'doctor', { projectRoot: PROJ, autoWatch: true });
check(aDoctor[1] === 'doctor',
      'doctor 排在脚本之后（argv[1]）',
      JSON.stringify(aDoctor));

/* ------------------------------------------------------------------ */
/* 3. 必传选项                                                         */
/* ------------------------------------------------------------------ */
console.log('\n[3] --project 与 --json 恒传');

for (const cmd of ['build', 'clean']) {
    const a = buildScriptArgs(SCRIPT, cmd, { projectRoot: PROJ, autoWatch: true });
    const pi = a.indexOf('--project');
    check(pi >= 0 && a[pi + 1] === PROJ,
          cmd + '：--project 带着工程目录',
          JSON.stringify(a));
    // --json 决定 stdout 的契约：不传的话进度文字会混进 stdout，
    // parseScriptJson 只能靠"找第一段能解析的 {...}"去猜。
    check(a.includes('--json'), cmd + '：传了 --json', JSON.stringify(a));
}

/* ------------------------------------------------------------------ */
/* 4. 可选选项只在有值时出现                                           */
/* ------------------------------------------------------------------ */
console.log('\n[4] 可选选项：空值不许出现在 argv 里');

const aMin = buildScriptArgs(SCRIPT, 'build', { projectRoot: PROJ, autoWatch: true });
check(!aMin.includes('--toolchain'), '工具链根为空时不传 --toolchain', JSON.stringify(aMin));
check(!aMin.includes('--no-watch'), 'autoWatch=true 时不传 --no-watch', JSON.stringify(aMin));
check(!aMin.includes('--exclude'), '黑名单为空时不传 --exclude', JSON.stringify(aMin));
check(!aMin.includes('--max-elems'), '元素数上限为 0 时不传 --max-elems', JSON.stringify(aMin));

const aFull = buildScriptArgs(SCRIPT, 'build', {
    projectRoot: PROJ, toolchainRoot: TC, autoWatch: false,
    watchExclude: ' big_a , big_b ', watchMaxElems: 256,
});
const tcI = aFull.indexOf('--toolchain');
check(tcI >= 0 && aFull[tcI + 1] === TC, '有工具链根时传 --toolchain', JSON.stringify(aFull));
check(aFull.includes('--no-watch'), 'autoWatch=false 时传 --no-watch', JSON.stringify(aFull));
const exI = aFull.indexOf('--exclude');
// ★ 必须 trim：带空格的 " big_a , big_b " 传给脚本，scut_symbols 会把
//   每一项都当成"名字前后带空格的变量"，于是一个都匹配不上（静默）。
check(exI >= 0 && aFull[exI + 1] === 'big_a , big_b',
      '--exclude 去掉了首尾空白', JSON.stringify(aFull));
const mxI = aFull.indexOf('--max-elems');
check(mxI >= 0 && aFull[mxI + 1] === '256', '--max-elems 带上了数字', JSON.stringify(aFull));

/* ------------------------------------------------------------------ */
/* 5. clean 不带无关选项                                               */
/* ------------------------------------------------------------------ */
console.log('\n[5] clean 只删目录，不带变量发现 / 工具链相关的选项');

const aClean2 = buildScriptArgs(SCRIPT, 'clean', {
    projectRoot: PROJ, toolchainRoot: TC, autoWatch: false,
    watchExclude: 'big_a', watchMaxElems: 256,
});
// ★ 无意义的参数出现在日志里，是排查时最容易误导人的东西：
//   "为什么清理也要 --no-watch？" 会让用户以为清理受影响于变量发现。
for (const bogus of ['--no-watch', '--exclude', '--max-elems', '--toolchain']) {
    check(!aClean2.includes(bogus),
          'clean 不传 ' + bogus, JSON.stringify(aClean2));
}

/* ------------------------------------------------------------------ */
/* 6. 端到端：拼出来的 argv 真的能跑                                   */
/* ------------------------------------------------------------------ */
console.log('\n[6] 拿拼出来的 argv 真的执行一次（--help），证明 python 认得它');

const { spawnSync } = require('child_process');
// ★ 解释器由调用方给（run_all_tests.py 传 sys.executable）。
//   刻意【不】在这里用裸 `python`：本机 PATH 上的那个是 3.6.2，
//   scut_build.py 用了 `from __future__ import annotations`，
//   3.6 会直接 SyntaxError —— 那会让这条测试报一个与 argv 无关的假失败。
//   没给就报错而不是猜，猜出来的解释器会让"到底是哪坏了"变得不可知。
const PY = process.env.SCUT71_TEST_PYTHON;
if (!PY) {
    check(false, '缺少 SCUT71_TEST_PYTHON（测试需要知道用哪个 python）');
}
const BUILTIN = path.join(ROOT, 'tools', 'scut_build.py');
if (!fs.existsSync(BUILTIN)) {
    check(false, '找不到 tools/scut_build.py（测试自身前置条件）');
} else if (PY) {
    // ★ 这里用 --help 而不是真的构建：--help 不碰磁盘，但它同样要求
    //   "脚本路径排第一"（否则 python 会抱怨找不到文件）。
    //   对 build / clean / doctor 都跑一遍。
    //
    // ★★ 注意这里【不做任何额外拼接】★★
    //   runScript 收到的就是 buildScriptArgs 的输出原样（它已经不含 script
    //   参数，结构上无法再插一次）。所以测试要验证的正是"buildScriptArgs
    //   的输出，就是 python 真正收到的 argv" —— 中间不许有第三只手。
    //   0.14.1 第二次事故恰好是测试只测了 buildScriptArgs、而 runScript
    //   又加了一次，两边都"正确"、合起来是错的。
    for (const cmd of ['build', 'clean', 'doctor']) {
        const argv = buildScriptArgs(BUILTIN, cmd, { projectRoot: PROJ, autoWatch: true });
        const r = spawnSync(PY, [...argv, '--help'], {
            encoding: 'utf8', timeout: 60000, windowsHide: true,
        });
        const out = (r.stdout || '') + (r.stderr || '');
        // argparse 的 --help 退出码是 0；找不到脚本时 python 退出码是 2 且
        // 文案里带 "can't open file"。
        check(r.status === 0,
              cmd + '：拼出来的 argv 能被 python 正常执行',
              '退出码 ' + r.status + '，输出尾部：' + out.slice(-200));
        check(!/can't open file|No such file or directory/i.test(out),
              cmd + '：没有出现「找不到文件」',
              out.slice(-200));
    }
}

/* ------------------------------------------------------------------ */
/* 7. 脚本路径不许重复（第二次事故的判据）                             */
/* ------------------------------------------------------------------ */
console.log('\n[7] 脚本路径在最终 argv 里【恰好一次】');

// ★ 这一组是 0.14.1 第二次事故的判据。当时 buildScriptArgs 与 runScript
//   各加一次脚本路径，得到 `python <脚本> <脚本> --project …`，
//   argparse 把第二个脚本当成子命令，报
//     invalid choice: 'c:\...\scut_build.py' (choose from 'build','doctor','clean')
//   只测 buildScriptArgs 是抓不到的 —— 必须测【组装链的最终结果】。
for (const cmd of ['build', 'clean', 'doctor']) {
    const argv = buildScriptArgs(SCRIPT, cmd, { projectRoot: PROJ, autoWatch: true });
    const hits = argv.filter((s) => s === SCRIPT).length;
    check(hits === 1,
          cmd + '：脚本路径恰好出现 1 次（现在是 ' + hits + ' 次）',
          JSON.stringify(argv));
    check(argv[1] !== SCRIPT,
          cmd + '：argv[1] 不是脚本路径（否则会被 argparse 当成子命令）',
          JSON.stringify(argv));
}

// 子命令仍须恰好一次：重复的 `clean clean` 同样会被 argparse 拒绝。
for (const cmd of ['clean', 'doctor']) {
    const argv = buildScriptArgs(SCRIPT, cmd, { projectRoot: PROJ, autoWatch: true });
    const n = argv.filter((s) => s === cmd).length;
    check(n === 1, cmd + '：子命令恰好出现 1 次', JSON.stringify(argv));
}

/* ------------------------------------------------------------------ */
/* 8. 结构守卫：runScript 不许自己再拼一次脚本路径                      */
/* ------------------------------------------------------------------ */
console.log('\n[8] runScript 的签名里没有 script 参数（结构上无法重复插入）');

// ★ 这条是【源码级】的守卫，但守的是行为：runScript 若还收 script 参数，
//   就又有两个负责方了 —— 那是三次事故的共同成因。
//   判据放在这里而不是 test_cleanup.py：它和上面第 7 组是同一件事的两面，
//   放在一起读得懂"为什么"。
const BUILD_TS = path.join(ROOT, 'extension', 'src', 'build.ts');
if (!fs.existsSync(BUILD_TS)) {
    check(false, '找不到 extension/src/build.ts（测试自身前置条件）');
} else {
    const src = fs.readFileSync(BUILD_TS, 'utf8');
    // 去掉注释再查，避免"解释为什么不能这么做"的注释被判成违规。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const m = /async function runScript\(\s*([^)]*)\)/.exec(code);
    check(m !== null, 'build.ts 里能定位到 runScript 的签名');
    if (m) {
        const params = m[1];
        check(!/\bscript\s*:/.test(params),
              'runScript 没有 script 参数（脚本路径只由 buildScriptArgs 产出）',
              '签名：' + params.replace(/\s+/g, ' ').trim());
        check(/argv\s*:/.test(params),
              'runScript 收的是完整 argv',
              '签名：' + params.replace(/\s+/g, ' ').trim());
    }
    // 反向：runScript 体内不许出现 [script, 这种前置拼接。
    check(!/\[\s*script\s*,/.test(code),
          'build.ts 里没有 [script, ...] 这样的前置拼接');

    // ★★ 最贴近真实事故形态的一条：调用点必须是 runScript(buildScriptArgs(...))
    //   第二次事故的实际写法就是在这个位置多包了一层 ——
    //     runScript([script, ...buildScriptArgs(...)], ...)
    //   或
    //     runScript([found.script, ...buildScriptArgs(...)], ...)
    //   上面那条 [script, 正则抓不到 found.script 这种写法（名字不同），
    //   所以这里查【结构】：每个 runScript 调用的第一个实参，
    //   必须【直接就是】buildScriptArgs(...)，前面不许有任何元素。
    // ★ 用 lookbehind 排除定义本身（`async function runScript(argv, …)`
    //   的 "(" 前面是函数名，不是调用）。不用它就会把签名判成一次调用。
    const calls = [...code.matchAll(/(?<!function )runScript\(\s*([^\s(])/g)];
    check(calls.length === 2,
          'build.ts 里恰好有 2 个 runScript 调用点（build 与 clean）',
          '实际 ' + calls.length + ' 个');
    for (const c of calls) {
        check(c[1] === 'b',
              'runScript 的第一个实参直接是 buildScriptArgs(...)，前面没有插东西',
              '实际以 "' + c[1] + '" 开头');
    }
}

/* ------------------------------------------------------------------ */
console.log('\n' + '='.repeat(60));
if (failures.length === 0) {
    console.log('全部 %d 项通过', checks);
} else {
    console.log('%d/%d 项通过，%d 项失败：', checks - failures.length, checks, failures.length);
    for (const f of failures) {
        console.log('  - ' + f);
    }
}
console.log('='.repeat(60));
process.exit(failures.length === 0 ? 0 : 1);
