# 多服务商与中转接口接入

此文档描述当前 `apps/server/src/providers.ts` 的实际请求合同。支持协议不等于所有供应商都已实测；服务商名称、模型 ID、参数支持和计费以你使用的服务文档为准。不要将下面的占位模型名直接当成可用模型。

## 配置与请求路径

在“模型接入”新增一个渠道，填写名称、协议、完整 API 基础地址、API Key、文本模型、图片模型、超时秒数。可保存多个渠道，任务选择渠道后使用其对应模型。至少配置一个模型；JSON 异步协议必须配置图片模型。

**Base URL 保留路径前缀，不会自动加 `/v1`。** 只去除末尾斜线，再拼接相应端点。

| Base URL | 端点 | 最终 URL |
| --- | --- | --- |
| `https://gateway.example.com/v1` | `chat/completions` | `https://gateway.example.com/v1/chat/completions` |
| `https://gateway.example.com/proxy/team/v1/` | `images/generations` | `https://gateway.example.com/proxy/team/v1/images/generations` |
| `https://gateway.example.com` | `models` | `https://gateway.example.com/models` |
| `https://generativelanguage.googleapis.com/v1beta` | `models/{model}:generateContent` | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |

不要把 `/chat/completions` 或 `/images/generations` 填进 Base URL，否则会重复拼接端点。`example.com` 及其子域名在本页仅是说明地址。

当前要求公共 HTTPS 地址，拒绝用户名 / 密码 URL、片段、Base URL 查询参数、localhost、内网和保留地址。DNS 结果在发送前检查并固定到该次 HTTPS 连接；不支持本机 Ollama 或内网模型。GET 最多跟随 3 次重定向，带凭据的 GET 不能跨源；付费 POST 不跟随重定向重发。

API Key 由服务端 AES-256-GCM 加密保存。读取渠道只返回 `hasKey`；编辑时 API Key 留空保留旧值，填写新值才替换。生成任务保存渠道与加密凭据快照，修改渠道不会改变已经创建的任务。不要在分享的截图、项目文本或问题报告中加入真实密钥。

超时是 **10–300 秒整数**，约束一次执行回合中的 DNS、提交、轮询和下载。异步图片任务在保存上游 ID 后可进入独立的有界恢复回合，因而整个本地任务可能超过这一时长；恢复规则见下文。当前每个服务实例最多并行 2 个任务，包括恢复查询。

## OpenAI 兼容协议

渠道配置的可提交示例（`POST /api/providers`；示例密钥需由用户自己在本地替换）：

```json
{
  "name": "我的兼容接口",
  "kind": "openai",
  "baseUrl": "https://gateway.example.com/v1",
  "apiKey": "REPLACE_WITH_YOUR_OWN_KEY",
  "textModel": "YOUR_TEXT_MODEL_ID",
  "imageModel": "YOUR_IMAGE_MODEL_ID",
  "timeoutSeconds": 180
}
```

当前使用 `Authorization: Bearer <key>`。连接检查请求 `GET {baseUrl}/models`，只检查是否返回 `data` 数组，不提交生成、不验证图片编辑能力，也不保证服务商将模型列表请求视为免费。

文案请求 `POST {baseUrl}/chat/completions`，结构如下；系统编辑规则由服务端固定加入，用户商品资料放在 user 消息中。

```json
{
  "model": "YOUR_TEXT_MODEL_ID",
  "messages": [
    { "role": "system", "content": "服务端的商品事实约束和 JSON 输出要求" },
    { "role": "user", "content": "{\"confirmedProductFacts\":{\"productName\":\"棉布包\",\"sellingPoints\":\"米白色\",\"confirmed\":true},\"instruction\":\"生成三页图文草稿\"}" }
  ],
  "response_format": { "type": "json_object" }
}
```

`content` 中实际发送完整简报，包括受众、价格、品牌、颜色、语气和平台。模型需在 `choices[0].message.content` 返回 JSON 字符串，例如：

