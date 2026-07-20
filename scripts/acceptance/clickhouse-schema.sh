#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

designated_host=${ACCEPTANCE_HOST_ADDRESS:-}
if [[ "$(uname -s)" != Linux || "${REMOTE_DOCKER_ACCEPTANCE:-}" != 1 ]]; then
  printf 'This ClickHouse acceptance script runs only on the designated remote Linux host; set REMOTE_DOCKER_ACCEPTANCE=1 there.\n' >&2
  exit 64
fi

for command in curl date diff docker find grep hostname mktemp openssl pnpm sed sha256sum sort ss tr wc; do
  command -v "$command" >/dev/null || {
    printf 'Required command is unavailable: %s\n' "$command" >&2
    exit 69
  }
done
host_addresses=" $(hostname -I 2>/dev/null) "
if [[ -z "$designated_host" ]]; then
  printf 'ACCEPTANCE_HOST_ADDRESS must name the dedicated acceptance host address.\n' >&2
  exit 64
fi
if [[ "$host_addresses" != *" $designated_host "* ]]; then
  printf 'Refusing to run outside designated remote host %s.\n' "$designated_host" >&2
  exit 64
fi
docker compose version >/dev/null

expected_proxy=${ACCEPTANCE_DEPENDENCY_PROXY:-}
daemon_proxy=not-required
if [[ -n "$expected_proxy" ]]; then
  if [[ "${HTTP_PROXY:-}" != "$expected_proxy" || "${HTTPS_PROXY:-}" != "$expected_proxy" ]]; then
    printf 'Remote dependency and image access must use ACCEPTANCE_DEPENDENCY_PROXY.\n' >&2
    exit 64
  fi
  daemon_proxy=$(docker info --format '{{.HTTPProxy}}|{{.HTTPSProxy}}')
  if [[ "$daemon_proxy" != "$expected_proxy|$expected_proxy" ]]; then
    printf 'The remote Docker daemon must use ACCEPTANCE_DEPENDENCY_PROXY.\n' >&2
    exit 69
  fi
  export ALL_PROXY=${ALL_PROXY:-$expected_proxy}
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTPS_PROXY"
  export all_proxy="$ALL_PROXY"
fi
export NO_PROXY=${ACCEPTANCE_NO_PROXY:-localhost,127.0.0.1,::1,clickhouse}
export no_proxy="$NO_PROXY"

repository_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
base_compose="$repository_root/deploy/docker-compose.clickhouse.yml"
test_compose="$repository_root/deploy/docker-compose.clickhouse.test.yml"
source "$repository_root/scripts/acceptance/remote/clickhouse-schema-lib.sh"
production_project=${ACCEPTANCE_PRODUCTION_PROJECT:-tokenpilot}
if [[ ! "$production_project" =~ ^tokenpilot(-[a-z0-9]+)*$ ]]; then
  printf 'The protected production project name is invalid.\n' >&2
  exit 64
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
run_id="$(printf '%s' "$stamp" | tr -cd '0-9')-$$-$(openssl rand -hex 3)"
project="tokenpilot-clickhouse-$run_id"
evidence=${CLICKHOUSE_SCHEMA_EVIDENCE_DIRECTORY:-$repository_root/artifacts/clickhouse-schema-$run_id}
environment_file=
secret_patterns=
default_netrc=
application_netrc=
migration_netrc=
production_before=
production_after=
production_snapshot_recorded=0
project_claimed=0
evidence_owned=0
credentials_redacted=0
compose=()

if [[ "$project" == "$production_project" ]]; then
  printf 'The isolated acceptance project must differ from the protected production project.\n' >&2
  exit 64
fi

production_snapshot() {
  docker ps -aq --filter "label=com.docker.compose.project=$production_project" |
    while IFS= read -r id; do
      [[ -z "$id" ]] || docker inspect --format \
        '{{.Id}}|{{.Name}}|{{.Image}}|{{.State.Status}}|{{.RestartCount}}' \
        "$id"
    done | sort
}

dc() {
  "${compose[@]}" "$@"
}

