-- CreateIndex
CREATE UNIQUE INDEX "applications_slug_key" ON "applications"("slug");

-- CreateIndex
CREATE INDEX "applications_status_updated_at_idx" ON "applications"("status", "updated_at");

-- CreateIndex
CREATE INDEX "application_members_user_created_at_idx" ON "application_members"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_api_keys_key_prefix_key" ON "application_api_keys"("key_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "application_api_keys_key_hash_key" ON "application_api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "application_api_keys_app_status_expiry_idx" ON "application_api_keys"("application_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "instance_settings_instance_id_key" ON "instance_settings"("instance_id");

-- CreateIndex
CREATE INDEX "connector_instances_application_heartbeat_idx" ON "connector_instances"("application_id", "last_heartbeat_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "connector_instances_application_instance_key" ON "connector_instances"("application_id", "instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_instances_application_id_key" ON "connector_instances"("application_id", "id");

-- CreateIndex
CREATE INDEX "connector_heartbeat_receipts_application_instance_sent_idx" ON "connector_heartbeat_receipts"("application_id", "connector_instance_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "connector_heartbeat_receipts_application_heartbeat_key" ON "connector_heartbeat_receipts"("application_id", "heartbeat_id");

-- CreateIndex
CREATE UNIQUE INDEX "call_connections_application_name_key" ON "call_connections"("application_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "call_connections_application_id_key" ON "call_connections"("application_id", "id");

-- CreateIndex
CREATE INDEX "call_connections_application_driver_idx" ON "call_connections"("application_id", "enabled", "driver");

-- CreateIndex
CREATE INDEX "call_connections_application_status_idx" ON "call_connections"("application_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "audit_logs_application_created_idx" ON "audit_logs"("application_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_object_created_at_idx" ON "audit_logs"("object_type", "object_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_idempotency_key_key" ON "background_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "background_jobs_status_scheduled_idx" ON "background_jobs"("status", "scheduled_for", "created_at");

-- CreateIndex
CREATE INDEX "background_jobs_type_created_idx" ON "background_jobs"("type", "created_at");

-- CreateIndex
CREATE INDEX "background_jobs_application_type_created_idx" ON "background_jobs"("application_id", "type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "account"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "account"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expires_at_idx" ON "verification"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "rate_limit_key_key" ON "rate_limit"("key");

-- CreateIndex
CREATE INDEX "model_definitions_application_enabled_idx" ON "model_definitions"("application_id", "enabled", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "model_definitions_application_connection_model_key" ON "model_definitions"("application_id", "connection_id", "request_model");

-- CreateIndex
CREATE UNIQUE INDEX "model_definitions_application_id_key" ON "model_definitions"("application_id", "id");

-- CreateIndex
CREATE INDEX "model_definitions_application_provider_task_idx" ON "model_definitions"("application_id", "provider", "task_type");

-- CreateIndex
CREATE INDEX "virtual_models_application_enabled_idx" ON "virtual_models"("application_id", "enabled", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_models_application_name_key" ON "virtual_models"("application_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_models_application_id_key" ON "virtual_models"("application_id", "id");

-- CreateIndex
CREATE INDEX "virtual_model_targets_route_idx" ON "virtual_model_targets"("application_id", "virtual_model_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_model_targets_model_key" ON "virtual_model_targets"("virtual_model_id", "model_id");

-- CreateIndex
CREATE INDEX "virtual_model_rules_route_idx" ON "virtual_model_rules"("application_id", "virtual_model_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_model_rules_virtual_model_id_key" ON "virtual_model_rules"("virtual_model_id", "id");

-- CreateIndex
CREATE INDEX "runtime_configuration_versions_status_idx" ON "runtime_configuration_versions"("application_id", "status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_configuration_versions_application_version_key" ON "runtime_configuration_versions"("application_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_configuration_versions_application_etag_key" ON "runtime_configuration_versions"("application_id", "etag");

-- CreateIndex
CREATE INDEX "runtime_configuration_acknowledgements_connector_idx" ON "runtime_configuration_acknowledgements"("application_id", "connector_instance_id", "received_at");

-- CreateIndex
CREATE INDEX "runtime_configuration_acknowledgements_configuration_idx" ON "runtime_configuration_acknowledgements"("application_id", "configuration_version", "state", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "runtime_configuration_acknowledgements_application_ack_key" ON "runtime_configuration_acknowledgements"("application_id", "acknowledgement_id");

-- CreateIndex
CREATE INDEX "property_definitions_application_scope_idx" ON "property_definitions"("application_id", "scope", "status");

-- CreateIndex
CREATE UNIQUE INDEX "property_definitions_application_key_key" ON "property_definitions"("application_id", "key");

-- CreateIndex
CREATE INDEX "model_cost_versions_current_idx" ON "model_cost_versions"("application_id", "model_id", "status", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "model_cost_versions_application_id_key" ON "model_cost_versions"("application_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "model_cost_versions_model_version_key" ON "model_cost_versions"("application_id", "model_id", "version");

-- CreateIndex
CREATE INDEX "model_cost_items_application_usage_idx" ON "model_cost_items"("application_id", "usage_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "model_cost_items_usage_key" ON "model_cost_items"("version_id", "usage_type", "unit_key");

-- CreateIndex
CREATE INDEX "model_aiu_versions_current_idx" ON "model_aiu_versions"("application_id", "model_id", "status", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "model_aiu_versions_application_id_key" ON "model_aiu_versions"("application_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "model_aiu_versions_model_version_key" ON "model_aiu_versions"("application_id", "model_id", "version");

-- CreateIndex
CREATE INDEX "model_aiu_items_application_usage_idx" ON "model_aiu_items"("application_id", "usage_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "model_aiu_items_usage_key" ON "model_aiu_items"("version_id", "usage_type", "unit_key");

-- CreateIndex
CREATE INDEX "application_users_status_seen_idx" ON "application_users"("application_id", "status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_users_external_id_key" ON "application_users"("application_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_users_application_id_key" ON "application_users"("application_id", "id");

-- CreateIndex
CREATE INDEX "user_aiu_quotas_active_period_idx" ON "user_aiu_quotas"("application_id", "enabled", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "user_aiu_quotas_application_id_key" ON "user_aiu_quotas"("application_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "user_aiu_quotas_application_user_key" ON "user_aiu_quotas"("application_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "aiu_quota_policies_application_id_key" ON "aiu_quota_policies"("application_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "aiu_quota_policies_application_user_key" ON "aiu_quota_policies"("application_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "aiu_quota_policies_application_group_key" ON "aiu_quota_policies"("application_id", "user_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "aiu_quota_policies_application_scope_key" ON "aiu_quota_policies"("application_id") WHERE "scope" = 'application';

-- CreateIndex
CREATE INDEX "aiu_quota_policies_resolution_idx" ON "aiu_quota_policies"("application_id", "scope", "enabled", "priority");

-- CreateIndex
CREATE INDEX "user_aiu_ledger_user_created_idx" ON "user_aiu_ledger_entries"("application_id", "user_id", "created_at");

-- CreateIndex
CREATE INDEX "user_aiu_ledger_quota_created_idx" ON "user_aiu_ledger_entries"("application_id", "quota_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_aiu_ledger_idempotency_key" ON "user_aiu_ledger_entries"("application_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "user_aiu_reservations_status_expiry_idx" ON "user_aiu_reservations"("application_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "user_aiu_reservations_quota_status_idx" ON "user_aiu_reservations"("application_id", "quota_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_aiu_reservations_operation_key" ON "user_aiu_reservations"("application_id", "user_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_aiu_reservations_application_id_key" ON "user_aiu_reservations"("application_id", "id");

-- CreateIndex
CREATE INDEX "application_usage_ratings_user_idx" ON "application_usage_ratings"("application_id", "user_id", "rated_at");

-- CreateIndex
CREATE INDEX "application_usage_ratings_model_idx" ON "application_usage_ratings"("application_id", "model_id", "rated_at");

-- CreateIndex
CREATE INDEX "application_usage_ratings_virtual_idx" ON "application_usage_ratings"("application_id", "virtual_model", "rated_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_usage_ratings_event_key" ON "application_usage_ratings"("application_id", "event_id");

-- CreateIndex
CREATE INDEX "application_user_groups_enabled_idx" ON "application_user_groups"("application_id", "enabled", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_user_groups_name_key" ON "application_user_groups"("application_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "application_user_groups_application_id_key" ON "application_user_groups"("application_id", "id");

-- CreateIndex
CREATE INDEX "application_user_group_evaluations_group_idx" ON "application_user_group_evaluations"("application_id", "group_id", "evaluated_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_user_group_evaluations_application_id_key" ON "application_user_group_evaluations"("application_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "application_user_group_evaluations_group_id_key" ON "application_user_group_evaluations"("application_id", "id", "group_id");

-- CreateIndex
CREATE INDEX "application_user_group_members_group_user_idx" ON "application_user_group_members"("application_id", "group_id", "user_id");

-- CreateIndex
CREATE INDEX "application_user_group_members_user_idx" ON "application_user_group_members"("application_id", "user_id", "matched_at");

-- CreateIndex
CREATE INDEX "application_user_group_actions_group_idx" ON "application_user_group_bulk_actions"("application_id", "group_id", "created_at");

-- CreateIndex
CREATE INDEX "saved_reports_kind_updated_idx" ON "saved_reports"("application_id", "kind", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "saved_reports_name_key" ON "saved_reports"("application_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "saved_reports_application_id_key" ON "saved_reports"("application_id", "id");

-- CreateIndex
CREATE INDEX "application_dashboard_cards_position_idx" ON "application_dashboard_cards"("application_id", "position", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_dashboard_cards_report_key" ON "application_dashboard_cards"("application_id", "report_id");

-- CreateIndex
CREATE INDEX "usage_event_registry_payload_hash_idx" ON "usage_event_registry"("payload_hash");

-- CreateIndex
CREATE INDEX "usage_event_registry_application_time_idx" ON "usage_event_registry"("application_id", "event_time", "event_id");

-- CreateIndex
CREATE INDEX "usage_event_registry_application_user_idx" ON "usage_event_registry"("application_id", "external_user_id", "event_time");

-- CreateIndex
CREATE INDEX "usage_event_registry_request_attempt_idx" ON "usage_event_registry"("request_id", "attempt_id");

-- CreateIndex
CREATE INDEX "usage_event_registry_stage_received_idx" ON "usage_event_registry"("processing_stage", "received_at");

-- CreateIndex
CREATE INDEX "usage_event_registry_event_time_idx" ON "usage_event_registry"("event_time", "event_id");

-- CreateIndex
CREATE INDEX "usage_event_registry_application_model_idx" ON "usage_event_registry"("application_id", "request_model", "event_time");

-- CreateIndex
CREATE INDEX "usage_event_registry_application_connection_idx" ON "usage_event_registry"("application_id", "connection_id", "event_time");

-- CreateIndex
CREATE INDEX "usage_event_registry_status_time_idx" ON "usage_event_registry"("result_status", "event_time");

-- CreateIndex
CREATE UNIQUE INDEX "usage_event_registry_application_event_key" ON "usage_event_registry"("application_id", "event_id");

-- CreateIndex
CREATE INDEX "ingestion_inbox_status_available_lease_idx" ON "ingestion_inbox"("status", "available_at", "lease_expires_at");

-- CreateIndex
CREATE INDEX "ingestion_inbox_application_status_idx" ON "ingestion_inbox"("application_id", "status", "available_at");

-- CreateIndex
CREATE INDEX "ingestion_inbox_stage_status_created_idx" ON "ingestion_inbox"("stage", "status", "created_at");

-- CreateIndex
CREATE INDEX "ingestion_inbox_payload_purge_idx" ON "ingestion_inbox"("payload_purge_after");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_inbox_application_event_key" ON "ingestion_inbox"("application_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_inbox_application_id_key" ON "ingestion_inbox"("application_id", "id");

-- CreateIndex
CREATE INDEX "pipeline_outbox_application_status_idx" ON "pipeline_outbox"("application_id", "status", "available_at", "id");

-- CreateIndex
CREATE INDEX "pipeline_outbox_status_available_idx" ON "pipeline_outbox"("status", "available_at", "id");

-- CreateIndex
CREATE INDEX "pipeline_outbox_aggregate_idx" ON "pipeline_outbox"("aggregate_type", "aggregate_id", "id");

-- CreateIndex
CREATE INDEX "pipeline_outbox_replay_of_idx" ON "pipeline_outbox"("replay_of_outbox_id");

-- CreateIndex
CREATE INDEX "pipeline_outbox_lease_expires_idx" ON "pipeline_outbox"("lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_outbox_application_id_key" ON "pipeline_outbox"("application_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_outbox_application_idempotency_key" ON "pipeline_outbox"("application_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "clickhouse_sync_state_status_updated_idx" ON "clickhouse_sync_state"("status", "updated_at");

-- CreateIndex
CREATE INDEX "dead_letter_events_application_status_idx" ON "dead_letter_events"("application_id", "status", "next_retry_at", "first_failed_at");

-- CreateIndex
CREATE INDEX "dead_letter_events_event_stage_idx" ON "dead_letter_events"("event_id", "stage", "status");

-- CreateIndex
CREATE INDEX "dead_letter_events_outbox_stage_idx" ON "dead_letter_events"("outbox_id", "stage", "status");

-- CreateIndex
CREATE INDEX "dead_letter_events_retention_idx" ON "dead_letter_events"("retention_until");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_idempotency_key_key" ON "reconciliation_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "reconciliation_runs_application_status_idx" ON "reconciliation_runs"("application_id", "status", "started_at");

-- CreateIndex
CREATE INDEX "reconciliation_runs_application_range_idx" ON "reconciliation_runs"("application_id", "range_start", "range_end");

-- CreateIndex
CREATE INDEX "reconciliation_diffs_run_severity_idx" ON "reconciliation_diffs"("run_id", "severity", "status");

-- CreateIndex
CREATE INDEX "reconciliation_diffs_run_type_status_idx" ON "reconciliation_diffs"("run_id", "diff_type", "status");

-- CreateIndex
CREATE INDEX "reconciliation_diffs_type_status_idx" ON "reconciliation_diffs"("diff_type", "status", "created_at");
