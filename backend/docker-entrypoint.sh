#!/bin/sh
set -e

# Drop-privilege entrypoint for the backend container (issue #861, prod EACCES
# on /data/uploads/csv).
#
# Railway mounts the persistent volume (RAILWAY_VOLUME_MOUNT_PATH, default
# /data) owned by ROOT. The backend handles financial data + DB credentials, so
# it must run as the non-root `node` user — but a plain `USER node` then can't
# `mkdir` the CSV / receipt / export dirs under the root-owned mount and the
# server crashes on boot with `EACCES: mkdir '/data/uploads/csv'`.
#
# So the container starts as root ONLY long enough to chown the volume, then
# drops to `node` via gosu and execs the real command. The app process itself
# never runs as root. `exec gosu` (not `su`) keeps the app as PID 1 so SIGTERM
# still reaches it for graceful shutdown (commit 0daaf5fd).
if [ "$(id -u)" = "0" ]; then
  DATA_DIR="${RAILWAY_VOLUME_MOUNT_PATH:-/data}"
  if [ -d "$DATA_DIR" ]; then
    # Idempotent: a no-op once the volume is already node-owned. Recursive so a
    # volume seeded root-owned by an earlier (root) deploy is fully reclaimed.
    chown -R node:node "$DATA_DIR" 2>/dev/null || true
  fi
  exec gosu node "$0" "$@"
fi

exec "$@"
