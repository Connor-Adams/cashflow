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
   - **Do NOT assign a public domain to this service.** The OTLP receiver on
     4318 (HTTP) and 4317 (gRPC) is **unauthenticated** — it only has a CORS
     `allowed_origins` list, which browsers enforce but `curl` / any OTLP SDK /
     a compromised container ignores. A public 4318 lets anyone POST arbitrary
     telemetry: log/trace injection, Grafana→GitHub-issue alert poisoning, and
     Loki/Tempo/Prometheus storage-cost DoS. Keep the collector on **private
     networking only** — the backend reaches it at
     `otel-collector.railway.internal:4318`, which needs no public port.
   - If browser OTLP is ever wanted, do **not** expose 4318 directly — proxy it
     through an **authenticated** backend endpoint (e.g. `/api/otlp`) that
     forwards to `otel-collector.railway.internal:4318` after the request passes
     the normal `requireAuth` boundary.
   - Keep 4317 (gRPC) internal-only as well.
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

## Postgres engine metrics (prod only)

Postgres exists **only in prod** — local dev runs on SQLite. So PG engine metrics
are a **prod-only overlay** on the collector, not part of the base config that
local `docker-compose` loads. The collector's `postgresql` receiver
(`infra/otel-collector/config.postgres.yaml`) scrapes `pg_stat_*` / `pg_settings`
and emits the metrics through the **existing** prometheus exporter on `:9464`,
which the `cashflow-otel-collector` Prometheus job already scrapes — so there is
**no new scrape job**. (App-side query spans already reach Tempo via the backend's
Sequelize auto-instrumentation; this adds the engine-health layer.) No extension
is needed — `pg_stat_statements` is only for query-digest analytics, which this
does not collect.

Dashboard: **Cashflow Postgres Engine** (`cashflow-postgres-engine`), auto-provisioned.

One-time Railway setup (on the existing `otel-collector` service):

1. **Create a read-only monitoring role** on the Railway Postgres. `pg_monitor`
   unlocks the optional metrics (deadlocks, locks); core metrics work without it.
   ```sql
   CREATE ROLE cashflow_metrics LOGIN PASSWORD '<strong-password>';
   GRANT pg_monitor TO cashflow_metrics;
   ```
