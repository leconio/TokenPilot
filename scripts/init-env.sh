#!/bin/sh

set -eu

output=${1:-.env}
template=.env.example

if [ ! -f "$template" ]; then
  printf 'Template not found: %s\n' "$template" >&2
  exit 66
fi
if [ -e "$output" ]; then
  printf 'Refusing to overwrite existing environment file: %s\n' "$output" >&2
  exit 73
fi
if ! command -v openssl >/dev/null 2>&1; then
  printf 'openssl is required to generate local secrets\n' >&2
  exit 69
fi

parent=${output%/*}
if [ "$parent" = "$output" ]; then
  parent=.
fi
mkdir -p "$parent"
umask 077

temporary=$(mktemp "$parent/.tokenpilot-env.XXXXXX")
secret_file=$(mktemp "$parent/.tokenpilot-secrets.XXXXXX")
trap 'rm -f "$temporary" "$secret_file"' EXIT HUP INT TERM

{
  openssl rand -hex 24
  openssl rand -hex 32
  openssl rand -hex 32
  openssl rand -hex 32
  openssl rand -hex 32
  openssl rand -hex 32
  openssl rand -hex 32
} >"$secret_file"
chmod 600 "$secret_file"

awk \
  -v secret_file="$secret_file" '
  BEGIN {
    FS = OFS = "="
    if ((getline postgres_password < secret_file) != 1 ||
      (getline api_key_pepper < secret_file) != 1 ||
      (getline clickhouse_bootstrap_password < secret_file) != 1 ||
      (getline clickhouse_application_password < secret_file) != 1 ||
      (getline clickhouse_migration_password < secret_file) != 1 ||
      (getline reservation_signing_key < secret_file) != 1 ||
      (getline reconciliation_hmac_secret < secret_file) != 1) {
      print "Failed to read generated secrets" > "/dev/stderr"
      exit 65
    }
    close(secret_file)
  }
  $1 == "POSTGRES_PASSWORD" { $2 = postgres_password }
  $1 == "DATABASE_URL" {
    $2 = "postgresql://tokenpilot:" postgres_password "@postgres:5432/tokenpilot"
  }
  $1 == "API_KEY_PEPPER" { $2 = api_key_pepper }
  $1 == "CLICKHOUSE_BOOTSTRAP_PASSWORD" { $2 = clickhouse_bootstrap_password }
  $1 == "CLICKHOUSE_PASSWORD" { $2 = clickhouse_application_password }
  $1 == "CLICKHOUSE_MIGRATION_PASSWORD" { $2 = clickhouse_migration_password }
  $1 == "AIU_RESERVATION_SIGNING_KEY" { $2 = reservation_signing_key }
  $1 == "RECONCILIATION_USER_HMAC_SECRET" { $2 = reconciliation_hmac_secret }
  { print }
' "$template" >"$temporary"

chmod 600 "$temporary"
if ! ln "$temporary" "$output" 2>/dev/null; then
  printf 'Refusing to overwrite existing environment file: %s\n' "$output" >&2
  exit 73
fi

permissions=$(stat -c '%a' "$output" 2>/dev/null || stat -f '%Lp' "$output" 2>/dev/null || true)
if [ "$permissions" != 600 ]; then
  rm -f "$output"
  printf 'The filesystem cannot enforce mode 0600 for %s.\n' "$output" >&2
  printf 'Use a native Linux filesystem; on WSL, use the distro filesystem or enable DrvFS metadata.\n' >&2
  exit 77
fi

rm -f "$temporary" "$secret_file"
trap - EXIT HUP INT TERM
printf 'Created mode-0600 environment file: %s\n' "$output"
printf 'Review INSTANCE_ID, public URLs, and ingress settings before use.\n'
