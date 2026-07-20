#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
database_url=${DATABASE_URL:-}
emit_snapshot=false

usage() {
  printf 'Usage: DATABASE_URL=postgresql://... %s [--database-url URL] [--snapshot]\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --database-url)
      (($# >= 2)) || { usage; exit 2; }
      database_url=$2
      shift 2
      ;;
    --snapshot)
      emit_snapshot=true
      shift
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

result=$(PGAPPNAME=tokenpilot-usage-integrity psql "$database_url" -X -q -v ON_ERROR_STOP=1 -At -F '|' <<'SQL'
WITH cost_line_totals AS (
  SELECT rating.id,
         coalesce(sum((line.value->>'amount')::numeric), 0::numeric) AS total
  FROM application_usage_ratings AS rating
  LEFT JOIN LATERAL jsonb_array_elements(rating.cost_lines_json) AS line(value)
    ON line.value->>'amount' IS NOT NULL
  GROUP BY rating.id
), aiu_line_totals AS (
  SELECT rating.id,
         coalesce(sum((line.value->>'charged_aiu_micros')::bigint), 0::numeric) AS total
  FROM application_usage_ratings AS rating
  LEFT JOIN LATERAL jsonb_array_elements(rating.aiu_lines_json) AS line(value)
    ON line.value->>'charged_aiu_micros' IS NOT NULL
  GROUP BY rating.id
), active_reservations AS (
  SELECT application_id, quota_id, coalesce(sum(reserved_aiu_micros), 0) AS total
  FROM user_aiu_reservations
  WHERE status = 'reserved'
  GROUP BY application_id, quota_id
), latest_ledger AS (
  SELECT DISTINCT ON (application_id, quota_id)
         application_id, quota_id, consumed_after_micros,
         reserved_after_micros, limit_after_micros
  FROM user_aiu_ledger_entries
  ORDER BY application_id, quota_id, created_at DESC, id DESC
), checks AS (
  SELECT 'application_user_identity_mismatch' AS name, count(*) AS failures
  FROM usage_event_registry AS registry
  JOIN application_users AS app_user
    ON app_user.application_id = registry.application_id
   AND app_user.id = registry.application_user_id
  WHERE app_user.external_id <> registry.external_user_id
  UNION ALL
  SELECT 'rating_token_total_mismatch', count(*)
  FROM application_usage_ratings
  WHERE total_tokens <> input_tokens + output_tokens
  UNION ALL
  SELECT 'model_cost_shape_mismatch', count(*)
  FROM application_usage_ratings
  WHERE (cost_status = 'official' AND
          (provider_cost IS NULL OR currency IS NULL OR cost_version_id IS NULL))
     OR (cost_status = 'unpriced' AND
          (provider_cost IS NOT NULL OR currency IS NOT NULL))
  UNION ALL
  SELECT 'model_cost_line_total_mismatch', count(*)
  FROM application_usage_ratings AS rating
  JOIN cost_line_totals AS lines ON lines.id = rating.id
  WHERE rating.cost_status = 'official'
    AND rating.provider_cost <> lines.total
  UNION ALL
  SELECT 'aiu_shape_mismatch', count(*)
  FROM application_usage_ratings
  WHERE (aiu_status = 'official' AND
          (aiu_micros IS NULL OR aiu_version_id IS NULL))
     OR (aiu_status = 'unrated' AND aiu_micros IS NOT NULL)
  UNION ALL
  SELECT 'aiu_line_total_mismatch', count(*)
  FROM application_usage_ratings AS rating
  JOIN aiu_line_totals AS lines ON lines.id = rating.id
  WHERE rating.aiu_status = 'official'
    AND rating.aiu_micros <> lines.total
  UNION ALL
  SELECT 'quota_negative_counter', count(*)
  FROM user_aiu_quotas
  WHERE limit_aiu_micros < 0 OR consumed_aiu_micros < 0 OR reserved_aiu_micros < 0
  UNION ALL
  SELECT 'quota_reservation_projection_mismatch', count(*)
  FROM user_aiu_quotas AS quota
  LEFT JOIN active_reservations AS reservations
    ON reservations.application_id = quota.application_id
   AND reservations.quota_id = quota.id
  WHERE quota.reserved_aiu_micros <> coalesce(reservations.total, 0)
  UNION ALL
  SELECT 'quota_ledger_snapshot_mismatch', count(*)
  FROM user_aiu_quotas AS quota
  JOIN latest_ledger AS ledger
    ON ledger.application_id = quota.application_id
   AND ledger.quota_id = quota.id
  WHERE ledger.consumed_after_micros <> quota.consumed_aiu_micros
     OR ledger.reserved_after_micros <> quota.reserved_aiu_micros
     OR ledger.limit_after_micros <> quota.limit_aiu_micros
)
SELECT name, failures FROM checks ORDER BY name;
SQL
)

total_failures=0
while IFS='|' read -r name failures; do
  [[ -n "$name" ]] || continue
  if [[ ! "$failures" =~ ^[0-9]+$ ]]; then
    printf 'Invalid integrity result for %s\n' "$name" >&2
    exit 1
  fi
  if ((failures > 0)); then
    printf 'FAIL %-40s %s\n' "$name" "$failures" >&2
    total_failures=$((total_failures + failures))
  else
    printf 'OK   %s\n' "$name" >&2
  fi
done <<<"$result"

((total_failures == 0)) || {
  printf 'Usage integrity failed with %s violation(s).\n' "$total_failures" >&2
  exit 1
}

if [[ "$emit_snapshot" == true ]]; then
  DATABASE_URL=$database_url "$script_directory/usage-snapshot.sh"
else
  printf 'Usage integrity OK.\n'
fi
