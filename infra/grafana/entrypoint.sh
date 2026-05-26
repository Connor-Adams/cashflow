#!/bin/sh
set -eu

# On every boot, reset the admin password to match GF_SECURITY_ADMIN_PASSWORD.
# Grafana only seeds the password from env on first boot; without this hook,
# env-var changes have no effect because the SQLite DB owns the truth.
#
# Skipped if env var unset OR if the SQLite DB does not yet exist (first boot
# will create the admin user from the env var via Grafana's normal init path).
if [ -n "${GF_SECURITY_ADMIN_PASSWORD:-}" ] && [ -f /var/lib/grafana/grafana.db ]; then
  echo "[entrypoint] Resetting admin password from GF_SECURITY_ADMIN_PASSWORD"
  grafana cli --homepath /usr/share/grafana admin reset-admin-password "$GF_SECURITY_ADMIN_PASSWORD" || {
    echo "[entrypoint] reset-admin-password failed; continuing with existing password"
  }
fi

exec /run.sh "$@"
