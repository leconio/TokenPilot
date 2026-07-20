# HTTP API 说明

[English](api.md)

TokenPilot 提供严格的 HTTP API，用于接收用量、管理应用、查询统计以及向可信运行程序下发配置。模型请求由 Node SDK、Python SDK 或 LiteLLM 直接发送给已配置的模型服务，TokenPilot 不提供模型生成接口。

## 身份验证与应用绑定

服务端客户端发送 `Authorization: Bearer <应用密钥>`。每个密钥只属于一个应用，只在创建时显示一次，服务端只保存哈希。建议按用途拆分权限：

- 接入：用量写入和 Connector 心跳；
- 运行：读取配置、回传应用结果、执行 AIU 预留；
- 管理：应用资源、统计、审计和运维操作。

API 从密钥确定 `application_id`，调用方不能在事件中选择或覆盖它。应用资源路径同时包含 `:applicationSlug`；URL 与密钥不匹配时会被拒绝。Web 管理页面使用登录 cookie，修改请求还需要 CSRF 校验。

## 用量接入

`POST /usage-events/batch` 接收严格且不含模型内容的事件批次。`user.user_id` 必填，推荐填写 `user.display_user`。有效事件会在密钥对应的应用中自动新增或更新用户；另一个应用中相同的 `user_id` 是完全独立的用户。

事件可以包含时间、请求与尝试标识、接入端和应用版本、调用连接、真实模型标识、虚拟模型、Token 与多模态用量、结果字段和类型化自定义字段。提示词、回复、消息、工具参数、cookie、认证头和服务商密钥会在持久接收前被拒绝或移除。

幂等范围是 `application_id + event_id`：

- 内容一致时返回 `duplicate`；
- 同一标识但内容不同时返回 `conflict`；
- 批次中一个项目无效，不会丢弃其他有效项目。

## 应用管理

下面的资源都绑定到 `/applications/:applicationSlug`：

| 功能       | 路径                                                                 |
| ---------- | -------------------------------------------------------------------- |
| 应用       | `GET/POST /applications`、`GET/PATCH /applications/:applicationSlug` |
| 调用连接   | `/connections`、`/connections/:id`、`/connections/:id/check`         |
| 模型       | `/models`、`/models/:id`、`/models/:id/cost`、`/models/:id/aiu`      |
| 虚拟模型   | `/virtual-models` 及候选模型、规则、排序和模拟接口                   |
| 类型化字段 | `/properties`                                                        |
| 用户       | `/users`、`/users/:id`、额度、重置和 AIU 记录                        |
| 用户组     | `/user-groups`、预览、计算、成员和固定快照批量操作                   |
| 配置发布   | `/runtime-configurations`、`/runtime-configurations/publish`         |
| 密钥       | `/service-api-keys`                                                  |
| 统计       | `/reports/*`、保存的报表和仪表盘卡片                                 |

后台新增用户只要求 `user_id`；`display_user`、标签和类型化属性都是可选项。`user_id` 创建后不能修改。拉闸、重置额度或执行用户组批量操作时，影响访问或额度的动作需要留下可审计原因。

## 搜索与报表

统计路径都属于当前应用：

- `/reports/overview`、`/reports/usage`、`/reports/provider-cost`、`/reports/aiu`；
- `/reports/cache`、`/reports/fallback`、`/reports/dimensions`、`/reports/pipeline-health`；
- `/reports/saved` 和 `/reports/dashboard` 用于复用分析条件。

查询支持 UTC 时间范围、时区、满足全部或任意条件、可选分组和有上限的分页。条件既可以使用内置字段，也可以使用当前应用已启用的类型化字段。统计只读取 ClickHouse，并返回水位和延迟。统计暂时不可用时会明确报错，不会改读 PostgreSQL 或伪造零值。

## 可信运行接口

| 方法和路径                                         | 用途                                     |
| -------------------------------------------------- | ---------------------------------------- |
| `GET /runtime/snapshot`                            | 使用 `ETag` 读取密钥所属应用的已发布配置 |
| `POST /runtime/configuration-acknowledgements`     | 回传已收到、已应用或已拒绝               |
| `POST /runtime/users/aiu/reservations`             | 调用前检查用户并预留 AIU                 |
| `POST /runtime/users/aiu/reservations/:id/settle`  | 成功后按实际 AIU 结算                    |
| `POST /runtime/users/aiu/reservations/:id/release` | 释放未使用的预留                         |

运行密钥决定应用身份。预留 token 是带签名的不透明值，服务端会校验持久化的应用、用户、操作、状态和过期时间。

## 健康与错误

| 路径                | 含义                                             |
| ------------------- | ------------------------------------------------ |
| `GET /health/live`  | 进程存活                                         |
| `GET /health/ready` | PostgreSQL、Redis、ClickHouse 和关键规则全部就绪 |
| `GET /metrics`      | Prometheus 运维指标                              |

请求对象默认拒绝未知字段；精确成本、数量和 AIU 使用十进制或整数字符串。错误不会回显密钥、提示词、模型回复或原始事件。字段级定义以运行实例的 OpenAPI 文档和 `packages/contracts` 为准。