2. **Add env vars** to the `otel-collector` service:
   - `PG_METRICS_ENDPOINT=postgres.railway.internal:5432` (the PG service's private host:port)
   - `PG_METRICS_USERNAME=cashflow_metrics`
   - `PG_METRICS_PASSWORD=<strong-password>`
   - `PG_METRICS_DATABASE=<db name>` (usually `railway`)
3. **Set the service's Custom Start Command** so the collector loads the overlay
   on top of the base config (a single image, two `--config` flags):
   ```
   --config=/etc/otel-collector-config.yaml --config=/etc/otel-collector-pg-config.yaml
   ```
   Without this flag the overlay is dormant — the base CMD loads only the first
   config. This is exactly why local stays quiet: it never gets the second flag.
4. Redeploy. Verify in Grafana → Explore → Prometheus: `postgresql_backends`
   should return a series within ~30s.

## Grafana service

The cashflow stack includes a self-hosted Grafana instance for querying Loki, Tempo, and Prometheus. Grafana runs as a Railway service at `ghcr.io/connor-adams/cashflow-grafana`. Datasources auto-provision on boot from `infra/grafana/provisioning/`.

### One-time Railway setup

1. Create the `grafana` service.
   - New Service → Deploy from Docker image → `ghcr.io/connor-adams/cashflow-grafana:main`
   - Add a persistent volume mounted at `/var/lib/grafana` (5GB).
   - Set env vars:
     - `GF_SECURITY_ADMIN_USER=admin`
     - `GF_SECURITY_ADMIN_PASSWORD=<strong-password>` — **required**. The
       container's entrypoint refuses to boot if this is unset/empty (issue
       #860); there is deliberately no default fallback, so a misconfigured
       service fails loudly instead of coming up with a known credential.
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
   - Add a persistent volume, mount at `/var/tempo`, size 10GB. **The mount path MUST be `/var/tempo`** — using the bare `/tempo` path would shadow the `grafana/tempo` binary and fail-start the container. The storage paths in `infra/tempo/config.yaml` (`storage.trace.wal.path` and `storage.trace.local.path`) are hard-pinned under `/var/tempo`; the regression-guard test `backend/test/tempoConfig.test.ts` asserts this in CI.
   - Set service name to `tempo` (Railway exposes it as `tempo.railway.internal` in private networking).
   - Set env var: `PORT=3200`.
   - Deploy.

2. **Add `TEMPO_HOST` to the `otel-collector` service.**
   - Set env var: `TEMPO_HOST=tempo.railway.internal`
   - Redeploy the otel-collector.

3. **Add the service ID to `.github/workflows/promote-to-production.yml`** (`RAILWAY_TEMPO_SERVICE_ID`). Open a follow-up PR with the value filled in.

### Verifying the volume mount

After deploying — or any time you suspect the mount has drifted — verify the tempo service is writing to the persistent volume rather than to the container's ephemeral overlay filesystem.

1. **Confirm volume exists and is attached.** From a checkout linked to the Railway project:

   ```bash
   railway volume list
   # Expect a `tempo-volume` row with `Attached to: tempo` and `Mount path: /var/tempo`.
   ```

   Or via GraphQL (no need for `RAILWAY_TOKEN` env var if the CLI is logged in — token lives in `~/.railway/config.json`):

   ```bash
   TOKEN=$(jq -r .user.token ~/.railway/config.json)
   PROJECT_ID=a5293fbb-c995-4c87-b3c7-4fb03a701156
   curl -sS https://backboard.railway.com/graphql/v2 \
     -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
     -d "{\"query\":\"query{project(id:\\\"${PROJECT_ID}\\\"){volumes{edges{node{name volumeInstances{edges{node{mountPath state serviceId}}}}}}}}\"}" \
     | jq '.data.project.volumes.edges[] | select(.node.name == "tempo-volume")'
   ```

2. **Confirm the live container has `/var/tempo` mounted as a separate filesystem.**

   ```bash
   railway ssh -s tempo "mount | grep /var/tempo"
   # Expect a line like: /dev/zd1968 on /var/tempo type ext4 (rw,relatime,...)
   ```

   If the only mount is the overlay `/` filesystem, the volume is not attached and traces will be lost on every restart.

3. **Confirm tempo is writing blocks to the mounted path.**

   ```bash
   railway ssh -s tempo "sh -c 'ls /var/tempo/wal; ls /var/tempo/traces; du -sh /var/tempo/*'"
   ```

   Healthy output shows a WAL block directory like `<uuid>+single-tenant+vParquet4`, a `traces/single-tenant/<uuid>/` tree once blocks have been flushed, and `tempo_cluster_seed.json` in `traces/`.

4. **Confirm trace durability across a deploy.** Note the current WAL block UUID, force a redeploy (`railway redeploy --service tempo -y`), and re-list — the prior WAL block should now appear under `/var/tempo/traces/single-tenant/<uuid>/` with `data.parquet`, `bloom-0`, `index`, `meta.json` files, proving it survived the container swap. A new WAL block starts for fresh ingestion.

### Creating a missing tempo volume

If `railway volume list` does not show `tempo-volume` at all (e.g. it was deleted, or the service was created without a volume), create it via the Railway GraphQL API rather than the dashboard so the mount path is set atomically with creation:

```bash
TOKEN=$(jq -r .user.token ~/.railway/config.json)
PROJECT_ID=a5293fbb-c995-4c87-b3c7-4fb03a701156
ENV_ID=a72f97a7-7fde-459f-87e7-57ac9255617c           # production
TEMPO_SERVICE_ID=977ae051-e712-4194-a564-f821346ad098

curl -sS https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "$(jq -nc --arg pid "$PROJECT_ID" --arg eid "$ENV_ID" --arg sid "$TEMPO_SERVICE_ID" \
        '{query: "mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id name } }",
          variables: {input: {projectId: $pid, environmentId: $eid, serviceId: $sid, mountPath: "/var/tempo"}}}')"
```

Railway automatically triggers a redeploy of the targeted service when a volume is attached. After the new deployment reports `SUCCESS`, run the verification steps above.

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

## Service reliability

The observability services (`tempo`, `loki`, `prometheus`) must auto-recover
from a clean shutdown. The 2026-05-29 incident exposed why: the tempo Railway
service received a clean SIGTERM (exit 0) and stayed stopped for ~15 hours
because the service was configured with `restartPolicyType: ON_FAILURE`,
which does not restart on a clean exit. The otel-collector silently retried
forever, so the only user-visible signal was "no new traces in Grafana."

### Decision: `restartPolicyType: ALWAYS` for tempo, loki, prometheus

For each of the `tempo`, `loki`, and `prometheus` Railway services, set:

```
restartPolicyType: ALWAYS
```

in the Railway dashboard → service → Settings → Deploy. This is set per
service in Railway and is **not** captured in this repo (Railway has no IaC
file for restart policy). The decision is documented here so a future reader
knows the intent.

Why ALWAYS over a watchdog (cron job, external monitor, custom probe):

- **Smaller blast radius**: no new service to deploy, monitor, or maintain.
  A watchdog has its own failure modes (the watchdog crashes; who watches it?).
- **Faster recovery**: Railway restarts the container immediately; an external
  watchdog cycles on a poll interval (minimum minutes).
- **`railway down` still works**: Railway honors explicit `down` commands
  separately from the restart policy, so an operator can still take a service
  offline intentionally for maintenance.

These services are stateless w.r.t. their bound volumes (they use local-disk
storage and are safe to restart at any time) and have no graceful-shutdown
ordering requirement that an ALWAYS policy would violate.

### Defense in depth: Grafana alerts on collector self-metrics

`ALWAYS` covers the crash case but not the "container running, pipeline
unhealthy" case (e.g. tempo accepts the TCP connection but rejects writes due
to a corrupt block or full disk). For that, Grafana provisions a set of
alert rules from [`infra/grafana/provisioning/alerting/observability-stack.yaml`](https://github.com/Connor-Adams/cashflow/blob/main/infra/grafana/provisioning/alerting/observability-stack.yaml).
Each rule's `runbook_url` annotation points at the matching subsection below
so the on-call engineer lands on the exact remediation, not this page's top.

These rules read the otel-collector's own self-telemetry metrics, which
require two supporting changes already in this repo:

1. [`infra/otel-collector/config.yaml`](https://github.com/Connor-Adams/cashflow/blob/main/infra/otel-collector/config.yaml) binds `service.telemetry.metrics.address`
   to `0.0.0.0:8888` (default is loopback-only).
2. [`infra/prometheus/prometheus.yml`](https://github.com/Connor-Adams/cashflow/blob/main/infra/prometheus/prometheus.yml) adds a `cashflow-otel-collector-self`
   scrape job pointed at `otel-collector.railway.internal:8888`.

The 5-minute rate window plus `for: 1m` keeps the worst-case alert latency
under 6 minutes, satisfying the issue #371 SLO of "surface tempo downtime
within 5 minutes."

#### TempoExportFailing

**Rule:** [`cashflow-tempo-export-failing`](https://github.com/Connor-Adams/cashflow/blob/main/infra/grafana/provisioning/alerting/observability-stack.yaml#L29) — fires when
`rate(otelcol_exporter_send_failed_spans_total{exporter="otlphttp/tempo"}[5m]) > 0`
for ≥1m.

**What it means:** the otel-collector is connecting to `tempo.railway.internal:4318`
but tempo is refusing or failing the write. Possible causes: tempo container
hung, disk full, mounted volume detached, ingester WAL corrupt.

**Remediation:**
1. `railway logs -s tempo -n 100` — look for `error` lines around the start of the alert window.
2. `railway ssh -s tempo "df -h /var/tempo"` — if `/var/tempo` is missing or full, that's the cause; see [Creating a missing tempo volume](#creating-a-missing-tempo-volume).
3. If logs show graceful shutdown / `Tempo stopped`, the restart policy did not catch a clean exit — confirm `restartPolicyType: ALWAYS` is set on the service.
4. Fast unstick: `railway redeploy --service tempo --yes`.
5. Verify recovery via [Verifying the volume mount](#verifying-the-volume-mount) step 3, then watch `otelcol_exporter_send_failed_spans_total` return to 0.

#### LokiExportFailing

**Rule:** [`cashflow-loki-export-failing`](https://github.com/Connor-Adams/cashflow/blob/main/infra/grafana/provisioning/alerting/observability-stack.yaml#L87) — fires when
`rate(otelcol_exporter_send_failed_log_records_total{exporter="loki"}[5m]) > 0`
for ≥1m.

**What it means:** the otel-collector cannot push log records to
`loki.railway.internal:3100/loki/api/v1/push`. Loki is most likely down,
out of disk, or the loki ingester is rejecting writes for label cardinality.

**Remediation:**
1. `railway logs -s loki -n 100` — `error` lines, especially `level=error msg="error processing requests"` or `permission denied` (Loki has historic UID-vs-volume-perm issues).
2. `railway ssh -s loki "df -h /loki"` — out of disk → bump the volume; rejection by ingester → check for runaway label cardinality.
3. If logs are silent and the container is just stopped, `railway redeploy --service loki --yes`.
4. Confirm recovery: `otelcol_exporter_send_failed_log_records_total{exporter="loki"}` flattens, and `{service_name="cashflow-backend"}` queries in Grafana Explore return fresh lines.

#### OtelCollectorScrapeDown

**Rule:** [`cashflow-otel-collector-scrape-down`](https://github.com/Connor-Adams/cashflow/blob/main/infra/grafana/provisioning/alerting/observability-stack.yaml#L144) — fires when
`up{job="cashflow-otel-collector"} == 0` for ≥5m.

**What it means:** Prometheus cannot scrape the otel-collector at
`otel-collector.railway.internal:9464`. Without this scrape, the
TempoExportFailing and LokiExportFailing rules have no data — this alert is
the last line of defense for the whole pipeline.

**Remediation:**
1. `railway logs -s otel-collector -n 100` — confirm the collector is running and serving metrics.
2. `railway logs -s prometheus -n 100` — look for `scrape failed` / DNS errors on the cashflow-otel-collector job; possible Railway private-network drop.
3. If both services are up but Prometheus still can't scrape, hit
   `http://prometheus.railway.internal:9090/api/v1/targets` from a sibling service (e.g.
   `railway run --service grafana curl ...`) — check `lastError` for the scrape target.
4. If the collector is the problem, `railway redeploy --service otel-collector --yes`. If
   Prometheus is the problem, `railway redeploy --service prometheus --yes`.
5. Recovery: `up{job="cashflow-otel-collector"}` returns to `1`; TempoExportFailing/LokiExportFailing become evaluable again.


#### BackendDown

**Rule:** `cashflow-backend-down` — fires when `absent(cashflow_up)` for ≥2m.

**What it means:** The cashflow backend is not reporting its heartbeat gauge
to Prometheus. The process is likely down or failing to push metrics through
the otel-collector.

**Note:** If OtelCollectorScrapeDown is also firing, the collector pipeline
is the root cause, not necessarily the backend.

**Remediation:**
1. `railway logs -s cashflow-backend -n 100` — check for crash loops or OOM kills.
2. If the backend is running but metrics are absent, verify the otel-collector is healthy (check OtelCollectorScrapeDown).
3. `railway redeploy --service cashflow-backend --yes` if the process is stuck.
4. Recovery: `cashflow_up` gauge reappears in Prometheus.

**Why a heartbeat gauge (design rationale):** Prometheus scrapes only the
otel-collector (`up{job="cashflow-otel-collector"}`); the backend *pushes*
metrics through that collector, so there is no `up{job="cashflow-backend"}`
series to alert on. The backend could be dead while the collector stays alive
and nothing would fire. Two alternatives were considered and rejected:

- **(A) `absent(cashflow_http_server_requests_total)`** — cheap (reuses an
  existing counter) but false-positives during legitimate idle windows
  (overnight, low traffic): no requests means the series goes stale even
  though the backend is perfectly healthy. Rejected — a liveness signal must
  be independent of inbound traffic.
- **(C) blackbox_exporter probing `/api/health`** — the most faithful check
  because it actually exercises the HTTP request path end-to-end, but it adds
  a new service plus a dedicated Prometheus scrape job to operate. Noted as a
  future upgrade if synthetic HTTP probing becomes worthwhile; out of scope
  for the heartbeat.

The `cashflow.up` observable gauge (registered in
`backend/src/observability/metrics.ts`) reports `1` on every 15s export
interval regardless of traffic, so `absent(cashflow_up)` is true only when the
backend has actually stopped exporting — traffic-independent by construction.

#### HighHttp5xxRate

**Rule:** `cashflow-high-http-5xx-rate` — fires when the 5xx error rate
exceeds 2% of total requests over a 5-minute window, sustained for ≥5m.

**What it means:** More than 2% of HTTP requests are returning server errors.

**Remediation:**
1. Check backend logs for unhandled exceptions or database connectivity errors.
2. Open the **5xx Error Budget** stat on the API Health dashboard to see how far
   over the 2% budget you are, and the **Request Rate by Route and Status** panel
   for which endpoints are failing.
3. Check downstream dependencies (database, external APIs) for outages.
4. Recovery: 5xx rate drops below 2%.

#### HighRouteLatencyP99

**Rule:** `cashflow-high-route-latency-p99` — fires when the 99th-percentile
HTTP response time exceeds 1000ms for ≥5m.

**What it means:** Request latency is significantly degraded. The p99 baseline
under normal load is ~150ms; the 1000ms threshold gives 6x headroom and
catches sustained degradation without alerting on transient spikes.

**Remediation:**
1. Open the **Route Latency p99** panel on the API Health dashboard (the 1000ms
   alert threshold is drawn on it) to see which routes are over budget.
2. Look for slow database queries or missing indexes.
3. Check for external API timeouts or memory pressure causing GC pauses.
4. Recovery: p99 latency drops below 1000ms.

#### OutboundDependencyFailing

**Rule:** `cashflow-outbound-dependency-failing` — fires when an external
service returns 5xx errors for ≥5m, identified by `server_address` label.

**What it means:** A third-party dependency (Yahoo Finance API, Plaid, email
service, etc.) is returning server errors.

**Remediation:**
1. Check which `server_address` is affected in the alert labels.
2. Verify whether the provider has a known outage.
3. If transient, the alert will auto-resolve when the dependency recovers.

#### JobFailing

**Rule:** `cashflow-job-failing` — fires when
`increase(cashflow_job_runs_total{result="failure"}[15m]) > 0` for ≥5m.

**What it means:** One or more background jobs have failed at least once in
the last 15 minutes. Recurring failures indicate a persistent error; a single
failure may be transient.

**Remediation:**
1. Check the `job` label to identify which job failed.
2. Review backend logs filtered by job name for error details.
3. Recovery: job succeeds on next tick.
### Verification

Once `restartPolicyType: ALWAYS` is set on tempo, simulate the original
incident:

1. From the Railway dashboard, stop the tempo deployment (or run
   `railway down --service tempo`).
2. Watch the deployment list. Within ~30 seconds Railway should spawn a new
   deployment automatically.
3. If you instead want to test the alert path, leave tempo down for ~2
   minutes and confirm `TempoExportFailing` fires in Grafana → Alerting.

Repeat for `loki` and `prometheus`.

### Alert routing: every fire becomes a GitHub issue

A firing alert no longer just shows as "Firing" in the Grafana UI and ages out —
it becomes a durable, owner-assignable GitHub issue (cashflow issue #386). This
replaces the old comment-next-to-the-wiring pattern: the alert *is* the ticket.

The path:

1. Grafana provisions a webhook contact point and a notification policy from
   [`infra/grafana/provisioning/alerting/contactpoints.yaml`](https://github.com/Connor-Adams/cashflow/blob/main/infra/grafana/provisioning/alerting/contactpoints.yaml).
   The policy routes every alert in the `Cashflow` folder to the
   `github-issues` contact point.
2. That contact point POSTs a webhook to GitHub's `repository_dispatch` API
   (`event_type: grafana-alert`), with the Alertmanager-shaped alert group as
   the `client_payload`.
3. [`.github/workflows/grafana-alert-to-issue.yml`](https://github.com/Connor-Adams/cashflow/blob/main/.github/workflows/grafana-alert-to-issue.yml)
   listens for that dispatch and runs
   [`scripts/grafana-alert-to-issue.cjs`](https://github.com/Connor-Adams/cashflow/blob/main/scripts/grafana-alert-to-issue.cjs).

Issue lifecycle (keyed by an `alert:<rule-uid>` label, one open issue per rule):

| Alert state | Open issue exists? | Action |
| :--- | :--- | :--- |
| firing | no | **create** a `bug` + `incident` issue (`severity:*`, `component:*`, `alert:<uid>` labels; body carries summary, description, `runbook_url`, and the Grafana rule link) |
| firing | yes | **comment** on it (no duplicate) |
| resolved | yes | **close** it with a "resolved" comment |
| resolved | no | noop |

**Required secret:** the contact point authenticates the dispatch POST with a
fine-scoped PAT exposed to the Grafana service as the `GITHUB_DISPATCH_TOKEN`
env var (Grafana expands `$GITHUB_DISPATCH_TOKEN` in provisioning). The PAT
needs only `contents: read` + `repository_dispatch` write on this repo. It is
**not** committed — set it in the Grafana service environment. The workflow
itself uses the built-in `GITHUB_TOKEN` with `issues: write`.

To test the path end to end, fire a real alert (stop tempo per the
[Verification](#verification) steps above) and confirm a `[alert] … on tempo`
issue appears in the tracker, then bring tempo back and confirm the issue is
closed.

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
