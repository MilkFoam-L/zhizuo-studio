// 提示词库：精选自 CC BY 4.0 开源提示词仓库（已按许可标注来源）。
// 来源：gpt-img-2/ai-image-prompt-cookbook 与 gpt-img-2/ai-xiaohongshu-chuanda-prompt-cookbook，
// 均为 Creative Commons Attribution 4.0 International，允许署名复制与二次分发。
// 提示词中的 [方括号] 是可替换变量，使用时替换为你的商品与场景信息。

export interface PromptLibraryEntry {
  id: string;
  category: '小红书封面' | '穿搭种草' | '电商主图' | '产品摄影' | '广告海报';
  title: string;
  scenario: string;
  prompt: string;
  source: string;
  sourceUrl: string;
}
export const PROMPT_LIBRARY_CATEGORIES = [
  '小红书封面',
  '穿搭种草',
  '电商主图',
  '产品摄影',
  '广告海报',
] as const;
export type PromptLibraryCategory = (typeof PROMPT_LIBRARY_CATEGORIES)[number];
export const PROMPT_LIBRARY: PromptLibraryEntry[] = [
  {
    id: 'xiaohongshu-cover',
    category: '小红书封面',
    title: '种草笔记封面',
    scenario: '产品推荐、好物分享、开箱内容。',
    prompt:
      '生成一张 3:4 小红书种草封面，主体是[产品名称]，放在温暖自然的生活方式场景中。上方留出标题区域，标题文字为“[短标题]”，字体清晰、醒目但不过度夸张。画面明亮、真实、有分享感，不要添加乱码、水印或多余贴纸。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/xiaohongshu-cover',
  },
  {
    id: 'xiaohongshu-cover-2',
    category: '小红书封面',
    title: '前后对比封面',
    scenario: '改造、修图、收纳、护肤、穿搭前后对比。',
    prompt:
      '生成一张小红书前后对比封面，左右分栏展示[对比对象]的变化，左侧标注“Before”，右侧标注“After”。顶部中文标题为“[标题]”。画面明亮真实，差异清楚但不要夸张，不要添加多余人物或不可读小字。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/xiaohongshu-cover',
  },
  {
    id: 'xiaohongshu-cover-3',
    category: '小红书封面',
    title: '合集清单封面',
    scenario: '好物合集、工具清单、模板合集。',
    prompt:
      '生成一张 3:4 小红书合集封面，展示 5 个[合集对象]，按网格或桌面平铺摆放。标题为“[合集标题]”，副标题为“[短副标题]”。风格清爽，背景浅色，物品之间留白充足，不要让文字压住主体。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/xiaohongshu-cover',
  },
  {
    id: 'xiaohongshu-cover-4',
    category: '小红书封面',
    title: '探店封面',
    scenario: '餐厅、咖啡店、展览、城市打卡。',
    prompt:
      '生成一张小红书探店封面，场景是[地点类型]，有自然光、真实空间层次和可打卡氛围。画面下方留出标题“[店名或主题]”。不要生成虚假地址、电话号码、二维码或具体商标，整体像真实手机拍摄但更精致。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/xiaohongshu-cover',
  },
  {
    id: 'xiaohongshu-cover-5',
    category: '小红书封面',
    title: '知识卡片封面',
    scenario: '学习笔记、职场方法、AI 教程。',
    prompt:
      '生成一张知识类小红书封面，主题是[知识主题]，采用白底卡片式排版，包含大标题“[标题]”和 3 个简短要点。视觉简洁、字体清晰、层级明确。不要添加长段文字、二维码、水印或复杂背景。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/xiaohongshu-cover',
  },
  {
    id: 'xiaohongshu-cover-6',
    category: '小红书封面',
    title: 'AI 工具推荐封面',
    scenario: '工具测评、AI 教程、效率技巧。',
    prompt:
      '生成一张小红书 AI 工具推荐封面，画面包含电脑屏幕、提示词输入框和生成图片预览，标题为“[标题]”。风格现代、清晰、有科技感但不过度炫光。不要使用官方品牌 logo，不要生成不可读界面小字。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/xiaohongshu-cover',
  },
  {
    id: 'ecommerce-main-image',
    category: '电商主图',
    title: '白底标准主图',
    scenario: '商品列表页、搜索结果页、SKU 展示。',
    prompt:
      '生成一张 1:1 电商白底主图，主体是[产品名称]，产品正面居中完整可见，保持真实形状、颜色、材质和包装比例。使用纯白背景、柔和棚拍光、自然接触阴影，边缘清晰。不要添加道具、手、假 logo、随机文字、水印或多余包装。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/ecommerce-main-image',
  },
  {
    id: 'ecommerce-main-image-2',
    category: '电商主图',
    title: '三卖点主图',
    scenario: '需要在图上表达 2-3 个核心卖点。',
    prompt:
      '生成一张 1:1 电商卖点主图，主体是[产品名称]，画面左侧展示产品，右侧放 3 个简短卖点图标区域。标题文字为“[主标题]”，卖点为“[卖点1]”“[卖点2]”“[卖点3]”。文字清晰可读，不要额外添加乱码、英文假字或水印。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/ecommerce-main-image',
  },
  {
    id: 'ecommerce-main-image-3',
    category: '电商主图',
    title: '节日促销主图',
    scenario: '大促、节日、限时优惠视觉。',
    prompt:
      '生成一张 4:5 节日促销电商主图，主体是[产品名称]，背景加入克制的[节日元素]，顶部标题为“[活动标题]”，底部保留价格和按钮位置。画面有促销氛围但不杂乱，产品真实清晰，不要添加夸张爆炸贴纸、乱码或假品牌。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/ecommerce-main-image',
  },
  {
    id: 'ecommerce-main-image-4',
    category: '电商主图',
    title: '使用前后对比图',
    scenario: '清洁、收纳、美妆、工具类商品。',
    prompt:
      '生成一张左右对比电商主图，左侧是使用前的[问题场景]，右侧是使用[产品名称]后的整洁效果。中间用简洁分割线区分，产品在右侧清晰可见。标题为“[短标题]”。不要夸大效果，不要添加不可读小字或无关人物。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/ecommerce-main-image',
  },
  {
    id: 'product-photo',
    category: '产品摄影',
    title: '高级棚拍',
    scenario: '官网、详情页、品牌视觉。',
    prompt:
      '生成一张高级棚拍产品照片，主体是[产品名称]，放在[台面材质]上，背景为[背景颜色]。使用柔和主光、清晰边缘光和自然接触阴影，产品居中完整可见。保持真实形状和材质，不要添加随机文字、水印或手。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/product-photo',
  },
  {
    id: 'product-photo-2',
    category: '产品摄影',
    title: '生活方式产品图',
    scenario: '独立站、社媒、广告图。',
    prompt:
      '生成一张生活方式产品摄影图，主体是[产品名称]，出现在[使用场景]，周围有少量相关道具但不抢主体。光线自然，画面真实温暖，右侧保留文案留白。保持产品结构和颜色准确，不要添加无关人物。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/product-photo',
  },
  {
    id: 'product-photo-3',
    category: '产品摄影',
    title: '材质微距',
    scenario: '强调面料、纹理、金属、食品质感。',
    prompt:
      '生成一张产品材质微距照片，主体是[产品名称]的[材质部位]，镜头近距离，浅景深，纹理真实清晰。背景简洁，光线柔和，适合详情页局部展示。不要过度锐化，不要改变材质颜色。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/product-photo',
  },
  {
    id: 'product-photo-4',
    category: '产品摄影',
    title: '食品产品摄影',
    scenario: '餐饮、电商食品、菜单图。',
    prompt:
      '生成一张食品产品摄影图，主体是[食品名称]，角度为 45 度或俯拍，食物新鲜真实，有自然油光和质感。背景为干净餐桌，少量道具。不要过度饱和，不要添加不可食用装饰或随机文字。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/product-photo',
  },
  {
    id: 'poster-design',
    category: '广告海报',
    title: '产品广告海报',
    scenario: '新品发布、品牌广告、投放素材。',
    prompt:
      '生成一张 4:5 产品广告海报，主体是[产品名称]，位于画面中心，背景为[场景/颜色]。顶部标题为“[标题]”，下方副标题为“[副标题]”。产品质感真实，文字清晰，留白充足。不要添加假 logo、水印、乱码或多余活动信息。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/poster-design',
  },
  {
    id: 'poster-design-2',
    category: '广告海报',
    title: '品牌形象海报',
    scenario: '品牌升级、品牌理念、社媒传播。',
    prompt:
      '生成一张品牌形象海报，围绕[品牌关键词]，主色为[品牌色]，画面包含抽象材质、产品或人物剪影。标题为“[品牌主张]”。整体高级、克制、可用于官网和社媒，不要添加大量小字或无关图标。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/poster-design',
  },
  {
    id: 'poster-design-3',
    category: '广告海报',
    title: '公益倡议海报',
    scenario: '环保、健康、安全、社区倡议。',
    prompt:
      '生成一张公益倡议海报，主题是[倡议主题]，主视觉为[象征元素]，标题为“[倡议标题]”。画面情绪真诚、克制，文字少而清楚，适合公众号和线下张贴。不要使用恐吓画面、虚假机构 logo 或乱码。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/poster-design',
  },
  {
    id: 'poster-design-4',
    category: '广告海报',
    title: '限时促销海报',
    scenario: '大促、优惠券、会员日。',
    prompt:
      '生成一张电商促销海报，主题是[活动名称]，主体产品为[产品名称]。标题文字为“[促销标题]”，画面下方保留价格和按钮区域但不要生成具体价格。风格热烈但高级，避免杂乱贴纸、夸张爆炸框和随机文字。',
    source: 'gpt-img-2/ai-image-prompt-cookbook (CC BY 4.0)',
    sourceUrl: 'https://image3.org/zh/prompts/poster-design',
  },
  {
    id: 'ai-womens-fashion-022',
    category: '穿搭种草',
    title: '法式慵懒 AI 女装提示词 1',
    scenario:
      '法式慵懒场景的 AI 女装图片提示词，适合女装店、小红书图文、电商主图和穿搭博主生成 9:16 竖版氛围图。',
    prompt:
      '9:16竖版构图，8K超高清、Ultra HD、电影级质感、细节拉满、无噪点、高锐度、色彩饱和高级，大师级摄影渲染，具ccd拍摄质感与iphone实拍感，高饱和纪实风格，带轻微胶片立体感。20岁纯欲甜妹，深棕色长发及腰，身着参考图同款灰色套装。置身温馨咖啡甜品店，镜面墙上手写各类咖啡饮品名称与价格，搭配可爱涂鸦。女孩坐在桌前，托腮看向镜头。桌上摆放贝果、可颂等餐点。整体对比度强烈却不失自然，画面真实呈现下午茶人像写真场景。',
    source: 'gpt-img-2/ai-xiaohongshu-chuanda-prompt-cookbook (CC BY 4.0)',
    sourceUrl:
      'https://gptimg2.art/zh/prompts/gpt-image-2/ai-womens-fashion-022?utm_source=github&utm_medium=repo&utm_campaign=fashion_prompt_cookbook&utm_content=xiaohongshu-outfit',
  },
  {
    id: 'ai-womens-fashion-038',
    category: '穿搭种草',
    title: 'OOTD 摆拍 AI 女装提示词',
    scenario:
      'OOTD 摆拍场景的 AI 女装图片提示词，适合女装店、小红书图文、电商主图和穿搭博主生成 9:16 竖版氛围图。',
    prompt:
      '9:16竖版构图，8K超高清、Ultra HD、电影级质感，细节拉满、无噪点、高锐度、色彩饱和高级。以OOTD风格将原图中的衣服和裤子按其排版姿势，立体摆放在铺满画面的白色毛茸茸毯子上。衣服和裤子面料柔软，呈现出仿佛穿在身上般更强的立体感，并带有自然影子。画面左上角放置一本杂志书，书上摆放着高级鲜艳的粉白色玫瑰花，部分粉白色花瓣散落一旁。右下角放置香奈儿红色链条包包与香水，整体营造出高级立体效果。',
    source: 'gpt-img-2/ai-xiaohongshu-chuanda-prompt-cookbook (CC BY 4.0)',
    sourceUrl:
      'https://gptimg2.art/zh/prompts/gpt-image-2/ai-womens-fashion-038?utm_source=github&utm_medium=repo&utm_campaign=fashion_prompt_cookbook&utm_content=xiaohongshu-outfit',
  },
  {
    id: 'ai-mens-fashion-028',
    category: '穿搭种草',
    title: '商务通勤男装 AI 男装提示词 1',
    scenario:
      '商务通勤男装场景的 AI 男装图片提示词，适合男装店、小红书图文、电商主图和男士穿搭内容生成 9:16 竖版氛围图。',
    prompt:
      '帮我生成图片：保留图中深咖色长款风衣的所有细节，30岁左右痞帅男性穿着，内搭黑色修身衬衫（领口微露），下身黑色直筒牛仔裤，脚穿棕色马丁靴。男性发型新潮，面相清秀，佩戴金丝框眼镜，多金气质。场景为现代美术馆旋转楼梯（白色弧形栏杆、大理石地面、墙上艺术画作，浅白+灰色调），人物一只手插风衣口袋，另一只手自然摆动，呈现行走姿态，俯拍角度且人物居中。画面真实高清有质感。比例9:16。',
    source: 'gpt-img-2/ai-xiaohongshu-chuanda-prompt-cookbook (CC BY 4.0)',
    sourceUrl:
      'https://gptimg2.art/zh/prompts/gpt-image-2/ai-mens-fashion-028?utm_source=github&utm_medium=repo&utm_campaign=fashion_prompt_cookbook&utm_content=xiaohongshu-outfit',
  },
  {
    id: 'ai-mens-fashion-011',
    category: '穿搭种草',
    title: '男装街拍 AI 男装提示词 1',
    scenario:
      '男装街拍场景的 AI 男装图片提示词，适合男装店、小红书图文、电商主图和男士穿搭内容生成 9:16 竖版氛围图。',
    prompt:
      '帮我生成图片：使用冷白光照明，穿着图中同款衣服，黑色阔腿裤，搭配白色平板鞋，左手佩戴简约男士手表。场景设定为17岁面容精致帅哥在高档下午茶店，店内有时尚陈列，室外是城市冬日街景，融合室内外景象，温馨且富有格调，人物动作改为右手端起咖啡杯准备饮用。比例 9:16。',
    source: 'gpt-img-2/ai-xiaohongshu-chuanda-prompt-cookbook (CC BY 4.0)',
    sourceUrl:
      'https://gptimg2.art/zh/prompts/gpt-image-2/ai-mens-fashion-011?utm_source=github&utm_medium=repo&utm_campaign=fashion_prompt_cookbook&utm_content=xiaohongshu-outfit',
  },
  {
    id: 'ai-kids-fashion-002',
    category: '穿搭种草',
    title: '童装对镜自拍 AI 童装提示词 1',
    scenario:
      '童装对镜自拍场景的 AI 童装图片提示词，适合童装店、小红书图文、电商主图和儿童穿搭内容生成 9:16 竖版氛围图。',
    prompt:
      '帮我生成图片：8岁中国小男孩，发型是深棕自然卷短发（发丝蓬松微乱，带有随性毛躁感，手持黑色苹果手机对镜自拍（手机遮挡面部），动作活泼可爱，穿着参考第1张图片的服饰鞋帽和搭配，孩童体态真实自然，姿势可爱活泼，身处现代轻奢风客厅，奶油色墙面，浅灰色大尺寸哑光瓷砖地面，黑色复古电视柜，柜上摆放黑胶唱片、小型圣诞树和潮玩摆件。墙面投影着黑胶唱片图案和英文“Love is a gentle melody”。右侧是白色纱帘，顶部有嵌入式灯带，左侧露出米白色沙发一角。整体光线柔和，氛围温馨，细节精致，8K高清，写实摄影风格。',
    source: 'gpt-img-2/ai-xiaohongshu-chuanda-prompt-cookbook (CC BY 4.0)',
    sourceUrl:
      'https://gptimg2.art/zh/prompts/gpt-image-2/ai-kids-fashion-002?utm_source=github&utm_medium=repo&utm_campaign=fashion_prompt_cookbook&utm_content=xiaohongshu-outfit',
  },
  {
    id: 'ai-womens-fashion-066',
    category: '穿搭种草',
    title: '店内穿搭 AI 女装提示词 1',
    scenario:
      '店内穿搭场景的 AI 女装图片提示词，适合女装店、小红书图文、电商主图和穿搭博主生成 9:16 竖版氛围图。',
    prompt:
      '高清 9:16 人像摄影图片，背景为温馨雅致的服装店内。图中模特身穿参考图中的衣服+短裙+帽子+鞋子，怀抱着一只布偶猫，背向镜头，镜子清晰映出其同款身影。模特脸上挂着礼貌微笑，眼神温和看向镜中的自己。镜子前景摆放着娇艳的粉玫瑰。透过窗户可见室外雨景与过山车。整体呈优雅甜美氛围，精致风格，营造出温馨且松弛的感觉。',
    source: 'gpt-img-2/ai-xiaohongshu-chuanda-prompt-cookbook (CC BY 4.0)',
    sourceUrl:
      'https://gptimg2.art/zh/prompts/gpt-image-2/ai-womens-fashion-066?utm_source=github&utm_medium=repo&utm_campaign=fashion_prompt_cookbook&utm_content=xiaohongshu-outfit',
  },
];

export function promptLibraryByCategory(): Record<string, PromptLibraryEntry[]> {
  return PROMPT_LIBRARY.reduce<Record<string, PromptLibraryEntry[]>>((acc, entry) => {
    (acc[entry.category] ??= []).push(entry);
    return acc;
  }, {});
}
