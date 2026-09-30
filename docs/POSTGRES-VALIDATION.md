# 真实 PostgreSQL 与独立 worker 验证

日期：2026-09-30（Asia/Shanghai）。隔离 PostgreSQL 18.4 的业务集成测试 **1/1 通过**，编译 API / worker 在外置模式启动烟雾通过。本轮同时通过 `npm run check`：typecheck、146/146 默认测试、build。真实数据库测试不包含在这146项中，供应商由 fixture 提供响应，没有真实收费请求、S3 桶或云生产部署。

## 环境与来源

本机 PATH 中没有 `postgres`、`initdb`、`pg_ctl`、`psql`。Docker CLI 存在，但 daemon 的 socket 不存在，因此没有启动或修改 Docker、系统服务或既有数据库。

使用隔离的 `work/pg-runtime/package.json`，从官方 `https://registry.npmjs.org` 安装固定版 `embedded-postgres@18.4.0-beta.17`。它仅用于本次验证，未加入根项目依赖。来源是 [leinelissen/embedded-postgres](https://github.com/leinelissen/embedded-postgres)，已阅读 npm README、仓库来源、包内 LICENSE 和实际生命周期脚本。包装代码为 MIT；上游 README 将打包的二进制归于 zonky 的 Apache-2.0 分发。二进制及随附第三方库仍应遵循各自许可，此临时目录不随项目交付。

安装命令先使用 `--ignore-scripts`，随后审查平台包的 `scripts/hydrate-symlinks.js` 与 `native/pg-symlinks.json`，确认仅在本包的 `native/lib` 恢复相对链接，再单独执行该脚本。

```sh
cd work/pg-runtime
npm install --ignore-scripts --registry=https://registry.npmjs.org --no-audit --no-fund
cd node_modules/@embedded-postgres/darwin-arm64
node scripts/hydrate-symlinks.js
```

此实例使用本地 macOS 平台包；SQL 实际报告版本为：

```text
PostgreSQL 18.4 on x86_64-apple-darwin24.6.0,
compiled by Apple clang version 17.0.0 (clang-1700.6.3.2), 64-bit
```

## 隔离方式与连接

- 数据目录由 `mkdtemp` 在 `work/pg-runtime/data-*` 下新建，未使用 `.data/` 或任何既有用户数据库。
- TCP 地址仅为 `127.0.0.1`；端口通过临时监听分配。初次连通性检查使用 `60043`，该实例随后退出；业务复验重新启动的实例使用 `50419`，两者不是同一个运行生命周期。
- `unix_socket_directories` 为空，不创建本地共享 socket。
- 采用随机 32 字节密码与 `scram-sha-256` 验证；未输出密码。
- 入口数据库名为 `zhizuo_validation`，仅供本次验证；业务测试另建随机命名的 `zhizuo_workers_*` 数据库，完成后删除自己创建的库。
- 环境文件 `work/pg-runtime/.env` 权限为 `0600`，包含 `DATABASE_URL`；运行目录为 `0700`。
- `work/` 已在 `.gitignore` 中，凭据、依赖、数据库和日志不进入 Git。

从项目根目录运行测试时直接让 Node 读取该环境文件，不需 shell `source`：

```sh
node --env-file=work/pg-runtime/.env --import tsx --test apps/server/tests/postgres.integration.ts
```

常规入口为 `npm run test:postgres`，需由环境提供 `POSTGRES_TEST_URL`。测试也接受专用环境文件中的 `DATABASE_URL`，但始终验证地址必须是 `127.0.0.1`、入口库必须为 `zhizuo_validation`；不接受远端或生产地址。该入口要求可创建临时数据库的测试角色，并会创建 / 删除自己的随机数据库，因此只用于独立空闲验证实例。

不要打印、提交、打包该环境文件。启动脚本每次创建新目录、端口和密码，不能复用本文历史端口或PID判断后续实例状态。

## 已验证证据

初次连通性检查中，`start.mjs` 启动实际 PostgreSQL 进程，建立连接并执行 SQL 后才写入 `ready.json` 和报告 `server_ready`。随后独立进程使用 `.env` 再次连接测试库，返回以下结果。它们是初次实例的历史记录，不代表 `60043` 仍在监听。

| 检查项 | 实际结果 |
| --- | --- |
| `SELECT current_database()` | `zhizuo_validation` |
| `SELECT version()` | PostgreSQL 18.4（完整信息见上） |
| `inet_server_addr()` / `inet_server_port()` | `127.0.0.1/32` / `60043` |
| `pg_settings.listen_addresses` | `127.0.0.1` |
| `pg_settings.unix_socket_directories` | 空字符串 |
| `lsof` 检查 PostgreSQL TCP listener | 仅 `127.0.0.1:60043` |
| 环境文件权限 | `0600` |

业务复验在重启后的 PostgreSQL 18.4 实例执行，证据为 `work/live-postgres-final.log`，对应 `apps/server/tests/postgres.integration.ts`。测试创建一个 API（关闭其内嵌 worker）、两个独立数据库访问器和两个实际子 worker 进程，检查：

| 检查项 | 实际断言与结果 |
| --- | --- |
| JSONB 参数与返回值 | 对象、嵌套属性与字符串值跨连接往返；数据库 `jsonb_typeof(body)` 为 `object`，没有双重JSON编码 |
| 多连接事务 | 两个连接并发执行24次行锁递增，最终为24；抛错事务回滚后另一连接仍读到24 |
| 并发额度 | 限额3，两个额度服务并发预占10次，恰好3次成功、7次拒绝；每项重复取消结算4次仍只释放一次，最终可用3 |
| 素材引用 / 清理竞争 | 一个连接保存引用，另一个清理无引用素材；引用成功则素材和对象保留，清理先成功则引用拒绝，无悬空版本 |
| 两个独立 worker | 3个新任务加1次重复请求形成3个任务；每项 fixture 只调用1次，保存3个版本和3个画布节点，额度消耗3 |
| 进程强杀与重启 | 提交 checkpoint 及 fixture 调用落库后 SIGKILL 对应 worker；租约过期后进入核对，替代 worker 启动后原请求调用数仍为1 |
| 未知结果与人工核对 | 强杀任务保留1次预占和1条待核对；填写依据确认消耗后总消耗为4、预占为0，没有触发供应商退款 |
| 公开任务字段 | API 响应不暴露 leaseToken 或 secret |
| 测试清理 | `finally` 停止子 worker、关闭 API / 数据库连接、删除随机测试库与临时素材目录 |

最终测试输出为 `tests 1 / pass 1 / fail 0 / skipped 0`。这个单项集成包含上述多项断言，不表示只运行了一个数据库操作。

另有 `work/compiled-worker-smoke.log` 记录已构建 `dist/server/index.js` 与 `dist/server/worker.js` 的实际启动：API health 报告 `storage=postgresql`、`workerMode=external-or-disabled`，worker保持等待任务。该烟雾没有向供应商提交任务，验证结束已关闭测试 API / worker 子进程；它证明编译入口与共享配置可用，不替代上述子 worker 的业务集成。

默认完整门禁见 `work/worker-quota-final-check.log`：typecheck 通过，146/146 tests，0失败 / 0跳过，前端与服务端双入口构建通过。PGlite 默认测试补充覆盖嵌套savepoint、任务 / 预占同时回滚、提交与发布失租阻断、跨进程取消逻辑、上传租约与清理、跨上海午夜结算、人工审计竞争和历史待核对分页。

## 已知验证边界

- 本次真实数据库拓扑为一个 API 与多个 worker，不是任意数量 API 实例的完整横向扩容验收；多 API 账号管理互斥、集中限流和完整任务事件 / 监控仍需补齐。
- worker 子进程注入供应商 fixture，真实 PostgreSQL 是实际运行的服务；没有真实模型凭据、供应商网络 / 计费或退款验证。任务次数核对不能被描述为实际钱款结算。
- 媒体竞争使用本地素材存储，没有连接真实 S3；没有验证云端私有桶权限、预签名直传、生命周期或跨区域行为。
- 强杀恢复证明没有自动重复提交该未知任务，不构成供应商 exactly-once 保证，也不是数据库备份恢复或整实例灾备演练。
- 没有生产部署、生产数据迁移或真实浏览器闭环。界面工具此前保存的本地访问权限拒绝尚未获得成功实测证据。

## 生命周期

临时脚本与状态均在 `work/pg-runtime/`：`start.mjs`、`stop.mjs`、`ready.json`、`runner.pid`、`server.pid`、`postgres.log`。`start.mjs` 默认保持运行，收到 `SIGTERM` 或 `SIGINT` 后给 PostgreSQL 发送快速有序关闭信号，保留临时目录用于复查。

```sh
node work/pg-runtime/start.mjs
# 在另一终端执行验证；验证完成后：
node work/pg-runtime/stop.mjs
```

初次连通性环境的 runner PID 为 `13976`、PostgreSQL PID 为 `14001`、端口为 `60043`；原代理执行会话结束后该实例已退出。主任务随后重新启动隔离环境进行业务复验，runner PID 为 `17852`、PostgreSQL PID 为 `17880`、端口为 `50419`。这些均为历史标识，本文不以它们承诺实例仍在线；停止前应核对 `ready.json` 和实时进程，避免操作已复用的PID。

业务测试拥有的随机数据库、素材目录和子 worker 已由测试清理，编译入口烟雾的 API / worker 子进程也已关闭。外层 PostgreSQL 临时实例的最终回收应另以 `stopped.json`、实时进程和监听端口退出为证；不需要改动系统服务。临时运行目录只用于本次证据复查，不随项目交付。

### 最终回收记录

主任务已向已核对的runner发送有序停止，`work/pg-runtime/stopped.json`记录`code=0`。随后实时检查PID17852/17880与50419监听均不存在，外层临时实例已正常回收。源文件与证据仍留在被Git忽略的work中，不属于交付包。
