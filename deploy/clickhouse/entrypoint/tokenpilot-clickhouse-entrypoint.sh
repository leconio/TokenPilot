#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -z "${CLICKHOUSE_PASSWORD:-}" ]]; then
  printf 'CLICKHOUSE_PASSWORD is required for bootstrap\n' >&2
  exit 1
fi

# The official image needs the clear bootstrap password for its temporary local
# client. Give the server only a SHA-256 value so its persistent preprocessed
# configuration never stores that clear password.
password_digest="$(printf '%s' "$CLICKHOUSE_PASSWORD" | sha256sum)"
export AI_CONTROL_CLICKHOUSE_BOOTSTRAP_PASSWORD_SHA256_HEX="${password_digest%% *}"
unset password_digest

exec /entrypoint.sh "$@"
