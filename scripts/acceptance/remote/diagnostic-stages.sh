#!/usr/bin/env bash

# Diagnostic stages run after the isolated stack, migrations, and health checks
# have been recorded by the same batch collector.
# shellcheck disable=SC2154 # Runner-owned globals are intentionally shared with sourced stages.
# shellcheck disable=SC2329 # Cleanup functions are invoked through EXIT traps.

record_playwright_trace() {
  local output_directory=$1 trace_evidence=$2 trace
  trace=$(find "$output_directory" -type f -name trace.zip -print -quit)
  [[ -n "$trace" && -s "$trace" ]] || return 1
  sha256sum "$trace" >"$trace_evidence"
  stat -c 'bytes=%s mode=%a' "$trace" >>"$trace_evidence"
}

run_web_project() {
  local browser_project=$1 output_directory=$2 trace_evidence=$3
  shift 3
  local status=0
  export PLAYWRIGHT_OUTPUT_DIR=$output_directory
  pnpm --dir "$repository" --filter @tokenpilot/web exec playwright test \
    e2e/real-stack-acceptance.spec.ts --project="$browser_project" "$@" || status=$?
  if ! record_playwright_trace "$output_directory" "$trace_evidence"; then
    printf 'Playwright trace is missing for %s\n' "$browser_project" >&2
    [[ "$status" -ne 0 ]] || return 65
  fi
  return "$status"
}

prepare_clickhouse_web_outage() {
  local ready_failed=0 status
  dc stop clickhouse
  status=$(docker inspect --format '{{.State.Status}}' "$(dc ps -aq clickhouse)")
  [[ "$status" == exited ]] || acceptance_die "isolated ClickHouse did not stop"
  for ((attempt = 0; attempt < 60; attempt += 1)); do
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 \
      "$api_url/health/ready" || true)
    if [[ "$status" == 503 ]]; then ready_failed=1; break; fi
    sleep 1
  done
  [[ "$ready_failed" -eq 1 ]] || acceptance_die "Web error-state outage did not fail readiness"
}

restore_clickhouse_after_web_outage() {
  dc start clickhouse
  wait_for_service_health clickhouse
  acceptance_wait_http "$api_url/health/ready"
}

identify_web_administrator() {
  local json=$temporary/web-administrator.json id=$temporary/web-administrator-id.txt
  REMOTE_WEB_ACCEPTANCE_SETUP=identify node "$script_directory/prepare-web-acceptance.mjs" >"$json"
  capture_web_administrator "$json" >"$id"
  cat "$json"
}

capture_web_administrator() {
  local source=$1
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f-]{36}$/iu.test(value.admin_user_id)) process.exit(64);
    process.stdout.write(value.admin_user_id);
  ' "$source"
}

verify_diagnostic_runtime_boundary() {
  local label=$1 expected_worker_replicas=${2:-} database owner expected_owner pause safe=1
  local worker_count=unknown worker_status=not-checked prometheus_status=not-checked
  local pause_status=unknown owner_status=unknown schema_status=unknown readiness_status=unknown
  [[ "$label" =~ ^[a-z0-9-]+$ ]] || acceptance_die "runtime boundary label is invalid"
  database=$(acceptance_env_value "$environment_file" CLICKHOUSE_DATABASE)
  expected_owner="acceptance:$run_id"
  if pause=$(dc exec -T redis redis-cli --raw GET clickhouse:sink:pause); then
    if [[ -z "$pause" ]]; then pause_status=clear; else pause_status=held; safe=0; fi
  else
    pause_status=unavailable
    safe=0
  fi
  if owner=$(dc exec -T redis redis-cli --raw GET \
    "clickhouse:fresh-rebuild:owner:$database"); then
    if [[ "$owner" == "$expected_owner" ]]; then
      owner_status=verified
    else
      owner_status=invalid
      safe=0
    fi
  else
    owner_status=unavailable
    safe=0
  fi
  if dc run --rm --no-deps --env-from-file "$environment_file" release-tooling \
    node packages/clickhouse/dist/cli.js verify \
    >"$evidence/runtime-boundary-$label-schema.txt" 2>&1; then
    schema_status=current
  else
    schema_status=invalid
    safe=0
  fi
  if curl --silent --show-error --fail --max-time 5 --output /dev/null \
    "$api_url/health/ready"; then
    readiness_status=ready
  else
    readiness_status=unavailable
    safe=0
  fi
  if [[ -n "$expected_worker_replicas" ]]; then
    [[ "$expected_worker_replicas" =~ ^[1-9][0-9]*$ ]] ||
      acceptance_die "expected Worker replica count is invalid"
    worker_count=$(dc ps --status running -q worker | wc -l)
    if [[ "$worker_count" -eq "$expected_worker_replicas" ]]; then
      worker_status=verified
    else
      worker_status=invalid
      safe=0
    fi
    if check_prometheus_targets "$expected_worker_replicas" \
      "$evidence/prometheus-targets-$label.json" \
      "$evidence/prometheus-api-metric-$label.json" \
      "$evidence/prometheus-worker-metric-$label.json"; then
      prometheus_status=verified
    else
      prometheus_status=invalid
      safe=0
    fi
  fi
  printf 'delivery_pause=%s ownership=%s schema=%s readiness=%s workers=%s worker_count=%s prometheus=%s\n' \
    "$pause_status" "$owner_status" "$schema_status" "$readiness_status" "$worker_status" \
    "$worker_count" "$prometheus_status"
  [[ "$safe" -eq 1 ]]
}

