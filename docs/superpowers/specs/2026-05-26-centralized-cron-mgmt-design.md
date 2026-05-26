# Centralized Cron Management — Design

**Status:** Draft
**Date:** 2026-05-26
**Author:** Connor (with Claude)

## Problem

Four hand-rolled `node-cron` schedulers live in `backend/src/`:

- `integrations/yahoo/scheduler.ts` — quote refresh `*/4 * * * *`
- `portfolio/dailySnapshotScheduler.ts` — `0 3 * * *`
- `portfolio/forwardIncomeScheduler.ts` — `0 2 * * *`
- `import/enrichmentBackfillScheduler.ts` — `0 4 * * *`

Plus one boot-time fire-and-forget: `backfillUsdCadHistory` in `server.ts`.

Each scheduler duplicates the same shape: in-process `runningTick` re-entrancy
guard, `activeTask` singleton, `cron.validate` check, env knobs `X_ENABLED` /
`X_CRON`, typed tick-result, structured log lines, and a manual `start*()` call
wired into `server.ts`. New jobs cost a whole file and three boilerplate
imports. There is no runtime visibility (last run, status, next fire), no way
to disable a job without an env change + redeploy, and no multi-instance
safety if Railway ever scales the backend beyond one replica.

## Goals

1. **Kill boilerplate.** Adding a new job is ~10 lines (a `defineJob` call and
   a handler), not a new file.
2. **Runtime visibility.** A new `Jobs` tab in Settings lists every job with
   cron expression, last run timestamp + status + duration, next run, enabled
   toggle, and a "run now" button.
3. **Multi-instance safety.** Lock primitive lets the same job run safely
   across N backend replicas. Built around Postgres advisory locks so no new
   infra is required; on sqlite (dev/tests) it is a no-op.

## Non-goals

- **No persistent run history.** No `JobRun` table. Only the latest run state
  per job is retained (upserted onto the `Job` row).
- **No new queue infrastructure.** Not switching to BullMQ/Bee/Agenda. We keep
  `node-cron` and wrap it.
- **No per-tenant jobs.** Jobs are global / process-level. Per-household
  backfills stay on their existing manual + cron paths.

## Approach

A thin in-house `JobRegistry` module wraps `node-cron`. Each existing
scheduler file becomes a `defineJob({ name, cronDefault, enabledDefault,
handler })` declaration. A single `startAllJobs()` call in `server.ts`
replaces the four `start*()` imports. The registry handles re-entrancy,
distributed lock, env→DB override resolution, timing, and last-run upsert.

Considered alternatives:

- **BullMQ + Redis.** Battle-tested distributed locks and repeatable jobs, but
  it adds Redis as a dependency and a worker-process model that we do not
  need for four jobs. Rejected as overkill.
- **Metadata-only (introspect existing schedulers).** Cheapest, but does not
  kill boilerplate. Rejected — fails goal #1.

## Architecture

### Module layout

```
backend/src/jobs/
  index.ts            // re-exports defineJob, startAllJobs
  registry.ts         // defineJob() + startAllJobs() + reconcile loop
  runner.ts           // single tick wrapper (lock + guard + timing + upsert + log)
  pgLock.ts           // withAdvisoryLock(name, fn) — no-op on sqlite
  configResolver.ts   // env defaults ⊕ DB Job row → effective {enabled, cron}
  api.ts              // GET /api/jobs, POST /api/jobs/:name/run, PATCH /api/jobs/:name
  types.ts            // JobDefinition, JobTickResult, JobStatusView
```

Existing files convert:

- `integrations/yahoo/scheduler.ts` → keeps `runQuoteTick()` handler; deletes
  `startQuoteScheduler()` and its cron wiring.
- `portfolio/dailySnapshotScheduler.ts` → keeps `runDailySnapshotTick()`;
  removes `startDailySnapshotScheduler()`.
- `portfolio/forwardIncomeScheduler.ts` → keeps `runForwardIncomeTick()`;
  removes `startForwardIncomeScheduler()`.
- `import/enrichmentBackfillScheduler.ts` → keeps
  `runEnrichmentBackfillTick()`; removes `startEnrichmentBackfillScheduler()`.