project_resource_counts() {
  local containers volumes networks
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project" | wc -l)
  volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" | wc -l)
  networks=$(docker network ls -q --filter "label=com.docker.compose.project=$project" | wc -l)
  printf '%s %s %s\n' "$containers" "$volumes" "$networks"
}

remove_project_resources() {
  local -a resources=()
  mapfile -t resources < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
  ((${#resources[@]} == 0)) || docker rm -f "${resources[@]}" >/dev/null 2>&1
  mapfile -t resources < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
  ((${#resources[@]} == 0)) || docker volume rm -f "${resources[@]}" >/dev/null 2>&1
  mapfile -t resources < <(docker network ls -q --filter "label=com.docker.compose.project=$project")
  ((${#resources[@]} == 0)) || docker network rm "${resources[@]}" >/dev/null 2>&1
}

select_free_port() {
  local base=$1 candidate attempt
  for ((attempt = 0; attempt < 1000; attempt += 1)); do
    candidate=$((base + (RANDOM + attempt) % 1000))
    if ! ss -H -ltn "sport = :$candidate" | grep -q .; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 69
}

collect_container_logs() {
  local container_id
  [[ "$evidence_owned" -eq 1 && -d "$evidence" ]] || return 0
  : >"$evidence/container-logs.txt"
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    printf 'container=%s\n' "$container_id" >>"$evidence/container-logs.txt"
    docker logs "$container_id" >>"$evidence/container-logs.txt" 2>&1 || true
  done < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
}

sanitize_evidence() {
  local file leaked=0
  credentials_redacted=0
  [[ "$evidence_owned" -eq 1 && -d "$evidence" && -s "$secret_patterns" ]] || return 0
  : >"$evidence/secret-scan.txt"
  while IFS= read -r -d '' file; do
    if grep -Fq -f "$secret_patterns" "$file" ||
      grep -Eq 'https?://[^[:space:]/]+:[^[:space:]@]+@|Bearer [A-Za-z0-9._~-]{16,}' "$file"; then
      printf 'credential material removed from %s\n' "${file#"$evidence"/}" \
        >>"$evidence/secret-scan.txt"
      : >"$file"
      leaked=1
    fi
  done < <(find "$evidence" -type f ! -name secret-scan.txt -print0)
  if [[ "$leaked" -eq 1 ]]; then
    credentials_redacted=1
    printf 'FAIL credential-bearing evidence was truncated before hashing\n' \
      >>"$evidence/secret-scan.txt"
    return 1
  fi
  printf 'PASS no generated credential or credential-bearing URL in retained evidence\n' \
    >"$evidence/secret-scan.txt"
}

cleanup() {
  local status=${1:-0}
  local containers=0 volumes=0 networks=0
  set +e
  trap - EXIT INT TERM
  if [[ "$project_claimed" -eq 1 ]]; then
    collect_container_logs
  fi
  sanitize_evidence
  if [[ "$credentials_redacted" -eq 1 && "$status" -eq 0 ]]; then
    status=92
  fi
  if [[ "$project_claimed" -eq 1 && ${#compose[@]} -gt 0 && -f "$environment_file" ]]; then
    dc down -v --remove-orphans --timeout 30 >/dev/null 2>&1
  fi
  if [[ "$project_claimed" -eq 1 ]]; then
    remove_project_resources
  fi
  if [[ "$production_snapshot_recorded" -eq 1 ]]; then
    production_snapshot >"$production_after"
    if [[ "$evidence_owned" -eq 1 ]]; then
      cp "$production_before" "$evidence/production-before.txt"
      cp "$production_after" "$evidence/production-after.txt"
    fi
    if ! diff -u "$production_before" "$production_after" >"$evidence/production-container-diff.txt"; then
      [[ "$status" -ne 0 ]] || status=90
    else
      rm -f "$evidence/production-container-diff.txt"
      printf 'PASS production container IDs, images, state, and restarts unchanged\n' \
        >"$evidence/production.txt"
    fi
  fi
  if [[ "$project_claimed" -eq 1 ]]; then
    read -r containers volumes networks < <(project_resource_counts)
  fi
  if [[ "$evidence_owned" -eq 1 ]]; then
    printf 'containers=%s volumes=%s networks=%s\n' "$containers" "$volumes" "$networks" \
      >"$evidence/teardown.txt"
  fi
  if [[ "$containers" -ne 0 || "$volumes" -ne 0 || "$networks" -ne 0 ]]; then
    [[ "$status" -ne 0 ]] || status=91
  fi
  rm -f "$environment_file" "$secret_patterns" "$default_netrc" "$application_netrc" \
    "$migration_netrc" "$production_before" "$production_after"
  if [[ "$evidence_owned" -eq 1 && -d "$evidence" ]]; then
    find "$evidence" -type f -exec chmod 600 {} +
    if ! (
      cd "$evidence" || exit 1
      while IFS= read -r -d '' file; do
        sha256sum -- "$file" || exit 1
      done < <(find . -type f ! -name SHA256SUMS -print0 | sort -z)
    ) >"$evidence/SHA256SUMS"; then
      [[ "$status" -ne 0 ]] || status=93
    fi
    chmod 600 "$evidence/SHA256SUMS" 2>/dev/null
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

environment_file=$(mktemp -p /tmp tokenpilot-clickhouse.XXXXXX.env)
secret_patterns=$(mktemp -p /tmp tokenpilot-clickhouse-secrets.XXXXXX)
default_netrc=$(mktemp -p /tmp tokenpilot-clickhouse-default.XXXXXX.netrc)
application_netrc=$(mktemp -p /tmp tokenpilot-clickhouse-app.XXXXXX.netrc)
migration_netrc=$(mktemp -p /tmp tokenpilot-clickhouse-migration.XXXXXX.netrc)
production_before=$(mktemp)
production_after=$(mktemp)
chmod 600 "$environment_file" "$secret_patterns" "$default_netrc" "$application_netrc" \
  "$migration_netrc" "$production_before" "$production_after"

if [[ -e "$evidence" || -L "$evidence" ]]; then
  printf 'Refusing to overwrite an existing evidence directory: %s\n' "$evidence" >&2
  exit 73
fi
mkdir -p "$evidence"
chmod 700 "$evidence"
evidence_owned=1

port=$(select_free_port 28000)
bootstrap_password="b$(openssl rand -hex 24)"
application_password="a$(openssl rand -hex 24)"
migration_password="m$(openssl rand -hex 24)"
database=ai_control_acceptance
application_user=ai_control_acceptance_app
migration_user=ai_control_acceptance_migrator
if [[ "$bootstrap_password" == "$application_password" || \
  "$bootstrap_password" == "$migration_password" || \
  "$application_password" == "$migration_password" ]]; then
  printf 'Generated ClickHouse credentials unexpectedly collided.\n' >&2
  exit 70
fi
printf '%s\n%s\n%s\n' "$bootstrap_password" "$application_password" "$migration_password" \
  >"$secret_patterns"
cat >"$environment_file" <<EOF
CLICKHOUSE_TEST_PORT=$port
CLICKHOUSE_DATABASE=$database
CLICKHOUSE_BOOTSTRAP_PASSWORD=$bootstrap_password
CLICKHOUSE_USERNAME=$application_user
CLICKHOUSE_PASSWORD=$application_password
CLICKHOUSE_MIGRATION_USERNAME=$migration_user
CLICKHOUSE_MIGRATION_PASSWORD=$migration_password
EOF
cat >"$default_netrc" <<EOF
machine 127.0.0.1 login default password $bootstrap_password
EOF
cat >"$application_netrc" <<EOF
machine 127.0.0.1 login $application_user password $application_password
EOF
cat >"$migration_netrc" <<EOF
machine 127.0.0.1 login $migration_user password $migration_password
EOF

compose=(
  docker compose
  --project-name "$project"
  --env-file "$environment_file"
  -f "$base_compose"
  -f "$test_compose"
)
read -r containers volumes networks < <(project_resource_counts)
if [[ "$containers" -ne 0 || "$volumes" -ne 0 || "$networks" -ne 0 ]]; then
  printf 'Refusing to reuse an existing Compose project: %s\n' "$project" >&2
  exit 73
fi
project_claimed=1

production_snapshot >"$production_before"
if [[ ! -s "$production_before" ]]; then
  printf 'The protected production Compose project has no containers.\n' >&2
  exit 69
fi
production_snapshot_recorded=1

{
  printf 'required_proxy=%s\n' "$expected_proxy"
  printf 'docker_daemon_proxy=%s\n' "$daemon_proxy"
} >"$evidence/proxy.txt"
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' \
  >"$evidence/docker-version.txt"
{
  printf 'mandatory_services='
  docker compose --env-file "$environment_file" -f "$base_compose" -f "$test_compose" \
    config --services | tr '\n' ','
  printf '\nbase_host_ports='
  if grep -Eq '^[[:space:]]+ports:' "$base_compose"; then printf 'present'; else printf 'none'; fi
  printf '\n'
} >"$evidence/mandatory-services.txt"
dc config | sha256sum | sed 's|  -$|  rendered-compose-config|' >"$evidence/compose-config.sha256"
(
  cd "$repository_root"
  find deploy/clickhouse packages/clickhouse scripts/acceptance/clickhouse-schema.sh \
    scripts/acceptance/remote/clickhouse-schema-lib.sh \
    deploy/docker-compose.clickhouse.yml deploy/docker-compose.clickhouse.test.yml \
    \( -type d \( -name node_modules -o -name dist -o -name .turbo \) -prune \) -o \
    \( -type f ! -name '._*' -print0 \) |
    sort -z |
    while IFS= read -r -d '' file; do sha256sum -- "$file"; done
) >"$evidence/source-manifest.sha256"

cd "$repository_root"
pnpm --filter @tokenpilot/clickhouse... build >"$evidence/package-build.txt" 2>&1
dc up -d --wait clickhouse >"$evidence/compose-up.txt" 2>&1
container_id=$(dc ps -q clickhouse)
if [[ -z "$container_id" ]]; then
  printf 'ClickHouse container was not created.\n' >&2
  exit 70
fi
health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")
if [[ "$health" != healthy ]]; then
  printf 'ClickHouse container did not become healthy.\n' >&2
  exit 70
fi
{
  docker inspect --format \
    'image={{.Image}} status={{.State.Status}} health={{.State.Health.Status}} restart={{.RestartCount}} readonly={{.HostConfig.ReadonlyRootfs}} security={{json .HostConfig.SecurityOpt}} cap_drop={{json .HostConfig.CapDrop}} cap_add={{json .HostConfig.CapAdd}}' \
    "$container_id"
  docker port "$container_id" 8123/tcp
} >"$evidence/runtime-security.txt"
configured_user=$(docker inspect --format '{{.Config.User}}' "$container_id")
pid_identity=$(docker exec "$container_id" sh -c \
  "awk '/^Uid:/ { uid=\$2 } /^Gid:/ { gid=\$2 } END { print uid \":\" gid }' /proc/1/status")
read_only=$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container_id")
cap_drop=$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container_id")
cap_add=$(docker inspect --format '{{json .HostConfig.CapAdd}}' "$container_id")
security_opt=$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container_id")
if [[ "$configured_user" != 101:101 || "$pid_identity" != 101:101 || "$read_only" != true || \
  "$cap_drop" != '["ALL"]' || ( "$cap_add" != null && "$cap_add" != '[]' ) || \
  "$security_opt" != *no-new-privileges* ]]; then
  printf 'ClickHouse did not run as the fixed capability-free 101:101 identity.\n' >&2
  exit 70
fi
if ! grep -Fq "127.0.0.1:$port" "$evidence/runtime-security.txt" || \
  grep -Eq '(^|[[:space:]])0\.0\.0\.0:' "$evidence/runtime-security.txt"; then
  printf 'ClickHouse test port is not bound exclusively to loopback.\n' >&2
  exit 70
fi
docker top "$container_id" -eo pid,args >"$evidence/process-arguments.txt"
if grep -Fq -f "$secret_patterns" "$evidence/process-arguments.txt"; then
  printf 'A ClickHouse credential appeared in process arguments.\n' >&2
  exit 70
fi
if printf '%s\n%s\n%s\n' "$bootstrap_password" "$application_password" "$migration_password" |
  docker exec -i "$container_id" grep -R -F -f - /var/lib/clickhouse /var/log/clickhouse-server \
    >/dev/null 2>&1; then
  printf 'A clear ClickHouse credential was persisted in the data or log volume.\n' >&2
  exit 70
fi
printf 'PASS no clear generated credential in persistent data/log volumes\n' \
  >"$evidence/persistent-secret-scan.txt"

base_url="http://127.0.0.1:$port"
if curl --silent --show-error --fail --netrc-file "$default_netrc" \
  --data-binary 'SELECT 1' "$base_url/" >/dev/null 2>&1; then
  printf 'The privileged default account was unexpectedly reachable through the published port.\n' >&2
  exit 70
fi
printf 'PASS privileged default account restricted to container loopback\n' \
  >"$evidence/default-network-denial.txt"

cli_environment=(
  env
  CLICKHOUSE_URL="$base_url"
  CLICKHOUSE_DATABASE="$database"
  CLICKHOUSE_MIGRATION_USERNAME="$migration_user"
  CLICKHOUSE_MIGRATION_PASSWORD="$migration_password"
  CLICKHOUSE_SECURE=false
  CLICKHOUSE_MIGRATIONS_DIR="$repository_root/packages/clickhouse/test/fixtures/migrations"
)
ch_cli() { "${cli_environment[@]}" pnpm --filter @tokenpilot/clickhouse clickhouse "$@"; }
ch_cli status >"$evidence/migration-status-before.json" 2>"$evidence/migration-status-before.stderr"
grep -Fq '"migrationTableExists": false' "$evidence/migration-status-before.json"
ch_cli up >"$evidence/migration-up-first.json" 2>"$evidence/migration-up-first.stderr"
grep -Fq '"appliedVersions": [' "$evidence/migration-up-first.json"
grep -Fq '1' "$evidence/migration-up-first.json"
ch_cli verify >"$evidence/migration-verify.json" 2>"$evidence/migration-verify.stderr"
grep -Fq '"state": "applied"' "$evidence/migration-verify.json"
ch_cli up >"$evidence/migration-up-noop.json" 2>"$evidence/migration-up-noop.stderr"
grep -Fq '"appliedVersions": []' "$evidence/migration-up-noop.json"

ch_migration_query() {
  curl --silent --show-error --fail --netrc-file "$migration_netrc" \
    --data-binary "$1" "$base_url/" >/dev/null
}
ch_application_query() {
  curl --silent --show-error --fail --netrc-file "$application_netrc" \
    --data-binary "$1" "$base_url/"
}

install_fixture_from_empty_database() {
  local reason=$1
  ch_cli status >"$evidence/${reason}-empty-status.json" 2>"$evidence/${reason}-empty-status.stderr"
  grep -Fq '"migrationTableExists": false' "$evidence/${reason}-empty-status.json"
  ch_cli up >"$evidence/${reason}-fresh-install.json" 2>"$evidence/${reason}-fresh-install.stderr"
  grep -Fq '"appliedVersions": [' "$evidence/${reason}-fresh-install.json" && grep -Fq '1' "$evidence/${reason}-fresh-install.json"
  ch_cli verify >"$evidence/${reason}-fresh-verify.json" 2>"$evidence/${reason}-fresh-verify.stderr"
  grep -Fq '"state": "applied"' "$evidence/${reason}-fresh-verify.json"
}

reject_conflict() {
  local label=$1 state=$2 complaint=$3
  if ch_cli verify >"$evidence/$label.stdout" 2>"$evidence/$label.stderr"; then
    printf 'The migration runner accepted %s.\n' "$complaint" >&2; exit 70
  fi
  grep -Fq "$state" "$evidence/$label.stderr"
  grep -Fq 'delete and recreate' "$evidence/$label.stderr"
}

lock_table="$database.__clickhouse_schema_migration_lock"
ch_migration_query "CREATE TABLE $lock_table (acquired_at DateTime64(3, 'UTC')) ENGINE = Memory"
if ch_cli up \
  >"$evidence/migration-lock.stdout" 2>"$evidence/migration-lock.stderr"; then
  printf 'The migration runner ignored an existing schema lock.\n' >&2
  exit 70
fi
grep -Fq 'holds the schema lock' "$evidence/migration-lock.stderr"
ch_migration_query "DROP TABLE $lock_table"
printf 'PASS deterministic concurrent-runner lock rejection\n' >"$evidence/migration-lock.txt"

history_table="$database.clickhouse_schema_migrations"
ch_migration_query "TRUNCATE TABLE $history_table"
ch_migration_query "INSERT INTO $history_table (version,name,checksum,execution_ms) VALUES (1,'create_clickhouse_test_probe','$(printf 'f%.0s' {1..64})',0)"
reject_conflict checksum-mismatch checksum_mismatch 'changed migration history'
recreate_isolated_storage checksum-conflict
install_fixture_from_empty_database checksum-conflict

ch_migration_query "INSERT INTO $history_table (version,name,checksum,execution_ms) VALUES (9999,'orphaned_probe','$(printf 'e%.0s' {1..64})',0)"
reject_conflict orphaned orphaned 'orphaned history'
recreate_isolated_storage orphan-conflict
install_fixture_from_empty_database orphan-conflict

ch_migration_query "INSERT INTO $history_table (version,name,checksum,execution_ms) SELECT version,name,checksum,execution_ms FROM $history_table WHERE version=1"
reject_conflict duplicate duplicate_record 'duplicate history'
recreate_isolated_storage duplicate-conflict
install_fixture_from_empty_database duplicate-conflict
printf 'PASS checksum, orphan, and duplicate conflicts require deletion; each replacement starts from an empty isolated volume\n' \
  >"$evidence/history-integrity.txt"

ch_application_query \
  "INSERT INTO $database.clickhouse_test_probe VALUES (generateUUIDv4(), now64(3))" >/dev/null
row_count_before=$(ch_application_query \
  "SELECT toString(count()) FROM $database.clickhouse_test_probe")
dc down --remove-orphans --timeout 30 >"$evidence/persistence-down.txt" 2>&1
dc up -d --wait clickhouse >"$evidence/persistence-up.txt" 2>&1
container_id=$(dc ps -q clickhouse)
row_count_after=$(ch_application_query \
  "SELECT toString(count()) FROM $database.clickhouse_test_probe")
if [[ ! "$row_count_before" =~ ^[0-9]+$ || "$row_count_before" -lt 1 || \
  "$row_count_after" != "$row_count_before" ]]; then
  printf 'ClickHouse data did not survive container recreation on the named volume.\n' >&2
  exit 70
fi
ch_cli verify >"$evidence/persistence-verify.json" 2>"$evidence/persistence-verify.stderr"
printf 'rows_before=%s rows_after=%s migration_verify=pass\n' \
  "$row_count_before" "$row_count_after" >"$evidence/persistence.txt"

# The runner-behavior probes above intentionally use a one-file fixture at
# migration version 1. Destroy that disposable volume before exercising the
# complete immutable analytics schema; rewriting migration history would hide
# the conflict that the fresh-only runner is required to reject.
recreate_isolated_storage fixture-to-current-schema
ch_cli status >"$evidence/current-schema-empty-status.json" 2>"$evidence/current-schema-empty-status.stderr"
grep -Fq '"migrationTableExists": false' "$evidence/current-schema-empty-status.json"
env \
  CLICKHOUSE_INTEGRATION=true \
  CLICKHOUSE_URL="$base_url" \
  CLICKHOUSE_DATABASE="$database" \
  CLICKHOUSE_USERNAME="$application_user" \
  CLICKHOUSE_PASSWORD="$application_password" \
  CLICKHOUSE_MIGRATION_USERNAME="$migration_user" \
  CLICKHOUSE_MIGRATION_PASSWORD="$migration_password" \
  CLICKHOUSE_SECURE=false \
  pnpm --filter @tokenpilot/clickhouse test:integration \
  >"$evidence/real-integration.txt" 2>&1
grep -Eq '2 passed|Tests[[:space:]]+2 passed' "$evidence/real-integration.txt"

printf 'PASS ClickHouse schema fresh-volume acceptance project=%s evidence=%s\n' "$project" "$evidence"
