/**
 * 判定：帧行（含 vars 字段）会被 parseVariablesLine 抢走吗？
 * 用户实测"重新编译后图片全没了"——嫌疑是 0.8.0 的每帧 vars 内嵌
 * 让帧行同时匹配两种解析器，而 handleLine 先试 vars。
 */
const path = require('path');
const proto = require(path.join('D:', '22车队管理', '一轮考核', '视觉组',
    'SCUT-71-vision-studio', 'extension', 'out', 'protocol.js'));

const frameLine = '{"frame":1,"w":188,"h":120,"img":"x.pgm","pic":"p.bmp",' +
    '"vars":[{"name":"a","kind":4,"dim":0,"total":1,"values":"1","truncated":false}],' +
    '"timing":{"processUs":1}}';

const asVars = proto.parseVariablesLine(frameLine);
const asFrame = proto.parseFrameLine(frameLine);

console.log('  parseVariablesLine(帧行):',
    asVars ? ('返回 ' + asVars.length + ' 条 —— 【抢走了】') : 'undefined');
console.log('  parseFrameLine(帧行)   :',
    asFrame ? '正常解析' : 'undefined');

// handleLine 的顺序是先 vars 后 frame：
if (asVars) {
    console.log('\n  ❌❌ 根因确认：帧行被 parseVariablesLine 抢走，');
    console.log('     handleLine 走 vars 分支 return，永远不会画帧 → 画面全黑。');
    console.log('     修复：handleLine 先试 parseFrameLine（帧行有 "frame" 字段），');
    console.log('     或者 vars 分发只在【独立 vars 行】（无 frame 字段）时走。');
    process.exit(1);
} else {
    console.log('\n  parse 不冲突，问题在别处');
}
