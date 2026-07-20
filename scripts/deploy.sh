#!/usr/bin/env bash
set -euo pipefail

repository=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository"

if [[ "$(uname -s)" != Linux ]]; then
  printf 'TokenPilot containers may only be started on a Linux deployment host.\n' >&2
  exit 64
fi
if [[ ! -f .env ]]; then
  printf 'Missing .env. Run "pnpm ops:init", then review .env before deployment.\n' >&2
  exit 66
fi
if grep -Eq '=(replace-with-generated-secret|acp_replace_with_generated_)' .env; then
  printf '.env still contains placeholder secrets. Run "pnpm ops:init" or replace them.\n' >&2
  exit 65
fi
command -v docker >/dev/null 2>&1 || {
  printf 'Docker with Compose is required on the Linux deployment host.\n' >&2
  exit 69
}
docker compose version >/dev/null
docker compose config --quiet

show_deployment_failure() {
  status=$?
  trap - ERR
  printf 'TokenPilot deployment failed; current Compose state follows.\n' >&2
  docker compose ps --all >&2 || true
  docker compose logs --no-color --tail=200 \
    postgres redis clickhouse clickhouse-migrate migrate api worker scheduler web caddy >&2 || true
  exit "$status"
}

trap show_deployment_failure ERR
docker compose up --detach --build --wait --remove-orphans
# Successful migration jobs are deliberately one-shot. Remove their stopped
# containers so a steady deployment contains only long-running services.
docker compose rm --force migrate clickhouse-migrate >/dev/null
trap - ERR
printf 'TokenPilot is ready at http://127.0.0.1:%s\n' "${HTTP_PORT:-8080}"
