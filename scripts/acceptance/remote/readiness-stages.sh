#!/usr/bin/env bash

# Sourced by the guarded remote runner. These stages collect every independent
# failure before the post-readiness browser, outage, performance, and security
# diagnostics begin.
# shellcheck disable=SC2154 # Runner-owned globals are intentionally shared.

seed_acceptance_clickhouse_image() {
  local source target
  source='clickhouse:26.3.17.4@sha256:158dcce6f6fdc59309650aad6b79484abf4eed07d4e0bdba31d732e64b5a25fb'
  target=$(acceptance_env_value "$environment_file" CLICKHOUSE_IMAGE)
  if ! docker image inspect "$source" >/dev/null 2>&1; then
    docker pull "$source"
  fi
  docker tag "$source" "$target"
  docker image inspect --format 'source={{.Id}} repo_digests={{json .RepoDigests}}' "$source"
  docker image inspect --format 'target={{.Id}} repo_tags={{json .RepoTags}}' "$target"
}

validate_postgresql_backup_path() {
  local path=$1
  [[ "$path" =~ ^/backups/tokenpilot-[0-9A-Za-z.+-]+-[0-9]{8}T[0-9]{6}Z$ ]] ||
    acceptance_die "fresh PostgreSQL backup path is invalid"
  printf '%s\n' "$path"
}

retain_postgresql_restore_evidence() {
  local restore_database=$1
  local source=$backup_host/postgresql-authority/$restore_database
  [[ -d "$source" && ! -L "$source" ]] ||
    acceptance_die "fresh PostgreSQL backup/restore evidence is missing"
  cp -R "$backup_host/postgresql-authority" "$evidence/postgresql-authority"
}

record_isolated_runtime_images() {
  local tooling_image tooling_image_id
  node "$script_directory/verify-project-isolation.mjs" \
    "$project" "$ingress_port" "$litellm_port" "$image_manifest" \
    >"$evidence/project-isolation.json"
  tooling_image=$(acceptance_env_value "$environment_file" RELEASE_TOOLING_IMAGE)
  tooling_image_id=$(docker image inspect --format '{{.Id}}' "$tooling_image")
  printf 'release-tooling|%s|%s\n' "$tooling_image_id" "$tooling_image" >>"$image_manifest"
}

block_runtime_foundation() {
  local reason=$1
  diagnostic_block clickhouse-ownership "establish fresh ClickHouse ownership" \
    "$evidence/clickhouse-fresh-ownership-stage.txt" "$reason"
  diagnostic_block api-liveness "verify isolated API liveness" \
    "$evidence/api-liveness.txt" "$reason"
}

block_database_foundation() {
  local reason=$1
  for stage in postgresql-migrate-first postgresql-migrate-second postgresql-seed-first \
    postgresql-seed-second; do
    diagnostic_block "$stage" "${stage//-/ }" "$evidence/$stage.txt" "$reason"
  done
}

block_backup_foundation() {
  local reason=$1
  for stage in postgresql-quiesce postgresql-backup postgresql-backup-path \
    postgresql-backup-restore postgresql-restore-evidence postgresql-restart \
    postgresql-ready; do
    diagnostic_block "$stage" "${stage//-/ }" "$evidence/$stage.txt" "$reason"
  done
}

block_runtime_acceptance() {
  local reason=$1
  diagnostic_block project-isolation "verify isolated project and immutable images" \
    "$evidence/project-isolation-stage.txt" "$reason"
  diagnostic_block runtime-security "verify runtime container security" \
    "$evidence/runtime-security.txt" "$reason"
  for suite in db api worker; do
    diagnostic_block "$suite-integration" "real isolated $suite integration" \
      "$evidence/$suite-integration.txt" "$reason"
  done
}

