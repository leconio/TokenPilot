#!/usr/bin/env bash
set -Eeuo pipefail

required=(
  CLICKHOUSE_PASSWORD
  AI_CONTROL_CLICKHOUSE_DATABASE
  AI_CONTROL_CLICKHOUSE_APPLICATION_USER
  AI_CONTROL_CLICKHOUSE_APPLICATION_PASSWORD
  AI_CONTROL_CLICKHOUSE_MIGRATION_USER
  AI_CONTROL_CLICKHOUSE_MIGRATION_PASSWORD
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'ClickHouse bootstrap variable %s is required\n' "$name" >&2
    exit 1
  fi
done

identifier='^[A-Za-z_][A-Za-z0-9_]*$'
for name in \
  AI_CONTROL_CLICKHOUSE_DATABASE \
  AI_CONTROL_CLICKHOUSE_APPLICATION_USER \
  AI_CONTROL_CLICKHOUSE_MIGRATION_USER
do
  if [[ ! "${!name}" =~ $identifier ]]; then
    printf 'ClickHouse bootstrap variable %s is not a safe identifier\n' "$name" >&2
    exit 1
  fi
done

application_user="$AI_CONTROL_CLICKHOUSE_APPLICATION_USER"
migration_user="$AI_CONTROL_CLICKHOUSE_MIGRATION_USER"
if [[ "$application_user" == default || "$migration_user" == default ]]; then
  printf 'ClickHouse application and migration users must not use the privileged default account\n' >&2
  exit 1
fi
if [[ "$application_user" == "$migration_user" ]]; then
  printf 'ClickHouse application and migration users must be distinct\n' >&2
  exit 1
fi

password='^[A-Za-z0-9._~!@#%^+=:-]{16,256}$'
for name in \
  CLICKHOUSE_PASSWORD \
  AI_CONTROL_CLICKHOUSE_APPLICATION_PASSWORD \
  AI_CONTROL_CLICKHOUSE_MIGRATION_PASSWORD
do
  if [[ ! "${!name}" =~ $password ]]; then
    printf 'ClickHouse bootstrap variable %s must be 16-256 URL-safe characters\n' "$name" >&2
    exit 1
  fi
done

database="$AI_CONTROL_CLICKHOUSE_DATABASE"
application_password="$AI_CONTROL_CLICKHOUSE_APPLICATION_PASSWORD"
migration_password="$AI_CONTROL_CLICKHOUSE_MIGRATION_PASSWORD"
case "${database,,}" in
  default|system|information_schema)
    printf 'ClickHouse application database must not use a reserved database name\n' >&2
    exit 1
    ;;
esac
if [[ "$CLICKHOUSE_PASSWORD" == "$application_password" || \
      "$CLICKHOUSE_PASSWORD" == "$migration_password" || \
      "$application_password" == "$migration_password" ]]; then
  printf 'ClickHouse bootstrap, application, and migration passwords must be distinct\n' >&2
  exit 1
fi
client_config="$(mktemp)"
trap 'rm -f "$client_config"' EXIT
chmod 600 "$client_config"

cat >"$client_config" <<EOF
<clickhouse>
  <host>127.0.0.1</host>
  <port>9000</port>
  <user>default</user>
  <password>${CLICKHOUSE_PASSWORD}</password>
</clickhouse>
EOF

clickhouse client --config-file "$client_config" --multiquery <<SQL
CREATE ROLE IF NOT EXISTS ai_control_runtime_role;
CREATE ROLE IF NOT EXISTS ai_control_migration_role;

GRANT SELECT, INSERT ON ${database}.* TO ai_control_runtime_role;
GRANT SELECT ON system.disks TO ai_control_runtime_role;
REVOKE SELECT, INSERT ON ${database}.clickhouse_schema_migrations FROM ai_control_runtime_role;
REVOKE SELECT, INSERT ON ${database}.__clickhouse_schema_migration_lock FROM ai_control_runtime_role;
GRANT SELECT, INSERT, CREATE TABLE, CREATE VIEW, CREATE DICTIONARY, ALTER TABLE, ALTER VIEW, DROP TABLE, DROP VIEW, DROP DICTIONARY, TRUNCATE, OPTIMIZE ON ${database}.* TO ai_control_migration_role;
GRANT SELECT ON system.tables TO ai_control_migration_role;

CREATE USER IF NOT EXISTS ${application_user}
  IDENTIFIED WITH sha256_password BY '${application_password}';
GRANT ai_control_runtime_role TO ${application_user};
ALTER USER ${application_user} DEFAULT ROLE ai_control_runtime_role;

CREATE USER IF NOT EXISTS ${migration_user}
  IDENTIFIED WITH sha256_password BY '${migration_password}';
GRANT ai_control_migration_role TO ${migration_user};
ALTER USER ${migration_user} DEFAULT ROLE ai_control_migration_role;
SQL

printf 'Created least-privilege ClickHouse application and migration users\n'
