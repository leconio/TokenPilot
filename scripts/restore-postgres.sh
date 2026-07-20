#!/usr/bin/env bash
set -euo pipefail

umask 077
script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
authority_script=$script_directory/acceptance/remote/postgresql-authority-fingerprint.mjs
compare_script=$script_directory/acceptance/remote/compare-postgresql-authority-fingerprints.mjs
# shellcheck source=scripts/lib/operations.sh
source "$script_directory/lib/operations.sh"

backup_directory=
target_url=
confirmed_database=

usage() {
  printf 'Usage: %s --backup DIR --target-url URL --confirm-empty-database NAME\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --backup)
      (($# >= 2)) || { usage; exit 2; }
      backup_directory=$2
      shift 2
      ;;
    --target-url)
      (($# >= 2)) || { usage; exit 2; }
      target_url=$2
      shift 2
      ;;
    --confirm-empty-database)
      (($# >= 2)) || { usage; exit 2; }
      confirmed_database=$2
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

[[ -n "$backup_directory" && -n "$target_url" && -n "$confirmed_database" ]] || { usage; exit 2; }
operations_require_command psql
operations_require_command pg_restore
operations_require_command node
[[ -f "$authority_script" && -f "$compare_script" ]] || \
  operations_die "PostgreSQL authority fingerprint helpers are missing"
"$script_directory/verify-backup.sh" --backup "$backup_directory" >/dev/null

actual_database=$(PGAPPNAME=tokenpilot-restore psql "$target_url" -X -q -v ON_ERROR_STOP=1 -At \
  -c 'SELECT current_database()')
[[ "$actual_database" == "$confirmed_database" ]] || \
  operations_die "target is $actual_database, but confirmation names $confirmed_database"

object_count=$(PGAPPNAME=tokenpilot-restore psql "$target_url" -X -q -v ON_ERROR_STOP=1 -At <<'SQL'
WITH public_objects AS (
  SELECT relation.oid
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT routine.oid
  FROM pg_proc AS routine
  JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
  WHERE namespace.nspname = 'public'
  UNION ALL
  SELECT type.oid
  FROM pg_type AS type
  JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
  WHERE namespace.nspname = 'public'
    AND type.typtype IN ('d', 'e', 'r')
)
SELECT count(*) FROM public_objects;
SQL
)
[[ "$object_count" == 0 ]] || operations_die "restore target must be an explicitly named empty database"

PGAPPNAME=tokenpilot-restore pg_restore "$backup_directory/database.dump" \
  --dbname="$target_url" \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  --no-privileges

authority_temporary=$(mktemp -d)
trap 'rm -rf "$authority_temporary"' EXIT
restored_authority=$authority_temporary/postgresql-authority.json
AUTHORITY_DATABASE_URL=$target_url node "$authority_script" \
  --database-url-env AUTHORITY_DATABASE_URL --output "$restored_authority" >/dev/null
node "$compare_script" "$backup_directory/postgresql-authority.json" "$restored_authority" \
  >/dev/null
printf 'Restore verified for empty target database %s.\n' "$actual_database"
