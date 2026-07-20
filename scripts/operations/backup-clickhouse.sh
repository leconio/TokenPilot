#!/usr/bin/env bash
set -euo pipefail

umask 077
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$repository_root/scripts/lib/operations.sh"

output_root=${BACKUP_ROOT:-./backups/clickhouse}
database=${CLICKHOUSE_DATABASE:-ai_control_plane}
backup_disk=${CLICKHOUSE_BACKUP_DISK:-backups}
client_config=${CLICKHOUSE_CLIENT_CONFIG:-}
backup_name=

usage() {
  printf 'Usage: CLICKHOUSE_CLIENT_CONFIG=/secure/client.xml %s [--output DIR] [--database NAME] [--disk NAME] [--name NAME]\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --output) output_root=$2; shift 2 ;;
    --database) database=$2; shift 2 ;;
    --disk) backup_disk=$2; shift 2 ;;
    --name) backup_name=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

[[ "$database" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || operations_die "invalid database name"
[[ "$backup_disk" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || operations_die "invalid backup disk"
[[ -n "$client_config" && -f "$client_config" ]] || operations_die "CLICKHOUSE_CLIENT_CONFIG is required"
[[ "$(operations_file_mode "$client_config")" == 600 ]] || operations_die "client config must have mode 0600"
operations_require_command clickhouse-client

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name=${backup_name:-tokenpilot-clickhouse-$timestamp}
[[ "$backup_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$ ]] || operations_die "invalid backup name"
mkdir -p "$output_root"
chmod 700 "$output_root"
final_directory=$output_root/$backup_name
temporary_directory=$output_root/.$backup_name.tmp.$$
[[ ! -e "$final_directory" ]] || operations_die "backup manifest already exists"
mkdir "$temporary_directory"
trap 'rm -rf "$temporary_directory"' EXIT

client=(clickhouse-client --config-file "$client_config" --multiquery)
stats=$(
  "${client[@]}" --param_db "$database" --query \
    "SELECT coalesce(sum(rows), 0), coalesce(sum(bytes_on_disk), 0) FROM system.parts WHERE active AND database={db:String} FORMAT TSVRaw"
)
IFS=$'\t' read -r rows bytes <<<"$stats"
"${client[@]}" --query \
  "BACKUP DATABASE \`$database\` TO Disk('$backup_disk', '$backup_name') SETTINGS deduplicate_files = 1"

migration_directory=$repository_root/packages/clickhouse/migrations
find "$migration_directory" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort |
  while IFS= read -r migration; do
    printf '%s  %s\n' "$(operations_sha256 "$migration")" "${migration#"$repository_root/"}"
  done >"$temporary_directory/migration-checksums.txt"
migration_sha=$(operations_sha256 "$temporary_directory/migration-checksums.txt")
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{\n  "schema": "1.0",\n  "created_at": "%s",\n  "database": "%s",\n  "backup_disk": "%s",\n  "backup_name": "%s",\n  "active_rows": %s,\n  "active_bytes": %s,\n  "migration_checksums_sha256": "%s"\n}\n' \
  "$created_at" "$database" "$backup_disk" "$backup_name" "$rows" "$bytes" "$migration_sha" \
  >"$temporary_directory/manifest.json"
printf '%s  migration-checksums.txt\n' "$migration_sha" \
  >"$temporary_directory/migration-checksums.txt.sha256"
chmod 600 "$temporary_directory"/*
chmod 700 "$temporary_directory"
mv "$temporary_directory" "$final_directory"
trap - EXIT
printf '%s\n' "$final_directory"
