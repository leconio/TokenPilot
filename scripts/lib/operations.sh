#!/usr/bin/env bash

operations_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

operations_require_command() {
  command -v "$1" >/dev/null 2>&1 || operations_die "required command not found: $1"
}

operations_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    operations_die "sha256sum or shasum is required"
  fi
}

operations_file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

operations_json_escape() {
  local value=${1//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

operations_manifest_string() {
  local manifest=$1 key=$2
  sed -nE 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$manifest" | head -n 1
}

operations_manifest_number() {
  local manifest=$1 key=$2
  sed -nE 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p' "$manifest" | head -n 1
}
