#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$script_directory/lib/operations.sh"

backup_directory=
maximum_age_hours=

usage() {
  printf 'Usage: %s --backup DIR [--max-age-hours HOURS]\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --backup)
      (($# >= 2)) || { usage; exit 2; }
      backup_directory=$2
      shift 2
      ;;
    --max-age-hours)
      (($# >= 2)) || { usage; exit 2; }
      maximum_age_hours=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ -n "$backup_directory" ]] || { usage; exit 2; }
[[ -d "$backup_directory" && ! -L "$backup_directory" ]] || \
  operations_die "backup directory is missing or unsafe: $backup_directory"
operations_require_command find
entry_count=0
while IFS= read -r -d '' entry; do
  entry_count=$((entry_count + 1))
  case "${entry##*/}" in
    manifest.json|database.dump|database.dump.sha256|postgresql-authority.json|postgresql-authority.json.sha256) ;;
    *) operations_die "unexpected backup entry: ${entry##*/}" ;;
  esac
done < <(find "$backup_directory" -mindepth 1 -maxdepth 1 -print0)
[[ "$entry_count" -eq 5 ]] || operations_die "backup set must contain exactly five current files"
for file in manifest.json database.dump database.dump.sha256 postgresql-authority.json postgresql-authority.json.sha256; do
  [[ -f "$backup_directory/$file" && ! -L "$backup_directory/$file" ]] || \
    operations_die "backup file is missing or unsafe: $file"
  [[ "$(operations_file_mode "$backup_directory/$file")" == 600 ]] || \
    operations_die "$file must have mode 0600"
done
[[ "$(operations_file_mode "$backup_directory")" == 700 ]] || operations_die "backup directory must have mode 0700"

operations_require_command pg_restore
operations_require_command node
dump_expected=$(awk 'NR == 1 {print $1}' "$backup_directory/database.dump.sha256")
authority_expected=$(awk 'NR == 1 {print $1}' "$backup_directory/postgresql-authority.json.sha256")
[[ "$dump_expected" =~ ^[0-9a-f]{64}$ ]] || operations_die "invalid dump checksum file"
[[ "$authority_expected" =~ ^[0-9a-f]{64}$ ]] || operations_die "invalid authority checksum file"
[[ "$(operations_sha256 "$backup_directory/database.dump")" == "$dump_expected" ]] || \
  operations_die "database dump checksum mismatch"
[[ "$(operations_sha256 "$backup_directory/postgresql-authority.json")" == "$authority_expected" ]] || \
  operations_die "PostgreSQL authority checksum mismatch"

manifest_schema=$(operations_manifest_string "$backup_directory/manifest.json" schema_version)
manifest_dump_file=$(operations_manifest_string "$backup_directory/manifest.json" dump_file)
manifest_dump_format=$(operations_manifest_string "$backup_directory/manifest.json" dump_format)
manifest_dump_sha=$(operations_manifest_string "$backup_directory/manifest.json" dump_sha256)
manifest_authority_file=$(operations_manifest_string \
  "$backup_directory/manifest.json" postgresql_authority_file)
manifest_authority_sha=$(operations_manifest_string \
  "$backup_directory/manifest.json" postgresql_authority_sha256)
[[ "$manifest_schema" == 2.0 ]] || operations_die "unsupported backup manifest schema"
[[ "$manifest_dump_file" == database.dump && "$manifest_dump_format" == custom ]] || \
  operations_die "backup manifest dump declaration is invalid"
[[ "$manifest_dump_sha" == "$dump_expected" ]] || operations_die "manifest dump checksum mismatch"
[[ "$manifest_authority_file" == postgresql-authority.json ]] || \
  operations_die "backup manifest authority declaration is invalid"
[[ "$manifest_authority_sha" == "$authority_expected" ]] || \
  operations_die "manifest authority checksum mismatch"
node "$script_directory/acceptance/remote/compare-postgresql-authority-fingerprints.mjs" \
  --validate "$backup_directory/postgresql-authority.json" >/dev/null
pg_restore --list "$backup_directory/database.dump" >/dev/null

if [[ -n "$maximum_age_hours" ]]; then
  [[ "$maximum_age_hours" =~ ^[0-9]+$ ]] || operations_die "maximum age must be a whole number of hours"
  created_at_epoch=$(operations_manifest_number "$backup_directory/manifest.json" created_at_epoch)
  [[ "$created_at_epoch" =~ ^[0-9]+$ ]] || operations_die "manifest created_at_epoch is missing"
  age_seconds=$(($(date -u +%s) - created_at_epoch))
  ((age_seconds >= 0)) || operations_die "backup timestamp is in the future"
  ((age_seconds <= maximum_age_hours * 3600)) || operations_die "backup is older than ${maximum_age_hours}h"
fi

printf 'Backup verified: %s\n' "$backup_directory"
