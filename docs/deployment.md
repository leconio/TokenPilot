# Deployment

[中文](deployment.zh-CN.md)

Run TokenPilot from the repository root on a Linux host with Docker Compose. A Mac used only for
source work does not need a container runtime.

## Required services

The root `compose.yaml` loads `deploy/docker-compose.yml` and starts:

- PostgreSQL for applications, configuration, users, ratings, quota, and audit;
- Redis for durable jobs and short-lived coordination;
- ClickHouse for every report and dashboard query;
- API, Worker, Scheduler, Web, and Caddy ingress;
- PostgreSQL and ClickHouse migration jobs that run at startup and then exit.

An optional LiteLLM profile is included, but the default deployment does not host your model
service or require provider keys. See the [integration guide](integration.md) to connect an existing
LiteLLM.

PostgreSQL, Redis, and ClickHouse are all mandatory. Database ports stay on private Compose
networks by default.

## Prepare `.env`

```bash
git clone https://github.com/leconio/TokenPilot.git
cd tokenpilot
./scripts/init-env.sh
```

The script creates `.env` with mode 0600, generates separate secrets, and does not overwrite an
existing file. Review the public URLs, timezone, currency, ingress binding, retention, and AIU
settings. Applications and application keys are created in the Web console, not in `.env`.

The script checks the file mode and removes `.env` if the filesystem cannot enforce 0600. On WSL,
keep the deployment under the distro's Linux filesystem, such as `~/tokenpilot`. Use `/mnt/c` or
`/mnt/e` only when DrvFS metadata is enabled and `stat` confirms mode 0600. Moving the distro VHDX
to another drive also moves this Linux filesystem.

If image or package downloads require a proxy, add it only to the deployment host environment or
`.env`:

```dotenv
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=127.0.0.1,localhost,api,web,worker,scheduler,postgres,redis,clickhouse,litellm
```

## Start

After `.env` is ready, run:

```bash
docker compose up -d --build --wait
```

`pnpm deploy` performs the same deployment with extra checks for the host, `.env`, placeholders,
Docker Compose, and the rendered configuration. It also removes successful one-time migration
containers. Both commands can be run again. Application services become healthy only after the
migrations finish.

Open `http://127.0.0.1:8080` unless `HTTP_PORT` or the bind address was changed. The first-run screen
checks required data connections, then asks for the administrator and first application. It creates
separate usage and runtime keys and displays their raw values once.

## Network exposure

The default `CADDY_BIND_ADDRESS=127.0.0.1` exposes only loopback. Before setting it to `0.0.0.0`, add
TLS, firewall rules, trusted-proxy settings, and access control for the network. Keep PostgreSQL,
Redis, and ClickHouse on private Compose networks. Do not publish ports 5432, 6379, 8123, or 9000.
Set `WEB_SESSION_COOKIE_SECURE=true` whenever the browser-facing origin is HTTPS. Set it to `false`
only for a direct HTTP deployment on a trusted development network.

## Use an existing gateway

Caddy owns only the default ingress; analytics, quota, and routing do not depend on it. If an API
gateway or reverse proxy already owns the public listener, start with the override:

```bash
docker compose --project-name tokenpilot \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.external-gateway.yml \
  up -d --build --wait
```

This leaves Caddy stopped and binds API to `127.0.0.1:15001` and Web to `127.0.0.1:15002` by
default. The `EXTERNAL_GATEWAY_API_*` and `EXTERNAL_GATEWAY_WEB_*` values in `.env` may change those
bindings. Do not publish a datastore through the gateway.

Keep Web and API on one public origin. Preserve paths, cookies, `Authorization`, `Host`, and the
forwarded protocol, and route as follows:

| Request path                                                                                                  | Upstream    |
| ------------------------------------------------------------------------------------------------------------- | ----------- |
| `/health/*`, `/openapi*`, `/web/*`                                                                            | API `15001` |
| Authenticated `/applications*`, `/audit*`, `/connectors*`, `/dlq*`, `/metrics`, `/runtime*`, `/usage-events*` | API `15001` |
| Everything else, including pages and `/api/control/*`                                                         | Web `15002` |

Set both `WEB_BASE_URL` and `API_BASE_URL` to that public origin. Adding `--profile bundled-ingress`
temporarily starts the bundled Caddy service, but an existing gateway normally does not need it.
An HTTPS gateway also requires `WEB_SESSION_COOKIE_SECURE=true`.

## Data and upgrades during development

The project currently starts from empty databases and does not support old schemas. When a schema
changes in an isolated development or test installation, remove that installation's labeled volumes
and start again. Do not remove or reuse production volumes for acceptance tests.

```bash
docker compose ps
docker compose logs --tail=200 api worker scheduler web clickhouse
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
```

Readiness fails if any required datastore or invariant is unavailable. Reports do not switch to a
different datastore.

## Stop and remove

`docker compose down` stops the service but preserves data. Removing volumes is appropriate only
for a named disposable installation whose data has been backed up or is intentionally discarded:

```bash
docker compose down
# Disposable environment only:
docker compose down --volumes --remove-orphans
```

See [operations](operations.md) before backup, restore, rebuild, or incident work.
