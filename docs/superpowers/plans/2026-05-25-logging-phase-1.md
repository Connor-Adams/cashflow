# Logging Standardization Phase 1 — pino + ALS + console.* purge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled JSON logger with `pino`, propagate request/user/job context automatically via `AsyncLocalStorage`, and route every `console.*` callsite in `backend/src/` through the new logger.

**Architecture:** New `backend/src/observability/requestContext.ts` exposes an `AsyncLocalStorage<LogContext>` and a `withContext(ctx, fn)` helper. `backend/src/observability/logger.ts` is rewritten as a pino instance whose `mixin` reads the ALS store and the active OTel span context. The HTTP middleware (`requestLogger.ts`) seeds the ALS with `requestId`/`route`; auth middleware layers `userId`/`householdId`/`role`. Schedulers wrap their tick bodies in `withContext({ jobName, tickId })`. Sequelize hooks inherit ALS through async automatically. All 15 logger callers get their argument order flipped from `logger.info(event, fields)` to pino's `logger.info(fields, event)`. All ~25 direct `console.*` callsites in `backend/src/` (FX, Sequelize hooks, enrichment, import, capture, portfolio, server boot) are replaced with `logger.{level}`. The Yahoo Finance demoting wrapper (`integrations/yahoo/client.ts`) keeps its noise-suppression semantics but routes through `logger` instead of `console.*`. No OTel SDK is registered yet — the trace_id/span_id fields are no-ops in Phase 1 because `@opentelemetry/api` returns no active span without a registered tracer provider. Phase 2 wires the SDK.

**Tech Stack:** TypeScript, Node 20+ (built-in `node:async_hooks`), pino 9.x, `@opentelemetry/api` 1.x, Express 4.x, Sequelize 6.x, node-cron, Vitest/node:test for tests.

---

## File Structure

**New files:**
- `backend/src/observability/requestContext.ts` — `AsyncLocalStorage` instance, `LogContext` type, `withContext(ctx, fn)` helper.
- `backend/test/requestContext.test.ts` — unit tests for `withContext` (merging, nesting, async propagation).
- `backend/test/logger.test.ts` — unit tests for pino logger output shape and ALS field injection.

**Rewritten:**
- `backend/src/observability/logger.ts` — pino-based logger with `mixin` reading ALS + OTel context.

**Modified (mechanical arg-order flip + new patterns):**
- `backend/src/observability/requestLogger.ts` — wrap downstream in `withContext`; flip log call.
- `backend/src/app.ts` — auth-success step layers ALS with `userId`/`householdId`/`role`.
- 15 existing `logger.*` callers (see Task 9–11 for the file list and exact diffs).

**Modified (console.* → logger):**
- 13 files containing ~25 direct `console.*` calls (see Tasks 12–17).

**Modified (schedulers wrap tick in withContext):**
- `backend/src/integrations/yahoo/scheduler.ts`
- `backend/src/portfolio/dailySnapshotScheduler.ts`
- `backend/src/portfolio/forwardIncomeScheduler.ts`

**Test changes:**
- `backend/test/accountKind.test.ts` — switch from `console.warn` spy to pino-spy fixture.

**Tooling:**
- `backend/package.json` — add `pino`, `pino-pretty`, `@opentelemetry/api`.
- `backend/eslint.config.*` (or equivalent) — add `no-console` rule scoped to `src/**`.

---

## Task 1: Install dependencies

**Files:**
- Modify: `backend/package.json`
- Modify: `yarn.lock`

- [ ] **Step 1: Add packages**

Run:
```bash
yarn workspace cashflow-backend add pino @opentelemetry/api
yarn workspace cashflow-backend add -D pino-pretty
```

Expected: lockfile updated, `backend/package.json` has `pino` and `@opentelemetry/api` under `dependencies`, `pino-pretty` under `devDependencies`.

- [ ] **Step 2: Verify versions resolve to current majors**

Run: `yarn workspace cashflow-backend why pino @opentelemetry/api pino-pretty`
Expected: `pino@^9`, `@opentelemetry/api@^1`, `pino-pretty@^11` or newer.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json yarn.lock
git commit -m "chore(backend): add pino, @opentelemetry/api, pino-pretty"
```

---

## Task 2: Create `requestContext.ts` with `AsyncLocalStorage`

**Files:**
- Create: `backend/src/observability/requestContext.ts`

- [ ] **Step 1: Write the module**

```ts
// backend/src/observability/requestContext.ts
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

/**
 * Run `fn` with the merged log context active. Any existing fields from a
 * surrounding `withContext` call are preserved; new fields override on key
 * collision. Reads via `als.getStore()` inside `fn` (or anywhere on its
 * async continuation) see the merged store.
 */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...als.getStore(), ...ctx };
  return als.run(merged, fn);
}

/** Read the current context (or `undefined` if no `withContext` is active). */
export function currentContext(): LogContext | undefined {
  return als.getStore();
}
```

- [ ] **Step 2: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/observability/requestContext.ts
git commit -m "feat(observability): add AsyncLocalStorage-based request context"
```

---

## Task 3: Write `requestContext` unit tests

