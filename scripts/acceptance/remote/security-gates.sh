#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/acceptance/remote/lib.sh
source "$script_directory/lib.sh"
acceptance_guard_host

project=${ACCEPTANCE_PROJECT:?ACCEPTANCE_PROJECT is required}
evidence=${ACCEPTANCE_SECURITY_EVIDENCE:?ACCEPTANCE_SECURITY_EVIDENCE is required}
repository=${ACCEPTANCE_REPOSITORY:?ACCEPTANCE_REPOSITORY is required}
manifest=${ACCEPTANCE_IMAGE_MANIFEST:?ACCEPTANCE_IMAGE_MANIFEST is required}
temporary=${ACCEPTANCE_TEMPORARY:?ACCEPTANCE_TEMPORARY is required}
acceptance_validate_project "$project"
[[ -d "$repository" && -s "$manifest" ]] || acceptance_die "security gate inputs are missing"
[[ ${SOURCE_SHA:-} =~ ^[a-f0-9]{64}$ ]] || acceptance_die "SOURCE_SHA is required"
for command in awk cp docker find git node sha256sum sort stat tar; do
  acceptance_require_command "$command"
done

readonly trivy_image=aquasec/trivy@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e
readonly syft_image=anchore/syft@sha256:f94e5d9fce1f2278491a8e3a63bd5f6ddb81fdfdbb8bf7a1637565c1d5344357
cache=$temporary/trivy-cache
source_tree=$temporary/source-tree
image_archives=$temporary/image-archives
scanner_outputs=$temporary/scanner-outputs
source_archive=$temporary/source.tar
source_manifest=$temporary/source-files.sha256
mkdir -p "$evidence" "$cache" "$source_tree" "$image_archives" "$scanner_outputs"
chmod 700 "$evidence" "$cache" "$source_tree" "$image_archives" "$scanner_outputs"

(cd "$repository" && git ls-files --cached --others --exclude-standard -z | sort -z |
  while IFS= read -r -d '' file; do sha256sum -- "$file"; done) >"$source_manifest"
[[ "$(sha256sum "$source_manifest" | awk '{print $1}')" == "$SOURCE_SHA" ]] ||
  acceptance_die "source changed after the acceptance binding was recorded"
(cd "$repository" && git ls-files --cached --others --exclude-standard -z | sort -z |
  tar --null --verbatim-files-from -cf "$source_archive" -T -)
chmod 600 "$source_archive"
tar -xf "$source_archive" -C "$source_tree"
if find "$source_tree" -type l -print -quit | grep -q .; then
  acceptance_die "source snapshot contains a symlink"
fi
{
  printf 'source_sha=%s\n' "$SOURCE_SHA"
  sha256sum "$source_archive"
  stat -c 'archive_bytes=%s archive_mode=%a' "$source_archive"
} >"$evidence/source-archive.txt"
rm -f "$source_archive"

docker pull "$trivy_image" >"$evidence/trivy-pull.txt" 2>&1
docker pull "$syft_image" >"$evidence/syft-pull.txt" 2>&1
{
  docker image inspect --format \
    'scanner=trivy image_id={{.Id}} repo_digests={{json .RepoDigests}}' "$trivy_image"
  docker image inspect --format \
    'scanner=syft image_id={{.Id}} repo_digests={{json .RepoDigests}}' "$syft_image"
} >"$evidence/scanner-images.txt"

uid=$(id -u)
gid=$(id -g)
archive=
cleanup_archive() {
  [[ -z "$archive" ]] || rm -f -- "$archive"
}
trap cleanup_archive EXIT HUP INT TERM
common=(
  --rm
  --label "com.docker.compose.project=$project"
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges
  --user "$uid:$gid"
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,mode=1777"
)
proxy=(
  --env "HTTP_PROXY=$ACCEPTANCE_PROXY"
  --env "HTTPS_PROXY=$ACCEPTANCE_PROXY"
  --env "ALL_PROXY=$ACCEPTANCE_PROXY"
  --env "http_proxy=$ACCEPTANCE_PROXY"
  --env "https_proxy=$ACCEPTANCE_PROXY"
  --env "all_proxy=$ACCEPTANCE_PROXY"
  --env "NO_PROXY=$NO_PROXY"
  --env "no_proxy=$no_proxy"
)

scan_errors=0
finding_scopes=0
: >"$evidence/security-scan-status.txt"

record_scan_error() {
  local scope=$1 reason=$2
  scan_errors=$((scan_errors + 1))
  printf 'scope=%s status=ERROR reason=%s\n' "$scope" "$reason" \
    >>"$evidence/security-scan-status.txt"
}

validate_sbom() {
  node -e '
    const fs = require("node:fs");
    const sbom = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (
      sbom.bomFormat !== "CycloneDX" ||
      !Array.isArray(sbom.components) ||
      sbom.components.length === 0 ||
      !sbom.metadata ||
      typeof sbom.metadata !== "object"
    ) process.exit(1);
  ' "$1"
}

