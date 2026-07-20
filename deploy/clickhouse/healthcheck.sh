#!/usr/bin/env bash
set -Eeuo pipefail

client_config="$(mktemp)"
trap 'rm -f "$client_config"' EXIT
chmod 600 "$client_config"

cat >"$client_config" <<EOF
<clickhouse>
  <host>127.0.0.1</host>
  <port>9000</port>
  <user>default</user>
  <password>${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}</password>
</clickhouse>
EOF

clickhouse client --config-file "$client_config" --query 'SELECT 1' >/dev/null
