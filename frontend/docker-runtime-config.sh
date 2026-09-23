#!/bin/sh
# Write the frontend's runtime configuration from the container environment.
#
# nginx serves a static bundle, so anything baked in at build time is fixed for
# the life of the image. This runs before nginx starts (the official entrypoint
# executes /docker-entrypoint.d/*.sh in order) and regenerates runtime-config.js,
# which index.html loads ahead of the app bundle.
#
# The effect is that one image runs in any environment: point API_BASE at
# whichever host serves the API and redeploy, no rebuild.
set -eu

TARGET=/usr/share/nginx/html/runtime-config.js

# Unset is legitimate — it means the API is proxied under the same origin, which
# runtimeConfig.ts treats as "not configured" and falls through to its own
# defaults. Emit the file either way so the <script> tag never 404s.
cat > "$TARGET" <<JS
globalThis.__CASHFLOW_CONFIG__ = { API_BASE: '${API_BASE:-}' };
JS

echo "[runtime-config] API_BASE=${API_BASE:-<same-origin>}"
