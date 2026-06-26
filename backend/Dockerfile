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

FROM node:22-slim AS runner
WORKDIR /app

RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

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

# Drop root: the backend handles financial data + DB credentials, so it runs
# least-privilege. Issue #861.
USER node

CMD ["sh", "-c", "yarn run db:migrate && exec node dist/server.js"]
