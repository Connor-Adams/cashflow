# Logging Phase 2 — OTLP log export + self-hosted Loki on Railway

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every backend log record to a self-hosted Loki instance via `otel-collector` on Railway, viewed through Grafana Cloud. Backend stdout output remains unchanged so Railway log capture still works.

**Architecture:** Pino multi-target transport — one target writes JSON to stdout (prod) or pretty-prints (dev); a second target ships every record via `pino-opentelemetry-transport` to the OTLP endpoint of a self-hosted `otel-collector`. The collector batches and forwards to Loki using its `loki` exporter. Loki stores logs on a Railway volume (filesystem backend, 30-day retention). Grafana Cloud is configured as a read-only viewer pointing at Railway's public Loki URL with basic-auth in front. No OTel `NodeSDK` is registered yet — `pino-opentelemetry-transport` brings its own `LoggerProvider`. Phase 3 will add the `NodeSDK` for traces.

**Tech Stack:** TypeScript, pino 10.x, `pino-opentelemetry-transport`, `@opentelemetry/api` 1.x, `@opentelemetry/api-logs`, `otel/opentelemetry-collector-contrib`, `grafana/loki:3.x`, Railway Docker services, Grafana Cloud free tier.

---

## File Structure

**New files:**
- `infra/otel-collector/Dockerfile`
- `infra/otel-collector/config.yaml`
- `infra/loki/Dockerfile`
- `infra/loki/config.yaml`
- `infra/docker-compose.yml` (local dev verification — collector + loki)
- `backend/test/loggerOtlpTransport.test.ts` (unit test that pino targets resolve correctly per env)

**Modified:**
- `backend/src/observability/logger.ts` (multi-target transport)
- `backend/package.json` (+ `pino-opentelemetry-transport`, `@opentelemetry/api-logs`)
- `backend/.env.example` (+ OTEL_* vars)
- `README.md` or `docs/observability.md` (optional, document the stack)

**Manual steps (no code):**
- Railway: deploy `otel-collector` and `loki` services, attach volumes, set env vars on `cashflow-backend`.
- Grafana Cloud: add Loki datasource pointing at Railway's public Loki URL.

---

## Task 1: Install OTel transport dependency

**Files:**
- Modify: `backend/package.json`
- Modify: `yarn.lock`

- [ ] **Step 1: Add packages**

```bash
yarn workspace cashflow-backend add pino-opentelemetry-transport @opentelemetry/api-logs
```

- [ ] **Step 2: Verify versions**

```bash
yarn workspace cashflow-backend why pino-opentelemetry-transport @opentelemetry/api-logs
```
Expected: `pino-opentelemetry-transport@^1` (or newer) and `@opentelemetry/api-logs@^0.5x` (or newer).

- [ ] **Step 3: Commit**

```bash
git add backend/package.json yarn.lock
git commit -m "chore(backend): add pino-opentelemetry-transport + @opentelemetry/api-logs"
```

---

## Task 2: Refactor `logger.ts` to multi-target transport

**Files:**
- Modify: `backend/src/observability/logger.ts`

The goal: keep dev pino-pretty output, keep prod JSON stdout output, AND add OTLP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Use pino's worker-thread `transport({ targets: [...] })` mechanism — never block the main event loop.

- [ ] **Step 1: Replace `logger.ts` contents**

