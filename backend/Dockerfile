# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY package.json yarn.lock .yarnrc.yml ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

# node_auth_token authenticates @connor-adams/* (GitHub Packages). Mounted as a
# BuildKit secret so it never lands in an image layer; .yarnrc.yml reads it via
# ${NODE_AUTH_TOKEN:-}. CI passes it from secrets.GITHUB_TOKEN.
RUN --mount=type=secret,id=node_auth_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/node_auth_token)" yarn install --immutable

COPY backend/ ./backend/
COPY shared/ ./shared/

RUN yarn workspace cashflow-backend build

# --- Local embedding model (the free tier of the categorisation pipeline) ------
#
# `@huggingface/transformers` drags in `onnxruntime-node`, whose npm tarball
# carries the native runtime for darwin, linux AND win32 (~287 MB in total) in
# one package; only linux is reachable from this image. Discarding the other two
# saves ~218 MB with no behavioural risk — onnxruntime-node resolves its binding
# at bin/napi-v*/$platform/$arch, so a linux container can never look in the
# directories being discarded. `set -eu` plus the two existence checks make a
# future layout change fail the build loudly instead of silently no-opping and
# quietly re-inflating the image.
RUN set -eu; \
    bindir=node_modules/onnxruntime-node/bin; \
    test -d "$bindir"; \
    find "$bindir" -mindepth 2 -maxdepth 2 -type d ! -name linux -prune -exec rm -rf -- {} +; \
    test -n "$(find "$bindir" -mindepth 2 -maxdepth 2 -type d -name linux)"

# The model weights are NOT installed by the package manager: transformers.js
# fetches them from the Hugging Face hub on FIRST USE, into
# node_modules/@huggingface/transformers/.cache/. Left alone, the first import in
# a fresh container would reach the embedding stage, stall or fail on that
# download, emit nothing, and look exactly like an import with nothing to
# categorise — the silent-dead-stage failure this whole effort exists to remove.
#
# So warm the cache here: after the prune above (which makes this step double as
# proof that the pruned tree still loads the model) and before the runner stage
# copies /app/node_modules wholesale. The script drives the production
# `getDefaultEmbedder()` and exits non-zero unless it gets a real 384-dimension
# vector back, so a failed fetch fails the BUILD rather than shipping a stage
# that looks alive. Costs ~23 MB in the image (q8 weights + tokenizer) and a few
# seconds of build time, and requires build-time egress to huggingface.co.
RUN yarn workspace cashflow-backend run embedding:warm

FROM node:22-slim AS runner
WORKDIR /app

RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# gosu lets the entrypoint chown the root-owned Railway volume as root, then
# drop to `node` and exec the app as PID 1 (see docker-entrypoint.sh). Issue #861.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && gosu nobody true

# Copy the built app owned by the non-root `node` user (UID 1000, baked into the
# official node image). `yarn run db:migrate` and corepack need a writable HOME
# and project tree; chowning at COPY time avoids a separate recursive `chown`
# layer over node_modules.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/backend ./backend
COPY --from=builder --chown=node:node /app/shared ./shared
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/yarn.lock ./
COPY --from=builder --chown=node:node /app/.yarnrc.yml ./

WORKDIR /app/backend

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
# Corepack/yarn write their cache under $HOME; point it at the node user's home
# so the migrate step doesn't try to write to a root-owned /root.
ENV HOME=/home/node

EXPOSE 3001

# The COPY --chown lines above own the copied subdirs (node_modules, backend,
# shared) but NOT /app itself, which WORKDIR created as root. At startup
# `yarn run db:migrate` writes Yarn's install-state.gz to the project root's
# .yarn/ (= /app/.yarn), so the `node` user needs /app writable or the container
# crash-loops on `EACCES: mkdir '/app/.yarn'`. Issue #861 regressed this.
RUN chown node:node /app && chmod +x docker-entrypoint.sh

# No `USER node` here on purpose: the container must start as root to chown the
# root-owned Railway /data volume (else `EACCES: mkdir '/data/uploads/csv'`).
# docker-entrypoint.sh does that, then drops to `node` via gosu before exec'ing
# the CMD — so the financial/DB-creds app process still runs least-privilege
# (issue #861), it just isn't pinned via a static USER directive.
ENTRYPOINT ["/app/backend/docker-entrypoint.sh"]
CMD ["sh", "-c", "yarn run db:migrate && exec node dist/server.js"]
