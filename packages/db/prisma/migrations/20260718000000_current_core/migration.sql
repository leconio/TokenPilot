-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "deployment_environment" AS ENUM ('development', 'test', 'staging', 'production');

-- CreateEnum
CREATE TYPE "api_key_status" AS ENUM ('active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "application_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "application_role" AS ENUM ('owner', 'admin', 'analyst', 'viewer');

-- CreateEnum
CREATE TYPE "application_user_status" AS ENUM ('active', 'blocked');

-- CreateEnum
CREATE TYPE "property_scope" AS ENUM ('event', 'user');

-- CreateEnum
CREATE TYPE "property_data_type" AS ENUM ('text', 'number', 'boolean', 'datetime', 'enum', 'text_list');

-- CreateEnum
CREATE TYPE "property_status" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "saved_report_kind" AS ENUM ('usage', 'cost', 'aiu');

-- CreateEnum
CREATE TYPE "policy_acknowledgement_state" AS ENUM ('received', 'applied', 'rejected');

-- CreateEnum
CREATE TYPE "background_job_type" AS ENUM ('usage.ledger', 'exports.generate', 'maintenance');

-- CreateEnum
CREATE TYPE "background_job_status" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "connector_status" AS ENUM ('healthy', 'degraded', 'stale');

-- CreateEnum
CREATE TYPE "publication_status" AS ENUM ('draft', 'published', 'retired', 'unknown');

-- CreateEnum
CREATE TYPE "quota_period_type" AS ENUM ('calendar_day', 'calendar_week', 'calendar_month', 'fixed_window', 'lifetime', 'unknown');

-- CreateEnum
CREATE TYPE "aiu_quota_policy_scope" AS ENUM ('application', 'user_group', 'user');

-- CreateEnum
CREATE TYPE "aiu_ledger_entry_type" AS ENUM ('grant', 'consume', 'refund', 'adjustment', 'expire', 'reserve', 'reservation_release', 'settlement_delta', 'reversal');

-- CreateEnum
CREATE TYPE "aiu_reservation_status" AS ENUM ('reserved', 'settled', 'released', 'expired', 'unknown');

-- CreateEnum
CREATE TYPE "pipeline_stage" AS ENUM ('received', 'normalized', 'model_resolved', 'provider_cost_rated', 'aiu_rated', 'quota_settled', 'official_committed', 'outbox_created', 'completed', 'dead_letter');

-- CreateEnum
CREATE TYPE "inbox_status" AS ENUM ('pending', 'leased', 'completed', 'failed', 'dead_letter');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('pending', 'leased', 'sent', 'failed', 'dead_letter');

-- CreateEnum
CREATE TYPE "clickhouse_sync_status" AS ENUM ('healthy', 'degraded', 'stale', 'failed');

-- CreateEnum
CREATE TYPE "dead_letter_status" AS ENUM ('open', 'replay_queued', 'resolved', 'ignored');

-- CreateEnum
CREATE TYPE "reconciliation_run_type" AS ENUM ('hourly', 'daily', 'manual', 'rebuild', 'unknown');

-- CreateEnum
CREATE TYPE "reconciliation_run_status" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled', 'unknown');

-- CreateEnum
CREATE TYPE "reconciliation_diff_type" AS ENUM ('CH_MISSING', 'PG_MISSING', 'DUPLICATE_PROJECTION', 'PAYLOAD_HASH_CONFLICT', 'USAGE_NORMALIZATION_MISMATCH', 'MODEL_IDENTITY_MISMATCH', 'PRICE_VERSION_MISMATCH', 'AIU_RATE_VERSION_MISMATCH', 'PROVISIONAL_OFFICIAL_DELTA_PENDING', 'LEDGER_PROJECTION_MISSING', 'LATE_EVENT', 'ADJUSTMENT_NOT_PROJECTED', 'WATERMARK_STALLED', 'unknown');

-- CreateEnum
CREATE TYPE "reconciliation_severity" AS ENUM ('info', 'warning', 'error', 'critical', 'unknown');

-- CreateEnum
CREATE TYPE "reconciliation_diff_status" AS ENUM ('open', 'investigating', 'resolved', 'ignored', 'unknown');

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "status" "application_status" NOT NULL DEFAULT 'active',
    "timezone" VARCHAR(128) NOT NULL DEFAULT 'UTC',
    "base_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_members" (
    "application_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "application_role" NOT NULL DEFAULT 'viewer',
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "application_members_pkey" PRIMARY KEY ("application_id","user_id")
);

-- CreateTable
CREATE TABLE "application_api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "key_prefix" VARCHAR(32) NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "scopes" TEXT[],
    "status" "api_key_status" NOT NULL DEFAULT 'active',
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_settings" (
    "application_id" UUID NOT NULL,
    "feature_usage_pipeline" BOOLEAN NOT NULL DEFAULT true,
    "feature_model_catalog" BOOLEAN NOT NULL DEFAULT true,
    "feature_aiu" BOOLEAN NOT NULL DEFAULT true,
    "feature_quota" BOOLEAN NOT NULL DEFAULT true,
    "feature_hard_limit" BOOLEAN NOT NULL DEFAULT false,
    "feature_reconciliation" BOOLEAN NOT NULL DEFAULT true,
    "aiu_micro_scale" BIGINT NOT NULL DEFAULT 1000000,
    "raw_event_retention_days" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "application_settings_pkey" PRIMARY KEY ("application_id")
);

