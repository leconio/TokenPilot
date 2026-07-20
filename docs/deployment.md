# Deployment

[中文](deployment.zh-CN.md)

TokenPilot is deployed from the repository root on a Linux host with Docker Compose. A source-only
Mac workstation does not need and should not start a container runtime.

## Required services

The root `compose.yaml` includes the maintained implementation in `deploy/docker-compose.yml` and
starts only the documented stack:

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

The script creates a mode-0600 `.env`, generates independent secrets, and refuses to overwrite an
existing file. Review public URLs, timezone, currency, ingress binding, retention, and AIU behavior.
The file contains deployment settings only: applications and application keys are created in the
Web console after startup.

The script also verifies the resulting permission and removes the file if the filesystem cannot
enforce mode 0600. On WSL, keep the deployment directory in the distro's Linux filesystem, such as
`~/tokenpilot`. Do not place `.env` under `/mnt/c` or `/mnt/e` unless DrvFS metadata is enabled and
`stat` confirms mode 0600. Moving the distro VHDX to another drive moves this Linux filesystem too.

If image or package downloads require a proxy, add it only to the deployment host environment or
`.env`:

```dotenv
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=127.0.0.1,localhost,api,web,worker,scheduler,postgres,redis,clickhouse,litellm
```

## Start

The standard command is sufficient after `.env` is valid:

```bash
docker compose up -d --build --wait
```

`pnpm deploy` runs the same deployment after checking Linux, `.env`, placeholders, Docker Compose,
and the rendered configuration, then removes successful one-shot migration containers. Both
commands are repeatable. Migration jobs must finish successfully before application services become
healthy.

Open `http://127.0.0.1:8080` unless `HTTP_PORT` or the bind address was changed. The first-run screen
checks required data connections, then asks for the administrator and first application. It creates
separate usage and runtime keys and displays their raw values once.

## Network exposure

The default `CADDY_BIND_ADDRESS=127.0.0.1` exposes only loopback. Before setting it to `0.0.0.0`, add
TLS, firewall rules, reverse-proxy trust configuration, and an access policy appropriate to the
network. Do not publish PostgreSQL, Redis, or ClickHouse ports.
Never publish ports 5432, 6379, 8123, or 9000 on the host; keep every datastore on its private
Compose network.
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

This project targets fresh current databases. There is no old-schema compatibility path. For an
isolated development or acceptance installation, remove its labeled volumes when the schema is
intentionally replaced and start again. Never remove or reuse production volumes for acceptance.

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
