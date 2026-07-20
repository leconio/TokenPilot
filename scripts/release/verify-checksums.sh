#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$repository_root/scripts/lib/operations.sh"

manifest=${1:-$repository_root/artifacts/release/SHA256SUMS}
[[ -f "$manifest" ]] || operations_die "checksum manifest is missing: $manifest"

while IFS= read -r line; do
  expected=${line%%  *}
  file=${line#*  }
  [[ "$file" != "$line" ]] || operations_die "checksum manifest line is malformed"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || operations_die "checksum manifest contains an invalid hash"
  [[ -n "$file" && "$file" != /* && "$file" != *../* && "$file" != ../* ]] || \
    operations_die "checksum manifest contains an unsafe path"
  [[ -f "$repository_root/$file" ]] || operations_die "checksummed file is missing: $file"
  [[ "$(operations_sha256 "$repository_root/$file")" == "$expected" ]] || \
    operations_die "checksum mismatch: $file"
done <"$manifest"

printf 'Release checksums verified: %s\n' "$manifest"
