# LiteLLM connector example

The Connector declares LiteLLM `>=1.80.0 <2.0.0` in its Python project, and the example remote
Compose profile defaults to a minimal non-root derivative of the upstream third-party `v1.92.0`
image. Pin `LITELLM_BASE_IMAGE` to a reviewed
registry digest in production; `LITELLM_IMAGE` names the derivative produced by the build.

[`config.example.yaml`](config.example.yaml) is key-free and demonstrates virtual-model routing,
control-plane route tags, `model_info.id` deployment identity, success/failure callbacks, and message
logging disabled by default.

1. Install `connectors/litellm` in the LiteLLM Proxy environment.
2. Copy `.env.example` outside version control and replace all placeholders. Keep the ingestion and
   policy keys distinct; the first uploads usage and heartbeat data, while the second reads and
   acknowledges Runtime Snapshots.
3. Mount a persistent directory at the configured `AI_CONTROL_SPOOL_PATH` parent.
4. Start LiteLLM with `litellm --config config.yaml`.

The optional Compose profile runs only on the authorized remote Linux host. Provider credentials and
the ingestion key comes from `deploy/litellm/.env`; Compose injects a separate application runtime
key as `AI_CONTROL_POLICY_API_KEY`:

```bash
LITELLM_ENV_FILE=./litellm/.env docker compose --env-file deploy/env/.env \
  -f deploy/docker-compose.yml --profile litellm up -d --build litellm
```

Provider credentials remain in the LiteLLM environment. They are never stored in or forwarded to
the control plane. The derivative bundles the Connector and callback shim, runs as Wolfi's
`nonroot` UID/GID `65532:65532`, and gives that account ownership only of the persistent Connector
spool. Its root filesystem remains read-only at runtime.
