#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../../.." && pwd)
fingerprint_script=$script_directory/postgresql-authority-fingerprint.mjs
compare_script=$script_directory/compare-postgresql-authority-fingerprints.mjs

[[ ${REMOTE_DOCKER_ACCEPTANCE:-} == 1 ]] || {
  printf 'REMOTE_DOCKER_ACCEPTANCE=1 is required\n' >&2
  exit 64
}
[[ ${ACCEPTANCE_PROJECT:-} =~ ^tokenpilot-acceptance-[0-9]{14}-[0-9]+-[a-f0-9]{6}$ ]] || {
  printf 'The isolated acceptance project is invalid\n' >&2
  exit 64
}
for command in node pnpm psql realpath; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is unavailable: %s\n' "$command" >&2
    exit 69
  }
done
source_database_url=${DATABASE_URL:?DATABASE_URL is required}
[[ -d ${BACKUP_SET:-} ]] || {
  printf 'The current isolated backup set is invalid\n' >&2
  exit 64
}
backup_set=$(realpath "$BACKUP_SET")
if [[ "$backup_set" != /backups/tokenpilot-* ]]; then
  printf 'The backup set is outside the authorized isolated mounts\n' >&2
  exit 64
fi
[[ ${RESTORE_DATABASE:-} =~ ^tokenpilot_restore_[a-z0-9_]{1,40}$ ]] || {
  printf 'The restore database name is invalid\n' >&2
  exit 64
}
[[ ${ACCEPTANCE_BACKUP_EVIDENCE:-} == /backups/postgresql-authority ]] || {
  printf 'ACCEPTANCE_BACKUP_EVIDENCE must be /backups/postgresql-authority\n' >&2
  exit 64
}
for file in "$fingerprint_script" "$compare_script"; do
  [[ -f "$file" ]] || {
    printf 'Required authority fingerprint helper is missing\n' >&2
    exit 69
  }
done

mkdir -p "$ACCEPTANCE_BACKUP_EVIDENCE"
chmod 700 "$ACCEPTANCE_BACKUP_EVIDENCE"
evidence=$ACCEPTANCE_BACKUP_EVIDENCE/$RESTORE_DATABASE
[[ ! -e "$evidence" && ! -L "$evidence" ]] || {
  printf 'Refusing to overwrite PostgreSQL authority evidence\n' >&2
  exit 73
}
mkdir "$evidence"
chmod 700 "$evidence"

cd "$repository_root"
scripts/verify-backup.sh --backup "$backup_set" >"$evidence/backup-verification.txt" 2>&1
# JavaScript reads BACKUP_SET from its environment.
# shellcheck disable=SC2016
backup_database=$(BACKUP_SET="$backup_set" node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(`${process.env.BACKUP_SET}/manifest.json`, "utf8"));
  if (typeof manifest.database_name !== "string" || manifest.database_name.length === 0) process.exit(64);
  process.stdout.write(manifest.database_name);
')

database_host=$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).hostname)')
database_name=$(node -e 'process.stdout.write(new URL(process.env.DATABASE_URL).pathname.slice(1))')
[[ "$database_host" == postgres && "$database_name" == tokenpilot ]] || {
  printf 'The backup/restore drill must use the fresh isolated tokenpilot database\n' >&2
  exit 64
}
[[ "$database_name" == "$backup_database" && "$RESTORE_DATABASE" != "$database_name" ]] || {
  printf 'The backup/restore drill is not attached to the isolated database\n' >&2
  exit 64
}

admin_url=$(node -e '
  const value = new URL(process.env.DATABASE_URL);
  value.pathname = "/postgres";
  process.stdout.write(value.toString());
')
# JavaScript reads RESTORE_DATABASE from its environment.
# shellcheck disable=SC2016
restore_url=$(RESTORE_DATABASE="$RESTORE_DATABASE" node -e '
  const value = new URL(process.env.DATABASE_URL);
  value.pathname = `/${process.env.RESTORE_DATABASE}`;
  process.stdout.write(value.toString());
')
drop_restore() {
  set +e
  psql "$admin_url" -X -q -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$RESTORE_DATABASE' AND pid <> pg_backend_pid()" \
    >/dev/null
  psql "$admin_url" -X -q -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$RESTORE_DATABASE\"" >/dev/null
}
trap drop_restore EXIT

fingerprint() {
  local database_url=$1 output=$2 log=$3
  AUTHORITY_DATABASE_URL="$database_url" node "$fingerprint_script" \
    --database-url-env AUTHORITY_DATABASE_URL --output "$output" >"$log" 2>&1
}

compare() {
  local before=$1 after=$2 output=$3
  node "$compare_script" "$before" "$after" >"$output" 2>&1
}

source_before=$evidence/source-before.json
fingerprint "$source_database_url" "$source_before" "$evidence/source-before.txt"

psql "$admin_url" -X -q -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$RESTORE_DATABASE\"" >/dev/null
scripts/restore-postgres.sh --backup "$backup_set" --target-url "$restore_url" \
  --confirm-empty-database "$RESTORE_DATABASE" >"$evidence/restore.txt" 2>&1

fingerprint "$restore_url" "$evidence/restore-current.json" \
  "$evidence/restore-current.txt"
compare "$source_before" "$evidence/restore-current.json" \
  "$evidence/restore-comparison.txt"

DATABASE_URL=$restore_url pnpm --filter @tokenpilot/db db:migrate \
  >"$evidence/migrate-first.txt" 2>&1
grep -Eiq 'No pending migrations' "$evidence/migrate-first.txt" || {
  printf 'The restored current schema unexpectedly required migration\n' >&2
  exit 70
}
fingerprint "$restore_url" "$evidence/after-migrate-first.json" \
  "$evidence/after-migrate-first.txt"
compare "$source_before" "$evidence/after-migrate-first.json" \
  "$evidence/migrate-first-comparison.txt"

DATABASE_URL=$restore_url pnpm --filter @tokenpilot/db db:migrate \
  >"$evidence/migrate-second.txt" 2>&1
grep -Eiq 'No pending migrations' "$evidence/migrate-second.txt" || {
  printf 'The second PostgreSQL migration was not an explicit no-op\n' >&2
  exit 70
}
fingerprint "$restore_url" "$evidence/after-migrate-second.json" \
  "$evidence/after-migrate-second.txt"
compare "$evidence/after-migrate-first.json" "$evidence/after-migrate-second.json" \
  "$evidence/migrate-second-comparison.txt"

DATABASE_URL=$restore_url pnpm --filter @tokenpilot/db db:seed \
  >"$evidence/seed-first.txt" 2>&1
fingerprint "$restore_url" "$evidence/after-seed-first.json" \
  "$evidence/after-seed-first.txt"
compare "$evidence/after-migrate-first.json" "$evidence/after-seed-first.json" \
  "$evidence/seed-first-comparison.txt"

DATABASE_URL=$restore_url pnpm --filter @tokenpilot/db db:seed \
  >"$evidence/seed-second.txt" 2>&1
fingerprint "$restore_url" "$evidence/after-seed-second.json" \
  "$evidence/after-seed-second.txt"
compare "$evidence/after-seed-first.json" "$evidence/after-seed-second.json" \
  "$evidence/seed-idempotency-comparison.txt"
compare "$evidence/after-migrate-first.json" "$evidence/after-seed-second.json" \
  "$evidence/final-authority-comparison.txt"

find "$evidence" -type f -exec chmod 600 {} +
printf 'PASS fresh isolated PostgreSQL backup/restore, two migration no-ops, and seed idempotency evidence=%s\n' \
  "$evidence"
