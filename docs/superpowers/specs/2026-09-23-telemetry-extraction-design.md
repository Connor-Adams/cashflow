# Telemetry Extraction — cashflow/infra → standalone multi-tenant stack on Dokploy

**Date:** 2026-09-23
**Status:** Approved (design); not yet implemented
**Type:** Infrastructure extraction + host migration
**Spans:** `Connor-Adams/cashflow` (removal) and `Connor-Adams/telemetry` (new repo)

## Problem

The observability stack lives at `cashflow/infra/` — five services (loki, tempo,
otel-collector, prometheus, grafana) deployed on Railway. It serves exactly one
tenant today, but it is about to serve several: rainbot is getting instrumented,
and future deployments will report into the same place.

Two things are wrong with where it sits.

**Ownership inversion.** Shared infrastructure inside one tenant's repo means
rainbot dashboards arrive as cashflow pull requests, and cashflow's release
cadence (GHCR on merge → `:production` on Release) churns a stack that has
nothing to do with a cashflow release.

**Host lock-in, twice over.** Internal hostnames are hardcoded `*.railway.internal`
in `prometheus/prometheus.yml` scrape targets and
`grafana/provisioning/datasources/datasources.yaml` urls. Moving the stack
without fixing that swaps Railway lock-in for Dokploy lock-in — a lateral move.
Only `otel-collector/config.yaml` is already env-driven.

Both cashflow and the telemetry stack are moving to the Dokploy box
(`192.168.2.88` / `connor-host1`), into **separate Dokploy projects**. The
`Telemetry` project (`TPsbEl1w_3hII69qotADg`) exists and is empty.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo boundary | New repo `Connor-Adams/telemetry` | Ends the ownership inversion; shared infra gets its own release cadence and its own PR surface. |
| Deploy unit | **Five Dokploy Applications** from GHCR images | Exactly the shape rainbot proved on this box. Cross-project reach uses the already-working `appName` DNS path, with no Compose external-network question to resolve. |
| Local dev observability | **Dropped** | `infra/` was also the local stack. It goes away; local debugging is stdout. Telemetry becomes a deployed-environments-only concern. |
| Historical data | **Migrate all four stores** | 4.4 GB total against 199 GB free. Cheap enough that losing query continuity across the cutover date is not worth it. |
| Grafana volume | Copy as-is, no prune | Preserves the service-account token, alert state and annotation history. Measured at 14.6 MB — Railway's 2 GB figure was a high-water mark, so there was never a trade-off here. |
| Grafana hostname | `grafana.rainbot.win` | The tunnel and DNS are already proven on that zone. Revisit if a neutral zone appears. |

### Accepted cost of the Applications shape

Config lives baked into images, so changing a dashboard, a scrape target or an
alert rule is a rebuild → push → redeploy, not a redeploy. This is the same
friction Railway imposed. It is accepted deliberately in exchange for using the
one deployment shape already known to work on this box.

## Facts this design rests on

Measured 2026-09-23, not assumed.

**Pinned versions.** `grafana/grafana:11.3.0`, `grafana/loki:3.2.0`,
`otel/opentelemetry-collector-contrib:0.110.0`, `prom/prometheus:v2.55.1`,
`grafana/tempo:2.6.0`.

**All four stores are filesystem-backed**, so migration is a directory copy, not
a store conversion:

| Railway volume | Mount path | Reported | Actual (`du`) |
|---|---|---|---|
| prometheus-volume | `/prometheus` | 856 MB | **672.7 MB** |
| tempo-volume | `/var/tempo` | 889 MB | **597.1 MB** |
| loki-volume | `/loki` | 645 MB | **63.3 MB** |
| grafana-volume | `/var/lib/grafana` | 2005 MB | **14.6 MB** (`grafana.db` 1.6 MB) |
| | | 4.4 GB | **≈1.3 GB** |

`railway volume list` reports a high-water mark, not live usage — off by up to
10× (grafana). Sizes above were measured directly with `du` inside each running
container on 2026-09-23. The grafana volume being 14.6 MB rather than 2 GB is
why no prune is worth considering.

Loki is tsdb schema **v13** from `2026-01-01`, retention 720h, compactor
retention enabled. Tempo is local backend, `block_retention` 168h. Grafana's
SQLite `grafana.db` is the fourth store — it owns users, alert state,
annotations and the `GRAFANA_SA_TOKEN` held in
`~/.config/secrets/cashflow-grafana.env`; leaving it behind breaks the
`tempo-slow-requests` skill.

**Target host.** `connor-host1`, Debian 13, kernel 6.12. SSH as `root` with key
auth (`connoradams`, `dokploy`, `ubuntu` are all rejected). `/dev/sda2` 221 G
with 199 G free. Dokploy v0.30.7, one host-wide `dokploy-network` overlay shared
by every project, persistent volumes named `<appName>-data`.

