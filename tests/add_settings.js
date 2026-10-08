/** 加三个钩子函数设置项（GUI 注册）。安全版本：完整读入再写回。 */
const fs = require('fs');
const f = 'extension/package.json';
const j = JSON.parse(fs.readFileSync(f, 'utf8'));
const props = j.contributes.configuration.properties;

props['scut71.initFunctions'] = {
    type: 'string',
    default: '',
    editPresentation: 'multilineText',
    markdownDescription:
        '**初始化函数**（启动时调用一次，不计时）。\n\n' +
        '填用户代码里的函数名，每行一个，按顺序执行。例如：\n\n' +
        '    my_init\n    Perspective_Init\n\n' +
        '留空 = 没有初始化钩子。注册写在【插件设置】里而不是用户代码里，' +
        '这样用户代码保持与车载工程完全一致、直接可移植。',
};
props['scut71.frameFunctions'] = {
    type: 'string',
    default: '',
    editPresentation: 'multilineText',
    markdownDescription:
        '**图像处理函数**（每帧调用，★ 计时段 —— 测速测的就是它）。\n\n' +
        '填用户代码里的函数名，每行一个。例如：\n\n' +
        '    image_process\n\n' +
        '留空 = 没有处理钩子（画面只显示输入图）。',
};
props['scut71.postFunctions'] = {
    type: 'string',
    default: '',
    editPresentation: 'multilineText',
    markdownDescription:
        '**后处理函数**（每帧调用一次，不计时：覆盖层、日志等观测用）。\n\n' +
        '填用户代码里的函数名，每行一个。例如：\n\n' +
        '    my_draw\n    my_report\n',
};

fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log('  OK settings added:',
    Object.keys(props).filter(k => k.includes('Functions')).join(', '));
