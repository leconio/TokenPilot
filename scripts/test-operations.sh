#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/.." && pwd)
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT
export PYTHONPYCACHEPREFIX="$temporary_directory/python-cache"

expect_failure() {
  if "$@" >"$temporary_directory/expected-failure.stdout" \
    2>"$temporary_directory/expected-failure.stderr"; then
    printf 'command unexpectedly succeeded: %s\n' "$*" >&2
    exit 1
  fi
}

for script in "$script_directory"/*.sh "$script_directory"/lib/*.sh; do
  bash -n "$script"
done
python3 -m py_compile "$script_directory/connector-spool-admin.py"
(cd "$repository_root" && node scripts/check-version-consistency.mjs)

generated_environment=$temporary_directory/generated.env
(cd "$repository_root" && scripts/init-env.sh "$generated_environment" >/dev/null)
permissions=$(stat -c '%a' "$generated_environment" 2>/dev/null || stat -f '%Lp' "$generated_environment")
[[ "$permissions" == 600 ]]
grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$generated_environment"
grep -Fqx 'POSTGRES_DB=tokenpilot' "$generated_environment"
grep -Eq '^API_KEY_PEPPER=[0-9a-f]{64}$' "$generated_environment"
grep -Eq '^CLICKHOUSE_BOOTSTRAP_PASSWORD=[0-9a-f]{64}$' "$generated_environment"
grep -Eq '^CLICKHOUSE_PASSWORD=[0-9a-f]{64}$' "$generated_environment"
grep -Eq '^CLICKHOUSE_MIGRATION_PASSWORD=[0-9a-f]{64}$' "$generated_environment"
grep -Eq '^AIU_RESERVATION_SIGNING_KEY=[0-9a-f]{64}$' "$generated_environment"
grep -Fqx 'AIU_MODE=observe' "$generated_environment"
grep -Eq '^RECONCILIATION_USER_HMAC_SECRET=[0-9a-f]{64}$' "$generated_environment"
secret_count=$(awk -F= '
  /^(POSTGRES_PASSWORD|API_KEY_PEPPER|CLICKHOUSE_BOOTSTRAP_PASSWORD|CLICKHOUSE_PASSWORD|CLICKHOUSE_MIGRATION_PASSWORD|AIU_RESERVATION_SIGNING_KEY|RECONCILIATION_USER_HMAC_SECRET)=/ { print $2 }
' "$generated_environment" | sort -u | wc -l | tr -d ' ')
[[ "$secret_count" == 7 ]]
if (cd "$repository_root" && scripts/init-env.sh "$generated_environment" >/dev/null 2>&1); then
  printf 'init-env unexpectedly overwrote an existing file\n' >&2
  exit 1
fi

fake_mode_bin=$temporary_directory/fake-mode-bin
mkdir -p "$fake_mode_bin"
cat >"$fake_mode_bin/stat" <<'SH'
#!/bin/sh
printf '777\n'
SH
chmod +x "$fake_mode_bin/stat"
unsupported_mode_environment=$temporary_directory/unsupported-mode.env
expect_failure env PATH="$fake_mode_bin:$PATH" \
  "$script_directory/init-env.sh" "$unsupported_mode_environment"
[[ ! -e "$unsupported_mode_environment" ]]
grep -Fq 'The filesystem cannot enforce mode 0600' \
  "$temporary_directory/expected-failure.stderr"

deploy_fixture=$temporary_directory/deploy-fixture
fake_bin=$temporary_directory/fake-bin
mkdir -p "$deploy_fixture/scripts" "$fake_bin"
cp "$script_directory/deploy.sh" "$deploy_fixture/scripts/deploy.sh"
cp "$generated_environment" "$deploy_fixture/.env"
cat >"$fake_bin/uname" <<'SH'
#!/bin/sh
printf 'Linux\n'
SH
cat >"$fake_bin/docker" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [ "$*" = "compose up --detach --build --wait --remove-orphans" ] &&
  [ "${FAKE_DOCKER_UP_STATUS:-0}" -ne 0 ]; then
  exit "$FAKE_DOCKER_UP_STATUS"
fi
exit 0
SH
chmod +x "$fake_bin/uname" "$fake_bin/docker"

deploy_log=$temporary_directory/deploy-success.log
deploy_stdout=$temporary_directory/deploy-success.stdout
(
  cd "$deploy_fixture"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$deploy_log" HTTP_PORT=15000 \
    scripts/deploy.sh >"$deploy_stdout"
)
(
  cd "$deploy_fixture"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$deploy_log" HTTP_PORT=15000 \
    scripts/deploy.sh >>"$deploy_stdout"
)
grep -Fqx 'compose version' "$deploy_log"
grep -Fqx 'compose config --quiet' "$deploy_log"
[[ "$(grep -Fxc 'compose up --detach --build --wait --remove-orphans' "$deploy_log")" == 2 ]]
[[ "$(grep -Fxc 'compose rm --force migrate clickhouse-migrate' "$deploy_log")" == 2 ]]
grep -Fqx 'TokenPilot is ready at http://127.0.0.1:15000' "$deploy_stdout"

failed_deploy_log=$temporary_directory/deploy-failure.log
failed_deploy_stderr=$temporary_directory/deploy-failure.stderr
if (
  cd "$deploy_fixture"
  PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$failed_deploy_log" FAKE_DOCKER_UP_STATUS=42 \
    scripts/deploy.sh >"$temporary_directory/deploy-failure.stdout" 2>"$failed_deploy_stderr"
); then
  printf 'deploy unexpectedly succeeded after the Compose up failure\n' >&2
  exit 1
fi
grep -Fqx 'compose ps --all' "$failed_deploy_log"
grep -Fqx \
  'compose logs --no-color --tail=200 postgres redis clickhouse clickhouse-migrate migrate api worker scheduler web caddy' \
  "$failed_deploy_log"
grep -Fqx 'TokenPilot deployment failed; current Compose state follows.' "$failed_deploy_stderr"

spool=$temporary_directory/current-spool.sqlite3
python3 - "$spool" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.executescript(
    """
    CREATE TABLE spool_events (
      event_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at REAL NOT NULL,
      lease_until REAL,
      created_at REAL NOT NULL,
      last_error_code TEXT
    );
    CREATE INDEX spool_events_ready_idx
      ON spool_events (state, available_at, created_at);
    CREATE TABLE spool_rejected (
      event_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      rejected_at REAL NOT NULL
    );
    CREATE TABLE spool_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    PRAGMA user_version=1;
    """
)
connection.close()
PY
python3 "$script_directory/connector-spool-admin.py" integrity --spool "$spool" >/dev/null
python3 "$script_directory/connector-spool-admin.py" backup \
  --spool "$spool" \
  --output "$temporary_directory/spool-backup.sqlite3" >/dev/null
(cd "$temporary_directory" && sha256sum --check spool-backup.sqlite3.sha256 >/dev/null)
python3 "$script_directory/connector-spool-admin.py" integrity \
  --spool "$temporary_directory/spool-backup.sqlite3" >/dev/null
expect_failure python3 "$script_directory/connector-spool-admin.py" backup \
  --spool "$spool" \
  --output "$temporary_directory/spool-backup.sqlite3"
[[ "$(python3 - "$spool" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
print(connection.execute("PRAGMA user_version").fetchone()[0])
connection.close()
PY
)" == 1 ]]

revision_zero_spool=$temporary_directory/revision-zero-spool.sqlite3
cp "$spool" "$revision_zero_spool"
python3 - "$revision_zero_spool" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("PRAGMA user_version=0")
connection.close()
PY
expect_failure python3 "$script_directory/connector-spool-admin.py" integrity \
  --spool "$revision_zero_spool"
expect_failure python3 "$script_directory/connector-spool-admin.py" migrate \
  --spool "$revision_zero_spool" \
  --output "$temporary_directory/migrated.sqlite3"

future_spool=$temporary_directory/future-spool.sqlite3
cp "$spool" "$future_spool"
python3 - "$future_spool" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("PRAGMA user_version=2")
connection.close()
PY
expect_failure python3 "$script_directory/connector-spool-admin.py" integrity \
  --spool "$future_spool"

invalid_state_spool=$temporary_directory/invalid-state-spool.sqlite3
cp "$spool" "$invalid_state_spool"
python3 - "$invalid_state_spool" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("PRAGMA ignore_check_constraints=ON")
connection.execute(
    "INSERT INTO spool_events"
    "(event_id, payload_json, state, available_at, created_at) "
    "VALUES ('bad-state', '{}', 'sent', 0, 0)"
)
connection.commit()
connection.close()
PY
expect_failure python3 "$script_directory/connector-spool-admin.py" integrity \
  --spool "$invalid_state_spool"

missing_table_spool=$temporary_directory/missing-table-spool.sqlite3
python3 - "$missing_table_spool" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("CREATE TABLE spool_events(event_id TEXT PRIMARY KEY, state TEXT NOT NULL)")
connection.execute("PRAGMA user_version=1")
connection.close()
PY
expect_failure python3 "$script_directory/connector-spool-admin.py" integrity \
  --spool "$missing_table_spool"

missing_index_spool=$temporary_directory/missing-index-spool.sqlite3
cp "$spool" "$missing_index_spool"
python3 - "$missing_index_spool" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("DROP INDEX spool_events_ready_idx")
connection.close()
PY
expect_failure python3 "$script_directory/connector-spool-admin.py" integrity \
  --spool "$missing_index_spool"

corrupt_spool=$temporary_directory/corrupt-spool.sqlite3
printf 'not a sqlite database\n' >"$corrupt_spool"
expect_failure python3 "$script_directory/connector-spool-admin.py" integrity \
  --spool "$corrupt_spool"

node "$script_directory/quality/check-compose-source.mjs"

printf 'Operations checks passed.\n'