**Files:**
- Create: `backend/test/requestContext.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// backend/test/requestContext.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { withContext, currentContext } from '../src/observability/requestContext';

test('withContext exposes its ctx via currentContext inside fn', () => {
  withContext({ requestId: 'r1', userId: 'u1' }, () => {
    assert.deepEqual(currentContext(), { requestId: 'r1', userId: 'u1' });
  });
});

test('nested withContext merges, inner overrides on key collision', () => {
  withContext({ requestId: 'outer', userId: 'u1' }, () => {
    withContext({ requestId: 'inner', householdId: 'h1' }, () => {
      assert.deepEqual(currentContext(), {
        requestId: 'inner',
        userId: 'u1',
        householdId: 'h1',
      });
    });
    // After inner returns, the outer ctx is restored.
    assert.deepEqual(currentContext(), { requestId: 'outer', userId: 'u1' });
  });
});

test('currentContext is undefined outside any withContext', () => {
  assert.equal(currentContext(), undefined);
});

test('ctx propagates across awaits (async continuation)', async () => {
  await withContext({ requestId: 'r1' }, async () => {
    await sleep(1);
    assert.deepEqual(currentContext(), { requestId: 'r1' });
  });
});
```

- [ ] **Step 2: Run tests, confirm they pass**

Run: `yarn workspace cashflow-backend run test --grep requestContext`

If the workspace uses `node --test`, run instead:
```bash
yarn workspace cashflow-backend exec -- node --test test/requestContext.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/test/requestContext.test.ts
git commit -m "test(observability): cover withContext merge/nest/async semantics"
```

---

## Task 4: Rewrite `logger.ts` as a pino instance with ALS + OTel mixin

**Files:**
- Modify: `backend/src/observability/logger.ts` (full rewrite)

- [ ] **Step 1: Replace the file contents**

```ts
// backend/src/observability/logger.ts
import pino, { type LoggerOptions } from 'pino';
import { context as otelContext, trace } from '@opentelemetry/api';
import { als } from './requestContext';

const isProd = process.env.NODE_ENV === 'production';
const isDev = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'cashflow-backend',
    env: process.env.NODE_ENV ?? 'development',
  },
  formatters: {
    // Emit `level: "info"` instead of pino's numeric default — matches OTel
    // `severity_text` convention and Loki's expectations.
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
  // Strip pino's `pid` and `hostname` from `base` — they aren't useful here
  // and just bloat every record.
};

const prettyTransport: LoggerOptions['transport'] | undefined = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
      },
    }
  : undefined;

export const logger = pino({
  ...baseOptions,
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});

// Backwards-compatible type aliases so call sites that still import these
// don't break during the migration window. Remove in a follow-up once all
// callers use pino's call shape directly.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

// Stamp `isProd` into the file so the prod-only branches are tree-shaken.
void isProd;
```

- [ ] **Step 2: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS. (Existing callers won't typecheck yet because of the arg-order flip — that's expected. They'll be fixed in Tasks 9–11. If typecheck fails on _other_ grounds, fix before continuing.)

If many caller-site errors flood the output, that's expected. Move on; this task is complete when the logger module itself compiles.

- [ ] **Step 3: Commit**

```bash
git add backend/src/observability/logger.ts
git commit -m "feat(observability): replace custom logger with pino + ALS/OTel mixin"
```

---

## Task 5: Write logger unit tests

**Files:**
- Create: `backend/test/logger.test.ts`

- [ ] **Step 1: Write tests using a pino destination stream**

```ts
// backend/test/logger.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { als } from '../src/observability/requestContext';

// Build a fresh logger pointed at an in-memory sink so we can assert on the
// exact JSON written. We rebuild here (rather than importing the singleton)
// because the singleton's transport is platform-dependent and harder to spy
// on in tests.
function buildTestLogger(sink: { lines: string[] }) {
  return pino(
    {
      level: 'debug',
      base: { service: 'cashflow-backend', env: 'test' },
      formatters: { level: (label) => ({ level: label }) },
      mixin() {
        const ctx = als.getStore() ?? {};
        return { ...ctx };
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    {
      write(chunk: string) {
        sink.lines.push(chunk);
      },
    },
  );
}

test('logger emits structured JSON with service + level', () => {
  const sink = { lines: [] as string[] };
  const log = buildTestLogger(sink);
  log.info({ foo: 'bar' }, 'event_name');
  assert.equal(sink.lines.length, 1);
  const entry = JSON.parse(sink.lines[0]);
  assert.equal(entry.level, 'info');
  assert.equal(entry.service, 'cashflow-backend');
  assert.equal(entry.msg, 'event_name');
  assert.equal(entry.foo, 'bar');
});

test('mixin injects ALS fields automatically', () => {
  const sink = { lines: [] as string[] };
  const log = buildTestLogger(sink);
  als.run({ requestId: 'rid-1', userId: 'u-1' }, () => {
    log.info('inside_context');
  });
  const entry = JSON.parse(sink.lines[0]);
  assert.equal(entry.requestId, 'rid-1');
  assert.equal(entry.userId, 'u-1');
});

test('outside ALS, no requestId field appears', () => {
  const sink = { lines: [] as string[] };
  const log = buildTestLogger(sink);
  log.info('no_context');
  const entry = JSON.parse(sink.lines[0]);
  assert.equal('requestId' in entry, false);
});

test('err serializer flattens Error to { message, stack, type }', () => {
  const sink = { lines: [] as string[] };
  const log = pino(
    {
      level: 'debug',
      serializers: { err: pino.stdSerializers.err },
    },
    { write(c: string) { sink.lines.push(c); } },
  );
  log.error({ err: new Error('boom') }, 'thing_failed');
  const entry = JSON.parse(sink.lines[0]);
  assert.equal(entry.err.message, 'boom');
  assert.equal(entry.err.type, 'Error');
  assert.equal(typeof entry.err.stack, 'string');
});
```

- [ ] **Step 2: Run tests**

Run: `yarn workspace cashflow-backend exec -- node --test test/logger.test.ts`
Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/test/logger.test.ts
git commit -m "test(observability): cover pino output shape and ALS mixin"
```

---

## Task 6: Update `requestLogger.ts` middleware to use `withContext` and pino call shape

**Files:**
- Modify: `backend/src/observability/requestLogger.ts`

- [ ] **Step 1: Replace the middleware**

```ts
// backend/src/observability/requestLogger.ts
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger';
import { withContext } from './requestContext';

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = headerValue(req, 'x-request-id') || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const statusCode = res.statusCode;
    const level: 'info' | 'warn' | 'error' =
      statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      {
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode,
        durationMs: Math.round(durationMs),
        // requestId, userId, householdId, role are auto-attached via ALS mixin
      },
      'http_request',
    );
  });

  withContext(
    {
      requestId,
      route: req.route?.path,
    },
    () => next(),
  );
}
```

**Note:** `req.route` is undefined until Express has matched a route — for top-level middleware ordering this means `route` will be undefined on the first pass. Auth middleware (Task 7) layers on `userId`/`householdId`/`role` later. The `route` field will populate naturally on subsequent middleware tiers once routing has resolved; if you want it sooner, add a per-route middleware that re-`withContext`s. Leave that for Phase 3 unless a callsite needs it now.

- [ ] **Step 2: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: requestLogger.ts compiles; other files still error from the arg-order flip until Task 9+.

- [ ] **Step 3: Commit**

```bash
git add backend/src/observability/requestLogger.ts
git commit -m "feat(observability): wrap requests in ALS and emit via pino"
```

---

## Task 7: Layer `userId`/`householdId`/`role` onto ALS after auth

**Files:**
- Modify: `backend/src/app.ts`

- [ ] **Step 1: Locate the auth middleware**

Read `backend/src/app.ts`. Find the middleware where `req.auth = { user, household, role }` is assigned (or where the auth context is loaded onto the request — search for `req.auth`).

- [ ] **Step 2: After the auth assignment, layer ALS**

In the same middleware (after `req.auth` is set), call `withContext` to enrich the active store:

```ts
import { withContext } from './observability/requestContext';