```ts
// backend/src/observability/logger.ts
import pino, { type LoggerOptions, type TransportTargetOptions } from 'pino';
import { context as otelContext, trace } from '@opentelemetry/api';
import { als } from './requestContext';

const isProd = process.env.NODE_ENV === 'production';
const isDev = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otlpEnabled = !!otlpEndpoint && process.env.OTEL_SDK_DISABLED !== 'true';

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'cashflow-backend',
    env: process.env.NODE_ENV ?? 'development',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  mixin() {
    const ctx = als.getStore() ?? {};
    const span = trace.getSpan(otelContext.active());
    const sc = span?.spanContext();
    return {
      ...ctx,
      ...(sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {}),
    };
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.token',
      '*.access_token',
      '*.refresh_token',
    ],
    remove: true,
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

function buildTargets(): TransportTargetOptions[] {
  const targets: TransportTargetOptions[] = [];

  if (isDev) {
    // Dev: pretty-print to stdout. No JSON-to-stdout target — pino-pretty handles
    // both formatting AND output to fd 1.
    targets.push({
      target: 'pino-pretty',
      level: process.env.LOG_LEVEL ?? 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:mm:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    });
  } else {
    // Prod / test: JSON to stdout for Railway log capture.
    targets.push({
      target: 'pino/file',
      level: process.env.LOG_LEVEL ?? 'info',
      options: { destination: 1 },
    });
  }

  if (otlpEnabled) {
    // OTLP export to the collector. Runs in a worker thread; main loop is never
    // blocked by network I/O.
    targets.push({
      target: 'pino-opentelemetry-transport',
      level: process.env.LOG_LEVEL ?? 'info',
      options: {
        loggerName: 'cashflow-backend',
        serviceVersion: process.env.GIT_SHA ?? 'dev',
        resourceAttributes: {
          'service.name': 'cashflow-backend',
          'deployment.environment': process.env.NODE_ENV ?? 'development',
          'service.version': process.env.GIT_SHA ?? 'dev',
        },
        logRecordProcessorOptions: {
          recordProcessorType: 'batch',
          exporterOptions: {
            protocol: 'http/protobuf',
            url: `${otlpEndpoint!.replace(/\/$/, '')}/v1/logs`,
          },
        },
      },
    });
  }

  return targets;
}

const targets = buildTargets();

export const logger =
  targets.length === 1 && isDev
    ? // Single-target dev path: skip the transport indirection for cleaner stack traces.
      pino({ ...baseOptions, transport: { target: targets[0].target, options: targets[0].options } })
    : pino(baseOptions, pino.transport({ targets }));

// Backwards-compatible type aliases.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

void isProd;
```

- [ ] **Step 2: Typecheck**

```bash
yarn workspace cashflow-backend run typecheck
```
Expected: clean (0 errors).

- [ ] **Step 3: Run existing tests**

