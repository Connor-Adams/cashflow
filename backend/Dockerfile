# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY package.json yarn.lock .yarnrc.yml ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

RUN yarn install --immutable

COPY backend/ ./backend/
COPY shared/ ./shared/

RUN yarn workspace cashflow-backend build

FROM node:22-slim AS runner
WORKDIR /app

RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/package.json ./
COPY --from=builder /app/yarn.lock ./
COPY --from=builder /app/.yarnrc.yml ./

WORKDIR /app/backend

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production

EXPOSE 3001

CMD ["sh", "-c", "yarn run db:migrate && exec node dist/server.js"]
