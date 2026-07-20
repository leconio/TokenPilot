#!/usr/bin/env bash

# Sourced by the isolated remote runner after its Compose helpers are defined.
configure_clickhouse_fresh_ownership() {
  local environment_file=$1 evidence=$2 project=$3 run_id=$4
  local database owner owner_key
  database=$(acceptance_env_value "$environment_file" CLICKHOUSE_DATABASE)
  owner=$(acceptance_env_value "$environment_file" CLICKHOUSE_FRESH_REBUILD_OWNER)
  [[ "$database" =~ ^ai_control_acceptance_[a-z0-9_]+$ ]] ||
    acceptance_die "fresh ClickHouse acceptance database is not disposable"
  [[ "$owner" == "acceptance:$run_id" ]] ||
    acceptance_die "fresh ClickHouse acceptance ownership is invalid"
  owner_key="clickhouse:fresh-rebuild:owner:$database"
  [[ $(dc exec -T redis redis-cli --raw SET "$owner_key" "$owner" NX) == OK ]] ||
    acceptance_die "fresh ClickHouse acceptance ownership marker already exists"
  printf 'database=%s project=%s ownership_marker=verified\n' "$database" "$project" \
    >"$evidence/clickhouse-fresh-ownership.txt"
}

run_clickhouse_fresh_rebuild_acceptance() {
  local evidence=$1 environment_file=$2 backup_host=$3 project=$4
  export CLICKHOUSE_ACCEPTANCE_TARGET=$project
  export CLICKHOUSE_ACCEPTANCE_ACK=disposable-fresh-database
  export CLICKHOUSE_ACCEPTANCE_EVIDENCE=/backups/clickhouse-fresh-rebuild
  gate "ClickHouse conflicting schema fresh rebuild" "$evidence/clickhouse-fresh-rebuild.txt" \
    dc run --rm --no-deps --env-from-file "$environment_file" \
    -e CLICKHOUSE_ACCEPTANCE_TARGET -e CLICKHOUSE_ACCEPTANCE_ACK \
    -e CLICKHOUSE_ACCEPTANCE_EVIDENCE release-tooling \
    node scripts/acceptance/release/clickhouse-fresh-rebuild.mjs
  if [[ -d "$backup_host/clickhouse-fresh-rebuild" ]]; then
    cp -R "$backup_host/clickhouse-fresh-rebuild" "$evidence/clickhouse-fresh-rebuild"
  fi
}
