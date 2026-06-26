# infra/loki/Dockerfile
FROM grafana/loki:3.2.0
# Run as root so Loki can create its subdirectories on the Railway-mounted volume
# at /loki. The grafana/loki image defaults to UID 10001 which can't write to the
# root-owned mount. Single-tenant, internal-only — root is the accepted trade-off
# here (PR #256, and issue #861's "where the volume mount allows" carve-out).
USER root
COPY config.yaml /etc/loki/local-config.yaml