```json
{
  "titles": ["米白色棉布包的日常搭配"],
  "body": "整理一份米白色棉布包的搭配灵感。具体尺寸、容量和使用感受还需补充。",
  "tags": ["日常搭配", "棉布包"],
  "pages": [
    { "headline": "米白色棉布包", "body": "以已确认的颜色和产品名称为内容起点。" }
  ],
  "warnings": ["尚未提供尺寸、容量和价格"]
}
```

当前只解析第一个 choice 的字符串 content。没有 Responses API、工具调用、多候选合并、流式输出或纯 reasoning 输出适配。拒绝 `response_format` 的接口需要新增明确适配，不会自动更换成另一种请求并额外收费。

无参考图时，图片请求为 `POST {baseUrl}/images/generations`：

```json
{
  "model": "YOUR_IMAGE_MODEL_ID",
  "prompt": "暖色背景，柔和自然光，不生成文字，为商品保留中央展示区。",
  "n": 1,
  "size": "1024x1024"
}
```

有参考图时，改为 `POST {baseUrl}/images/edits` 的 multipart/form-data。字段为 `model`、`prompt`、`n=1`、`size=1024x1024` 和名为 `image` 的一个 PNG / JPEG / WebP 文件。当前不包含 mask、多参考图、quality、seed 或供应商私有参数。

响应读取 `data[0].b64_json`，否则下载 `data[0].url`。仅保存第一个结果；Base64 必须是原始编码字符串，当前不接受 `b64_json` 中的 data URL。URL 必须是可无额外授权下载的公共 HTTPS 地址。结果下载不携带供应商密钥，临时 URL 的图片会在任务中转存为项目素材。

## Gemini 原生协议

```json
{
  "name": "我的 Gemini 原生接口",
  "kind": "gemini",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
  "apiKey": "REPLACE_WITH_YOUR_OWN_KEY",
  "textModel": "YOUR_GEMINI_TEXT_MODEL_ID",
  "imageModel": "YOUR_GEMINI_IMAGE_MODEL_ID",
  "timeoutSeconds": 180
}
```

通过 `x-goog-api-key` 传入密钥；模型 ID 可以带一个 `models/` 前缀，发送前会去除。连接检查调用 `GET {baseUrl}/models`，要求响应有 `models` 数组。

文案请求 `POST {baseUrl}/models/{textModel}:generateContent`：

```json
{
  "systemInstruction": { "parts": [{ "text": "服务端的商品事实约束和 JSON 输出要求" }] },
  "contents": [{ "role": "user", "parts": [{ "text": "包含 confirmedProductFacts 与 instruction 的 JSON 字符串" }] }],
  "generationConfig": { "responseMimeType": "application/json" }
}
```

