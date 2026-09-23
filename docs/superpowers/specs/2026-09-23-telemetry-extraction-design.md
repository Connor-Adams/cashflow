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
| Grafana volume | Copy as-is, no prune | Preserves the service-account token, alert state and annotation history. 2 GB is noise on this disk. |
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

| Railway volume | Mount path | Size |
|---|---|---|
| grafana-volume | `/var/lib/grafana` | 2005 MB |
| tempo-volume | `/var/tempo` | 889 MB |
| prometheus-volume | `/prometheus` | 856 MB |
| loki-volume | `/loki` | 645 MB |

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
the collector is now shared; the three alert rules are updated to match.

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
boundary on the same host-wide `dokploy-network`. Verify this cross-project
resolution with a live DNS check before repointing emitters; if it fails, the
collector is the single service that would need a tunnel-fronted authenticated
ingress instead, and that is a design change, not a config tweak.

### Multi-tenancy

One shared collector for all deployments. Tenants are separated by label, not by
instance: cashflow already emits `LOKI_SERVICE_NAME=cashflow-backend`. Dashboards
are foldered per tenant. Prometheus gains scrape targets per tenant as they
arrive.

Rainbot is winston-based with no OpenTelemetry dependency, so its eventual path
in is a Loki push, not OTLP. That work is out of scope here; this design only
commits to not blocking it.

## Migration

Four stores, ~4.4 GB total. Small enough to stream `tar` straight through the
local machine — Railway → Mac → box — with no R2 or other object-store staging,
and 199 G of headroom at the destination.

Per store, in order: stop the Railway writer → stream `tar` from the Railway
volume to the corresponding `<appName>-data` volume on the box → verify file
counts and sizes → start the box service.

**Unverified mechanism.** Getting bytes *out* of a Railway volume is the one
step not yet proven. `railway volume list` reads metadata only; extraction needs
either `railway ssh` into the service or a one-off command container with the
volume attached. Establish which works — on the smallest store, loki at 645 MB —
before committing to the full sequence. If neither works, the fallback is a
temporary sidecar service that pushes each volume to R2 (credentials already
present as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`), which the rainbot
migration proved as a Railway egress path.

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
