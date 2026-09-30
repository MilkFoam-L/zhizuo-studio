# 织作 ZhiZuo Studio

面向中文电商与内容创作者的 AI 内容工作台。把商品事实、素材、图文草稿和海报版本放在一张画布中，支持多服务商接入、模板排版和作品导出。

当前处于开发阶段，任务进度见 [docs/TASKS.md](docs/TASKS.md)，已执行的检查与明确缺口见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。平台尺寸是编辑预设，发布前需要核对平台最新规范。

## 本地启动

需要 Node.js 22.13+（推荐 24）。无需 Docker：默认使用磁盘持久化的 PGlite（PostgreSQL 引擎）。

```sh
npm ci
cp .env.example .env
npm run dev
```

打开 http://127.0.0.1:5173 。API 位于 http://127.0.0.1:4317 。本地模式只监听 loopback，数据和自动生成的加密密钥位于 `.data/`，不要提交或分享该目录。

配置真实模型：工作台「模型接入」添加服务商、HTTPS Base URL、API Key、文本模型和图片模型。支持 OpenAI 兼容、Gemini 原生、受限 JSON 异步协议。密钥由服务器 AES-GCM 加密存储；浏览器只读取 hasKey，不会再次得到密钥。真实生成由你配置的服务商计费。

未配置模型时，可以上传真实图片、编辑内容简报、制作模板海报、保存版本、导出 PNG 和备份项目。没有假 AI 结果。

## 运行与验证

```sh
npm run typecheck
npm test
npm run build
npm start
```

构建后 API 同时提供网页：http://127.0.0.1:4317 。运行目录必须是项目根目录，以便加载字体和静态产物。

## 数据与部署边界

- `DATABASE_URL` 可连接 PostgreSQL；未设置时使用 `.data/db`。
- 图片写入 `.data/assets`，当前支持单实例磁盘部署。备份需包含 `.data` 和加密密钥；界面可导出不含密钥的项目 ZIP。
- 私有部署设置 `HOST`、至少 16 字符的 `APP_PASSWORD`、`APP_ORIGIN`，并使用 HTTPS 反向代理。共享密码对应一个私有工作空间，尚不是多租户 SaaS。
- 任务记录持久化，进程内最多两个任务并行。服务中断时已开始的任务进入「需要核对」。已保存上游任务编号的异步 JSON 任务可在有限次数与时间内继续 GET 查询；其他协议不会自动重复提交可能收费的请求。
- 目前不承诺供应商请求的 exactly-once：网络超时可能发生在供应商已接收之后。请核对供应商任务/账单，再决定是否重试。
- 模型连接探测不调用收费生成接口；异步自定义协议只能通过真实任务验证。供应商兼容性以测试与实际接入记录为准。

## 来源与许可

[docs/REFERENCE_REVIEW.md](docs/REFERENCE_REVIEW.md) 记录开源研究和固定版本。当前业务代码独立实现；画布使用 MIT 的 React Flow，前端实际采用 shadcn/ui 与 Radix（组件许可见 `apps/web/src/components/ui/LICENSE.shadcn.md`），字体使用 SIL OFL 的 Noto Sans SC（许可见 `apps/server/fonts/OFL.txt`）。没有复制 CC BY-NC-SA 项目的商业受限代码。项目本身的发布许可证待所有者决定。

## 界面设计与检查

界面参考与访问边界见 [UI_REFERENCES.md](docs/UI_REFERENCES.md)，基于用户指定设计技能的改动与静态审阅见 [UI_POLISH_REVIEW.md](docs/UI_POLISH_REVIEW.md)。布局采用暖白与深绿的中文内容工作台，正文14–16px，窄屏重排和主要触控控件44px。视觉、键盘和真实浏览器验收状态以验证记录为准。
