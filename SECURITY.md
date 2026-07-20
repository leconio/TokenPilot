# Security Policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Submit a private report through
[GitHub Security Advisories](https://github.com/leconio/TokenPilot/security/advisories/new)
with a minimal reproduction, affected versions, impact, and any proposed mitigation. If that form is
unavailable, contact a repository owner through the private contact method on their GitHub profile
and ask for a secure reporting channel; do not include exploit details in the initial public-facing
message. Maintainers should acknowledge a report within five business days.

## Security boundaries

Model Provider credentials, prompts, and model responses remain in operator-owned LiteLLM and must
never enter the control plane. The control plane necessarily receives its own scoped API bearer
tokens and web session/CSRF cookies while authenticating requests; it processes them transiently,
redacts them from logs, errors, and audit payloads, and persists only one-way API-key and session
token hashes. Initial credentials and newly created service keys are displayed exactly once at
issuance and are never recoverable afterward. Deployment records may contain only non-secret
metadata and local `secret_ref` names.

Example credentials are for isolated local development only. Rotate any credential that may have been exposed and avoid including sensitive payloads in diagnostics.