record_runtime_boundary() {
  local stage=$1 label=$2 expected_worker_replicas=${3:-}
  local was_safe=${DIAGNOSTIC_RUNTIME_SAFE:-0}
  diagnostic_run "$stage" "$label" "$evidence/$stage.txt" \
    verify_diagnostic_runtime_boundary "$stage" "$expected_worker_replicas"
  if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS && "$was_safe" -eq 1 ]]; then
    DIAGNOSTIC_RUNTIME_SAFE=1
  else
    DIAGNOSTIC_RUNTIME_SAFE=0
  fi
}

run_reconciliation_diagnostic() {
  local token="reconciliation-$run_id" reconciliation_status=0
  if [[ -s "$evidence/web-administrator.json" ]]; then
    RELEASE_ADMIN_USER_ID=$(capture_web_administrator "$evidence/web-administrator.json")
    export RELEASE_ADMIN_USER_ID
  fi
  reconciliation_cleanup() {
    local result
    set +e
    result=$(dc exec -T redis redis-cli --raw EVAL \
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" \
      1 clickhouse:sink:pause "$token" 2>>"$evidence/reconciliation-resume-recovery.txt")
    printf 'resume_result=%s\n' "$result" >>"$evidence/reconciliation-resume-recovery.txt"
  }
  trap 'reconciliation_exit_status=$?; trap - EXIT; reconciliation_cleanup; exit "$reconciliation_exit_status"' EXIT
  pause_sink "$token"
  REMOTE_RECONCILIATION_SETUP=true node "$script_directory/prepare-reconciliation-diff.mjs" \
    >"$evidence/reconciliation-fixture.json"
  resume_sink "$token"
  run_reconciliation_acceptance "$evidence/reconciliation-fixture.json" "$evidence" \
    "$environment_file" "$backup_host" "$project" "$run_id" "$repository" || \
    reconciliation_status=$?
  trap - EXIT
  reconciliation_cleanup
  return "$reconciliation_status"
}

run_performance_acceptance() {
  dc run --rm --no-deps "${performance_environment[@]}" release-tooling \
    node scripts/performance/remote-acceptance.mjs --output "$performance_output"
}

validate_performance_acceptance() {
  dc run --rm --no-deps "${performance_environment[@]}" release-tooling \
    node scripts/performance/validate-results.mjs --input "$performance_output"
}

retain_performance_report() {
  [[ -s "$backup_host/performance/report.json" ]] || acceptance_die "performance report is missing"
  mkdir -p "$evidence/performance"
  cp "$backup_host/performance/report.json" "$evidence/performance/report.json"
}

check_stability_backlog() {
  {
    printf 'inbox_outstanding=%s\n' "$(postgres_scalar \
      "SELECT count(*) FROM ingestion_inbox WHERE status IN ('pending','leased','failed')")"
    printf 'inbox_dead_letter=%s\n' "$(postgres_scalar \
      "SELECT count(*) FROM ingestion_inbox WHERE status='dead_letter'")"
    printf 'outbox_outstanding=%s\n' "$(postgres_scalar \
      "SELECT count(*) FROM pipeline_outbox WHERE status IN ('pending','leased','failed')")"
    printf 'outbox_dead_letter=%s\n' "$(postgres_scalar \
      "SELECT count(*) FROM pipeline_outbox WHERE status='dead_letter'")"
    printf 'active_dead_letter_events=%s\n' "$(postgres_scalar \
      "SELECT count(*) FROM dead_letter_events WHERE status IN ('open','replay_queued')")"
  } >"$evidence/sustained-stability-backlog.txt"
  grep -Fxq 'inbox_outstanding=0' "$evidence/sustained-stability-backlog.txt"
  grep -Fxq 'inbox_dead_letter=0' "$evidence/sustained-stability-backlog.txt"
  grep -Fxq 'outbox_outstanding=0' "$evidence/sustained-stability-backlog.txt"
  grep -Fxq 'outbox_dead_letter=0' "$evidence/sustained-stability-backlog.txt"
  grep -Fxq 'active_dead_letter_events=0' "$evidence/sustained-stability-backlog.txt"
}

run_security_diagnostic() {
  "$script_directory/security-gates.sh"
}

run_web_diagnostics() {
  local web_prepared=0 chromium_ready=0 web_ready=0 clickhouse_state
  diagnostic_run web-preparation "verify Web real-stack acceptance setup" \
    "$evidence/web-preparation.json" env REMOTE_WEB_ACCEPTANCE_SETUP=identify \
    node "$script_directory/prepare-web-acceptance.mjs"
  [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && web_prepared=1
  diagnostic_run chromium-install "install remote Chromium" "$evidence/playwright-install.txt" \
    pnpm --dir "$repository" --filter @tokenpilot/web exec playwright install chromium
  [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && chromium_ready=1
  [[ "$web_prepared" -eq 1 && "$chromium_ready" -eq 1 ]] && web_ready=1

  export REAL_STACK_SCENARIO=healthy
  for browser_project in desktop-1440x900 narrow-390x844; do
    if [[ "$web_ready" -eq 1 ]]; then
      diagnostic_run "web-healthy-$browser_project" "Web real-stack $browser_project" \
        "$evidence/web-$browser_project.txt" run_web_project "$browser_project" \
        "$temporary/playwright/$browser_project" \
        "$evidence/web-$browser_project-trace.sha256"
    else
      diagnostic_block "web-healthy-$browser_project" "Web real-stack $browser_project" \
        "$evidence/web-$browser_project.txt" "Web preparation or Chromium installation failed"
    fi
  done

  if [[ "$web_ready" -eq 1 ]]; then
    diagnostic_run web-administrator "identify Web administrator" \
      "$evidence/web-administrator.json" identify_web_administrator
  else
    diagnostic_block web-administrator "identify Web administrator" \
      "$evidence/web-administrator.json" "Web preparation or Chromium installation failed"
  fi
  unset RELEASE_ADMIN_USER_ID

  diagnostic_run web-clickhouse-outage "start Web ClickHouse outage" \
    "$evidence/web-clickhouse-outage-stop.txt" prepare_clickhouse_web_outage
  clickhouse_state=$(docker inspect --format '{{.State.Status}}' "$(dc ps -aq clickhouse)" 2>/dev/null || true)
  export REAL_STACK_SCENARIO=clickhouse-outage
  for browser_project in desktop-1440x900 narrow-390x844; do
    if [[ "$web_ready" -eq 1 && "$clickhouse_state" == exited ]]; then
      diagnostic_run "web-error-$browser_project" "Web real-stack error state $browser_project" \
        "$evidence/web-error-$browser_project.txt" run_web_project "$browser_project" \
        "$temporary/playwright-error/$browser_project" \
        "$evidence/web-error-$browser_project-trace.sha256" \
        --grep "ClickHouse 中断时真实报告页显示错误态"
    else
      diagnostic_block "web-error-$browser_project" "Web real-stack error state $browser_project" \
        "$evidence/web-error-$browser_project.txt" \
        "Chromium is unavailable or the isolated ClickHouse outage was not established"
    fi
  done
  diagnostic_run web-clickhouse-recovery "recover Web ClickHouse outage" \
    "$evidence/web-clickhouse-outage-start.txt" restore_clickhouse_after_web_outage
  export REAL_STACK_SCENARIO=healthy
}

run_datastore_diagnostics() {
  local clickhouse_outbox_query service worker_scale_attempted=0 scale_two_passed=0
  clickhouse_outbox_query="SELECT count(*) FROM pipeline_outbox WHERE status<>'sent' AND event_type IN ('usage_events_raw','usage_lines','provider_cost.provisional','provider_cost.official_delta','provider_cost.adjustment','provider_cost.unpriced','aiu.provisional','aiu.official_delta','aiu.decision','application_user.profile')"
  for service in postgres redis clickhouse; do
    if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 ]]; then
      diagnostic_run "outage-$service" "isolated $service outage and recovery" \
        "$evidence/$service-outage-stage.txt" run_dependency_outage_drill \
        "$evidence" "$clickhouse_outbox_query" "$service"
      record_runtime_boundary "runtime-after-outage-$service" \
        "verify runtime after $service outage"
    else
      diagnostic_block "outage-$service" "isolated $service outage and recovery" \
        "$evidence/$service-outage-stage.txt" "the isolated runtime boundary is unsafe"
    fi
  done

  if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 ]]; then
    diagnostic_run reconciliation "real reconciliation detection and repair" \
      "$evidence/reconciliation-stage.txt" run_reconciliation_diagnostic
    record_runtime_boundary runtime-after-reconciliation \
      "verify runtime after reconciliation repair"
  else
    diagnostic_block reconciliation "real reconciliation detection and repair" \
      "$evidence/reconciliation-stage.txt" "the isolated runtime boundary is unsafe"
  fi

  if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 ]]; then
    worker_scale_attempted=1
    diagnostic_run worker-scale-two "scale two isolated Workers" \
      "$evidence/worker-scale-two.txt" scale_workers 2
    if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
      scale_two_passed=1
      record_runtime_boundary runtime-after-worker-scale-two \
        "verify runtime with two isolated Workers" 2
    else
      DIAGNOSTIC_RUNTIME_SAFE=0
      diagnostic_block runtime-after-worker-scale-two \
        "verify runtime with two isolated Workers" \
        "$evidence/runtime-after-worker-scale-two.txt" "Worker scale-out failed"
    fi
    if [[ "$scale_two_passed" -eq 1 && "$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 ]]; then
      diagnostic_run clickhouse-fresh-rebuild "ClickHouse conflicting schema fresh rebuild" \
        "$evidence/clickhouse-fresh-rebuild-stage.txt" run_clickhouse_fresh_rebuild_acceptance \
        "$evidence" "$environment_file" "$backup_host" "$project"
      if [[ "$DIAGNOSTIC_LAST_STATUS" != PASS ]]; then DIAGNOSTIC_RUNTIME_SAFE=0; fi
      record_runtime_boundary runtime-after-fresh-rebuild \
        "verify runtime after ClickHouse fresh rebuild" 2
    else
      diagnostic_block clickhouse-fresh-rebuild "ClickHouse conflicting schema fresh rebuild" \
        "$evidence/clickhouse-fresh-rebuild-stage.txt" \
        "two healthy isolated Workers were not verified"
      diagnostic_block runtime-after-fresh-rebuild \
        "verify runtime after ClickHouse fresh rebuild" \
        "$evidence/runtime-after-fresh-rebuild.txt" "ClickHouse fresh rebuild was not run"
    fi
  else
    diagnostic_block worker-scale-two "scale two isolated Workers" \
      "$evidence/worker-scale-two.txt" "the isolated runtime boundary is unsafe"
    diagnostic_block runtime-after-worker-scale-two \
      "verify runtime with two isolated Workers" \
      "$evidence/runtime-after-worker-scale-two.txt" "Worker scale-out was not attempted"
    diagnostic_block clickhouse-fresh-rebuild "ClickHouse conflicting schema fresh rebuild" \
      "$evidence/clickhouse-fresh-rebuild-stage.txt" "the isolated runtime boundary is unsafe"
    diagnostic_block runtime-after-fresh-rebuild \
      "verify runtime after ClickHouse fresh rebuild" \
      "$evidence/runtime-after-fresh-rebuild.txt" "ClickHouse fresh rebuild was not run"
  fi
  if [[ "$worker_scale_attempted" -eq 1 ]]; then
    diagnostic_run worker-scale-one "restore isolated Worker count to one" \
      "$evidence/worker-scale-one.txt" restore_worker_count
    if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
      record_runtime_boundary runtime-after-worker-scale-one \
        "verify runtime with one isolated Worker" 1
    else
      DIAGNOSTIC_RUNTIME_SAFE=0
      diagnostic_block runtime-after-worker-scale-one \
        "verify runtime with one isolated Worker" \
        "$evidence/runtime-after-worker-scale-one.txt" "Worker scale-in failed"
    fi
  else
    diagnostic_block worker-scale-one "scale isolated Worker back to one" \
      "$evidence/worker-scale-one.txt" "Worker scale-out was not attempted"
    diagnostic_block runtime-after-worker-scale-one \
      "verify runtime with one isolated Worker" \
      "$evidence/runtime-after-worker-scale-one.txt" "Worker scale-in was not attempted"
  fi
}

run_observability_diagnostics() {
  diagnostic_run prometheus-config "validate Prometheus config" "$evidence/prometheus-config.txt" \
    dc exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
  diagnostic_run prometheus-rules "validate Prometheus rules" "$evidence/prometheus-rules.txt" \
    dc exec -T prometheus promtool check rules /etc/prometheus/alerts.yml
  diagnostic_run prometheus-rule-tests "test Prometheus rules" \
    "$evidence/prometheus-rule-tests.txt" dc exec -T prometheus promtool test rules \
    /etc/prometheus/alerts.test.yml
  if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 ]]; then
    diagnostic_run prometheus-targets "check Prometheus targets" \
      "$evidence/prometheus-targets-check.txt" check_prometheus_targets 1 \
      "$evidence/prometheus-targets.json" "$evidence/prometheus-api-metric.json" \
      "$evidence/prometheus-worker-metric.json"
  else
    diagnostic_block prometheus-targets "check Prometheus targets" \
      "$evidence/prometheus-targets-check.txt" "the isolated runtime boundary is unsafe"
  fi
}

