#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)
# shellcheck source=scripts/lib/operations.sh
source "$repository_root/scripts/lib/operations.sh"

output=${1:-$repository_root/artifacts/release/SHA256SUMS}
if (($# > 0)); then shift; fi

if (($# == 0)); then
  files=(
    CHANGELOG.md
    README.md
    README.zh-CN.md
    package.json
    pnpm-lock.yaml
    connectors/litellm/pyproject.toml
    connectors/litellm/uv.lock
    sdks/python/pyproject.toml
    sdks/python/uv.lock
    deploy/release/release-policy.json
    docs/README.md
    docs/README.zh-CN.md
    docs/guide.md
    docs/guide.zh-CN.md
    docs/concepts.md
    docs/concepts.zh-CN.md
    docs/integration.md
    docs/integration.zh-CN.md
    docs/deployment.md
    docs/deployment.zh-CN.md
    docs/tutorial.md
    docs/tutorial.zh-CN.md
    docs/operations.md
    docs/operations.zh-CN.md
    docs/api.md
    docs/api.zh-CN.md
    docs/development.md
    docs/development.zh-CN.md
  )
else
  files=("$@")
fi

umask 077
mkdir -p "$(dirname "$output")"
temporary=$output.tmp-$$
trap 'rm -f "$temporary"' EXIT
: >"$temporary"

for file in "${files[@]}"; do
  [[ "$file" != /* ]] || operations_die "checksum inputs must be repository-relative: $file"
  [[ "$file" != *../* && "$file" != ../* ]] || operations_die "checksum input escapes repository: $file"
  [[ -f "$repository_root/$file" ]] || operations_die "checksum input is missing: $file"
  printf '%s  %s\n' "$(operations_sha256 "$repository_root/$file")" "$file" >>"$temporary"
done

LC_ALL=C sort -k2 "$temporary" -o "$temporary"
mv "$temporary" "$output"
chmod 600 "$output"
trap - EXIT
printf 'Release checksums: %s\n' "$output"