-- CreateTable
CREATE TABLE "instance_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "instance_id" VARCHAR(256) NOT NULL,
    "environment" "deployment_environment" NOT NULL,
    "timezone" VARCHAR(128) NOT NULL,
    "base_currency" CHAR(3) NOT NULL,
    "feature_usage_pipeline" BOOLEAN NOT NULL DEFAULT false,
    "feature_model_catalog" BOOLEAN NOT NULL DEFAULT false,
    "feature_aiu" BOOLEAN NOT NULL DEFAULT false,
    "feature_quota" BOOLEAN NOT NULL DEFAULT false,
    "feature_hard_limit" BOOLEAN NOT NULL DEFAULT false,
    "feature_reconciliation" BOOLEAN NOT NULL DEFAULT false,
    "aiu_micro_scale" BIGINT NOT NULL DEFAULT 1000000,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "instance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "instance_id" VARCHAR(256) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "version" VARCHAR(64) NOT NULL,
    "status" "connector_status" NOT NULL,
    "last_heartbeat_at" TIMESTAMPTZ(6) NOT NULL,
    "heartbeat_sent_at" TIMESTAMPTZ(6),
    "last_heartbeat_id" CHAR(26),
    "last_heartbeat_payload_hash" CHAR(64),
    "last_successful_upload_at" TIMESTAMPTZ(6),
    "buffer_depth" INTEGER NOT NULL DEFAULT 0,
    "oldest_event_age_seconds" DECIMAL(20,3),
    "capabilities_json" JSONB,
    "metadata_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "connector_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_heartbeat_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "heartbeat_id" CHAR(26) NOT NULL,
    "connector_instance_id" UUID NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_heartbeat_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID,
    "actor_id" TEXT,
    "action" VARCHAR(120) NOT NULL,
    "object_type" VARCHAR(120) NOT NULL,
    "object_id" VARCHAR(256) NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "reason" VARCHAR(500),
    "ip" INET,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID,
    "type" "background_job_type" NOT NULL,
    "status" "background_job_status" NOT NULL DEFAULT 'queued',
    "idempotency_key" VARCHAR(256) NOT NULL,
    "parameters_json" JSONB NOT NULL,
    "result_json" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(120),
    "error_message" VARCHAR(500),
    "scheduled_for" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(6),
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "last_request" BIGINT NOT NULL,

    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "litellm_tag" VARCHAR(256) NOT NULL,
    "provider" VARCHAR(120),
    "capabilities_json" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "model_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_models" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "default_model_id" UUID,
    "description" TEXT,
    "last_published_version" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "virtual_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_model_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "virtual_model_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "weight" DECIMAL(9,6) NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "virtual_model_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_model_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "virtual_model_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "priority" INTEGER NOT NULL,
    "match_json" JSONB NOT NULL,
    "target_model_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "virtual_model_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_configuration_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "publication_status" NOT NULL DEFAULT 'draft',
    "etag" CHAR(71) NOT NULL,
    "snapshot_json" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_configuration_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_configuration_acknowledgements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "acknowledgement_id" VARCHAR(36) NOT NULL,
    "connector_instance_id" VARCHAR(256) NOT NULL,
    "connector_name" VARCHAR(32) NOT NULL,
    "connector_version" VARCHAR(64) NOT NULL,
    "configuration_version" INTEGER NOT NULL,
    "configuration_etag" CHAR(71) NOT NULL,
    "state" "policy_acknowledgement_state" NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6) NOT NULL,
    "applied_at" TIMESTAMPTZ(6),
    "error_code" VARCHAR(120),
    "error_message" VARCHAR(500),
    "payload_hash" CHAR(64) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_configuration_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "scope" "property_scope" NOT NULL,
    "data_type" "property_data_type" NOT NULL,
    "allowed_values_json" JSONB,
    "searchable" BOOLEAN NOT NULL DEFAULT true,
    "groupable" BOOLEAN NOT NULL DEFAULT false,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "constraints_json" JSONB NOT NULL DEFAULT '{}',
    "status" "property_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "property_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_cost_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "publication_status" NOT NULL DEFAULT 'published',
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_cost_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_cost_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "usage_type" VARCHAR(120) NOT NULL,
    "unit_key" VARCHAR(128) NOT NULL DEFAULT '',
    "unit_size" DECIMAL(38,9) NOT NULL,
    "unit_price" DECIMAL(38,18) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_cost_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_aiu_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "publication_status" NOT NULL DEFAULT 'published',
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_aiu_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_aiu_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "application_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "usage_type" VARCHAR(120) NOT NULL,
    "unit_key" VARCHAR(128) NOT NULL DEFAULT '',
    "unit_size" DECIMAL(38,9) NOT NULL,
    "aiu_micros_per_unit" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_aiu_items_pkey" PRIMARY KEY ("id")
);