图片请求 `POST {baseUrl}/models/{imageModel}:generateContent`：

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "保留参考商品外观，添加暖色背景，不生成文字。" },
      { "inlineData": { "mimeType": "image/png", "data": "BASE64_IMAGE_BYTES" } }
    ]
  }],
  "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
}
```

无参考图时不发送 `inlineData`。文案读取首个 candidate 的文本 parts 并合并为 JSON；图片读取首个 candidate 中首个图片 part，支持 `inlineData` 和 `inline_data` 两种字段拼写。需要模型原生支持图片输出，普通文本模型不会因协议选择而获得生图能力。

当前不适配 Vertex AI OAuth / 项目区域路径、Files API、Imagen 专用 predict 协议、流式生成、模型专用比例配置和多张参考图。此处列出的是织作当前合同，不替代供应商最新 API 文档。

## 受限 JSON 异步中转协议

适用于接收固定 JSON 提交体、返回任务 ID、通过 GET 轮询状态、最终给出单个图片 URL 的服务。字段映射只读取 JSON 对象，不执行 JavaScript 或模板脚本。

```json
{
  "name": "我的异步图片渠道",
  "kind": "async-json",
  "baseUrl": "https://gateway.example.com/api/v1",
  "apiKey": "REPLACE_WITH_YOUR_OWN_KEY",
  "textModel": "",
  "imageModel": "YOUR_ASYNC_IMAGE_MODEL_ID",
  "timeoutSeconds": 180,
  "asyncMapping": {
    "submitPath": "/tasks",
    "pollPath": "/tasks/{taskId}",
    "taskIdPath": "data.id",
    "statusPath": "data.status",
    "successValue": "done",
    "failureValue": "error",
    "resultUrlPath": "data.output.url"
  }
}
```

一次实际请求序列：

1. `POST https://gateway.example.com/api/v1/tasks`，Bearer 鉴权，JSON 为 `{"model":"YOUR_ASYNC_IMAGE_MODEL_ID","prompt":"商品背景","image":"data:image/png;base64,..."}`。没有参考图则省略 `image`。
2. 供应商返回 `{"data":{"id":"job-123"}}`。服务端等待 `upstreamTaskId` 持久化成功后才开始查询；若保存失败，不继续轮询或重提生成请求。
3. 每隔约 2 秒调用 `GET https://gateway.example.com/api/v1/tasks/job-123`，使用同一 Bearer 鉴权。
4. `{"data":{"status":"running"}}` 继续等待；`{"data":{"status":"done","output":{"url":"https://images.example.com/result.png"}}}` 开始下载；`{"data":{"status":"error"}}` 显示失败。

每个执行回合最多轮询 60 次，同时受该回合超时限制，不代表保证等待满 120 秒或 300 秒。失败值只配置一个；`cancelled` / `canceled`（不区分大小写）识别为供应商取消。其他存在的状态值视为处理中，状态字段缺失会进入需要核对的错误。

限制：

- `submitPath` 与 `pollPath` 是相对路径，前面都保留 Base URL 前缀；不允许查询参数、绝对 URL、`..` 或额外模板变量。
- `pollPath` 必须且只能有一个 `{taskId}`。返回 ID 只允许 1–200 个字母、数字、下划线或连字符。
- JSON 字段路径只支持 `data.output.url` 这样的对象点路径，不支持 `data[0]`、数组取值、JSONPath 运算或表达式。
- 提交请求体固定，当前没有自定义 header、字段重命名、签名、回调、取消端点或结果数组适配。
- 只支持图片任务；文本模型请另建 OpenAI 兼容或 Gemini 渠道。
- 此协议没有统一模型列表探测接口，“测试连接”会说明需要真实任务验证，不会为了测试而自动提交付费生成。
- 上游任务 ID 持久化在本地任务中，并可在任务详情看到；保存的渠道 / 凭据快照用于后续查询。只有保存了有效 ID 的 `async-json` 图片任务可以恢复查询，其他协议和未取得 ID 的不确定提交仍需人工核对。

若服务商合同超出这些边界，应新增可测试适配器，不能把“支持异步 JSON”解释为已经兼容所有中转接口。

### 异步任务恢复

已提交的异步图片发生轮询、下载中断或服务重启后，任务进入 `reconciling`。恢复只使用保存的原上游 ID 调用 GET 状态查询与 GET 结果下载，不再次调用生成 POST。

- 首次提交回合之外，最多额外执行 **3 个恢复回合**。恢复次数和截止时间写入数据库，重启不会重置限额。
- 失败后安排下一回合时，等待时间依次为 **5 / 15 / 45 秒**。服务启动认领中断任务时，若没有已保存的等待时间，可以直接开始合格的恢复回合；这些间隔不是固定的“服务重启延迟”。
- 收到并保存上游 ID 时设置 **15 分钟**恢复截止时间；兼容已有 ID 但缺少截止时间的旧记录时，以任务创建时间加 15 分钟计算。每回合同时受渠道超时和剩余恢复窗口约束。
- 只有状态、协议、图片类型、ID、次数和截止时间均符合条件，且未被停止核对的任务可恢复。没有 ID、窗口已过、次数用尽或本地结果清理失败，都不会再请求供应商。
- 每回合仍最多 60 次状态查询；恢复失败后的下一回合会计入上述 3 次限额。达到限额保留 `reconciling`，由用户去供应商后台核对结果与费用。
- 任务面板的“停止核对”使用现有取消接口，停止本地等待及未来自动查询。供应商可能继续生成并计费，此按钮不调用远程取消接口。

