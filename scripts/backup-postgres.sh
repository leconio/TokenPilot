#!/usr/bin/env bash
set -euo pipefail

umask 077
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
authority_script=$script_directory/acceptance/remote/postgresql-authority-fingerprint.mjs
compare_script=$script_directory/acceptance/remote/compare-postgresql-authority-fingerprints.mjs
# shellcheck source=scripts/lib/operations.sh
source "$script_directory/lib/operations.sh"

database_url=${DATABASE_URL:-}
backup_root=${BACKUP_ROOT:-./backups}
control_plane_version=${CONTROL_PLANE_VERSION:-0.2.0}

usage() {
  printf 'Usage: DATABASE_URL=postgresql://... %s [--database-url URL] [--output DIR] [--version SEMVER]\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --database-url)
      (($# >= 2)) || { usage; exit 2; }
      database_url=$2
      shift 2
      ;;
    --output)
      (($# >= 2)) || { usage; exit 2; }
      backup_root=$2
      shift 2
      ;;
    --version)
      (($# >= 2)) || { usage; exit 2; }
      control_plane_version=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ -n "$database_url" ]] || { usage; exit 2; }
[[ "$control_plane_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]] || \
  operations_die "CONTROL_PLANE_VERSION must be SemVer"
operations_require_command pg_dump
operations_require_command pg_restore
operations_require_command psql
operations_require_command node
[[ -f "$authority_script" && -f "$compare_script" ]] || \
  operations_die "PostgreSQL authority fingerprint helpers are missing"

mkdir -p "$backup_root"
chmod 700 "$backup_root"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
created_at_epoch=$(date -u +%s)
backup_name="tokenpilot-${control_plane_version}-${timestamp}"
final_directory=$backup_root/$backup_name
temporary_directory=$backup_root/.${backup_name}.tmp.$$
[[ ! -e "$final_directory" ]] || operations_die "backup already exists: $final_directory"
mkdir "$temporary_directory"
trap 'rm -rf "$temporary_directory"' EXIT

AUTHORITY_DATABASE_URL=$database_url node "$authority_script" \
  --database-url-env AUTHORITY_DATABASE_URL \
  --output "$temporary_directory/authority-before.json" >/dev/null

PGAPPNAME=tokenpilot-backup pg_dump "$database_url" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$temporary_directory/database.dump"
pg_restore --list "$temporary_directory/database.dump" >/dev/null

AUTHORITY_DATABASE_URL=$database_url node "$authority_script" \
  --database-url-env AUTHORITY_DATABASE_URL \
  --output "$temporary_directory/postgresql-authority.json" >/dev/null
if ! node "$compare_script" "$temporary_directory/authority-before.json" \
  "$temporary_directory/postgresql-authority.json" >/dev/null; then
  operations_die "PostgreSQL authority changed during pg_dump; quiesce writes and retry"
fi
rm "$temporary_directory/authority-before.json"

dump_sha=$(operations_sha256 "$temporary_directory/database.dump")
authority_sha=$(operations_sha256 "$temporary_directory/postgresql-authority.json")
printf '%s  database.dump\n' "$dump_sha" >"$temporary_directory/database.dump.sha256"
printf '%s  postgresql-authority.json\n' "$authority_sha" \
  >"$temporary_directory/postgresql-authority.json.sha256"

database_metadata=$(PGAPPNAME=tokenpilot-backup psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -F '|' \
  -c "SELECT current_database(), current_setting('server_version_num')")
IFS='|' read -r database_name postgres_version <<<"$database_metadata"
database_name=$(operations_json_escape "$database_name")
postgres_version=$(operations_json_escape "$postgres_version")

printf '{\n  "schema_version": "2.0",\n  "control_plane_version": "%s",\n  "created_at": "%s",\n  "created_at_epoch": %s,\n  "database_name": "%s",\n  "postgres_server_version": "%s",\n  "dump_file": "database.dump",\n  "dump_format": "custom",\n  "dump_sha256": "%s",\n  "postgresql_authority_file": "postgresql-authority.json",\n  "postgresql_authority_sha256": "%s"\n}\n' \
  "$(operations_json_escape "$control_plane_version")" \
  "$created_at" \
  "$created_at_epoch" \
  "$database_name" \
  "$postgres_version" \
  "$dump_sha" \
  "$authority_sha" >"$temporary_directory/manifest.json"

chmod 600 "$temporary_directory"/*
chmod 700 "$temporary_directory"
mv "$temporary_directory" "$final_directory"
trap - EXIT
printf '%s\n' "$final_directory"
