ARG POSTGRES_BASE_IMAGE=postgres:16.14-alpine3.24
ARG REDIS_BASE_IMAGE=redis:7.4.9-alpine3.21

FROM ${POSTGRES_BASE_IMAGE} AS postgres

USER root

# Compose starts this image directly as the official Alpine postgres account. The
# root-only gosu helper is therefore unreachable and removing it also removes its
# embedded, stale Go standard library from the production attack surface/SBOM.
RUN apk upgrade --no-cache \
    && test "$(id -u postgres)" = "70" \
    && test "$(id -g postgres)" = "70" \
    && rm -f /usr/local/bin/gosu \
    && ! command -v gosu

USER 70:70

FROM ${REDIS_BASE_IMAGE} AS redis

USER root

# The Redis entrypoint invokes gosu only when it starts as root. The fixed
# 999:1000 runtime identity takes the supported direct-user branch instead.
RUN apk upgrade --no-cache \
    && test "$(id -u redis)" = "999" \
    && test "$(id -g redis)" = "1000" \
    && rm -f /usr/local/bin/gosu \
    && ! command -v gosu

USER 999:1000