// inside the auth middleware, after req.auth is assigned:
withContext(
  {
    userId: req.auth.user.id,
    householdId: req.auth.household.id,
    role: req.auth.role,
  },
  () => next(),
);
```

If the existing middleware ends with a bare `next()`, replace that call with the `withContext(..., () => next())` wrapper. Do not rename or refactor the surrounding middleware.

- [ ] **Step 3: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: app.ts compiles for this change; remaining logger arg-order errors persist.

- [ ] **Step 4: Commit**

```bash
git add backend/src/app.ts
git commit -m "feat(observability): layer user/household/role onto ALS after auth"
```

---

## Task 8: Integration test — ALS context flows from middleware to logger output

**Files:**
- Create: `backend/test/loggerIntegration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/loggerIntegration.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pino from 'pino';
import { als } from '../src/observability/requestContext';
import { withContext } from '../src/observability/requestContext';

test('ALS context set in middleware appears in pino log written from a handler', async () => {
  const lines: string[] = [];
  const log = pino(
    {
      level: 'debug',
      mixin() { return { ...als.getStore() }; },
    },
    { write(c: string) { lines.push(c); } },
  );

  const app = express();
  app.use((req, _res, next) => {
    withContext({ requestId: 'integration-rid', userId: 'u-int' }, () => next());
  });
  app.get('/x', (_req, res) => {
    log.info({ where: 'handler' }, 'handler_log');
    res.json({ ok: true });
  });

  // Drive a synthetic request through Express.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const res = await fetch(`http://127.0.0.1:${addr.port}/x`);
        await res.json();
        server.close();
        resolve();
      } catch (e) { reject(e); }
    });
  });

  const handlerLine = lines.find((l) => l.includes('handler_log'));
  assert.ok(handlerLine, 'handler log was not captured');
  const entry = JSON.parse(handlerLine);
  assert.equal(entry.requestId, 'integration-rid');
  assert.equal(entry.userId, 'u-int');
  assert.equal(entry.where, 'handler');
});
```

- [ ] **Step 2: Run the test**

Run: `yarn workspace cashflow-backend exec -- node --test test/loggerIntegration.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/test/loggerIntegration.test.ts
git commit -m "test(observability): ALS context reaches logger across middleware boundary"
```

---

## Task 9: Migrate logger callers — schedulers + server boot

**Files:**
- Modify: `backend/src/server.ts`
- Modify: `backend/src/integrations/yahoo/scheduler.ts`
- Modify: `backend/src/portfolio/dailySnapshotScheduler.ts`
- Modify: `backend/src/portfolio/forwardIncomeScheduler.ts`

Pino call shape: `logger.info({ ...fields }, 'event')`. For errors with an Error object: `logger.error({ err, ...fields }, 'event')`.

- [ ] **Step 1: `backend/src/server.ts`**

Replace each `logger.<level>('event_name', { fields })` with `logger.<level>({ fields }, 'event_name')`. The `server_started` call (around line 21–26) becomes:

```ts
logger.info({ port, env: process.env.NODE_ENV }, 'server_started');
```

Replace the `console.error('[boot] USD/CAD backfill failed (non-fatal):', err)` at line ~38 with:

```ts
logger.warn({ err }, 'boot_usd_cad_backfill_failed');
```

- [ ] **Step 2: `backend/src/integrations/yahoo/scheduler.ts`**

Flip arg order for all `logger.*` calls. Replace the existing block (line 265–298 area):

```ts
export function startQuoteScheduler(): ScheduledTask | null {
  if (!env.quoteSchedulerEnabled) {
    logger.info({ reason: 'flag_off' }, 'quote_scheduler_disabled');
    return null;
  }
  if (activeTask) {
    logger.warn({}, 'quote_scheduler_already_running');
    return activeTask;
  }
  if (!cron.validate(env.quoteTickCron)) {
    logger.error({ expression: env.quoteTickCron }, 'quote_scheduler_invalid_cron');
    return null;
  }

  activeTask = cron.schedule(env.quoteTickCron, async () => {
    if (runningTick) {
      logger.debug({}, 'quote_scheduler_tick_skipped_reentrant');
      return;
    }
    runningTick = true;
    try {
      const result = await runQuoteSchedulerTick();
      logger.info(result as unknown as Record<string, unknown>, 'quote_scheduler_tick');
    } catch (err) {
      logger.error({ err }, 'quote_scheduler_tick_unhandled');
    } finally {
      runningTick = false;
    }
  });

  logger.info(
    { cron: env.quoteTickCron, minAgeHours: env.quoteMinAgeHours },
    'quote_scheduler_started',
  );
  return activeTask;
}
```

- [ ] **Step 3: `backend/src/portfolio/dailySnapshotScheduler.ts`**

Apply the same mechanical flip: `(event, fields)` → `(fields, event)`. For the error-with-Error pattern (`logger.error('x', {}, err)`), convert to `logger.error({ err }, 'x')`.

- [ ] **Step 4: `backend/src/portfolio/forwardIncomeScheduler.ts`**

Same as above.

- [ ] **Step 5: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: these four files compile. Errors remain in other logger callers.

- [ ] **Step 6: Commit**

```bash
git add backend/src/server.ts backend/src/integrations/yahoo/scheduler.ts backend/src/portfolio/dailySnapshotScheduler.ts backend/src/portfolio/forwardIncomeScheduler.ts
git commit -m "refactor(observability): flip logger arg order in schedulers + server boot"
```

---

## Task 10: Migrate logger callers — routes

**Files:**
- Modify: `backend/src/routes/import.ts`
- Modify: `backend/src/routes/transactions.ts`
- Modify: `backend/src/routes/emailIntegrations.ts`
- Modify: `backend/src/routes/externalOrders.ts`
- Modify: `backend/src/routes/clientLogs.ts`

For each file, flip `logger.<level>('event', { fields })` → `logger.<level>({ fields }, 'event')`. For error-with-Error: `logger.error('event', {}, err)` → `logger.error({ err }, 'event')`. For dynamic event names (`'import_' + event`), keep the concat in the message position:

```ts
// before:
logger.info('import_' + event, details);
// after:
logger.info(details, `import_${event}`);
```

In `clientLogs.ts`, the ingestion logs at line 55–64 take a validated `fields` map. Pass the validated fields object as the first arg, the `clientEvent` string as the second:

```ts
// inside the validated handler:
const level = mapLevel(clientLevel); // existing helper or inline
logger[level]({ ...validated, requestId, source: 'client' }, clientEvent);
```

- [ ] **Step 1: Apply the flip in each file**

Edit each route file. Run `grep -n "logger\." backend/src/routes/<file>.ts` first to enumerate every call; flip each one.

- [ ] **Step 2: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: route files compile.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/import.ts backend/src/routes/transactions.ts backend/src/routes/emailIntegrations.ts backend/src/routes/externalOrders.ts backend/src/routes/clientLogs.ts
git commit -m "refactor(observability): flip logger arg order in routes"
```

