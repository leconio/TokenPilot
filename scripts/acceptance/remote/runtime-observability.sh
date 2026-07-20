#!/usr/bin/env bash

# Worker scaling and Prometheus gates are sourced by the guarded remote runner.
# shellcheck disable=SC2154 # Runner-owned globals are intentionally shared with sourced stages.
# shellcheck disable=SC2329 # Functions are invoked by the diagnostic stage orchestrator.

scale_workers() {
  local replicas=$1 count
  if [[ "$replicas" -eq 1 ]]; then
    audit_worker_logs_before_scale_in
  fi
  dc up -d --wait --wait-timeout 180 --no-deps --scale "worker=$replicas" worker
  count=$(dc ps --status running -q worker | wc -l)
  [[ "$count" -eq "$replicas" ]] || acceptance_die "$replicas Worker replicas were not created"
}

restore_worker_count() {
  scale_workers 1
}

prometheus_targets_are_up() {
  local target_file=$1 expected_workers=$2
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const expectedWorkers = Number(process.argv[2]);
    const targets = value.data?.activeTargets;
    const expected = new Map([
      ["prometheus", 1],
      ["tokenpilot-api", 1],
      ["tokenpilot-worker", expectedWorkers],
      ["node-exporter", 1],
    ]);
    if (!Number.isSafeInteger(expectedWorkers) || expectedWorkers < 1 || !Array.isArray(targets)) {
      process.exit(1);
    }
    const actual = new Map([...expected.keys()].map((job) => [job, 0]));
    for (const target of targets) {
      const job = String(target.labels?.job ?? "");
      if (target.health !== "up" || !actual.has(job)) process.exit(1);
      actual.set(job, actual.get(job) + 1);
    }
    for (const [job, count] of expected) {
      if (actual.get(job) !== count) process.exit(1);
    }
  ' "$target_file" "$expected_workers"
}

prometheus_metric_count_matches() {
  local metric_file=$1 expected=$2
  node -e '
    const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const expected = Number(process.argv[2]);
    const result = value.data?.result;
    const actual = Array.isArray(result) && result.length === 1
      ? Number(result[0]?.value?.[1])
      : Number.NaN;
    if (value.status !== "success" || !Number.isFinite(actual) || actual !== expected) {
      process.exit(1);
    }
  ' "$metric_file" "$expected"
}

fetch_prometheus_query() {
  local query=$1 output=$2 encoded
  encoded=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$query")
  dc exec -T prometheus wget -qO- \
    "http://127.0.0.1:9090/api/v1/query?query=$encoded" >"$output" 2>/dev/null
}

check_prometheus_targets() {
  local expected_workers=$1 target_file=$2 api_metric_file=$3 worker_metric_file=$4
  local started deadline now healthy_since=0
  [[ "$expected_workers" =~ ^[1-9][0-9]*$ ]] || return 64
  started=$(date +%s)
  deadline=$((started + 90))
  while :; do
    now=$(date +%s)
    if dc exec -T prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets \
      >"$target_file" 2>/dev/null &&
      prometheus_targets_are_up "$target_file" "$expected_workers"; then
      [[ "$healthy_since" -ne 0 ]] || healthy_since=$now
      if ((now - healthy_since >= 16)); then
        if fetch_prometheus_query \
          'count(ai_control_db_connections{job="tokenpilot-api"})' "$api_metric_file" &&
          fetch_prometheus_query \
            'count(count by (instance) (ai_control_queue_depth{job="tokenpilot-worker"}))' \
            "$worker_metric_file" &&
          prometheus_metric_count_matches "$api_metric_file" 1 &&
          prometheus_metric_count_matches "$worker_metric_file" "$expected_workers"; then
          printf 'targets_up_continuously_seconds=%s api_metric_targets=1 worker_metric_targets=%s\n' \
            "$((now - healthy_since))" "$expected_workers"
          return 0
        fi
      fi
    else
      healthy_since=0
    fi
    ((now >= deadline)) && break
    sleep 5
  done
  printf 'Prometheus targets and stable API/Worker metrics did not match the expected runtime\n' >&2
  return 1
}
