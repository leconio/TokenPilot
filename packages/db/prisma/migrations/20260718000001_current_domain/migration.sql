-- CreateTable
CREATE TABLE "application_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "external_id" VARCHAR(256) NOT NULL,
    "name" VARCHAR(256),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "properties_json" JSONB NOT NULL DEFAULT '{}',
    "status" "application_user_status" NOT NULL DEFAULT 'active',
    "blocked_reason" VARCHAR(500),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "application_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_aiu_quotas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "policy_id" UUID,
    "period_type" "quota_period_type" NOT NULL DEFAULT 'lifetime',
    "period_start" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "period_end" TIMESTAMPTZ(6),
    "limit_aiu_micros" BIGINT NOT NULL DEFAULT 0,
    "consumed_aiu_micros" BIGINT NOT NULL DEFAULT 0,
    "reserved_aiu_micros" BIGINT NOT NULL DEFAULT 0,
    "hard_limit" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_aiu_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aiu_quota_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "scope" "aiu_quota_policy_scope" NOT NULL,
    "user_id" UUID,
    "user_group_id" UUID,
    "limit_aiu_micros" BIGINT NOT NULL,
    "hard_limit" BOOLEAN NOT NULL DEFAULT false,
    "period_type" "quota_period_type" NOT NULL DEFAULT 'lifetime',
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aiu_quota_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_aiu_ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "quota_id" UUID NOT NULL,
    "entry_type" "aiu_ledger_entry_type" NOT NULL,
    "consumed_delta_micros" BIGINT NOT NULL DEFAULT 0,
    "reserved_delta_micros" BIGINT NOT NULL DEFAULT 0,
    "consumed_after_micros" BIGINT NOT NULL,
    "reserved_after_micros" BIGINT NOT NULL,
    "limit_after_micros" BIGINT NOT NULL,
    "source_event_id" VARCHAR(36),
    "source_reservation_id" UUID,
    "idempotency_key" VARCHAR(256) NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_aiu_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_aiu_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "quota_id" UUID NOT NULL,
    "operation_id" VARCHAR(256) NOT NULL,
    "virtual_model" VARCHAR(120) NOT NULL,
    "candidate_model_ids_json" JSONB NOT NULL,
    "estimated_aiu_micros" BIGINT NOT NULL,
    "reserved_aiu_micros" BIGINT NOT NULL,
    "settled_aiu_micros" BIGINT NOT NULL DEFAULT 0,
    "token_hash" CHAR(64) NOT NULL,
    "status" "aiu_reservation_status" NOT NULL DEFAULT 'reserved',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_aiu_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_usage_ratings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "event_id" VARCHAR(36) NOT NULL,
    "user_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "virtual_model" VARCHAR(120),
    "cost_status" VARCHAR(32) NOT NULL,
    "provider_cost" DECIMAL(38,18),
    "currency" CHAR(3),
    "cost_version_id" UUID,
    "cost_lines_json" JSONB NOT NULL DEFAULT '[]',
    "input_tokens" DECIMAL(38,9) NOT NULL DEFAULT 0,
    "output_tokens" DECIMAL(38,9) NOT NULL DEFAULT 0,
    "cached_tokens" DECIMAL(38,9) NOT NULL DEFAULT 0,
    "total_tokens" DECIMAL(38,9) NOT NULL DEFAULT 0,
    "aiu_status" VARCHAR(32) NOT NULL,
    "aiu_micros" BIGINT,
    "aiu_version_id" UUID,
    "aiu_lines_json" JSONB NOT NULL DEFAULT '[]',
    "rated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "application_usage_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_user_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "definition_json" JSONB NOT NULL,
    "definition_version" INTEGER NOT NULL DEFAULT 1,
    "refresh_minutes" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_evaluated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "application_user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_user_group_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "definition_version" INTEGER NOT NULL,
    "member_count" INTEGER NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_user_group_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_user_group_members" (
    "application_id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "matched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_user_group_members_pkey" PRIMARY KEY ("evaluation_id","user_id")
);

