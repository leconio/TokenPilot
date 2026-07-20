#!/usr/bin/env bash

# shellcheck disable=SC2154 # Runner-owned globals are intentionally shared with sourced drills.
# shellcheck disable=SC2329 # Cleanup function is invoked through an EXIT trap.

outage_request_id() {
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!/^outage-[0-9a-hjkmnp-tv-z]{26}$/u.test(value.request_id)) process.exit(64);
    process.stdout.write(value.request_id);
  ' "$1"
}

wait_for_service_health() {
  local service=$1 health=unknown
  for ((attempt = 0; attempt < 180; attempt += 1)); do
    health=$(docker inspect --format '{{.State.Health.Status}}' "$(dc ps -q "$service")")
    [[ "$health" == healthy ]] && return 0
    sleep 2
  done
  acceptance_die "$service did not recover"
}

wait_for_registry_request() {
  local request_id=$1 count=0
  [[ "$request_id" =~ ^outage-[0-9a-hjkmnp-tv-z]{26}$ ]] ||
    acceptance_die "outage request ID is invalid"
  for ((attempt = 0; attempt < 300; attempt += 1)); do
    count=$(postgres_scalar "SELECT count(*) FROM usage_event_registry WHERE request_id='$request_id'")
    # The deterministic route always records two real Provider attempts: the
    # rejected primary and the successful fallback. Exactness catches both
    # missing callbacks and accidental duplicate delivery.
    [[ "$count" == 2 ]] && return 0
    sleep 1
  done
  acceptance_die "recovered PostgreSQL did not receive exactly two spooled Provider attempts"
}

wait_for_clickhouse_backlog() {
  local query=$1 count=0
  for ((attempt = 0; attempt < 180; attempt += 1)); do
    count=$(postgres_scalar "$query")
    [[ "$count" =~ ^[1-9][0-9]*$ ]] && return 0
    sleep 1
  done
  acceptance_die "ClickHouse outage did not retain a PostgreSQL Outbox backlog"
}

run_dependency_outage_drill() {
  local evidence=$1 outbox_query=$2 service=$3 state probe request_id
  local recovery_required=0
  case "$service" in postgres | redis | clickhouse) ;; *) acceptance_die "invalid outage service" ;; esac

  dependency_outage_cleanup() {
    local original_status=$? recovery_status=0 health=unknown ready=0
    trap - EXIT
    if [[ "$recovery_required" -eq 1 ]]; then
      set +e
      dc start "$service" >>"$evidence/$service-outage-recovery.txt" 2>&1 || recovery_status=$?
      if [[ "$recovery_status" -eq 0 ]]; then
        for ((attempt = 0; attempt < 90; attempt += 1)); do
          health=$(docker inspect --format '{{.State.Health.Status}}' "$(dc ps -q "$service")" \
            2>>"$evidence/$service-outage-recovery.txt")
          [[ "$health" == healthy ]] && break
          sleep 2
        done
        [[ "$health" == healthy ]] || recovery_status=70
      fi
      if [[ "$recovery_status" -eq 0 ]]; then
        for ((attempt = 0; attempt < 90; attempt += 1)); do
          if curl --silent --show-error --fail --max-time 5 --output /dev/null \
            "$api_url/health/ready" >>"$evidence/$service-outage-recovery.txt" 2>&1; then
            ready=1
            break
          fi
          sleep 2
        done
        [[ "$ready" -eq 1 ]] || recovery_status=71
      fi
      printf 'recovery_status=%s health=%s full_stack_ready=%s\n' \
        "$recovery_status" "$health" "$ready" \
        >>"$evidence/$service-outage-recovery.txt"
      if [[ "$original_status" -eq 0 && "$recovery_status" -ne 0 ]]; then
        original_status=$recovery_status
      fi
    fi
    exit "$original_status"
  }
  trap dependency_outage_cleanup EXIT

  wait_outbox_count 0 "$outbox_query"
  recovery_required=1
  dc stop "$service" >"$evidence/$service-outage-stop.txt"
  state=$(docker inspect --format '{{.State.Status}}' "$(dc ps -aq "$service")")
  [[ "$state" == exited ]] || acceptance_die "isolated $service did not stop"
  probe=$evidence/$service-outage.json
  ACCEPTANCE_OUTAGE_DEPENDENCY=$service REMOTE_DEPENDENCY_OUTAGE_PROBE=true \
    node "$script_directory/dependency-outage-probe.mjs" >"$probe"
  if [[ "$service" == clickhouse ]]; then wait_for_clickhouse_backlog "$outbox_query"; fi
  dc start "$service" >"$evidence/$service-outage-start.txt"
  wait_for_service_health "$service"
  acceptance_wait_http "http://127.0.0.1:$ingress_port/health/ready"
  recovery_required=0
  request_id=$(outage_request_id "$probe")
  wait_for_registry_request "$request_id"
  wait_outbox_count 0 "$outbox_query"
  export ACCEPTANCE_CLICKHOUSE_REQUEST_ID=$request_id
  gate "recovered $service outage event" "$evidence/$service-outage-current-view.json" \
    dc run --rm --no-deps --env-from-file "$environment_file" \
    -e REMOTE_DOCKER_ACCEPTANCE -e ACCEPTANCE_PROJECT -e ACCEPTANCE_CLICKHOUSE_REQUEST_ID \
    release-tooling node scripts/acceptance/remote/verify-clickhouse-event.mjs
  trap - EXIT
}

run_dependency_outage_drills() {
  local evidence=$1 outbox_query=$2 service
  for service in postgres redis clickhouse; do
    run_dependency_outage_drill "$evidence" "$outbox_query" "$service"
  done
}
