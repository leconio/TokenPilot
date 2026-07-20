#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  printf 'Usage: %s --project COMPOSE_PROJECT SERVICE [SERVICE ...]\n' "$0" >&2
}

project=""
if [[ "${1:-}" == "--project" && -n "${2:-}" ]]; then
  project=$2
  shift 2
fi
if [[ -z "$project" || "$#" -eq 0 ]]; then
  usage
  exit 64
fi
if ! command -v docker >/dev/null 2>&1; then
  printf 'docker is required; run this verifier on the deployment host, never on a workstation without an approved container runtime\n' >&2
  exit 69
fi
if ! command -v node >/dev/null 2>&1; then
  printf 'node is required to parse container state without relying on optional health fields\n' >&2
  exit 69
fi

declare -Ar expected_users=(
  [api]="1000:1000"
  [caddy]="1000:1000"
  [clickhouse]="101:101"
  [clickhouse-migrate]="1000:1000"
  [fake-provider]="1000:1000"
  [litellm]="65532:65532"
  [migrate]="1000:1000"
  [node-exporter]="65534:65534"
  [postgres]="70:70"
  [prometheus]="65534:65534"
  [redis]="999:1000"
  [release-tooling]="1000:1000"
  [scheduler]="1000:1000"
  [web]="1000:1000"
  [worker]="1000:1000"
)

failed=0
for service in "$@"; do
  expected=${expected_users[$service]:-}
  if [[ -z "$expected" ]]; then
    printf 'unsupported service: %s\n' "$service" >&2
    failed=1
    continue
  fi

  mapfile -t containers < <(
    docker ps --all --quiet \
      --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=$service"
  )
  if [[ "${#containers[@]}" -ne 1 ]]; then
    printf 'service=%s error=expected-one-container actual=%s\n' "$service" "${#containers[@]}" >&2
    failed=1
    continue
  fi

  container=${containers[0]}
  configured_user=$(docker inspect --format '{{.Config.User}}' "$container")
  image_id=$(docker inspect --format '{{.Image}}' "$container")
  image_user=$(docker image inspect --format '{{.Config.User}}' "$image_id")
  read_only=$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")
  cap_drop=$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container")
  security_opt=$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container")
  state=$(docker inspect --format '{{.State.Status}}' "$container")
  exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$container")
  health=$(docker inspect --format '{{json .State}}' "$container" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const state = JSON.parse(input);
      process.stdout.write(state.Health?.Status ?? "none");
    });
  ')
  environment_keys=$(docker inspect --format '{{json .Config.Env}}' "$container" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const values = JSON.parse(input) ?? [];
      const keys = values.map((entry) => entry.slice(0, entry.indexOf("="))).sort();
      process.stdout.write(`${keys.join("\n")}\n`);
    });
  ')
  privileged_clickhouse_values=$(docker inspect --format '{{json .Config.Env}}' "$container" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const values = new Map((JSON.parse(input) ?? []).map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
      for (const key of [
        "CLICKHOUSE_BOOTSTRAP_PASSWORD",
        "CLICKHOUSE_MIGRATION_USERNAME",
        "CLICKHOUSE_MIGRATION_PASSWORD",
      ]) process.stdout.write(`${key}=${values.has(key) ? values.get(key) : "<absent>"}\n`);
    });
  ')

  if [[ "$configured_user" != "$expected" ]]; then
    printf 'service=%s error=configured-user expected=%s actual=%s\n' \
      "$service" "$expected" "${configured_user:-<unset>}" >&2
    failed=1
  fi
  if [[ "$read_only" != "true" ]]; then
    printf 'service=%s error=root-filesystem-is-writable\n' "$service" >&2
    failed=1
  fi
  if [[ "$cap_drop" != '["ALL"]' ]]; then
    printf 'service=%s error=capabilities-not-fully-dropped actual=%s\n' "$service" "$cap_drop" >&2
    failed=1
  fi
  if [[ "$security_opt" != *'no-new-privileges'* ]]; then
    printf 'service=%s error=no-new-privileges-missing actual=%s\n' "$service" "$security_opt" >&2
    failed=1
  fi

  forbidden_environment=()
  if [[ "$service" == api ]]; then
    forbidden_environment=(
      LITELLM_MASTER_KEY
      OPENAI_API_KEY
      ANTHROPIC_API_KEY
    )
    while IFS='=' read -r privileged_key privileged_value; do
      if [[ -n "$privileged_value" ]]; then
        printf 'service=%s error=privileged-environment-not-empty key=%s\n' \
          "$service" "$privileged_key" >&2
        failed=1
      fi
    done <<<"$privileged_clickhouse_values"
  elif [[ "$service" == worker ]]; then
    forbidden_environment=(
      ADMIN_INITIAL_PASSWORD
      INGEST_API_KEY
      POLICY_API_KEY
      ADMIN_API_KEY
      API_KEY_PEPPER
      CLICKHOUSE_BOOTSTRAP_PASSWORD
      CLICKHOUSE_MIGRATION_USERNAME
      CLICKHOUSE_MIGRATION_PASSWORD
      LITELLM_MASTER_KEY
      OPENAI_API_KEY
      ANTHROPIC_API_KEY
    )
  fi
  for forbidden_key in "${forbidden_environment[@]}"; do
    if grep -Fxq "$forbidden_key" <<<"$environment_keys"; then
      printf 'service=%s error=forbidden-environment-key key=%s\n' \
        "$service" "$forbidden_key" >&2
      failed=1
    fi
  done

  pid1_uid="not-running"
  pid1_gid="not-running"
  if [[ "$state" == "running" ]]; then
    pid1_uid=$(docker exec "$container" sh -c "awk '/^Uid:/ { print \$2 }' /proc/1/status")
    pid1_gid=$(docker exec "$container" sh -c "awk '/^Gid:/ { print \$2 }' /proc/1/status")
    if [[ "$pid1_uid:$pid1_gid" != "$expected" ]]; then
      printf 'service=%s error=pid1-identity expected=%s actual=%s:%s\n' \
        "$service" "$expected" "$pid1_uid" "$pid1_gid" >&2
      failed=1
    fi
    if [[ "$health" != "healthy" ]]; then
      printf 'service=%s error=not-healthy actual=%s\n' "$service" "$health" >&2
      failed=1
    fi
  elif [[ "$service" == "migrate" || "$service" == "clickhouse-migrate" || \
    "$service" == "release-tooling" ]]; then
    if [[ "$state" != "exited" || "$exit_code" != "0" ]]; then
      printf 'service=%s error=one-shot-did-not-complete state=%s exit_code=%s\n' \
        "$service" "$state" "$exit_code" >&2
      failed=1
    fi
  else
    printf 'service=%s error=long-lived-service-not-running actual=%s\n' "$service" "$state" >&2
    failed=1
  fi

  printf 'service=%s container_id=%s image_id=%s image_user=%s configured_user=%s pid1_uid=%s pid1_gid=%s rootfs_read_only=%s cap_drop=%s no_new_privileges=true state=%s exit_code=%s health=%s\n' \
    "$service" "${container:0:12}" "$image_id" "${image_user:-<unset>}" "$configured_user" \
    "$pid1_uid" "$pid1_gid" "$read_only" "$cap_drop" "$state" "$exit_code" "$health"
done

exit "$failed"
