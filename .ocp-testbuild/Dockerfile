# Test image: stremio-web built against a patched stremio-core-web.
#
# Stage 1 compiles the WASM bridge from the amasolov/stremio-core fork
# (branch board-pagination, based on the stremio-core-web-v0.59.0 tag that
# stremio-web v5.0.0-beta.38 pins). Stage 2 builds stremio-web normally but
# overlays the freshly built core-web package over the one pnpm installed
# from npm, so the app runs the patched serializer.
#
# This exists to validate the board-pagination change end to end before
# proposing it upstream. It is not part of the ArgoCD-managed deployment.

FROM docker.io/library/rust:1.95 AS core

RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-pack --locked --version 0.13.1

# Node is needed for the babel steps in core-web's build.sh.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
ARG CORE_REPO=https://github.com/amasolov/stremio-core.git
ARG CORE_REF=board-pagination
RUN git clone --depth 1 --branch "$CORE_REF" "$CORE_REPO" .

WORKDIR /src/stremio-core-web
# build.sh writes its outputs next to package.json, which is what stremio-web
# consumes as the package root.
RUN npm install --no-audit --no-fund && sh ./scripts/build.sh

FROM docker.io/library/node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && apk add --no-cache git
RUN mkdir -p /var/www/stremio-web
WORKDIR /var/www/stremio-web

FROM base AS app

ARG WEB_REF=v5.0.0-beta.38
RUN git clone --depth 1 --branch "$WEB_REF" \
    https://github.com/Stremio/stremio-web.git /var/www/stremio-web

RUN pnpm i --frozen-lockfile

# Overlay the patched core-web over the npm-installed copy. Only the build
# outputs are replaced; package.json stays as pnpm wrote it so the module
# entrypoints still resolve.
COPY --from=core /src/stremio-core-web/stremio_core_web.js \
     /src/stremio-core-web/stremio_core_web_bg.wasm \
     /src/stremio-core-web/bridge.js \
     /src/stremio-core-web/worker.js \
     /var/www/stremio-web/node_modules/@stremio/stremio-core-web/

RUN pnpm build

FROM base AS server
RUN pnpm i express@4

FROM base
COPY --from=app /var/www/stremio-web/http_server.js /var/www/stremio-web/
COPY --from=server /var/www/stremio-web/node_modules /var/www/stremio-web/node_modules
COPY --from=app /var/www/stremio-web/build /var/www/stremio-web/build
EXPOSE 8080
CMD ["node", "http_server.js"]
