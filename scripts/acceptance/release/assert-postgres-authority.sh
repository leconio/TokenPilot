#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../../.." && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$repository_root/scripts/lib/operations.sh"

database_url=${DATABASE_URL:-}
if [[ ${1:-} == --database-url && -n ${2:-} ]]; then
  database_url=$2
elif [[ $# -ne 0 ]]; then
  printf 'Usage: %s [--database-url URL]\n' "$0" >&2
  exit 64
fi
[[ -n "$database_url" ]] || operations_die "DATABASE_URL or --database-url is required"
operations_require_command psql

state=$(PGAPPNAME=tokenpilot-postgres-authority \
  psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -F '|' <<'SQL'
SELECT
  count(*),
  bool_and(feature_hard_limit IS FALSE),
  to_regclass('public.provider_cost_ledger_entries') IS NOT NULL,
  to_regclass('public.aiu_ledger_entries') IS NOT NULL,
  (SELECT bool_and(hard_limit_enabled IS FALSE AND mode <> 'hard_limit') FROM aiu_settings),
  (SELECT count(*) FROM aiu_reservations WHERE status = 'reserved')
FROM instance_settings;
SQL
)
IFS='|' read -r settings_count hard_limit_disabled provider_ledger aiu_ledger aiu_nonblocking reserved_count <<<"$state"

[[ "$settings_count" == 1 ]] || operations_die "instance settings singleton is missing"
[[ "$hard_limit_disabled" == t ]] || \
  operations_die "hard limit must remain disabled until the acceptance decision passes"
[[ "$provider_ledger" == t && "$aiu_ledger" == t ]] || \
  operations_die "authoritative PostgreSQL journals are missing"
[[ "$aiu_nonblocking" == t ]] || operations_die "AIU settings still permit request blocking"
[[ "$reserved_count" == 0 ]] || operations_die "$reserved_count AIU reservation(s) remain open"

printf '%s\n' '{"authority":"postgresql","hard_limit":false,"aiu_blocking":false,"open_reservations":"0","usage_journals":"present","decision":"pass"}'
