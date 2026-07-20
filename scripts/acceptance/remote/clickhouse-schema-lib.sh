#!/usr/bin/env bash

# Sourced by clickhouse-schema.sh after its remote-host guard. The caller
# supplies dc, project_resource_counts, and the run-scoped variables.
recreate_isolated_storage() {
  local reason=$1 containers volumes networks health
  [[ "$project" == tokenpilot-clickhouse-* && "$database" == ai_control_acceptance ]] || {
    printf 'Refusing to recreate storage outside the run-scoped acceptance project.\n' >&2
    exit 70
  }
  dc down -v --remove-orphans --timeout 30 >"$evidence/${reason}-fresh-down.txt" 2>&1
  read -r containers volumes networks < <(project_resource_counts)
  printf 'containers=%s volumes=%s networks=%s\n' "$containers" "$volumes" "$networks" >"$evidence/${reason}-fresh-teardown.txt"
  [[ "$containers $volumes $networks" == '0 0 0' ]] || {
    printf 'The isolated ClickHouse project was not fully destroyed before recreation.\n' >&2
    exit 70
  }
  dc up -d --wait clickhouse >"$evidence/${reason}-fresh-up.txt" 2>&1
  container_id=$(dc ps -q clickhouse)
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")
  [[ -n "$container_id" && "$health" == healthy ]] || {
    printf 'The isolated ClickHouse project was not healthy after fresh storage recreation.\n' >&2
    exit 70
  }
}