A new `backend/src/jobs/definitions/` directory holds one `defineJob` file per
job that imports the appropriate `run*Tick` handler. The registry imports the
definitions for their side effects at boot.

USD/CAD backfill (`backfillUsdCadHistory`) is converted from a boot-time
fire-and-forget into a `defineJob` with a daily-noon cron. Idempotent already,
so re-running it is safe.

### Data model

New Sequelize model `Job`, one row per registered job name. Migration creates
the empty table; the registry upserts one row per `defineJob` call at boot
(idempotent). This avoids coupling the migration to the set of jobs — adding a
new `defineJob` is enough; no new migration needed.

```ts
// backend/src/models/Job.ts
{
  name: string;                    // PK, matches defineJob.name
  enabledOverride: boolean | null; // null = use env default
  cronOverride: string | null;     // null = use env default
  lastRunAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus:
    | 'ok'
    | 'error'
    | 'skipped_disabled'
    | 'skipped_locked'
    | 'skipped_reentrant'
    | null;
  lastDurationMs: number | null;
  lastError: string | null;        // truncated to ~1KB
  lastResultJson: string | null;   // optional handler-returned summary, truncated to ~2KB
  createdAt, updatedAt;
}
```

No `JobRun` table. Each tick `UPDATE`s the `Job` row in place.

### Lock primitive

```ts
// pgLock.ts
export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }>;
```

- Hashes `name` to a stable bigint, calls `pg_try_advisory_lock(key)`. Releases
  in `finally` via `pg_advisory_unlock`.
- Sequelize dialect check: if `dialect !== 'postgres'` (sqlite tests, dev),
  bypasses the lock and just runs `fn` so dev ergonomics are unchanged.
- The in-process `runningTick` guard remains as a cheap short-circuit before
  the DB round-trip — the lock is the cross-replica safety net.

### Config resolution

```ts
// configResolver.ts
resolveJobConfig(name):
  { enabled: boolean,
    cron: string,
    source: { enabled: 'env' | 'db', cron: 'env' | 'db' } }
```

- Env defaults are registered via `defineJob({ enabledDefault, cronDefault })`.
  Existing env keys (`QUOTE_TICK_CRON`, `DAILY_SNAPSHOT_ENABLED`, etc.) keep
  working — `defineJob` reads them and uses them as the defaults.
- `Job` row's non-null `enabledOverride` / `cronOverride` win over env.
- A single **reconcile loop** runs every 60s: compares the currently-scheduled
  `cron.ScheduledTask` for each job against the resolved effective config;
  if cron expression changed, stops and reschedules; if `enabled` flipped,
  starts/stops the task. No PATCH-driven invalidation — one timer to debug.

### API surface

All routes gated by `isSuperadmin(req)` (existing helper in
[backend/src/auth/scope.ts](backend/src/auth/scope.ts:6)). Non-superadmins
get 403.

```
GET    /api/jobs
       → [{ name, cron, enabled, source, lastRunAt, lastFinishedAt,
             lastStatus, lastDurationMs, lastError, lastResultJson,
             nextRunAt }]

POST   /api/jobs/:name/run
       → Triggers a tick now. Honors the lock and re-entrancy guard. Returns
         { status, durationMs, result? }. Synchronous (waits for the tick).

PATCH  /api/jobs/:name
       Body: { enabled?: boolean | null, cron?: string | null }
       → Upserts the Job row's overrides. `null` clears that override (falls
         back to env). Validates cron via `cron.validate` before persisting.
         Returns the updated effective config.
```

`nextRunAt` is computed from the effective cron expression via the
`cron-parser` package (small dep, ~30KB).

### Frontend tab

New `frontend/src/pages/settings/tabs/JobsTab.tsx`, wired into the existing
`SettingsPage` tab strip. Columns:

| Job | Cron | Enabled | Last Run | Status | Duration | Next Run | Actions |

- **Cron** cell shows the effective expression with a small env/db badge
  pulled from `source`.
