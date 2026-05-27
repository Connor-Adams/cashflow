# Observability stack (Phase 3)

Cashflow runs a self-hosted observability stack on Railway:

- `otel-collector` — receives OTLP from the backend, forwards logs to Loki, traces to Tempo, and metrics to Prometheus.
- `loki` — log storage, 30-day retention, 10GB filesystem volume.
- `tempo` — trace storage, 7-day retention, local filesystem volume on Railway.
- `prometheus` — metrics storage, 15-day retention, local filesystem volume on Railway.
- `grafana` — self-hosted Grafana for querying Loki, Tempo, and Prometheus via private networking. Loki log lines auto-correlate to Tempo traces via `trace_id` derived field.

## Local development

The stack runs locally via `infra/docker-compose.yml`. From the repo root:

```bash
cd infra
docker compose up -d --build
# wait ~15s for Loki + collector to boot

# Verify Loki is ready
curl -sS http://localhost:3100/ready                                # -> "ready"

# Verify the collector OTLP endpoint accepts requests
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4318/v1/logs   # -> 415 (expected — no body)
```

Then run the backend dev server with OTLP pointed at the local collector:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 yarn workspace cashflow-backend run dev
```

Exercise the API a bit, then query Loki directly or open Grafana at http://localhost:3000 (admin/admin):

```bash
curl -sG http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="cashflow-backend"}' \
  --data-urlencode "start=$(($(date +%s) - 120))000000000" \
  --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode 'limit=20'
```

Prometheus metrics flow through the same OTLP endpoint:

1. Backend exports OTLP metrics to `otel-collector` at `http://localhost:4318/v1/metrics`.
2. The collector exposes Prometheus-format metrics at `http://localhost:9464/metrics`.
3. Prometheus scrapes the collector and serves PromQL at `http://localhost:9090`.

Verify locally:

```bash
curl -fsS http://localhost:9464/metrics | head
curl -fsS 'http://localhost:9090/api/v1/query?query=up'
```

Tear down:

```bash
cd infra && docker compose down -v
```

## Railway setup (one-time)

The backend and frontend deploy as GHCR images, not source builds. The observability services follow the same pattern — `build-images.yml` publishes images to GHCR on every merge to `main`; `promote-to-production.yml` retags `:sha-XXX` as `:production` on each GitHub release and triggers `railway redeploy`.

To onboard:

1. **Create the `loki` Railway service.**
   - New Service → "Deploy from Docker image".
   - Image: `ghcr.io/connor-adams/cashflow-loki:main` (initially) — bump to `:production` once a release has tagged it.
   - Add a persistent volume, mount at `/loki`, size 10GB.
   - Set service name to `loki` (Railway will expose it as `loki.railway.internal` in private networking).
   - Deploy.

2. **Create the `otel-collector` Railway service.**
   - New Service → "Deploy from Docker image".
   - Image: `ghcr.io/connor-adams/cashflow-otel-collector:main` (or `:production`).
   - Env vars:
     - `LOKI_HOST=loki.railway.internal`
     - `TEMPO_HOST=tempo.railway.internal`
     - `PUBLIC_FRONTEND_ORIGIN=cashflow.<your-domain>` (frontend origin without protocol)
   - Expose port 4318 publicly (for browser OTLP later) AND internally (for the backend).
   - Deploy.

3. **Create the `prometheus` Railway service.**
   - New Service → "Deploy from Docker image".
   - Image: `ghcr.io/connor-adams/cashflow-prometheus:main` (or `:production`).
   - Add a persistent volume, mount at `/prometheus`, size 10GB.
   - Keep the service private-network only.
   - Set service name to `prometheus` (Railway exposes it as `prometheus.railway.internal`).
   - After the service exists, set `RAILWAY_PROMETHEUS_SERVICE_ID` in `.github/workflows/promote-to-production.yml` so releases redeploy it automatically.

4. **Add the service IDs to `.github/workflows/promote-to-production.yml`** so future releases auto-redeploy them. Copy the IDs from the Railway dashboard URL of each service. Open a follow-up PR with the `env:` values filled in.