---

## Task 11: Migrate logger callers — remaining backend modules

**Files:**
- Modify: `backend/src/app.ts` (error handler around line 130–148)
- Modify: `backend/src/integrations/scanReceipts.ts`
- Modify: `backend/src/portfolio/reconcileDividends.ts`
- Modify: `backend/src/portfolio/backfill.ts`
- Modify: `backend/src/demo/seedDemoData.ts`
- Modify: `backend/src/import/splitTxnByItems.ts`

- [ ] **Step 1: Flip arg order in each file**

Same pattern as Tasks 9–10. For each file, run `grep -n "logger\." backend/src/<file>` and convert every call.

`app.ts` error handler example: `logger.error('request_failed', { ...fields }, err)` → `logger.error({ ...fields, err }, 'request_failed')`. Use the same pattern for the warn branch.

- [ ] **Step 2: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS. **At this point all 15 logger callers should compile.** If typecheck still reports logger-related errors, list them and fix before continuing.

- [ ] **Step 3: Run the full test suite**

Run: `yarn workspace cashflow-backend run test`
Expected: PASS (except `accountKind.test.ts` which still spies on `console.warn` — fixed in Task 19). If other tests break, investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add backend/src/app.ts backend/src/integrations/scanReceipts.ts backend/src/portfolio/reconcileDividends.ts backend/src/portfolio/backfill.ts backend/src/demo/seedDemoData.ts backend/src/import/splitTxnByItems.ts
git commit -m "refactor(observability): flip logger arg order in remaining modules"
```

---

## Task 12: Replace `console.*` in FX modules

**Files:**
- Modify: `backend/src/fx/bankOfCanada.ts`
- Modify: `backend/src/fx/backfillUsdCadHistory.ts`

- [ ] **Step 1: `bankOfCanada.ts` — replace all 7 `console.*` calls**

Add at the top:

```ts
import { logger } from '../observability/logger';
```

Replace each callsite (mapping the existing `[bankOfCanada]` prefix into a `module` field):

- Line 66 `console.error(...)`:
  ```ts
  logger.error({ from, to, module: 'bankOfCanada' }, 'fx_unsupported_pair');
  ```
- Line 78 `console.error(...)` (HTTP error):
  ```ts
  logger.error({ status: response.status, url, module: 'bankOfCanada' }, 'fx_http_error');
  ```
- Line 83 `console.error('[bankOfCanada] fetch error', err)`:
  ```ts
  logger.error({ err, url, module: 'bankOfCanada' }, 'fx_fetch_failed');
  ```
- Line 89 `console.error(...)` (no observations):
  ```ts
  logger.error({ series, start, asOfDate, module: 'bankOfCanada' }, 'fx_no_observations');
  ```
- Line 97 `console.error('[bankOfCanada] Unexpected observation shape', last)`:
  ```ts
  logger.error({ observation: last, module: 'bankOfCanada' }, 'fx_bad_observation_shape');
  ```
- Line 103 `console.error('[bankOfCanada] Non-numeric rate value', seriesValue.v)`:
  ```ts
  logger.error({ value: seriesValue.v, module: 'bankOfCanada' }, 'fx_non_numeric_rate');
  ```
- Line 155 `console.warn('[bankOfCanada] Failed to cache FxRate row', err)`:
  ```ts
  logger.warn({ err, module: 'bankOfCanada' }, 'fx_cache_persist_failed');
  ```

- [ ] **Step 2: `backfillUsdCadHistory.ts` — replace all 3 `console.*` calls**

Add the logger import. Then:

- Line 29 `console.error(...)` (HTTP error):
  ```ts
  logger.error({ status: response.status, url, module: 'backfillUsdCadHistory' }, 'fx_backfill_http_error');
  ```
- Line 34 `console.error('[backfillUsdCadHistory] fetch error', err)`:
  ```ts
  logger.error({ err, url, module: 'backfillUsdCadHistory' }, 'fx_backfill_fetch_failed');
  ```
- Line 93–96 `console.log` (insertion summary). Replace with:
  ```ts
  logger.info(
    { count: rowsToCreate.length, startDate: opts.startDate, endDate: opts.endDate, module: 'backfillUsdCadHistory' },
    'fx_backfill_rows_inserted',
  );
  ```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/fx/bankOfCanada.ts backend/src/fx/backfillUsdCadHistory.ts
git commit -m "refactor(fx): route console.* through pino logger"
```