```bash
cd backend && yarn test 2>&1 | tail -10
```
Expected: all green (1083+ pass). The existing tests build their own pino instance (they don't import the singleton), so the transport change shouldn't affect them.

- [ ] **Step 4: Commit**

```bash
git add backend/src/observability/logger.ts
git commit -m "feat(observability): add OTLP target to pino logger (gated on OTEL_EXPORTER_OTLP_ENDPOINT)"
```

---

## Task 3: Unit test — transport target selection per env

**Files:**
- Create: `backend/test/loggerOtlpTransport.test.ts`

- [ ] **Step 1: Write the test**

```ts
// backend/test/loggerOtlpTransport.test.ts
//
// We can't easily assert on the actual OTLP HTTP traffic from a unit test
// without spinning up a fake collector. Instead, verify the target-list
// selection logic by importing the module under different env states.
//
// pino's transport spawns a worker thread for non-dev paths, which would be
// flaky to assert on synchronously. So we extract the target-builder logic
// behind a guard: the test sets env, dynamically imports the module, and
// asserts on the resulting logger's level + that it constructs without
// throwing.

import test from 'node:test';
import assert from 'node:assert/strict';

async function freshImport<T>(modulePath: string): Promise<T> {
  // Dynamic import with cache-bust to force re-evaluation under new env.
  const url = `${modulePath}?cachebust=${Date.now()}_${Math.random()}`;
  // @ts-expect-error — TS doesn't know about dynamic URLs.
  return import(url);
}

test('logger constructs without OTLP env set', async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SDK_DISABLED;
  process.env.NODE_ENV = 'test';
  const mod = await freshImport<{ logger: { level: string } }>(
    '../src/observability/logger',
  );
  assert.ok(mod.logger);
  assert.equal(typeof mod.logger.level, 'string');
});

test('logger constructs with OTLP env set', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
  delete process.env.OTEL_SDK_DISABLED;
  process.env.NODE_ENV = 'test';
  const mod = await freshImport<{ logger: { level: string } }>(
    '../src/observability/logger',
  );
  assert.ok(mod.logger);
});

test('logger skips OTLP when OTEL_SDK_DISABLED=true', async () => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
  process.env.OTEL_SDK_DISABLED = 'true';
  process.env.NODE_ENV = 'test';
  const mod = await freshImport<{ logger: { level: string } }>(
    '../src/observability/logger',
  );
  assert.ok(mod.logger);
});
```

- [ ] **Step 2: Run**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test test/loggerOtlpTransport.test.ts
```
Expected: 3 pass.

- [ ] **Step 3: Commit**

```bash
git add backend/test/loggerOtlpTransport.test.ts
git commit -m "test(observability): verify logger constructs across OTLP env permutations"
```

---

## Task 4: Update `.env.example`

**Files:**
- Modify: `backend/.env.example`

- [ ] **Step 1: Append OTel block**

Read the current `.env.example`. Append (with a comment block):

```bash
# --- Observability (Phase 2+) ---
# Set to enable OTLP log export to the collector. Unset (or OTEL_SDK_DISABLED=true)
# disables OTLP and falls back to stdout-only.
# OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.railway.internal:4318
# OTEL_SDK_DISABLED=false
# GIT_SHA=local
```

Commented-out so local dev defaults to stdout-only without setup.

- [ ] **Step 2: Commit**

```bash
git add backend/.env.example
git commit -m "docs(env): document OTEL_* env vars for observability stack"
```

---

## Task 5: `infra/otel-collector` service

**Files:**
- Create: `infra/otel-collector/Dockerfile`
- Create: `infra/otel-collector/config.yaml`

- [ ] **Step 1: Dockerfile**

```dockerfile
# infra/otel-collector/Dockerfile
FROM otel/opentelemetry-collector-contrib:0.110.0
COPY config.yaml /etc/otel-collector-config.yaml
CMD ["--config=/etc/otel-collector-config.yaml"]
```

- [ ] **Step 2: config.yaml**

```yaml
# infra/otel-collector/config.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins:
            - "https://${env:PUBLIC_FRONTEND_ORIGIN}"
            - "http://localhost:5173"
      grpc:
        endpoint: 0.0.0.0:4317

processors:
  batch:
    timeout: 5s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 15
  attributes/redact:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: http.request.header.cookie
        action: delete

exporters:
  loki:
    endpoint: http://${env:LOKI_HOST}:3100/loki/api/v1/push
    default_labels_enabled:
      exporter: false
      job: true

service:
  pipelines:
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes/redact, batch]
      exporters: [loki]
  telemetry:
    logs:
      level: info
```

The collector resolves `${env:LOKI_HOST}` and `${env:PUBLIC_FRONTEND_ORIGIN}` from its container env. Railway private networking means LOKI_HOST will be `loki.railway.internal` (or whatever Railway names the loki service).

- [ ] **Step 3: Commit**

```bash
git add infra/otel-collector/Dockerfile infra/otel-collector/config.yaml
git commit -m "infra: add otel-collector service config (OTLP HTTP/gRPC -> Loki exporter)"
```

---

## Task 6: `infra/loki` service

**Files:**
- Create: `infra/loki/Dockerfile`
- Create: `infra/loki/config.yaml`

- [ ] **Step 1: Dockerfile**

```dockerfile
# infra/loki/Dockerfile
FROM grafana/loki:3.2.0
COPY config.yaml /etc/loki/local-config.yaml
```

- [ ] **Step 2: config.yaml**

```yaml
# infra/loki/config.yaml — single-binary mode, filesystem storage on Railway volume.
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2026-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /loki/index
    cache_location: /loki/index_cache

limits_config:
  retention_period: 720h           # 30 days
  ingestion_rate_mb: 4
  ingestion_burst_size_mb: 8

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem

ruler:
  storage:
    type: local
    local:
      directory: /loki/rules