正常结果回填仍保存原 task / inputSnapshot，恢复成功不会为同一任务主动创建新生成请求。当前单进程执行器有发布与取消互斥及清理测试，但数据库、文件写入和供应商之间没有分布式事务，不能据此承诺端到端 exactly-once。

## 计费、取消与需要核对

真实生成由选定供应商计费。当前织作记录任务使用情况，`cost` 为 `null`、`costStatus` 为 `not_reported`；没有价格估算、充值、余额扣减或自动退款。每日任务上限是共享空间请求次数上限，不是财务额度。

本地提交使用项目内幂等键：相同键返回原任务，避免浏览器重复提交创建两项任务。当前没有向所有供应商传递统一幂等键，也不能保证供应商仅计费一次。

| 情况 | 当前行为 | 用户处理 |
| --- | --- | --- |
| 排队时取消 | 任务取消，不启动该任务 | 可重新编辑后创建新任务 |
| 请求已发送后取消 / 停止核对 | 停止本地等待及后续自动查询；供应商可能继续处理 | 查看供应商记录，取消不等于退款 |
| 付费 POST 网络中断、5xx、重定向或无法解析 JSON | 不自动重发，可能进入 `reconciling` | 核对供应商任务和费用后再决定新建任务 |
| 异步已提交但轮询 / 下载中断，有已保存 ID | `reconciling`，在 3 回合 / 15 分钟限额内自动 GET 原任务 | 可停止核对；到达限额后从供应商核对结果与费用 |
| 提交结果不确定，未保存上游 ID | 保留 `reconciling`，不发起恢复请求 | 到供应商后台核对，不能仅凭本地超时再次生成 |
| 服务重启时原任务为 running | 启动时改为 `reconciling`；合格的异步任务继续有界 GET 查询 | 其他任务人工核对，不自动再次调用生成 POST |
| 明确 401 / 403 / 404 / 429 或供应商失败状态 | 返回可读错误，不自动重发 | 检查地址、密钥、权限、模型及额度 |

`failed` 也不是供应商已退款的证明：模型返回的文案结构、图片能力或审核状态不满足要求时可能仍已消费额度。只有供应商账单或其明确合同可以确定收费。

## 媒体与响应边界

供应商图片结果和参考图上限为 20 MB，支持 PNG / JPEG / WebP；响应 JSON 上限通常 30 MB，文案 / 模型列表 / 轮询更小。结果经过图片头检查，写入素材时继续用 Sharp 完整解码、像素数和格式校验。

用户直接上传另有 24 MB 输入限制及 3200 万像素限制，支持静态 AVIF，之后会归一化 PNG。上传成功的高分辨率素材在用作 AI 参考图时仍可能超过供应商适配器的 20 MB 上限，需先缩小；不要把上传上限当作所有模型输入上限。

## 验证记录要求

先运行 `npm test` 检查 `providers.test.ts` 合同测试，再用实际有权访问的渠道完成一次文案、一次生图和一次参考图编辑。异步协议独立验证提交 / 状态字段和结果 URL。记录服务商、协议、模型、日期、成功输出与费用核对状态，不记录密钥。

模拟网络测试证明请求构造、解析、限制及错误行为；真实外部可用性、地区可达性、生成质量、价格和平台发布合规需要另外验证。

当前合同测试包含：先持久化 ID 再首次 GET、持久化失败不查询 / 不重提、恢复只 GET、跨数据库重开恢复、恢复次数 / 截止、停止核对和停止后晚到的 ID。执行记录见 `TASKS.md`。尚未配置真实供应商，因此本页不列出“已实测可用”的外部平台名单。
