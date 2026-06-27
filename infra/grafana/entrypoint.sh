#!/bin/sh
set -eu

# Refuse to boot without an admin password. Grafana is exposed on a public
# domain (:3000); booting with an unset/empty GF_SECURITY_ADMIN_PASSWORD used
# to leave a publicly-known default credential live (issue #860). Fail loudly
# instead of falling back to a known literal.
if [ -z "${GF_SECURITY_ADMIN_PASSWORD:-}" ]; then
  echo "[entrypoint] FATAL: GF_SECURITY_ADMIN_PASSWORD is required but unset/empty." >&2
  echo "[entrypoint] Set a strong GF_SECURITY_ADMIN_PASSWORD on the service and redeploy." >&2
  exit 1
fi

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
