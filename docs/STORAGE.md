# 素材存储适配

`apps/server/src/storage.ts` 提供统一的 `BlobStorage`：`put(key, Buffer, contentType)`、`get(key)`、`remove(key)`、只读的 `identity`，以及可选的 `close()`。`createStorage(dataDir)` 默认选择本地磁盘；传入 `S3StorageConfig` 后选择官方 `@aws-sdk/client-s3` 客户端。

`Media` 已通过适配层完成素材写入、原图/缩略图读取、海报渲染和删除；HTTP 图片接口、项目备份与恢复均通过 `Media` 读取数据。S3 模式不需要本地 `assets` 目录，数据库和服务器加密密钥仍按各自配置持久化。

## 配置合同

S3 配置来自服务器管理员，不能作为普通用户可编辑的模型 Base URL 或任意 URL 下载入口。HTTP 不被接受，包括 localhost；本地 S3 测试服务需要配置受信任的 HTTPS 证书。

启动入口通过 `STORAGE_BACKEND=s3` 启用 S3，并读取 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`。可选 `S3_PREFIX` 与 `S3_FORCE_PATH_STYLE=false` 分别覆盖前缀和寻址方式。未配置后端时继续使用本地磁盘；不得将真实凭据提交到版本库。

| 字段                              | 规则                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `endpoint`                        | HTTPS S3 API endpoint，不含用户名、密码、query、fragment、空白或反斜杠                  |
| `region`                          | 服务商要求的签名区域，例如 `us-east-1` 或支持服务中的 `auto`                            |
| `bucket`                          | 已存在的私有 bucket，使用标准小写 S3 名称                                               |
| `accessKeyId` / `secretAccessKey` | 管理员注入的凭据，不入库、不返回网页、不记录日志                                        |
| `forcePathStyle`                  | 默认 `true`；可按供应商要求设置 `false`                                                 |
| `prefix`                          | 默认 `zhizuo/assets`，可使用 `deploy-one/assets`，不能为空、不能含 `.`、`..` 或绝对路径 |

不同部署应设置不同 prefix 和不同的最小权限凭据。prefix 是部署级名称空间，不构成用户权限系统；每次读取、生成和导出仍须先由业务 API 校验素材属于请求用户可访问的项目。适配层只接收已校验的素材 key。

S3 请求只使用 `PutObject`、`GetObject`、`DeleteObject`，不列举 bucket，不执行批量删除，不设置公开 ACL。对象写入时保存明确的 MIME、长度以及 `Cache-Control: private, no-store`。限制 IAM 资源到该部署的 `prefix/*`，开启 bucket 的公开访问阻止，并根据部署策略启用服务端加密和版本控制。

## 文件、体积与错误

- key 必须是规范小写 UUID（版本 1–8、RFC variant），后缀只能为 `.png` 或 `.thumb.webp`。PNG 配 `image/png`，缩略图配 `image/webp`。
- 本地路径保持 `dataDir/assets/<uuid>.png` 和 `<uuid>.thumb.webp`，与既有数据兼容。写入采用同目录随机临时文件、`0600` 权限、文件同步后原子 `rename`。
- 本地读取、覆盖和删除拒绝符号链接、非普通文件和硬链接；目录检查结合真实路径及 inode，叶节点读取使用 `O_NOFOLLOW`。部署必须把数据目录的写权限限制为服务进程。适配层不能保护服务器被同一 OS 账户主动修改路径的环境；此类账户本身已经具有访问应用数据的权限。
- 两种后端均将单个对象限制为 **40 MiB**，与已经归一化的素材最大体积一致。S3 下载先检查声明长度，再逐块计算实际长度；超限立即停止并关闭流，不先把未知大小响应全部读入内存。存在 `Content-Length` 时还检查是否截断。
- `StorageError.code` 为 `INVALID_KEY`、`INVALID_CONTENT_TYPE`、`TOO_LARGE`、`NOT_FOUND`、`UNSAFE_PATH`、`CONFIG_ERROR` 或 `IO_ERROR`。错误文字不回显 SDK 原始异常、请求 URL、凭据、bucket 名或对象响应内容，也不保留原始 `cause`。
- 删除缺失对象是幂等操作；无权限、存储桶不存在等故障会报错。业务层只有确认对应文件删除成功后才能最终清理关联记录，清理失败应保留后续重试所需的标识。
- S3 使用 SDK 的签名与 HTTPS 校验，最多两次 SDK 请求尝试，连接超时 5 秒、socket 超时 30 秒、单请求超时 60 秒。服务关闭时调用 `storage.close?.()` 释放 SDK 连接。

## 接入与迁移

调用方负责图片解析、格式归一化、像素限制、项目授权、数据库记录和业务事务。此层处理已经归一化的二进制，不把上传内容仅凭扩展名认定为安全图片。

切换存储不会自动搬迁文件。现有部署从本地迁往 S3 时：先暂停写入、备份数据库与原文件；按数据库中的素材 ID 复制原图和缩略图至指定 prefix；逐个核对长度及 SHA-256；切换配置；验证读取、导出、删除，再保留旧副本至回滚窗口结束。反向迁移采用同样流程。不得只修改 endpoint 就认定旧项目已经完成迁移，也不得混用来自其他部署的 bucket 前缀。

本阶段不提供公开下载 URL 或预签名上传。后续直传需单独的暂存 key、短期凭据、声明与实际体积限制、图片验证与归一化、授权确认和未完成上传清理，再把已验证内容转存到正式 key，不能让浏览器直接覆盖正式素材。

## 上传日志与故障恢复

素材上传在首次写入对象前，先把 `id`、`projectId`、`storageIdentity`、`createdAt` 持久化到数据库的 `pending_assets` scope。此 scope 复用现有 documents 表，不改变已保存项目格式，也不对前端或项目备份输出。

写入原图、缩略图以及成功的 assets 元数据后，服务清理 pending 记录。清理记录失败不影响已经成功的素材；之后的恢复过程只删除该 pending 记录。若上传失败并且即时对象清理也失败，pending 记录会保留，供之后恢复。若 assets 写入返回错误，但数据库确认该记录已成功提交，则返回已提交的素材；若数据库连确认查询也无法完成，则保留对象与 pending 记录，不猜测提交结果后删除数据。

`Media.reconcilePending()` 返回 `{ cleaned, completed, deferred, failed }`：

- `cleaned`：未找到已完成的 assets 记录，成功删除遗留原图和缩略图后删除 pending。
- `completed`：找到已完成的 assets 记录，只清理 pending，保留用户素材。
- `deferred`：当前实例正在上传，或 pending 的存储标识与当前后端不匹配；保持原记录与对象。
- `failed`：数据库检查或对象清理失败；保持可重试记录，不回显底层错误。

存储标识由本地绝对目录，或 S3 endpoint + bucket + prefix 构成，不含 access key、secret key。轮换密钥不会改变标识，切换后端、目录、endpoint、bucket 或 prefix 则不自动清理旧位置。存储迁移前应在旧配置下完成 pending 清理；暂时不可访问的旧存储应保留 pending，并由管理员在恢复旧存储或完成对象迁移核对后处理。不要为了消除待处理计数直接删除这些记录。

调用方应在服务开始接收上传前执行一次恢复，再定时调用（例如每 60 秒）。恢复方法合并重叠调用，并跳过该 `Media` 实例尚未结束的上传。停止服务时先清理调度器、等待正在进行的恢复与上传，再释放存储客户端和数据库。数据库整体不可用时该方法会 reject，调用方需处理并安排下轮恢复；单条失败会计入 `failed`。

本实现适用于当前单 API 实例部署。跨进程同时上传与恢复需要分布式租约；进程内的 activeUploads 集合不能保护另一台服务器上的在途上传。既有完成素材删除失败时保留 assets 元数据，调用方重试即可；本次上传日志不替代该删除流程。

## 已覆盖的验证与缺口

`apps/server/tests/storage.test.ts` 使用真实临时磁盘目录及注入的 S3 `send` 函数，覆盖两种后端的读写删、原子覆盖、规范 key、MIME、40 MiB 边界、文件与目录链接拒绝、前缀隔离、下载截断、错误脱敏、流超限停止和工厂选择。测试不需要真实密钥，不访问公网 bucket。

`apps/server/tests/media-storage.test.ts` 使用真实 Sharp、字体渲染和磁盘 PGlite，配合 LocalStorage 与注入传输的 S3Storage，执行 15 项集成验证：

- 具有 EXIF 方向的 JPEG 上传归一化为旋转后的 PNG，并持久化独立 WebP 缩略图；两后端均验证元数据、尺寸、MIME、记录和读取。
- 中文海报实际渲染，以及 Local → S3、S3 → Local 的自含备份与恢复；校验恢复后的资产、版本和画布引用重映射，且重新渲染得到相同图像。
- S3 路径中断言本地 `assets` 目录不存在，验证原图、缩略图、渲染和备份不会意外退回本地文件读取。
- 图片写入失败（远端写入前或写入成功但响应丢失）及数据库提交失败时清理两类对象；已经提交但回执失败时，确认记录后返回成功素材。
- 已存在素材删除失败时保留数据库记录，故障解除后重试完成删除；导入第二张素材失败时清理此前导入的素材与新项目，原项目仍保留。
- Fastify 实际图片和缩略图路由调用 `Media.bytes`/`Media.thumbnail`，并返回可解析的 PNG/WebP 数据。
- 上传与清理同时失败后重建 `Media` 可继续恢复；pending 删除失败与数据库提交结果未知时不误删已完成资产；不同存储位置保留旧 pending，密钥轮换保持标识稳定。
- 正在上传的对象不会被同实例的清理任务删除，重叠清理合并为一次执行；上传意图无法持久化时不发出任何对象 PUT。

定向运行：`npx tsx --test apps/server/tests/storage.test.ts apps/server/tests/media-storage.test.ts`。当前适配单测 16 项、媒体集成测试 15 项，共 31 项通过；类型检查通过。

这些测试验证适配合同，不证明任何具体供应商已完成接入。发布前仍需用目标服务执行真实上传、读取、缩略图、项目备份与海报导出、删除测试，并记录 endpoint 类型、SDK 版本、path-style 设置、权限策略和故障恢复结果。未完成真实服务测试时，应保留这项验收缺口。
