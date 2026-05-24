# syntax=docker/dockerfile:1.7

FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable

COPY package.json yarn.lock ./
COPY backend/package.json ./backend/
COPY shared/package.json ./shared/
COPY frontend/package.json ./frontend/

RUN yarn install --frozen-lockfile

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