## Constraints

**The collector's OTLP receivers are unauthenticated and must never be given a
Domain** (cashflow issue #858). `cors.allowed_origins` is browser-enforced only;
curl or any OTLP SDK ignores it. On Railway this was enforced by withholding a
public domain; on Dokploy the equivalent is attaching no Domain to the
collector Application. Emitters reach it over internal Swarm DNS by `appName`.

**Grafana's custom entrypoint is load-bearing** (cashflow issue #860). It
hard-fails boot when `GF_SECURITY_ADMIN_PASSWORD` is unset and re-runs
`grafana cli admin reset-admin-password` on every boot, because Grafana seeds
the admin password from env on first boot only and the SQLite DB owns the truth
thereafter. It survives the extraction unchanged.

**Datasource uids are `loki` / `tempo` / `prometheus`** and all eight dashboards
reference them. They are preserved verbatim.

**Versions are locked across the cutover.** The box runs byte-identical image
versions to Railway at migration time. Upgrading any component is a separate,
later change — never bundled with a data move.

## Architecture

### Repo layout

```
services/loki/            Dockerfile, config.yaml
services/tempo/           Dockerfile, config.yaml
services/prometheus/      Dockerfile, prometheus.yml.tmpl, entrypoint.sh
services/otel-collector/  Dockerfile, config.yaml
services/grafana/         Dockerfile, grafana.ini, entrypoint.sh, provisioning/
.github/workflows/images.yml
scripts/migrate-volume.sh
docs/
```

Images publish as `ghcr.io/connor-adams/telemetry-<svc>:main`, matching the
rainbot convention already running on the box.

Grafana provisioning keeps its existing three-part structure — `datasources/`,
`alerting/` (contactpoints + the `observability-stack` rules), and
`dashboards/`, with dashboards reorganised per tenant: cashflow's eight move
under `dashboards/cashflow/`, and `dashboards/<app>/` is where rainbot's land
later.

### Purging `railway.internal`

| File | Change |
|---|---|
| `grafana/provisioning/datasources/datasources.yaml` | urls → `$LOKI_URL`, `$TEMPO_URL`, `$PROM_URL`. Grafana expands `$VAR` in provisioning natively. |
| `prometheus/prometheus.yml` | Becomes `prometheus.yml.tmpl`; an entrypoint runs `envsubst` into `/etc/prometheus/prometheus.yml` at boot. Targets come from `$OTEL_COLLECTOR_HOST`. |
| `otel-collector/config.yaml` | Already uses `${env:LOKI_HOST}` / `${env:TEMPO_HOST}`. Unchanged. |

Prometheus needs the template step because, unlike Grafana, it does **not**
expand environment variables in its config file. Both existing scrape jobs are
preserved — `cashflow-otel-collector` (:9464, app metrics) and
`cashflow-otel-collector-self` (:8888, collector self-telemetry) — because the
`OtelCollectorScrapeDown`, `TempoExportFailing` and `LokiExportFailing` alert
rules have no data without them. Job names lose their `cashflow-` prefix, since
the collector is now shared. This is a low-risk rename: those names describe the
*collector*, not any application, and application identity travels separately
(see Multi-tenancy). The only reference to update is
`alerting/observability-stack.yaml:169`.

### Dokploy topology — Telemetry project

| Application | Persistent mount | Domain | Key env |
|---|---|---|---|
| loki | `/loki` | none | — |
| tempo | `/var/tempo` | none | — |
| prometheus | `/prometheus` | none | `OTEL_COLLECTOR_HOST` |
| otel-collector | none (stateless) | **none, permanently** | `LOKI_HOST`, `TEMPO_HOST`, `PUBLIC_FRONTEND_ORIGIN` |
| grafana | `/var/lib/grafana` | `grafana.rainbot.win` | `LOKI_URL`, `TEMPO_URL`, `PROM_URL`, `GF_SECURITY_ADMIN_PASSWORD` |

Every host value is a generated Dokploy `appName`, resolved over Swarm DNS —
never a friendly name. The concrete appNames are unknown until the Applications
are created, so env wiring is a post-create step.

Cashflow, in its own Dokploy project, reaches the collector across the project
boundary on the same host-wide `dokploy-network`. **Proven 2026-09-23, not
assumed:** `dokploy-network` is an `attachable=true` swarm overlay carrying every
project's containers at once — Infra's cloudflared, all of Rainbot's services,
traefik and dokploy itself. Resolving across the boundary works, verified with a
negative control:

| From | Resolve | Result |
|---|---|---|
| `rainbot-redis-8nav0c` (Rainbot) | `infra-cloudflared-v6kums` (Infra) | `10.0.1.133` |
| `rainbot-redis-8nav0c` (Rainbot) | `rainbot-raincloud-24kw6t` (Rainbot) | `10.0.1.8` |
| `rainbot-redis-8nav0c` (Rainbot) | `telemetry-does-not-exist-yet` | `rc=2` |

Dokploy projects are a UI grouping, not a network boundary. The tunnel-fronted
authenticated-ingress contingency is therefore dropped.

### Multi-tenancy

**One shared collector. Tenant identity already works and needs no new
mechanism.** Each emitter sets the OTel resource attribute `service.name`
(cashflow: `backend/src/observability/otlpDestination.ts:133` and
`logger.ts:73` → `cashflow-backend`), and it propagates to all three signals
without collector involvement:

| Signal | Label carrying tenant identity |
|---|---|
| Logs | Loki `service_name` (resource attrs normalise dots to underscores) |
| Traces | `service.name`, first-class in Tempo |
| Metrics | Prometheus `exported_job` |

Verified live against production Prometheus:
`cashflow_up{exported_job="cashflow-backend", instance="otel-collector.railway.internal:9464", job="cashflow-otel-collector"}`.

Note the two `job`-ish labels are unrelated. `job` names **the collector that
Prometheus scraped**; `exported_job` names **the application that emitted**.
Prometheus renames the emitter's `job` to `exported_job` because it collides
with the scrape job label. Renaming the scrape job therefore has no effect on
application identity.

A new tenant needs nothing built. Rainbot setting `service.name=rainbot-raincloud`
gets `exported_job="rainbot-raincloud"` and Loki `service_name="rainbot-raincloud"`
automatically.

**Improvement taken during the move:** set `honor_labels: true` on the scrape
config so the emitter's own `job` wins and the label reads `job="cashflow-backend"`
rather than the accidental `exported_job`. Safe here for two reasons —
`exported_job` appears zero times across all eight dashboards and the alert
rules, and `up{job="cashflow-otel-collector"}` is synthesised by Prometheus
rather than exposed by the target, so `honor_labels` cannot affect it and the
`OtelCollectorScrapeDown` alert keeps evaluating.

Multiple collectors would only be warranted for isolation, never for naming:
preventing a tenant from spoofing another's `service.name`, per-tenant
ingestion limits, or blast-radius separation. None apply yet.

Rainbot is winston-based with no OpenTelemetry dependency, so its eventual path
in is a Loki push, not OTLP. That work is out of scope here; this design only
commits to not blocking it.

## Migration

Four stores, ≈1.3 GB total. Streamed `tar` straight through the local machine —
Railway → Mac → box — with no R2 or other object-store staging, against 199 G of
headroom at the destination.

Per store, in order: stop the Railway writer → stream `tar` from the Railway
volume to the corresponding `<appName>-data` volume on the box → verify file
counts and sizes → start the box service.

**Egress mechanism — proven 2026-09-23.** `railway ssh --service <svc> '<cmd>'`
executes non-interactively against the running container, and each volume is
readable from inside it. Probed on loki:

```
$ railway ssh --service loki "sh -c 'ls /loki; du -sh /loki; which tar'"
chunks  compactor  index  index_cache  lost+found  rules  wal
63.3M   /loki
/busybox/tar
```

`tar` is present in the images (busybox), so each store streams out as
`railway ssh --service <svc> 'tar -C <path> -cf - .'` piped into
`ssh root@192.168.2.88 'tar -C <dest> -xf -'`. No R2 sidecar is needed; that
fallback is dropped from the plan.

Sequencing follows the lesson from the rainbot cutover, where workers were
deployed before their orchestrator was healthy, exhausted a finite retry budget,
and sat silently unregistered: **loki, tempo, prometheus first, then
otel-collector, then grafana, and emitters last.** A Swarm service with no
running task does not resolve, so `ENOTFOUND` during a cutover means the target
is not up — not that DNS is broken.

Railway's telemetry services are decommissioned only after the box stack is
verified end to end: Grafana reachable at `grafana.rainbot.win`, all three
datasources green, historical data queryable across the cutover date, and the
three observability-stack alert rules evaluating with data.

## Cashflow repo changes

Delete `infra/` entirely. Update `CLAUDE.md` (the Architecture section describes
`infra/` as the local observability stack) and `docs/observability.md`. Repoint
the backend's OTLP endpoint env at the telemetry collector's `appName`. The
alerting rules' source comments contain GitHub URLs into
`cashflow/infra/grafana/provisioning/...`; those move with the files and are
rewritten to the telemetry repo.

## Verification

- All five images build and push to GHCR.
- Prometheus boots with an `envsubst`-rendered config and both scrape jobs `up`.
- Grafana boots, all three datasources green, all eight dashboards render.
- Historical queries span the cutover date in all three stores.
- The preserved SA token still authenticates, i.e. `tempo-slow-requests` works.
- The three observability-stack alert rules evaluate with data, not `NoData`.
- The collector has no Domain attached, verified against the Dokploy API.
