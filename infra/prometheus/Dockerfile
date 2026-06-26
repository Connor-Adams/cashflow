FROM prom/prometheus:v2.55.1

COPY prometheus.yml /etc/prometheus/prometheus.yml

# Stays root by design: Prometheus writes its TSDB to a Railway volume mounted at
# /prometheus, and Railway mounts persistent volumes root-owned. The image's default
# nobody user (UID 65534) hits `permission denied` on that mount. Single-tenant,
# internal-only — root is the accepted trade-off here (see infra/loki/Dockerfile,
# PR #256, and issue #861's "where the volume mount allows" carve-out).
USER root

ENTRYPOINT ["/bin/prometheus"]
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=15d", "--web.listen-address=0.0.0.0:9090"]