- **Enabled** cell is a toggle switch → `PATCH /api/jobs/:name { enabled }`.
- **Actions:** "Run now" button → `POST /api/jobs/:name/run`, shows a spinner
  and toasts the result; "Edit cron" opens an inline input with a preflight
  `cron.validate` and PATCHes on save; "Reset to env default" PATCHes both
  fields to `null`.
- Polls `GET /api/jobs` every 10s while the tab is open. Pauses polling when
  the tab is hidden.
- Styling matches existing `EnrichmentBackfillCard` (Tailwind utilities, table
  layout, badge components).

For non-superadmins the tab is hidden in the Settings tab strip — same
visibility pattern as any other admin-only surface.

## Data flow (single tick)

1. `node-cron` fires the wrapped callback for job `X`.
2. `runner.tick(X)`:
   1. `resolveJobConfig(X)` → effective `{ enabled, cron }`.
   2. If `!enabled` → upsert `lastStatus = 'skipped_disabled'`, return.
   3. If in-process `runningTick[X]` already true → upsert
      `lastStatus = 'skipped_reentrant'`, return.
   4. Set `runningTick[X] = true`; record `lastRunAt = now`.
   5. `withAdvisoryLock(X, async () => { ... })`:
      - If lock not acquired → upsert `lastStatus = 'skipped_locked'`.
      - Else run handler, capture result or error, time it.
   6. Upsert `lastFinishedAt`, `lastDurationMs`, `lastStatus`, `lastError`,
      `lastResultJson`.
   7. Clear `runningTick[X]`; emit structured log.

`POST /api/jobs/:name/run` invokes the same `runner.tick(X)` so manual runs
flow through every safety check.

## Error handling

- Handler throws → caught in `runner.tick`, `lastStatus = 'error'`,
  `lastError` truncated to 1KB, full error logged via existing
  `observability/logger` with `job_tick_failed` event. The cron schedule keeps
  ticking — one failed run does not stop the job.
- DB upsert on the `Job` row fails → logged with `job_state_persist_failed`,
  swallowed. We never want a state-persistence bug to take down the job.
- Invalid cron expression after a `PATCH` → API returns 400 before persisting;
  the running task is untouched. The reconcile loop refuses to reschedule on
  an invalid expression and logs `job_reconcile_invalid_cron`.
- `pg_try_advisory_lock` round-trip fails → treated as not-acquired
  (`skipped_locked`) and logged with `job_lock_query_failed`. Next tick
  retries.

## Testing strategy

- **Unit:** `pgLock` against a real Postgres test database (acquire/release,
  contention, sqlite no-op branch). `configResolver` truth table covering
  env-only, db-only, both, and null-override reset. `runner.tick` with a
  stubbed handler for each `lastStatus` branch.
- **Integration:** `GET /api/jobs` returns seeded job rows. `PATCH` updates
  overrides and the reconcile loop picks them up within 60s (test uses an
  injectable interval). `POST /run` invokes the handler and updates the row.
- **UI:** React Testing Library render of `JobsTab` with mocked API
  responses, covers enabled-toggle, run-now, cron edit, and the env/db
  source badge.
- All four converted schedulers keep their existing tests. Only the entry
  point changes — handlers and tick semantics do not.

## Migration plan

1. Add `backend/src/jobs/` module, `Job` model, migration, and `cron-parser`
   dep. No behavior change yet — module exists but is not started.
2. Convert each of the four existing schedulers to a `defineJob` registration,
   one PR per job. Delete the old `start*()` exports and the
   `server.ts` import for that job. The reconcile loop owns it now.
3. Convert `backfillUsdCadHistory` from boot-time fire-and-forget to a daily
   `defineJob`. Remove the inline IIFE in `server.ts`.
4. Add `/api/jobs` routes gated by `isSuperadmin`.
5. Add `JobsTab` to `SettingsPage`.
6. Document the registry and the `defineJob` API in
   `backend/src/jobs/README.md`.

Each step is independently shippable. Steps 1–3 are no-op from the user's
perspective; steps 4–5 add the new surface.

## Open questions

None outstanding. All clarifying questions were answered during brainstorm.
