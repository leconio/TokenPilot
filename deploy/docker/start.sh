#!/bin/sh

set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

case "${APP:-}" in
  api | scheduler | worker)
    exec node "/workspace/apps/${APP}/dist/main.js"
    ;;
  migrate)
    cd /workspace/apps/migrate
    node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts
    set +e
    node node_modules/prisma/build/index.js migrate diff \
      --config prisma.config.ts \
      --exit-code \
      --from-migrations ../../packages/db/prisma/migrations \
      --to-config-datasource
    drift_status=$?
    set -e
    case "$drift_status" in
      0) exit 0 ;;
      2)
        echo "PostgreSQL schema differs from the current TokenPilot schema; recreate the development database." >&2
        exit 78
        ;;
      *)
        echo "PostgreSQL schema verification failed." >&2
        exit "$drift_status"
        ;;
    esac
    ;;
  web)
    exec node /workspace/apps/web/server.js
    ;;
  *)
    echo "Unsupported or missing APP: ${APP:-<unset>}" >&2
    exit 64
    ;;
esac
