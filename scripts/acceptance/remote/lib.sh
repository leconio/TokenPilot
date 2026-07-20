#!/usr/bin/env bash

readonly ACCEPTANCE_ADDRESS=${ACCEPTANCE_HOST_ADDRESS:-}
readonly ACCEPTANCE_PROXY=${ACCEPTANCE_DEPENDENCY_PROXY:-}
readonly ACCEPTANCE_BYPASS=${ACCEPTANCE_NO_PROXY:-127.0.0.1,localhost,::1,api,web,worker,scheduler,postgres,redis,clickhouse,caddy,fake-provider,litellm}
readonly PROTECTED_PRODUCTION_PROJECT=${ACCEPTANCE_PRODUCTION_PROJECT:-tokenpilot}

acceptance_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

acceptance_require_command() {
  command -v "$1" >/dev/null 2>&1 || acceptance_die "required command is unavailable: $1"
}

acceptance_write_result() {
  local output=$1 status=$2 project=$3 run_id=$4 completed_at started_at
  started_at=${ACCEPTANCE_STARTED_AT:-}
  [[ "$started_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    acceptance_die "acceptance start time is unavailable"
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf 'status=%s\nexit_code=%s\nproject=%s\nrun_id=%s\nstarted_at=%s\ncompleted_at=%s\nschema=current\ndatastores=postgresql,redis,clickhouse\n' \
    "$([[ "$status" -eq 0 ]] && printf PASS || printf FAIL)" \
    "$status" "$project" "$run_id" "$started_at" "$completed_at" >"$output"
}

acceptance_wait_http() {
  local url=$1
  for ((attempt = 0; attempt < 180; attempt += 1)); do
    if curl --silent --show-error --fail --max-time 5 --output /dev/null "$url"; then return 0; fi
    sleep 2
  done
  acceptance_die "timed out waiting for $url"
}

acceptance_build_isolated_images() {
  local attempt
  for attempt in 1 2 3; do
    printf '[acceptance] isolated image build attempt %s/3\n' "$attempt"
    if dc build --pull "$@"; then return 0; fi
    [[ "$attempt" -lt 3 ]] || return 1
    sleep $((attempt * 5))
  done
}

acceptance_export_proxy() {
  if [[ -n "$ACCEPTANCE_PROXY" ]]; then
    export HTTP_PROXY=$ACCEPTANCE_PROXY
    export HTTPS_PROXY=$ACCEPTANCE_PROXY
    export ALL_PROXY=$ACCEPTANCE_PROXY
    export http_proxy=$ACCEPTANCE_PROXY
    export https_proxy=$ACCEPTANCE_PROXY
    export all_proxy=$ACCEPTANCE_PROXY
  fi
  export NO_PROXY=$ACCEPTANCE_BYPASS
  export no_proxy=$NO_PROXY
}

acceptance_guard_host() {
  if [[ "$(uname -s)" != Linux || "${REMOTE_DOCKER_ACCEPTANCE:-}" != 1 ]]; then
    acceptance_die "remote acceptance requires Linux and REMOTE_DOCKER_ACCEPTANCE=1"
  fi
  local addresses
  [[ -n "$ACCEPTANCE_ADDRESS" ]] ||
    acceptance_die "ACCEPTANCE_HOST_ADDRESS must name the dedicated acceptance host address"
  [[ "$PROTECTED_PRODUCTION_PROJECT" =~ ^tokenpilot(-[a-z0-9]+)*$ ]] ||
    acceptance_die "the protected production project name is invalid"
  addresses=" $(hostname -I 2>/dev/null) "
  [[ "$addresses" == *" $ACCEPTANCE_ADDRESS "* ]] ||
    acceptance_die "remote acceptance is restricted to $ACCEPTANCE_ADDRESS"
  acceptance_export_proxy
  acceptance_require_command docker
  docker compose version >/dev/null
  if [[ -n "$ACCEPTANCE_PROXY" ]]; then
    for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
      [[ "${!name:-}" == "$ACCEPTANCE_PROXY" ]] ||
        acceptance_die "$name must equal ACCEPTANCE_DEPENDENCY_PROXY"
    done
    local daemon_proxy
    daemon_proxy=$(docker info --format '{{.HTTPProxy}}|{{.HTTPSProxy}}')
    [[ "$daemon_proxy" == "$ACCEPTANCE_PROXY|$ACCEPTANCE_PROXY" ]] ||
      acceptance_die "the Docker daemon proxy does not match ACCEPTANCE_DEPENDENCY_PROXY"
  fi
}

acceptance_validate_project() {
  local project=$1
  [[ "$project" != "$PROTECTED_PRODUCTION_PROJECT" ]] ||
    acceptance_die "the production Compose project is protected"
  [[ "$project" =~ ^tokenpilot-acceptance-[0-9]{14}-[0-9]+-[a-f0-9]{6}$ ]] ||
    acceptance_die "the isolated project name is invalid"
}

acceptance_project_resource_counts() {
  local project=$1 containers volumes networks
  acceptance_validate_project "$project"
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project" | wc -l)
  volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" | wc -l)
  networks=$(docker network ls -q --filter "label=com.docker.compose.project=$project" | wc -l)
  printf '%s %s %s\n' "$containers" "$volumes" "$networks"
}

acceptance_assert_project_unused() {
  local project=$1 containers volumes networks
  read -r containers volumes networks < <(acceptance_project_resource_counts "$project")
  [[ "$containers" -eq 0 && "$volumes" -eq 0 && "$networks" -eq 0 ]] ||
    acceptance_die "refusing to reuse existing isolated project resources"
}

acceptance_remove_project_resources() {
  local project=$1
  local -a resources=()
  acceptance_validate_project "$project"
  mapfile -t resources < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
  ((${#resources[@]} == 0)) || docker rm -f "${resources[@]}" >/dev/null 2>&1
  mapfile -t resources < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
  ((${#resources[@]} == 0)) || docker volume rm -f "${resources[@]}" >/dev/null 2>&1
  mapfile -t resources < <(docker network ls -q --filter "label=com.docker.compose.project=$project")
  ((${#resources[@]} == 0)) || docker network rm "${resources[@]}" >/dev/null 2>&1
}

acceptance_select_free_port() {
  local start=$1 end=$2 candidate offset span
  [[ "$start" =~ ^[0-9]+$ && "$end" =~ ^[0-9]+$ && "$start" -lt "$end" ]] || return 64
  span=$((end - start + 1))
  for ((offset = 0; offset < span; offset += 1)); do
    candidate=$((start + (RANDOM + offset) % span))
    if ! ss -H -ltn "sport = :$candidate" | grep -q .; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 69
}

acceptance_env_value() {
  local file=$1 key=$2 value
  value=$(awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$file")
  [[ -n "$value" ]] || acceptance_die "required isolated environment value is absent: $key"
  printf '%s' "$value"
}

acceptance_secret_patterns() {
  local environment_file=$1 output=$2
  awk -F= '
    /^(POSTGRES_PASSWORD|API_KEY_PEPPER|CLICKHOUSE_BOOTSTRAP_PASSWORD|CLICKHOUSE_PASSWORD|CLICKHOUSE_MIGRATION_PASSWORD|AIU_RESERVATION_SIGNING_KEY|RECONCILIATION_USER_HMAC_SECRET)=/ {
      value = substr($0, index($0, "=") + 1)
      if (length(value) > 0) print value
    }
  ' "$environment_file" | sort -u >"$output"
  chmod 600 "$output"
  [[ "$(wc -l <"$output")" -eq 7 ]] || acceptance_die "isolated secrets are incomplete"
}

acceptance_append_secret_values() {
  local source=$1 output=$2
  [[ -f "$source" && ! -L "$source" ]] || acceptance_die "isolated secret file is invalid"
  awk -F= '
    $1 ~ /(API_KEY|PASSWORD|SECRET|SIGNING_KEY)$/ {
      value = substr($0, index($0, "=") + 1)
      if (length(value) > 0) print value
    }
  ' "$source" >>"$output"
  sort -u -o "$output" "$output"
  chmod 600 "$output"
}

acceptance_sanitize_evidence() {
  local evidence=$1 patterns=$2 sensitive_patterns=$3 file relative leaked=0 sensitive=0
  : >"$evidence/secret-scan.txt"
  : >"$evidence/sensitive-payload-scan.txt"
  while IFS= read -r -d '' file; do
    relative=${file#"$evidence"/}
    if grep -aFq -f "$patterns" "$file" ||
      grep -aEq 'https?://[^[:space:]/]+:[^[:space:]@]+@|Bearer [A-Za-z0-9._~-]{16,}' "$file"; then
      printf 'credential-bearing evidence removed: %s\n' "$relative" \
        >>"$evidence/secret-scan.txt"
      : >"$file"
      leaked=1
    fi
    # The source manifest contains hashes plus repository paths, not runtime
    # payloads. A path may legitimately share a word with a test sentinel, so
    # keep credential scanning enabled but exclude this metadata file from the
    # payload-sentinel pass.
    if [[ "$relative" != source-files.sha256 ]] &&
      grep -aFq -f "$sensitive_patterns" "$file"; then
      printf 'sensitive-payload-bearing evidence removed: %s\n' "$relative" \
        >>"$evidence/sensitive-payload-scan.txt"
      : >"$file"
      sensitive=1
    fi
  done < <(find "$evidence" -type f ! -name secret-scan.txt \
    ! -name sensitive-payload-scan.txt -print0)
  if [[ "$leaked" -ne 0 ]]; then
    printf 'FAIL generated evidence contained credential material\n' >>"$evidence/secret-scan.txt"
    return 1
  fi
  printf 'PASS no generated credential or credential-bearing URL retained\n' \
    >"$evidence/secret-scan.txt"
  if [[ "$sensitive" -ne 0 ]]; then
    printf 'FAIL generated evidence contained Prompt, Response, or raw subject sentinel material\n' \
      >>"$evidence/sensitive-payload-scan.txt"
    return 1
  fi
  printf 'PASS no Prompt, Response, or raw subject sentinel retained in generated evidence\n' \
    >"$evidence/sensitive-payload-scan.txt"
}

acceptance_hash_evidence() {
  local evidence=$1
  if ! (
    cd "$evidence" || exit 1
    while IFS= read -r -d '' file; do
      sha256sum -- "$file" || exit 1
    done < <(find . -type f ! -name SHA256SUMS -print0 | sort -z)
  ) >"$evidence/SHA256SUMS"; then
    rm -f -- "$evidence/SHA256SUMS"
    return 1
  fi
  if ! find "$evidence" -type f -exec chmod 600 {} +; then
    rm -f -- "$evidence/SHA256SUMS"
    return 1
  fi
}
