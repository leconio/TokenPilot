#!/usr/bin/env bash
set -euo pipefail

umask 077
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$repository_root/scripts/lib/operations.sh"

output_root=${BACKUP_ROOT:-./backups/redis}
host=${REDIS_HOST:-127.0.0.1}
port=${REDIS_PORT:-6379}
user=${REDIS_USER:-default}
tls=${REDIS_TLS:-false}

while (($# > 0)); do
  case "$1" in
    --output) output_root=$2; shift 2 ;;
    -h|--help) printf 'Usage: REDISCLI_AUTH=... %s [--output DIR]\n' "$0" >&2; exit 0 ;;
    *) exit 2 ;;
  esac
done

if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || ((port <= 0 || port > 65535)); then
  operations_die "invalid Redis port"
fi
operations_require_command redis-cli
operations_require_command redis-check-rdb
client=(redis-cli --no-auth-warning -h "$host" -p "$port" --user "$user")
[[ "$tls" == true ]] && client+=(--tls)

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
name=tokenpilot-redis-$timestamp
mkdir -p "$output_root"
chmod 700 "$output_root"
final_directory=$output_root/$name
temporary_directory=$output_root/.$name.tmp.$$
[[ ! -e "$final_directory" ]] || operations_die "backup manifest already exists"
mkdir "$temporary_directory"
trap 'rm -rf "$temporary_directory"' EXIT
"${client[@]}" --rdb "$temporary_directory/dump.rdb" >/dev/null
redis-check-rdb "$temporary_directory/dump.rdb" >/dev/null
dump_sha=$(operations_sha256 "$temporary_directory/dump.rdb")
db_size=$("${client[@]}" --raw DBSIZE)
server_version=$("${client[@]}" --raw INFO server | sed -n 's/^redis_version://p' | tr -d '\r')
printf '%s  dump.rdb\n' "$dump_sha" >"$temporary_directory/dump.rdb.sha256"
printf '{\n  "schema": "1.0",\n  "created_at": "%s",\n  "redis_version": "%s",\n  "key_count": %s,\n  "dump_sha256": "%s"\n}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(operations_json_escape "$server_version")" "$db_size" "$dump_sha" \
  >"$temporary_directory/manifest.json"
chmod 600 "$temporary_directory"/*
chmod 700 "$temporary_directory"
mv "$temporary_directory" "$final_directory"
trap - EXIT
printf '%s\n' "$final_directory"