```

Loki listens on `:3100`. Railway volume must mount at `/loki` (10 GB to start).

- [ ] **Step 3: Commit**

```bash
git add infra/loki/Dockerfile infra/loki/config.yaml
git commit -m "infra: add Loki service config (single-binary, filesystem, 30d retention)"
```

---

## Task 7: Local `docker-compose.yml` for dev verification

**Files:**
- Create: `infra/docker-compose.yml`

This lets a developer run the full collector + Loki stack on their laptop, point `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` at it, run `yarn dev`, and verify logs land in Loki without touching Railway.

- [ ] **Step 1: Write the compose file**

```yaml
# infra/docker-compose.yml — local dev observability stack
services:
  loki:
    build: ./loki
    ports:
      - "3100:3100"
    volumes:
      - loki-data:/loki
    environment:
      - JAEGER_AGENT_HOST=

  otel-collector:
    build: ./otel-collector
    ports:
      - "4317:4317"   # OTLP gRPC
      - "4318:4318"   # OTLP HTTP
    environment:
      - LOKI_HOST=loki
      - PUBLIC_FRONTEND_ORIGIN=localhost:5173
    depends_on:
      - loki

volumes:
  loki-data:
```

- [ ] **Step 2: Smoke-test boot**

```bash
cd infra && docker compose up -d
```
Wait ~10s, then:
```bash
curl -s http://localhost:3100/ready                                # Loki readiness
curl -s http://localhost:4318/v1/logs -X POST                      # collector OTLP — expect 400 (empty body) not connection refused
docker compose logs otel-collector | tail -20                      # no exporter errors
docker compose down
```

If the stack doesn't boot cleanly, fix the config issue. Do NOT proceed to Task 8 with a broken stack.

- [ ] **Step 3: Commit**

```bash
git add infra/docker-compose.yml
git commit -m "infra: add docker-compose for local observability stack verification"
```

---

## Task 8: End-to-end smoke test against local stack

**Files:** none modified (this is a verification task)

- [ ] **Step 1: Boot local stack + dev server**

```bash
cd infra && docker compose up -d
cd ..
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 LOG_LEVEL=info yarn workspace cashflow-backend run dev
```

In a second terminal, hit any endpoint (e.g. `/api/health` if it exists, otherwise the root):
```bash
curl -s http://localhost:3000/api/health
```

- [ ] **Step 2: Verify the log landed in Loki**

```bash
curl -sG http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="cashflow-backend"}' \
  --data-urlencode "start=$(($(date +%s) - 120))000000000" \
  --data-urlencode "end=$(date +%s)000000000" \
  --data-urlencode 'limit=20' | python3 -m json.tool | head -50
```

Expected: at least one entry with `msg: "http_request"`, the `requestId`, `statusCode`, `path`. If no entries land, investigate (start with `docker compose logs otel-collector`).

- [ ] **Step 3: Clean up**

```bash
cd infra && docker compose down
# Kill the dev server.
```

If everything verified: no commit needed for this task. If you found and fixed an issue during smoke test, commit the fix.

---

## Task 9: Document Railway deployment (no code execution by Claude — Connor runs these)

**Files:**
- Create: `docs/observability.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Observability stack (Phase 2)

Cashflow runs a self-hosted observability stack on Railway:

- `otel-collector` — receives OTLP from the backend, forwards to Loki.
- `loki` — log storage, 30-day retention, 10GB filesystem volume.

Phase 3 will add a Tempo service for traces.

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

