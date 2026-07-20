# 运维与恢复

[English](operations.md)

## 日常健康检查

```bash
docker compose ps
curl --fail http://127.0.0.1:8080/healthz
curl --fail http://127.0.0.1:8080/health/ready
```

存活检查只表示进程还在运行；就绪检查要求 PostgreSQL、Redis 和 ClickHouse 同时正常。即使外部 LiteLLM 仍能处理模型请求，只要就绪检查失败，就应该按服务故障处理。

故障期间重点查看这些页面：

- **服务连接**：心跳时间和 Connector 待上传数量；
- **操作记录**：最近配置变化；
- **模型花费**和 **AIU 分析**：未定价、未计算和未识别覆盖缺口；
- **发布中心**：每个 Connector 已确认的精确运行配置。

## 日志

```bash
docker compose logs --since 30m api worker scheduler web caddy
docker compose logs --since 30m postgres redis clickhouse
```

日志中不应出现提示词、模型回复、密钥或原始用户身份。完整日志只能保存在受限运维系统，并设置明确保留时间。

## 备份

在同一个运维时间窗口备份所有权威和统计存储：

```bash
./scripts/backup-postgres.sh --output /secure/backups
./scripts/operations/backup-clickhouse.sh --output /secure/backups
./scripts/operations/backup-redis.sh --output /secure/backups
```

生成的清单和校验值要与备份一起保存。备份存储应加密，并定期在隔离项目中恢复验证。没有实际恢复过的备份不能算已验证备份。

LiteLLM Connector spool 是本地持久传输状态。只在 Connector 停止时备份，或者使用 SQLite 安全备份命令：

```bash
python scripts/connector-spool-admin.py backup \
  --spool /var/lib/tokenpilot/litellm-spool.sqlite3 \
  --output /secure/backups/litellm-spool.sqlite3
```

## 恢复演练

不要恢复到正在运行的项目。创建一个新的隔离 Compose 项目和空卷，使用文档脚本恢复三个存储，然后验证：

1. 所有服务都变成就绪；
2. PostgreSQL 配置和额度指纹一致；
3. ClickHouse 行身份和聚合总量完全一致；
4. Redis 没有外部租约或遗留暂停标记；
5. 数据核对没有无法解释的差异；
6. 删除隔离项目不会触碰正在运行的项目。

## 依赖故障

### PostgreSQL 不可用

配置写入、计算权威、额度决定和就绪检查都会失败。不要发布策略，也不要手工写两份数据。恢复 PostgreSQL，检查数据库结构和所有权，然后让持久队列继续处理。

### Redis 不可用

队列和额度预留协调停止，就绪检查失败。先恢复 Redis 再重启 Worker，并确认租约和预留只收敛一次。

### ClickHouse 不可用

统计页面返回不可用，Worker 会把待投影工作保留在 PostgreSQL Outbox。恢复 ClickHouse，验证当前结构，恢复 sink，并确认积压降到零。统计不会改读 PostgreSQL。

## 全新重建 ClickHouse

受保护的重建工具只能用于已经明确声明所有权的隔离数据库。它会暂停 sink，删除冲突的隔离结构，创建当前结构，重放 PostgreSQL Outbox 中保留的事件，逐项核对投影身份和聚合结果，验证通过后才恢复。任何失败都会保持暂停，等待检查。

## 常见告警

| 告警                 | 首先检查                                   |
| -------------------- | ------------------------------------------ |
| Connector 心跳过期   | LiteLLM 进程、密钥状态、网络、spool 完整性 |
| Connector 积压增长   | API 就绪、spool 容量、接入错误             |
| 服务商用量未定价     | 模型标签识别和缺少的用量类型价格           |
| AIU 未计算           | 已发布 AIU 单价和继承覆盖                  |
| ClickHouse sink 延迟 | ClickHouse 就绪、Outbox 租约、暂停所有者   |
| 额度预留过期突增     | 客户端取消路径和请求超时                   |
| 配置确认延迟         | Connector 实例和精确发布修订               |
| 数据核对差异         | 修复前先导出已脱敏差异                     |

## 密钥轮换

停用旧服务密钥之前，先创建新密钥。更新客户端并确认新密钥已经使用，再停用旧密钥。签名密钥轮换期间最多保留一个上一个密钥；所有客户端刷新并超过最大时钟误差窗口后删除旧密钥。

## 安全停止

```bash
docker compose down
```

这个命令会保留数据卷。只有确认项目属于可删除开发环境时才使用 `--volumes`。删除前记录项目名和数据卷列表。
