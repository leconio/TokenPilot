#!/usr/bin/env bash

# Sourced by the guarded remote runner. Diagnostic commands run in isolated
# subshells so acceptance_die and errexit stop only the current stage.
# shellcheck disable=SC2034 # Status globals are consumed by the stage orchestrator.

diagnostic_batch_initialize() {
  local evidence=$1
  [[ -d "$evidence" && ! -L "$evidence" ]] || acceptance_die "diagnostic evidence is invalid"
  DIAGNOSTIC_EVIDENCE=$evidence
  DIAGNOSTIC_RESULTS=$evidence/diagnostic-stages.tsv
  DIAGNOSTIC_SUMMARY=$evidence/diagnostic-summary.txt
  DIAGNOSTIC_TOTAL=0
  DIAGNOSTIC_PASSED=0
  DIAGNOSTIC_FAILED=0
  DIAGNOSTIC_BLOCKED=0
  DIAGNOSTIC_LAST_STATUS=
  DIAGNOSTIC_LAST_EXIT_CODE=0
  printf 'stage\tstatus\texit_code\tduration_seconds\tevidence\tlabel\n' \
    >"$DIAGNOSTIC_RESULTS"
}

diagnostic_validate_stage() {
  local stage=$1 label=$2 output=$3
  [[ ${DIAGNOSTIC_EVIDENCE:-} != "" ]] || acceptance_die "diagnostic batch is not initialized"
  [[ "$stage" =~ ^[a-z0-9][a-z0-9-]*$ ]] || acceptance_die "diagnostic stage ID is invalid"
  [[ "$label" != *$'\n'* && "$label" != *$'\t'* && -n "$label" ]] ||
    acceptance_die "diagnostic stage label is invalid"
  case "$output" in
    "$DIAGNOSTIC_EVIDENCE"/*) ;;
    *) acceptance_die "diagnostic output must stay inside its evidence directory" ;;
  esac
  [[ ! -L "$output" ]] || acceptance_die "diagnostic output must not be a symlink"
  if awk -F '\t' -v stage="$stage" 'NR > 1 && $1 == stage { found=1 } END { exit !found }' \
    "$DIAGNOSTIC_RESULTS"; then
    acceptance_die "diagnostic stage was already recorded: $stage"
  fi
}

diagnostic_record() {
  local stage=$1 status=$2 exit_code=$3 duration=$4 output=$5 label=$6 relative
  relative=${output#"$DIAGNOSTIC_EVIDENCE"/}
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$stage" "$status" "$exit_code" "$duration" "$relative" "$label" \
    >>"$DIAGNOSTIC_RESULTS"
  DIAGNOSTIC_TOTAL=$((DIAGNOSTIC_TOTAL + 1))
  case "$status" in
    PASS) DIAGNOSTIC_PASSED=$((DIAGNOSTIC_PASSED + 1)) ;;
    FAIL) DIAGNOSTIC_FAILED=$((DIAGNOSTIC_FAILED + 1)) ;;
    BLOCKED) DIAGNOSTIC_BLOCKED=$((DIAGNOSTIC_BLOCKED + 1)) ;;
    *) acceptance_die "diagnostic status is invalid" ;;
  esac
  DIAGNOSTIC_LAST_STATUS=$status
  DIAGNOSTIC_LAST_EXIT_CODE=$exit_code
}

diagnostic_run() {
  local stage=$1 label=$2 output=$3 started completed status
  shift 3
  (($# > 0)) || acceptance_die "diagnostic stage command is missing"
  diagnostic_validate_stage "$stage" "$label" "$output"
  printf '[acceptance] %s\n' "$label"
  started=$(date +%s)
  set +e
  (
    set -Eeuo pipefail
    "$@"
  ) >"$output" 2>&1
  status=$?
  set -e
  completed=$(date +%s)
  if [[ "$status" -eq 0 ]]; then
    diagnostic_record "$stage" PASS 0 "$((completed - started))" "$output" "$label"
  else
    diagnostic_record "$stage" FAIL "$status" "$((completed - started))" "$output" "$label"
    printf '[acceptance] recorded failure: %s (exit %s)\n' "$label" "$status" >&2
  fi
}

diagnostic_block() {
  local stage=$1 label=$2 output=$3 reason=$4
  diagnostic_validate_stage "$stage" "$label" "$output"
  printf 'BLOCKED: %s\n' "$reason" >"$output"
  diagnostic_record "$stage" BLOCKED 125 0 "$output" "$label"
  printf '[acceptance] recorded blocked stage: %s\n' "$label" >&2
}

diagnostic_batch_finish() {
  {
    printf 'total=%s\npassed=%s\nfailed=%s\nblocked=%s\n' \
      "$DIAGNOSTIC_TOTAL" "$DIAGNOSTIC_PASSED" "$DIAGNOSTIC_FAILED" "$DIAGNOSTIC_BLOCKED"
    if [[ "$DIAGNOSTIC_FAILED" -eq 0 && "$DIAGNOSTIC_BLOCKED" -eq 0 ]]; then
      printf 'status=PASS\n'
    else
      printf 'status=FAIL\n'
      awk -F '\t' 'NR > 1 && $2 != "PASS" { printf "%s\t%s\texit=%s\t%s\n", $1, $2, $3, $6 }' \
        "$DIAGNOSTIC_RESULTS"
    fi
  } >"$DIAGNOSTIC_SUMMARY"
  [[ "$DIAGNOSTIC_FAILED" -eq 0 && "$DIAGNOSTIC_BLOCKED" -eq 0 ]]
}