1. Get a free Grafana Cloud account.
2. Add a Loki datasource pointing at `https://<loki-public-url>:3100`.
3. Put basic-auth in front of the public Loki endpoint (Railway service variables → set up a simple proxy or use `loki`'s `auth_enabled: true` config — see `infra/loki/config.yaml`).

## Verification

In Grafana Cloud Explore, switch to the Loki datasource and run:
```
{service_name="cashflow-backend"} |= "http_request"
```
You should see log lines from the deployed backend.

## Kill switch

To stop OTLP export without redeploying app code:
- Set `OTEL_SDK_DISABLED=true` on the backend service.
- The pino logger detects this at boot and skips the OTLP target. Stdout output is unaffected.
```

- [ ] **Step 2: Commit**

```bash
git add docs/observability.md
git commit -m "docs(observability): Railway + Grafana Cloud runbook for Phase 2 stack"
```

---

## Task 10: Open the PR

**Files:** none modified

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "Logging Phase 2: OTLP log export + self-hosted Loki/collector" --body "$(cat <<'EOF'
## Summary

Phase 2 of the logging standardization. Spec: `docs/superpowers/specs/2026-05-25-logging-standardization-design.md`. Plan: `docs/superpowers/plans/2026-05-26-logging-phase-2.md`.

- Pino multi-target transport: dev gets pretty-printed stdout, prod gets JSON stdout + OTLP export to the collector. Both via worker threads — main event loop is never blocked.
- `pino-opentelemetry-transport` ships its own `LoggerProvider`; no `NodeSDK` registration needed yet (Phase 3 will add it for traces).
- New `infra/otel-collector/` service: OTLP HTTP/gRPC receiver → Loki exporter, with redaction processor.
- New `infra/loki/` service: single-binary Loki on filesystem storage, 30-day retention, designed for a Railway volume.
- `infra/docker-compose.yml` for local stack verification.
- `docs/observability.md` runbook for Connor's Railway + Grafana Cloud setup.
- `backend/.env.example` documents the new env vars.
- New unit test covers logger construction across `OTEL_EXPORTER_OTLP_ENDPOINT` permutations.

The `trace_id`/`span_id` fields injected by the pino mixin remain undefined in Phase 2 — Phase 3 adds the `NodeSDK` with HTTP/Sequelize/Undici instrumentations and a Tempo sink.

## Test plan

- [x] Backend typecheck clean
- [x] Backend tests green (1083+ pass)
- [x] Logger constructs across env permutations (new test)
- [x] Local docker-compose stack boots cleanly (`docker compose up -d` then `curl http://localhost:3100/ready`)
- [x] End-to-end: dev server → OTLP → collector → Loki, verified via `/loki/api/v1/query_range`
- [ ] **Manual** (Connor): deploy `loki` and `otel-collector` Railway services per `docs/observability.md`
- [ ] **Manual** (Connor): set `OTEL_EXPORTER_OTLP_ENDPOINT` on `cashflow-backend` Railway service
- [ ] **Manual** (Connor): wire Grafana Cloud Loki datasource, verify log lines appear
EOF
)"
```

- [ ] **Step 3: Capture PR URL and arm auto-merge per project preference**

```bash
gh pr view --json url -q .url
gh pr merge --auto --merge
```

## Report (final task)

- **Status:** DONE
- PR URL
- Final HEAD SHA
- `git log --oneline` for the Phase 2 commits

---

## Self-review checklist

- [ ] Every Phase 2 requirement in the spec (`infra/otel-collector`, `infra/loki`, `backend/src/observability/otel.ts` *OR* the equivalent in the logger, OTLP transport, env vars, Railway deploy steps) has a corresponding task.
- [ ] No placeholders.
- [ ] Type names and config keys consistent across tasks.
- [ ] Tests use the established `yarn tsx --import ./test/setup.ts --test ...` pattern.
- [ ] Commits are small and topical.

## Open questions

- `pino-opentelemetry-transport` version: at time of writing, latest stable is `1.x`. If `yarn add` resolves to a newer major with breaking config changes, adjust the options block in Task 2.
- The plan assumes the backend writes to fd 1 (stdout) in production via `pino/file` target. If Railway's runtime intercepts stdout differently, fall back to the default pino destination (`process.stdout`) without a transport for the stdout target, then add OTLP as the secondary transport via `pino.multistream`. Re-evaluate during Task 8 smoke test.

## Out of scope (Phase 3+)

- `NodeSDK` with HTTP/Express/Sequelize/Undici instrumentations → Phase 3.
- Tempo trace sink → Phase 3.
- Browser OTel SDK + delete `/api/client-logs` → Phase 4.
- Alerting rules in Grafana → later.
