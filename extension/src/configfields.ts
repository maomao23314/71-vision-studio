/**
 * configfields.ts —— 配置面板的字段表。
 *
 * ★ 为什么单独一个文件 ★
 *   字段的"路径 / 标题 / 类型 / 提示"在这里定义【一次】，
 *   面板（settingsview.ts + media/settingsview.js）都读它。
 *   之前字段散在 projectconfig.ts 的映射表和 package.json 里，
 *   改一处忘另一处就会出现"设置里有、代码读不到"的静默失效 ——
 *   0.9.3 的坑就是这么来的。
 *
 * ★ 类型说明 ★
 *   text      单行文本
 *   number    数字（面板里做整数校验）
 *   lines     多行文本，每行一项 → 字符串数组（钩子函数名用）
 *   bool      开关
 *   folder    目录（点按钮走系统对话框）
 *   file      单个文件（Python 解释器用）
 */

/* ★ 这里原先 import 了 ProjectConfig —— 随 pickValue/setValue 一起删掉后
 *   它就没有消费者了。本文件只描述"字段长什么样"，不读写配置。 */

/** 一级配置键（与 projectconfig.ts 的 ProjectConfig 字段一一对应）。 */
export type SectionKey =
    | 'image'
    | 'inputArray'
    | 'outputArray'
    | 'hooks'
    | 'pic'
    | 'run'
    | 'toolchain';

export type FieldKind = 'text' | 'number' | 'lines' | 'bool' | 'folder' | 'file';

export interface FieldDef {
    /** 在 scut_project.json 里的路径 */
    path: string[];
    label: string;
    kind: FieldKind;
    /** 面板里显示在字段下方的一句话 */
    hint?: string;
    /** 控件后缀，如 px、ms */
    unit?: string;
    /** 是否需要重新编译才生效 */
    rebuild?: boolean;
}

export interface SectionDef {
    /**
     * 分组的稳定 id —— **只**用于 DOM 的 `data-group`，与配置键无关。
     *
     * ★ 为什么它不再等于"配置的一级键"（一次真实缺陷的修复）：
     *   原先一个分组只能装【一个】一级键（`f.path[0] === s.key`），
     *   于是 `inputArray` 与 `outputArray` 这两个同一类的字段
     *   只能有一个分组接收 —— 结果是 `outputArray`（结果图数组名）
     *   从 0.9.4 起【从来没有在面板上出现过】：用户翻遍面板都找不到
     *   "结果图数组名"这一项，只能靠手改 JSON 或那个一次性输入框向导。
     *   现在分组用 `keys` 声明它负责哪几个一级键，想装几个装几个。
     */
    key: string;
    /** 这个分组负责显示哪些一级配置键。FIELDS 里每个 path[0] 必须被【恰好一个】分组覆盖。 */
    keys: string[];
    title: string;
    note: string;
}

export const SECTIONS: SectionDef[] = [
    {
        key: 'image', keys: ['image'], title: '图像尺寸',
        note: '编译期契约 · 改动需重新编译',
    },
    {
        key: 'array', keys: ['inputArray', 'outputArray'], title: '图像数组',
        note: '编译期契约 · 输入图与结果图',
    },
    {
        key: 'hooks', keys: ['hooks'], title: '钩子函数',
        note: '编译期契约 · 决定环境调用哪些函数',
    },
    { key: 'pic', keys: ['pic'], title: '测试图集', note: '改完立即生效' },
    { key: 'run', keys: ['run'], title: '运行期', note: '改完立即生效' },
    { key: 'toolchain', keys: ['toolchain'], title: '工具链', note: '本机环境' },
];

/**
 * 字段表。顺序即面板显示顺序。
 *
 * ★ 更正（这条注释原先自相矛盾，2026-10-11 修）：
 *   它曾写着"注意 pic.start 【不在这里】"，而下面的 FIELDS 里
 *   明明就有 path:['pic','start'] —— 注释与代码直接打架，
 *   读代码的人会以为那个字段不存在。
 *
 *   现在的说明（与代码一致）：
 *     pic.start 就排在图集那一组里，紧跟 pic.ext 之后。
 *     它与 image（画布尺寸）含义不同，所以 hint 里各自写清了，
 *     但没有把它挪出本表 —— 它是设置项，就该出现在设置面板里。
 */
