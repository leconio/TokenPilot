#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$repository_root/scripts/lib/operations.sh"

manifest_directory=
target_database=
confirmed_database=
client_config=${CLICKHOUSE_CLIENT_CONFIG:-}

usage() {
  printf 'Usage: CLICKHOUSE_CLIENT_CONFIG=/secure/client.xml %s --backup-manifest DIR --target-database NAME --confirm-empty-database NAME\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --backup-manifest) manifest_directory=$2; shift 2 ;;
    --target-database) target_database=$2; shift 2 ;;
    --confirm-empty-database) confirmed_database=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$manifest_directory" && -n "$target_database" ]] || { usage; exit 2; }
[[ "$target_database" == "$confirmed_database" ]] || operations_die "target confirmation does not match"
[[ "$target_database" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || operations_die "invalid target database"
[[ -f "$manifest_directory/manifest.json" ]] || operations_die "backup manifest is missing"
[[ -f "$manifest_directory/migration-checksums.txt" ]] || operations_die "migration checksums are missing"
[[ -f "$manifest_directory/migration-checksums.txt.sha256" ]] || operations_die "migration checksum digest is missing"
[[ "$(operations_file_mode "$manifest_directory/manifest.json")" == 600 ]] || operations_die "manifest must have mode 0600"
[[ -n "$client_config" && -f "$client_config" ]] || operations_die "CLICKHOUSE_CLIENT_CONFIG is required"
[[ "$(operations_file_mode "$client_config")" == 600 ]] || operations_die "client config must have mode 0600"
operations_require_command clickhouse-client

source_database=$(operations_manifest_string "$manifest_directory/manifest.json" database)
backup_disk=$(operations_manifest_string "$manifest_directory/manifest.json" backup_disk)
backup_name=$(operations_manifest_string "$manifest_directory/manifest.json" backup_name)
for value in "$source_database" "$backup_disk"; do
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || operations_die "manifest contains an invalid identifier"
done
[[ "$backup_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$ ]] || operations_die "manifest backup name is invalid"

expected=$(awk 'NR == 1 {print $1}' "$manifest_directory/migration-checksums.txt.sha256")
[[ "$(operations_sha256 "$manifest_directory/migration-checksums.txt")" == "$expected" ]] || \
  operations_die "migration checksum manifest is corrupt"
client=(clickhouse-client --config-file "$client_config" --multiquery)
table_count=$(
  "${client[@]}" --param_db "$target_database" --query \
    "SELECT count() FROM system.tables WHERE database={db:String} FORMAT TSVRaw"
)
[[ "$table_count" == 0 ]] || operations_die "restore target database must be empty"
"${client[@]}" --query \
  "RESTORE DATABASE \`$source_database\` AS \`$target_database\` FROM Disk('$backup_disk', '$backup_name') SETTINGS allow_non_empty_tables = 0"
restored_tables=$(
  "${client[@]}" --param_db "$target_database" --query \
    "SELECT count() FROM system.tables WHERE database={db:String} FORMAT TSVRaw"
)
((restored_tables > 0)) || operations_die "restore completed without tables"
printf 'ClickHouse restore completed into isolated database %s; reconciliation is required.\n' "$target_database"
