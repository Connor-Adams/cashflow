# Logging standardization — pino + OpenTelemetry + self-hosted Loki/Tempo

**Date:** 2026-05-25
**Status:** Design approved, pending implementation plan
**Author:** Connor (with Claude)

## Problem

The cashflow backend uses a hand-rolled JSON logger at `backend/src/observability/logger.ts`. It works, but:

1. **Inconsistent callsites.** 50 callsites go through the logger; 27 direct `console.*` calls bypass it entirely — concentrated in FX modules (`bankOfCanada.ts`, `backfillUsdCadHistory.ts`), Sequelize hooks (`Rule`, `BudgetTarget`, `Transaction`'s `ensureCategory`), the enrichment pipeline (`enrich.ts`, `aiBatchStage.ts`), and import scripts. These bypasses lose correlation IDs (`requestId`, `userId`, `householdId`) and event-name discipline.
2. **Missing context.** Even logger callsites only get correlation fields when the caller threads `req` through. Background jobs, model hooks, and async chains drop context silently.
3. **Hard to debug prod.** Logs go to stdout only — Railway captures them, but there's no queryable sink, no trace correlation, no filtering by household/route/job. "Why did this user's import fail at 3am?" requires scrolling Railway's log viewer by hand.
4. **No tracing.** Cross-service waterfalls (browser → Express → Sequelize → Yahoo Finance) are invisible.

## Goals

- Single logger API used by every callsite in `backend/src`.
- Every log record carries `service`, `env`, `requestId`, `userId`, `householdId`, `route` (or `jobName`/`tickId`), `trace_id`/`span_id`, and event-specific fields — without callers having to thread context through call stacks.
- Logs and traces land in a queryable store (Loki + Tempo) with trace ↔ log correlation in Grafana.
- Backend instrumented for HTTP, Sequelize, fetch/Undici, and manual scheduler tick spans. Frontend instrumented for fetch + global errors.
- Phased rollout: each phase ships independent value and can be reverted in isolation.

## Non-goals

- Metrics (Prometheus/Mimir) — separate effort.
- Alerting rules in Grafana — phase 5+, not covered here.
- Session replay, RUM beyond OTel — out of scope.
- Migrating the audit-style `ProviderJobLog` table to Loki — it's a business audit log, not telemetry.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Logger library | **pino** | Fastest JSON logger in Node; ecosystem: `@opentelemetry/instrumentation-pino`, OTLP transports, redaction, serializers. Drop-in replacement for current logger with mechanical callsite rewrites. |
| OTel scope | **Logs + traces** | Trace ID stitching is the killer feature; without it, Loki is just a log viewer. |
| Sink | **Self-hosted Loki + Tempo on Railway** | User wants control and learning. Accepts the ops overhead of 3 extra services with persistent volumes. |
| Context propagation | **AsyncLocalStorage** | Hooks, schedulers, and async chains get context for free. No threading `req` through Sequelize hooks. |
| Frontend | **Browser OTel SDK** | Real end-to-end traces from button click → backend span. Bundle cost (~60–90KB gzip) lazy-loaded post-hydration. |
| Grafana | **Grafana Cloud free tier as viewer** | Datasources point at Railway Loki/Tempo public URLs. No 4th service to run. |

## Architecture

### Backend logger core

`backend/src/observability/logger.ts` (rewrite):

```ts
import pino from 'pino';
import { context as otelContext, trace } from '@opentelemetry/api';
import { als } from './requestContext';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'cashflow-backend', env: process.env.NODE_ENV },
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
    paths: ['*.password', '*.token', 'req.headers.authorization', '*.access_token'],
    remove: true,
  },
  serializers: { err: pino.stdSerializers.err },
  timestamp: pino.stdTimeFunctions.isoTime,
});
```

`pino-pretty` is loaded only in development.

### AsyncLocalStorage context

`backend/src/observability/requestContext.ts` (new):

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogContext = {
  requestId?: string;
  userId?: string;
  householdId?: string;
  role?: string;
  route?: string;
  jobName?: string;
  tickId?: string;
};

export const als = new AsyncLocalStorage<LogContext>();

export const withContext = <T>(ctx: LogContext, fn: () => T): T => {
  const merged = { ...als.getStore(), ...ctx };
  return als.run(merged, fn);
};
```

**Wiring points:**

- HTTP middleware (`requestLogger.ts`): seed `{ requestId, route }`, then auth middleware layers `{ userId, householdId, role }`.
- Schedulers (`yahoo/scheduler.ts`, `dailySnapshotScheduler.ts`, `forwardIncomeScheduler.ts`): each tick wraps in `withContext({ jobName, tickId: uuid() }, ...)`.
- Sequelize hooks: no change needed — ALS flows through async automatically.
- FX modules: inherit from caller's ALS scope; logs from boot scripts get an empty context (no `requestId`, that's fine).
- `/api/client-logs` ingestor: extracts W3C `traceparent` from request, sets OTel context, pino mixin attaches `trace_id`/`span_id`.

### OTel SDK bootstrap

`backend/src/observability/otel.ts` (new), imported at line 1 of `backend/src/server.ts`. The snippet below is the **final state** after Phase 3; Phase 2 ships only the logs exporter (no `spanProcessors`, no Http/Express/Sequelize/Undici instrumentations).

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes as A } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { SequelizeInstrumentation } from 'opentelemetry-instrumentation-sequelize';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://otel-collector:4318';

export const sdk = new NodeSDK({
  resource: new Resource({
    [A.SERVICE_NAME]: 'cashflow-backend',
    [A.SERVICE_VERSION]: process.env.GIT_SHA ?? 'dev',
    [A.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
  }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))],
  logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${endpoint}/v1/logs` }))],
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation({ ignoreLayersType: ['middleware'] }),
    new SequelizeInstrumentation({ ignoreOrphanedSpans: true }),
    new UndiciInstrumentation(),
    new PinoInstrumentation({
      logKeys: { traceId: 'trace_id', spanId: 'span_id', traceFlags: 'trace_flags' },
    }),
  ],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
