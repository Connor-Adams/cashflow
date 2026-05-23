# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

RUN yarn install --frozen-lockfile

COPY backend/ ./backend/
COPY shared/ ./shared/

RUN yarn workspace cashflow-backend build

FROM node:22-slim AS runner
WORKDIR /app

RUN corepack enable

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/backend ./backend
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/package.json ./
COPY --from=builder /app/yarn.lock ./

WORKDIR /app/backend

ENV NODE_ENV=production

EXPOSE 3001

CMD ["sh", "-c", "yarn run db:migrate && exec node dist/server.js"]
