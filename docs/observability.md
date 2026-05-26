# Observability stack (Phase 2)

Cashflow runs a self-hosted observability stack on Railway:

- `otel-collector` — receives OTLP from the backend, forwards to Loki.
- `loki` — log storage, 30-day retention, 10GB filesystem volume.

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

Exercise the API a bit, then query Loki:

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

In the cashflow Railway project:

1. **Create the `loki` service.**
   - New Service → "Empty" → Connect repository → Root directory: `infra/loki/`.
   - Add a persistent volume, mount at `/loki`, size 10GB.
   - Set service domain / private networking name to `loki` (Railway internal).
   - Deploy.

2. **Create the `otel-collector` service.**
   - New Service → "Empty" → Connect repository → Root directory: `infra/otel-collector/`.
   - Env vars:
     - `LOKI_HOST=loki.railway.internal` (or whatever Railway shows for the loki service's internal hostname)
     - `PUBLIC_FRONTEND_ORIGIN=cashflow.<your-domain>` (frontend origin without protocol)
   - Expose port 4318 publicly (for browser OTLP later) AND internally (for the backend).
   - Deploy.

3. **Update `cashflow-backend` env vars.**
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.railway.internal:4318`
   - `GIT_SHA=${{RAILWAY_GIT_COMMIT_SHA}}`
   - Redeploy.

## Grafana Cloud datasource

1. Sign up for the Grafana Cloud free tier.
2. Add a Loki datasource pointing at the public Loki URL Railway gives you for the `loki` service (port 3100).
3. Put basic-auth in front of the public endpoint — Loki's `auth_enabled` flag in `infra/loki/config.yaml` is currently `false` for internal-only access. To expose publicly, either:
   - Flip `auth_enabled: true` and configure a tenant, or
   - Front Loki with a small auth proxy service on Railway.

## Verification

In Grafana Cloud Explore, switch to the Loki datasource and run:

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