---

## Task 13: Replace `console.warn` in Sequelize `ensureCategory` hooks

**Files:**
- Modify: `backend/src/models/Rule.ts`
- Modify: `backend/src/models/BudgetTarget.ts`
- Modify: `backend/src/models/Transaction.ts`

The three files share the same `console.warn('[ensureCategory] <Model> hook failed', e)` pattern.

- [ ] **Step 1: For each file, add the import and replace the warn**

Top of file:
```ts
import { logger } from '../observability/logger';
```

Replace the `console.warn`:

```ts
// Rule.ts:111
logger.warn({ err: e, model: 'Rule' }, 'ensure_category_hook_failed');

// BudgetTarget.ts:73
logger.warn({ err: e, model: 'BudgetTarget' }, 'ensure_category_hook_failed');

// Transaction.ts:319
logger.warn({ err: e, model: 'Transaction' }, 'ensure_category_hook_failed');
```

- [ ] **Step 2: Typecheck + tests**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run test`
Expected: PASS (still excluding accountKind.test.ts).

- [ ] **Step 3: Commit**

```bash
git add backend/src/models/Rule.ts backend/src/models/BudgetTarget.ts backend/src/models/Transaction.ts
git commit -m "refactor(models): route ensureCategory hook warnings through logger"
```

---

## Task 14: Replace `console.warn` in `networth/accountKind.ts`

**Files:**
- Modify: `backend/src/networth/accountKind.ts`

- [ ] **Step 1: Replace the warn**

Add at the top:
```ts
import { logger } from '../observability/logger';
```

Replace line 9:
```ts
// before
console.warn(`[networth] unknown accountType: ${accountType} — defaulting to asset`);
// after
logger.warn({ accountType, module: 'networth' }, 'unknown_account_type_default_asset');
```

- [ ] **Step 2: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/networth/accountKind.ts
git commit -m "refactor(networth): route unknown-accountType warning through logger"
```

---

## Task 15: Replace `console.*` in enrichment + import pipeline

**Files:**
- Modify: `backend/src/import/enrich.ts`
- Modify: `backend/src/import/runImport.ts`
- Modify: `backend/src/import/runEnrichmentBackfill.ts`
- Modify: `backend/src/import/enrichment/aiBatchStage.ts`

- [ ] **Step 1: `enrich.ts:45` — stage failure**

Add the logger import. Replace:

```ts
// before
console.error(`[enrichment] stage "${name}" threw — continuing with no signals`, err);
// after
logger.error({ err, stage: name, module: 'enrichment' }, 'enrichment_stage_failed');
```

- [ ] **Step 2: `runImport.ts:671` — ai-batch post-update failure**

Add the logger import. Replace:

```ts
// before
console.warn(`[enrichment] ai-batch post-update failed for txn ${c.txnId}`, err instanceof Error ? err.message : err);
// after
logger.warn({ err, txnId: c.txnId, module: 'enrichment' }, 'enrichment_ai_batch_post_update_failed');
```

- [ ] **Step 3: `runEnrichmentBackfill.ts` — 4 calls**

Add the logger import. Replace each:

- Line 118 `console.log('[backfill] ${total} transactions match filter')`:
  ```ts
  logger.info({ total, module: 'enrichment_backfill' }, 'backfill_started');
  ```
- Line 201–205 `console.log` (verbose per-txn). Replace with:
  ```ts
  logger.debug(
    {
      txnId: txn.id,
      date: txn.date,
      merchantRaw: txn.merchantRaw,
      merchantClean: f.merchantClean,
      merchantCanonical: f.merchantCanonical ?? null,
      txnType: f.txnType,
      autoSource: f.autoSource ?? null,
      autoConfidence: f.autoConfidence ?? null,
      signalsCount: enriched.signals.length,
      willClearReview,
      module: 'enrichment_backfill',
    },
    'backfill_txn_enriched',
  );
  ```
  Note: this drops from `console.log` to `logger.debug` because it is gated by the existing `flags.verbose` check — keeping the `if (flags.verbose)` wrapping `if` block so the log only emits when the operator asked for it.
