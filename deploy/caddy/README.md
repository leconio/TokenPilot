# Caddy deployment

Caddy is the only service published by the production Compose stack. It routes the unversioned
Control Plane API, health, `/openapi`, and `/openapi-json` requests directly to the API; all other
paths go to the Web console.
Operational metrics remain private to the internal Prometheus network. The
container listens on unprivileged port `8080`, runs as UID/GID 1000 with every Linux capability
dropped, and exposes `/healthz` for the Compose health check.

The default listener is plain HTTP so it can run behind an existing TLS load balancer. It deliberately
omits HSTS, Cross-Origin-Opener-Policy, and `upgrade-insecure-requests`, because those headers require
HTTPS or are not useful on a plain HTTP LAN origin. Terminate TLS before production traffic reaches
the host; add the HTTPS-only headers at the TLS ingress.
To let Caddy manage public certificates directly, replace `CADDY_ADDRESS` with the HTTPS hostname,
remove `auto_https off`, expose 443, and persist the existing `caddy-data` volume.