normalize_sbom() {
  node -e '
    const fs = require("node:fs");
    const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], `${JSON.stringify(input, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
  ' "$1" "$2"
}

archive_image_identity() {
  tar -xOf "$1" manifest.json | node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Array.isArray(manifest) || manifest.length !== 1) process.exit(65);
    const config = manifest[0]?.Config;
    const match = typeof config === "string"
      ? /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:[.]json)?$/u.exec(config)
      : null;
    if (match === null) process.exit(65);
    process.stdout.write(`sha256:${match[1]}`);
  '
}

analyze_report() {
  local scope=$1 report=$2 summary=$3 status
  set +e
  node "$script_directory/analyze-trivy-report.mjs" "$scope" "$report" "$summary"
  status=$?
  set -e
  ANALYZE_REPORT_STATUS=$status
  case "$status" in
    0) printf 'scope=%s status=PASS\n' "$scope" >>"$evidence/security-scan-status.txt" ;;
    1)
      finding_scopes=$((finding_scopes + 1))
      printf 'scope=%s status=FAIL reason=findings\n' "$scope" \
        >>"$evidence/security-scan-status.txt"
      ;;
    *) record_scan_error "$scope" "invalid-or-unreadable-report" ;;
  esac
}

docker run "${common[@]}" "${proxy[@]}" \
  --name "$project-trivy-db" \
  --volume "$cache:/cache" \
  "$trivy_image" image --cache-dir /cache --download-db-only \
  >"$evidence/trivy-db-download.txt" 2>&1
docker run "${common[@]}" --network none \
  --name "$project-trivy-version" \
  --volume "$cache:/cache:ro" \
  "$trivy_image" --cache-dir /cache --version >"$evidence/trivy-version-and-db.txt"

if docker run "${common[@]}" --network none \
  --name "$project-syft-repository" \
  --volume "$source_tree:/source:ro" \
  --volume "$scanner_outputs:/outputs" \
  "$syft_image" dir:/source -o cyclonedx-json=/outputs/repository.cdx.json \
  >"$evidence/syft-repository.txt" 2>&1; then
  if [[ -s "$scanner_outputs/repository.cdx.json" ]] && \
    validate_sbom "$scanner_outputs/repository.cdx.json"; then
    normalize_sbom "$scanner_outputs/repository.cdx.json" "$evidence/repository.cdx.json"
    printf 'scope=repository-sbom status=PASS\n' >>"$evidence/security-scan-status.txt"
  else
    record_scan_error repository-sbom "invalid-or-missing-cyclonedx"
  fi
else
  record_scan_error repository-sbom "scanner-execution-failed"
fi
if docker run "${common[@]}" --network none \
  --name "$project-trivy-repository" \
  --volume "$source_tree:/source:ro" \
  --volume "$cache:/cache" \
  --volume "$scanner_outputs:/outputs" \
  "$trivy_image" fs --cache-dir /cache --scanners vuln,secret,misconfig \
  --skip-db-update --skip-java-db-update --skip-check-update \
  --skip-version-check --skip-vex-repo-update --offline-scan \
  --severity HIGH,CRITICAL --ignore-unfixed=false --exit-code 0 --format json \
  --output /outputs/repository-report.json /source \
  >"$evidence/trivy-repository.txt" 2>&1; then
  analyze_report repository "$scanner_outputs/repository-report.json" \
    "$evidence/repository-findings.json"
else
  record_scan_error repository "scanner-execution-failed"
fi
rm -f -- "$scanner_outputs/repository.cdx.json" "$scanner_outputs/repository-report.json"

declare -A canonical_image_service=()
while IFS='|' read -r service image_id image_ref; do
  sbom_ready=0
  scan_ready=0
  archive_image_id=
  [[ "$service" =~ ^[a-z][a-z0-9-]*$ && "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    acceptance_die "the immutable image manifest is invalid"
  printf 'service=%s image_id=%s image_ref=%s\n' "$service" "$image_id" "$image_ref" \
    >>"$evidence/scanned-images.txt"
  if [[ -n ${canonical_image_service[$image_id]+present} ]]; then
    canonical_service=${canonical_image_service[$image_id]}
    {
      printf 'service=%s image_id=%s canonical_service=%s\n' \
        "$service" "$image_id" "$canonical_service"
      if [[ -s "$evidence/$canonical_service.cdx.json" ]]; then
        sha256sum "$evidence/$canonical_service.cdx.json"
      fi
      if [[ -s "$evidence/$canonical_service-findings.json" ]]; then
        sha256sum "$evidence/$canonical_service-findings.json"
      fi
    } >"$evidence/$service-scan-reference.txt"
    printf 'scope=%s-image status=REUSED canonical_scope=%s-image\n' \
      "$service" "$canonical_service" >>"$evidence/security-scan-status.txt"
    continue
  fi
  archive=$image_archives/$service-image.tar
  [[ ! -e "$archive" ]] || acceptance_die "refusing to reuse an image archive"
  if ! docker image save --output "$archive" "$image_id"; then
    record_scan_error "${service}-image" "image-archive-failed"
    rm -f -- "$archive"
    archive=
    continue
  fi
  chmod 600 "$archive"
  if ! archive_image_id=$(archive_image_identity "$archive"); then
    record_scan_error "${service}-image" "invalid-image-archive-identity"
    rm -f -- "$archive"
    archive=
    continue
  fi
  printf 'manifest_image_id=%s archive_config_id=%s\n' "$image_id" "$archive_image_id" \
    >"$evidence/$service-image-identity.txt"
  if docker run "${common[@]}" --network none \
    --name "$project-syft-$service" \
    --volume "$archive:/image.tar:ro" \
    --volume "$scanner_outputs:/outputs" \
    "$syft_image" "docker-archive:/image.tar" \
      -o "cyclonedx-json=/outputs/$service.cdx.json" \
    >"$evidence/syft-$service.txt" 2>&1; then
    if validate_sbom "$scanner_outputs/$service.cdx.json"; then
      normalize_sbom "$scanner_outputs/$service.cdx.json" "$evidence/$service.cdx.json"
      sbom_ready=1
      printf 'scope=%s-sbom status=PASS\n' "$service" >>"$evidence/security-scan-status.txt"
    else
      record_scan_error "${service}-sbom" "invalid-cyclonedx"
    fi
  else
    record_scan_error "${service}-sbom" "scanner-execution-failed"
  fi
  if docker run "${common[@]}" --network none \
    --name "$project-trivy-$service" \
    --volume "$archive:/image.tar:ro" \
    --volume "$cache:/cache" \
    --volume "$scanner_outputs:/outputs" \
    "$trivy_image" image --cache-dir /cache --input "/image.tar" \
    --skip-db-update --skip-java-db-update --skip-check-update \
    --skip-version-check --skip-vex-repo-update --offline-scan \
    --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed=false --exit-code 0 --format json \
    --output "/outputs/$service-report.json" \
    >"$evidence/trivy-$service.txt" 2>&1; then
    set +e
    node "$script_directory/analyze-trivy-report.mjs" "${service}-image" \
      "$scanner_outputs/$service-report.json" "$evidence/$service-findings.json" \
      "$archive_image_id"
    ANALYZE_REPORT_STATUS=$?
    set -e
    case "$ANALYZE_REPORT_STATUS" in
      0) printf 'scope=%s status=PASS\n' "${service}-image" >>"$evidence/security-scan-status.txt" ;;
      1)
        finding_scopes=$((finding_scopes + 1))
        printf 'scope=%s status=FAIL reason=findings\n' "${service}-image" \
          >>"$evidence/security-scan-status.txt"
        ;;
      *) record_scan_error "${service}-image" "identity-mismatch-or-unreadable-report" ;;
    esac
    if [[ "$ANALYZE_REPORT_STATUS" -eq 0 || "$ANALYZE_REPORT_STATUS" -eq 1 ]]; then
      scan_ready=1
    fi
  else
    record_scan_error "${service}-image" "scanner-execution-failed"
  fi
  if [[ -s "$evidence/$service.cdx.json" && -s "$evidence/$service-findings.json" ]]; then {
    printf 'service=%s image_id=%s archive_config_id=%s image_ref=%s\n' \
      "$service" "$image_id" "$archive_image_id" "$image_ref"
    sha256sum "$evidence/$service-image-identity.txt" \
      "$evidence/$service.cdx.json" "$evidence/$service-findings.json"
  } >"$evidence/$service-scan-binding.txt"; fi
  if [[ "$sbom_ready" -eq 1 && "$scan_ready" -eq 1 ]]; then
    canonical_image_service[$image_id]=$service
  fi
  rm -f -- "$archive"
  rm -f -- "$scanner_outputs/$service.cdx.json" "$scanner_outputs/$service-report.json"
  archive=
done <"$manifest"

find "$evidence" -type f -exec chmod 600 {} +
{
  printf 'scan_errors=%s\nfinding_scopes=%s\n' "$scan_errors" "$finding_scopes"
  if [[ "$scan_errors" -eq 0 && "$finding_scopes" -eq 0 ]]; then
    printf 'status=PASS\n'
  else
    printf 'status=FAIL\n'
  fi
} >"$evidence/security-summary.txt"
if [[ "$scan_errors" -ne 0 || "$finding_scopes" -ne 0 ]]; then
  printf 'FAIL security scans completed with %s infrastructure errors and %s finding scopes\n' \
    "$scan_errors" "$finding_scopes" >&2
  exit 1
fi
printf 'PASS repository and immutable runtime images have CycloneDX SBOMs and no High/Critical findings\n'
