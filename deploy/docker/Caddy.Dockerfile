ARG GO_IMAGE=golang:1.26.5-alpine3.24
ARG RUNTIME_IMAGE=alpine:3.24

FROM ${GO_IMAGE} AS build

ARG CADDY_VERSION=v2.11.4
ARG XCADDY_VERSION=v0.4.5
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG all_proxy
ARG no_proxy
ENV CGO_ENABLED=0 \
    GOSUMDB=sum.golang.org \
    GOTOOLCHAIN=local

RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates git \
    && mkdir -p /out \
    && proxy_http="${HTTP_PROXY:-${http_proxy:-}}" \
    && proxy_https="${HTTPS_PROXY:-${https_proxy:-}}" \
    && proxy_all="${ALL_PROXY:-${all_proxy:-}}" \
    && proxy_bypass="${NO_PROXY:-${no_proxy:-}}" \
    && HTTP_PROXY="${proxy_http}" \
       HTTPS_PROXY="${proxy_https}" \
       ALL_PROXY="${proxy_all}" \
       NO_PROXY="${proxy_bypass}" \
       http_proxy="${proxy_http}" \
       https_proxy="${proxy_https}" \
       all_proxy="${proxy_all}" \
       no_proxy="${proxy_bypass}" \
       GOBIN=/out go install \
         "github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}" \
    && HTTP_PROXY="${proxy_http}" \
       HTTPS_PROXY="${proxy_https}" \
       ALL_PROXY="${proxy_all}" \
       NO_PROXY="${proxy_bypass}" \
       http_proxy="${proxy_http}" \
       https_proxy="${proxy_https}" \
       all_proxy="${proxy_all}" \
       no_proxy="${proxy_bypass}" \
       /out/xcaddy build "${CADDY_VERSION}" --output /out/caddy \
    && embedded_version="$(go version -m /out/caddy | awk '($1 == "mod" || $1 == "dep") && $2 == "github.com/caddyserver/caddy/v2" { print $3 }')" \
    && test "${embedded_version}" = "${CADDY_VERSION}" \
    && reported_version="$(/out/caddy version | awk '{ print $1 }')" \
    && test "${reported_version}" = "${CADDY_VERSION}"

FROM ${RUNTIME_IMAGE} AS runtime

RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates tzdata \
    && mkdir -p /config/caddy /data/caddy /etc/caddy \
    && chown -R 1000:1000 /config /data

COPY --from=build /out/caddy /usr/bin/caddy
COPY deploy/caddy/Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    && chown -R 1000:1000 /data /config

ENV XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/data
USER 1000:1000
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
