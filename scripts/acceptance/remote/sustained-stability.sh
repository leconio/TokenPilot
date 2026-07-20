#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/acceptance/remote/lib.sh
source "$script_directory/lib.sh"

project=${ACCEPTANCE_PROJECT:-}
ready_url=${STABILITY_READY_URL:-}
duration=${STABILITY_DURATION_SECONDS:-60}
interval=${STABILITY_SAMPLE_INTERVAL_SECONDS:-5}
expected_worker_replicas=${STABILITY_EXPECTED_WORKER_REPLICAS:-1}
stats_timeout=${STABILITY_DOCKER_STATS_TIMEOUT_SECONDS:-15}

acceptance_guard_host
acceptance_validate_project "$project"
[[ "$ready_url" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/health/ready$ ]] ||
  acceptance_die "stability readiness URL must use isolated loopback ingress"
[[ "$duration" =~ ^[0-9]+$ && "$duration" -ge 30 && "$duration" -le 600 ]] ||
  acceptance_die "stability duration must be between 30 and 600 seconds"
[[ "$interval" =~ ^[0-9]+$ && "$interval" -ge 1 && "$interval" -le 30 ]] ||
  acceptance_die "stability sample interval must be between 1 and 30 seconds"
[[ "$expected_worker_replicas" =~ ^[0-9]+$ && "$expected_worker_replicas" -ge 1 &&
  "$expected_worker_replicas" -le 8 ]] ||
  acceptance_die "expected Worker replicas must be between 1 and 8"
[[ "$stats_timeout" =~ ^[0-9]+$ && "$stats_timeout" -ge 5 && "$stats_timeout" -le 30 ]] ||
  acceptance_die "Docker stats timeout must be between 5 and 30 seconds"
acceptance_require_command timeout

temporary=$(mktemp -d /tmp/tokenpilot-stability.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
baseline=$temporary/baseline.txt
current=$temporary/current.txt
required_services_file=$temporary/required-services.txt
actual_services_file=$temporary/actual-services.txt
stats_file=$temporary/stats.txt
required_services=(postgres redis clickhouse api worker scheduler web caddy fake-provider litellm
  prometheus node-exporter)
printf '%s\n' "${required_services[@]}" | sort -u >"$required_services_file"
expected_container_count=$((${#required_services[@]} - 1 + expected_worker_replicas))

snapshot() {
  local output=$1
  local service expected actual
  local -a containers=()
  mapfile -t containers < <(
    docker ps -q --no-trunc --filter "label=com.docker.compose.project=$project" | sort -u
  )
  ((${#containers[@]} == expected_container_count)) ||
    acceptance_die "isolated runtime container count does not match the exact long-lived service set"
  docker inspect --format '{{.Id}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}' \
    "${containers[@]}" | sort >"$output"
  awk -F'|' 'NF != 5 || $3 != "running" || ($4 != "" && $4 != "healthy") || $5 !~ /^[0-9]+$/ { exit 1 }' \
    "$output" ||
    acceptance_die "an isolated runtime container is not running and healthy"
  cut -d'|' -f2 "$output" | sort -u >"$actual_services_file"
  diff -u "$required_services_file" "$actual_services_file" >/dev/null ||
    acceptance_die "isolated runtime service set does not match the required long-lived services"
  for service in "${required_services[@]}"; do
    expected=1
    [[ "$service" != worker ]] || expected=$expected_worker_replicas
    actual=$(awk -F'|' -v service="$service" '$2 == service { count += 1 } END { print count + 0 }' \
      "$output")
    [[ "$actual" -eq "$expected" ]] ||
      acceptance_die "isolated runtime service replica count is invalid: $service"
  done
}

snapshot "$baseline"
awk -F'|' '$5 != "0" { exit 1 }' "$baseline" ||
  acceptance_die "an isolated runtime container had already restarted before stability observation"
started=$(date +%s)
deadline=$((started + duration))
samples=0
max_memory_percent=0
while :; do
  curl --silent --show-error --fail --max-time 5 --output /dev/null "$ready_url"
  snapshot "$current"
  if [[ "$(cut -d'|' -f1 "$baseline" | sha256sum | awk '{print $1}')" != \
    "$(cut -d'|' -f1 "$current" | sha256sum | awk '{print $1}')" ]]; then
    acceptance_die "isolated runtime container identity changed during stability observation"
  fi
  mapfile -t containers < <(cut -d'|' -f1 "$current")
  if ! timeout --foreground --kill-after=5s "${stats_timeout}s" \
    docker stats --no-stream --format '{{.ID}}|{{.MemPerc}}' "${containers[@]}" >"$stats_file"; then
    acceptance_die "bounded Docker stats sample failed or timed out"
  fi
  [[ "$(wc -l <"$stats_file")" -eq "${#containers[@]}" ]] ||
    acceptance_die "Docker stats did not return every isolated runtime container"
  awk -F'|' 'NF != 2 || $1 !~ /^[a-f0-9]+$/ || $2 !~ /^[0-9]+([.][0-9]+)?%$/ { exit 1 }' \
    "$stats_file" || acceptance_die "Docker stats returned an invalid memory sample"
  sample_max=$(awk -F'|' '{ value=$2; sub(/%$/, "", value); if (value+0 > max) max=value+0 } END { printf "%.3f", max+0 }' \
    "$stats_file")
  awk -v value="$sample_max" 'BEGIN { exit !(value < 90) }' ||
    acceptance_die "isolated runtime memory exceeded 90 percent during stability observation"
  max_memory_percent=$(awk -v prior="$max_memory_percent" -v candidate="$sample_max" \
    'BEGIN { printf "%.3f", (candidate > prior ? candidate : prior) }')
  samples=$((samples + 1))
  now=$(date +%s)
  ((now >= deadline)) && break
  remaining=$((deadline - now))
  if ((remaining < interval)); then
    sleep "$remaining"
  else
    sleep "$interval"
  fi
done

snapshot "$current"
diff -u "$baseline" "$current" >/dev/null ||
  acceptance_die "isolated runtime restart count or health changed during stability observation"
printf 'status=PASS duration_seconds=%s samples=%s services=%s worker_replicas=%s max_container_memory_percent=%s restart_delta=0 baseline_restart_count=0\n' \
  "$duration" "$samples" "${#required_services[@]}" "$expected_worker_replicas" \
  "$max_memory_percent"
