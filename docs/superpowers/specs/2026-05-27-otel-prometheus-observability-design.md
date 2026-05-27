# OTel + Prometheus observability design

## Driver

Cashflow already has self-hosted Loki and Tempo wired into Grafana, but API health still depends on log-derived queries and ad-hoc trace search. That is the wrong primitive for health dashboards and alerting. We need first-class metrics while keeping the telemetry model scalable enough to support Mimir later.

## Decision

Use OpenTelemetry as the application instrumentation API and keep Prometheus as the first owned metrics store on Railway.

The path is:

1. `cashflow-backend` records metrics through OTel SDK instruments.
2. The backend exports metrics to `otel-collector` over OTLP.
3. `otel-collector` exposes converted Prometheus metrics on an internal scrape endpoint.
4. A new Railway `prometheus` service scrapes the collector and stores time series on a Railway volume.
5. Grafana gets a Prometheus datasource pointing at the Railway-private Prometheus URL.

This keeps application code independent of Prometheus-specific client APIs while avoiding Mimir's operational weight until Cashflow needs horizontal metrics storage, multi-tenant isolation, or long retention beyond a single Railway volume.

## Non-goals

- Do not add Mimir in this slice.
- Do not replace Loki or Tempo.
- Do not expose Prometheus publicly without an auth boundary.
- Do not use raw request URLs as metric labels.
- Do not add frontend browser metrics in this slice.

## Architecture

```text
cashflow-backend
  OTLP logs/traces/metrics
        |
        v
otel-collector
  logs  -> Loki
  traces -> Tempo
  metrics -> Prometheus scrape endpoint (:9464/metrics)
        |
        v
Prometheus on Railway
  scrapes otel-collector.railway.internal:9464
  stores at /prometheus
        |
        v
Grafana
  Loki datasource
  Tempo datasource
  Prometheus datasource
```

## Backend Metrics

Add a focused backend metrics module that owns OTel meter setup and metric instruments.

Required instruments:

- `cashflow.http.server.requests`: counter
  - Attributes: `http.request.method`, `http.route`, `http.response.status_code`
- `cashflow.http.server.duration`: histogram in milliseconds or seconds
  - Attributes: `http.request.method`, `http.route`, `http.response.status_code`
- Runtime metrics through OTel host/process/runtime instrumentation where available without invasive setup.

Route labels must be bounded. Prefer Express route patterns like `/api/transactions/:id`; fall back to a small explicit normalizer only when Express cannot provide a route pattern. Never label with raw `req.originalUrl`.

## Collector

Extend `infra/otel-collector/config.yaml`:

- Add the Prometheus exporter on `0.0.0.0:9464`.
- Add a metrics pipeline: `otlp -> memory_limiter -> batch -> prometheus`.
- Keep logs flowing to Loki.
- Keep traces flowing to Tempo if the deployed collector already has that path; if local config is behind production, reconcile it rather than removing trace export.

The collector remains the telemetry hub. Backend services export OTLP to one endpoint; storage choices stay behind the collector.

## Prometheus

Add `infra/prometheus/`:

- `Dockerfile` based on the official Prometheus image.
- `prometheus.yml` scraping `otel-collector:9464` locally and `otel-collector.railway.internal:9464` in Railway via environment substitution or a Railway-specific config.
- Storage under `/prometheus`.
- Initial retention: `15d`.

The Railway service should mount a persistent volume at `/prometheus` and stay private-network only.

## Grafana

Add a Prometheus datasource pointing at:

```text
http://prometheus.railway.internal:9090
```

Then create a Cashflow API Health dashboard with:

- Request rate by route.
- 4xx/5xx rate by route.
- Latency p50/p95/p99 by route.
- Slowest routes.
- Highest-volume routes.
- Recent errors via Loki.
- Trace drilldown links via Tempo when trace IDs are present.

Prometheus panels diagnose health. Loki and Tempo panels drill into evidence.

## Scaling Path

Prometheus is the correct first owned store because Cashflow has one backend and modest metric volume. If retention, availability, or ingestion volume outgrow a single Prometheus service, keep the backend instrumentation unchanged and replace only the collector storage path:

```text
cashflow-backend -> otel-collector -> Mimir
```

At that point Prometheus can either become a scraper/agent or disappear in favor of collector remote write. The dashboard PromQL can largely survive because Mimir is Prometheus-compatible.

## Testing

Backend:

- Unit or integration test proves request metrics are recorded with bounded route labels.
- Test proves `/metrics` is not added to the app as a public unauthenticated endpoint; metrics flow through OTLP to the collector.
- Typecheck.

Infra:

- Docker Compose starts Loki, Tempo if present, collector, and Prometheus.
- Collector exposes Prometheus-format metrics at `:9464/metrics`.
- Prometheus target for collector is up.

Grafana:

- Prometheus datasource can query `up`.
- Dashboard panels return data after exercising backend routes.

## Operational Notes

- Existing kill switch `OTEL_SDK_DISABLED=true` should disable metric export too.
- Metrics export failure must not block API requests.
- Labels must avoid user IDs, household IDs, request IDs, raw paths, merchant names, or other high-cardinality/private values.
- Prometheus must be Railway-private unless an authenticated proxy is deliberately added later.
