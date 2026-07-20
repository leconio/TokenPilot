-- AddForeignKey
ALTER TABLE "application_members" ADD CONSTRAINT "application_members_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_members" ADD CONSTRAINT "application_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_api_keys" ADD CONSTRAINT "application_api_keys_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_settings" ADD CONSTRAINT "application_settings_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_instances" ADD CONSTRAINT "connector_instances_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_heartbeat_receipts" ADD CONSTRAINT "connector_heartbeat_receipts_application_id_connector_inst_fkey" FOREIGN KEY ("application_id", "connector_instance_id") REFERENCES "connector_instances"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_heartbeat_receipts" ADD CONSTRAINT "connector_heartbeat_receipts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_definitions" ADD CONSTRAINT "model_definitions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_models" ADD CONSTRAINT "virtual_models_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_models" ADD CONSTRAINT "virtual_models_application_id_default_model_id_fkey" FOREIGN KEY ("application_id", "default_model_id") REFERENCES "model_definitions"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_model_targets" ADD CONSTRAINT "virtual_model_targets_application_id_virtual_model_id_fkey" FOREIGN KEY ("application_id", "virtual_model_id") REFERENCES "virtual_models"("application_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_model_targets" ADD CONSTRAINT "virtual_model_targets_application_id_model_id_fkey" FOREIGN KEY ("application_id", "model_id") REFERENCES "model_definitions"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_model_rules" ADD CONSTRAINT "virtual_model_rules_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_model_rules" ADD CONSTRAINT "virtual_model_rules_application_id_virtual_model_id_fkey" FOREIGN KEY ("application_id", "virtual_model_id") REFERENCES "virtual_models"("application_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_model_rules" ADD CONSTRAINT "virtual_model_rules_application_id_target_model_id_fkey" FOREIGN KEY ("application_id", "target_model_id") REFERENCES "model_definitions"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_configuration_versions" ADD CONSTRAINT "runtime_configuration_versions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_configuration_versions" ADD CONSTRAINT "runtime_configuration_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_configuration_acknowledgements" ADD CONSTRAINT "runtime_configuration_acknowledgements_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_configuration_acknowledgements" ADD CONSTRAINT "runtime_configuration_acknowledgements_application_id_conf_fkey" FOREIGN KEY ("application_id", "configuration_version") REFERENCES "runtime_configuration_versions"("application_id", "version") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "property_definitions" ADD CONSTRAINT "property_definitions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_cost_versions" ADD CONSTRAINT "model_cost_versions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_cost_versions" ADD CONSTRAINT "model_cost_versions_application_id_model_id_fkey" FOREIGN KEY ("application_id", "model_id") REFERENCES "model_definitions"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_cost_items" ADD CONSTRAINT "model_cost_items_application_id_version_id_fkey" FOREIGN KEY ("application_id", "version_id") REFERENCES "model_cost_versions"("application_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_aiu_versions" ADD CONSTRAINT "model_aiu_versions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_aiu_versions" ADD CONSTRAINT "model_aiu_versions_application_id_model_id_fkey" FOREIGN KEY ("application_id", "model_id") REFERENCES "model_definitions"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_aiu_items" ADD CONSTRAINT "model_aiu_items_application_id_version_id_fkey" FOREIGN KEY ("application_id", "version_id") REFERENCES "model_aiu_versions"("application_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_users" ADD CONSTRAINT "application_users_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_quotas" ADD CONSTRAINT "user_aiu_quotas_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_quotas" ADD CONSTRAINT "user_aiu_quotas_application_id_user_id_fkey" FOREIGN KEY ("application_id", "user_id") REFERENCES "application_users"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_quotas" ADD CONSTRAINT "user_aiu_quotas_application_id_policy_id_fkey" FOREIGN KEY ("application_id", "policy_id") REFERENCES "aiu_quota_policies"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aiu_quota_policies" ADD CONSTRAINT "aiu_quota_policies_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aiu_quota_policies" ADD CONSTRAINT "aiu_quota_policies_application_id_user_id_fkey" FOREIGN KEY ("application_id", "user_id") REFERENCES "application_users"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aiu_quota_policies" ADD CONSTRAINT "aiu_quota_policies_application_id_user_group_id_fkey" FOREIGN KEY ("application_id", "user_group_id") REFERENCES "application_user_groups"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_ledger_entries" ADD CONSTRAINT "user_aiu_ledger_entries_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_ledger_entries" ADD CONSTRAINT "user_aiu_ledger_entries_application_id_user_id_fkey" FOREIGN KEY ("application_id", "user_id") REFERENCES "application_users"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_ledger_entries" ADD CONSTRAINT "user_aiu_ledger_entries_application_id_quota_id_fkey" FOREIGN KEY ("application_id", "quota_id") REFERENCES "user_aiu_quotas"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_reservations" ADD CONSTRAINT "user_aiu_reservations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_reservations" ADD CONSTRAINT "user_aiu_reservations_application_id_user_id_fkey" FOREIGN KEY ("application_id", "user_id") REFERENCES "application_users"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_aiu_reservations" ADD CONSTRAINT "user_aiu_reservations_application_id_quota_id_fkey" FOREIGN KEY ("application_id", "quota_id") REFERENCES "user_aiu_quotas"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_usage_ratings" ADD CONSTRAINT "application_usage_ratings_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_usage_ratings" ADD CONSTRAINT "application_usage_ratings_application_id_event_id_fkey" FOREIGN KEY ("application_id", "event_id") REFERENCES "usage_event_registry"("application_id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_usage_ratings" ADD CONSTRAINT "application_usage_ratings_application_id_user_id_fkey" FOREIGN KEY ("application_id", "user_id") REFERENCES "application_users"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_usage_ratings" ADD CONSTRAINT "application_usage_ratings_application_id_model_id_fkey" FOREIGN KEY ("application_id", "model_id") REFERENCES "model_definitions"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_user_groups" ADD CONSTRAINT "application_user_groups_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_user_group_evaluations" ADD CONSTRAINT "application_user_group_evaluations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_user_group_evaluations" ADD CONSTRAINT "application_user_group_evaluations_application_id_group_id_fkey" FOREIGN KEY ("application_id", "group_id") REFERENCES "application_user_groups"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_user_group_members" ADD CONSTRAINT "application_user_group_members_application_id_evaluation_i_fkey" FOREIGN KEY ("application_id", "evaluation_id", "group_id") REFERENCES "application_user_group_evaluations"("application_id", "id", "group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_user_group_members" ADD CONSTRAINT "application_user_group_members_application_id_user_id_fkey" FOREIGN KEY ("application_id", "user_id") REFERENCES "application_users"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_user_group_bulk_actions" ADD CONSTRAINT "application_user_group_bulk_actions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_user_group_bulk_actions" ADD CONSTRAINT "application_user_group_bulk_actions_application_id_evaluat_fkey" FOREIGN KEY ("application_id", "evaluation_id", "group_id") REFERENCES "application_user_group_evaluations"("application_id", "id", "group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_dashboard_cards" ADD CONSTRAINT "application_dashboard_cards_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_dashboard_cards" ADD CONSTRAINT "application_dashboard_cards_application_id_report_id_fkey" FOREIGN KEY ("application_id", "report_id") REFERENCES "saved_reports"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event_registry" ADD CONSTRAINT "usage_event_registry_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event_registry" ADD CONSTRAINT "usage_event_registry_application_id_application_user_id_fkey" FOREIGN KEY ("application_id", "application_user_id") REFERENCES "application_users"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_event_registry" ADD CONSTRAINT "usage_event_registry_application_id_model_id_fkey" FOREIGN KEY ("application_id", "model_id") REFERENCES "model_definitions"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_inbox" ADD CONSTRAINT "ingestion_inbox_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_inbox" ADD CONSTRAINT "ingestion_inbox_application_id_event_id_fkey" FOREIGN KEY ("application_id", "event_id") REFERENCES "usage_event_registry"("application_id", "event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_events" ADD CONSTRAINT "dead_letter_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_events" ADD CONSTRAINT "dead_letter_events_application_id_inbox_id_fkey" FOREIGN KEY ("application_id", "inbox_id") REFERENCES "ingestion_inbox"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_events" ADD CONSTRAINT "dead_letter_events_application_id_outbox_id_fkey" FOREIGN KEY ("application_id", "outbox_id") REFERENCES "pipeline_outbox"("application_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_events" ADD CONSTRAINT "dead_letter_events_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_diffs" ADD CONSTRAINT "reconciliation_diffs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