5. **Update `cashflow-backend` env vars.**
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.railway.internal:4318`
   - `GIT_SHA=${{RAILWAY_GIT_COMMIT_SHA}}`
   - Redeploy.

## Grafana service

The cashflow stack includes a self-hosted Grafana instance for querying Loki, Tempo, and Prometheus. Grafana runs as a Railway service at `ghcr.io/connor-adams/cashflow-grafana`. Datasources auto-provision on boot from `infra/grafana/provisioning/`.

### One-time Railway setup

1. Create the `grafana` service.
   - New Service → Deploy from Docker image → `ghcr.io/connor-adams/cashflow-grafana:main`
   - Add a persistent volume mounted at `/var/lib/grafana` (5GB).
   - Set env vars:
     - `GF_SECURITY_ADMIN_USER=admin`
     - `GF_SECURITY_ADMIN_PASSWORD=<strong-password>`
     - `PORT=3000`
   - Generate a public domain forwarding port 3000.
2. Add the service ID to `.github/workflows/promote-to-production.yml` (`RAILWAY_GRAFANA_SERVICE_ID`).

### Login

Open the Grafana public URL. Log in with the admin credentials. Navigate to Explore → Loki, query `{service_name="cashflow-backend"}`.

### Datasource access from Grafana

Loki, Tempo, and Prometheus stay on Railway private networking:

- `loki.railway.internal:3100`
- `tempo.railway.internal:3200`
- `prometheus.railway.internal:9090`

Grafana queries them via provisioned datasources. No public Loki, Tempo, or Prometheus URL is needed.

## Tempo service

Tempo receives traces from the otel-collector and makes them queryable in Grafana. It runs as a single-binary with local filesystem storage on a Railway volume.

### One-time Railway setup

1. **Create the `tempo` Railway service.**
   - New Service → "Deploy from Docker image".
   - Image: `ghcr.io/connor-adams/cashflow-tempo:main` (initially) — bump to `:production` once a release has tagged it.
   - Add a persistent volume, mount at `/var/tempo`, size 10GB.
   - Set service name to `tempo` (Railway exposes it as `tempo.railway.internal` in private networking).
   - Set env var: `PORT=3200`.
   - Deploy.

2. **Add `TEMPO_HOST` to the `otel-collector` service.**
   - Set env var: `TEMPO_HOST=tempo.railway.internal`
   - Redeploy the otel-collector.

3. **Add the service ID to `.github/workflows/promote-to-production.yml`** (`RAILWAY_TEMPO_SERVICE_ID`). Open a follow-up PR with the value filled in.

### Loki ↔ Tempo correlation in Grafana

The Grafana datasource provisioning (`infra/grafana/provisioning/datasources/datasources.yaml`) sets up automatic correlation:

- **Loki → Tempo**: a `derivedFields` rule on the Loki datasource matches `trace_id` in log JSON and renders a "View Trace" link. Clicking it opens the matching span waterfall in Tempo Explore.
- **Tempo → Loki**: the Tempo datasource's `tracesToLogsV2` config links back to Loki, filtering logs by trace ID and time window around the span.

To use: in Grafana Explore, select the Loki datasource and query for log lines. Any line containing `"trace_id":` shows a "View Trace" button. Click it to jump to the Tempo trace view.

## Verification

In Grafana Explore, switch to the Loki datasource and run:

```
{service_name="cashflow-backend"} |= "http_request"
```

You should see log lines from the deployed backend. Note: the Loki label is `service_name` (underscore), not `service.name` — the collector's loki exporter maps OTel resource attributes by normalizing dots to underscores.

In Grafana Explore, switch to the Prometheus datasource and run:

```
cashflow_http_server_requests_total
```

After the backend has served requests, you should see route-bounded request counters with labels such as `http_route`, `http_request_method`, and `http_response_status_code`.

## Kill switch

To stop OTLP export without redeploying app code:

- Set `OTEL_SDK_DISABLED=true` on the backend service.
- The pino logger detects this at boot and skips the OTLP target. Stdout output is unaffected.

## Schema

Each log record landing in Loki carries these fields (via the pino → OTLP transport):

- `body`: the pino `msg` string (the event name, e.g. `http_request`)
- `severity`: `info` / `warn` / `error` / `debug`
- `attributes`: every field passed to `logger.<level>({...}, msg)` plus the ALS-mixin fields (`requestId`, `userId`, `householdId`, `role`, `route`, `jobName`, `tickId`)
- `resources.service.name`: `cashflow-backend`
- `resources.deployment.environment`: `development` / `production`
- `resources.service.version`: the `GIT_SHA` env var (or `dev` locally)

Every log carries `trace_id` and `span_id` automatically — the pino mixin reads them from the active OTel context set by the NodeSDK (Phase 3).
