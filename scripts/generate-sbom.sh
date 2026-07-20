#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/.." && pwd)
target=${1:-dir:$repository_root}
output=${2:-$repository_root/.sbom/repository.cdx.json}
mkdir -p "$(dirname "$output")"

command -v syft >/dev/null 2>&1 || {
  printf 'Syft is required; this script never starts a local container.\n' >&2
  exit 1
}
syft "$target" --output "cyclonedx-json=$output"

[[ -s "$output" ]] || { printf 'SBOM was not created: %s\n' "$output" >&2; exit 1; }
chmod 600 "$output"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$output" >"$output.sha256"
else
  shasum -a 256 "$output" >"$output.sha256"
fi
chmod 600 "$output.sha256"
printf 'CycloneDX SBOM: %s\n' "$output"