-- CreateTable
CREATE TABLE "application_user_group_bulk_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "evaluation_id" UUID NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "actor_id" VARCHAR(256) NOT NULL,
    "target_count" INTEGER NOT NULL,
    "success_count" INTEGER NOT NULL,
    "failure_count" INTEGER NOT NULL,
    "result_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_user_group_bulk_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "saved_report_kind" NOT NULL,
    "definition_json" JSONB NOT NULL,
    "created_by" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_dashboard_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "application_dashboard_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_event_registry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "application_version" VARCHAR(64),
    "sdk_version" VARCHAR(64),
    "connector_version" VARCHAR(64),
    "config_version" VARCHAR(64),
    "external_user_id" VARCHAR(256) NOT NULL,
    "user_name" VARCHAR(256),
    "event_properties_json" JSONB,
    "user_properties_json" JSONB,
    "application_user_id" UUID NOT NULL,
    "virtual_model" VARCHAR(120),
    "model_id" UUID,
    "request_model" VARCHAR(256) NOT NULL,
    "connection_id" UUID,
    "connection_driver" VARCHAR(64),
    "reservation_id" UUID,
    "event_id" VARCHAR(36) NOT NULL,
    "schema_version" VARCHAR(32) NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "request_id" VARCHAR(256) NOT NULL,
    "attempt_id" VARCHAR(256) NOT NULL,
    "attempt_index" INTEGER NOT NULL DEFAULT 0,
    "is_final_attempt" BOOLEAN NOT NULL DEFAULT true,
    "operation_id" VARCHAR(256),
    "instance_id" VARCHAR(256) NOT NULL,
    "provider" VARCHAR(120),
    "result_status" VARCHAR(32) NOT NULL,
    "route_reason" VARCHAR(256),
    "fallback_from" VARCHAR(256),
    "event_time" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_type" VARCHAR(64) NOT NULL,
    "processing_stage" "pipeline_stage" NOT NULL DEFAULT 'received',
    "clickhouse_raw_synced_at" TIMESTAMPTZ(6),
    "clickhouse_official_synced_at" TIMESTAMPTZ(6),
    "analytics_dimensions_json" JSONB,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "usage_event_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_inbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "event_id" VARCHAR(36) NOT NULL,
    "payload_json" JSONB,
    "status" "inbox_status" NOT NULL DEFAULT 'pending',
    "stage" "pipeline_stage" NOT NULL DEFAULT 'received',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_retry_at" TIMESTAMPTZ(6),
    "lease_owner" VARCHAR(256),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "payload_purge_after" TIMESTAMPTZ(6),
    "payload_purged_at" TIMESTAMPTZ(6),
    "replay_intent_json" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingestion_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_outbox" (
    "id" BIGSERIAL NOT NULL,
    "application_id" UUID NOT NULL,
    "aggregate_type" VARCHAR(120) NOT NULL,
    "aggregate_id" VARCHAR(256) NOT NULL,
    "event_type" VARCHAR(120) NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'pending',
    "idempotency_key" VARCHAR(256) NOT NULL,
    "replay_of_outbox_id" BIGINT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_retry_at" TIMESTAMPTZ(6),
    "lease_owner" VARCHAR(256),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pipeline_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clickhouse_sync_state" (
    "pipeline_name" VARCHAR(120) NOT NULL,
    "last_outbox_id" BIGINT,
    "last_event_time" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "lag_seconds" BIGINT NOT NULL DEFAULT 0,
    "status" "clickhouse_sync_status" NOT NULL DEFAULT 'healthy',
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clickhouse_sync_state_pkey" PRIMARY KEY ("pipeline_name")
);

-- CreateTable
CREATE TABLE "dead_letter_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "event_id" VARCHAR(36),
    "inbox_id" UUID,
    "outbox_id" BIGINT,
    "stage" "pipeline_stage" NOT NULL,
    "error_code" VARCHAR(120) NOT NULL,
    "error_class" VARCHAR(120) NOT NULL,
    "error_message" TEXT NOT NULL,
    "details_json" JSONB NOT NULL DEFAULT '{}',
    "status" "dead_letter_status" NOT NULL DEFAULT 'open',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "replay_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMPTZ(6),
    "first_failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "retention_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dead_letter_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(256),
    "run_type" "reconciliation_run_type" NOT NULL,
    "range_start" TIMESTAMPTZ(6) NOT NULL,
    "range_end" TIMESTAMPTZ(6) NOT NULL,
    "status" "reconciliation_run_status" NOT NULL DEFAULT 'queued',
    "pg_watermark" TIMESTAMPTZ(6),
    "ch_watermark" TIMESTAMPTZ(6),
    "scope_json" JSONB NOT NULL DEFAULT '{}',
    "summary_json" JSONB NOT NULL DEFAULT '{"event_count":"0","input_tokens":"0","cached_input_tokens":"0","output_tokens":"0","provider_cost":"0","aiu_micros":"0","unpriced_count":"0","unrated_count":"0","diff_count":"0"}',
    "started_by" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "error" TEXT,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_diffs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "diff_type" "reconciliation_diff_type" NOT NULL,
    "severity" "reconciliation_severity" NOT NULL,
    "dimensions_json" JSONB,
    "pg_values_json" JSONB,
    "ch_values_json" JSONB,
    "delta_values_json" JSONB NOT NULL,
    "sample_event_ids_json" JSONB NOT NULL DEFAULT '[]',
    "difference_count" BIGINT NOT NULL DEFAULT 0,
    "amount" DECIMAL(38,18),
    "explanation" TEXT NOT NULL DEFAULT '',
    "status" "reconciliation_diff_status" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_diffs_pkey" PRIMARY KEY ("id")
);
