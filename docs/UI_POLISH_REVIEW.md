# 织作工作台 UI 改进与审阅

日期：2026-09-30。模式：**full**。本轮实施范围为 React 项目首页、模板、画布工作区、简报/版本检查器、模型接入表单、文案与海报弹窗、版本对比及导出界面。沿用已有 shadcn/ui、Radix、Tailwind 与品牌 CSS；无新增依赖。

已读取用户指定的 [make-interfaces-feel-better](https://www.ui-skills.com/skills/jakubkrehel/make-interfaces-feel-better)、[emil-design-eng](https://www.ui-skills.com/skills/emilkowalski/emil-design-eng) 公开技能正文，以及 [UI_REFERENCES.md](UI_REFERENCES.md) 中的公开设计证据。本轮以暖白、深绿、清楚的中文阅读层次为方向。

**审阅边界：浏览器对本地地址仍返回保存的权限拒绝。本轮没有绕过该策略，也没有进行浏览器渲染、截图、点击或触屏实测。以下结果为源码检查、静态颜色计算和构建验证；没有将其称为视觉验收通过。**

## 五个维度的覆盖

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | `styles.css` 中桌面/窄屏字号、正文/辅助文字、表单、节点、版本表；`shadcn-theme.css` | 正文和表单采用 14–16px，辅助信息 12–13px，手机输入 16px；计算关键纯色对比。实际字体渲染和用户图片上的内容未验证 |
| Surfaces | 项目/模板 Card、Dialog、简报、检查器、图片预览、表单边界和按钮点击区域 | 调整层级、12px 卡片与 5px 内图圆角、纯黑低透明度图像描边、40/44px 控件。实际溢出/遮挡未验证 |
| Animations | 品牌样式中全部 hover、按钮/标签页基础类、Toast、Dialog、Canvas fitView | 删除上浮与进场位移动效；高频适应画布操作即时完成；hover 限定精细鼠标；保留 reduced-motion。10% 速度浏览器检查未运行 |
| Icons | `App.tsx` 导航、`ProjectEditor.tsx` 工具栏和面板、`Editors.tsx` 图层控件 | 沿用 Lucide；补足图标按钮名称、当前页/展开/按下语义；手机图标 18–20px、点击区域 44px。屏幕阅读器未实测 |
| Performance | 现有动画属性、依赖清单边界、构建输出 | 未新增动画库、字体或图片资源；减少重复 transform 动画；稳定 Canvas 上下文与内容节点。构建成功，现有主包仍超过 500kB 警告；运行时帧率与加载性能未验证 |

## Findings 与实际修改

合并重复性问题，共 15 项实质修改。Before 描述本轮修改前的源码；After 为已写入的实现。

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| HIGH | `apps/web/src/styles.css`, `apps/web/src/styles.css`, `apps/web/src/styles.css`, `apps/web/src/styles.css`; `apps/web/src/shadcn-theme.css` | 多数业务说明、时间、字段与版本详情为 8–11px，灰绿辅助文字对比偏低 | 正文/字段 14–16px，辅助信息 12–13px；统一 `--muted-foreground: #627166`。节点、检查器、任务、模型表单、登录、对比、导出均纳入相同阅读层次 | Typography / 可读性：需要用户做决定的说明与数值必须可以正常阅读；保留模板插画自身的印刷比例，它们为 `aria-hidden` 装饰 |
| MEDIUM | `apps/web/src/Dashboard.tsx`, `apps/web/src/styles.css` | 288px 以上欢迎海报与模板先于最近项目，首屏偏展示 | 最近项目移到标题之后，删除欢迎海报及其孤儿样式；空状态展示创建路径，模板随后出现并注明版式示意 | 信息优先级：打开工作台即可继续已有项目，或明确开始第一份素材；不构造 AI 成功案例 |
| HIGH | `apps/web/src/styles.css`, `apps/web/src/styles.css`, `apps/web/src/styles.css` | 手机仍三列模板，标签缩到 6–9px | 模板中屏两列、540px 以下一列；项目小屏一列；卡片标题 15px、说明和尺寸 12px，搜索/恢复动作重排 | 响应式与 Typography：通过重排保留内容，而不是缩小中文阅读尺度 |
| HIGH | `apps/web/src/styles.css`, `apps/web/src/styles.css`; `apps/web/src/ProjectEditor.tsx` | 图标按钮可降到 27×28px，部分按钮约 29–34px，版本选择只有 14px 复选框 | 常规桌面按钮至少 40px，手机/触控关键控件 44px；版本复选框由独立 40/44px Label 包裹；普通确认标签可整块点击 | Minimum Hit Area：提升可点击范围，避免通过重叠伪元素扩大热点 |
| MEDIUM | `apps/web/src/styles.css`, `apps/web/src/shadcn-theme.css` | 表单边界过浅，手机字体过小，部分高级设置挤在两列 | 输入边界统一为 `#83927f`，焦点使用 `#47765b`；手机输入 16px、44px 高，服务商配置改为单列 | Surfaces / 可访问表单：清晰分辨控件边界和输入内容；标签、错误提示与 shadcn 字段语义保留 |
| MEDIUM | `apps/web/src/ProjectEditor.tsx`, `apps/web/src/ProjectEditor.tsx`, `apps/web/src/styles.css` | 中窄屏默认打开简报占据画布；检查器与简报可能同时叠加 | 1100px 以下初始收起简报；选择内容或打开简报时切换侧面板；新增简报关闭按钮；桌面简报 292px/详情 316px，中屏调整为覆盖面板 | 工作区域布局：为画布留空间，同时保持关闭入口与展开状态可读 |
| HIGH | `apps/web/src/ProjectEditor.tsx`, `apps/web/src/Editors.tsx`, `apps/web/src/styles.css` | 窄屏隐藏工具文字后缺少明确可访问名称；一行工具被迫继续缩小 | 上传、文案、模板增加 `aria-label` 和 title；简报/任务列表提供展开关系；手机工具栏两行、44px 控件；模板/文字图层增加 `aria-pressed` 并加强选中边界 | Icons / 可访问名称：鼠标、触控、辅助技术能识别同一个动作 |
| MEDIUM | `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `apps/web/src/styles.css` | 图标导航靠视觉说明，键盘需重复穿过导航 | 导航加中文 `aria-label`、title、`aria-current`；新增“跳到工作区”链接和可聚焦 main；侧栏文本采用统一阅读色阶 | 键盘导航与状态语义：当前页面和内容入口可被直接识别 |
| LOW | `apps/web/src/styles.css`, `apps/web/src/styles.css` | 卡片层次与图片边缘不一致，用户品牌色可能成为项目封面文字色 | 卡片统一细结构边界与轻阴影；模板嵌套圆角按内边距调整；图片预览加纯黑 10% 内描边；封面文字采用稳定前景色，品牌色用于装饰 | Surfaces：保留用户图片边缘和内容可读性；阴影只表达层级 |
| MEDIUM | `apps/web/src/styles.css`, `apps/web/src/styles.css` | 数字更新宽度可能抖动，长服务商地址/项目名显示不完整 | 时间、任务数、版本、尺寸和输入使用 tabular numerals；标题平衡换行、正文 pretty；服务地址可换行，项目标题保留完整 title | Typography：让扫描与比较更稳定；保留完整信息入口 |
| MEDIUM | `apps/web/src/styles.css`, `apps/web/src/components/ui/button.tsx`, `apps/web/src/components/ui/tabs.tsx`, `apps/web/src/Canvas.tsx` | 按钮/卡片 hover 上浮、通用 transition-all、Toast 位移、fitView 350ms | 去掉高频位移与宽泛过渡，fitView duration=0；静态按压反馈；颜色 hover 仅鼠标 120ms；Toast/弹窗即时显现；保留 reduced-motion 覆盖伪元素 | Motion restraint / Performance：高频操作即时响应，触控不触发品牌 hover，键盘焦点不播放过渡 |
| MEDIUM | `apps/web/src/styles.css`, `apps/web/src/styles.css`; `apps/web/src/ProjectEditor.tsx` | 窄屏海报预览与控制栏并列，版本对比、导出文字继续缩小 | 手机海报预览/编辑、版本比较上下排列；版本表文本保持 12–14px、选择/查看区域明确；任务与保存提示使用可读颜色与字号 | 阅读与恢复动作：维护实际编辑、导出和错误处理路径；CSS 不改变供应商任务或保存协议 |

| MEDIUM | `apps/web/src/ProjectEditor.tsx`, `apps/web/src/styles.css` | 服务中断的异步任务只提示人工核对，没有停止后续查询入口 | 配合已增加的 `upstreamTaskId` 合同，显示“核对原任务（不重复提交）”及任务编号；提供“停止核对/停止本地等待”；保留主动重新创作和可能重复计费的说明；`reconciling` 状态不计入“正在处理”任务数 | 真实状态反馈：停止本地查询不等于停止供应商生成；用户能区分恢复原任务与提交新任务 |

| MEDIUM | `apps/web/src/Editors.tsx` | 版本比较中的海报、素材图片没有宽高属性，加载前高度由图片下载决定 | 海报使用版本中的实际 width/height，素材使用关联 Asset 的实际 width/height；现有 `max-width:100%;height:auto` 保持响应式比例 | Performance / 布局稳定：浏览器可在下载完成前从业务元数据预留比例，降低版本比较布局位移 |

| MEDIUM | `apps/web/src/Canvas.tsx`, `apps/web/src/Canvas.tsx`, `apps/web/src/Canvas.tsx` | 每次节点拖动都会创建新的 ContentContext value，使所有内容节点收到上下文更新；节点也没有 memo 边界 | 按 assets / versions / brief memo 上下文 value，并在模块级为 ContentNode 添加 React.memo；节点类型映射继续保持稳定 | Performance：画布布局变化无需重新计算未变化的内容节点；属于源码层面的重渲染优化，尚未取得 200 节点运行时耗时对比 |

## Considered but Rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| 项目首页 | 新增营销首屏、AI 成功计数和默认虚构作品 | 用户需要真实项目入口；这些内容会掩盖实际工作流，且成功计数没有业务数据依据 |
| `components/ui/button.tsx` | 为所有按钮加入 scale 按压弹簧 | 画布编辑属于高频操作；静态颜色/按压状态更稳定，也避免缩放文字 |
| `styles.css` | 引入另一套动画库或 UI 样式框架 | 已有 shadcn/Radix、Tailwind 与品牌 CSS 能完成本轮需求；增加依赖没有实际收益 |
| 模板预览 | 把所有装饰性印刷文字强制放大至 14px | 模板预览是 `aria-hidden` 的版式示意，需要维持成品比例；真正的模板名称、描述、类别和尺寸已单独可读 |

## Verification

- `npm run typecheck`：通过。
- `npm run build`：通过，Vite 与服务器 tsup 均成功。Vite 主 JS 约 588kB（gzip 约 187kB），仍提示大于 500kB；本轮没有把构建警告隐藏或提高阈值。
- 使用 PostCSS 解析品牌样式，并遍历所有 `:hover` 规则：**0 条**缺少 `(hover: hover) and (pointer: fine)` 限定的品牌 hover 规则。该检查不代表第三方库内部样式逐条验收。
- 依据 WCAG 相对亮度公式检查以下纯色组合：辅助文字在暖白背景 **4.88:1**、白底 **5.16:1**；主动作白字 **9.52:1**；输入边界对白底 **3.29:1**；AI 按钮文字 **5.86:1**；警告文字 **5.00:1**；错误文字 **5.89:1**。这不是整个页面的 WCAG 认证。
- 源码确认加载、空项目、错误、禁用、成功反馈和原有生成/保存/导出调用仍存在；新增的是布局、点击区域与语义状态。没有使用模拟结果替代真实任务。
- **Not verified**：360/390/768/1440px 实际布局；Tab/Enter/Escape 和弹窗焦点恢复；触控拖拽；真实图片/长文案显示；输入自动缩放；hover/focus/active/loading/empty 实际渲染；10% 速度运动检查；创建→上传→编辑→版本→导出的浏览器回归。保存的本地浏览器权限策略拒绝仍需解除后运行。

## React Doctor 诊断复核

对根代理首次设计扫描的 **7 项 warning** 逐一读取源码。版本为 `react-doctor@0.9.14`；没有安装到项目、修改检测配置或添加规则抑制。补丁后使用相同版本重扫，诊断变为 **5 项**；修复的是版本比较的两个图片尺寸问题。

| Rule / 数量 | 判断与置信度 | 文件证据 | 处理 |
| --- | --- | --- | --- |
| `no-redundant-title-tooltip` ×2 | 假阳 / 高 | `App.tsx:26` 导航在常规桌面有文字；`styles.css` 的 `.in-editor .sidebar nav a` 与手机 `.sidebar nav a` 将文字设为 `font-size:0`，使用图标导航 | 保留中文 title 供图标态鼠标识别；独立 `aria-label` 提供辅助技术名称。没有为了分数去掉实际有用的信息 |
| `no-img-without-dimensions` / Canvas ×2 | 假阳 / 高 | `Canvas.tsx:10` 图片置于 `.canvas-node{width:258px}` 中；已有 `.node-image img{width:100%;height:210px;object-fit:contain;display:block}` 在加载前固定图片框 | 保留固定展示框，不附加不同素材的原始尺寸影响节点布局；实际图片加载的浏览器位移尚未实测 |
| `no-img-without-dimensions` / Editors ×2 | 真阳 / 高 | `Editors.tsx:28` 比较图片原来只有 src/alt，CSS 只有 `max-width:100%;height:auto`，没有预留原始比例 | 已补海报和关联素材的业务宽高；重扫这两项诊断消失 |
| `no-all-caps-body-text` ×1 | 假阳 / 高 | `Providers.tsx:24` 原文“前端不会读取已保存的完整密钥。接入前请确认服务商可信、API 协议和模型名称正确；不同中转商的图片编辑能力可能不同。”正文为中文，其中 `API` 是标准缩写 | 保留协议名称，未把专业缩写改为错误大小写，也未静默关闭规则 |

运行命令：`npx --yes react-doctor@0.9.14 design --verbose --no-telemetry --output-dir work/react-doctor-after`。扫描 38 文件，正常结束；完整日志 `work/react-doctor-after.log`，逐项 JSON 为 `work/react-doctor-after/diagnostics.json`。设计扫描不产生 React 健康评分，也不等于浏览器界面验收。最新 `npm run typecheck` 通过。

## Verdict

**Needs changes（浏览器验收尚未完成）**。本轮记录的源码问题已经调整；在以上 Not verified 项完成之前，不给出界面可用性或视觉验收通过的结论。

回滚边界：本次改动只在 `apps/web/src` 的业务 UI/品牌样式及本审阅文档。没有改动数据表、模型密钥或生产部署。异步核对 UI 使用主任务已扩展的 GenerationTask 可选字段及既有取消接口，没有自行修改 API 实现。项目当前文件尚未提交，因此回滚时应按本轮差异恢复前端修改，保留已有业务代码与用户文件。

## 后续工程检查

页面已通过动态导入拆分：首页入口约313.3 kB（gzip 101.64 kB），画布页约254.87 kB（gzip 81.03 kB），最终构建无原先的500 kB单块警告。`npm run check` 的55项服务端与协议测试全部通过；这些结果不能替代浏览器布局和交互验收。源码经Prettier整理，表格使用文件路径定位而非整理前行号。