export const FIELDS: FieldDef[] = [
    {
        path: ['image', 'width'], label: '图像宽度', kind: 'number',
        unit: 'px', rebuild: true,
        hint: '必须与 pic/ 里的测试图一致，否则读到的像素会错位',
    },
    {
        path: ['image', 'height'], label: '图像高度', kind: 'number',
        unit: 'px', rebuild: true,
        hint: '同上',
    },
    {
        path: ['inputArray'], label: '输入图像数组名', kind: 'text',
        rebuild: true,
        hint: '环境会定义一个同名同形状的全局数组，你的算法按名字访问它。'
            + '车载库里常见的是 mt9v03x_image',
    },
    {
        path: ['outputArray'], label: '结果图数组名', kind: 'text',
        rebuild: true,
        hint: '留空 = 画面只显示输入图；填了才显示算法结果，例如 binary_image',
    },
    {
        path: ['hooks', 'init'], label: '开机函数', kind: 'lines',
        rebuild: true,
        hint: '开机调用一次，不计时。每行一个，例如 camera_init',
    },
    {
        path: ['hooks', 'frame'], label: '每帧处理函数', kind: 'lines',
        rebuild: true,
        hint: '每帧调用，★ 计时段就是这里。每行一个，例如 image_process',
    },
    {
        path: ['hooks', 'post'], label: '每帧后处理函数', kind: 'lines',
        rebuild: true,
        hint: '每帧调用，不计时。每行一个，例如 camera_draw、camera_report',
    },
    {
        path: ['pic', 'dir'], label: '图集目录', kind: 'folder',
        hint: '相对工程根目录。留空 = 用 pic/。★ 改完立即生效，不需要重新编译',
    },
    {
        path: ['pic', 'ext'], label: '图集后缀', kind: 'text',
        hint: '可填多个，逗号分隔，例如 .png,.bmp,.jpg —— 仿真会逐一尝试，'
            + '所以同一个目录里混着多种格式也能跑。留空 = 自动探测常见格式。'
            + '★ 改完立即生效，不需要重新编译',
    },
    {
        path: ['pic', 'start'], label: '图集起始编号', kind: 'number',
        hint: '从第几张图开始跑。★ 省略或留空时默认按 1 起编号 —— '
            + '如果你的图集是 0 起的（pic/0.png、pic/1.png…），'
            + '这里必须显式填 0，否则第 0 张永远轮不到。'
            + '（后端也会自己探测 0.<ext> 是否存在，但显式填最稳。）',
    },
    {
        path: ['run', 'processRepeat'], label: '每帧重复次数', kind: 'number',
        hint: '大于 1 时每帧跑多遍取平均，结果更稳，耗时也成倍',
    },
    /* ★ 这里原先还有「运行」连跑帧数（run.runFrames）。
     *   那个功能在 0.10.6 连同按钮一起删了（用户原话："这个功能没意义"），
     *   字段自然也不该留在面板上 —— 留着就是"配了没用"。 */
    {
        path: ['run', 'benchRepeat'], label: '「测速」重复次数', kind: 'number',
        hint: '点「测速」时对同一张图重复几遍取平均周期数',
    },
    // ★ 这里【故意】没有 view 段 ★
    //   初版加了 showTiming / showVariables / showLog / pickPersist 四个开关，
    //   但全项目没有任何代码读取它们 —— 面板一直按自己的方式显示，
    //   勾不勾都一样。留着就是骗人的死界面：用户勾了「不显示日志」，
    //   日志照旧出现，于是反过来怀疑"是不是我用的方式不对"。
    //   勾选变量的持久化也已由面板自己的 setState 完成，不在这里重复。
    //
    //   教训：把字段名写进 UI 很容易，难的是先确认有人真的读它。
    {
        path: ['toolchain', 'path'], label: '工具链根目录', kind: 'folder',
        hint: '内含 bin\\clang.exe 的那一层。留空 = 自动探测：'
            + '环境变量 → 已下载的目录 → PATH',
    },
    {
        path: ['toolchain', 'pythonPath'], label: 'Python 解释器路径', kind: 'file',
        hint: '跑构建脚本用，只要求 3.7+，不需要装任何第三方库。'
            + 'conda / 官方安装包 / python.org 的都行，选到 python.exe 那一层。'
            + '★ 留空 = 自动探测：SCUT71_PYTHON 环境变量 → 工具链自带的 → '
            + 'py 启动器 → PATH。自动探测在机器上装了多个 Python 时可能挑中 '
            + '旧的那个（本机实测就发生过：py -3 反查到 3.6），'
            + '所以装了多个的话建议在这里写死一个',
    },
    {
        path: ['toolchain', 'autoWatch'], label: '自动发现全局变量', kind: 'bool',
        hint: '关闭可加快构建，但变量面板会是空的',
    },
    {
        path: ['toolchain', 'watchExclude'], label: '变量黑名单', kind: 'text',
        rebuild: true,
        hint: '逗号分隔的变量名：这些全局量不进变量面板。'
            + '适合排除体积大又不想看的缓冲（例如整幅中间图）。留空 = 不排除。'
            + '★ 改完要重新编译',
    },
    {
        path: ['toolchain', 'watchMaxElems'], label: '变量元素数上限', kind: 'number',
        rebuild: true,
        hint: '只把元素数不超过这个值的变量放进面板；0 = 不限制。'
            + '★ 与「默认勾选」的区别：本项是【根本不出现在列表里】，'
            + '而大缓冲本来默认就不勾选（仍在列表里，想要可以勾上）。'
            + '★ 改完要重新编译',
    },
];

/* ★ 这里原先还有 pickValue() / setValue()（按路径读写的两个辅助函数）。
 *   已删除：全树零调用点。面板真正的读写发生在 media/settingsview.js ——
 *   webview 里拿不到 TS 的函数，那一份只能自己实现一遍。
 *   宿主侧这两个从来没人调用，留着就是"同一件事两份实现"，
 *   而且会让人以为面板的读写出自这里。 */