run_performance_diagnostics() {
  performance_output=/backups/performance/report.json
  performance_environment=(-e ACCEPTANCE_PROJECT -e ACCEPTANCE_RUN_ID -e SOURCE_SHA -e DATABASE_URL
    -e ACCEPTANCE_PERFORMANCE_NONCE -e REMOTE_DOCKER_ACCEPTANCE -e PERF_ISOLATED_STACK
    -e PERF_API_URL -e PERF_APPLICATION_SLUG -e PERF_INGEST_API_KEY -e PERF_READ_API_KEY
    -e PERF_RUNTIME_API_KEY
    -e CLICKHOUSE_URL -e CLICKHOUSE_DATABASE -e CLICKHOUSE_USERNAME -e CLICKHOUSE_PASSWORD)
  if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -ne 1 ]]; then
    diagnostic_block performance-run "real multi-scale performance acceptance" \
      "$evidence/performance-run.txt" "the isolated runtime boundary is unsafe"
    diagnostic_block performance-validation "independent performance report validation" \
      "$evidence/performance-validation.txt" "performance acceptance was blocked"
    diagnostic_block performance-evidence "retain performance report" \
      "$evidence/performance-evidence.txt" "performance acceptance was blocked"
    return
  fi
  diagnostic_run performance-run "real multi-scale performance acceptance" \
    "$evidence/performance-run.txt" run_performance_acceptance
  if [[ -s "$backup_host/performance/report.json" ]]; then
    diagnostic_run performance-validation "independent performance report validation" \
      "$evidence/performance-validation.txt" validate_performance_acceptance
    diagnostic_run performance-evidence "retain performance report" \
      "$evidence/performance-evidence.txt" retain_performance_report
  else
    diagnostic_block performance-validation "independent performance report validation" \
      "$evidence/performance-validation.txt" "performance run produced no report"
    diagnostic_block performance-evidence "retain performance report" \
      "$evidence/performance-evidence.txt" "performance run produced no report"
  fi
}

