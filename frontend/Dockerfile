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

COPY frontend/ ./frontend/
COPY shared/ ./shared/

ARG VITE_API_BASE
ENV VITE_API_BASE=$VITE_API_BASE

ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION

RUN yarn workspace frontend build

FROM nginx:alpine AS runner

ENV PORT=80

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
