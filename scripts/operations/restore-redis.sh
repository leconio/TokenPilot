#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$repository_root/scripts/lib/operations.sh"

backup_directory=
target_directory=
confirmed_directory=
confirmed_stopped=false

usage() {
  printf 'Usage: %s --backup DIR --target-data-directory DIR --confirm-empty-directory DIR --confirm-redis-stopped\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --backup) backup_directory=$2; shift 2 ;;
    --target-data-directory) target_directory=$2; shift 2 ;;
    --confirm-empty-directory) confirmed_directory=$2; shift 2 ;;
    --confirm-redis-stopped) confirmed_stopped=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

[[ -n "$backup_directory" && -n "$target_directory" ]] || { usage; exit 2; }
[[ "$confirmed_stopped" == true ]] || operations_die "explicit Redis-stopped confirmation is required"
[[ "$target_directory" == "$confirmed_directory" ]] || operations_die "target directory confirmation does not match"
[[ -d "$target_directory" ]] || operations_die "target data directory does not exist"
[[ -f "$backup_directory/dump.rdb" && -f "$backup_directory/dump.rdb.sha256" ]] || \
  operations_die "Redis backup is incomplete"
operations_require_command redis-check-rdb
expected=$(awk 'NR == 1 {print $1}' "$backup_directory/dump.rdb.sha256")
[[ "$(operations_sha256 "$backup_directory/dump.rdb")" == "$expected" ]] || operations_die "Redis dump checksum mismatch"
redis-check-rdb "$backup_directory/dump.rdb" >/dev/null
if find "$target_directory" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  operations_die "target data directory must be empty"
fi
temporary=$target_directory/.dump.rdb.restore.$$
trap 'rm -f "$temporary"' EXIT
cp "$backup_directory/dump.rdb" "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$target_directory/dump.rdb"
trap - EXIT
printf 'Redis RDB staged in stopped isolated target %s; verify queues after startup.\n' "$target_directory"
