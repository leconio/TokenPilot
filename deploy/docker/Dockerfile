ARG NODE_IMAGE=node:24.18.0-alpine3.24
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.28

FROM ${UV_IMAGE} AS uv-bin

FROM ${NODE_IMAGE} AS toolchain

ARG PNPM_VERSION=11.13.0
ARG TURBO_VERSION=2.10.5
ENV COREPACK_HOME=/corepack
ENV NODE_USE_ENV_PROXY=1
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}/bin:${PNPM_HOME}:${PATH}
WORKDIR /workspace

RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates openssl \
    && corepack enable \
    && corepack install --global pnpm@${PNPM_VERSION} \
    && pnpm add --global turbo@${TURBO_VERSION} \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

FROM toolchain AS pruner

ARG APP
COPY . .
RUN test -n "${APP}" \
    && case "${APP}" in api|migrate|scheduler|web|worker) ;; *) exit 64 ;; esac \
    && turbo prune "@tokenpilot/${APP}" --docker --out-dir=/workspace/out \
    && if [ "${APP}" = "migrate" ]; then \
         mkdir -p out/full/packages/db \
         && cp -R packages/db/prisma out/full/packages/db/prisma; \
       fi

FROM toolchain AS build

ARG APP
COPY --from=pruner /workspace/out/json/ ./
RUN --mount=type=cache,id=tokenpilot-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --prod=false --frozen-lockfile
COPY --from=pruner /workspace/out/full/ ./
COPY --from=pruner /workspace/tsconfig.json ./tsconfig.json
COPY --from=pruner /workspace/scripts/release/ ./scripts/release/
RUN if [ "${APP}" != "migrate" ]; then \
      turbo run build --filter="@tokenpilot/${APP}..."; \
    fi
RUN mkdir -p /workspace/apps/web/.next/standalone \
             /workspace/apps/web/.next/static \
             /workspace/apps/web/public \
             /workspace/apps/migrate \
             /workspace/packages/db/prisma \
    && if [ ! -f /workspace/apps/migrate/prisma.config.ts ]; then \
         : > /workspace/apps/migrate/prisma.config.ts; \
       fi
RUN mkdir -p /compiled \
    && if [ "${APP}" = "api" ] || [ "${APP}" = "scheduler" ] || [ "${APP}" = "worker" ]; then \
         find apps packages -type d -name dist -prune | while IFS= read -r directory; do \
           mkdir -p "/compiled/$(dirname "${directory}")"; \
           cp -R "${directory}" "/compiled/${directory}"; \
         done; \
       fi \
    && if [ "${APP}" = "worker" ]; then \
         test -n "$(find packages/clickhouse/migrations -maxdepth 1 -type f -name '*.sql' -print -quit)" \
         && mkdir -p /compiled/packages/clickhouse \
         && cp -R packages/clickhouse/migrations /compiled/packages/clickhouse/migrations; \
       fi

FROM toolchain AS production-dependencies

ARG APP
ENV NODE_ENV=production
COPY --from=pruner /workspace/out/json/ ./
RUN if [ "${APP}" != "web" ]; then \
      pnpm install --prod --no-optional --frozen-lockfile; \
    fi

FROM production-dependencies AS release

ARG APP
RUN mkdir -p /release
COPY --from=build /compiled/ /compiled/
COPY --from=build /workspace/apps/web/.next/standalone/ /web-standalone/
COPY --from=build /workspace/apps/web/.next/static/ /web-static/
COPY --from=build /workspace/apps/web/public/ /web-public/
COPY --from=build /workspace/apps/migrate/prisma.config.ts /migrate/prisma.config.ts
COPY --from=build /workspace/packages/db/prisma/ /migrate/prisma/
COPY --from=build /workspace/scripts/release/ /release/scripts/release/
RUN if [ "${APP}" = "web" ]; then \
      cp -R /web-standalone/. /release/ \
      && mkdir -p /release/apps/web/.next /release/apps/web/public \
      && cp -R /web-static/. /release/apps/web/.next/static/ \
      && cp -R /web-public/. /release/apps/web/public/; \
    else \
      cp -R /workspace/. /release/ \
      && if [ "${APP}" = "migrate" ]; then \
           cp /migrate/prisma.config.ts /release/apps/migrate/prisma.config.ts \
           && mkdir -p /release/packages/db \
           && cp -R /migrate/prisma /release/packages/db/prisma; \
         else \
           cp -R /compiled/. /release/; \
         fi \
      && rm -f /release/pnpm-lock.yaml /release/pnpm-workspace.yaml; \
    fi

