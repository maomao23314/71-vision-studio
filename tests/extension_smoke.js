/**
 * 扩展纯逻辑的 Node 级回归测试（不依赖 VS Code）。
 *
 * 为什么要有这一层：
 *   Webview 内部是无法从扩展宿主断言的（沙箱 + 消息传递）。
 *   但「解析仿真进程的输出」这段逻辑是纯函数，可以脱离 VS Code 直接测，
 *   而它恰恰是最容易悄悄坏掉的部分 —— 协议一变，界面就永远空白。
 *
 * 用法：
 *   node tests/extension_smoke.js [帧目录]
 *
 * ★ 契约说明（本测试与实现对齐，勿凭直觉改）：
 *   · 解析失败一律返回 undefined，不是 null
 *     （null 在这套代码里表示"值就是空"，语义不同）
 *   · parseNumericValues 接收的是一条【已解析的变量条目】，
 *     它自己从 .values 字符串里拆数字
 */
const path = require('path');
const fs = require('fs');

const protocol = require(path.join(__dirname, '..', 'extension', 'out', 'protocol.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

console.log('=== 1. LineSplitter：跨 chunk 边界的行重组 ===');
{
    const sp = new protocol.LineSplitter();
    const lines = [];
    const a = sp.push('{"frame":1,"w":18');
    const b = sp.push('8,"h":120}\n{"frame":2');
    const c = sp.push(',"w":188,"h":120}\n');
    lines.push(...a, ...b, ...c);
    ok('分片重组出 2 行', lines.length === 2, JSON.stringify(lines));
    ok('第 1 行内容正确', lines[0] === '{"frame":1,"w":188,"h":120}', lines[0]);
    ok('第 2 行内容正确', lines[1] === '{"frame":2,"w":188,"h":120}', lines[1]);
    const d = sp.push('partial-no-newline');
    ok('不完整行不提前吐出', d.length === 0, JSON.stringify(d));
    const fin = sp.flush();
    ok('flush 吐出残留', fin.length === 1 && fin[0] === 'partial-no-newline', JSON.stringify(fin));
}

console.log('\n=== 2. parseFrameLine：仿真帧协议 ===');
{
    const line = JSON.stringify({
        frame: 7, w: 188, h: 120,
        img: 'C:\\a\\b\\frame_0007.pgm',
        pic: 'pic/1/7.bmp',
        timing: { processUs: 123.5, drawUs: 4.25, reportUs: 1.5,
                  frameUs: 130.0, cycles: 456789, cyclesValid: true }
    });
    const f = protocol.parseFrameLine(line);
    ok('解析出帧对象', !!f);
    ok('frame 序号', f && f.frame === 7, f && String(f.frame));
    ok('尺寸', f && f.w === 188 && f.h === 120);
    ok('图片路径', f && f.img === 'C:\\a\\b\\frame_0007.pgm', f && f.img);
    ok('输入图路径 pic（本轮新增，必须保留）',
       f && f.pic === 'pic/1/7.bmp', f && JSON.stringify(f.pic));
    ok('计时 processUs', f && f.timing.processUs === 123.5);
    ok('计时 cyclesValid', f && f.timing.cyclesValid === true);
    ok('非法行返回 undefined', protocol.parseFrameLine('not json') === undefined);
    ok('变量行不误判为帧', protocol.parseFrameLine('{"vars":[]}') === undefined);

    // 向后兼容：老后端不发 pic，也必须能解析
    const noPic = JSON.stringify({ frame: 1, w: 188, h: 120, img: 'x.pgm', timing: {} });
    const g = protocol.parseFrameLine(noPic);
    ok('缺 pic 字段仍能解析（向后兼容）', !!g, g === undefined ? 'undefined' : '');
    ok('缺 pic 时 pic 为空串', g && g.pic === '', g && JSON.stringify(g.pic));
}

console.log('\n=== 3. parseVariablesLine：变量协议 ===');
{
    const line = JSON.stringify({
        vars: [
            { name: 'g_threshold', kind: 4, dim: 0, total: 1, values: '75', truncated: false },
            { name: 'g_left_line', kind: 4, dim: 1, total: 120, values: '0 1 2', truncated: true }
        ]
    });
    const v = protocol.parseVariablesLine(line);
    ok('解析出变量数组', Array.isArray(v) && v.length === 2);
    ok('标量名', v && v[0].name === 'g_threshold');
    ok('标量值', v && v[0].values === '75');
    ok('数组截断标记', v && v[1].truncated === true);
    ok('非变量行返回 undefined',
       protocol.parseVariablesLine('{"frame":1}') === undefined);

    // ★ parseNumericValues 的入参是【空格分隔的字符串】（即 .values 字段本身），
    //   不是变量条目对象。传对象会直接抛异常 —— 这条断言就是防止这个误用。
    const nums = protocol.parseNumericValues(v[1].values);
    ok('数值解析', nums.length === 3 && nums[0] === 0 && nums[2] === 2, nums.join(','));
    // 结构体/指针这类非数值记号必须被跳过，而不是变成 NaN
    const weird = protocol.parseNumericValues('<24 bytes>');
    ok('非数值记号被跳过', weird.length === 0, JSON.stringify(weird));
    // 空串不能抛异常（大数组被完全截断时会出现）
    ok('空串安全', protocol.parseNumericValues('').length === 0);
    // 指针的十六进制记号也不该被当成数字
    ok('十六进制记号安全', protocol.parseNumericValues('0x4050b0').length === 0);
}

console.log('\n=== 4. parsePgm：真实仿真输出 ===');
{
    const dir = process.argv[2];
    if (dir && fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.pgm')).sort();
        ok('找到 PGM 文件', files.length > 0, dir);
        if (files.length) {
            const buf = fs.readFileSync(path.join(dir, files[0]));
            const img = protocol.parsePgm(new Uint8Array(buf));
            ok('解析出图像', !!img);
            if (!img) {
                console.log('  (后续 PGM 断言跳过)');
            } else {
                // ★ 字段名是 gray（不是 pixels）—— 与 PgmImage 接口一致
                ok('宽度 188', img.width === 188, String(img.width));
                ok('高度 120', img.height === 120, String(img.height));
                ok('像素数 = w*h', img.gray.length === 188 * 120,
                   String(img.gray.length));
                let nz = 0;
                for (const p of img.gray) if (p) nz++;
                ok('图像非全黑（证明加载链路通）', nz > 0, 'non-zero=' + nz);
                console.log('        ' + files[0] + ': ' + img.width + 'x' + img.height +
                            ', 非零像素 ' + nz + ' / ' + img.gray.length);
            }
        }
    } else {
        console.log('  SKIP  未提供帧目录（用法: node tests/extension_smoke.js <帧目录>）');
    }
}

console.log('\n=== 5. parsePgm：畸形输入必须安全 ===');
{
    ok('空 buffer', protocol.parsePgm(new Uint8Array(0)) === undefined);
    ok('非 P5 魔数',
       protocol.parsePgm(new Uint8Array(Buffer.from('P6\n1 1\n255\n'))) === undefined);
    ok('头部被截断',
       protocol.parsePgm(new Uint8Array(Buffer.from('P5\n188'))) === undefined);
    let threw = false;
    try { protocol.parsePgm(new Uint8Array(Buffer.from('P5\n2 2\n255\n\x01'))); }
    catch (e) { threw = true; }
    ok('数据不足不抛异常', !threw);
}

console.log('\n=== 6. 诊断解析（编译错误 -> Problems 面板）===');
{
    const text = [
        "code/main.c:42:5: error: expected ';' before '}' token",
        "code/main.c:50:9: warning: unused variable 'x' [-Wunused-variable]",
        'D:/a b/c.c:7:1: error: something bad'
    ].join('\n');
    const d = protocol.parseDiagnostics(text);
    ok('解析出 3 条', d.length === 3, String(d.length));
    ok('第 1 条是 error', d[0] && d[0].severity === 'error');
    ok('行号正确', d[0] && d[0].line === 42, d[0] && String(d[0].line));
    ok('第 2 条是 warning', d[1] && d[1].severity === 'warning');
    ok('带空格路径也能解析', d[2] && d[2].line === 7);
}

console.log('\n=== 7. 真实进程输出端到端（协议一致性）===');
{
    const dir = process.argv[2];
    const sim = process.argv[3];
    if (sim && fs.existsSync(sim)) {
        const { spawnSync } = require('child_process');
        const r = spawnSync(sim, ['--frames', '2', '--json', '--out',
                                  path.join(path.dirname(sim), 'frames')],
                            { encoding: 'buffer', cwd: path.dirname(path.dirname(path.dirname(sim))) });
        const text = r.stdout.toString('utf8');
        const sp = new protocol.LineSplitter();
        const lines = sp.push(text).concat(sp.flush());
        let frames = 0, varLines = 0;
        for (const ln of lines) {
            if (protocol.parseFrameLine(ln)) frames++;
            if (protocol.parseVariablesLine(ln)) varLines++;
        }
        ok('真实输出解析出 2 帧', frames === 2, 'got ' + frames);
        ok('真实输出解析出变量行', varLines >= 1, 'got ' + varLines);
    } else {
        console.log('  SKIP  未提供仿真程序路径（第 3 个参数）');
    }
}

console.log('\n' + '='.repeat(50));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
