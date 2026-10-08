/**
 * 校验「主动暴露」这条链路：从清单 + 运行期注册表出发，复现宿主侧
 * augmentManifestFromRuntime 的分组结果，确认 7 个手写变量被标成 manual。
 *
 * 用法：node tests/manual_vars.js <工程目录>
 */
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const proj = process.argv[2];
if (!proj || !fs.existsSync(path.join(proj, '.scut', 'gen', 'variables.json'))) {
    console.log('  SKIP  需要一个已构建的工程: node tests/manual_vars.js <工程目录>');
    process.exit(0);
}

const manifest = JSON.parse(
    fs.readFileSync(path.join(proj, '.scut', 'gen', 'variables.json'), 'utf8').replace(/^\uFEFF/, ''));
const exe = path.join(proj, '.scut', 'bin', 'scut_sim.exe');
const r = cp.spawnSync(exe, ['--list-vars', '--json'], { encoding: 'utf8', cwd: proj });
const line = (r.stdout || '').split('\n').filter((l) => l.includes('"vars"')).pop();
// ★ --list-vars 输出的数组键是 "vars"，而 .vars.json 里是 "variables"。
//   两者不同名（一个是运行期注册表，一个是编译期清单），这里统一一下。
const runtimeParsed = line ? JSON.parse(line.trim()) : {};
const runtime = {
    variables: runtimeParsed.vars || runtimeParsed.variables || [],
};

console.log('=== 1. 源码扫描结果进了清单 ===');
const manualNames = new Set(manifest.manualWatches || []);
ok('manifest.manualWatches 非空', manualNames.size > 0,
    `size=${manualNames.size}`);
// ★ 不写死具体名字：这套测试要能跑在【任何】工程上（模板工程里手写注册的
//   名字完全不同）。写死名字会让它"在真实工程上通过、在模板工程上失败"，
//   看起来像是功能坏了，其实只是测试与具体工程耦合。
ok('手写名字都是合法 C 标识符',
    [...manualNames].every((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)),
    [...manualNames].join(','));

console.log('\n=== 2. 手写注册【真的执行了】 ===');
const rtNames = new Set(runtime.variables.map((v) => v.name));
for (const n of manualNames) {
    ok(`运行期注册表里有 ${n}`, rtNames.has(n));
}

console.log('\n=== 3. 宿主侧分组（复刻 build.ts 的逻辑）===');
const known = new Set((manifest.variables || []).map((v) => v.name));
const mark = (v) => ({ ...v, manual: manualNames.has(v.name) || v.manual === true });
const all = (manifest.variables || []).map(mark);
const manual = all.filter((v) => v.manual);
const auto = all.filter((v) => !v.manual);
const extra = runtime.variables.filter((v) => !known.has(v.name)).map(mark);
// 与 build.ts 一致：手动项要先挑出来置顶（DWARF 清单里的 + 运行期独有的）
const merged = [...manual, ...extra.filter((v) => v.manual),
    ...auto, ...extra.filter((v) => !v.manual)];

ok('合并后 7 个手写变量全部标记为 manual',
    manualNames.size > 0 && [...manualNames].every((n) =>
        merged.some((v) => v.name === n && v.manual === true)),
    `manual 条目=${manual.length}`);
ok('合并总数 = 清单 + 运行期独有',
    merged.length === (manifest.variables || []).length + extra.length,
    `${merged.length}`);
ok('手动项排在自动项前面（用户要求：主动在前）',
    merged.findIndex((v) => v.manual === true) < merged.findIndex((v) => !v.manual));

console.log('\n=== 4. 显示规则：主动恒显示、自动看勾选 ===');
// 模拟 simview.sendSnapshot 的过滤条件
function shown(selected) {
    const names = new Set(merged.filter((v) => v.manual).map((v) => v.name));
    return runtime.variables.filter(
        (v) => names.has(v.name) || selected.has(v.name)).map((v) => v.name);
}
const none = new Set();
const s0 = shown(none);
ok('一个都不勾时，手写变量仍然可见', manualNames.size > 0 &&
    [...manualNames].every((n) => s0.includes(n)), `可见 ${s0.length} 个`);
ok('一个都不勾时，自动变量不可见',
    !s0.some((n) => auto.some((a) => a.name === n)),
    s0.join(','));

// 随便挑一个自动变量（不写死名字）验证勾选能加进来
const anyAuto = auto.find((v) => v.total <= 512 && v.name !== null);
if (anyAuto) {
    const withOne = shown(new Set([anyAuto.name]));
    ok(`勾选 ${anyAuto.name} 后多出一个`, withOne.length === s0.length + 1 &&
        withOne.includes(anyAuto.name));
} else {
    ok('存在可用于勾选验证的自动变量', false, '清单里没有自动变量');
}

console.log(`\n${pass + fail} assertions, ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);