FROM toolchain AS tooling

ARG APP
ENV APP=${APP}
ENV HOME=/tmp
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
ENV XDG_CACHE_HOME=/tmp/.cache
ENV PATH=/workspace/connectors/litellm/.venv/bin:${PATH}
COPY --from=uv-bin /uv /uvx /usr/local/bin/
RUN test -n "${APP}" \
    && case "${APP}" in api|migrate|scheduler|web|worker) ;; *) exit 64 ;; esac
RUN apk add --no-cache bash postgresql16-client \
    && bash --version | head -n 1 \
    && uv --version | grep -E '^uv 0\.11\.28( |$)' \
    && psql --version | grep -E '^psql \(PostgreSQL\) 16\.' \
    && pg_dump --version | grep -E '^pg_dump \(PostgreSQL\) 16\.' \
    && pg_restore --version | grep -E '^pg_restore \(PostgreSQL\) 16\.'
COPY connectors/litellm/pyproject.toml \
     connectors/litellm/uv.lock \
     connectors/litellm/README.md \
     ./connectors/litellm/
COPY connectors/litellm/src/ ./connectors/litellm/src/
RUN --mount=type=cache,id=tokenpilot-uv,target=/root/.cache/uv,sharing=locked \
    apk add --no-cache --virtual .connector-build-deps build-base cargo \
    && UV_CACHE_DIR=/root/.cache/uv uv python install 3.12 \
    && UV_CACHE_DIR=/root/.cache/uv uv sync \
         --project connectors/litellm --locked --no-dev --python 3.12 \
    && apk del .connector-build-deps \
    && rm -rf /tmp/.cache/puccinialin \
    && test "$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" = "3.12" \
    && uv run --project connectors/litellm --offline --no-sync python -c \
         "import ai_control_litellm, litellm" \
    && rm -rf /tmp/.cargo
COPY . .
RUN --mount=type=cache,id=tokenpilot-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --prod=false --frozen-lockfile
RUN turbo run build \
      --filter="@tokenpilot/api..." \
      --filter="@tokenpilot/worker..." \
      --filter="@tokenpilot/scheduler..."
RUN node --input-type=module -e \
      'const [database, clickhouse] = await Promise.all([import("@tokenpilot/db"), import("@tokenpilot/clickhouse")]); if (typeof database.createPrismaClient !== "function" || typeof clickhouse.createClickHouseClient !== "function") throw new TypeError("release tooling runtime packages are incomplete");'
RUN if [ "${APP}" = "migrate" ]; then \
      test -d packages/db/prisma/schema \
      && test -n "$(find packages/db/prisma/schema -maxdepth 1 -type f -name '*.prisma' -print -quit)"; \
    else \
      turbo run build --filter="@tokenpilot/${APP}..."; \
    fi
RUN mkdir -p /var/lib/tokenpilot/exports \
    && chown -R node:node /var/lib/tokenpilot
COPY --chown=root:root deploy/docker/start.sh /usr/local/bin/tokenpilot-start
RUN chmod 0555 /usr/local/bin/tokenpilot-start

USER 1000:1000
ENTRYPOINT ["/usr/local/bin/tokenpilot-start"]

FROM ${NODE_IMAGE} AS runtime

ARG APP
ARG BUILD_DATE=unknown
ARG CONTROL_PLANE_VERSION=0.2.0
ARG VCS_REF=unknown
ENV APP=${APP}
ENV HOME=/tmp
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV XDG_CACHE_HOME=/tmp/.cache
WORKDIR /workspace

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.description="TokenPilot ${APP}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/leconio/TokenPilot" \
      org.opencontainers.image.title="TokenPilot ${APP}" \
      org.opencontainers.image.version="${CONTROL_PLANE_VERSION}"

RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates openssl \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /opt/yarn-* \
    && rm -f /usr/local/bin/npm \
             /usr/local/bin/npx \
             /usr/local/bin/yarn \
             /usr/local/bin/yarnpkg \
             /usr/local/bin/corepack \
    && mkdir -p /var/lib/tokenpilot/exports \
    && chown -R node:node /var/lib/tokenpilot
COPY --from=release --chown=node:node /release/ /workspace/
COPY --chown=root:root deploy/docker/start.sh /usr/local/bin/tokenpilot-start
RUN chmod 0555 /usr/local/bin/tokenpilot-start

USER 1000:1000
ENTRYPOINT ["/usr/local/bin/tokenpilot-start"]
