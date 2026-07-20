#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository=$(CDPATH='' cd -- "$script_directory/../../.." && pwd)
# shellcheck source=scripts/acceptance/remote/lib.sh
source "$script_directory/lib.sh"
# shellcheck source=scripts/acceptance/remote/dependency-outage-drill.sh
source "$script_directory/dependency-outage-drill.sh"
# shellcheck source=scripts/acceptance/remote/clickhouse-fresh-rebuild.sh
source "$script_directory/clickhouse-fresh-rebuild.sh"
# shellcheck source=scripts/acceptance/remote/reconciliation-drill.sh
source "$script_directory/reconciliation-drill.sh"
# shellcheck source=scripts/acceptance/remote/batch-diagnostics.sh
source "$script_directory/batch-diagnostics.sh"
# shellcheck source=scripts/acceptance/remote/runtime-observability.sh
source "$script_directory/runtime-observability.sh"
# shellcheck source=scripts/acceptance/remote/diagnostic-stages.sh
source "$script_directory/diagnostic-stages.sh"
# shellcheck source=scripts/acceptance/remote/readiness-stages.sh
source "$script_directory/readiness-stages.sh"

# The single acceptance workflow provisions only a fresh isolated PostgreSQL and ClickHouse stack.
(($# == 0)) || acceptance_die "this runner accepts configuration only through named environment variables"
acceptance_guard_host
for command in awk basename cp curl cut date diff docker env find git grep hostname id mkdir mktemp \
  node openssl pnpm realpath rm sed sha256sum sleep sort ss stat tar timeout uniq wc; do
  acceptance_require_command "$command"
done

[[ -z ${ACCEPTANCE_PRODUCTION_BACKUP_HOST_PATH:-} ]] ||
  acceptance_die "remote acceptance must not receive a production backup"

run_id="$(date -u +%Y%m%d%H%M%S)-$$-$(openssl rand -hex 3)"
ACCEPTANCE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export ACCEPTANCE_STARTED_AT
project="tokenpilot-acceptance-$run_id"
acceptance_validate_project "$project"
acceptance_assert_project_unused "$project"
evidence_root=$repository/artifacts/acceptance/remote
evidence=$evidence_root/$run_id
[[ ! -e "$evidence" && ! -L "$evidence" ]] || acceptance_die "evidence path already exists"
mkdir -p "$evidence"
chmod 700 "$evidence"
temporary=$(mktemp -d /tmp/tokenpilot-acceptance.XXXXXX)
chmod 700 "$temporary"
environment_file=$temporary/runtime.env
litellm_environment=$temporary/litellm.env
acceptance_keys_environment=$temporary/acceptance-keys.env
secret_patterns=$temporary/secret-patterns.txt
sensitive_patterns=$temporary/sensitive-patterns.txt
backup_host=$temporary/backups
docker_config=$temporary/docker-config
image_tags=$temporary/acceptance-image-tags.txt
container_log_records=$temporary/container-log-audit-records
mkdir -p "$backup_host" "$docker_config" "$container_log_records"
chmod 700 "$backup_host" "$docker_config"
printf '{}\n' >"$docker_config/config.json"
: >"$secret_patterns"
: >"$sensitive_patterns"
: >"$litellm_environment"
: >"$acceptance_keys_environment"
chmod 600 "$secret_patterns" "$sensitive_patterns" "$litellm_environment" \
  "$acceptance_keys_environment"
export LITELLM_ENV_FILE=$litellm_environment
export REMOTE_ACCEPTANCE_KEYS_FILE=$acceptance_keys_environment
export REAL_STACK_ADMIN_EMAIL="acceptance-$run_id@example.test"
REAL_STACK_ADMIN_PASSWORD=$(openssl rand -base64 36 | tr -d '\n')
export REAL_STACK_ADMIN_PASSWORD
export REAL_STACK_APPLICATION_NAME=Acceptance
export REAL_STACK_APPLICATION_SLUG=acceptance
export DOCKER_CONFIG=$docker_config
export REMOTE_DOCKER_ACCEPTANCE=1
export ACCEPTANCE_PROJECT=$project
export ACCEPTANCE_RUN_ID=$run_id
export ACCEPTANCE_REPOSITORY=$repository
export BACKUP_HOST_PATH=$backup_host
export TURBO_CACHE_DIR=$temporary/turbo

production_before_recorded=0
compose_configured=0
project_claimed=0
cleanup_failed=0
container_log_leak=0
compose=()

dc() {
  "${compose[@]}" "$@"
}

record_cleanup_failure() {
  cleanup_failed=1
  printf 'cleanup-error=%s\n' "$1" >>"$evidence/cleanup-errors.txt"
}

render_container_log_audit() {
  local record
  mkdir -p "$evidence/runtime"
  : >"$evidence/runtime/container-log-audit.txt"
  while IFS= read -r -d '' record; do
    cat "$record" >>"$evidence/runtime/container-log-audit.txt"
  done < <(find "$container_log_records" -type f -name '*.record' -print0 | sort -z)
}

audit_container_logs() {
  local reason=$1
  shift
  local log_directory=$temporary/container-logs metadata candidate id service replica name
  local log record credential_leak sensitive_payload_leak bytes lines digest
  local pre_scale_in_audited final_audited collection_failed=0
  [[ "$reason" == pre-worker-scale-in || "$reason" == final ]] ||
    acceptance_die "container log audit reason is invalid"
  mkdir -p "$log_directory" "$container_log_records" "$evidence/runtime"
  chmod 700 "$log_directory" "$container_log_records"
  for candidate in "$@"; do
    [[ "$candidate" =~ ^[a-f0-9]{12,64}$ ]] || {
      collection_failed=1
      continue
    }
    if ! metadata=$(docker inspect --format \
      '{{.Id}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.container-number"}}|{{.Name}}' \
      "$candidate"); then
      collection_failed=1
      continue
    fi
    IFS='|' read -r id service replica name <<<"$metadata"
    if [[ ! "$id" =~ ^[a-f0-9]{64}$ || ! "$service" =~ ^[a-z0-9][a-z0-9_-]*$ ||
      ! "$replica" =~ ^[1-9][0-9]*$ || ! "$name" =~ ^/[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
      collection_failed=1
      continue
    fi
    log=$log_directory/$id.log
    record=$container_log_records/$id.record
    pre_scale_in_audited=no
    final_audited=no
    [[ -f "$container_log_records/$id.pre-worker-scale-in" ]] && pre_scale_in_audited=yes
    [[ -f "$container_log_records/$id.final" ]] && final_audited=yes
    credential_leak=no
    sensitive_payload_leak=no
    if ! docker logs --timestamps "$id" >"$log" 2>&1; then
      printf 'container_id=%s service=%s replica=%s container_name=%s bytes=0 lines=0 sha256=none credential_leak=no sensitive_payload_leak=no pre_scale_in_audited=%s final_audited=%s collection_error=yes\n' \
        "$id" "$service" "$replica" "${name#/}" "$pre_scale_in_audited" "$final_audited" \
        >"$record"
      rm -f -- "$log"
      collection_failed=1
      continue
    fi
    if [[ "$reason" == pre-worker-scale-in ]]; then
      : >"$container_log_records/$id.pre-worker-scale-in"
      pre_scale_in_audited=yes
    else
      : >"$container_log_records/$id.final"
      final_audited=yes
    fi
    if grep -aFq -f "$secret_patterns" "$log" ||
      grep -aEq 'https?://[^[:space:]/]+:[^[:space:]@]+@|Bearer [A-Za-z0-9._~-]{16,}' "$log"; then
      credential_leak=yes
    fi
    if grep -aFq -f "$sensitive_patterns" "$log"; then
      sensitive_payload_leak=yes
    fi
    if ! bytes=$(wc -c <"$log") || ! lines=$(wc -l <"$log") ||
      ! digest=$(sha256sum "$log" | awk '{print $1}'); then
      printf 'container_id=%s service=%s replica=%s container_name=%s bytes=0 lines=0 sha256=none credential_leak=%s sensitive_payload_leak=%s pre_scale_in_audited=%s final_audited=%s collection_error=yes\n' \
        "$id" "$service" "$replica" "${name#/}" "$credential_leak" \
        "$sensitive_payload_leak" "$pre_scale_in_audited" "$final_audited" >"$record"
      rm -f -- "$log"
      collection_failed=1
      continue
    fi
    printf 'container_id=%s service=%s replica=%s container_name=%s bytes=%s lines=%s sha256=%s credential_leak=%s sensitive_payload_leak=%s pre_scale_in_audited=%s final_audited=%s collection_error=no\n' \
      "$id" "$service" "$replica" "${name#/}" "$bytes" "$lines" "$digest" \
      "$credential_leak" "$sensitive_payload_leak" "$pre_scale_in_audited" "$final_audited" \
      >"$record"
    rm -f -- "$log"
  done
  render_container_log_audit || collection_failed=1
  [[ "$collection_failed" -eq 0 ]]
}

audit_worker_logs_before_scale_in() {
  local -a workers=()
  mapfile -t workers < <(docker ps -aq --no-trunc \
    --filter "label=com.docker.compose.project=$project" \
    --filter 'label=com.docker.compose.service=worker' | sort -u)
  ((${#workers[@]} > 0)) || acceptance_die "no Worker container exists before scale-in"
  audit_container_logs pre-worker-scale-in "${workers[@]}"
}

collect_container_log_audit() {
  local -a containers=()
  local id duplicate_count=0 coverage_failed=0
  mapfile -t containers < <(docker ps -aq --no-trunc \
    --filter "label=com.docker.compose.project=$project" | sort -u)
  ((${#containers[@]} > 0)) || return 1
  audit_container_logs final "${containers[@]}" || coverage_failed=1
  for id in "${containers[@]}"; do
    [[ -f "$container_log_records/$id.record" && -f "$container_log_records/$id.final" ]] ||
      coverage_failed=1
  done
  duplicate_count=$(awk '{ for (field=1; field<=NF; field+=1) if ($field ~ /^container_id=/) { sub(/^container_id=/, "", $field); print $field } }' \
    "$evidence/runtime/container-log-audit.txt" | sort | uniq -d | wc -l)
  [[ "$duplicate_count" -eq 0 ]] || coverage_failed=1
  if grep -Eq 'credential_leak=yes|sensitive_payload_leak=yes' \
    "$evidence/runtime/container-log-audit.txt"; then
    container_log_leak=1
  fi
  [[ "$coverage_failed" -eq 0 ]]
}

finalize() {
  local original_status=$?
  local final_status=$original_status remaining_containers=0 remaining_volumes=0 remaining_networks=0
  local -a audit_containers=()
  trap - EXIT HUP INT TERM
  set +e
  final_status=$original_status
  if [[ "$compose_configured" -eq 1 && "$project_claimed" -eq 1 ]]; then
    mkdir -p "$evidence/runtime"
    mapfile -t audit_containers < <(docker ps -aq --no-trunc \
      --filter "label=com.docker.compose.project=$project")
    if ((${#audit_containers[@]} > 0)); then
      collect_container_log_audit || record_cleanup_failure "isolated log audit failed"
    else
      : >"$evidence/runtime/container-log-audit.txt"
    fi
    dc down --volumes --remove-orphans --timeout 30 >"$evidence/runtime/compose-down.txt" 2>&1 ||
      record_cleanup_failure "Compose teardown failed"
  fi
  if [[ "$project_claimed" -eq 1 ]]; then
    acceptance_remove_project_resources "$project" || record_cleanup_failure "label-scoped cleanup failed"
    read -r remaining_containers remaining_volumes remaining_networks \
      < <(acceptance_project_resource_counts "$project")
    printf 'containers=%s volumes=%s networks=%s\n' \
      "$remaining_containers" "$remaining_volumes" "$remaining_networks" \
      >"$evidence/isolated-resource-teardown.txt"
    if [[ "$remaining_containers" -ne 0 || "$remaining_volumes" -ne 0 ||
      "$remaining_networks" -ne 0 ]]; then
      record_cleanup_failure "isolated resources remain"
    fi
  fi
  if [[ -s "$image_tags" ]]; then
    while IFS= read -r tag; do
      if [[ ! "$tag" =~ ^tokenpilot-acceptance-[a-z0-9-]+:[a-z0-9.]+$ ]]; then
        record_cleanup_failure "invalid unique image cleanup allowlist"
        continue
      fi
      if docker image inspect "$tag" >/dev/null 2>&1; then
        docker image rm "$tag" >>"$evidence/acceptance-image-cleanup.txt" 2>&1 ||
          record_cleanup_failure "unique image tag cleanup failed"
      fi
    done <"$image_tags"
  fi
  if [[ "$production_before_recorded" -eq 1 ]]; then
    if node "$script_directory/production-snapshot.mjs" >"$evidence/production-after.json"; then
      if ! node "$script_directory/compare-snapshots.mjs" \
        "$evidence/production-before.json" "$evidence/production-after.json" \
        >"$evidence/production-unchanged.txt" 2>"$evidence/production-compare.stderr"; then
        diff -u "$evidence/production-before.json" "$evidence/production-after.json" \
          >"$evidence/production-diff.txt"
        final_status=90
      fi
    else
      record_cleanup_failure "production after-snapshot failed"
      final_status=90
    fi
  fi
  if [[ "$final_status" -ne 90 && "$cleanup_failed" -ne 0 ]]; then final_status=91; fi
  if [[ "$final_status" -ne 90 && "$container_log_leak" -ne 0 ]]; then final_status=92; fi
  if ! acceptance_sanitize_evidence "$evidence" "$secret_patterns" "$sensitive_patterns"; then
    final_status=92
  fi
  if [[ "$temporary" == /tmp/tokenpilot-acceptance.* && -d "$temporary" ]]; then
    if ! rm -rf -- "$temporary" || [[ -e "$temporary" ]]; then final_status=94; fi
  else
    final_status=94
  fi
  if ! acceptance_write_result "$evidence/result.txt" "$final_status" "$project" "$run_id"; then
    final_status=95
    acceptance_write_result "$evidence/result.txt" "$final_status" "$project" "$run_id" || true
  fi
  if ! acceptance_hash_evidence "$evidence"; then
    final_status=93
    rm -f -- "$evidence/SHA256SUMS"
    acceptance_write_result "$evidence/result.txt" "$final_status" "$project" "$run_id" || true
  fi
  exit "$final_status"
}

trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# This is deliberately the first Docker-state snapshot before any build, pull,
# tag, Compose up, or scanner action.
node "$script_directory/production-snapshot.mjs" >"$evidence/production-before.json"
production_before_recorded=1
project_claimed=1

gate() {
  local name=$1 output=$2
  shift 2
  printf '[acceptance] %s\n' "$name"
  "$@" >"$output" 2>&1
}

postgres_scalar() {
  local query=$1 user database
  user=$(acceptance_env_value "$environment_file" POSTGRES_USER)
  database=$(acceptance_env_value "$environment_file" POSTGRES_DB)
  dc exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$user" -d "$database" -Atc "$query"
}

wait_outbox_count() {
  local expected=$1 query=$2 actual
  for ((attempt = 0; attempt < 300; attempt += 1)); do
    actual=$(postgres_scalar "$query")
    [[ "$actual" == "$expected" ]] && return 0
    sleep 1
  done
  acceptance_die "timed out waiting for isolated PostgreSQL outbox state"
}

pause_sink() {
  local token=$1 result
  result=$(dc exec -T redis redis-cli --raw SET clickhouse:sink:pause "$token" NX PX 3600000)
  [[ "$result" == OK ]] || acceptance_die "ClickHouse sink pause was already held"
  wait_outbox_count 0 "SELECT count(*) FROM pipeline_outbox WHERE status='leased' AND event_type IN ('usage_events_raw','usage_lines','provider_cost.provisional','provider_cost.official_delta','provider_cost.adjustment','provider_cost.unpriced','aiu.provisional','aiu.official_delta','aiu.decision','application_user.profile')"
}

resume_sink() {
  local token=$1 result
  result=$(dc exec -T redis redis-cli --raw EVAL \
    "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end" \
    1 clickhouse:sink:pause "$token")
  [[ "$result" == 1 ]] || acceptance_die "ClickHouse sink pause ownership was lost"
}

gate "generate isolated secrets" "$evidence/init-environment.txt" \
  "$repository/scripts/init-env.sh" "$environment_file"
ingress_port=$(acceptance_select_free_port 32000 33999) || acceptance_die "no ingress port available"
litellm_port=$(acceptance_select_free_port 34000 35999) || acceptance_die "no LiteLLM port available"
node "$script_directory/configure-environment.mjs" \
  "$environment_file" "$run_id" "$ingress_port" "$litellm_port"
acceptance_secret_patterns "$environment_file" "$secret_patterns"
printf '%s\n' "$REAL_STACK_ADMIN_PASSWORD" >>"$secret_patterns"
sort -u -o "$secret_patterns" "$secret_patterns"
printf '%s\n' \
  'Run the isolated dependency outage check.' \
  'Run the content-free real stack acceptance.' \
  'browser-acceptance' \
  'remote-acceptance' >"$sensitive_patterns"
export ENV_FILE=$environment_file
export HTTP_PORT=$ingress_port
export LITELLM_DEMO_PORT=$litellm_port
compose=(
  docker compose --project-name "$project" --env-file "$environment_file"
  -f "$repository/deploy/docker-compose.yml"
  -f "$repository/deploy/docker-compose.litellm-demo.yml"
  -f "$repository/deploy/docker-compose.maintenance.yml"
  -f "$repository/deploy/acceptance/docker-compose.remote.yml"
)
compose+=(--profile litellm-demo --profile observability --profile maintenance)
compose_configured=1
dc config --quiet
dc config | sha256sum | sed 's|  -$|  rendered-compose-config|' \
  >"$evidence/compose-config.sha256"

image_keys=(POSTGRES_IMAGE REDIS_IMAGE MIGRATE_IMAGE API_IMAGE WORKER_IMAGE SCHEDULER_IMAGE
  WEB_IMAGE CADDY_IMAGE LITELLM_IMAGE FAKE_PROVIDER_IMAGE CLICKHOUSE_IMAGE PROMETHEUS_IMAGE
  NODE_EXPORTER_IMAGE RELEASE_TOOLING_IMAGE)
for key in "${image_keys[@]}"; do acceptance_env_value "$environment_file" "$key"; printf '\n'; done \
  >"$image_tags"
chmod 600 "$image_tags"

{
  printf 'required=%s\n' "$ACCEPTANCE_PROXY"
  for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
    printf '%s=%s\n' "$name" "${!name:-}"
  done
  docker version --format 'docker_client={{.Client.Version}} docker_server={{.Server.Version}}'
  docker compose version
} >"$evidence/remote-runtime.txt"

source_manifest=$evidence/source-files.sha256
(cd "$repository" && git ls-files --cached --others --exclude-standard -z | sort -z |
  while IFS= read -r -d '' file; do sha256sum -- "$file"; done) >"$source_manifest"
export SOURCE_SHA
SOURCE_SHA=$(sha256sum "$source_manifest" | awk '{print $1}')

diagnostic_batch_initialize "$evidence"
run_pre_readiness_acceptance
run_post_readiness_diagnostics