- Line 288 `console.error('[backfill] txn ${txn.id} failed:', err)`. Replace with:
  ```ts
  logger.error({ err, txnId: txn.id, module: 'enrichment_backfill' }, 'backfill_txn_failed');
  ```
- Line 295–299 `console.log` (progress every 100 rows or final). Replace with:
  ```ts
  logger.info(
    {
      processed,
      total,
      updated,
      reviewFlagCleared,
      skipped,
      dryRun: flags.dryRun,
      module: 'enrichment_backfill',
    },
    'backfill_progress',
  );
  ```

- [ ] **Step 4: `aiBatchStage.ts:287` — fallback warning**

Add the logger import. Replace:

```ts
// before
console.warn('[enrichment] ai-batch failed, falling back to per-row', toError(err).message);
// after
logger.warn({ err, module: 'enrichment_ai_batch' }, 'ai_batch_failed_fallback_per_row');
```

- [ ] **Step 5: Typecheck + tests**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/enrich.ts backend/src/import/runImport.ts backend/src/import/runEnrichmentBackfill.ts backend/src/import/enrichment/aiBatchStage.ts
git commit -m "refactor(import): route enrichment pipeline console.* through logger"
```

---

## Task 16: Replace `console.*` in routes (capture + portfolio)

**Files:**
- Modify: `backend/src/routes/capture.ts`
- Modify: `backend/src/routes/portfolio.ts`

- [ ] **Step 1: `capture.ts:238` — post-capture backfill error**

Add the logger import. Replace:

```ts
// before
.catch((err) => console.error('[capture] post-capture backfill failed', err))
// after
.catch((err) => logger.error({ err, module: 'capture' }, 'post_capture_backfill_failed'))
```

- [ ] **Step 2: `portfolio.ts:107` — `buildUnifiedCadTotal` missing FX rate**

Add the logger import. Replace lines 107–109:

```ts
// before
console.warn(
  `[portfolio] buildUnifiedCadTotal: no FX rate for ${row.currency}→CAD on ${asOfDate}`
);
// after
logger.warn(
  { fromCurrency: row.currency, toCurrency: 'CAD', asOfDate, module: 'portfolio' },
  'portfolio_unified_cad_total_missing_fx_rate',
);
```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/capture.ts backend/src/routes/portfolio.ts
git commit -m "refactor(routes): route capture + portfolio console.* through logger"
```

---

## Task 17: Route the Yahoo demoting logger through pino

**Files:**
- Modify: `backend/src/integrations/yahoo/client.ts`

The `createDemotingLogger()` factory currently routes through `console.log/warn/error/dir`. Route it through `logger` while preserving the "Invalid options" demotion semantics.

- [ ] **Step 1: Rewrite the factory**

Replace `createDemotingLogger` (currently around lines 107–139) with:

```ts
import { logger } from '../../observability/logger';

function createDemotingLogger() {
  let pendingOptionsDump = false;
  const isOptionsErrorHeadline = (args: unknown[]): boolean => {
    const first = args[0];
    return (
      typeof first === 'string' &&
      first.startsWith('[yahooFinance.') &&
      first.includes('Invalid options')
    );
  };
  const formatArgs = (args: unknown[]): { msg: string; data?: unknown } => {
    if (args.length === 0) return { msg: '' };
    const [first, ...rest] = args;
    if (typeof first === 'string') {
      return rest.length === 0 ? { msg: first } : { msg: first, data: rest };
    }
    return { msg: 'yahoo_log', data: args };
  };
  return {
    info: (...args: unknown[]) => {
      const { msg, data } = formatArgs(args);
      if (pendingOptionsDump) {
        pendingOptionsDump = false;
        logger.warn({ source: 'yahoo-finance2', data }, `yahoo_invalid_options_dump: ${msg}`);
        return;
      }
      logger.info({ source: 'yahoo-finance2', data }, msg);
    },
    warn: (...args: unknown[]) => {
      const { msg, data } = formatArgs(args);
      logger.warn({ source: 'yahoo-finance2', data }, msg);
    },
    error: (...args: unknown[]) => {
      const { msg, data } = formatArgs(args);
      if (isOptionsErrorHeadline(args)) {
        pendingOptionsDump = true;
        logger.warn({ source: 'yahoo-finance2', data }, `yahoo_invalid_options: ${msg}`);
        return;
      }
      logger.error({ source: 'yahoo-finance2', data }, msg);
    },
    debug: (..._args: unknown[]) => {},
    dir: (item: unknown, _options?: unknown) => {
      logger.debug({ source: 'yahoo-finance2', item }, 'yahoo_dir');
    },
  };
}
```

The `dir` method previously called `console.dir`; routing it through `logger.debug` keeps the diagnostic available behind `LOG_LEVEL=debug` without polluting other levels.