run_pre_readiness_acceptance() {
  local dependencies_ready=0 seed_ready=0 build_ready=0 stack_ready=0 ownership_ready=0
  local api_live=0 litellm_live=0 application_ready=0 migrate_ready=0 seed_data_ready=0
  local quiesce_attempted=0
  local backup_ready=0 backup_path_ready=0 restore_ready=0 restart_ready=0 ready_after_backup=0
  local isolation_ready=0 current_backup restore_database suite redis_db
  local -a build_services runtime_services integration_environment

  diagnostic_run dependency-install "install locked dependencies through the authorized proxy" \
    "$evidence/pnpm-install.txt" pnpm --dir "$repository" install --frozen-lockfile --prefer-offline
  [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && dependencies_ready=1
  if [[ "$dependencies_ready" -eq 1 ]]; then
    diagnostic_run release-readiness "verify release source readiness" \
      "$evidence/release-readiness.txt" pnpm --dir "$repository" release:check
    diagnostic_run operations-static "run operations static acceptance" \
      "$evidence/operations-static.txt" pnpm --dir "$repository" test:operations
    diagnostic_run clickhouse-schema "run ClickHouse fresh-schema acceptance" \
      "$evidence/clickhouse-schema-runner.txt" env \
      CLICKHOUSE_SCHEMA_EVIDENCE_DIRECTORY="$evidence/clickhouse-schema" \
      "$repository/scripts/acceptance/clickhouse-schema.sh"
  else
    diagnostic_block release-readiness "verify release source readiness" \
      "$evidence/release-readiness.txt" "locked dependency installation failed"
    diagnostic_block operations-static "run operations static acceptance" \
      "$evidence/operations-static.txt" "locked dependency installation failed"
    diagnostic_block clickhouse-schema "run ClickHouse fresh-schema acceptance" \
      "$evidence/clickhouse-schema-runner.txt" "locked dependency installation failed"
  fi

  diagnostic_run immutable-image-seeding "seed immutable ClickHouse image" \
    "$evidence/immutable-image-seeding.txt" seed_acceptance_clickhouse_image
  [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && seed_ready=1
  runtime_services=(postgres redis migrate clickhouse clickhouse-migrate api worker scheduler web
    caddy fake-provider prometheus node-exporter)
  build_services=("${runtime_services[@]}" litellm)
  diagnostic_run compose-build "build unique isolated images" "$evidence/compose-build.txt" \
    acceptance_build_isolated_images "${build_services[@]}" release-tooling
  [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && build_ready=1
  if [[ "$seed_ready" -eq 1 && "$build_ready" -eq 1 ]]; then
    diagnostic_run compose-up "start isolated stack" "$evidence/compose-up.txt" \
      dc up -d --wait --wait-timeout 600 "${runtime_services[@]}"
    [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && stack_ready=1
  else
    diagnostic_block compose-up "start isolated stack" "$evidence/compose-up.txt" \
      "immutable image seeding or isolated image build failed"
  fi

  if [[ "$stack_ready" -eq 1 ]]; then
    diagnostic_run clickhouse-ownership "establish fresh ClickHouse ownership" \
      "$evidence/clickhouse-fresh-ownership-stage.txt" configure_clickhouse_fresh_ownership \
      "$environment_file" "$evidence" "$project" "$run_id"
    [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && ownership_ready=1
    diagnostic_run api-liveness "verify isolated API liveness" "$evidence/api-liveness.txt" \
      acceptance_wait_http "http://127.0.0.1:$ingress_port/healthz"
    [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && api_live=1
  else
    block_runtime_foundation "the isolated stack did not start"
  fi

  database_url=$(acceptance_env_value "$environment_file" DATABASE_URL)
  export DATABASE_URL=$database_url
  test_database_url=${database_url%/*}/postgres
  if [[ "$stack_ready" -eq 1 && "$ownership_ready" -eq 1 ]]; then
    diagnostic_run postgresql-migrate-first "PostgreSQL migration first pass" \
      "$evidence/postgresql-migrate-first.txt" dc run --rm --no-deps \
      --env-from-file "$environment_file" release-tooling pnpm --filter @tokenpilot/db db:migrate
    if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
      diagnostic_run postgresql-migrate-second "PostgreSQL migration second pass" \
        "$evidence/postgresql-migrate-second.txt" dc run --rm --no-deps \
        --env-from-file "$environment_file" release-tooling pnpm --filter @tokenpilot/db db:migrate
      if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] &&
        grep -Fq 'No pending migrations' "$evidence/postgresql-migrate-second.txt"; then
        migrate_ready=1
      fi
    else
      diagnostic_block postgresql-migrate-second "PostgreSQL migration second pass" \
        "$evidence/postgresql-migrate-second.txt" "the first migration pass failed"
    fi
    if [[ "$migrate_ready" -eq 1 ]]; then
      diagnostic_run postgresql-seed-first "PostgreSQL seed first pass" \
        "$evidence/postgresql-seed-first.txt" dc run --rm --no-deps \
        --env-from-file "$environment_file" release-tooling pnpm --filter @tokenpilot/db db:seed
      if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
        diagnostic_run postgresql-seed-second "PostgreSQL seed second pass" \
          "$evidence/postgresql-seed-second.txt" dc run --rm --no-deps \
          --env-from-file "$environment_file" release-tooling pnpm --filter @tokenpilot/db db:seed
        [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && seed_data_ready=1
      else
        diagnostic_block postgresql-seed-second "PostgreSQL seed second pass" \
          "$evidence/postgresql-seed-second.txt" "the first seed pass failed"
      fi
    else
      diagnostic_block postgresql-seed-first "PostgreSQL seed first pass" \
        "$evidence/postgresql-seed-first.txt" "PostgreSQL migrations were not verified"
      diagnostic_block postgresql-seed-second "PostgreSQL seed second pass" \
        "$evidence/postgresql-seed-second.txt" "PostgreSQL migrations were not verified"
    fi
  else
    block_database_foundation "the isolated database foundation is unavailable"
  fi

  api_url="http://127.0.0.1:$ingress_port"
  export RELEASE_API_URL=$api_url
  if [[ "$seed_data_ready" -eq 1 && "$api_live" -eq 1 ]]; then
    diagnostic_run application-preparation \
      "initialize the application and issue application-scoped acceptance keys" \
      "$evidence/application-preparation.json" env REMOTE_WEB_ACCEPTANCE_SETUP=prepare \
      node "$script_directory/prepare-web-acceptance.mjs"
    if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
      acceptance_append_secret_values "$litellm_environment" "$secret_patterns"
      acceptance_append_secret_values "$acceptance_keys_environment" "$secret_patterns"
      diagnostic_run litellm-start "start LiteLLM with application-scoped keys" \
        "$evidence/litellm-start.txt" dc up -d --wait --wait-timeout 180 litellm
      if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
        diagnostic_run litellm-liveness "verify isolated LiteLLM liveness" \
          "$evidence/litellm-liveness.txt" acceptance_wait_http \
          "http://127.0.0.1:$litellm_port/health/liveliness"
        if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
          litellm_live=1
          application_ready=1
        fi
      else
        diagnostic_block litellm-liveness "verify isolated LiteLLM liveness" \
          "$evidence/litellm-liveness.txt" "LiteLLM did not start"
      fi
    else
      diagnostic_block litellm-start "start LiteLLM with application-scoped keys" \
        "$evidence/litellm-start.txt" "application preparation failed"
      diagnostic_block litellm-liveness "verify isolated LiteLLM liveness" \
        "$evidence/litellm-liveness.txt" "application preparation failed"
    fi
  else
    diagnostic_block application-preparation \
      "initialize the application and issue application-scoped acceptance keys" \
      "$evidence/application-preparation.json" "migration, seed, or API liveness failed"
    diagnostic_block litellm-start "start LiteLLM with application-scoped keys" \
      "$evidence/litellm-start.txt" "application preparation failed"
    diagnostic_block litellm-liveness "verify isolated LiteLLM liveness" \
      "$evidence/litellm-liveness.txt" "application preparation failed"
  fi

  if [[ "$application_ready" -eq 1 && "$litellm_live" -eq 1 ]]; then
    quiesce_attempted=1
    diagnostic_run postgresql-quiesce "quiesce current PostgreSQL authority" \
      "$evidence/postgresql-quiesce.txt" dc stop api worker scheduler
    if [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]]; then
      diagnostic_run postgresql-backup "back up fresh current PostgreSQL" \
        "$evidence/postgresql-backup.txt" dc run --rm --no-deps \
        --env-from-file "$environment_file" release-tooling scripts/backup-postgres.sh \
        --output /backups
      [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && backup_ready=1
    else
      diagnostic_block postgresql-backup "back up fresh current PostgreSQL" \
        "$evidence/postgresql-backup.txt" "authority quiescence failed"
    fi
    if [[ "$backup_ready" -eq 1 ]]; then
      current_backup=$(awk 'END { print }' "$evidence/postgresql-backup.txt")
      diagnostic_run postgresql-backup-path "validate PostgreSQL backup path" \
        "$evidence/postgresql-backup-path.txt" validate_postgresql_backup_path "$current_backup"
      [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && backup_path_ready=1
    else
      diagnostic_block postgresql-backup-path "validate PostgreSQL backup path" \
        "$evidence/postgresql-backup-path.txt" "the PostgreSQL backup failed"
    fi
    restore_database="tokenpilot_restore_${run_id//-/_}"
    if [[ "$backup_path_ready" -eq 1 ]]; then
      diagnostic_run postgresql-backup-restore "restore fresh current PostgreSQL" \
        "$evidence/postgresql-backup-restore.txt" dc run --rm --no-deps \
        --env-from-file "$environment_file" -e REMOTE_DOCKER_ACCEPTANCE \
        -e ACCEPTANCE_PROJECT -e BACKUP_SET="$current_backup" \
        -e RESTORE_DATABASE="$restore_database" \
        -e ACCEPTANCE_BACKUP_EVIDENCE=/backups/postgresql-authority release-tooling \
        scripts/acceptance/remote/backup-restore-in-container.sh
      [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && restore_ready=1
    else
      diagnostic_block postgresql-backup-restore "restore fresh current PostgreSQL" \
        "$evidence/postgresql-backup-restore.txt" "no verified PostgreSQL backup is available"
    fi
    if [[ "$restore_ready" -eq 1 ]]; then
      diagnostic_run postgresql-restore-evidence "retain PostgreSQL restore evidence" \
        "$evidence/postgresql-restore-evidence.txt" retain_postgresql_restore_evidence \
        "$restore_database"
    else
      diagnostic_block postgresql-restore-evidence "retain PostgreSQL restore evidence" \
        "$evidence/postgresql-restore-evidence.txt" "the PostgreSQL restore failed"
    fi
  else
    block_backup_foundation "migration, seed, or runtime liveness was not verified"
  fi

  if [[ "$quiesce_attempted" -eq 1 ]]; then
    diagnostic_run postgresql-restart "restart current authority services" \
      "$evidence/postgresql-restart.txt" dc up -d --wait --wait-timeout 180 --no-deps \
      api worker scheduler
    [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && restart_ready=1
    if [[ "$restart_ready" -eq 1 ]]; then
      diagnostic_run postgresql-ready "verify readiness after PostgreSQL backup" \
        "$evidence/postgresql-ready.txt" acceptance_wait_http \
        "http://127.0.0.1:$ingress_port/health/ready"
      [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && ready_after_backup=1
    else
      diagnostic_block postgresql-ready "verify readiness after PostgreSQL backup" \
        "$evidence/postgresql-ready.txt" "authority services did not restart"
    fi
  fi

  image_manifest=$evidence/runtime-images.txt
  if [[ "$ready_after_backup" -eq 1 && "$restore_ready" -eq 1 ]]; then
    diagnostic_run project-isolation "verify isolated project and immutable images" \
      "$evidence/project-isolation-stage.txt" record_isolated_runtime_images
    [[ "$DIAGNOSTIC_LAST_STATUS" == PASS ]] && isolation_ready=1
    diagnostic_run runtime-security "verify runtime container security" \
      "$evidence/runtime-security.txt" "$repository/scripts/verify-runtime-container-security.sh" \
      --project "$project" api caddy clickhouse clickhouse-migrate fake-provider litellm migrate \
      node-exporter postgres prometheus redis scheduler web worker
  else
    block_runtime_acceptance "the isolated runtime did not reach a verified current state"
  fi

  export CLICKHOUSE_URL=http://clickhouse:8123
  export CLICKHOUSE_DATABASE CLICKHOUSE_USERNAME CLICKHOUSE_PASSWORD
  CLICKHOUSE_DATABASE=$(acceptance_env_value "$environment_file" CLICKHOUSE_DATABASE)
  CLICKHOUSE_USERNAME=$(acceptance_env_value "$environment_file" CLICKHOUSE_USERNAME)
  CLICKHOUSE_PASSWORD=$(acceptance_env_value "$environment_file" CLICKHOUSE_PASSWORD)
  if [[ "$isolation_ready" -eq 1 ]]; then
    for suite in db api worker; do
      redis_db=15
      [[ "$suite" == worker ]] && redis_db=14
      export TEST_DATABASE_URL=$test_database_url TEST_REDIS_URL="redis://redis:6379/$redis_db"
      integration_environment=()
      if [[ "$suite" != db ]]; then
        integration_environment=(
          -e CLICKHOUSE_URL -e CLICKHOUSE_DATABASE -e CLICKHOUSE_USERNAME -e CLICKHOUSE_PASSWORD
        )
      fi
      diagnostic_run "$suite-integration" "real isolated $suite integration" \
        "$evidence/$suite-integration.txt" dc run --rm --no-deps \
        "${integration_environment[@]}" -e TEST_DATABASE_URL -e TEST_REDIS_URL release-tooling \
        pnpm "test:$suite"
    done
  fi

  DIAGNOSTIC_RUNTIME_SAFE=$isolation_ready
  if [[ "$DIAGNOSTIC_RUNTIME_SAFE" -eq 1 ]]; then
    ingest_key=$(acceptance_env_value "$acceptance_keys_environment" RELEASE_INGEST_API_KEY)
    policy_key=$(acceptance_env_value "$acceptance_keys_environment" RELEASE_RUNTIME_API_KEY)
    admin_key=$(acceptance_env_value "$acceptance_keys_environment" RELEASE_ADMIN_API_KEY)
    application_slug=$(acceptance_env_value "$acceptance_keys_environment" RELEASE_APPLICATION_SLUG)
    export RELEASE_API_URL=$api_url RELEASE_INGEST_API_KEY=$ingest_key
    export RELEASE_RUNTIME_API_KEY=$policy_key RELEASE_ADMIN_API_KEY=$admin_key
    export RELEASE_APPLICATION_SLUG=$application_slug
    export RELEASE_ISOLATED_STACK=true
  fi
}
