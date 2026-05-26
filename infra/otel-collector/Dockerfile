# infra/otel-collector/Dockerfile
FROM otel/opentelemetry-collector-contrib:0.110.0
COPY config.yaml /etc/otel-collector-config.yaml
CMD ["--config=/etc/otel-collector-config.yaml"]
