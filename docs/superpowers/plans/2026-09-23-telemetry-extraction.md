# Telemetry Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the five-service observability stack out of `cashflow/infra/` into a standalone `Connor-Adams/telemetry` repo, running as five Dokploy Applications on `connor-host1`, with all four data stores migrated off Railway.

**Architecture:** Five independent Dokploy Applications (not a Compose stack), each built from its own Dockerfile into `ghcr.io/connor-adams/telemetry-<svc>:main` and wired to its peers by generated Dokploy `appName` over the host-wide `dokploy-network` swarm overlay. Hostnames currently hardcoded as `*.railway.internal` become environment variables so the stack is host-agnostic. Tenant identity needs no new mechanism — it already rides each emitter's `service.name` resource attribute.

**Tech Stack:** Docker, GitHub Actions, GHCR, Dokploy v0.30.7 REST API, Docker Swarm, Grafana 11.3.0, Loki 3.2.0, Tempo 2.6.0, Prometheus v2.55.1, OpenTelemetry Collector Contrib 0.110.0.

**Spec:** `docs/superpowers/specs/2026-09-23-telemetry-extraction-design.md`

## Global Constraints

- Image versions are **locked** across the migration: `grafana/grafana:11.3.0`, `grafana/loki:3.2.0`, `otel/opentelemetry-collector-contrib:0.110.0`, `prom/prometheus:v2.55.1`, `grafana/tempo:2.6.0`. No component is upgraded in this plan.
- The **otel-collector Application must never be given a Domain** (cashflow issue #858). Its OTLP receivers are unauthenticated; `cors.allowed_origins` is browser-enforced only.
- Grafana's custom `entrypoint.sh` is preserved unchanged (cashflow issue #860). It hard-fails boot without `GF_SECURITY_ADMIN_PASSWORD` and re-resets the password on every boot.
- Grafana datasource uids stay exactly `loki`, `tempo`, `prometheus`. All eight dashboards reference them by uid.
- Images publish as `ghcr.io/connor-adams/telemetry-<svc>:main`, matching the rainbot convention already on the box.
- Dokploy panel is `http://192.168.2.88:3000`, auth header `x-api-key`, key in `$dokploy_key` (sourced from `~/.config/secrets/gv.env`). Telemetry project id is `TPsbEl1w_3hII69qotADg`.
- Box SSH is `root@192.168.2.88` with key auth. No other user works.
- **Never use `docker run --rm` on the box** — the `--rm` flag trips a file-deletion guard. Use `docker exec` into existing containers, or `docker run` without `--rm` plus an explicit cleanup.
- Secrets are never passed as CLI arguments (they land in shell history) and never echoed.
- **There is no local Docker daemon on Connor's machine.** Every verification that needs to build or run a container happens in CI (GitHub Actions runners provide Docker) or on the box over SSH. No task may instruct anyone to run `docker` locally. This is why config validation and the Grafana boot probes live in the `validate` CI job rather than as one-off local commands — which also makes them a permanent regression gate instead of a step someone ran once.

---

### Task 1: Scaffold the telemetry repo with verbatim service copies

Copy the five services across unchanged first, so any later behavioural change is an isolated, reviewable diff rather than being tangled with the move.

**Files:**
- Create: `~/Developer/telemetry/` (new repo, new clone)
- Create: `~/Developer/telemetry/services/{loki,tempo,prometheus,otel-collector,grafana}/` (copied from `cashflow/infra/<svc>/`)
- Create: `~/Developer/telemetry/README.md`
- Create: `~/Developer/telemetry/.gitignore`

**Interfaces:**
- Produces: repo path `~/Developer/telemetry`, and the layout `services/<name>/Dockerfile` + config, consumed by Task 2's CI matrix.

- [ ] **Step 1: Create the repo and clone it**

```bash
gh repo create Connor-Adams/telemetry --private --description "Shared multi-tenant observability stack (loki, tempo, prometheus, otel-collector, grafana)"
```

```bash
git clone git@github.com:Connor-Adams/telemetry.git ~/Developer/telemetry
```

Expected: clone succeeds into an empty repo.

- [ ] **Step 2: Copy the five services verbatim**

```bash
cd ~/Developer/telemetry && mkdir -p services && for svc in loki tempo prometheus otel-collector grafana; do cp -R ~/Developer/cashflow/infra/"$svc" services/"$svc"; done && ls -R services | head -40
```

Expected: `services/grafana/provisioning/dashboards/cashflow/` holds the eight dashboard JSON files, and each service has a `Dockerfile`.

- [ ] **Step 3: Verify the copy is byte-identical to the source**

There is no local Docker, so config validation does not run here — it is built as a CI job in Task 2 and runs against this same content on the first push. What this step verifies instead is the thing Task 1 actually claims: that the copy changed nothing.

```bash
diff -rq /Users/connoradams/Developer/cashflow/.claude/worktrees/dokploy-migration-setup-d3a529/infra ~/Developer/telemetry/services
```

Expected: no output. Any output means a file was altered, added or dropped during the copy, which defeats the purpose of a verbatim import.

```bash
ls ~/Developer/telemetry/services/grafana/provisioning/dashboards/cashflow/ | wc -l
```

Expected: `8`.

- [ ] **Step 4: Write the README**

Create `~/Developer/telemetry/README.md` with this content:

```markdown
# telemetry

Shared observability stack for all deployments on `connor-host1`. Extracted from
`Connor-Adams/cashflow` (`infra/`) on 2026-09-23.

## Services

| Service | Image | Purpose |
|---|---|---|
| loki | `grafana/loki:3.2.0` | log storage, tsdb schema v13, 720h retention |
| tempo | `grafana/tempo:2.6.0` | trace storage, 168h block retention |
| prometheus | `prom/prometheus:v2.55.1` | metric storage, scrapes the collector |
| otel-collector | `otel/opentelemetry-collector-contrib:0.110.0` | OTLP ingest, fans out to all three |
| grafana | `grafana/grafana:11.3.0` | query UI and alerting, at grafana.rainbot.win |

Images publish to `ghcr.io/connor-adams/telemetry-<svc>:main`.

## Tenancy

One collector serves every deployment. Tenants are separated by label, not by
instance — each emitter sets the OTel resource attribute `service.name`, which
lands as Loki `service_name`, Tempo `service.name`, and Prometheus `job`.
Adding a tenant requires no change here.

## Security

The collector's OTLP receivers are unauthenticated and must never be given a
public Domain. Emitters reach it over internal Swarm DNS by appName.
```

Create `~/Developer/telemetry/.gitignore` containing a single line: `.DS_Store`

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/telemetry && git add -A && git commit -m "feat: import the observability stack from cashflow/infra verbatim

Five services copied unchanged so the move itself is a no-op diff and every
later change stays reviewable in isolation. Configs still reference
*.railway.internal; that is fixed in a later commit." && git push -u origin main
```

---

### Task 2: CI — build and push the five images to GHCR

Cashflow's `build-images.yml` uses a content-hash skip system (`scripts/service-content-hash.cjs`, `:tree-<hash>` tags, skopeo probing) because its backend and frontend images are expensive to build. These five are config-only images that build in seconds, so that machinery is deliberately **not** ported — a plain matrix is the right size.

**Files:**
- Create: `~/Developer/telemetry/.github/workflows/build-images.yml`

This task also carries **all container-based verification for the repo**, because there is no local Docker. A `validate` job gates the build: if a config stops parsing, or Grafana stops provisioning its datasources, dashboards or alert rules, no image is published. Tasks 3 through 6 rely on this job instead of running containers locally.

**Interfaces:**
- Consumes: `services/<name>/Dockerfile` from Task 1.
- Produces: `ghcr.io/connor-adams/telemetry-{loki,tempo,prometheus,otel-collector,grafana}:main`, consumed by Task 7.
- Produces: `scripts/validate-stack.sh`, the single entry point for container-based verification, re-used by Tasks 3-6 and runnable on the box over SSH if CI is ever unavailable.

- [ ] **Step 1: Write the validation script**

Create `~/Developer/telemetry/scripts/validate-stack.sh`. It runs where Docker exists — a CI runner, or the box — and is the only place container-based checks live.

```bash
#!/usr/bin/env bash
# Container-based verification for the whole stack. Runs in CI; can also be run
# on the box. There is no local Docker on Connor's machine, so this is the only
# place these checks execute.
#
# Verifies:
#   1. the otel-collector config parses
#   2. the prometheus entrypoint renders its template and the result is valid
#   3. grafana boots and provisions 3 datasources, 8 dashboards in a cashflow
#      folder, and the 3 observability-stack alert rules
set -euo pipefail

cd "$(dirname "$0")/.."
PROBE_PW="probe-only-not-a-real-password"
fail() { echo "FAIL: $1" >&2; exit 1; }

echo "==> otel-collector config parses"
docker run --rm -v "$PWD/services/otel-collector:/cfg" \
  otel/opentelemetry-collector-contrib:0.110.0 validate --config=/cfg/config.yaml \
  || fail "otel-collector config did not validate"

echo "==> prometheus config parses"
docker run --rm -v "$PWD/services/prometheus:/cfg" \
  prom/prometheus:v2.55.1 promtool check config /cfg/prometheus.yml \
  || fail "prometheus config did not validate"

echo "==> grafana boots and provisions"
docker build -q -t telemetry-grafana-ci services/grafana >/dev/null
docker run -d --rm --name telemetry-grafana-ci-probe \
  -e GF_SECURITY_ADMIN_PASSWORD="$PROBE_PW" \
  -e LOKI_URL=http://probe-loki:3100 \
  -e TEMPO_URL=http://probe-tempo:3200 \
  -e PROM_URL=http://probe-prom:9090 \
  -p 3999:3000 telemetry-grafana-ci >/dev/null

for _ in $(seq 1 30); do
  curl -sf -u "admin:$PROBE_PW" http://localhost:3999/api/health >/dev/null && break
  sleep 2
done

api() { curl -sf -u "admin:$PROBE_PW" "http://localhost:3999$1"; }

# Only uids are asserted here. At this point in the plan the urls are still the
# hardcoded railway.internal ones; Task 4 env-templates them and tightens this
# check to assert the urls come from the environment.
api /api/datasources | python3 -c '
import sys, json
ds = {d["uid"] for d in json.load(sys.stdin)}
want = {"loki", "tempo", "prometheus"}
assert ds == want, f"datasource uids wrong: got {sorted(ds)}, want {sorted(want)}"
print("  datasource uids OK:", sorted(ds))
' || fail "datasource provisioning wrong"

# Count only. Task 6 tightens this to assert they are foldered under cashflow,
# once the provider config has been checked.
api '/api/search?type=dash-db' | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert len(d) == 8, f"expected 8 dashboards, got {len(d)}"
print("  dashboards OK:", len(d), "in", sorted({x.get("folderTitle", "(root)") for x in d}))
' || fail "dashboard provisioning wrong"

api /api/v1/provisioning/alert-rules | python3 -c '
import sys, json
titles = {r["title"] for r in json.load(sys.stdin)}
want = {"OtelCollectorScrapeDown", "TempoExportFailing", "LokiExportFailing"}
missing = want - titles
assert not missing, f"missing alert rules: {missing}"
print("  alert rules OK:", sorted(want))
' || fail "alert rule provisioning wrong"

docker stop telemetry-grafana-ci-probe >/dev/null

echo "==> all checks passed"
```

Make it executable:

```bash
cd ~/Developer/telemetry && chmod +x scripts/validate-stack.sh
```

Note this script does use `docker run --rm`. That is fine — it runs on a CI runner, not on Connor's machine or the box, where the deletion guard applies.

- [ ] **Step 2: Write the workflow**

Create `~/Developer/telemetry/.github/workflows/build-images.yml`:

```yaml
name: build-images

on:
  push:
    branches: [main]
    paths-ignore:
      - '**/*.md'
      - 'docs/**'
  pull_request:
  workflow_dispatch:

concurrency:
  group: build-images-${{ github.ref }}
  cancel-in-progress: false

jobs:
  # There is no local Docker on Connor's machine, so this job is where every
  # container-based check runs. It gates the build: a config that stops parsing
  # or a Grafana that stops provisioning publishes no image.
  validate:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

      # Task 3 adds a step here to run services/prometheus/entrypoint.test.sh
      # once that entrypoint exists.
      - name: Validate configs and Grafana provisioning
        run: ./scripts/validate-stack.sh

  build:
    needs: validate
    # Only publish from main; pull_request runs validate only.
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      fail-fast: false
      matrix:
        service: [loki, tempo, prometheus, otel-collector, grafana]
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@d7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5 # v4

      - name: Log in to GHCR
        uses: docker/login-action@650006c6eb7dba73a995cc03b0b2d7f5ca915bee # v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push ${{ matrix.service }}
        uses: docker/build-push-action@f9f3042f7e2789586610d6e8b85c8f03e5195baf # v7
        with:
          context: services/${{ matrix.service }}
          file: services/${{ matrix.service }}/Dockerfile
          push: true
          # Single-manifest output. build-push v6+ defaults provenance on,
          # turning a single-arch image into an index with an extra
          # unknown/unknown manifest. Dokploy does not need that.
          provenance: false
          tags: |
            ghcr.io/connor-adams/telemetry-${{ matrix.service }}:main
            ghcr.io/connor-adams/telemetry-${{ matrix.service }}:sha-${{ github.sha }}
          cache-from: type=gha,scope=${{ matrix.service }}
          cache-to: type=gha,mode=max,scope=${{ matrix.service }}
```

- [ ] **Step 2: Commit and push to trigger it**

```bash
cd ~/Developer/telemetry && git add .github/workflows/build-images.yml && git commit -m "ci: build and push the five service images to GHCR

Plain matrix build. Cashflow's content-hash skip system is deliberately not
ported: these are config-only images that build in seconds, so the skip
machinery would cost more to maintain than it saves." && git push
```

- [ ] **Step 3: Verify the workflow succeeded**

```bash
cd ~/Developer/telemetry && gh run watch "$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: exits 0, all five matrix legs green.

- [ ] **Step 4: Verify all five images exist in GHCR**

```bash
for svc in loki tempo prometheus otel-collector grafana; do skopeo inspect --raw --creds "$(gh api user --jq .login):$(gh auth token)" "docker://ghcr.io/connor-adams/telemetry-$svc:main" >/dev/null && echo "OK   telemetry-$svc" || echo "FAIL telemetry-$svc"; done
```

Expected: five `OK` lines.

---

### Task 3: Make Prometheus host-agnostic with an envsubst entrypoint

Prometheus does **not** expand environment variables in its config file, unlike Grafana. The config becomes a template rendered at container start.

**Files:**
- Create: `~/Developer/telemetry/services/prometheus/prometheus.yml.tmpl`
- Create: `~/Developer/telemetry/services/prometheus/entrypoint.sh`
- Create: `~/Developer/telemetry/services/prometheus/entrypoint.test.sh`
- Delete: `~/Developer/telemetry/services/prometheus/prometheus.yml`
- Modify: `~/Developer/telemetry/services/prometheus/Dockerfile`

**Interfaces:**
- Produces: the prometheus image now requires env var `OTEL_COLLECTOR_HOST` — a **bare hostname**, no scheme, no port. Consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Create `~/Developer/telemetry/services/prometheus/entrypoint.test.sh`:

```sh
#!/bin/sh
# Renders the template with a known host and asserts the output. Run from this
# directory. Exercises the same code path the container entrypoint uses.
set -eu

fail() { echo "FAIL: $1" >&2; exit 1; }

OUT=$(mktemp)
OTEL_COLLECTOR_HOST=telemetry-otel-collector-abc123 \
  TEMPLATE=./prometheus.yml.tmpl OUTPUT="$OUT" ./entrypoint.sh --render-only

grep -q 'telemetry-otel-collector-abc123:9464' "$OUT" \
  || fail "app-metrics scrape target not rendered"
grep -q 'telemetry-otel-collector-abc123:8888' "$OUT" \
  || fail "collector self-telemetry scrape target not rendered"
# Negative assertions must use `if`, not `cmd && fail`. Under `set -e` an
# AND-OR list that ends in a failed grep exits the script — which would abort
# on the *success* path, where these patterns are correctly absent.
if grep -q 'railway.internal' "$OUT"; then
  fail "railway.internal survived rendering"
fi
if grep -q '\${' "$OUT"; then
  fail "unsubstituted variable left in output"
fi

# An unset required variable must fail loudly rather than render an empty host.
if OTEL_COLLECTOR_HOST= TEMPLATE=./prometheus.yml.tmpl OUTPUT="$OUT" \
     ./entrypoint.sh --render-only 2>/dev/null; then
  fail "empty OTEL_COLLECTOR_HOST was accepted"
fi

echo "PASS"
```

Then make it executable and run it:

```bash
cd ~/Developer/telemetry/services/prometheus && chmod +x entrypoint.test.sh && ./entrypoint.test.sh
```

Expected: FAIL — `./entrypoint.sh: not found`.

- [ ] **Step 2: Write the template**

Create `~/Developer/telemetry/services/prometheus/prometheus.yml.tmpl`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  # App metrics emitted by the OTLP -> prometheus pipeline (cashflow_http_*,
  # job tick counters, and the equivalents from every other tenant). The
  # up{job="otel-collector"} series generated by this scrape powers the
  # OtelCollectorScrapeDown alert.
  #
  # honor_labels: true lets the emitting application's own `job` label win
  # instead of being renamed to `exported_job` on collision with the scrape
  # job. That gives job="cashflow-backend" / job="rainbot-raincloud" directly,
  # which is the label a multi-tenant stack actually wants. The synthetic up{}
  # series is generated by Prometheus rather than exposed by the target, so it
  # keeps job="otel-collector" regardless and the alert is unaffected.
  - job_name: otel-collector
    honor_labels: true
    static_configs:
      - targets:
          - ${OTEL_COLLECTOR_HOST}:9464

  # Self-telemetry from the collector itself (otelcol_exporter_*,
  # otelcol_receiver_*, otelcol_processor_*). These series surface the
  # otlphttp/tempo and loki exporter failure counters that feed the
  # TempoExportFailing and LokiExportFailing alert rules. Without this scrape
  # those alerts have no data and tempo can be silently down.
  - job_name: otel-collector-self
    static_configs:
      - targets:
          - ${OTEL_COLLECTOR_HOST}:8888
```

Then remove the old static config:

```bash
cd ~/Developer/telemetry/services/prometheus && git rm prometheus.yml
```

- [ ] **Step 3: Write the entrypoint**

Create `~/Developer/telemetry/services/prometheus/entrypoint.sh`:

```sh
#!/bin/sh
# Renders prometheus.yml from its template, because Prometheus does not expand
# environment variables in its own config file. Refuses to render with an unset
# host rather than producing a config that silently scrapes ":9464".
set -eu

TEMPLATE="${TEMPLATE:-/etc/prometheus/prometheus.yml.tmpl}"
OUTPUT="${OUTPUT:-/etc/prometheus/prometheus.yml}"

if [ -z "${OTEL_COLLECTOR_HOST:-}" ]; then
  echo "[entrypoint] FATAL: OTEL_COLLECTOR_HOST is required but unset/empty." >&2
  echo "[entrypoint] Set it to the collector's Dokploy appName, e.g." >&2
  echo "[entrypoint]   OTEL_COLLECTOR_HOST=telemetry-otel-collector-xxxxxx" >&2
  exit 1
fi

# Only the variable named here is substituted. A bare `envsubst` would also eat
# any literal $-expression Prometheus itself uses.
envsubst '${OTEL_COLLECTOR_HOST}' < "$TEMPLATE" > "$OUTPUT"
echo "[entrypoint] rendered $OUTPUT with OTEL_COLLECTOR_HOST=$OTEL_COLLECTOR_HOST"

# --render-only exists so the test can exercise rendering without booting
# Prometheus.
if [ "${1:-}" = "--render-only" ]; then
  exit 0
fi

exec /bin/prometheus \
  --config.file="$OUTPUT" \
  --storage.tsdb.path=/prometheus \
  --web.console.libraries=/usr/share/prometheus/console_libraries \
  --web.console.templates=/usr/share/prometheus/consoles \
  "$@"
```

Make it executable:

```bash
cd ~/Developer/telemetry/services/prometheus && chmod +x entrypoint.sh
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ~/Developer/telemetry/services/prometheus && ./entrypoint.test.sh
```

Expected: `PASS`.

If `envsubst` is missing locally, install it with `brew install gettext`, or run the test inside the built image after Step 5.

- [ ] **Step 5: Update the Dockerfile**

Replace `~/Developer/telemetry/services/prometheus/Dockerfile` with:

```dockerfile
FROM prom/prometheus:v2.55.1

USER root
# envsubst comes from gettext; the base image does not ship it.
RUN apk add --no-cache gettext

COPY prometheus.yml.tmpl /etc/prometheus/prometheus.yml.tmpl
COPY entrypoint.sh /entrypoint.sh

USER nobody
ENTRYPOINT ["/entrypoint.sh"]
```

- [ ] **Step 6: Move the prometheus check in CI from static config to rendered template**

`services/prometheus/prometheus.yml` no longer exists, so the check written in Task 2 would now fail on a missing file. Replace that section of `scripts/validate-stack.sh` — the block under `echo "==> prometheus config parses"` — with one that builds the image, renders the template, and validates the result:

```bash
echo "==> prometheus renders its template and the result is valid"
docker build -q -t telemetry-prometheus-ci services/prometheus >/dev/null
docker run --rm -e OTEL_COLLECTOR_HOST=probe-host \
  --entrypoint /bin/sh telemetry-prometheus-ci -c \
  'TEMPLATE=/etc/prometheus/prometheus.yml.tmpl OUTPUT=/tmp/p.yml /entrypoint.sh --render-only \
     && grep -q "probe-host:9464" /tmp/p.yml \
     && grep -q "probe-host:8888" /tmp/p.yml \
     && promtool check config /tmp/p.yml' \
  || fail "prometheus template did not render into a valid config"
```

Also add the entrypoint unit test to `.github/workflows/build-images.yml`, in the `validate` job immediately before the `Validate configs and Grafana provisioning` step (replacing the placeholder comment left there in Task 2):

```yaml
      - name: Run the prometheus entrypoint unit test
        run: |
          sudo apt-get update -qq && sudo apt-get install -y -qq gettext-base
          cd services/prometheus && ./entrypoint.test.sh
```

- [ ] **Step 7: Push and confirm CI proves the rendering works**

There is no local Docker, so the image build and render are verified by the `validate` job. Commit (Step 8), push, then:

```bash
cd ~/Developer/telemetry && gh run watch "$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: exits 0. In the `validate` job log, `entrypoint.test.sh` prints `PASS` and the validate script prints `prometheus renders its template and the result is valid`.

If the build fails because `apk` is unavailable — the base image not being Alpine — substitute the correct package manager in the Dockerfile and push again. That failure surfaces here rather than locally.

- [ ] **Step 8: Commit**

```bash
cd ~/Developer/telemetry && git add services/prometheus && git commit -m "feat(prometheus): render the config from a template at boot

Prometheus does not expand environment variables in its config file, so the
scrape targets move into prometheus.yml.tmpl and an entrypoint renders them
with envsubst. The entrypoint hard-fails on an unset OTEL_COLLECTOR_HOST
rather than rendering a config that scrapes ':9464'.

Also sets honor_labels: true so the emitting application's own job label wins
instead of being renamed to exported_job, and drops the cashflow- prefix from
the job names now that the collector is shared." && git push
```

---

### Task 4: Make Grafana datasources host-agnostic

Unlike Prometheus, Grafana expands `$VAR` in provisioning YAML natively, so no entrypoint work is needed here.

**Files:**
- Modify: `~/Developer/telemetry/services/grafana/provisioning/datasources/datasources.yaml`

**Interfaces:**
- Produces: the grafana image now requires `LOKI_URL`, `TEMPO_URL`, `PROM_URL` — **full URLs** including scheme and port. Consumed by Task 8.

- [ ] **Step 1: Replace the three hardcoded urls**

```bash
cd ~/Developer/telemetry/services/grafana/provisioning/datasources && python3 -c "
import pathlib
p = pathlib.Path('datasources.yaml')
s = p.read_text()
pairs = [
    ('url: http://loki.railway.internal:3100',       'url: \$LOKI_URL'),
    ('url: http://tempo.railway.internal:3200',      'url: \$TEMPO_URL'),
    ('url: http://prometheus.railway.internal:9090', 'url: \$PROM_URL'),
]
for old, new in pairs:
    assert old in s, f'anchor not found: {old}'
    s = s.replace(old, new)
p.write_text(s)
print('replaced 3 urls')
" && grep -n 'url:' datasources.yaml
```

Expected: three lines reading `url: $LOKI_URL`, `url: $TEMPO_URL`, `url: $PROM_URL`, and no remaining `railway.internal`.

- [ ] **Step 2: Confirm the uids were not disturbed**

```bash
cd ~/Developer/telemetry/services/grafana/provisioning/datasources && grep -n 'uid:' datasources.yaml
```

Expected: exactly `uid: loki`, `uid: tempo`, `uid: prometheus`, plus the cross-references (`datasourceUid: tempo` in Loki's derived fields, `datasourceUid: 'loki'` in Tempo's `tracesToLogsV2`). All eight dashboards resolve datasources by these uids; if any changed, revert and redo.

- [ ] **Step 3: Tighten the CI datasource assertion to prove env expansion**

Task 2's check asserts uids only, because the urls were still hardcoded then. Now that they come from the environment, replace that block in `scripts/validate-stack.sh` — the one under the comment about Task 4 tightening it — with an assertion on the urls the probe env supplies:

```bash
api /api/datasources | python3 -c '
import sys, json
ds = {d["uid"]: d["url"] for d in json.load(sys.stdin)}
want = {"loki": "http://probe-loki:3100",
        "tempo": "http://probe-tempo:3200",
        "prometheus": "http://probe-prom:9090"}
assert ds == want, f"datasources wrong: got {ds}, want {want}"
print("  datasources OK:", sorted(ds))
' || fail "datasource provisioning wrong"
```

This fails if `$VAR` expansion silently does not happen — the urls would come back as the literal strings `$LOKI_URL` and so on, which is precisely the failure worth catching.

- [ ] **Step 4: Push and confirm CI proves the expansion**

```bash
cd ~/Developer/telemetry && gh run watch "$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: exits 0, and the `validate` job log prints `datasources OK: ['loki', 'prometheus', 'tempo']` and `dashboards OK: 8`.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/telemetry && git add services/grafana/provisioning/datasources/datasources.yaml && git commit -m "feat(grafana): take datasource urls from the environment

Grafana expands \$VAR in provisioning yaml natively, so the three
railway.internal urls become \$LOKI_URL / \$TEMPO_URL / \$PROM_URL with no
entrypoint changes. Datasource uids are untouched — all eight dashboards
resolve their datasources by uid." && git push
```

---

### Task 5: Update the alert rules for the renamed scrape job

Task 3 renamed the scrape jobs from `cashflow-otel-collector` to `otel-collector`. One alert rule references the old name and would evaluate `NoData` forever.

**Files:**
- Modify: `~/Developer/telemetry/services/grafana/provisioning/alerting/observability-stack.yaml`

- [ ] **Step 1: Find every stale job reference**

```bash
cd ~/Developer/telemetry/services/grafana/provisioning && grep -rn 'cashflow-otel-collector' . || echo "none remaining"
```

Expected: at least one hit at `alerting/observability-stack.yaml:169`, inside `OtelCollectorScrapeDown`'s `up{job="cashflow-otel-collector"}` expression. Every hit must be updated in Step 2.

- [ ] **Step 2: Rename it**

```bash
cd ~/Developer/telemetry/services/grafana/provisioning && python3 -c "
import pathlib
p = pathlib.Path('alerting/observability-stack.yaml')
s = p.read_text()
n = s.count('cashflow-otel-collector')
assert n >= 1, 'expected at least one reference'
s = s.replace('cashflow-otel-collector-self', 'otel-collector-self')
s = s.replace('cashflow-otel-collector', 'otel-collector')
p.write_text(s)
print(f'renamed {n} reference(s)')
" && grep -rn 'job=\"otel-collector' alerting/
```

Expected: the `up{job="otel-collector"}` expression, with no `cashflow-` prefix remaining.

Replacement order matters — the longer `cashflow-otel-collector-self` is replaced first, or the shorter pattern would mangle it via a partial match.

- [ ] **Step 3: Verify no stale references survive anywhere in the repo**

```bash
cd ~/Developer/telemetry && grep -rn 'cashflow-otel-collector' . && echo "STALE REFERENCES REMAIN" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 4: Push and confirm CI still parses the alerting provisioning**

The `validate` job already asserts the three alert rules provision by title, so a rename that breaks the YAML fails CI without any new check. Commit (Step 5), push, then:

```bash
cd ~/Developer/telemetry && gh run watch "$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: exits 0, and the `validate` job log prints `alert rules OK: ['LokiExportFailing', 'OtelCollectorScrapeDown', 'TempoExportFailing']`.

Note what this does and does not prove: it confirms the rules still load, not that the renamed job label matches real data. Only Task 11 Step 6, against live metrics, can confirm that.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/telemetry && git add services/grafana/provisioning/alerting/observability-stack.yaml && git commit -m "fix(alerting): follow the scrape job rename

The collector is shared across tenants now, so its scrape jobs lost the
cashflow- prefix. OtelCollectorScrapeDown matched on the old name and would
have evaluated NoData forever." && git push
```

---

### Task 6: Confirm dashboards are tenant-foldered

The dashboards already sit under `provisioning/dashboards/cashflow/` from the verbatim copy. This task verifies the provider config actually folders them in the Grafana UI, so rainbot's dashboards can land beside them later without collision.

**Files:**
- Modify (conditionally): `~/Developer/telemetry/services/grafana/provisioning/dashboards/dashboards.yaml`

- [ ] **Step 1: Inspect the current provider config**

```bash
cd ~/Developer/telemetry/services/grafana/provisioning/dashboards && cat dashboards.yaml
```

- [ ] **Step 2: Ensure the provider derives folders from the directory structure**

The provider must set `foldersFromFilesStructure: true` with `path` pointing at the **parent** dashboards directory, so `cashflow/` becomes a Grafana folder instead of all eight dashboards landing at the root. If the file already does exactly this, make no change and note that in the commit. Otherwise replace it with:

```yaml
apiVersion: 1

providers:
  # One provider for every tenant. foldersFromFilesStructure turns each
  # subdirectory of `path` into a Grafana folder, so
  # provisioning/dashboards/cashflow/*.json lands in a "cashflow" folder and a
  # future rainbot/ directory folders itself with no config change here.
  - name: tenants
    orgId: 1
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: false
    options:
      path: /etc/grafana/provisioning/dashboards
      foldersFromFilesStructure: true
```

- [ ] **Step 3: Tighten the CI dashboard assertion to require the folder**

Task 2's check counts dashboards only. Now assert they are actually foldered. Replace that block in `scripts/validate-stack.sh` — the one under the comment about Task 6 tightening it — with:

```bash
api '/api/search?type=dash-db' | python3 -c '
import sys, json
d = json.load(sys.stdin)
assert len(d) == 8, f"expected 8 dashboards, got {len(d)}"
folders = {x.get("folderTitle", "(root)") for x in d}
assert folders == {"cashflow"}, f"expected all dashboards in a cashflow folder, got {folders}"
print("  dashboards OK: 8 in", folders)
' || fail "dashboard foldering wrong"
```

This is the check that would have caught the dashboards landing at the root, which is the actual failure mode when `foldersFromFilesStructure` is missing or `path` points at the wrong directory.

- [ ] **Step 3b: Push and confirm CI proves the foldering**

```bash
cd ~/Developer/telemetry && gh run watch "$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: exits 0, and the `validate` job log prints `dashboards OK: 8 in {'cashflow'}`.

- [ ] **Step 4: Commit**

```bash
cd ~/Developer/telemetry && git add services/grafana/provisioning/dashboards/dashboards.yaml && git commit -m "feat(grafana): folder dashboards by tenant

foldersFromFilesStructure turns each subdirectory into a Grafana folder, so
cashflow's eight dashboards land in a cashflow folder and a future rainbot/
directory needs no provider change." && git push
```

---

### Task 7: Create the five Dokploy Applications

Dokploy generates each Application's `appName` at creation time, and those names are the DNS hostnames every other service needs. They cannot be known in advance, so creation and env wiring are necessarily two passes.

**Files:**
- Create: `~/Developer/telemetry/docs/dokploy-appnames.md`

**Interfaces:**
- Produces: five `applicationId`s and five generated `appName`s, consumed by Task 8 and Task 10.

- [ ] **Step 1: Confirm API reachability and get the environment id**

```bash
set +x; source ~/.config/secrets/gv.env; curl -s -H "x-api-key: $dokploy_key" "http://192.168.2.88:3000/api/project.one?projectId=TPsbEl1w_3hII69qotADg" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["name"], [e["environmentId"] for e in d["environments"]])'
```

Expected: `Telemetry ['<environmentId>']`. Record that id — Applications are created against an **environment**, not a project. Note that service arrays hang off `environments[]`, never the project root.

- [ ] **Step 2: Create the five Applications**

Substituting the environment id from Step 1:

```bash
set +x; source ~/.config/secrets/gv.env; for svc in loki tempo prometheus otel-collector grafana; do curl -s -X POST -H "x-api-key: $dokploy_key" -H 'Content-Type: application/json' -d "{\"name\":\"$svc\",\"appName\":\"\",\"description\":\"\",\"environmentId\":\"<ENV_ID>\",\"serverId\":null}" http://192.168.2.88:3000/api/application.create | python3 -c "import sys,json; d=json.load(sys.stdin); print('$svc', d.get('applicationId'), d.get('appName'))"; done
```

Expected: five lines, each with an applicationId and a generated appName shaped `telemetry-<svc>-xxxxxx`.

If `application.create` rejects the payload, read the panel's own network calls for the v0.30.7 schema rather than guessing at field names.

- [ ] **Step 3: Record the generated names**

```bash
set +x; source ~/.config/secrets/gv.env; curl -s -H "x-api-key: $dokploy_key" "http://192.168.2.88:3000/api/project.one?projectId=TPsbEl1w_3hII69qotADg" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for e in d["environments"]:
    for a in e.get("applications") or []:
        print(f"{a[\"name\"]:16} {a[\"appName\"]:40} {a[\"applicationId\"]}")
'
```

Write the output into `~/Developer/telemetry/docs/dokploy-appnames.md`, with a heading explaining that these are DNS hostnames on `dokploy-network` and that they change if an Application is deleted and recreated.

- [ ] **Step 4: Point each Application at its GHCR image**

For each service, set the docker provider to `ghcr.io/connor-adams/telemetry-<svc>:main` via `application.saveDockerProvider` (or the v0.30.7 equivalent), passing the `applicationId` from Step 3.

- [ ] **Step 5: Add the persistent mounts**

Four Applications need a volume; the collector is stateless and gets none.

| Service | Mount path |
|---|---|
| loki | `/loki` |
| tempo | `/var/tempo` |
| prometheus | `/prometheus` |
| grafana | `/var/lib/grafana` |

Dokploy names the underlying volume `<appName>-data`; Task 10 restores into exactly those.

- [ ] **Step 6: Attach the domain to Grafana only**

Add `grafana.rainbot.win` to the **grafana** Application, port 3000. Attach no domain to any other Application.

- [ ] **Step 7: Verify the collector has no domain**

```bash
set +x; source ~/.config/secrets/gv.env; curl -s -H "x-api-key: $dokploy_key" "http://192.168.2.88:3000/api/project.one?projectId=TPsbEl1w_3hII69qotADg" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for e in d["environments"]:
    for a in e.get("applications") or []:
        doms=[x.get("host") for x in (a.get("domains") or [])]
        print(f"{a[\"name\"]:16} domains={doms}")
'
```

Expected: `grafana domains=['grafana.rainbot.win']` and **every other service `domains=[]`**. A domain on otel-collector violates issue #858 and must be removed before continuing.

- [ ] **Step 8: Commit the recorded appNames**

```bash
cd ~/Developer/telemetry && git add docs/dokploy-appnames.md && git commit -m "docs: record the generated Dokploy appNames

These are the DNS hostnames services resolve each other by on dokploy-network.
They are generated at Application creation and change if an Application is
deleted and recreated, so env wiring must be re-checked if that happens." && git push
```

---

### Task 8: Wire the environment variables

**Files:** none in git — this is Dokploy state, using the appNames recorded in Task 7.

- [ ] **Step 1: Set each Application's env**

Substitute the real appNames from `docs/dokploy-appnames.md`:

| Application | Environment |
|---|---|
| loki | *(none)* |
| tempo | *(none)* |
| prometheus | `OTEL_COLLECTOR_HOST=telemetry-otel-collector-xxxxxx` |
| otel-collector | `LOKI_HOST=telemetry-loki-xxxxxx`, `TEMPO_HOST=telemetry-tempo-xxxxxx`, `PUBLIC_FRONTEND_ORIGIN=<cashflow frontend origin>` |
| grafana | `LOKI_URL=http://telemetry-loki-xxxxxx:3100`, `TEMPO_URL=http://telemetry-tempo-xxxxxx:3200`, `PROM_URL=http://telemetry-prometheus-xxxxxx:9090`, `GF_SECURITY_ADMIN_PASSWORD=<strong password>` |

The shape difference is a real source of mistakes: `OTEL_COLLECTOR_HOST`, `LOKI_HOST` and `TEMPO_HOST` are **bare hostnames** (the collector config and prometheus template supply scheme and port), while `LOKI_URL`/`TEMPO_URL`/`PROM_URL` are **full URLs**.

Set these through `application.update` with the `env` field, one Application at a time.

- [ ] **Step 2: Set the Grafana admin password without putting it in shell history**

Generate and store it with the existing secrets helper, which prompts without echoing:

```bash
setkey telemetry_grafana_admin_password
```

Then paste that value into the Dokploy UI's env field for the grafana Application. Do not pass it as a curl argument.

- [ ] **Step 3: Verify env landed on every Application — key names only, never values**

```bash
set +x; source ~/.config/secrets/gv.env; curl -s -H "x-api-key: $dokploy_key" "http://192.168.2.88:3000/api/project.one?projectId=TPsbEl1w_3hII69qotADg" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for e in d["environments"]:
    for a in e.get("applications") or []:
        keys=[l.split("=",1)[0] for l in (a.get("env") or "").splitlines() if "=" in l]
        print(f"{a[\"name\"]:16} {keys}")
'
```

Expected: prometheus `['OTEL_COLLECTOR_HOST']`; otel-collector `['LOKI_HOST','TEMPO_HOST','PUBLIC_FRONTEND_ORIGIN']`; grafana `['LOKI_URL','TEMPO_URL','PROM_URL','GF_SECURITY_ADMIN_PASSWORD']`; loki and tempo empty.

---

### Task 9: Deploy in dependency order and verify health

Deploy order is load-bearing. A Swarm service with no running task does not resolve, so deploying a consumer before its target is healthy produces `ENOTFOUND` that looks like a networking fault but is not — this is exactly what cost time during the rainbot cutover.

- [ ] **Step 1: Deploy the three storage backends first**

Trigger a deploy for `loki`, `tempo`, `prometheus`. Wait for each to report 1/1:

```bash
set +x; ssh root@192.168.2.88 'docker service ls --filter name=telemetry- --format "{{.Name}}\t{{.Replicas}}\t{{.Image}}"'
```

Expected: `telemetry-loki-*`, `telemetry-tempo-*`, `telemetry-prometheus-*` each `1/1`.

- [ ] **Step 2: Deploy the collector, then confirm it resolves both backends**

Substitute real appNames:

```bash
set +x; ssh root@192.168.2.88 'C=$(docker ps --filter "name=telemetry-otel-collector" --format "{{.Names}}" | head -1); echo "from: $C"; docker exec "$C" getent hosts telemetry-loki-xxxxxx; docker exec "$C" getent hosts telemetry-tempo-xxxxxx'
```

Expected: both resolve to `10.0.x.x` addresses.

If either returns nothing, the target service has no running task — go back to Step 1 rather than investigating DNS.

- [ ] **Step 3: Deploy grafana**

Trigger the grafana deploy and confirm 1/1 via the command in Step 1.

- [ ] **Step 4: Verify Prometheus rendered its config with the real host**

```bash
set +x; ssh root@192.168.2.88 'C=$(docker ps --filter "name=telemetry-prometheus" --format "{{.Names}}" | head -1); docker logs "$C" 2>&1 | grep entrypoint'
```

Expected: `[entrypoint] rendered /etc/prometheus/prometheus.yml with OTEL_COLLECTOR_HOST=telemetry-otel-collector-xxxxxx`.

- [ ] **Step 5: Verify Grafana is reachable on its domain**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://grafana.rainbot.win/login
```

Expected: `200`. If this fails, the Cloudflare tunnel needs a route for `grafana.rainbot.win` in the Infra project's `cloudflared` configuration — the same mechanism already serving `dash.rainbot.win`.

---

### Task 10: Migrate the four data stores

Each store is replaced while its consumer is stopped. Restoring into a live Loki/Tempo/Prometheus data directory corrupts it.

Measured sizes: prometheus 672.7 MB, tempo 597.1 MB, loki 63.3 MB, grafana 14.6 MB.

**Files:**
- Create: `~/Developer/telemetry/scripts/migrate-store.sh`

- [ ] **Step 1: Write the migration script**

Create `~/Developer/telemetry/scripts/migrate-store.sh`:

```bash
#!/usr/bin/env bash
# Streams one store's data from its Railway volume into the matching Dokploy
# volume on the box. Railway -> this machine -> box, no object-store staging.
#
# Usage: migrate-store.sh <railway-service> <container-path> <dokploy-appname>
#   e.g. migrate-store.sh loki /loki telemetry-loki-abc123
#
# The destination Dokploy service MUST be stopped first. Restoring into a live
# data directory corrupts Loki/Tempo/Prometheus.
set -euo pipefail

SVC="${1:?railway service name}"
PATH_IN="${2:?path inside the railway container}"
APPNAME="${3:?dokploy appName}"
BOX="${BOX:-root@192.168.2.88}"
VOL="${APPNAME}-data"
HELPER="migrate-${APPNAME}-$$"

echo "==> verifying destination volume ${VOL} exists"
ssh "$BOX" "docker volume inspect '${VOL}' >/dev/null" \
  || { echo "FATAL: volume ${VOL} does not exist — deploy the service once to create it" >&2; exit 1; }

running=$(ssh "$BOX" "docker ps --filter 'name=${APPNAME}' --format '{{.Names}}' | wc -l")
if [ "$running" -ne 0 ]; then
  echo "FATAL: ${APPNAME} still has ${running} running container(s). Stop the service first." >&2
  exit 1
fi

echo "==> source inventory"
railway ssh --service "$SVC" "sh -c 'du -sh ${PATH_IN}; ls ${PATH_IN}'" </dev/null

echo "==> streaming ${SVC}:${PATH_IN} -> ${BOX}:${VOL}"
# A helper container mounts the named volume so tar can write into it. No --rm:
# the box guards against container deletion, so it is cleaned up explicitly.
railway ssh --service "$SVC" "sh -c 'tar -C ${PATH_IN} -cf - .'" </dev/null \
  | ssh "$BOX" "docker run -i --name '${HELPER}' -v '${VOL}':/dest alpine:3 tar -C /dest -xf -"
ssh "$BOX" "docker container rm '${HELPER}' >/dev/null"

echo "==> destination inventory"
ssh "$BOX" "docker run -i --name '${HELPER}-v' -v '${VOL}':/dest alpine:3 sh -c 'du -sh /dest; ls /dest'; docker container rm '${HELPER}-v' >/dev/null"

echo "==> done: ${SVC} -> ${VOL}"
```

The destination volume is freshly created by the service's first deploy and therefore empty, so the script extracts over it without clearing it first. If a migration is ever re-run against a populated volume, delete and recreate the volume rather than extracting on top of existing data.

Make it executable:

```bash
cd ~/Developer/telemetry && chmod +x scripts/migrate-store.sh
```

- [ ] **Step 2: Commit the script before using it**

```bash
cd ~/Developer/telemetry && git add scripts/migrate-store.sh && git commit -m "feat(scripts): stream one store from a Railway volume to a Dokploy volume

Refuses to run unless the destination volume exists and its Dokploy service is
stopped — restoring into a live Loki/Tempo/Prometheus data directory corrupts
it. Avoids docker run --rm because the box guards container deletion." && git push
```

- [ ] **Step 3: Migrate loki first — smallest store, proves the pipeline**

Stop the `loki` Application in Dokploy, then:

```bash
cd ~/Developer/telemetry && ./scripts/migrate-store.sh loki /loki telemetry-loki-xxxxxx
```

Expected: source inventory shows `63.3M` and the directories `chunks compactor index index_cache rules wal`; destination inventory shows a comparable size and the same names.

- [ ] **Step 4: Start loki and confirm it reads the migrated data**

Start the loki Application, then query it from a container already on the network:

```bash
set +x; ssh root@192.168.2.88 'C=$(docker ps --filter "name=telemetry-grafana" --format "{{.Names}}" | head -1); docker exec "$C" wget -qO- "http://telemetry-loki-xxxxxx:3100/loki/api/v1/labels"'
```

Expected: JSON containing `"service_name"` among the labels — proving migrated index data is readable, not merely present on disk.

- [ ] **Step 5: Migrate the remaining three**

Stop each Application before its migration and start it after.

```bash
cd ~/Developer/telemetry && ./scripts/migrate-store.sh tempo /var/tempo telemetry-tempo-xxxxxx
```

```bash
cd ~/Developer/telemetry && ./scripts/migrate-store.sh prometheus /prometheus telemetry-prometheus-xxxxxx
```

```bash
cd ~/Developer/telemetry && ./scripts/migrate-store.sh grafana /var/lib/grafana telemetry-grafana-xxxxxx
```

Expected per store: destination `du` within a few percent of source `du`.

Grafana carries `grafana.db`, which owns the service-account token. After starting grafana, the entrypoint re-derives the admin password from `GF_SECURITY_ADMIN_PASSWORD`, so the env var set in Task 8 governs — not whatever the migrated database held.

- [ ] **Step 6: Confirm the tempo persistence canary survived**

```bash
set +x; ssh root@192.168.2.88 'C=$(docker ps --filter "name=telemetry-tempo" --format "{{.Names}}" | head -1); docker exec "$C" ls /var/tempo'
```

Expected: `issue-370-sentinel-20260530T053027Z.txt` alongside `traces` and `wal` — an independent check that the copy carried small files too, not just the large directories.

---

### Task 11: End-to-end verification

Every item in the spec's verification list. Do not proceed to Task 12 until all pass.

- [ ] **Step 1: All five services running**

```bash
set +x; ssh root@192.168.2.88 'docker service ls --filter name=telemetry- --format "{{.Name}}\t{{.Replicas}}"'
```

Expected: five services, all `1/1`.

- [ ] **Step 2: Both Prometheus scrape jobs up**

```bash
set +x; ssh root@192.168.2.88 'C=$(docker ps --filter "name=telemetry-grafana" --format "{{.Names}}" | head -1); docker exec "$C" wget -qO- "http://telemetry-prometheus-xxxxxx:9090/api/v1/query?query=up"' | python3 -m json.tool
```

Expected: two results with `job` values `otel-collector` and `otel-collector-self`, both value `"1"`.

- [ ] **Step 3: All three datasources green**

```bash
curl -s -u admin:<password> https://grafana.rainbot.win/api/datasources | python3 -c 'import sys,json; [print(d["name"], d["uid"], d["url"]) for d in json.load(sys.stdin)]'
```

Expected: three datasources with uids `loki`/`tempo`/`prometheus` pointing at the telemetry appNames.

- [ ] **Step 4: Historical data spans the cutover date**

In Grafana Explore, query a window starting a week before today and ending now:
- Loki: `{service_name="cashflow-backend"}`
- Prometheus: `cashflow_http_server_requests_total`
- Tempo: search by service name `cashflow-backend`

Expected: results from **before** the migration, proving history came across rather than the stack merely starting fresh.

- [ ] **Step 5: The preserved service-account token still authenticates**

```bash
set +x; source ~/.config/secrets/cashflow-grafana.env; curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $GRAFANA_SA_TOKEN" https://grafana.rainbot.win/api/datasources
```

Expected: `200`. This is the check that `tempo-slow-requests` keeps working.

Then repoint that secrets file at the new host:

```bash
setkey GRAFANA_BASE_URL
```

Enter `https://grafana.rainbot.win` at the prompt.

- [ ] **Step 6: Alert rules evaluate with data, not NoData**

```bash
curl -s -u admin:<password> https://grafana.rainbot.win/api/prometheus/grafana/api/v1/rules | python3 -c '
import sys,json
d=json.load(sys.stdin)
for g in d["data"]["groups"]:
    for r in g["rules"]:
        print(f"{r[\"name\"]:32} {r.get(\"health\")} {r.get(\"state\")}")'
```

Expected: `OtelCollectorScrapeDown`, `TempoExportFailing`, `LokiExportFailing` all `health=ok`. A state of `NoData` means the scrape job rename did not take.

- [ ] **Step 7: The collector still has no domain**

Re-run Task 7 Step 7. Expected: only grafana has a domain.

---

### Task 12: Repoint the cashflow backend at the new collector

**Files:** none in git — service environment only.

Cashflow reads a single variable, `OTEL_EXPORTER_OTLP_ENDPOINT` (`backend/src/observability/logger.ts:8`, `otel.ts:29`, `metrics.ts:37`). Telemetry is **gated on it being set**, so a wrong value silently disables telemetry rather than erroring — which makes Step 3's verification mandatory, not optional.

- [ ] **Step 1: Confirm the current value**

```bash
cd ~/Developer/cashflow && railway variables --service backend --json | python3 -c 'import sys,json; v=json.load(sys.stdin); print(v.get("OTEL_EXPORTER_OTLP_ENDPOINT"))'
```

Expected: the existing `http://otel-collector.railway.internal:4318`.

- [ ] **Step 2: Decide reachability before changing anything**

The new collector has **no public domain by design**. A Railway-hosted cashflow backend therefore cannot reach it.

This task only applies once the cashflow app itself runs in the Dokploy Cashflow project, where it reaches the collector by appName over `dokploy-network`. Until then, leave `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at the Railway collector and keep the Railway telemetry stack alive — which also means Task 14 must wait.

Once cashflow is on Dokploy, set on its Application:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://telemetry-otel-collector-xxxxxx:4318
```

- [ ] **Step 3: Verify fresh telemetry arrives**

After redeploying the backend, in Grafana Explore query `{service_name="cashflow-backend"}` over the last 15 minutes.

Expected: fresh log lines dated after the redeploy.

Then query `cashflow_http_server_requests_total` and confirm the series carry `job="cashflow-backend"` rather than `exported_job` — proving `honor_labels: true` took effect.

---

### Task 13: Remove the stack from cashflow

**Files:**
- Delete: `cashflow/infra/` (entire directory)
- Modify: `cashflow/.github/workflows/build-images.yml` — the `SERVICES` array
- Modify: `cashflow/scripts/service-content-hash.cjs` — if it enumerates the infra services
- Modify: `cashflow/CLAUDE.md` — the Architecture section describing `infra/`
- Modify: `cashflow/docs/observability.md`

Do this only after Task 11 passes and, per Task 12, only once cashflow no longer depends on the Railway stack.

- [ ] **Step 1: Find every reference to infra/ before deleting**

```bash
cd ~/Developer/cashflow && grep -rn 'infra/' --include='*.yml' --include='*.yaml' --include='*.md' --include='*.cjs' --include='*.ts' --include='*.json' . | grep -v node_modules | grep -v 'docs/superpowers/'
```

Record every hit. Each must be resolved in this task — a missed one breaks CI once the directory is gone.

- [ ] **Step 2: Remove the five infra services from the build matrix**

Edit `.github/workflows/build-images.yml`, deleting these five lines from the `SERVICES` array and leaving `backend` and `frontend`:

```
            "otel-collector|infra/otel-collector|infra/otel-collector/Dockerfile"
            "loki|infra/loki|infra/loki/Dockerfile"
            "prometheus|infra/prometheus|infra/prometheus/Dockerfile"
            "grafana|infra/grafana|infra/grafana/Dockerfile"
            "tempo|infra/tempo|infra/tempo/Dockerfile"
```

- [ ] **Step 3: Check the content-hash script**

```bash
cd ~/Developer/cashflow && cat scripts/service-content-hash.cjs
```

If it maps service names to `infra/` paths, remove those entries. If it derives paths from the workflow's array, no change is needed.

- [ ] **Step 4: Delete the directory**

```bash
cd ~/Developer/cashflow && git rm -r --quiet infra
```

- [ ] **Step 5: Update CLAUDE.md**

Remove `infra/` from the repository layout description, and rewrite the Observability bullet in the Backend section to point at the telemetry repo rather than a local compose stack. State plainly that there is no local observability stack any more and that local debugging is stdout.

- [ ] **Step 6: Rewrite docs/observability.md**

The file is largely Railway setup instructions for services that no longer live here. Replace it with a short page covering: where the stack now lives (`Connor-Adams/telemetry`), where Grafana is (`https://grafana.rainbot.win`), how a service joins (set `OTEL_EXPORTER_OTLP_ENDPOINT` and a `service.name`), and that there is no local stack.

- [ ] **Step 7: Verify nothing dangling remains**

```bash
cd ~/Developer/cashflow && grep -rn 'infra/' --include='*.yml' --include='*.yaml' --include='*.cjs' . | grep -v node_modules | grep -v 'docs/superpowers/' && echo "DANGLING REFERENCES" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 8: Run the full CI suite**

```bash
cd ~/Developer/cashflow && yarn ci
```

Expected: typecheck, all tests, and both production builds pass. This is what catches a stale import or a workflow still referencing a deleted path.

- [ ] **Step 9: Commit**

```bash
cd ~/Developer/cashflow && git add -A && git commit -m "refactor: move the observability stack out to Connor-Adams/telemetry

The five-service stack now runs as Dokploy Applications in the Telemetry
project and serves every deployment, not just cashflow. Removes infra/, drops
the five infra images from the build matrix, and rewrites the observability
docs to point at the new home.

Local observability is deliberately gone: infra/ was also the local dev stack,
and local debugging is stdout now."
```

---

### Task 14: Decommission the Railway telemetry services

**Destructive and irreversible.** Do not begin without explicit confirmation from Connor, given per-service. Gate on Task 11 passing **and** Task 12 being genuinely complete — while cashflow still emits to Railway, deleting these drops telemetry entirely.

- [ ] **Step 1: Confirm the box stack has been sole source of truth long enough**

Query Grafana for data recency and confirm coverage since cutover with no gap. If there is a gap, stop and diagnose rather than deleting the only remaining copy.

- [ ] **Step 2: Confirm with Connor, naming each service**

Present the exact list — `loki`, `tempo`, `prometheus`, `grafana` in the `Cashflow Tracker` Railway project — and their volumes. Wait for explicit approval.

- [ ] **Step 3: Delete the four services and their volumes**

Only after Step 2's approval, through the Railway dashboard so each deletion is individually confirmed.

- [ ] **Step 4: Verify the box stack is unaffected**

Re-run Task 11's verification in full. Expected: all checks still pass.

---

## Verification Summary

The migration is complete when every one of these holds:

- [ ] Five images build and push to `ghcr.io/connor-adams/telemetry-<svc>:main`
- [ ] Five Dokploy Applications run `1/1` in the Telemetry project
- [ ] Prometheus boots with an envsubst-rendered config and both scrape jobs report `up`
- [ ] Grafana serves `https://grafana.rainbot.win` with all three datasources green
- [ ] All eight dashboards render, foldered under `cashflow`
- [ ] Historical queries span the cutover date in Loki, Tempo and Prometheus
- [ ] The preserved service-account token authenticates (`tempo-slow-requests` works)
- [ ] `OtelCollectorScrapeDown`, `TempoExportFailing`, `LokiExportFailing` evaluate with data
- [ ] Metrics carry `job="cashflow-backend"`, not `exported_job`
- [ ] Only grafana has a Domain; the collector has none
- [ ] `cashflow/infra/` is gone and `yarn ci` passes
