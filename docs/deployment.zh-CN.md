# 部署指南

[English](deployment.md)

在安装了 Docker Compose 的 Linux 主机上，从仓库根目录运行 TokenPilot。只处理源码的 Mac 不需要容器环境。

## 必需服务

根目录 `compose.yaml` 会加载 `deploy/docker-compose.yml` 并启动：

- PostgreSQL：保存应用、配置、用户、计算结果、额度和审计；
- Redis：持久任务和短期协调；
- ClickHouse：所有统计和仪表盘查询；
- API、Worker、Scheduler、Web 和 Caddy 入口；
- 启动时运行并在完成后退出的 PostgreSQL 与 ClickHouse 迁移任务。

项目附带可选的 LiteLLM profile，但默认部署不会替用户托管模型服务，也不需要 Provider 密钥。连接现有 LiteLLM 请参阅[接入指南](integration.zh-CN.md)。

PostgreSQL、Redis 和 ClickHouse 缺一不可。默认不会向宿主机开放数据库端口。

## 准备 `.env`

```bash
git clone https://github.com/leconio/TokenPilot.git
cd tokenpilot
./scripts/init-env.sh
```

脚本会创建权限为 0600 的 `.env`，生成相互独立的随机密钥，并保留已有文件。请检查外部地址、时区、币种、入口监听、保留时间和 AIU 设置。应用和应用密钥在 Web 页面创建，不写入 `.env`。

脚本会检查文件权限。文件系统不能落实 0600 时，它会删除 `.env` 并停止。在 WSL 中，把部署目录放在发行版自己的 Linux 文件系统，例如 `~/tokenpilot`。只有启用 DrvFS metadata 且 `stat` 确认权限为 0600 时，才能使用 `/mnt/c` 或 `/mnt/e`。迁移发行版 VHDX 时，这套 Linux 文件系统也会一起移动。

如果镜像或依赖下载需要代理，只在部署主机环境或 `.env` 中配置：

```dotenv
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=127.0.0.1,localhost,api,web,worker,scheduler,postgres,redis,clickhouse,litellm
```

## 启动

`.env` 准备好后运行：

```bash
docker compose up -d --build --wait
```

`pnpm deploy` 会额外检查主机、`.env`、占位密钥、Docker Compose 和渲染结果，然后执行相同部署。它还会删除成功退出的一次性迁移容器。两种命令都可以重复运行。迁移完成后，应用服务才会进入健康状态。

默认打开 `http://127.0.0.1:8080`。首次配置页面会先检查所需数据连接，再要求创建管理员和第一个应用，并创建相互独立的用量密钥与运行密钥；原始密钥只显示一次。

## 网络暴露

默认 `CADDY_BIND_ADDRESS=127.0.0.1` 只监听回环地址。改成 `0.0.0.0` 前，请先配置 TLS、防火墙、可信代理和当前网络的访问控制。PostgreSQL、Redis 和 ClickHouse 应留在 Compose 私有网络中，不要开放 5432、6379、8123 或 9000 端口。
浏览器访问的公开地址是 HTTPS 时，应设置 `WEB_SESSION_COOKIE_SECURE=true`。只有可信开发网络里的纯 HTTP 直连部署才设置为 `false`。

## 使用已有网关

Caddy 只负责默认入口，不参与统计、额度或路由逻辑。已有 API 网关或反向代理时，使用覆盖文件启动：

```bash
docker compose --project-name tokenpilot \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.external-gateway.yml \
  up -d --build --wait
```

这个命令不启动 Caddy，并默认把 API 绑定到 `127.0.0.1:15001`、Web 绑定到 `127.0.0.1:15002`。可以在 `.env` 中修改 `EXTERNAL_GATEWAY_API_*` 和 `EXTERNAL_GATEWAY_WEB_*`，但不要把数据库端口交给网关。

网关应让 Web 和 API 使用同一个公开域名，并保留原始路径、Cookie、`Authorization`、`Host` 和转发协议：

| 请求路径                                                                                                       | 转发目标    |
| -------------------------------------------------------------------------------------------------------------- | ----------- |
| `/health/*`、`/openapi*`、`/web/*`                                                                             | API `15001` |
| 携带应用密钥的 `/applications*`、`/audit*`、`/connectors*`、`/dlq*`、`/metrics`、`/runtime*`、`/usage-events*` | API `15001` |
| 其他路径，包括页面和 `/api/control/*`                                                                          | Web `15002` |

`WEB_BASE_URL` 和 `API_BASE_URL` 都填写这个公开域名。若要临时重新启用项目内 Caddy，在命令中增加 `--profile bundled-ingress`；通常不需要这样做。
网关使用 HTTPS 时，还应设置 `WEB_SESSION_COOKIE_SECURE=true`。

## 开发阶段的数据结构

项目目前从空数据库开始，不支持旧结构。隔离开发或验收环境更换结构时，删除该环境带标签的卷后重新创建。验收不能删除或复用正式数据卷。

```bash
docker compose ps
docker compose logs --tail=200 api worker scheduler web clickhouse
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
```

任何必需数据服务或关键规则不可用时，readiness 都会失败。统计不会切换到另一种数据来源。

## 停止与删除

`docker compose down` 只停止服务并保留数据。只有明确命名的临时环境已经备份或确定可以丢弃时，才能删除卷：

```bash
docker compose down
# 仅限临时环境：
docker compose down --volumes --remove-orphans
```

备份、恢复、重建和故障处理前请阅读[运维指南](operations.zh-CN.md)。
