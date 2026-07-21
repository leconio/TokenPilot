-- Current application and instance invariants that Prisma cannot express.
ALTER TABLE "instance_settings"
  ADD CONSTRAINT "instance_settings_singleton_check" CHECK ("id" = 1),
  ADD CONSTRAINT "instance_settings_aiu_scale_check" CHECK ("aiu_micro_scale" > 0);

ALTER TABLE "applications"
  ADD CONSTRAINT "applications_archive_status_check"
  CHECK ("archived_at" IS NULL OR "status" = 'disabled');

ALTER TABLE "application_members"
  ADD CONSTRAINT "application_members_permissions_known_check"
  CHECK (
    "permissions" <@ ARRAY[
      'usage:read', 'model:read', 'model:write', 'configuration:read',
      'configuration:write', 'admin:read', 'admin:write', 'pricing:read',
      'pricing:write', 'reports:read', 'jobs:read', 'jobs:write',
      'reconciliation:read', 'reconciliation:write'
    ]::TEXT[]
  ),
  ADD CONSTRAINT "application_members_role_permissions_check"
  CHECK (
    "role" IN ('owner', 'admin')
    OR ("role" = 'viewer' AND "permissions" <@ ARRAY[
      'usage:read', 'model:read', 'configuration:read', 'admin:read',
      'pricing:read', 'reports:read'
    ]::TEXT[])
    OR ("role" = 'analyst' AND "permissions" <@ ARRAY[
      'usage:read', 'model:read', 'configuration:read', 'admin:read',
      'pricing:read', 'reports:read', 'jobs:read', 'reconciliation:read'
    ]::TEXT[])
  );

ALTER TABLE "model_definitions"
  ADD CONSTRAINT "model_definitions_request_model_check"
  CHECK (length(btrim("request_model")) BETWEEN 1 AND 256);

ALTER TABLE "call_connections"
  ADD CONSTRAINT "call_connections_name_check"
  CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "call_connections_credential_ref_check"
  CHECK ("credential_ref" IS NULL OR length(btrim("credential_ref")) BETWEEN 1 AND 256),
  ADD CONSTRAINT "call_connections_driver_url_check"
  CHECK ("driver" <> 'openai_compatible' OR "base_url" IS NOT NULL);

ALTER TABLE "virtual_model_targets"
  ADD CONSTRAINT "virtual_model_targets_priority_check" CHECK ("priority" >= 0),
  ADD CONSTRAINT "virtual_model_targets_weight_check" CHECK ("weight" > 0);

ALTER TABLE "model_cost_rules"
  ADD CONSTRAINT "model_cost_rules_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "model_cost_rules_priority_check" CHECK ("priority" >= 0),
  ADD CONSTRAINT "model_cost_rules_match_mode_check" CHECK ("match_mode" IN ('all', 'any')),
  ADD CONSTRAINT "model_cost_rules_fixed_amount_check" CHECK ("fixed_amount" IS NULL OR "fixed_amount" >= 0);

ALTER TABLE "model_cost_rule_items"
  ADD CONSTRAINT "model_cost_rule_items_amount_check" CHECK ("amount_per_unit" >= 0);

ALTER TABLE "model_aiu_items"
  ADD CONSTRAINT "model_aiu_items_unit_size_check" CHECK ("unit_size" > 0),
  ADD CONSTRAINT "model_aiu_items_rate_check" CHECK ("aiu_micros_per_unit" >= 0);

ALTER TABLE "application_users"
  ADD CONSTRAINT "application_users_external_id_check"
  CHECK (length(btrim("external_id")) BETWEEN 1 AND 256);

ALTER TABLE "user_aiu_quotas"
  ADD CONSTRAINT "user_aiu_quotas_counters_check"
  CHECK (
    "limit_aiu_micros" >= 0
    AND "consumed_aiu_micros" >= 0
    AND "reserved_aiu_micros" >= 0
  ),
  ADD CONSTRAINT "user_aiu_quotas_period_check"
  CHECK ("period_end" IS NULL OR "period_end" > "period_start");

ALTER TABLE "aiu_quota_policies"
  ADD CONSTRAINT "aiu_quota_policies_subject_check"
  CHECK (
    ("scope" = 'application' AND "user_id" IS NULL AND "user_group_id" IS NULL)
    OR ("scope" = 'user' AND "user_id" IS NOT NULL AND "user_group_id" IS NULL)
    OR ("scope" = 'user_group' AND "user_id" IS NULL AND "user_group_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "aiu_quota_policies_limit_check" CHECK ("limit_aiu_micros" >= 0),
  ADD CONSTRAINT "aiu_quota_policies_priority_check" CHECK ("priority" >= 0),
  ADD CONSTRAINT "aiu_quota_policies_period_check"
  CHECK (
    ("period_type" = 'fixed_window' AND "starts_at" IS NOT NULL AND "ends_at" > "starts_at")
    OR ("period_type" <> 'fixed_window' AND "starts_at" IS NULL AND "ends_at" IS NULL)
  );

ALTER TABLE "user_aiu_ledger_entries"
  ADD CONSTRAINT "user_aiu_ledger_snapshots_check"
  CHECK (
    "consumed_after_micros" >= 0
    AND "reserved_after_micros" >= 0
    AND "limit_after_micros" >= 0
  );

ALTER TABLE "user_aiu_reservations"
  ADD CONSTRAINT "user_aiu_reservations_amounts_check"
  CHECK (
    "estimated_aiu_micros" >= 0
    AND "reserved_aiu_micros" >= 0
    AND "settled_aiu_micros" >= 0
  ),
  ADD CONSTRAINT "user_aiu_reservations_expiry_check" CHECK ("expires_at" > "created_at");

ALTER TABLE "application_usage_ratings"
  ADD CONSTRAINT "application_usage_ratings_tokens_check"
  CHECK (
    "input_tokens" >= 0
    AND "output_tokens" >= 0
    AND "cached_tokens" >= 0
    AND "total_tokens" = "input_tokens" + "output_tokens"
  ),
  ADD CONSTRAINT "application_usage_ratings_cost_check"
  CHECK (
    ("cost_status" = 'official'
      AND "provider_cost" IS NOT NULL
      AND "provider_cost" >= 0
      AND "currency" IS NOT NULL
      )
    OR
    ("cost_status" = 'unpriced'
      AND "provider_cost" IS NULL
      AND "currency" IS NULL)
  ),
  ADD CONSTRAINT "application_usage_ratings_aiu_check"
  CHECK (
    ("aiu_status" = 'official'
      AND "aiu_micros" IS NOT NULL
      AND "aiu_micros" >= 0
      AND "aiu_version_id" IS NOT NULL)
    OR
    ("aiu_status" = 'unrated' AND "aiu_micros" IS NULL)
  );

ALTER TABLE "usage_event_registry"
  ADD CONSTRAINT "usage_event_registry_user_id_check"
  CHECK (length(btrim("external_user_id")) BETWEEN 1 AND 256),
  ADD CONSTRAINT "usage_event_registry_request_model_check"
  CHECK (length(btrim("request_model")) BETWEEN 1 AND 256);

ALTER TABLE "pipeline_outbox"
  ADD CONSTRAINT "pipeline_outbox_idempotency_key_check"
  CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 256);

ALTER TABLE "dead_letter_events"
  ADD CONSTRAINT "dead_letter_events_owner_check"
  CHECK (num_nonnulls("inbox_id", "outbox_id") = 1);
