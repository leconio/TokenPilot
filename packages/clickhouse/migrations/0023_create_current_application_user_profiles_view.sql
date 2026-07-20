-- Current empty-database baseline statement 0023.
-- Resolves the latest immutable profile projection without FINAL or PostgreSQL fallback.
CREATE VIEW current_application_user_profiles AS
SELECT
    profile.application_id,
    profile.user_id,
    argMax(profile.user_record_id, profile.profile_version) AS user_record_id,
    argMax(profile.display_user, profile.profile_version) AS display_user,
    argMax(profile.tags, profile.profile_version) AS tags,
    argMax(profile.status, profile.profile_version) AS status,
    argMax(profile.first_seen_at, profile.profile_version) AS first_seen_at,
    argMax(profile.last_seen_at, profile.profile_version) AS last_seen_at,
    argMax(profile.profile_updated_at, profile.profile_version) AS profile_updated_at,
    argMax(profile.user_text_properties, profile.profile_version) AS user_text_properties,
    argMax(profile.user_number_properties, profile.profile_version) AS user_number_properties,
    argMax(profile.user_boolean_properties, profile.profile_version) AS user_boolean_properties,
    argMax(profile.user_datetime_properties, profile.profile_version) AS user_datetime_properties,
    argMax(profile.user_enum_properties, profile.profile_version) AS user_enum_properties,
    argMax(profile.user_text_list_properties, profile.profile_version) AS user_text_list_properties,
    argMax(profile.properties_json, profile.profile_version) AS properties_json,
    max(profile.profile_version) AS profile_version
FROM application_user_profiles AS profile
GROUP BY profile.application_id, profile.user_id;
