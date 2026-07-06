/**
 * BAT AI 指引助手 — 全站智能引导系统
 * 调用 DeepSeek API，用户开箱即用无需配置
 * 版本: 2.0
 */
(function () {
  'use strict';

  // ==================== 配置 ====================
  const CONFIG = {
    // ===== API 配置 =====
    // 方案1（推荐）：通过 Cloudflare Worker 代理 — API Key 安全存储在后端
    // 部署 bat-ai-proxy-worker.js 后，将下面的 URL 替换为你的 Worker URL
    proxyUrl: 'https://bat-ai-proxy.bat-ai-proxy.workers.dev',
    // 如果 Worker 未部署，用户可以在 ⚙ 设置中输入自己的 API Key
    // 直接连接 DeepSeek（仅当用户自行提供 Key 时使用）
    deepseekApiUrl: 'https://api.deepseek.com/chat/completions',
    // ⚠️ 不再硬编码 API Key！用户 Key 仅存储在浏览器 localStorage 中

    // 模型配置
    model: 'deepseek-chat',
    maxTokens: 2048,
    temperature: 0.7,

    // ===== 监控配置 =====
    // Google Analytics 4 测量 ID（可选，用于全站访问监控）
    // 前往 https://analytics.google.com 创建账号后获取 G-XXXXXXXXXX 格式的 ID
    gaMeasurementId: '',  // 留空则不启用 GA
    // Cloudflare Web Analytics token（可选，隐私友好的替代方案）
    cfAnalyticsToken: '', // 留空则不启用

    // UI
    maxHistoryRounds: 15,
    panelWidth: 400,
    panelHeight: 560,
    mobileBreakpoint: 640,

    // localStorage keys
    storageKeyHistory: 'bat_ai_history',
    storageKeySettings: 'bat_ai_settings',
    storageKeyUsageLog: 'bat_ai_usage_log',   // 客户端用量记录
  };

  // ==================== 知识库 ====================
  const KNOWLEDGE_BASE = {
    '氨基酸查询': {
      category: '蛋白质工程',
      desc: '查看氨基酸的中英文名称对照、缩写和特性信息',
      usage: [
        '在搜索框中输入氨基酸的名称（中/英文）、三字母缩写或单字母符号',
        '系统实时显示匹配结果，包含中文名、英文名、缩写、分子式等信息',
        '支持模糊搜索，无需输入完整名称',
      ],
      tips: '常用缩写速记：甘氨酸 Gly(G)、丙氨酸 Ala(A)、缬氨酸 Val(V)、亮氨酸 Leu(L)、异亮氨酸 Ile(I)',
      faq: [
        ['常见氨基酸有哪些？', '标准氨基酸共20种，包括甘氨酸、丙氨酸、缬氨酸、亮氨酸、异亮氨酸、脯氨酸、苯丙氨酸、酪氨酸、色氨酸、丝氨酸、苏氨酸、半胱氨酸、甲硫氨酸、天冬酰胺、谷氨酰胺、天冬氨酸、谷氨酸、赖氨酸、精氨酸、组氨酸。'],
        ['单字母和三字母缩写怎么对应？', '三字母缩写通常是英文名的前三个字母，如 Gly=甘氨酸；单字母缩写是国际惯例，如 G=甘氨酸。在工具中任意输入一种格式即可查询。'],
      ],
    },
    '模拟突变': {
      category: '蛋白质工程',
      desc: '上传FASTA文件，选择基因并指定突变位点，生成模拟突变体序列',
      usage: [
        '上传包含目标基因序列的 FASTA 格式文件',
        '在基因列表中选择要突变的基因',
        '指定突变位点：格式为「原始氨基酸+位置+突变后氨基酸」，如 A123G',
        '点击"生成突变体"，系统输出突变后的完整序列',
        '可同时指定多个突变位点，用逗号或换行分隔',
      ],
      tips: '突变表示法：A123G 表示将第123位的丙氨酸(A)突变为甘氨酸(G)。支持批量输入多个位点。',
      faq: [
        ['支持哪些突变格式？', '支持 A123G（单字母）和 Ala123Gly（三字母）两种格式，多个突变用逗号或换行分隔。'],
        ['FASTA文件有什么要求？', '标准FASTA格式，第一行以>开头为序列名称，第二行起为氨基酸序列（单字母大写）。'],
      ],
    },
    '密码子翻译': {
      category: '蛋白质工程',
      desc: '将核苷酸序列快速翻译为氨基酸序列，支持查找特定位置对应的氨基酸',
      usage: [
        '在输入框中粘贴密码子序列（如 AUG GCC UGG）或核苷酸序列',
        '选择翻译方向（5\'→3\' 或 3\'→5\'）',
        '系统自动按三联体密码子表翻译为氨基酸序列',
        '可通过位置索引查看某一位点对应的氨基酸',
      ],
      tips: '支持DNA和RNA序列，自动识别T/U。输入时注意去掉空格和数字。',
      faq: [
        ['支持RNA序列吗？', '支持，工具自动将U替换为T后进行翻译，也可直接输入DNA序列。'],
      ],
    },
    '突变引物设计': {
      category: '蛋白质工程',
      desc: '上传DNA序列及突变位置，自动设计上下游引物并导出表格',
      usage: [
        '上传包含目标基因的 DNA 序列文件（FASTA格式）',
        '在突变位点区指定突变（格式：原始碱基+位置+突变碱基，如 c.123A>G）',
        '设置引物长度（默认25-35bp）和Tm值范围',
        '点击"设计引物"，系统生成上游和下游引物序列',
        '导出引物表格（Excel格式），包含序列、长度、Tm值、GC含量等信息',
      ],
      tips: '引物设计遵循分子克隆标准原则：突变位点居中，两端各12-15bp同源臂，Tm值在55-65°C之间。',
      faq: [
        ['引物长度怎么设置？', '默认25-35bp，可根据需要调整。长度越长特异性越好，但合成成本越高。'],
        ['Tm值是什么意思？', '熔解温度，DNA双链解离50%时的温度。上下游引物Tm值应尽量接近（差值<5°C）。'],
      ],
    },
    '序列反向/互补': {
      category: '序列编辑',
      desc: '获取核苷酸序列的反向片段、DNA互补链或RNA互补链',
      usage: [
        '在输入框中粘贴核苷酸序列（DNA或RNA）',
        '选择操作类型：反向（Reverse）、DNA互补、RNA互补、反向互补',
        '点击执行按钮，系统即时输出结果',
        '结果可直接复制使用',
      ],
      tips: '反向互补常用于设计反义引物；DNA互补链遵循A-T/C-G配对；RNA互补链遵循A-U/C-G配对。',
      faq: [
        ['反向和反向互补有什么区别？', '反向只是将序列首尾颠倒；反向互补是首尾颠倒后再做碱基互补配对。'],
      ],
    },
    '序列比对表格导出': {
      category: '序列编辑',
      desc: '将FASTA格式的氨基酸序列比对结果导出到Excel表格',
      usage: [
        '上传或粘贴多序列比对后的 FASTA 文件（所有序列长度须一致）',
        '系统解析比对结果，每行一个序列，每列一个位点',
        '可选择是否标注保守位点和变异位点',
        '导出为 .xlsx 格式表格，方便在Excel中进一步分析',
      ],
      tips: '可用于Clustal Omega、MAFFT、MUSCLE等比对软件的输出文件。序列长度不一致会导致导出失败。',
      faq: [
        ['支持什么比对软件的输出？', '任何输出标准FASTA格式的比对软件都可以（Clustal、MAFFT、MUSCLE等）。'],
        ['可以标注保守位点吗？', '可以，工具会自动计算每个位点的保守性比例并可选标注。'],
      ],
    },
    '保守位点分析': {
      category: '序列编辑',
      desc: '查找多序列比对结果中氨基酸保守性达到设定阈值的位点',
      usage: [
        '上传多序列比对后的 FASTA 文件',
        '设置保守性阈值（如90%，即该位点90%以上序列的氨基酸相同）',
        '系统逐个位点计算保守性比例',
        '输出保守位点列表及其对应的氨基酸和保守度',
      ],
      tips: '保守位点通常具有重要的结构或功能意义，是蛋白质工程改造时需要特别注意的区域。',
      faq: [
        ['保守性阈值设多少合适？', '通常80-100%。90%以上为高度保守，80-90%为中度保守，可根据研究目的调整。'],
      ],
    },
    '基因文件合并': {
      category: '序列编辑',
      desc: '将多个文件中的基因序列快速合并到一个FASTA文件',
      usage: [
        '选择多个 FASTA 文件（支持批量拖拽上传）',
        '系统自动合并所有序列到单一文件',
        '可选择添加文件名前缀以区分来源',
        '下载合并后的 FASTA 文件',
      ],
      tips: '合并时注意序列名称不要重复，工具会自动检测并添加后缀避免冲突。',
      faq: [
        ['合并后序列名称会重复吗？', '工具会自动检测重复名称，并在名称后添加来源文件名以避免混淆。'],
      ],
    },
    '基因序列提取': {
      category: '序列编辑',
      desc: '基于基因名称，批量提取FASTA文件中的氨基酸序列',
      usage: [
        '上传包含多个基因序列的 FASTA 文件',
        '输入要提取的基因名称列表（支持批量粘贴和模糊匹配）',
        '系统按名称匹配并提取对应序列',
        '下载提取后的序列文件',
      ],
      tips: '支持精确匹配和模糊匹配（包含关键词即可），多个基因名称用逗号或换行分隔。',
      faq: [
        ['支持模糊匹配吗？', '支持，输入关键词可匹配所有包含该关键词的序列名称。'],
      ],
    },
    '基因名称批量修改': {
      category: '序列编辑',
      desc: '通过模块化工作流，对FASTA文件中所有基因名称进行批量修改',
      usage: [
        '上传 FASTA 文件',
        '选择修改模块：添加前缀/后缀、替换关键词、正则表达式、删除指定字符等',
        '支持多模块组合，按顺序执行（如：先添加前缀，再替换关键词）',
        '实时预览修改效果，下载修改后的文件',
      ],
      tips: '模块化工作流允许你像搭建积木一样组合操作，实现复杂的批量重命名任务。',
      faq: [
        ['可以撤销操作吗？', '可以在预览区查看每一步操作的效果，不满意可删除对应模块重新配置。'],
        ['支持正则表达式吗？', '支持，高级用户可以使用正则表达式实现复杂的名称替换。'],
      ],
    },
    '序列内容清洗': {
      category: '序列编辑',
      desc: '对FASTA文件中的所有序列内容进行批量优化格式化处理',
      usage: [
        '上传 FASTA 文件',
        '选择清洗操作：去除空格/数字/特殊字符、统一大小写、去除终止密码子、截取指定区间',
        '系统显示清洗前后对比',
        '下载清洗后的文件',
      ],
      tips: '清洗操作不会改变序列的生物学意义，只是格式化处理，确保下游分析工具的兼容性。',
      faq: [
        ['清洗会改变序列信息吗？', '仅做格式化处理（去空格/换行、统一大小写等），不会改变氨基酸/碱基信息。'],
      ],
    },
    '特定长度氨基酸序列筛选': {
      category: '序列编辑',
      desc: '筛选FASTA文件中具有特定长度的氨基酸序列',
      usage: [
        '上传 FASTA 文件',
        '设置筛选条件：长度范围（如 200-300 aa）、或比较条件（大于/小于/等于指定值）',
        '系统筛选符合条件的所有序列',
        '下载筛选结果',
      ],
      tips: '可用于去除序列比对中的截短序列，或筛选特定结构域长度的蛋白质。',
      faq: [
        ['可以同时设置多个条件吗？', '支持设置一个范围条件（最小-最大长度），满足该范围的序列均会被筛选出来。'],
      ],
    },
    '双向测序结果拼接': {
      category: '序列编辑',
      desc: '将基因两端测序结果的FASTA文件拼接为完整序列',
      usage: [
        '上传正向和反向测序结果文件（两个FASTA文件）',
        '系统自动识别重叠区域并进行拼接',
        '可手动调整重叠区参数（最小重叠长度、相似度阈值）',
        '下载拼接后的完整序列',
      ],
      tips: 'Sanger测序通常会产生正向和反向两个测序结果，该工具将它们拼接为完整的基因序列。',
      faq: [
        ['拼接失败怎么办？', '检查两个序列是否有足够的重叠区，可尝试降低最小重叠长度或相似度阈值。'],
      ],
    },
    '生物信息学工具汇总': {
      category: '科研助手',
      desc: '收录了大量生物信息学常用网站、软件和数据库的分类汇总',
      usage: [
        '按分类浏览：序列比对、结构预测、分子动力学、数据库等',
        '点击链接直达外部工具网站',
        '每个条目包含工具名称、用途简介和链接',
      ],
      tips: '这是一个工具目录导航页面，帮助你快速找到需要的生物信息学资源和工具。',
      faq: [],
    },
    '热图绘制': {
      category: '科研助手',
      desc: '上传数据矩阵生成自定义热图，支持大型热图生成',
      usage: [
        '上传数据矩阵文件（Excel或CSV格式，行为基因/蛋白，列为样本/条件）',
        '设置配色方案、聚类方式（行/列/双向）、归一化方法',
        '调整标签大小、颜色标尺等显示参数',
        '生成热图预览，满意后下载高清图片（PNG/SVG/PDF格式）',
      ],
      tips: '数据量较大时（>100行），建议先生成预览，调整参数后再导出最终版本。支持Z-score归一化。',
      faq: [
        ['支持哪些聚类方法？', '支持层次聚类（欧氏距离/皮尔逊相关）、K-means聚类，以及不聚类选项。'],
        ['图片分辨率不够怎么办？', '导出SVG或PDF矢量格式，可无损放大。PNG格式默认300dpi。'],
      ],
    },
    '溶液稀释体系计算': {
      category: '科研助手',
      desc: '根据需求计算原溶液和溶剂的添加量',
      usage: [
        '输入原溶液浓度和目标溶液浓度',
        '输入目标溶液体积',
        '系统自动计算所需原溶液体积和溶剂体积',
        '支持连续稀释和梯度稀释',
      ],
      tips: '使用 C₁V₁ = C₂V₂ 公式计算。注意浓度和体积的单位保持一致。',
      faq: [
        ['支持什么浓度单位？', '支持 mol/L、g/L、mg/mL、μg/mL 等常见单位，也支持百分比浓度。'],
      ],
    },
    'PDF文件合并与拆分': {
      category: '科研助手',
      desc: '按需合并多个PDF文件，或从PDF中提取目标页码',
      usage: [
        '合并模式：选择多个PDF文件，按指定顺序合并为一个文件',
        '拆分模式：上传一个PDF，输入要提取的页码范围（如 1-5, 8, 10-15）',
        '点击执行，下载处理后的PDF',
      ],
      tips: '合并时可通过拖拽调整文件顺序；拆分支持非连续页码提取。所有处理在浏览器本地完成，文件不会上传到服务器。',
      faq: [
        ['文件会上传到服务器吗？', '不会！所有处理在本地浏览器完成，保护你的数据隐私。'],
        ['文件大小有限制吗？', '受浏览器内存限制，建议单个PDF不超过100MB，合并总文件不超过500MB。'],
      ],
    },
    'AI小助手': {
      category: '科研助手',
      desc: '独立AI对话助手页面，可帮助解答科研相关问题',
      usage: [
        '在对话框中输入你的科研问题',
        'AI提供解答和建议',
        '支持多轮对话深入讨论',
      ],
      tips: '这是通用AI对话页面，与本页面右下角的BAT AI指引助手互补使用。',
      faq: [],
    },
    'DLKcat输入文件生成': {
      category: '软件工具',
      desc: '快速生成多个突变体的DLKcat输入文件，加速酶催化效率(kcat)预测',
      usage: [
        '上传蛋白质结构文件（PDB格式）和突变列表',
        '系统解析结合位点和底物信息',
        '批量生成每个突变体的DLKcat输入配置文件',
        '下载打包文件，可直接用于DLKcat计算',
      ],
      tips: 'DLKcat是基于深度学习的酶kcat值预测工具。本功能仅限国工实验室成员使用。',
      faq: [],
      restricted: true,
    },
    'AlphaFold3输入文件生成': {
      category: '软件工具',
      desc: '搭配高性能计算平台，批量生成AlphaFold3的输入JSON文件',
      usage: [
        '输入蛋白质序列（支持批量FASTA）',
        '配置MSA搜索参数和模板选择',
        '指定输出目录和计算资源',
        '导出AlphaFold3标准JSON输入文件',
      ],
      tips: 'AlphaFold3需要特定的JSON输入格式，本工具将序列和参数打包为HPC集群可直接使用的配置文件。仅限国工实验室成员使用。',
      faq: [],
      restricted: true,
    },
    'Amber24工作站批量生成': {
      category: '软件工具',
      desc: '搭配高性能计算平台，批量生成Amber24分子动力学模拟输入文件',
      usage: [
        '上传蛋白质结构文件',
        '配置模拟参数：力场、溶剂模型、温度、压力、模拟时长',
        '系统生成完整的Amber24输入文件包（tleap、min、heat、equil、prod）',
        '可直接提交到HPC集群运行',
      ],
      tips: 'Amber24是经典的分子动力学模拟软件，本工具自动生成标准MD工作流所需的所有输入文件。仅限国工实验室成员使用。',
      faq: [],
      restricted: true,
    },
    '自由能景观构建': {
      category: '软件工具',
      desc: '对分子动力学模拟结果进行自由能景观分析',
      usage: [
        '上传MD模拟轨迹文件（DCD/NetCDF格式）和拓扑文件',
        '选择反应坐标（如RMSD、回转半径、特定二面角等）',
        '系统计算自由能并生成二维/三维景观图',
        '可导出高质量图片和数据矩阵',
      ],
      tips: '自由能景观图反映蛋白质构象空间的能量分布，有助于理解折叠路径和构象变化。仅限国工实验室成员使用。',
      faq: [],
      restricted: true,
    },
    '残基最短路径(SPM)计算': {
      category: '软件工具',
      desc: '使用距离矩阵、相关性矩阵及结构文件计算残基间最短路径',
      usage: [
        '上传蛋白质结构文件和/或距离/相关性矩阵',
        '选择源残基和目标残基（或计算所有残基对）',
        '系统运行最短路径算法计算',
        '输出路径图、路径长度统计和通过频次分析',
      ],
      tips: 'SPM分析可揭示蛋白质中残基间信息传递的关键路径和热点残基，对理解别构调控机制非常重要。仅限国工实验室成员使用。',
      faq: [],
      restricted: true,
    },
    '超级五子棋': {
      category: '隐藏功能',
      desc: '特殊规则的五子棋游戏，休闲放松',
      usage: ['点击棋盘落子', '五子连珠即获胜', '支持双人对战'],
      tips: '按 Ctrl+Y+C 可在首页显示/隐藏此区域',
      faq: [],
    },
    '大规模象棋': {
      category: '隐藏功能',
      desc: '大型棋盘象棋游戏（刘邦模拟器）',
      usage: ['标准象棋规则，双人对弈'],
      tips: '按 Ctrl+Y+C 可在首页显示/隐藏此区域',
      faq: [],
    },
    '弹幕躲避': {
      category: '隐藏功能',
      desc: '自定义文本弹幕躲避类游戏',
      usage: ['控制角色躲避弹幕', '支持自定义弹幕文本'],
      tips: '按 Ctrl+Y+C 可在首页显示/隐藏此区域',
      faq: [],
    },
    'Failure Communications': {
      category: '隐藏功能',
      desc: '《失败通讯》期刊官网',
      usage: ['浏览期刊内容', '查看投稿信息'],
      tips: '按 Ctrl+Y+C 可在首页显示/隐藏此区域',
      faq: [],
    },
    '文明演替模型': {
      category: '隐藏功能',
      desc: '模拟文明兴衰演替的交互模型',
      usage: ['调整参数观察文明演化', '支持多种初始条件'],
      tips: '按 Ctrl+Y+C 可在首页显示/隐藏此区域',
      faq: [],
    },
  };

  // ==================== 页面识别 ====================
  function detectCurrentTool() {
    const path = window.location.pathname;
    const filename = path.substring(path.lastIndexOf('/') + 1).replace('.html', '');

    if (filename === 'index' || filename === '') {
      return { isIndex: true, name: null, info: null };
    }

    for (const [toolName, info] of Object.entries(KNOWLEDGE_BASE)) {
      if (filename.includes(toolName)) {
        return { isIndex: false, name: toolName, info };
      }
    }

    const title = document.title.replace(/\s*[-–—|]\s*生物信息分析工具包.*$/, '').trim();
    for (const [toolName, info] of Object.entries(KNOWLEDGE_BASE)) {
      if (title.includes(toolName) || toolName.includes(title)) {
        return { isIndex: false, name: toolName, info };
      }
    }

    return { isIndex: false, name: title || filename, info: null };
  }

  // ==================== 页面 DOM 分析 ====================
  function analyzePageDOM() {
    const result = { title: '', sections: [], controls: [], textHints: [] };

    // 页面标题
    result.title = document.title.replace(/\s*[-–—|].*$/, '').trim();

    // 排除 AI 助手自身元素
    const aiContainer = document.getElementById('bat-ai-container');

    // 扫描所有可见交互控件
    const formElements = document.querySelectorAll('input:not([type="hidden"]), textarea, select, button, [role="button"]');
    formElements.forEach(el => {
      if (el.offsetParent === null) return; // 不可见
      if (aiContainer && aiContainer.contains(el)) return; // 排除 AI 自身
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      const id = el.id || '';
      const placeholder = el.placeholder || '';
      const text = (el.textContent || el.value || '').trim().substring(0, 40);

      // 找关联 label
      let label = '';
      if (id) {
        const labelEl = document.querySelector(`label[for="${id}"]`);
        if (labelEl) label = labelEl.textContent.trim();
      }
      if (!label && el.closest('label')) {
        label = el.closest('label').textContent.replace(text, '').trim();
      }
      if (!label && placeholder) label = placeholder;

      if (label || text || placeholder) {
        let desc = '';
        if (tag === 'input') desc = type ? `输入框[${type}]` : '输入框';
        else if (tag === 'textarea') desc = '文本区域';
        else if (tag === 'select') desc = '下拉选择';
        else if (tag === 'button' || el.getAttribute('role') === 'button') desc = '按钮';

        if (label) desc += ` "${label.substring(0, 30)}"`;
        if (id) desc += ` (id:${id})`;
        result.controls.push(desc);
      }
    });

    // 去重 controls
    result.controls = [...new Set(result.controls)].slice(0, 25);

    // 扫描主要区域标题
    const headings = document.querySelectorAll('h2, h3, .section-title, .card-header, legend, .panel-title');
    headings.forEach(h => {
      if (h.offsetParent === null) return;
      if (aiContainer && aiContainer.contains(h)) return;
      const text = h.textContent.trim().substring(0, 40);
      if (text && !result.sections.includes(text)) result.sections.push(text);
    });
    result.sections = result.sections.slice(0, 15);

    // 扫描关键提示文字
    const hints = document.querySelectorAll('.tip, .hint, .note, .help-text, .instruction, small, .desc');
    hints.forEach(h => {
      if (h.offsetParent === null) return;
      if (aiContainer && aiContainer.contains(h)) return;
      const text = h.textContent.trim().substring(0, 60);
      if (text && text.length > 3) result.textHints.push(text);
    });
    result.textHints = [...new Set(result.textHints)].slice(0, 10);

    return result;
  }

  // ==================== System Prompt 构建 ====================
  function buildSystemPrompt(ctx) {
    let p = `你是BAT（Bioinformatics Analysis Toolkit）平台的AI指引助手"小蝙"🦇。
BAT是江南大学粮食发酵工艺与技术国家工程实验室开发的生物信息学分析平台。

## 你的角色
- 友好、专业、耐心，用中文交流，名字叫"小蝙"
- 回答简洁清晰，多用结构化列表，保持口语化自然
- 回复控制在200字以内，除非用户明确要求详细说明

## 能力
1. **工具推荐**：根据研究需求推荐平台内最合适的工具
2. **使用教程**：手把手教用户使用工具，分步骤说明
3. **生信答疑**：解答生物信息学概念性问题
4. **导航引导**：告诉用户在页面哪里找到某个功能

## 平台工具全览
| 分类 | 工具 |
|------|------|
| 蛋白质工程 | 氨基酸查询、模拟突变、密码子翻译、突变引物设计 |
| 序列编辑 | 序列反向/互补、序列比对表格导出、保守位点分析、基因文件合并、基因序列提取、基因名称批量修改、序列内容清洗、特定长度氨基酸序列筛选、双向测序结果拼接 |
| 科研助手 | 生物信息学工具汇总、热图绘制、溶液稀释体系计算、PDF文件合并与拆分 |
| 软件工具 | DLKcat输入文件生成、AlphaFold3输入文件生成、Amber24工作站批量生成、自由能景观构建、残基最短路径(SPM)计算 |
| 隐藏功能 | 超级五子棋、大规模象棋、弹幕躲避、Failure Communications、文明演替模型 |

## 工具推荐格式（极其重要！）
推荐工具时必须使用 \`{{工具名}}\` 格式，例如：
- "推荐使用 {{氨基酸查询}} 工具"
- "你可以试试 {{模拟突变}} 或 {{密码子翻译}}"
系统会自动识别{{...}}并高亮页面中对应的工具卡片，所以这个格式非常重要！

`;

    if (ctx && ctx.info) {
      // 分析当前页面 DOM 结构
      const dom = analyzePageDOM();

      p += `## 用户当前所在工具：${ctx.name}（${ctx.info.category}）
用户正在使用此工具，你的首要任务是帮助用户理解和使用这个工具。

### 功能描述
${ctx.info.desc}

### 你面前的页面实际结构
请根据下面的实际页面元素来指导用户——你知道页面上有什么！
- 页面区域：${dom.sections.join('、') || '标准工具布局'}
- 可用控件：${dom.controls.join('；') || '标准表单控件'}
${dom.textHints.length > 0 ? '- 页面提示文字：' + dom.textHints.join('；') + '\n' : ''}
### 使用流程
${ctx.info.usage.map((s, i) => (i + 1) + '. ' + s).join('\n')}

### 使用提示
${ctx.info.tips || '暂无'}
`;

      if (ctx.info.faq && ctx.info.faq.length > 0) {
        p += '### 常见问题\n' + ctx.info.faq.map(([q, a]) => 'Q: ' + q + '\nA: ' + a).join('\n\n') + '\n';
      }

      p += `当用户询问"怎么用"、"教程"、"步骤"时，请参考上述"页面实际结构"来给出精准的步骤指引（如"点击xxx按钮"、"在xxx输入框中..."）。
当用户的问题涉及其他工具时，可以推荐并引导用户前往对应页面。\n`;
    } else {
      const dom = analyzePageDOM();
      p += `## 当前页面：首页
用户正在浏览工具目录。

### 页面布局
首页按分类展示了以下工具区：${dom.sections.join('、')}

你的主要任务：
1. 了解用户的科研需求
2. 推荐最合适的工具（必须使用 {{工具名}} 格式！）
3. 简要说明推荐理由
4. 告诉用户在哪个分类下可以找到该工具\n`;
    }

    p += '\n## 回复要求\n- 始终使用中文，偶尔可用英文专业术语\n- 结构清晰：先说结论，再展开细节\n- 推荐工具时必须使用 {{工具名}} 格式\n- 如果不确定答案，诚实告知并给出参考建议\n- 保持积极友好的语气，适当使用emoji';
    return p;
  }

  // ==================== CSS 注入 ====================
  function injectStyles() {
    const css = `
#bat-ai-container{position:fixed;bottom:24px;right:24px;z-index:99999;font-family:"Microsoft YaHei","微软雅黑",sans-serif}
#bat-ai-floating-btn{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#32586d,#1e3a47);border:none;cursor:pointer;box-shadow:0 4px 16px rgba(50,88,109,.35);display:flex;align-items:center;justify-content:center;font-size:26px;position:relative;transition:transform .2s,box-shadow .2s;color:#fff;line-height:1}
#bat-ai-floating-btn:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(50,88,109,.5)}
#bat-ai-floating-btn::after{content:'';position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(50,88,109,.3);animation:bat-pulse 2s ease-in-out infinite}
@keyframes bat-pulse{0%,100%{transform:scale(1);opacity:.6}50%{transform:scale(1.12);opacity:0}}
#bat-ai-tooltip{position:absolute;right:62px;top:50%;transform:translateY(-50%);background:#1e3a47;color:#fff;padding:6px 14px;border-radius:16px;font-size:13px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .3s}
#bat-ai-floating-btn:hover #bat-ai-tooltip,#bat-ai-tooltip.show{opacity:1}
#bat-ai-panel{position:absolute;bottom:64px;right:0;width:400px;height:560px;max-height:calc(100vh - 100px);background:#fff;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.18);display:none;flex-direction:column;overflow:hidden;border:1px solid rgba(178,209,214,.4)}
#bat-ai-panel.open{display:flex}
.bat-ai-header{background:linear-gradient(135deg,#32586d,#1e3a47);color:#fff;padding:12px 14px;display:flex;align-items:center;gap:8px;flex-shrink:0}
.bat-ai-header .bat-icon{font-size:20px;line-height:1}
.bat-ai-header .bat-title{font-weight:600;font-size:14px;flex:1}
.bat-ai-header button{background:rgba(255,255,255,.12);border:none;color:#fff;width:26px;height:26px;border-radius:50%;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:background .2s;line-height:1}
.bat-ai-header button:hover{background:rgba(255,255,255,.28)}
.bat-ai-context-badge{font-size:10px;background:rgba(255,255,255,.1);padding:2px 8px;border-radius:8px;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.bat-ai-messages{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8fafb}
.bat-ai-messages::-webkit-scrollbar{width:5px}
.bat-ai-messages::-webkit-scrollbar-track{background:transparent}
.bat-ai-messages::-webkit-scrollbar-thumb{background:#c4d4da;border-radius:3px}
.bat-msg{max-width:88%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.6;word-break:break-word;animation:msg-in .25s ease-out}
@keyframes msg-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.bat-msg.user{align-self:flex-end;background:#ca3032;color:#fff;border-bottom-right-radius:4px}
.bat-msg.assistant{align-self:flex-start;background:#fff;border:1px solid #e1e8eb;border-bottom-left-radius:4px}
.bat-msg.assistant p{margin:4px 0}
.bat-msg.assistant p:first-child{margin-top:0}
.bat-msg.assistant p:last-child{margin-bottom:0}
.bat-msg.assistant strong{color:#32586d}
.bat-msg.assistant code{background:#eef3f5;padding:1px 5px;border-radius:3px;font-size:12px;font-family:"Cascadia Code",Consolas,monospace}
.bat-msg.assistant pre{background:#1e3a47;color:#e1f0f2;padding:10px;border-radius:6px;overflow-x:auto;font-size:12px;margin:6px 0}
.bat-msg.assistant ul,.bat-msg.assistant ol{padding-left:18px;margin:4px 0}
.bat-msg.assistant li{margin:2px 0}
.bat-tool-ref{display:inline-block;background:linear-gradient(135deg,#e1f0f2,#b2d1d6);color:#32586d;padding:1px 8px;border-radius:10px;font-weight:600;font-size:13px;cursor:pointer;transition:all .2s;text-decoration:none;margin:0 1px}
.bat-tool-ref:hover{background:#32586d;color:#fff;transform:translateY(-1px)}
.bat-tool-ref.no-link{cursor:default;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}
.bat-quick-questions{display:flex;flex-wrap:wrap;gap:6px;padding:0 0 6px}
.bat-quick-btn{background:#fff;border:1px solid #b2d1d6;color:#32586d;padding:6px 12px;border-radius:16px;font-size:12px;cursor:pointer;transition:all .2s;white-space:nowrap}
.bat-quick-btn:hover{background:#32586d;color:#fff;border-color:#32586d}
.bat-ai-input-area{padding:10px 12px;border-top:1px solid #e1e8eb;display:flex;gap:8px;align-items:flex-end;flex-shrink:0;background:#fff}
.bat-ai-input-area textarea{flex:1;border:1px solid #d4dde2;border-radius:18px;padding:8px 14px;font-size:13px;resize:none;max-height:80px;min-height:36px;outline:none;font-family:inherit;line-height:1.4;transition:border-color .2s}
.bat-ai-input-area textarea:focus{border-color:#32586d}
.bat-ai-send-btn{width:36px;height:36px;border-radius:50%;background:#32586d;border:none;color:#fff;font-size:16px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background .2s}
.bat-ai-send-btn:hover{background:#1e3a47}
.bat-ai-send-btn:disabled{background:#b2d1d6;cursor:not-allowed}
.bat-ai-send-btn.sending{background:#ca3032;animation:send-pulse .8s infinite}
@keyframes send-pulse{0%,100%{opacity:1}50%{opacity:.5}}
.bat-typing{display:flex;gap:4px;padding:8px 14px;align-items:center}
.bat-typing span{width:7px;height:7px;border-radius:50%;background:#b2d1d6;animation:typing-bounce 1.2s infinite}
.bat-typing span:nth-child(2){animation-delay:.2s}
.bat-typing span:nth-child(3){animation-delay:.4s}
@keyframes typing-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
.bat-cursor{color:#32586d;animation:blink .8s infinite;font-weight:700}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.bat-ai-footer{text-align:center;font-size:10px;color:#a0b4bd;padding:4px;border-top:1px solid #eef3f5;flex-shrink:0;background:#fff}
.bat-empty-state{text-align:center;padding:30px 20px;color:#8aa0aa}
.bat-empty-state .bat-icon-large{font-size:40px;margin-bottom:10px}
.bat-empty-state p{font-size:13px;line-height:1.5;margin:4px 0}
.bat-settings-overlay{position:absolute;inset:0;background:rgba(255,255,255,.97);z-index:10;display:none;flex-direction:column;padding:20px;border-radius:12px}
.bat-settings-overlay.show{display:flex}
.bat-settings-overlay h3{color:#32586d;margin-bottom:14px;font-size:15px}
.bat-settings-overlay label{font-size:12px;color:#666;margin-bottom:3px;display:block}
.bat-settings-overlay input{width:100%;padding:8px 12px;border:1px solid #d4dde2;border-radius:8px;font-size:13px;margin-bottom:10px;outline:none;font-family:inherit}
.bat-settings-overlay input:focus{border-color:#32586d}
.bat-settings-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:auto}
.bat-settings-btns button{padding:8px 16px;border-radius:8px;border:none;cursor:pointer;font-size:13px}
.bat-settings-save{background:#32586d;color:#fff}
.bat-settings-save:hover{background:#1e3a47}
.bat-settings-cancel{background:#e1e8eb;color:#555}
.bat-settings-cancel:hover{background:#d4dde2}

/* 工具卡片高亮（仅在首页生效） */
.tool-card.bat-highlight{animation:bat-card-glow .6s ease-in-out 3;border-color:#ca3032!important;box-shadow:0 0 20px rgba(202,48,50,.4)!important;z-index:10;position:relative}
@keyframes bat-card-glow{0%,100%{box-shadow:0 0 5px rgba(202,48,50,.2)}50%{box-shadow:0 0 30px rgba(202,48,50,.6);transform:translateY(-4px)}}

/* 移动端适配 */
@media(max-width:640px){
  #bat-ai-panel{position:fixed;bottom:0;right:0;left:0;top:0;width:100%;height:100%;max-height:100vh;border-radius:0}
  #bat-ai-floating-btn{width:44px;height:44px;font-size:22px;bottom:16px;right:16px}
}
`;
    const style = document.createElement('style');
    style.id = 'bat-ai-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ==================== DOM 构建 ====================
  function createDOM() {
    const container = document.createElement('div');
    container.id = 'bat-ai-container';
    container.innerHTML = `
      <div id="bat-ai-panel">
        <div class="bat-ai-header">
          <span class="bat-icon">🦇</span>
          <span class="bat-title">BAT AI 指引助手</span>
          <span class="bat-ai-context-badge" id="bat-ai-context-badge">首页</span>
          <button id="bat-ai-settings-btn" title="设置">⚙</button>
          <button id="bat-ai-minimize-btn" title="最小化">−</button>
          <button id="bat-ai-close-btn" title="关闭">✕</button>
        </div>
        <div class="bat-settings-overlay" id="bat-settings-overlay">
          <h3>⚙ API 设置</h3>
          <label>DeepSeek API Key（可选，留空使用后端代理）</label>
          <input type="password" id="bat-settings-apikey" placeholder="sk-xxxxxxxx">
          <label style="margin-top:4px;font-size:11px;color:#999;">Key 仅保存在你的浏览器本地。如管理员已部署代理，无需填写</label>
          <label style="margin-top:8px;">模型</label>
          <input type="text" id="bat-settings-model" placeholder="deepseek-chat">
          <div class="bat-settings-btns">
            <button class="bat-settings-cancel" id="bat-settings-cancel">取消</button>
            <button class="bat-settings-save" id="bat-settings-save">保存</button>
          </div>
        </div>
        <div class="bat-ai-messages" id="bat-ai-messages">
          <div class="bat-empty-state" id="bat-empty-state">
            <div class="bat-icon-large">🦇</div>
            <p><strong>你好！我是小蝙 🦇</strong></p>
            <p id="bat-welcome-text">有什么可以帮助你的？</p>
          </div>
        </div>
        <div class="bat-ai-input-area">
          <textarea id="bat-ai-input" rows="1" placeholder="输入你的问题..."></textarea>
          <button class="bat-ai-send-btn" id="bat-ai-send-btn" title="发送">➤</button>
        </div>
        <div class="bat-ai-footer">由 DeepSeek 驱动 · 江南大学国家工程实验室</div>
      </div>
      <button id="bat-ai-floating-btn" title="AI助手">
        <span>🦇</span>
        <span id="bat-ai-tooltip">需要帮助？</span>
      </button>
    `;
    document.body.appendChild(container);

    return {
      panel: document.getElementById('bat-ai-panel'),
      floatBtn: document.getElementById('bat-ai-floating-btn'),
      msgContainer: document.getElementById('bat-ai-messages'),
      input: document.getElementById('bat-ai-input'),
      sendBtn: document.getElementById('bat-ai-send-btn'),
      emptyState: document.getElementById('bat-empty-state'),
      tooltip: document.getElementById('bat-ai-tooltip'),
      contextBadge: document.getElementById('bat-ai-context-badge'),
      settingsOverlay: document.getElementById('bat-settings-overlay'),
      welcomeText: document.getElementById('bat-welcome-text'),
    };
  }

  // ==================== 核心类 ====================
  class BatAI {
    constructor() {
      this.messages = [];
      this.isStreaming = false;
      this.dom = null;
      this.ctx = null;
    }

    init() {
      injectStyles();
      this.dom = createDOM();
      this.ctx = detectCurrentTool();
      this.bindEvents();
      this.loadHistory();
      this.updateContext();
      this.initTooltipTimer();
      this.updateFooterStatus();
      this.injectAnalytics();
      this.sendPageViewBeacon();     // 上报页面浏览
      this.bindToolCardTracking();   // 追踪工具卡片点击
      console.log('🦇 BAT AI 指引助手已就绪  |  Ctrl+Shift+B 切换面板');
    }

    // ===== 页面浏览信标 =====
    sendPageViewBeacon() {
      if (!CONFIG.proxyUrl || CONFIG.proxyUrl.includes('REPLACE-ME')) return;
      const page = this.ctx.name || (this.ctx.isIndex ? 'index' : window.location.pathname);
      try {
        const beaconUrl = CONFIG.proxyUrl + '/beacon';
        navigator.sendBeacon(beaconUrl, JSON.stringify({
          type: 'pageview',
          page: page,
          timestamp: new Date().toISOString(),
        }));
      } catch (e) { /* 静默失败，不影响用户体验 */ }
    }

    // ===== 工具卡片点击追踪（仅首页） =====
    bindToolCardTracking() {
      if (!this.ctx.isIndex) return; // 只在首页追踪
      // 延迟绑定，等页面完全渲染
      setTimeout(() => {
        document.querySelectorAll('.tool-card').forEach(card => {
          if (card.dataset.batTracked) return; // 避免重复绑定
          card.dataset.batTracked = '1';
          card.addEventListener('click', (e) => {
            // 获取工具名和分类
            const header = card.querySelector('.tool-card-header');
            const toolName = header ? header.textContent.trim() : card.dataset.tool || '';
            // 从父级区域推断分类
            const section = card.closest('[class*="section"], .category-section, .tool-group');
            let category = '';
            if (section) {
              const sectionTitle = section.querySelector('h2, h3, .section-title, .category-title');
              if (sectionTitle) category = sectionTitle.textContent.trim();
            }
            if (!category) category = card.dataset.category || '';
            if (!toolName) return;
            this.sendToolClickBeacon(toolName, category);
          });
        });
      }, 1500);
    }

    sendToolClickBeacon(toolName, category) {
      if (!CONFIG.proxyUrl || CONFIG.proxyUrl.includes('REPLACE-ME')) return;
      try {
        const beaconUrl = CONFIG.proxyUrl + '/beacon';
        navigator.sendBeacon(beaconUrl, JSON.stringify({
          type: 'tool_click',
          tool: toolName,
          category: category,
          timestamp: new Date().toISOString(),
        }));
      } catch (e) { /* 静默失败 */ }
    }

    // ===== Google Analytics 注入 =====
    injectAnalytics() {
      const gaId = CONFIG.gaMeasurementId;
      if (!gaId || gaId.startsWith('G-XXXXXXXX')) return;

      // GA4 脚本
      const gaScript = document.createElement('script');
      gaScript.async = true;
      gaScript.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
      document.head.appendChild(gaScript);

      const gaInit = document.createElement('script');
      gaInit.textContent = `
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', '${gaId}', {
          page_path: window.location.pathname,
          page_title: document.title,
        });
      `;
      document.head.appendChild(gaInit);
      window.gtag = window.gtag || function () { (window.dataLayer = window.dataLayer || []).push(arguments); };

      // Cloudflare Web Analytics（备选，隐私友好）
      const cfToken = CONFIG.cfAnalyticsToken;
      if (cfToken) {
        const cfScript = document.createElement('script');
        cfScript.defer = true;
        cfScript.src = 'https://static.cloudflareinsights.com/beacon.min.js';
        cfScript.setAttribute('data-cf-beacon', `{"token": "${cfToken}"}`);
        document.head.appendChild(cfScript);
      }

      // 发送 AI 助手加载事件
      const ctx = this.ctx;
      this.sendGAEvent('ai_assistant_loaded', {
        page: ctx.name || (ctx.isIndex ? 'index' : 'unknown'),
        category: ctx.info?.category || 'unknown',
      });
    }

    // 发送 GA 事件
    sendGAEvent(eventName, params) {
      if (typeof window.gtag === 'function') {
        window.gtag('event', eventName, params);
      }
    }

    updateFooterStatus() {
      const footer = this.dom.panel.querySelector('.bat-ai-footer');
      if (!footer) return;
      const userKey = this.getApiKey();
      if (userKey) {
        footer.textContent = '由 DeepSeek 驱动 · 使用个人 Key';
      } else if (CONFIG.proxyUrl && !CONFIG.proxyUrl.includes('REPLACE-ME')) {
        footer.textContent = '由 DeepSeek 驱动 · 后端代理模式';
      } else {
        footer.textContent = '⚠ 未配置 · 请在 ⚙ 设置中输入 API Key';
      }
    }

    // --- 事件绑定 ---
    bindEvents() {
      const d = this.dom;
      d.floatBtn.addEventListener('click', () => this.openPanel());
      document.getElementById('bat-ai-close-btn').addEventListener('click', () => this.closePanel());
      document.getElementById('bat-ai-minimize-btn').addEventListener('click', () => this.closePanel());
      d.sendBtn.addEventListener('click', () => this.send());
      d.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
      });
      d.input.addEventListener('input', () => {
        d.input.style.height = 'auto';
        d.input.style.height = Math.min(d.input.scrollHeight, 80) + 'px';
      });
      document.getElementById('bat-ai-settings-btn').addEventListener('click', () => this.toggleSettings());
      document.getElementById('bat-settings-cancel').addEventListener('click', () => this.toggleSettings());
      document.getElementById('bat-settings-save').addEventListener('click', () => this.saveSettings());

      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'B') { e.preventDefault(); this.togglePanel(); }
      });
    }

    initTooltipTimer() {
      setTimeout(() => this.dom.tooltip.classList.add('show'), 2000);
      setTimeout(() => this.dom.tooltip.classList.remove('show'), 10000);
    }

    // --- 面板控制 ---
    togglePanel() {
      this.dom.panel.classList.contains('open') ? this.closePanel() : this.openPanel();
    }
    openPanel() {
      this.dom.panel.classList.add('open');
      this.dom.floatBtn.style.display = 'none';
      this.dom.input.focus();
      this.refreshWelcome();
    }
    closePanel() {
      this.dom.panel.classList.remove('open');
      this.dom.floatBtn.style.display = 'flex';
    }

    // --- 上下文 ---
    updateContext() {
      const ctx = this.ctx;
      if (ctx.isIndex) {
        this.dom.contextBadge.textContent = '🏠 首页 · 工具目录';
        this.dom.welcomeText.textContent = '告诉我你的研究需求，我来推荐最合适的工具！';
      } else if (ctx.info) {
        this.dom.contextBadge.textContent = `📌 ${ctx.name}`;
        this.dom.welcomeText.textContent = `你在「${ctx.name}」页面，有任何使用问题都可以问我！`;
      } else {
        this.dom.contextBadge.textContent = '📄 ' + (ctx.name || '未知');
        this.dom.welcomeText.textContent = '有什么需要帮助的吗？';
      }
      this.renderQuickQuestions();
    }

    renderQuickQuestions() {
      const old = this.dom.msgContainer.querySelector('.bat-quick-questions');
      if (old) old.remove();

      const ctx = this.ctx;
      let questions = [];
      if (ctx.isIndex) {
        questions = [
          ['🔍 蛋白质突变分析用什么工具？', '我想做蛋白质突变分析，推荐什么工具？'],
          ['📝 如何批量修改基因名称？', '如何批量修改FASTA文件中的基因名称？'],
          ['📊 怎么绘制热图？', '怎么绘制基因表达热图？'],
          ['🧬 帮我拼接Sanger测序结果', '双向测序结果怎么拼接？'],
        ];
      } else if (ctx.info) {
        questions = [
          ['📖 这个工具怎么使用？', `${ctx.name}怎么使用？请分步骤说明`],
          ['💡 有什么使用技巧？', `使用${ctx.name}时有什么注意事项和技巧？`],
          ['🔗 推荐相关工具', `使用完${ctx.name}后，接下来可能还需要哪些工具？`],
        ];
      }

      if (questions.length > 0) {
        const div = document.createElement('div');
        div.className = 'bat-quick-questions';
        questions.forEach(([label, q]) => {
          const btn = document.createElement('button');
          btn.className = 'bat-quick-btn';
          btn.textContent = label;
          btn.addEventListener('click', () => this.send(q));
          div.appendChild(btn);
        });
        const es = this.dom.msgContainer.querySelector('.bat-empty-state');
        if (es) { es.after(div); } else { this.dom.msgContainer.appendChild(div); }
      }
    }

    refreshWelcome() {
      const hasMsgs = this.dom.msgContainer.querySelectorAll('.bat-msg').length > 0;
      const es = this.dom.msgContainer.querySelector('.bat-empty-state');
      if (es) es.style.display = hasMsgs ? 'none' : 'block';
    }

    // --- 设置 ---
    toggleSettings() {
      const ov = this.dom.settingsOverlay;
      if (ov.classList.contains('show')) {
        ov.classList.remove('show');
      } else {
        const s = this.loadSettings();
        document.getElementById('bat-settings-apikey').value = s.apiKey || '';
        document.getElementById('bat-settings-model').value = s.model || CONFIG.model;
        ov.classList.add('show');
      }
    }
    saveSettings() {
      const data = {
        apiKey: document.getElementById('bat-settings-apikey').value.trim(),
        model: document.getElementById('bat-settings-model').value.trim(),
      };
      localStorage.setItem(CONFIG.storageKeySettings, JSON.stringify(data));
      this.dom.settingsOverlay.classList.remove('show');
      this.updateFooterStatus();
    }
    loadSettings() {
      try {
        const raw = localStorage.getItem(CONFIG.storageKeySettings);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* ignore */ }
      return { apiKey: '', model: CONFIG.model };
    }
    getApiKey() { return this.loadSettings().apiKey || ''; }
    getModel() { return this.loadSettings().model || CONFIG.model; }

    // API 配置：优先使用代理，否则使用用户自己的 Key 直连
    getApiConfig() {
      const userApiKey = this.getApiKey();
      // 如果用户设了自己的 Key，直连 DeepSeek
      if (userApiKey) {
        return {
          url: CONFIG.deepseekApiUrl,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + userApiKey,
          },
        };
      }
      // 否则使用代理（API Key 安全存储在后端）
      if (CONFIG.proxyUrl && !CONFIG.proxyUrl.includes('REPLACE-ME')) {
        return {
          url: CONFIG.proxyUrl,
          headers: {
            'Content-Type': 'application/json',
          },
        };
      }
      // 都没有配置 — 提示用户
      return null;
    }

    // --- 消息渲染 ---
    renderMessage(text) {
      if (!text) return '';
      let html = text;

      // {{工具名}} → 高亮工具引用链接
      html = html.replace(/\{\{(.+?)\}\}/g, (_, toolName) => {
        const clean = toolName.trim();
        let href = findToolUrl(clean);
        const cssClass = href ? 'bat-tool-ref' : 'bat-tool-ref no-link';
        if (!href) href = '#';
        return `<a class="${cssClass}" href="${href}" data-tool="${this.escapeAttr(clean)}" title="点击查看：${this.escapeAttr(clean)}">🔗 ${this.escapeHtml(clean)}</a>`;
      });

      // 轻量 Markdown
      html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
      html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
      html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
      html = html.replace(/^###\s+(.+)$/gm, '<strong>$1</strong>');
      html = html.replace(/\n\n/g, '</p><p>');
      html = html.replace(/\n/g, '<br>');
      if (!html.startsWith('<')) html = '<p>' + html + '</p>';

      return html;
    }

    escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
    escapeAttr(s) {
      return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // --- 消息操作 ---
    addMessageEl(role, html, raw) {
      const es = this.dom.msgContainer.querySelector('.bat-empty-state');
      if (es) es.style.display = 'none';

      const div = document.createElement('div');
      div.className = `bat-msg ${role}`;
      div.innerHTML = html;
      if (raw !== undefined) div.dataset.raw = raw;
      this.dom.msgContainer.appendChild(div);
      this.scrollBottom();
      return div;
    }

    showTyping() {
      const div = document.createElement('div');
      div.className = 'bat-msg assistant bat-typing';
      div.id = 'bat-typing-indicator';
      div.innerHTML = '<span></span><span></span><span></span>';
      this.dom.msgContainer.appendChild(div);
      this.scrollBottom();
      return div;
    }

    removeTyping() {
      const el = document.getElementById('bat-typing-indicator');
      if (el) el.remove();
    }

    scrollBottom() {
      requestAnimationFrame(() => {
        this.dom.msgContainer.scrollTop = this.dom.msgContainer.scrollHeight;
      });
    }

    setSending(v) {
      this.dom.sendBtn.disabled = v;
      this.dom.input.disabled = v;
      if (v) { this.dom.sendBtn.classList.add('sending'); }
      else { this.dom.sendBtn.classList.remove('sending'); this.dom.input.focus(); }
    }

    // --- 对话历史 ---
    loadHistory() {
      try {
        const raw = localStorage.getItem(CONFIG.storageKeyHistory);
        if (raw) this.messages = JSON.parse(raw);
      } catch (e) { this.messages = []; }

      this.messages.forEach(msg => {
        if (msg.role === 'user') {
          this.addMessageEl('user', this.escapeHtml(msg.content), msg.content);
        } else if (msg.role === 'assistant') {
          this.addMessageEl('assistant', this.renderMessage(msg.content), msg.content);
        }
      });
    }

    saveHistory() {
      try {
        const toSave = this.messages.slice(-CONFIG.maxHistoryRounds * 2);
        localStorage.setItem(CONFIG.storageKeyHistory, JSON.stringify(toSave));
      } catch (e) { /* quota exceeded, ignore */ }
    }

    // --- AI 交互 ---
    send(prefill) {
      if (this.isStreaming) return;
      const text = (prefill || this.dom.input.value.trim());
      if (!text) return;

      // 检查 API 配置
      const apiConfig = this.getApiConfig();
      if (!apiConfig) {
        this.addMessageEl('assistant', '<p>⚠️ AI 助手尚未配置。</p><p style="font-size:12px;color:#888;">管理员请部署 Cloudflare Worker 代理（见 bat-ai-proxy-worker.js），<br>或点击 ⚙ 设置输入你的 DeepSeek API Key。</p>');
        return;
      }

      if (!prefill) { this.dom.input.value = ''; this.dom.input.style.height = 'auto'; }
      this.setSending(true);

      this.addMessageEl('user', this.escapeHtml(text), text);
      this.messages.push({ role: 'user', content: text });

      // GA 事件：用户提问
      const ctx = this.ctx;
      this.sendGAEvent('ai_query', {
        page: ctx.name || (ctx.isIndex ? 'index' : 'unknown'),
        query_length: text.length,
      });

      const apiMessages = [
        { role: 'system', content: buildSystemPrompt(this.ctx) },
        ...this.messages,
      ];

      this.showTyping();
      let fullResponse = '';
      this.isStreaming = true;

      this.streamChat(apiMessages, {
        onChunk: (chunk) => {
          fullResponse += chunk;
          let msgEl = this.dom.msgContainer.querySelector('.bat-msg.streaming');
          if (!msgEl) {
            this.removeTyping();
            msgEl = document.createElement('div');
            msgEl.className = 'bat-msg assistant streaming';
            this.dom.msgContainer.appendChild(msgEl);
          }
          msgEl.innerHTML = this.renderMessage(fullResponse) + '<span class="bat-cursor">▌</span>';
          this.scrollBottom();
        },
        onDone: () => {
          this.removeTyping();
          const msgEl = this.dom.msgContainer.querySelector('.bat-msg.streaming');
          if (msgEl) {
            msgEl.classList.remove('streaming');
            const cursor = msgEl.querySelector('.bat-cursor');
            if (cursor) cursor.remove();
            msgEl.innerHTML = this.renderMessage(fullResponse);
            msgEl.dataset.raw = fullResponse;
            this.attachToolEvents(msgEl);
          }
          this.messages.push({ role: 'assistant', content: fullResponse });
          this.saveHistory();
          highlightToolCards(fullResponse);
          this.setSending(false);
          this.isStreaming = false;
          this.sendGAEvent('ai_response', {
            page: this.ctx.name || (this.ctx.isIndex ? 'index' : 'unknown'),
            response_length: fullResponse.length,
          });
        },
        onError: (err) => {
          this.removeTyping();
          console.error('BAT AI Error:', err);
          let errMsg = '抱歉，请求遇到了问题 😥';
          const em = err.message || '';
          if (em.includes('Failed to fetch') || em.includes('NetworkError'))
            errMsg = '无法连接到AI服务，请检查网络或管理员是否已部署代理服务';
          else if (em.includes('401')) errMsg = 'API Key 无效或已过期，请在 ⚙ 设置中更新 Key';
          else if (em.includes('402')) errMsg = 'API 额度不足，请到 DeepSeek 平台充值 💰';
          else if (em.includes('429')) errMsg = '请求过于频繁，请稍后再试 ⏳';
          else if (em.includes('500') || em.includes('502') || em.includes('503'))
            errMsg = 'AI服务暂时不可用，请稍后重试 🔧';
          this.addMessageEl('assistant', '<p>' + errMsg + '</p>');
          this.setSending(false);
          this.isStreaming = false;
          this.sendGAEvent('ai_error', {
            page: this.ctx.name || (this.ctx.isIndex ? 'index' : 'unknown'),
            error: em.substring(0, 100),
          });
        },
      });
    }

    async streamChat(messages, callbacks) {
      const apiConfig = this.getApiConfig();
      if (!apiConfig) {
        callbacks.onError(new Error('No API configuration'));
        return;
      }

      // 构建请求体
      const requestBody = {
        model: this.getModel(),
        messages,
        stream: true,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
      };

      // 通过代理时附加页面信息用于监控
      if (apiConfig.url === CONFIG.proxyUrl) {
        requestBody._page = this.ctx.name || (this.ctx.isIndex ? 'index' : 'unknown');
      }

      try {
        const resp = await fetch(apiConfig.url, {
          method: 'POST',
          headers: apiConfig.headers,
          body: JSON.stringify(requestBody),
        });

        if (!resp.ok) {
          const txt = await resp.text().catch(() => '');
          let errMsg = `API Error (${resp.status})`;
          try {
            const errJson = JSON.parse(txt);
            if (errJson.error) errMsg = errJson.error;
          } catch (e) { errMsg += ': ' + txt.substring(0, 200); }
          throw new Error(errMsg);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // 记录 token 用量（从 usage 字段提取）
        let inputTokens = 0;
        let outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const t = line.trim();
            if (!t || !t.startsWith('data: ')) continue;
            const data = t.slice(6);
            if (data === '[DONE]') {
              this.logClientUsage(inputTokens, outputTokens);
              callbacks.onDone();
              return;
            }
            try {
              const json = JSON.parse(data);
              const content = json.choices?.[0]?.delta?.content;
              if (content) callbacks.onChunk(content);
              // 提取 usage 信息（流结束时 DeepSeek 会在最后一个 chunk 返回）
              if (json.usage) {
                inputTokens = json.usage.prompt_tokens || 0;
                outputTokens = json.usage.completion_tokens || 0;
              }
            } catch (e) { /* skip parse errors */ }
          }
        }

        if (buffer.trim()) {
          const t = buffer.trim();
          if (t.startsWith('data: ') && t !== 'data: [DONE]') {
            try {
              const json = JSON.parse(t.slice(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content) callbacks.onChunk(content);
              if (json.usage) {
                inputTokens = json.usage.prompt_tokens || 0;
                outputTokens = json.usage.completion_tokens || 0;
              }
            } catch (e) { /* skip */ }
          }
        }
        this.logClientUsage(inputTokens, outputTokens);
        callbacks.onDone();
      } catch (e) {
        this.logClientUsage(0, 0, e.message);
        callbacks.onError(e);
      }
    }

    // 客户端用量记录（localStorage 备份监控）
    logClientUsage(inputTokens, outputTokens, error) {
      try {
        const today = new Date().toISOString().split('T')[0];
        const raw = localStorage.getItem(CONFIG.storageKeyUsageLog);
        const log = raw ? JSON.parse(raw) : {};

        if (!log[today]) {
          log[today] = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
        }
        log[today].requests++;
        log[today].inputTokens += inputTokens;
        log[today].outputTokens += outputTokens;
        if (error) log[today].errors++;

        // 只保留最近 60 天
        const keys = Object.keys(log).sort();
        while (keys.length > 60) { delete log[keys.shift()]; }

        localStorage.setItem(CONFIG.storageKeyUsageLog, JSON.stringify(log));
      } catch (e) { /* ignore */ }
    }

    attachToolEvents(msgEl) {
      msgEl.querySelectorAll('.bat-tool-ref').forEach(ref => {
        ref.addEventListener('click', function (e) {
          const toolName = this.dataset.tool;
          if (toolName && detectCurrentTool().isIndex && this.getAttribute('href') === '#') {
            e.preventDefault();
            highlightToolCards('{{' + toolName + '}}');
          }
        });
      });
    }
  }

  // ==================== 工具卡片高亮 ====================
  function highlightToolCards(text) {
    if (!detectCurrentTool().isIndex) return;
    const matches = text.match(/\{\{(.+?)\}\}/g);
    if (!matches) return;

    let first = null;
    matches.forEach(m => {
      const toolName = m.replace(/[\{\}]/g, '').trim();
      document.querySelectorAll('.tool-card').forEach(card => {
        const header = card.querySelector('.tool-card-header');
        if (header && header.textContent.trim() === toolName) {
          card.classList.add('bat-highlight');
          if (!first) first = card;
          setTimeout(() => card.classList.remove('bat-highlight'), 5000);
        }
      });
    });

    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ==================== 工具函数 ====================
  function findToolUrl(toolName) {
    for (const [name, info] of Object.entries(KNOWLEDGE_BASE)) {
      if (name === toolName || toolName.includes(name) || name.includes(toolName)) {
        const catPrefix = {
          '蛋白质工程': '蛋白质工程', '序列编辑': '序列编辑',
          '科研助手': '科研助手', '软件工具': '软件工具', '隐藏功能': '隐藏功能',
        }[info.category] || '';
        return catPrefix ? `${catPrefix}-${name}.html` : `${name}.html`;
      }
    }
    return null;
  }

  // ==================== 启动 ====================
  const batAI = new BatAI();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => batAI.init());
  } else {
    batAI.init();
  }
})();
