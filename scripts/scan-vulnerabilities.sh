#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/.." && pwd)
target=${1:-$repository_root}

if command -v trivy >/dev/null 2>&1; then
  if [[ -d "$target" ]]; then
    trivy fs --scanners vuln --severity HIGH,CRITICAL --exit-code 1 "$target"
  else
    trivy image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 "$target"
  fi
elif command -v grype >/dev/null 2>&1; then
  if [[ -d "$target" ]]; then
    grype "dir:$target" --fail-on high
  else
    grype "$target" --fail-on high
  fi
else
  printf 'Install Trivy or Grype; container-based scanning runs only in remote acceptance.\n' >&2
  exit 1
fi
