#!/usr/bin/env bash
set -euo pipefail

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH='' cd -- "$script_directory/../.." && pwd)

profile=
actor=
reason=
apply=false
evidence_directory=

usage() {
  printf 'Usage: %s --profile <analytics|observe|soft-limit|hard-limit> --actor ID --reason TEXT [--apply] [--evidence-dir DIR]\n' "$0" >&2
}

while (($# > 0)); do
  case "$1" in
    --profile)
      (($# >= 2)) || { usage; exit 64; }
      profile=$2
      shift 2
      ;;
    --actor)
      (($# >= 2)) || { usage; exit 64; }
      actor=$2
      shift 2
      ;;
    --reason)
      (($# >= 2)) || { usage; exit 64; }
      reason=$2
      shift 2
      ;;
    --apply)
      apply=true
      shift
      ;;
    --evidence-dir)
      (($# >= 2)) || { usage; exit 64; }
      evidence_directory=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

[[ -n "$profile" && -n "$actor" && ${#reason} -ge 5 ]] || { usage; exit 64; }

case "$profile" in
  analytics)
    assignments=(
      model_catalog=true
      aiu=false quota=false hard_limit=false reconciliation=true
    )
    ;;
  observe)
    assignments=(
      model_catalog=true
      aiu=true quota=false hard_limit=false reconciliation=true
    )
    ;;
  soft-limit)
    assignments=(
      model_catalog=true
      aiu=true quota=true hard_limit=false reconciliation=true
    )
    ;;
  hard-limit)
    assignments=(
      model_catalog=true
      aiu=true quota=true hard_limit=true reconciliation=true
    )
    ;;
  *)
    printf 'Unknown feature profile: %s\n' "$profile" >&2
    exit 64
    ;;
esac

if [[ "$apply" != true ]]; then
  printf '{"mode":"plan","profile":"%s","assignments":[' "$profile"
  separator=
  for assignment in "${assignments[@]}"; do
    printf '%s"%s"' "$separator" "$assignment"
    separator=,
  done
  printf ']}\n'
  exit 0
fi

[[ -n ${DATABASE_URL:-} ]] || { printf 'DATABASE_URL is required with --apply\n' >&2; exit 64; }
if [[ -z "$evidence_directory" ]]; then
  evidence_directory=$repository_root/artifacts/release/feature-$(date -u +%Y%m%dT%H%M%SZ)
fi
umask 077
mkdir -p "$evidence_directory"
chmod 700 "$evidence_directory"

(cd "$repository_root" && pnpm ops:feature-flags show) >"$evidence_directory/before.json"
(cd "$repository_root" && pnpm ops:feature-flags set "${assignments[@]}" \
  --actor "$actor" --reason "$reason") >"$evidence_directory/change.json"
(cd "$repository_root" && pnpm ops:feature-flags show) >"$evidence_directory/after.json"
chmod 600 "$evidence_directory"/*.json

printf 'Applied audited feature profile %s; restart and verify Worker before serving traffic.\n' "$profile"
printf 'Evidence: %s\n' "$evidence_directory"
