ARG NODE_IMAGE=node:24.18.0-alpine3.24

FROM ${NODE_IMAGE}

RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /opt/yarn-* \
    && rm -f /usr/local/bin/npm \
             /usr/local/bin/npx \
             /usr/local/bin/yarn \
             /usr/local/bin/yarnpkg \
             /usr/local/bin/corepack

COPY --chown=0:0 examples/fake-provider/server.mjs /app/server.mjs

USER 1000:1000
