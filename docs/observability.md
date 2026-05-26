# Observability stack (Phase 2)

Cashflow runs a self-hosted observability stack on Railway:

- `otel-collector` — receives OTLP from the backend, forwards to Loki.
- `loki` — log storage, 30-day retention, 10GB filesystem volume.
- `grafana` — self-hosted Grafana for querying Loki (and future Tempo) via private networking.

Phase 3 will add a Tempo service for traces.

## Local development

The stack runs locally via `infra/docker-compose.yml`. From the repo root:

```bash
cd infra
docker compose up -d --build
# wait ~15s for Loki + collector to boot

# Verify Loki is ready
curl -sS http://localhost:3100/ready                                # → "ready"

# Verify the collector OTLP endpoint accepts requests
curl -sS -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4318/v1/logs   # → 415 (expected — no body)
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

Tear down:

```bash
cd infra && docker compose down -v
```

## Railway setup (one-time)

The backend and frontend deploy as GHCR images, not source builds. The new observability services follow the same pattern — `build-images.yml` publishes images to GHCR on every merge to `main`; `promote-to-production.yml` retags `:sha-XXX` as `:production` on each GitHub release and triggers `railway redeploy`.

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
     - `PUBLIC_FRONTEND_ORIGIN=cashflow.<your-domain>` (frontend origin without protocol)
   - Expose port 4318 publicly (for browser OTLP later) AND internally (for the backend).
   - Deploy.

3. **Add the service IDs to `.github/workflows/promote-to-production.yml`** so future releases auto-redeploy them. Copy the IDs from the Railway dashboard URL of each service. Open a follow-up PR with the `env:` values filled in.

4. **Update `cashflow-backend` env vars.**
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.railway.internal:4318`
   - `GIT_SHA=${{RAILWAY_GIT_COMMIT_SHA}}`
   - Redeploy.

## Grafana service

The cashflow stack includes a self-hosted Grafana instance for querying Loki (and future Tempo). Grafana runs as a Railway service at `ghcr.io/connor-adams/cashflow-grafana`. Datasources auto-provision on boot from `infra/grafana/provisioning/`.

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

### Loki access from Grafana

Loki stays on Railway private networking (`loki.railway.internal:3100`). Grafana queries it via its provisioned datasource. No public Loki URL needed. The `loki-production-b81e.up.railway.app` public domain on the loki service can now be removed.

## Verification

In Grafana Explore, switch to the Loki datasource and run:

```
{service_name="cashflow-backend"} |= "http_request"
```

You should see log lines from the deployed backend. Note: the Loki label is `service_name` (underscore), not `service.name` — the collector's loki exporter maps OTel resource attributes by normalizing dots to underscores.

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

When Phase 3 adds the trace SDK, every log will also carry `trace_id` and `span_id` automatically (the pino mixin already reads them from the active OTel context).
