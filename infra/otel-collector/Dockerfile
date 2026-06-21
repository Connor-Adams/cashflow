# infra/otel-collector/Dockerfile
FROM otel/opentelemetry-collector-contrib:0.110.0
COPY config.yaml /etc/otel-collector-config.yaml
# Prod-only Postgres overlay. NOT loaded by the default CMD (local has no PG);
# Railway's start command adds it via a second --config flag. See
# config.postgres.yaml and docs/observability.md.
COPY config.postgres.yaml /etc/otel-collector-pg-config.yaml
CMD ["--config=/etc/otel-collector-config.yaml"]
