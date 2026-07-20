# 开发与架构

[English](development.md)

## 仓库目录

- `apps/api`：HTTP API、身份验证、配置、统计和运行快照。
- `apps/worker`：持久用量处理、成本、AI Unit、投影和数据核对。
- `apps/scheduler`：定期维护和核对任务。
- `apps/web`：使用 shadcn/ui、Radix、React Query 和 Playwright 的 Next.js 管理页面。
- `packages`：独立领域库、Contract、PostgreSQL 客户端和 ClickHouse 客户端。
- `connectors/litellm`：Python callback、脱敏、本地队列、发送和心跳。
- `sdks/node`、`sdks/python`：可信上下文、策略缓存、模型分流和额度工具。
- `deploy`：Compose 实现、镜像、入口、ClickHouse 初始化和监控。
- `scripts`：源码检查、备份、性能、发布和远程验收工具。

生成文件放在所属 package 内。构建结果、缓存、验收证据和本地运行状态均被忽略，不能提交。

## 数据流程

```text
LiteLLM callback
  → 本地 SQLite spool
  → API Registry 与 Inbox 事务
  → Worker 模型识别
  → 服务商成本与 AI Unit 计算
  → PostgreSQL 变动记录与 Outbox 事务
  → ClickHouse 投影
  → Web 统计
```

每个边界都有稳定幂等标识。Worker 租约使用 fencing token。重放保留原始权威顺序，因此旧决定不能覆盖更新的终态决定。

## 本地源码环境

```bash
corepack enable
corepack install --global pnpm@11.13.0
pnpm install --frozen-lockfile
uv sync --project connectors/litellm --locked --all-groups
uv sync --project sdks/python --locked --all-groups
```

只处理源码的工作站不需要容器运行时。数据库集成和完整部署验收在隔离 Linux 主机运行。

## 质量门禁

应当把独立门禁整批运行，先收集完整失败列表，再按共同原因统一修复：

```bash
pnpm check:structure
pnpm check:versions
pnpm check:contracts
pnpm check:docs
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @tokenpilot/web test:e2e
pnpm test:operations
pnpm test:release
```

`pnpm check:structure` 会检查正式目录和文件大小。Contract 由一份 TypeScript 权威生成，并与 Python、SDK、Connector、示例和 fixture 对比。

## 数据库测试

集成测试必须同时使用 PostgreSQL、Redis 和 ClickHouse，并使用全新空数据库及隔离 Redis 编号。不要把测试指向共享或生产服务。远程验收会创建唯一 Compose 项目，以只读方式检查受保护生产项目指纹，运行所有可执行阶段，记录 PASS/FAIL/BLOCKED，最后只删除带隔离标签的资源。

远程验收会绑定指定主机。运行前把 `ACCEPTANCE_HOST_ADDRESS` 设置为专用 Linux 主机上的地址。依赖下载需要代理时设置 `ACCEPTANCE_DEPENDENCY_PROXY`，站点特定的直连名单通过 `ACCEPTANCE_NO_PROXY` 提供。这些值只属于运维环境，不应提交到仓库。

## Web 约定

- 使用 `apps/web/components/ui` 中已有 shadcn/ui 组件。
- 表单保持精简；服务端可以安全推导的标识和默认值不让用户填写。
- 高级字段放在明确的“更多设置”中。
- 每个页面都要处理加载、空内容、无权限和依赖故障状态。
- 用户文案同时提供中文和英文。
- 普通错误文案不暴露数据库名称或内部事件术语。

## 新增 Contract 字段

1. 修改 `packages/contracts` 中的规范 schema。
2. 添加有效和无效 fixture。
3. 生成 JSON Schema 和 Python model。
4. 更新 Connector 与 SDK 解析。
5. 只有字段归属明确时，才增加持久化和 ClickHouse 投影。
6. 运行 `pnpm check:contracts` 和跨语言一致性测试。

## 安全边界

模型内容路径在 LiteLLM 结束。代码审查应拒绝任何可以携带提示词、模型回复、工具参数或服务商凭据的新字段。密钥不能进入测试证据。运行容器使用固定非 root 身份、只读根文件系统、移除 capability，并把数据库放在私有网络。