```

**Manual scheduler spans:**

```ts
import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('cashflow-scheduler');

const tick = () => tracer.startActiveSpan('yahoo_quote.tick', async (span) => {
  try { /* existing body */ } finally { span.end(); }
});
```

Each scheduler wraps its tick in both `tracer.startActiveSpan` and `withContext`.

**Sampling:** Traces start at 100% (`OTEL_TRACES_SAMPLER_ARG=1.0`); drop to 0.1 if Tempo storage grows. Logs are not sampled.

**Yahoo "Invalid options" demoter** (`backend/src/integrations/yahoo/client.ts`): the existing custom wrapper survives, now routing to `logger.warn`/`logger.debug` instead of `console.*`.

### Railway infrastructure

Three new services in the same Railway project, each with its own `Dockerfile` and persistent volume.

**`otel-collector`** (`infra/otel-collector/`):
- Image: `otel/opentelemetry-collector-contrib:0.110.0`
- Receivers: OTLP HTTP `:4318` (CORS for frontend origin), OTLP gRPC `:4317`
- Processors: `memory_limiter`, `attributes/redact` (strip auth headers, cookies), `batch`
- Exporters: `loki` (HTTP push), `otlphttp/tempo`

**`loki`** (`infra/loki/`):
- Image: `grafana/loki:3.2.0`
- Single-binary mode, filesystem storage on Railway volume mounted at `/loki`
- Retention: 720h (30d)
- Volume: 10GB initial

**`tempo`** (`infra/tempo/`):
- Image: `grafana/tempo:2.6.0`
- Local storage on Railway volume at `/tempo`
- Retention: 168h (7d traces)
- Volume: 10GB initial

**`cashflow-backend` env additions:**
```
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.railway.internal:4318
OTEL_SERVICE_NAME=cashflow-backend
GIT_SHA=${RAILWAY_GIT_COMMIT_SHA}
```

**Grafana:** Grafana Cloud free tier, Loki + Tempo datasources pointing at Railway public URLs with basic-auth in front.

**Failure modes:**
- Collector down → pino still writes stdout (Railway captures), traces dropped silently, app keeps running.
- `OTEL_SDK_DISABLED=true` env var as kill switch.

## Schema and conventions

**Log record shape:**
```
ts, level, service, env,
requestId?, userId?, householdId?, role?, route?, jobName?, tickId?,
trace_id?, span_id?,
msg, ...event-specific-fields
```

**Level policy:**

| Level | Meaning | Examples |
|---|---|---|
| `error` | Action required, page-able | Unhandled exception, DB transaction lost, scheduler tick failed |
| `warn` | Degraded but recovered | 4xx response, retry-succeeded, FX cache miss, `ensureCategory` hook fallback |
| `info` | Business event | HTTP request, scheduler tick result, import lifecycle, login |
| `debug` | Gated by `LOG_LEVEL=debug` | Loop bodies, per-symbol decisions, cache hits |

**Event naming:** `snake_case`, noun-first. Examples: `http_request`, `import_started`, `yahoo_quote_tick`, `dividend_reconcile_failed`.

**Redaction:** pino `redact` paths + collector `attributes/redact` processor strip `password`, `token`, `access_token`, `authorization` header, `cookie` header.

## Rollout — four phases, four PRs

### Phase 1 — pino + ALS + console.* purge

Files:
- Rewrite `backend/src/observability/logger.ts`.
- New `backend/src/observability/requestContext.ts`.
- Update `backend/src/observability/requestLogger.ts` to wrap in `withContext`.
- Update `backend/src/app.ts` so auth middleware layers `userId`/`householdId`/`role`.
- Flip arg order on all 14 existing logger callers: `logger.info('event', { fields })` → `logger.info({ fields }, 'event')`.
- Replace all 27 direct `console.*` callsites with `logger.{level}`:
  - `backend/src/fx/bankOfCanada.ts` (7)
  - `backend/src/fx/backfillUsdCadHistory.ts` (4)
  - `backend/src/models/Rule.ts`, `BudgetTarget.ts`, `Transaction.ts` (`ensureCategory` warns)
  - `backend/src/networth/accountKind.ts`
  - `backend/src/import/enrich.ts`, `runImport.ts`, `runEnrichmentBackfill.ts`, `enrichment/aiBatchStage.ts`
  - `backend/src/routes/capture.ts`, `portfolio.ts`
- Update `backend/src/integrations/yahoo/client.ts` wrapper to route to `logger.warn`/`logger.debug`.
- Wrap each scheduler tick in `withContext({ jobName, tickId }, ...)`.
- Switch `backend/test/accountKind.test.ts` from `console.warn` spy to a pino transport spy.
- Add `pino` and `pino-pretty` to `backend/package.json`.

Verification: existing test suite green; one new unit test asserts ALS-supplied fields appear in pino output.

### Phase 2 — Loki + collector + OTLP logs

Files:
- New `infra/otel-collector/{Dockerfile,config.yaml}`.
- New `infra/loki/{Dockerfile,config.yaml}`.
- New `backend/src/observability/otel.ts` (logs exporter only, no instrumentations yet).
- `backend/src/server.ts` line 1: `import './observability/otel'`.
- `backend/src/observability/logger.ts`: add OTLP transport via `pino-opentelemetry-transport` or `pino.multistream` so stdout capture stays intact.
- Add OTel packages to `backend/package.json`.
- Railway: deploy `otel-collector` and `loki` services, add env vars to `cashflow-backend`.

Verification: logs visible in Loki via Grafana Cloud datasource. Existing stdout logs unchanged.

### Phase 3 — Backend traces

Files:
- New `infra/tempo/{Dockerfile,config.yaml}`.
- Update `backend/src/observability/otel.ts` to add trace exporter + Http/Express/Sequelize/Undici instrumentations.
- Wrap scheduler ticks in `tracer.startActiveSpan(...)` alongside `withContext`.
- Optional: manual span per Yahoo quote fetch (skip if Undici instrumentation catches it cleanly).

Verification: trace for `GET /api/transactions` shows Express + Sequelize spans in Tempo; matching log lines share `trace_id`.

### Phase 4 — Browser OTel

Files:
- Add `@opentelemetry/sdk-trace-web`, `@opentelemetry/instrumentation-fetch`, `@opentelemetry/api-logs`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-logs-otlp-http` to `frontend/package.json`.
- New `frontend/src/observability/otel.ts`, dynamically imported from `main.tsx` via `requestIdleCallback` to defer bundle cost.
- Rewrite `frontend/src/lib/clientLogger.ts` to push records via OTLP logs exporter; drop POST-to-`/api/client-logs` path.
- Update `frontend/src/lib/api.ts`: fetch instrumentation auto-attaches `traceparent`; remove manual `requestId` attach.
- Delete `backend/src/routes/clientLogs.ts` and its rate limiter.
- Update `frontend/src/components/ErrorBoundary.tsx` to use OTel logs API.
- Vite config: build-time substitution for OTLP endpoint URL.
- `otel-collector` config: add frontend origin to CORS allowlist.

Verification: button click → frontend span → backend HTTP span → log line; all share `trace_id`. Bundle size delta < 100KB gzip. Lighthouse cold-load score unchanged.

## Open questions

- Should `pino-opentelemetry-transport` (which uses worker thread) or `pino.multistream` to a custom OTLP writer be used in phase 2? Worker thread is the official pattern but adds a dependency; multistream is simpler but blocks the event loop briefly during batch flushes. Decide during phase 2 implementation.
- Tempo retention 7d is a guess. Revisit after one week of real traffic.
- `attributes/redact` processor list may grow as we find more sensitive headers in production traffic. Treat as living config.

## Out of scope

- Metrics pipeline (Prometheus/Mimir).
- Alerting rules.
- Frontend session replay.
- Mobile app (none exists).
- Migrating `ProviderJobLog` to Loki (business audit, not telemetry).
