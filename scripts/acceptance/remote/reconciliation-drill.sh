#!/usr/bin/env bash

# Sourced by the isolated remote runner after its Compose helpers are defined.
run_reconciliation_acceptance() {
  local fixture=$1 evidence=$2 environment_file=$3 backup_host=$4
  local project=$5 run_id=$6 repository=$7
  local diff_id event_id application_id application_slug range_from range_to status=0

  read -r diff_id event_id application_id application_slug range_from range_to < <(node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f-]{36}$/iu.test(value.diff_id)) process.exit(64);
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.event_id)) process.exit(64);
    if (!/^[0-9a-f-]{36}$/iu.test(value.application_id)) process.exit(64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.application_slug)) process.exit(64);
    for (const name of ["range_from", "range_to"]) {
      if (!Number.isFinite(Date.parse(value[name]))) process.exit(64);
    }
    process.stdout.write(
      `${value.diff_id} ${value.event_id} ${value.application_id} ${value.application_slug} ${value.range_from} ${value.range_to}\n`,
    );
  ' "$fixture")

  export RELEASE_RECONCILIATION_DIFF_ID=$diff_id
  clickhouse_outbox_query="SELECT count(*) FROM pipeline_outbox WHERE status<>'sent' AND event_type IN ('usage_events_raw','usage_lines','provider_cost.provisional','provider_cost.official_delta','provider_cost.adjustment','provider_cost.unpriced','aiu.provisional','aiu.official_delta','aiu.decision','application_user.profile')"
  gate "current remote release domains" "$evidence/release-remote.txt" \
    pnpm --dir "$repository" test:release:remote
  wait_outbox_count 0 "$clickhouse_outbox_query"

  export CLICKHOUSE_ACCEPTANCE_TARGET=$project
  export CLICKHOUSE_ACCEPTANCE_ACK=disposable-fresh-database
  export RECONCILIATION_FAULT_API_URL=http://api:4000
  export RECONCILIATION_FAULT_EVENT_ID=$event_id
  export RECONCILIATION_FAULT_APPLICATION_ID=$application_id
  export RECONCILIATION_FAULT_APPLICATION_SLUG=$application_slug
  export RECONCILIATION_FAULT_RANGE_FROM=$range_from
  export RECONCILIATION_FAULT_RANGE_TO=$range_to
  export CLICKHOUSE_RECONCILIATION_EVIDENCE=/backups/reconciliation-faults
  gate "real reconciliation detection and repair" "$evidence/reconciliation-fault-drill.txt" \
    dc run --rm --no-deps --env-from-file "$environment_file" \
    -e REMOTE_RECONCILIATION_FAULT_DRILL=true -e CLICKHOUSE_URL=http://clickhouse:8123 \
    -e CLICKHOUSE_ACCEPTANCE_TARGET -e CLICKHOUSE_ACCEPTANCE_ACK \
    -e RECONCILIATION_FAULT_API_URL -e RELEASE_ADMIN_API_KEY \
    -e RECONCILIATION_FAULT_EVENT_ID -e RECONCILIATION_FAULT_APPLICATION_ID \
    -e RECONCILIATION_FAULT_APPLICATION_SLUG -e RECONCILIATION_FAULT_RANGE_FROM \
    -e RECONCILIATION_FAULT_RANGE_TO -e CLICKHOUSE_RECONCILIATION_EVIDENCE \
    release-tooling node scripts/acceptance/remote/reconciliation-fault-drill.mjs || status=$?
  if [[ -d "$backup_host/reconciliation-faults" ]]; then
    cp -R "$backup_host/reconciliation-faults" "$evidence/reconciliation-faults"
  elif [[ "$status" -eq 0 ]]; then
    acceptance_die "reconciliation fault-drill evidence is missing"
  fi
  return "$status"
}