run_stability_and_security_diagnostics() {
  if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 ]]; then
    diagnostic_run sustained-stability "sustained stability observation" \
      "$evidence/sustained-stability.txt" "$script_directory/sustained-stability.sh"
    diagnostic_run sustained-stability-backlog "verify sustained stability backlog" \
      "$evidence/sustained-stability-backlog-check.txt" check_stability_backlog
  else
    diagnostic_block sustained-stability "sustained stability observation" \
      "$evidence/sustained-stability.txt" "the isolated runtime boundary is unsafe"
    diagnostic_block sustained-stability-backlog "verify sustained stability backlog" \
      "$evidence/sustained-stability-backlog-check.txt" "the isolated runtime boundary is unsafe"
  fi
  diagnostic_run security "SBOM and High/Critical vulnerability gates" \
    "$evidence/security-run.txt" run_security_diagnostic
}

run_post_readiness_diagnostics() {
  [[ ${DIAGNOSTIC_EVIDENCE:-} == "$evidence" ]] || diagnostic_batch_initialize "$evidence"
  DIAGNOSTIC_RUNTIME_SAFE=${DIAGNOSTIC_RUNTIME_SAFE:-1}
  if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -ne 1 ]]; then
    diagnostic_block post-readiness-diagnostics "run post-readiness diagnostics" \
      "$evidence/post-readiness-diagnostics.txt" \
      "the isolated runtime foundation is unsafe"
    if ! diagnostic_batch_finish; then return 80; fi
    return 0
  fi
  export REAL_STACK_E2E=true REAL_STACK_E2E_ISOLATED=true REAL_STACK_SCENARIO=healthy
  export PLAYWRIGHT_BASE_URL=$api_url LITELLM_DEMO_URL="http://127.0.0.1:$litellm_port"
  export PLAYWRIGHT_TRACE=on PLAYWRIGHT_WORKERS=1

  run_web_diagnostics
  record_runtime_boundary runtime-after-web "verify runtime after Web outage recovery"
  run_datastore_diagnostics
  run_observability_diagnostics

  ACCEPTANCE_PERFORMANCE_NONCE="$(openssl rand -hex 32)"
  printf '%s\n' "$ACCEPTANCE_PERFORMANCE_NONCE" >>"$secret_patterns"
  export PERF_ISOLATED_STACK=true PERF_API_URL=http://api:4000 ACCEPTANCE_PERFORMANCE_NONCE
  export PERF_APPLICATION_SLUG=$REAL_STACK_APPLICATION_SLUG
  export PERF_INGEST_API_KEY=$ingest_key PERF_READ_API_KEY=$admin_key
  export PERF_RUNTIME_API_KEY=$policy_key CLICKHOUSE_URL=http://clickhouse:8123
  run_performance_diagnostics

  export STABILITY_READY_URL="http://127.0.0.1:$ingress_port/health/ready"
  export STABILITY_DURATION_SECONDS=60 STABILITY_SAMPLE_INTERVAL_SECONDS=5
  export STABILITY_EXPECTED_WORKER_REPLICAS=1 STABILITY_DOCKER_STATS_TIMEOUT_SECONDS=15
  export ACCEPTANCE_SECURITY_EVIDENCE=$evidence/security ACCEPTANCE_IMAGE_MANIFEST=$image_manifest
  export ACCEPTANCE_TEMPORARY=$temporary/security
  mkdir -p "$ACCEPTANCE_TEMPORARY"
  chmod 700 "$ACCEPTANCE_TEMPORARY"
  run_stability_and_security_diagnostics

  if ! diagnostic_batch_finish; then
    printf '[acceptance] batch diagnostics found %s failed and %s blocked stages\n' \
      "$DIAGNOSTIC_FAILED" "$DIAGNOSTIC_BLOCKED" >&2
    return 80
  fi
  printf 'PASS all non-skippable isolated remote acceptance gates completed\n'
}