- [ ] **Step 2: Typecheck + tests**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/integrations/yahoo/client.ts
git commit -m "refactor(yahoo): route demoting logger output through pino"
```

---

## Task 18: Wrap scheduler tick bodies in `withContext({ jobName, tickId })`

**Files:**
- Modify: `backend/src/integrations/yahoo/scheduler.ts`
- Modify: `backend/src/portfolio/dailySnapshotScheduler.ts`
- Modify: `backend/src/portfolio/forwardIncomeScheduler.ts`

- [ ] **Step 1: `yahoo/scheduler.ts` — wrap the cron callback**

Add at the top:
```ts
import { randomUUID } from 'crypto';
import { withContext } from '../../observability/requestContext';
```

In `startQuoteScheduler`, replace the cron callback body:

```ts
activeTask = cron.schedule(env.quoteTickCron, async () => {
  await withContext(
    { jobName: 'yahoo_quote_scheduler', tickId: randomUUID() },
    async () => {
      if (runningTick) {
        logger.debug({}, 'quote_scheduler_tick_skipped_reentrant');
        return;
      }
      runningTick = true;
      try {
        const result = await runQuoteSchedulerTick();
        logger.info(result as unknown as Record<string, unknown>, 'quote_scheduler_tick');
      } catch (err) {
        logger.error({ err }, 'quote_scheduler_tick_unhandled');
      } finally {
        runningTick = false;
      }
    },
  );
});
```

Note: `withContext` returns whatever `fn` returns. Awaiting it works for async functions.

- [ ] **Step 2: `dailySnapshotScheduler.ts` — same pattern**

Wrap the tick body in `withContext({ jobName: 'daily_snapshot_scheduler', tickId: randomUUID() }, ...)`.

- [ ] **Step 3: `forwardIncomeScheduler.ts` — same pattern**

Wrap the tick body in `withContext({ jobName: 'forward_income_scheduler', tickId: randomUUID() }, ...)`.

- [ ] **Step 4: Typecheck + tests**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/yahoo/scheduler.ts backend/src/portfolio/dailySnapshotScheduler.ts backend/src/portfolio/forwardIncomeScheduler.ts
git commit -m "feat(observability): tag scheduler ticks with jobName + tickId via ALS"
```

---

## Task 19: Switch `accountKind.test.ts` from `console.warn` spy to pino spy

**Files:**
- Modify: `backend/test/accountKind.test.ts`

The current test (around lines 34–44) captures warnings by monkey-patching `console.warn`. Now `accountKind` warns via `logger.warn` — so the spy needs to target pino's output stream.

- [ ] **Step 1: Read the current test**

Read `backend/test/accountKind.test.ts` to understand the existing spy pattern and what it asserts on.

- [ ] **Step 2: Replace the spy with a pino-stream capture**

Pino's destination stream can be intercepted with `pino-test`'s `sink()` helper, or by building a local logger. The cleanest minimal change: import the real `logger` and use the `pino` module's `symbols.streamSym` is not stable across versions — instead, expose a small test seam.

**Option A (preferred): add a tiny export to the logger module** that returns the active stream so tests can hook it:

In `backend/src/observability/logger.ts`, append:

```ts
// Test seam — DO NOT use in production code.
export const __testHooks = {
  /** Replace the logger's write target with `write`. Returns a restore fn. */
  captureWrites(write: (line: string) => void): () => void {
    // pino exposes the underlying destination via Symbol.for('pino.destination')
    // but that symbol is internal; instead, swap a wrapping function on the
    // module-level `logger` reference. The simplest robust path is to keep a
    // mutable destination and rebuild the logger only for tests.
    const original = (logger as unknown as { [k: symbol]: unknown })[Symbol.for('pino.stream')];
    (logger as unknown as Record<symbol, unknown>)[Symbol.for('pino.stream')] = { write };
    return () => {
      (logger as unknown as Record<symbol, unknown>)[Symbol.for('pino.stream')] = original;
    };
  },
};
```

If the `Symbol.for('pino.stream')` swap proves brittle in the installed pino version, fall back to **Option B**: build a parallel test logger that shares the mixin, point `accountKind` at it via dependency injection. That requires a one-line refactor of `accountKind.ts` to accept an optional logger parameter — acceptable if Option A doesn't work.

**Option B fallback** in `accountKind.ts`:
```ts
import { logger as defaultLogger } from '../observability/logger';
export function accountKind(accountType: string, log = defaultLogger) {
  if (/* unknown */) {
    log.warn({ accountType, module: 'networth' }, 'unknown_account_type_default_asset');
  }
  // ...
}
```

Then the test passes its own pino instance pointed at a `lines[]` buffer.

- [ ] **Step 3: Rewrite the test using whichever option worked**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { accountKind } from '../src/networth/accountKind';

test('accountKind warns once per unknown type', () => {
  const lines: string[] = [];
  const testLogger = pino({ level: 'debug' }, { write(c: string) { lines.push(c); } });
  accountKind('mystery', testLogger);
  const warn = lines.find((l) => l.includes('unknown_account_type_default_asset'));
  assert.ok(warn, 'expected warn event');
  const entry = JSON.parse(warn);
  assert.equal(entry.accountType, 'mystery');
  assert.equal(entry.level, 'warn');
});
```

- [ ] **Step 4: Run the test**

Run: `yarn workspace cashflow-backend exec -- node --test test/accountKind.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/test/accountKind.test.ts backend/src/networth/accountKind.ts backend/src/observability/logger.ts
git commit -m "test(networth): convert console.warn spy to pino logger injection"
```

---

## Task 20: Add `no-console` ESLint rule scoped to `backend/src/**`

**Files:**
- Modify: `backend/eslint.config.js` (or whatever lint config the workspace uses — check `package.json` `eslint` field and the repo's `.eslintrc*`).

- [ ] **Step 1: Locate the ESLint config**

Run: `find backend -maxdepth 3 -name "eslint.config*" -o -name ".eslintrc*" | head -5`

Open the discovered config. Note the existing structure (flat config vs legacy).

- [ ] **Step 2: Add the rule, scoped to `src/**` only**

For flat config (`eslint.config.js`):

```js
{
  files: ['src/**/*.ts'],
  rules: {
    'no-console': ['error', { allow: [] }],
  },
}
```

For legacy `.eslintrc`:

```json
{
  "overrides": [
    {
      "files": ["src/**/*.ts"],
      "rules": { "no-console": "error" }
    }
  ]
}
```

The `test/` directory is exempt — tests still need `console` for some debugging patterns and the rule shouldn't punish that.

- [ ] **Step 3: Run lint**

Run: `yarn workspace cashflow-backend run lint`
Expected: PASS. If any `console.*` survives in `src/`, the rule will flag it; fix those callsites the same way as Tasks 12–17.

- [ ] **Step 4: Commit**

```bash
git add backend/eslint.config.js backend/.eslintrc*
git commit -m "chore(lint): forbid console.* in backend/src to enforce logger usage"
```

(Adjust the `git add` paths to match whatever lint config file was actually edited.)

---

## Task 21: Full CI parity — typecheck, lint, test, integration test, build

**Files:** none modified

- [ ] **Step 1: Run the CI pipeline locally**

Run: `yarn ci`
Expected: PASS (typecheck, unit tests, integration tests, frontend build, backend build).

If any step fails, fix the underlying issue. Do not skip or weaken the failing check.

- [ ] **Step 2: Verify no `console.*` remain in `backend/src`**

Run:
```bash
grep -rn "console\.\(log\|warn\|error\|info\|dir\)" backend/src | grep -v "// eslint-disable" | wc -l
```
Expected: `0`.

If any survive, they must be either (a) genuinely required and `// eslint-disable-next-line no-console`'d with a comment justifying why, or (b) migrated.

