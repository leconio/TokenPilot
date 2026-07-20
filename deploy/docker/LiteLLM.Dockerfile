ARG LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm:v1.92.0
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.11.28

FROM ${UV_IMAGE} AS uv-bin

FROM ${LITELLM_BASE_IMAGE}

ARG BUILD_DATE=unknown
ARG CONTROL_PLANE_VERSION=0.2.0
ARG VCS_REF=unknown

ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPYCACHEPREFIX=/tmp/pycache \
    PYTHONPATH=/opt/tokenpilot-connector \
    XDG_CACHE_HOME=/tmp/.cache

LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.description="Hardened LiteLLM runtime with the TokenPilot Connector" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/leconio/TokenPilot" \
      org.opencontainers.image.title="TokenPilot LiteLLM" \
      org.opencontainers.image.version="${CONTROL_PLANE_VERSION}"

USER root

COPY --from=uv-bin /uv /usr/local/bin/uv

# The upstream Wolfi image defines the nonroot account as UID/GID 65532, but its
# default image user is root.  Preparing the volume seed directory in the image
# lets a newly created named volume retain non-root ownership without a privileged
# init container or a root entrypoint.
RUN apk upgrade --no-cache || ( \
      for delay in 2 5 10; do \
        sleep "${delay}"; \
        apk upgrade --no-cache && exit 0; \
      done; \
      exit 1; \
    ) \
    && uv pip install --python /app/.venv/bin/python --no-cache --upgrade 'mcp==1.28.1' \
    && python -c 'from importlib.metadata import version; assert version("mcp") == "1.28.1"' \
    && rm -f /usr/local/bin/uv \
    && test "$(id -u nonroot)" = "65532" \
    && test "$(id -g nonroot)" = "65532" \
    && site_packages="$(python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')" \
    && rm -rf "${site_packages}/ddtrace" "${site_packages}"/ddtrace-*.dist-info \
    && python -c 'import importlib.util; assert importlib.util.find_spec("ddtrace") is None' \
    && python -c 'import litellm' \
    && mkdir -p /etc/litellm /opt/tokenpilot-connector /var/lib/tokenpilot \
    && chown -R 65532:65532 /var/lib/tokenpilot \
    && chmod 0755 /etc/litellm /opt/tokenpilot-connector \
    && chmod 0700 /var/lib/tokenpilot

COPY --chown=0:0 connectors/litellm/src/ /opt/tokenpilot-connector/
COPY --chown=0:0 deploy/litellm/ai_control_callback.py /etc/litellm/ai_control_callback.py

USER 65532:65532
