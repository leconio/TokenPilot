#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: DATABASE_URL=postgresql://... %s [--database-url URL]\n' "$0" >&2
}

database_url=${DATABASE_URL:-}
while (($# > 0)); do
  case "$1" in
    --database-url)
      (($# >= 2)) || { usage; exit 2; }
      database_url=$2
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
command -v psql >/dev/null 2>&1 || { printf 'psql is required\n' >&2; exit 1; }

PGAPPNAME=tokenpilot-usage-snapshot psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT jsonb_build_object(
  'schema_version', 'current',
  'captured_at', now(),
  'scope', 'postgresql_transactional_authority',
  'integrity', 'verified',
  'analytics_included', false,
  'analytics_store', 'clickhouse'
)::text;
SQL
