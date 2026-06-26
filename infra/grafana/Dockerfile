FROM grafana/grafana:11.3.0
# Stays root by design: Grafana persists its SQLite DB to a Railway volume mounted
# at /var/lib/grafana, and Railway mounts persistent volumes root-owned. The image's
# default grafana user (UID 472) hits `permission denied` on that mount. Single-tenant,
# internal-only — root is the accepted trade-off here (see infra/loki/Dockerfile,
# PR #256, and issue #861's "where the volume mount allows" carve-out).
USER root
COPY grafana.ini /etc/grafana/grafana.ini
COPY provisioning /etc/grafana/provisioning
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD []
