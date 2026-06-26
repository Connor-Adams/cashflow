FROM grafana/tempo:2.6.0
# Stays root by design: Tempo writes its trace blocks + WAL to a Railway volume
# mounted at /var/tempo, and Railway mounts persistent volumes root-owned. The image's
# default tempo user (UID 10001) hits `permission denied` on that mount. Single-tenant,
# internal-only — root is the accepted trade-off here (see infra/loki/Dockerfile,
# PR #256, and issue #861's "where the volume mount allows" carve-out).
USER root
COPY config.yaml /etc/tempo.yaml
ENTRYPOINT ["/tempo"]
CMD ["-config.file=/etc/tempo.yaml"]
