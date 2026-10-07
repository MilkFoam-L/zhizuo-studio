# 自动化发布：想法 → 生图 → 调整 → 发布

更新：2026-10-07。自动化流水线把「创作者的想法」变成一条可审计的发布流程：助手模型生成文案草稿与配图提示词并自动创建生图任务，图片就绪后由**用户显式确认**，通过自部署的小红书发布通道 (MCP) 发布到你的账号。

## 流程与状态

```
想法 → reviewing/generating（助手草稿 + 生图任务在途）
     → ready（全部配图完成，等待确认）
     → 用户确认 → publishing → published
任意失败 → failed（可取消）；取消 → cancelled
```

- 助手模型编排：`generateWithTools` 单轮工具调用循环（最多 8 轮），工具为 `read_brief`、`search_prompt_library`、`add_image_prompt`（**调用即创建生图任务**：额度预占 + 任务事件 + 画布任务节点）与 `finish_draft`。
- 生图任务复用现有任务管线：数据库租约、提交前 checkpoint、失败/取消结算、处理记录时间线全部生效。
- 单图可重新生成（带调整要求，默认上限 3 次），每次重试消耗新的任务额度。
- 发布需要：运行状态 ready + 用户点击「确认发布」+ 已配置并启用的发布通道。

## 配置

1. **助手模型**：「模型接入」为服务商填写"助手模型 ID"（需支持工具调用的对话模型；OpenAI 兼容与 Gemini 原生可用，异步中转不支持）。未配置时自动化入口会明确提示。
2. **发布通道 (MCP)**：「模型接入 → 发布通道 (MCP)」添加端点与可选 Bearer token（AES-GCM 加密存储），并完成扫码登录。

## 内置发布通道（Docker 部署）

`compose.yaml` 已内置发布通道服务（**来源：[xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)，已获作者授权内置**，其许可与使用条款见原仓库）：

```sh
docker compose up -d          # 同时启动 studio 与 xiaohongshu-mcp
```

- 内置通道端点：`http://xiaohongshu-mcp:18060/mcp`（compose 网络内），本机浏览器访问地址为 `http://127.0.0.1:18060`
- 「模型接入 → 发布通道 (MCP) → 添加发布通道」提供了内置/本机端点预设，一键选用
- 扫码登录：通道卡片点「扫码登录」，二维码在织作界面内展示，用小红书 App 扫描后点"我已扫码"；登录态（cookie）持久化在 Docker 卷 `zhizuo-studio_xhs-mcp-data`
- 发布图片通过共享卷 `publish-staging` 在织作与 MCP 之间交接，无需公网暴露
- 注意：镜像 `xpzouying/xiaohongshu-mcp` 需从 Docker Hub 拉取；受限网络环境可能需要配置镜像加速

本地（非 Docker）开发：单独运行 MCP（`go run .` 或其登录工具），发布通道端点填 `http://127.0.0.1:18060/mcp`。

## 发布行为

- 发布调用 MCP 工具 `publish_content`，图片以**本机绝对路径**交接：发布前织作把选中配图渲染为 PNG 写入 `DATA_DIR/publish-staging/<runId>/`。MCP 服务与织作同机部署时直接可用；跨机部署需要共享该目录或改用公网可达的 HTTP 链接（自行评估暴露风险）。
- 标题/正文/话题标签来自助手草稿；可见范围默认公开，可选仅自己可见（推荐首次使用）。
- 发布后回执文本与时间记入运行记录；失败时运行回到 ready 并记录原因。

## 风险与边界（务必阅读）

- **平台合规**：xiaohongshu-mcp 通过浏览器自动化驱动你自己的登录会话，是否违反平台条款由用户自行判断与承担；织作不绕过登录、不复用他人 Cookie。
- **账号互踢**：同一小红书账号不能同时在多个网页端登录，MCP 登录后其他网页端会被踢出。
- **费用**：生图按服务商计费；自动化失败或取消不自动退款。
- **验收边界**：交付的自动化证据来自 stub 级全链路测试（fixture 助手模型 + stub MCP，见 `apps/server/tests/assistant.test.ts`、`mcp.test.ts`）；真实助手模型调用与真实发布验收需要已部署并登录的 MCP 环境，尚未完成。
- 定向测试：`npx tsx --test apps/server/tests/mcp.test.ts apps/server/tests/assistant.test.ts`