- [ ] **Step 3: Verify the new logger output shape by running the dev server briefly**

Run (in a separate shell):
```bash
LOG_LEVEL=info yarn workspace cashflow-backend run dev
```

Hit a public endpoint (e.g. `curl http://localhost:3000/api/health`) and confirm in the dev terminal that the log line is the `pino-pretty` colored output containing `http_request`, `requestId`, `path`, `statusCode`, `durationMs`.

Kill the dev server.

- [ ] **Step 4: Verify production-mode JSON output**

```bash
NODE_ENV=production LOG_LEVEL=info yarn workspace cashflow-backend run dev
```

Hit the same endpoint. Confirm the log line is single-line JSON with `level: "info"`, `service: "cashflow-backend"`, `env: "production"`, `requestId`, `msg: "http_request"`, and the http fields.

Kill the dev server.

- [ ] **Step 5: Commit any incidental cleanup**

If the verification revealed any small issues (typos in event names, missing fields), fix them and commit:

```bash
git add <files>
git commit -m "fix(observability): <specific fix found during verification>"
```

If there were no issues, skip the commit.

---

## Task 22: Open the PR

**Files:** none modified

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create --title "Logging Phase 1: pino + ALS + console.* purge" --body "$(cat <<'EOF'
## Summary

Phase 1 of the logging standardization (spec: `docs/superpowers/specs/2026-05-25-logging-standardization-design.md`).

- Replace the hand-rolled JSON logger with **pino** (`backend/src/observability/logger.ts`).
- Introduce **AsyncLocalStorage**-based request context (`backend/src/observability/requestContext.ts`) — `requestId`, `userId`, `householdId`, `role`, `route`, `jobName`, `tickId` auto-attach to every log line via a pino `mixin`.
- HTTP middleware seeds the ALS; auth middleware layers user/household/role.
- Schedulers (yahoo quote, daily snapshot, forward income) wrap each tick in `withContext({ jobName, tickId })`.
- Replace ~25 direct `console.*` calls across FX, Sequelize hooks, enrichment, import pipeline, capture, portfolio, and server boot with `logger.{level}`.
- Yahoo Finance demoting wrapper now routes through `logger` (still suppresses "Invalid options" noise to `warn`).
- New ESLint `no-console` rule on `backend/src/**` prevents regressions.
- New unit + integration tests for the logger and ALS.

No OTel SDK is registered yet — Phase 2 wires `otel-collector` + Loki and the OTLP log exporter.

## Test plan

- [ ] `yarn ci` green
- [ ] No `console.*` in `backend/src` (`grep` check from Task 21)
- [ ] Dev server logs render via `pino-pretty`
- [ ] `NODE_ENV=production` server logs are single-line JSON with the expected schema
- [ ] HTTP requests carry `requestId`, `userId`, `householdId` in the response log when authenticated
- [ ] Scheduler logs carry `jobName` + `tickId`
EOF
)"
```

- [ ] **Step 3: Confirm CI passes on the PR**

Wait for CI checks. If anything fails, investigate and fix on the branch.

---

## Self-review checklist (for the implementer)

After all 22 tasks land:

- [ ] Every spec requirement in **Phase 1** of `2026-05-25-logging-standardization-design.md` has a corresponding task above.
- [ ] No placeholders, no "implement later" steps.
- [ ] Type names and method shapes used in later tasks match earlier tasks (`withContext`, `logger.<level>({fields}, 'event')`, `LogContext`).
- [ ] Tests use `node --test` (matching the repo's existing pattern from `accountKind.test.ts`).
- [ ] Commits are small and topical — one logical change per commit.

## Notes for Phases 2–4 (out of scope for this plan)

- Phase 2 will register an OTel SDK with the OTLP **logs** exporter and add the `pino-opentelemetry-transport` (or `pino.multistream`-with-custom-OTLP) so log records flow into Loki via the collector. The trace_id/span_id fields added by the Phase 1 mixin become non-null once Phase 3 registers the trace SDK.
- Phase 3 wires Http/Express/Sequelize/Undici instrumentations and Tempo as the trace sink.
- Phase 4 swaps the frontend `clientLogger` for the browser OTel SDK; deletes the `/api/client-logs` endpoint.
- Do not anticipate those changes in Phase 1. The mixin's `trace_id`/`span_id` fields are correct as-is — they just resolve to `undefined` until the SDK is registered.
