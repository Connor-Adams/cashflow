# Centralized Cron Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four hand-rolled `node-cron` schedulers and one boot-time backfill with a single `JobRegistry`. Adds a superadmin-only `/settings/jobs` tab for visibility and run-now control. Designed for safe multi-replica execution via Postgres advisory locks.

**Architecture:** Thin in-house module `backend/src/jobs/` wraps `node-cron`. Each job is registered via `defineJob({ name, cronDefault, enabledDefault, handler })`. A `runner` wraps each tick with re-entrancy guard → advisory lock → handler → last-run upsert on the `Job` row. A 60s reconcile loop watches the `Job` table and reschedules tasks when DB overrides change. Env vars stay as defaults; DB overrides win.

**Tech Stack:** TypeScript, Express, Sequelize (Postgres in prod, SQLite in tests), `node-cron`, new dep `cron-parser`, React + Tailwind, `node:test` runner, React Testing Library.

**Spec:** [docs/superpowers/specs/2026-05-26-centralized-cron-mgmt-design.md](../specs/2026-05-26-centralized-cron-mgmt-design.md)

---

## File Structure

### Create

- `backend/src/jobs/types.ts` — `JobDefinition`, `JobHandlerResult`, `JobStatus`, `JobStatusView`
- `backend/src/jobs/pgLock.ts` — `withAdvisoryLock(name, fn)` (Postgres + SQLite no-op branch)
- `backend/src/jobs/configResolver.ts` — `resolveJobConfig(name)`
- `backend/src/jobs/runner.ts` — `tick(name)` (re-entrancy, lock, timing, persist)
- `backend/src/jobs/registry.ts` — `defineJob`, `startAllJobs`, `stopAllJobs`, `listJobs`, reconcile loop
- `backend/src/jobs/index.ts` — re-exports `defineJob`, `startAllJobs`, `tick`, `listJobs`
- `backend/src/jobs/definitions/yahooQuote.ts` — `defineJob` wrapping `runQuoteSchedulerTick`
- `backend/src/jobs/definitions/dailySnapshot.ts`
- `backend/src/jobs/definitions/forwardIncome.ts`
- `backend/src/jobs/definitions/enrichmentBackfill.ts`
- `backend/src/jobs/definitions/usdCadBackfill.ts`
- `backend/src/jobs/api.ts` — Express router for `/api/jobs`
- `backend/src/models/Job.ts` — Sequelize model
- `backend/src/migrations/20260526000001-jobs.js` — table migration
- `backend/test/jobs/pgLock.test.ts`
- `backend/test/jobs/configResolver.test.ts`
- `backend/test/jobs/runner.test.ts`
- `backend/test/jobs/registry.test.ts`
- `backend/test/integration/jobsApi.test.ts`
- `frontend/src/pages/settings/tabs/JobsTab.tsx`
- `frontend/src/pages/settings/tabs/JobsTab.test.tsx`
- `frontend/src/types/jobs.ts`

### Modify

- `backend/package.json` — add `cron-parser`
- `backend/src/config/env.ts` — no behavior change (defaults still read here)
- `backend/src/models/index.ts` — register `Job` model
- `backend/src/server.ts` — replace four `start*()` + USD/CAD IIFE with `startAllJobs()`
- `backend/src/app.ts` — mount `/api/jobs` router
- `backend/src/integrations/yahoo/scheduler.ts` — remove `startQuoteScheduler` / `stopQuoteScheduler` / `activeTask`; keep `runQuoteSchedulerTick`
- `backend/src/portfolio/dailySnapshotScheduler.ts` — same shape: remove `start*` / `activeTask` / `runningTick`; keep `runDailySnapshotTick`
- `backend/src/portfolio/forwardIncomeScheduler.ts` — same
- `backend/src/import/enrichmentBackfillScheduler.ts` — same
- `backend/src/fx/backfillUsdCadHistory.ts` — no behavior change (signature accepts date range; the job definition will pass dates)
- `frontend/src/App.tsx` — add `<Route path="jobs" element={<JobsTab />} />`
- `frontend/src/pages/settings/SettingsPage.tsx` — add `{ value: 'jobs', label: 'Jobs', superadminOnly: true }` to `TOP_TABS`, filter by `auth.user?.globalRole === 'superadmin'`
- `frontend/src/pages/settings/useActiveSettingsTopTab.ts` — add `'jobs'` to union and matcher

---

## Conventions

- **Tests:** Node 22's built-in `node:test`. Backend unit tests in `backend/test/*.test.ts`; integration in `backend/test/integration/*.test.ts`. Frontend uses Vitest + React Testing Library; co-locate `Foo.test.tsx` next to `Foo.tsx`.
- **Commits:** Conventional Commits (`feat(jobs): …`, `refactor(jobs): …`, `test(jobs): …`). Connor is sole author — never add `Co-Authored-By`.
- **Test runner cmds:**
  - Single backend unit file: `yarn workspace cashflow-backend run tsx --import ./test/setup.ts --test backend/test/jobs/<file>.test.ts`
  - Single backend integration file: `yarn workspace cashflow-backend run tsx --import ./test/setup.ts --test backend/test/integration/jobsApi.test.ts`
  - Single frontend file: `yarn workspace frontend run test -- JobsTab.test.tsx`
  - Full backend: `yarn workspace cashflow-backend run test`
  - Typecheck: `yarn workspace cashflow-backend run typecheck`

---

## Task 0: Add `cron-parser` dependency

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Add the dep**

```bash
yarn workspace cashflow-backend add cron-parser
```

- [ ] **Step 2: Verify it installed**

```bash
yarn workspace cashflow-backend list --pattern cron-parser
```

Expected: shows `cron-parser@<version>` in tree.

- [ ] **Step 3: Smoke-import**

```bash
yarn workspace cashflow-backend run tsx -e "import { CronExpressionParser } from 'cron-parser'; console.log(CronExpressionParser.parse('*/4 * * * *').next().toISOString())"
```

Expected: prints a future ISO timestamp.

- [ ] **Step 4: Commit**

```bash
git add backend/package.json yarn.lock
git commit -m "feat(jobs): add cron-parser dep for nextRunAt computation"
```

---

## Task 1: `Job` Sequelize model + migration

**Files:**
- Create: `backend/src/models/Job.ts`
- Create: `backend/src/migrations/20260526000001-jobs.js`
- Modify: `backend/src/models/index.ts`
- Create: `backend/test/jobs/jobModel.test.ts`

- [ ] **Step 1: Write the failing model test**

`backend/test/jobs/jobModel.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../src/models');

before(async () => {
  models = await import('../../src/models');
  await models.sequelize.sync();
});

after(async () => { await models.sequelize.close(); });

test('Job upserts a row keyed by name', async () => {
  await models.Job.upsert({
    name: 'test_job_a',
    enabledOverride: null,
    cronOverride: null,
    lastRunAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastError: null,
    lastResultJson: null,
  });
  const row = await models.Job.findOne({ where: { name: 'test_job_a' } });
  assert.ok(row);
  assert.equal(row.enabledOverride, null);
  assert.equal(row.cronOverride, null);
});

test('Job round-trips status fields', async () => {
  await models.Job.upsert({
    name: 'test_job_b',
    enabledOverride: true,
    cronOverride: '*/5 * * * *',
    lastRunAt: new Date('2026-05-26T10:00:00Z'),
    lastFinishedAt: new Date('2026-05-26T10:00:01Z'),
    lastStatus: 'ok',
    lastDurationMs: 1234,
    lastError: null,
    lastResultJson: JSON.stringify({ processed: 3 }),
  });
  const row = await models.Job.findOne({ where: { name: 'test_job_b' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'ok');
  assert.equal(row.lastDurationMs, 1234);
  assert.equal(row.cronOverride, '*/5 * * * *');
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/jobModel.test.ts
```

Expected: FAIL (`models.Job` does not exist).

- [ ] **Step 3: Create the model**

`backend/src/models/Job.ts`:

```ts
import {
  Model,
  DataTypes,
  type Sequelize,
  type ModelAttributes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';

export type JobLastStatus =
  | 'ok'
  | 'error'
  | 'skipped_disabled'
  | 'skipped_locked'
  | 'skipped_reentrant';

export class Job extends Model<
  InferAttributes<Job>,
  InferCreationAttributes<Job>
> {
  declare name: string;
  declare enabledOverride: boolean | null;
  declare cronOverride: string | null;
  declare lastRunAt: Date | null;
  declare lastFinishedAt: Date | null;
  declare lastStatus: JobLastStatus | null;
  declare lastDurationMs: number | null;
  declare lastError: string | null;
  declare lastResultJson: string | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

export function initJob(sequelize: Sequelize): typeof Job {
  Job.init(
    {
      name: { type: DataTypes.STRING(128), primaryKey: true, allowNull: false },
      enabledOverride: {
        type: DataTypes.BOOLEAN,
        field: 'enabled_override',
        allowNull: true,
      },
      cronOverride: {
        type: DataTypes.STRING(128),
        field: 'cron_override',
        allowNull: true,
      },
      lastRunAt: { type: DataTypes.DATE, field: 'last_run_at', allowNull: true },
      lastFinishedAt: {
        type: DataTypes.DATE,
        field: 'last_finished_at',
        allowNull: true,
      },
      lastStatus: {
        type: DataTypes.STRING(32),
        field: 'last_status',
        allowNull: true,
      },
      lastDurationMs: {
        type: DataTypes.INTEGER,
        field: 'last_duration_ms',
        allowNull: true,
      },
      lastError: {
        type: DataTypes.STRING(1024),
        field: 'last_error',
        allowNull: true,
      },
      lastResultJson: {
        type: DataTypes.STRING(2048),
        field: 'last_result_json',
        allowNull: true,
      },
    } as ModelAttributes<Job>,
    {
      sequelize,
      modelName: 'Job',
      tableName: 'jobs',
      underscored: true,
      timestamps: true,
    },
  );
  return Job;
}
```

- [ ] **Step 4: Register in models index**

Edit `backend/src/models/index.ts`. Find the import block (around line 43 where `ProviderJobLog` is imported) and add:

```ts
import { Job, initJob } from './Job';
```

Find the init block (around line 58 onward) and add `initJob(sequelize);` somewhere in the list (order does not matter — no FK).

Find the re-export block at the bottom of the file and add `Job` to the exports list (follow the existing style; usually `export { Job };` or addition to a combined export).

- [ ] **Step 5: Create migration**

`backend/src/migrations/20260526000001-jobs.js`:

```js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('jobs', {
      name: { type: Sequelize.STRING(128), primaryKey: true, allowNull: false },
      enabled_override: { type: Sequelize.BOOLEAN, allowNull: true },
      cron_override: { type: Sequelize.STRING(128), allowNull: true },
      last_run_at: { type: Sequelize.DATE, allowNull: true },
      last_finished_at: { type: Sequelize.DATE, allowNull: true },
      last_status: { type: Sequelize.STRING(32), allowNull: true },
      last_duration_ms: { type: Sequelize.INTEGER, allowNull: true },
      last_error: { type: Sequelize.STRING(1024), allowNull: true },
      last_result_json: { type: Sequelize.STRING(2048), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('jobs');
  },
};
```

- [ ] **Step 6: Re-run model test, verify pass**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/jobModel.test.ts
```

Expected: 2/2 passing.

- [ ] **Step 7: Commit**

```bash
git add backend/src/models/Job.ts backend/src/models/index.ts \
        backend/src/migrations/20260526000001-jobs.js \
        backend/test/jobs/jobModel.test.ts
git commit -m "feat(jobs): add Job model and jobs table migration"
```

---

## Task 2: `pgLock` primitive (Postgres + SQLite no-op)

**Files:**
- Create: `backend/src/jobs/pgLock.ts`
- Create: `backend/test/jobs/pgLock.test.ts`

- [ ] **Step 1: Write the failing test**

`backend/test/jobs/pgLock.test.ts`:

```ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let pgLock: typeof import('../../src/jobs/pgLock');
let models: typeof import('../../src/models');

before(async () => {
  models = await import('../../src/models');
  await models.sequelize.sync();
  pgLock = await import('../../src/jobs/pgLock');
});

after(async () => { await models.sequelize.close(); });

test('withAdvisoryLock on sqlite is no-op and runs fn', async () => {
  let ran = false;
  const r = await pgLock.withAdvisoryLock('test_lock_a', async () => {
    ran = true;
    return 42;
  });
  assert.equal(ran, true);
  assert.deepEqual(r, { acquired: true, value: 42 });
});

test('withAdvisoryLock returns acquired:false when fn throws on sqlite is irrelevant — fn errors propagate', async () => {
  await assert.rejects(
    pgLock.withAdvisoryLock('test_lock_b', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
});

test('hashName produces stable bigint for the same string', async () => {
  const a = pgLock.hashJobNameForTest('forward_income');
  const b = pgLock.hashJobNameForTest('forward_income');
  const c = pgLock.hashJobNameForTest('daily_snapshot');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/pgLock.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `pgLock`**

`backend/src/jobs/pgLock.ts`:

```ts
import { createHash } from 'node:crypto';
import { sequelize } from '../db';
import { logger } from '../observability/logger';

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

function hashName(name: string): bigint {
  // Stable 64-bit signed int from sha256(name). Postgres advisory locks take
  // a bigint key.
  const digest = createHash('sha256').update(name).digest();
  // Take the first 8 bytes as a signed bigint.
  const view = new DataView(digest.buffer, digest.byteOffset, 8);
  return view.getBigInt64(0, false);
}

export function hashJobNameForTest(name: string): bigint {
  return hashName(name);
}

function isPostgres(): boolean {
  return sequelize.getDialect() === 'postgres';
}

export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  if (!isPostgres()) {
    const value = await fn();
    return { acquired: true, value };
  }
  const key = hashName(name).toString();
  let acquired = false;
  try {
    const [rows] = (await sequelize.query(
      'SELECT pg_try_advisory_lock(CAST(? AS bigint)) AS locked',
      { replacements: [key] },
    )) as [Array<{ locked: boolean }>, unknown];
    acquired = Boolean(rows[0]?.locked);
  } catch (err) {
    logger.error('job_lock_query_failed', { name }, err as Error);
    return { acquired: false };
  }
  if (!acquired) return { acquired: false };
  try {
    const value = await fn();
    return { acquired: true, value };
  } finally {
    try {
      await sequelize.query('SELECT pg_advisory_unlock(CAST(? AS bigint))', {
        replacements: [key],
      });
    } catch (err) {
      logger.error('job_lock_release_failed', { name }, err as Error);
    }
  }
}
```

- [ ] **Step 4: Re-run test, verify pass**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/pgLock.test.ts
```

Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/jobs/pgLock.ts backend/test/jobs/pgLock.test.ts
git commit -m "feat(jobs): add pg advisory lock primitive (sqlite no-op)"
```

---

## Task 3: `configResolver`

**Files:**
- Create: `backend/src/jobs/types.ts`
- Create: `backend/src/jobs/configResolver.ts`
- Create: `backend/test/jobs/configResolver.test.ts`

- [ ] **Step 1: Write `types.ts` (no test — pure types)**

`backend/src/jobs/types.ts`:

```ts
export type JobStatus =
  | 'ok'
  | 'error'
  | 'skipped_disabled'
  | 'skipped_locked'
  | 'skipped_reentrant';

export interface JobHandlerResult {
  /** Optional structured summary persisted as JSON (truncated to 2KB). */
  summary?: Record<string, unknown>;
}

export type JobHandler = () => Promise<JobHandlerResult | void>;

export interface JobDefinition {
  name: string;
  cronDefault: string;
  enabledDefault: boolean;
  handler: JobHandler;
}

export interface ResolvedJobConfig {
  enabled: boolean;
  cron: string;
  source: {
    enabled: 'env' | 'db';
    cron: 'env' | 'db';
  };
}

export interface JobStatusView {
  name: string;
  cron: string;
  enabled: boolean;
  source: ResolvedJobConfig['source'];
  lastRunAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: JobStatus | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResultJson: string | null;
  nextRunAt: string | null;
}
```

- [ ] **Step 2: Write the failing resolver test**

`backend/test/jobs/configResolver.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../src/models');
let resolver: typeof import('../../src/jobs/configResolver');
let types: typeof import('../../src/jobs/types');

const DEF: import('../../src/jobs/types').JobDefinition = {
  name: 'resolver_test_job',
  cronDefault: '0 3 * * *',
  enabledDefault: true,
  handler: async () => ({}),
};

before(async () => {
  models = await import('../../src/models');
  await models.sequelize.sync();
  resolver = await import('../../src/jobs/configResolver');
  types = await import('../../src/jobs/types');
  void types;
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.Job.destroy({ where: { name: DEF.name } });
});

test('returns env defaults when no Job row exists', async () => {
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.enabled, true);
  assert.equal(r.cron, '0 3 * * *');
  assert.equal(r.source.enabled, 'env');
  assert.equal(r.source.cron, 'env');
});

test('Job row null overrides keep env defaults', async () => {
  await models.Job.create({
    name: DEF.name,
    enabledOverride: null,
    cronOverride: null,
    lastRunAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastError: null,
    lastResultJson: null,
  });
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.source.enabled, 'env');
  assert.equal(r.source.cron, 'env');
});

test('Job row non-null overrides win', async () => {
  await models.Job.create({
    name: DEF.name,
    enabledOverride: false,
    cronOverride: '*/10 * * * *',
    lastRunAt: null, lastFinishedAt: null, lastStatus: null,
    lastDurationMs: null, lastError: null, lastResultJson: null,
  });
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.enabled, false);
  assert.equal(r.cron, '*/10 * * * *');
  assert.equal(r.source.enabled, 'db');
  assert.equal(r.source.cron, 'db');
});

test('mixed sources: db enabled override only, env cron', async () => {
  await models.Job.create({
    name: DEF.name,
    enabledOverride: false,
    cronOverride: null,
    lastRunAt: null, lastFinishedAt: null, lastStatus: null,
    lastDurationMs: null, lastError: null, lastResultJson: null,
  });
  const r = await resolver.resolveJobConfig(DEF);
  assert.equal(r.enabled, false);
  assert.equal(r.cron, '0 3 * * *');
  assert.equal(r.source.enabled, 'db');
  assert.equal(r.source.cron, 'env');
});
```

- [ ] **Step 3: Run test, verify failure**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/configResolver.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 4: Implement resolver**

`backend/src/jobs/configResolver.ts`:

```ts
import { Job } from '../models';
import type { JobDefinition, ResolvedJobConfig } from './types';

export async function resolveJobConfig(
  def: JobDefinition,
): Promise<ResolvedJobConfig> {
  const row = await Job.findOne({ where: { name: def.name } });
  const enabled =
    row?.enabledOverride !== null && row?.enabledOverride !== undefined
      ? row.enabledOverride
      : def.enabledDefault;
  const cron =
    row?.cronOverride !== null && row?.cronOverride !== undefined
      ? row.cronOverride
      : def.cronDefault;
  return {
    enabled,
    cron,
    source: {
      enabled:
        row?.enabledOverride !== null && row?.enabledOverride !== undefined
          ? 'db'
          : 'env',
      cron:
        row?.cronOverride !== null && row?.cronOverride !== undefined
          ? 'db'
          : 'env',
    },
  };
}
```

- [ ] **Step 5: Re-run test, verify pass**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/configResolver.test.ts
```

Expected: 4/4 passing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/jobs/types.ts backend/src/jobs/configResolver.ts \
        backend/test/jobs/configResolver.test.ts
git commit -m "feat(jobs): add JobDefinition types and configResolver"
```

---

## Task 4: `runner.tick` (re-entrancy, lock, timing, persist)

**Files:**
- Create: `backend/src/jobs/runner.ts`
- Create: `backend/test/jobs/runner.test.ts`

- [ ] **Step 1: Write the failing runner test**

`backend/test/jobs/runner.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../src/models');
let runner: typeof import('../../src/jobs/runner');
let types: typeof import('../../src/jobs/types');

function makeDef(
  name: string,
  enabledDefault: boolean,
  handler: import('../../src/jobs/types').JobHandler,
): import('../../src/jobs/types').JobDefinition {
  return { name, cronDefault: '* * * * *', enabledDefault, handler };
}

before(async () => {
  models = await import('../../src/models');
  await models.sequelize.sync();
  runner = await import('../../src/jobs/runner');
  types = await import('../../src/jobs/types');
  void types;
});

after(async () => { await models.sequelize.close(); });

beforeEach(async () => {
  await models.Job.destroy({ where: {}, truncate: true });
});

test('disabled job returns skipped_disabled and upserts row', async () => {
  const def = makeDef('r_disabled', false, async () => ({}));
  const r = await runner.tick(def);
  assert.equal(r.status, 'skipped_disabled');
  const row = await models.Job.findOne({ where: { name: 'r_disabled' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'skipped_disabled');
});

test('successful tick upserts ok and duration', async () => {
  const def = makeDef('r_ok', true, async () => ({ summary: { processed: 7 } }));
  const r = await runner.tick(def);
  assert.equal(r.status, 'ok');
  const row = await models.Job.findOne({ where: { name: 'r_ok' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'ok');
  assert.ok((row.lastDurationMs ?? -1) >= 0);
  assert.ok(row.lastResultJson?.includes('"processed":7'));
});

test('handler throw produces error status and truncated error', async () => {
  const def = makeDef('r_err', true, async () => {
    throw new Error('kaboom');
  });
  const r = await runner.tick(def);
  assert.equal(r.status, 'error');
  const row = await models.Job.findOne({ where: { name: 'r_err' } });
  assert.ok(row);
  assert.equal(row.lastStatus, 'error');
  assert.ok(row.lastError?.includes('kaboom'));
});

test('concurrent ticks: second sees skipped_reentrant in-process', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => { release = res; });
  const def = makeDef('r_reentrant', true, async () => {
    await gate;
    return {};
  });
  const first = runner.tick(def);
  // Give first a moment to set the guard
  await new Promise((r) => setImmediate(r));
  const second = await runner.tick(def);
  assert.equal(second.status, 'skipped_reentrant');
  release();
  const firstR = await first;
  assert.equal(firstR.status, 'ok');
});

test('long error message is truncated to 1024 chars in lastError', async () => {
  const big = 'x'.repeat(5000);
  const def = makeDef('r_trunc', true, async () => { throw new Error(big); });
  await runner.tick(def);
  const row = await models.Job.findOne({ where: { name: 'r_trunc' } });
  assert.ok((row?.lastError?.length ?? 0) <= 1024);
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/runner.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement runner**

`backend/src/jobs/runner.ts`:

```ts
import { Job } from '../models';
import { logger } from '../observability/logger';
import { resolveJobConfig } from './configResolver';
import { withAdvisoryLock } from './pgLock';
import type { JobDefinition, JobStatus } from './types';

const runningTicks = new Set<string>();

const ERROR_MAX = 1024;
const RESULT_MAX = 2048;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

async function upsertState(
  name: string,
  patch: Partial<{
    lastRunAt: Date;
    lastFinishedAt: Date;
    lastStatus: JobStatus;
    lastDurationMs: number;
    lastError: string | null;
    lastResultJson: string | null;
  }>,
): Promise<void> {
  try {
    const [row] = await Job.findOrCreate({
      where: { name },
      defaults: {
        name,
        enabledOverride: null,
        cronOverride: null,
        lastRunAt: null,
        lastFinishedAt: null,
        lastStatus: null,
        lastDurationMs: null,
        lastError: null,
        lastResultJson: null,
      },
    });
    await row.update(patch);
  } catch (err) {
    logger.error('job_state_persist_failed', { name }, err as Error);
  }
}

export interface TickOutcome {
  status: JobStatus;
  durationMs: number;
  result?: Record<string, unknown>;
  error?: string;
}

export async function tick(def: JobDefinition): Promise<TickOutcome> {
  const startedAt = new Date();
  const cfg = await resolveJobConfig(def);
  if (!cfg.enabled) {
    await upsertState(def.name, {
      lastRunAt: startedAt,
      lastFinishedAt: startedAt,
      lastStatus: 'skipped_disabled',
      lastDurationMs: 0,
      lastError: null,
    });
    return { status: 'skipped_disabled', durationMs: 0 };
  }

  if (runningTicks.has(def.name)) {
    await upsertState(def.name, {
      lastRunAt: startedAt,
      lastFinishedAt: startedAt,
      lastStatus: 'skipped_reentrant',
      lastDurationMs: 0,
      lastError: null,
    });
    return { status: 'skipped_reentrant', durationMs: 0 };
  }
  runningTicks.add(def.name);
  await upsertState(def.name, { lastRunAt: startedAt });

  const t0 = Date.now();
  try {
    const lockResult = await withAdvisoryLock(def.name, () => def.handler());
    const durationMs = Date.now() - t0;
    if (!lockResult.acquired) {
      await upsertState(def.name, {
        lastFinishedAt: new Date(),
        lastStatus: 'skipped_locked',
        lastDurationMs: durationMs,
        lastError: null,
      });
      return { status: 'skipped_locked', durationMs };
    }
    const handlerResult = lockResult.value;
    const summary =
      handlerResult && typeof handlerResult === 'object' && 'summary' in handlerResult
        ? (handlerResult as { summary?: Record<string, unknown> }).summary
        : undefined;
    const lastResultJson = summary
      ? truncate(JSON.stringify(summary), RESULT_MAX)
      : null;
    await upsertState(def.name, {
      lastFinishedAt: new Date(),
      lastStatus: 'ok',
      lastDurationMs: durationMs,
      lastError: null,
      lastResultJson,
    });
    logger.info('job_tick_ok', { name: def.name, durationMs });
    return { status: 'ok', durationMs, result: summary };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    await upsertState(def.name, {
      lastFinishedAt: new Date(),
      lastStatus: 'error',
      lastDurationMs: durationMs,
      lastError: truncate(message, ERROR_MAX),
    });
    logger.error('job_tick_failed', { name: def.name, durationMs }, err as Error);
    return { status: 'error', durationMs, error: message };
  } finally {
    runningTicks.delete(def.name);
  }
}

export function isTickRunning(name: string): boolean {
  return runningTicks.has(name);
}
```

- [ ] **Step 4: Re-run test, verify pass**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/runner.test.ts
```

Expected: 5/5 passing.

- [ ] **Step 5: Commit**

```bash
git add backend/src/jobs/runner.ts backend/test/jobs/runner.test.ts
git commit -m "feat(jobs): add runner.tick with re-entrancy, lock, last-run upsert"
```

---

## Task 5: Registry (`defineJob`, `startAllJobs`, reconcile loop)

**Files:**
- Create: `backend/src/jobs/registry.ts`
- Create: `backend/src/jobs/index.ts`
- Create: `backend/test/jobs/registry.test.ts`

- [ ] **Step 1: Write the failing registry test**

`backend/test/jobs/registry.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../../src/models');
let registry: typeof import('../../src/jobs/registry');

before(async () => {
  models = await import('../../src/models');
  await models.sequelize.sync();
  registry = await import('../../src/jobs/registry');
});

after(async () => {
  registry.stopAllJobs();
  await models.sequelize.close();
});

beforeEach(async () => {
  registry.__resetForTest();
  await models.Job.destroy({ where: {}, truncate: true });
});

test('defineJob registers definition and listJobs returns view', async () => {
  registry.defineJob({
    name: 'reg_a',
    cronDefault: '*/4 * * * *',
    enabledDefault: true,
    handler: async () => ({}),
  });
  const views = await registry.listJobs();
  assert.equal(views.length, 1);
  assert.equal(views[0].name, 'reg_a');
  assert.equal(views[0].cron, '*/4 * * * *');
  assert.equal(views[0].enabled, true);
  assert.equal(views[0].source.enabled, 'env');
  assert.ok(views[0].nextRunAt && new Date(views[0].nextRunAt).getTime() > Date.now());
});

test('duplicate defineJob throws', async () => {
  registry.defineJob({
    name: 'reg_dup',
    cronDefault: '*/4 * * * *',
    enabledDefault: true,
    handler: async () => ({}),
  });
  assert.throws(() =>
    registry.defineJob({
      name: 'reg_dup',
      cronDefault: '*/5 * * * *',
      enabledDefault: false,
      handler: async () => ({}),
    }),
  );
});

test('runJobByName triggers tick and upserts row', async () => {
  let calls = 0;
  registry.defineJob({
    name: 'reg_run',
    cronDefault: '*/4 * * * *',
    enabledDefault: true,
    handler: async () => { calls += 1; return {}; },
  });
  const outcome = await registry.runJobByName('reg_run');
  assert.equal(outcome.status, 'ok');
  assert.equal(calls, 1);
});

test('runJobByName throws on unknown', async () => {
  await assert.rejects(registry.runJobByName('nope'), /unknown job/);
});

test('reconcile picks up DB cron override on next iteration', async () => {
  registry.defineJob({
    name: 'reg_reconcile',
    cronDefault: '0 3 * * *',
    enabledDefault: true,
    handler: async () => ({}),
  });
  await registry.startAllJobs({ reconcileMs: null }); // disable timer
  let views = await registry.listJobs();
  assert.equal(views[0].cron, '0 3 * * *');

  await models.Job.upsert({
    name: 'reg_reconcile',
    enabledOverride: null,
    cronOverride: '*/15 * * * *',
    lastRunAt: null, lastFinishedAt: null, lastStatus: null,
    lastDurationMs: null, lastError: null, lastResultJson: null,
  });
  await registry.reconcileOnceForTest();
  views = await registry.listJobs();
  assert.equal(views[0].cron, '*/15 * * * *');
  assert.equal(views[0].source.cron, 'db');
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/registry.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement registry**

`backend/src/jobs/registry.ts`:

```ts
import cron, { type ScheduledTask } from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { Job } from '../models';
import { logger } from '../observability/logger';
import { resolveJobConfig } from './configResolver';
import { tick, type TickOutcome } from './runner';
import type { JobDefinition, JobStatusView } from './types';

const definitions = new Map<string, JobDefinition>();
const scheduled = new Map<string, { task: ScheduledTask; cron: string; enabled: boolean }>();
let reconcileTimer: NodeJS.Timeout | null = null;

export function defineJob(def: JobDefinition): void {
  if (definitions.has(def.name)) {
    throw new Error(`Job already defined: ${def.name}`);
  }
  if (!cron.validate(def.cronDefault)) {
    throw new Error(`Invalid cronDefault for job ${def.name}: ${def.cronDefault}`);
  }
  definitions.set(def.name, def);
}

export function listDefinitions(): JobDefinition[] {
  return Array.from(definitions.values());
}

function nextRunAt(cronExpr: string): string | null {
  try {
    return CronExpressionParser.parse(cronExpr).next().toISOString();
  } catch {
    return null;
  }
}

export async function listJobs(): Promise<JobStatusView[]> {
  const out: JobStatusView[] = [];
  for (const def of definitions.values()) {
    const cfg = await resolveJobConfig(def);
    const row = await Job.findOne({ where: { name: def.name } });
    out.push({
      name: def.name,
      cron: cfg.cron,
      enabled: cfg.enabled,
      source: cfg.source,
      lastRunAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastFinishedAt: row?.lastFinishedAt ? row.lastFinishedAt.toISOString() : null,
      lastStatus: (row?.lastStatus as JobStatusView['lastStatus']) ?? null,
      lastDurationMs: row?.lastDurationMs ?? null,
      lastError: row?.lastError ?? null,
      lastResultJson: row?.lastResultJson ?? null,
      nextRunAt: cfg.enabled ? nextRunAt(cfg.cron) : null,
    });
  }
  return out;
}

export async function runJobByName(name: string): Promise<TickOutcome> {
  const def = definitions.get(name);
  if (!def) throw new Error(`unknown job: ${name}`);
  return tick(def);
}

async function applyConfig(def: JobDefinition): Promise<void> {
  const cfg = await resolveJobConfig(def);
  const current = scheduled.get(def.name);
  const needsRebuild =
    !current ||
    current.cron !== cfg.cron ||
    current.enabled !== cfg.enabled;
  if (!needsRebuild) return;

  if (current) {
    current.task.stop();
    scheduled.delete(def.name);
  }
  if (!cfg.enabled) {
    logger.info('job_disabled', { name: def.name, cron: cfg.cron });
    return;
  }
  if (!cron.validate(cfg.cron)) {
    logger.error('job_reconcile_invalid_cron', { name: def.name, cron: cfg.cron });
    return;
  }
  const task = cron.schedule(cfg.cron, async () => {
    await tick(def);
  });
  scheduled.set(def.name, { task, cron: cfg.cron, enabled: cfg.enabled });
  logger.info('job_scheduled', { name: def.name, cron: cfg.cron });
}

export async function reconcileOnceForTest(): Promise<void> {
  for (const def of definitions.values()) {
    await applyConfig(def);
  }
}

export interface StartOptions {
  /** Reconcile interval in ms. Pass null to disable the timer (tests). */
  reconcileMs?: number | null;
}

export async function startAllJobs(opts: StartOptions = {}): Promise<void> {
  for (const def of definitions.values()) {
    await applyConfig(def);
  }
  const ms = opts.reconcileMs === undefined ? 60_000 : opts.reconcileMs;
  if (ms !== null) {
    reconcileTimer = setInterval(() => {
      void (async () => {
        for (const def of definitions.values()) {
          try {
            await applyConfig(def);
          } catch (err) {
            logger.error('job_reconcile_failed', { name: def.name }, err as Error);
          }
        }
      })();
    }, ms);
    reconcileTimer.unref?.();
  }
}

export function stopAllJobs(): void {
  for (const [, s] of scheduled) s.task.stop();
  scheduled.clear();
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

export function __resetForTest(): void {
  stopAllJobs();
  definitions.clear();
}
```

- [ ] **Step 4: Write `backend/src/jobs/index.ts`**

```ts
export { defineJob, startAllJobs, stopAllJobs, listJobs, runJobByName } from './registry';
export type {
  JobDefinition,
  JobStatusView,
  JobStatus,
  JobHandler,
  JobHandlerResult,
} from './types';
```

- [ ] **Step 5: Re-run registry test, verify pass**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/jobs/registry.test.ts
```

Expected: 5/5 passing.

- [ ] **Step 6: Commit**

```bash
git add backend/src/jobs/registry.ts backend/src/jobs/index.ts \
        backend/test/jobs/registry.test.ts
git commit -m "feat(jobs): add JobRegistry with defineJob, reconcile loop, listJobs"
```

---

## Task 6: Convert Yahoo quote scheduler → `defineJob`

**Files:**
- Modify: `backend/src/integrations/yahoo/scheduler.ts`
- Create: `backend/src/jobs/definitions/yahooQuote.ts`

- [ ] **Step 1: Strip cron-glue from `scheduler.ts`**

Delete from `backend/src/integrations/yahoo/scheduler.ts`:
- The `import cron, { type ScheduledTask } from 'node-cron';` line (no longer needed if not referenced elsewhere — keep `cron.validate` only if used; the file only used it inside `start*`; after deletion the import goes too).
- The module-level `let activeTask: ScheduledTask | null = null;`.
- The exported `startQuoteScheduler` function (lines ~259–294 in the existing file).
- The exported `stopQuoteScheduler` function (lines ~296–300).

Keep:
- `runQuoteSchedulerTick(configOverride?)` and all `TickResult` / `TickConfig` types.
- All persistence helpers + `dispatch` + `pickNext` usage.

After editing, the file should expose `runQuoteSchedulerTick` as its only scheduling-related export.

- [ ] **Step 2: Create job definition**

`backend/src/jobs/definitions/yahooQuote.ts`:

```ts
import { defineJob } from '../registry';
import { runQuoteSchedulerTick } from '../../integrations/yahoo/scheduler';
import * as env from '../../config/env';

defineJob({
  name: 'yahoo_quote_refresh',
  cronDefault: env.quoteTickCron,
  enabledDefault: env.quoteSchedulerEnabled,
  handler: async () => {
    const r = await runQuoteSchedulerTick();
    return { summary: { ...r } };
  },
});
```

- [ ] **Step 3: Update existing test for Yahoo scheduler**

If `backend/test/integrations/yahoo/scheduler*.test.ts` (or wherever Yahoo scheduler tests live) imports `startQuoteScheduler` or `stopQuoteScheduler`, delete those imports and any assertions on them. Tests calling `runQuoteSchedulerTick` directly are unaffected.

```bash
grep -rn "startQuoteScheduler\|stopQuoteScheduler" backend/test
```

For each match, remove the line. If the whole test was only exercising the start function, delete the test case.

- [ ] **Step 4: Run yahoo tests + typecheck**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/integrations/alphaVantage/*.test.ts
yarn run typecheck
```

Expected: tests pass (alphaVantage suite is the closest reference — Yahoo tests should also pass if they exist). Typecheck must be clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/integrations/yahoo/scheduler.ts \
        backend/src/jobs/definitions/yahooQuote.ts \
        backend/test
git commit -m "refactor(jobs): convert Yahoo quote scheduler to defineJob"
```

---

## Task 7: Convert daily snapshot scheduler → `defineJob`

**Files:**
- Modify: `backend/src/portfolio/dailySnapshotScheduler.ts`
- Create: `backend/src/jobs/definitions/dailySnapshot.ts`

- [ ] **Step 1: Strip cron-glue**

In `backend/src/portfolio/dailySnapshotScheduler.ts`:
- Delete `import cron, { type ScheduledTask } from 'node-cron';`.
- Delete the module-level `let activeTask`, `let runningTick` (runner owns these now).
- Delete the exported `startDailySnapshotScheduler` function.
- Keep `runDailySnapshotTick`, `DailySnapshotTickResult`, `DailySnapshotTickConfig`, `configFromEnv`.

- [ ] **Step 2: Create job definition**

`backend/src/jobs/definitions/dailySnapshot.ts`:

```ts
import { defineJob } from '../registry';
import { runDailySnapshotTick } from '../../portfolio/dailySnapshotScheduler';
import * as env from '../../config/env';

defineJob({
  name: 'daily_snapshot',
  cronDefault: env.dailySnapshotCron,
  enabledDefault: env.dailySnapshotEnabled,
  handler: async () => {
    const r = await runDailySnapshotTick();
    return { summary: { ...r } };
  },
});
```

- [ ] **Step 3: Drop start/stop assertions from existing test**

```bash
grep -rn "startDailySnapshotScheduler" backend/test
```

Remove any matching lines. The existing `runDailySnapshotTick` tests continue to work.

- [ ] **Step 4: Run snapshot tests + typecheck**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/portfolio/*.test.ts
yarn run typecheck
```

Expected: portfolio tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/dailySnapshotScheduler.ts \
        backend/src/jobs/definitions/dailySnapshot.ts \
        backend/test
git commit -m "refactor(jobs): convert daily snapshot scheduler to defineJob"
```

---

## Task 8: Convert forward income scheduler → `defineJob`

**Files:**
- Modify: `backend/src/portfolio/forwardIncomeScheduler.ts`
- Create: `backend/src/jobs/definitions/forwardIncome.ts`

- [ ] **Step 1: Strip cron-glue**

In `backend/src/portfolio/forwardIncomeScheduler.ts`:
- Delete `import cron, { type ScheduledTask } from 'node-cron';`.
- Delete `let activeTask`, `let runningTick`.
- Delete the exported `startForwardIncomeScheduler` function.
- Keep `runForwardIncomeTick`, `ForwardIncomeTickResult`, `ForwardIncomeTickConfig`.

- [ ] **Step 2: Create job definition**

`backend/src/jobs/definitions/forwardIncome.ts`:

```ts
import { defineJob } from '../registry';
import { runForwardIncomeTick } from '../../portfolio/forwardIncomeScheduler';
import * as env from '../../config/env';

defineJob({
  name: 'forward_income',
  cronDefault: env.forwardIncomeCron,
  enabledDefault: env.forwardIncomeEnabled,
  handler: async () => {
    const r = await runForwardIncomeTick();
    return { summary: { ...r } };
  },
});
```

- [ ] **Step 3: Drop start/stop assertions from existing test**

```bash
grep -rn "startForwardIncomeScheduler" backend/test
```

Remove any matches.

- [ ] **Step 4: Run portfolio tests + typecheck**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/portfolio/*.test.ts
yarn run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/portfolio/forwardIncomeScheduler.ts \
        backend/src/jobs/definitions/forwardIncome.ts \
        backend/test
git commit -m "refactor(jobs): convert forward income scheduler to defineJob"
```

---

## Task 9: Convert enrichment backfill scheduler → `defineJob`

**Files:**
- Modify: `backend/src/import/enrichmentBackfillScheduler.ts`
- Create: `backend/src/jobs/definitions/enrichmentBackfill.ts`

- [ ] **Step 1: Strip cron-glue**

In `backend/src/import/enrichmentBackfillScheduler.ts`:
- Delete `import cron, { type ScheduledTask } from 'node-cron';`.
- Delete `let activeTask`, `let runningTick`.
- Delete the exported `startEnrichmentBackfillScheduler` function.
- Keep `runEnrichmentBackfillTick`, `EnrichmentBackfillTickResult`, `EnrichmentBackfillTickConfig`.

- [ ] **Step 2: Create job definition**

`backend/src/jobs/definitions/enrichmentBackfill.ts`:

```ts
import { defineJob } from '../registry';
import { runEnrichmentBackfillTick } from '../../import/enrichmentBackfillScheduler';
import * as env from '../../config/env';

defineJob({
  name: 'enrichment_backfill',
  cronDefault: env.enrichmentBackfillCron,
  enabledDefault: env.enrichmentBackfillEnabled,
  handler: async () => {
    const r = await runEnrichmentBackfillTick();
    return { summary: { ...r } };
  },
});
```

- [ ] **Step 3: Drop start/stop assertions from existing test**

```bash
grep -rn "startEnrichmentBackfillScheduler" backend/test
```

Remove any matches.

- [ ] **Step 4: Run enrichment + import tests + typecheck**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/enrich*.test.ts
yarn run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/enrichmentBackfillScheduler.ts \
        backend/src/jobs/definitions/enrichmentBackfill.ts \
        backend/test
git commit -m "refactor(jobs): convert enrichment backfill scheduler to defineJob"
```

---

## Task 10: Convert USD/CAD backfill → daily `defineJob`

**Files:**
- Create: `backend/src/jobs/definitions/usdCadBackfill.ts`
- Modify: `backend/src/server.ts` (boot IIFE removed in Task 11; here we only add the definition)

- [ ] **Step 1: Create job definition**

`backend/src/jobs/definitions/usdCadBackfill.ts`:

```ts
import { defineJob } from '../registry';
import { backfillUsdCadHistory } from '../../fx/backfillUsdCadHistory';
import { logger } from '../../observability/logger';

defineJob({
  name: 'usdcad_backfill',
  cronDefault: '0 12 * * *', // daily noon UTC
  enabledDefault: true,
  handler: async () => {
    const today = new Date().toISOString().slice(0, 10);
    const fiveYearsAgo = (() => {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 5);
      return d.toISOString().slice(0, 10);
    })();
    try {
      await backfillUsdCadHistory({ startDate: fiveYearsAgo, endDate: today });
      return { summary: { startDate: fiveYearsAgo, endDate: today, status: 'ok' } };
    } catch (err) {
      logger.error('usdcad_backfill_job_failed', {}, err as Error);
      throw err;
    }
  },
});
```

- [ ] **Step 2: Typecheck**

```bash
cd backend && yarn run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/jobs/definitions/usdCadBackfill.ts
git commit -m "refactor(jobs): convert USD/CAD backfill to daily defineJob"
```

---

## Task 11: Wire `startAllJobs` into `server.ts`

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Replace scheduler wiring**

Rewrite `backend/src/server.ts` to this exact content:

```ts
import fs from 'fs';
import app from './app';
import * as env from './config/env';
import { seedDemoData } from './demo/seedDemoData';
import { logger } from './observability/logger';
import { isS3ReceiptStorageEnabled } from './storage/receiptStorage';
// Register job definitions (side-effect imports).
import './jobs/definitions/yahooQuote';
import './jobs/definitions/dailySnapshot';
import './jobs/definitions/forwardIncome';
import './jobs/definitions/enrichmentBackfill';
import './jobs/definitions/usdCadBackfill';
import { startAllJobs } from './jobs';

const uploadDir = env.csvUploadDir;
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

async function start() {
  await seedDemoData();

  app.listen(env.port, () => {
    logger.info('server_started', {
      port: env.port,
      nodeEnv: env.nodeEnv,
      uploadDir,
      receiptStorage: isS3ReceiptStorageEnabled() ? 's3' : 'local',
    });
  });

  await startAllJobs();
}

start().catch((err) => {
  logger.error('server_start_failed', { port: env.port }, err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck + boot smoke**

```bash
cd backend && yarn run typecheck
yarn run dev &
DEV_PID=$!
sleep 5
kill $DEV_PID 2>/dev/null
wait $DEV_PID 2>/dev/null
```

Expected: typecheck clean; dev server boots and prints `server_started` plus `job_scheduled` lines for the five jobs in the logs.

- [ ] **Step 3: Commit**

```bash
git add backend/src/server.ts
git commit -m "refactor(jobs): replace per-scheduler start calls with startAllJobs"
```

---

## Task 12: `/api/jobs` routes (GET / PATCH / POST run)

**Files:**
- Create: `backend/src/jobs/api.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/test/integration/jobsApi.test.ts`

- [ ] **Step 1: Write the failing integration test**

`backend/test/integration/jobsApi.test.ts`:

```ts
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import express, { type Express } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-jobs-api.sqlite');

let app: Express;
let models: typeof import('../../src/models');
let registry: typeof import('../../src/jobs/registry');
let jobsRouter: import('express').Router;

async function authedRequest(
  method: string,
  url: string,
  isSuperadmin: boolean,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const addr = server.address() as { port: number };
        const r = await fetch(`http://127.0.0.1:${addr.port}${url}`, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-test-superadmin': isSuperadmin ? '1' : '0',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        server.close();
        resolve({ status: r.status, json: text ? JSON.parse(text) : null });
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });
  models = await import('../../src/models');
  registry = await import('../../src/jobs/registry');
  registry.__resetForTest();
  registry.defineJob({
    name: 'api_test_job',
    cronDefault: '*/15 * * * *',
    enabledDefault: true,
    handler: async () => ({ summary: { ok: true } }),
  });
  const mod = await import('../../src/jobs/api');
  jobsRouter = mod.default;
  app = express();
  app.use(express.json());
  // Stub auth: superadmin gated by header for tests.
  app.use((req, _res, next) => {
    (req as any).auth = {
      user: {
        id: 1,
        email: 'test@example.com',
        globalRole: req.headers['x-test-superadmin'] === '1' ? 'superadmin' : 'user',
      },
      household: { id: 1 },
      role: 'owner',
    };
    next();
  });
  app.use('/api/jobs', jobsRouter);
});

after(async () => {
  registry.stopAllJobs();
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.Job.destroy({ where: {}, truncate: true });
});

test('GET /api/jobs requires superadmin', async () => {
  const r = await authedRequest('GET', '/api/jobs', false);
  assert.equal(r.status, 403);
});

test('GET /api/jobs returns the registered job', async () => {
  const r = await authedRequest('GET', '/api/jobs', true);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  const job = r.json.find((j: any) => j.name === 'api_test_job');
  assert.ok(job);
  assert.equal(job.cron, '*/15 * * * *');
  assert.equal(job.enabled, true);
  assert.equal(job.source.enabled, 'env');
});

test('PATCH /api/jobs/:name persists overrides; null resets', async () => {
  let r = await authedRequest('PATCH', '/api/jobs/api_test_job', true, {
    enabled: false,
    cron: '*/30 * * * *',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.cron, '*/30 * * * *');
  assert.equal(r.json.source.enabled, 'db');
  assert.equal(r.json.source.cron, 'db');

  r = await authedRequest('PATCH', '/api/jobs/api_test_job', true, {
    enabled: null,
    cron: null,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.source.enabled, 'env');
  assert.equal(r.json.source.cron, 'env');
});

test('PATCH rejects invalid cron with 400', async () => {
  const r = await authedRequest('PATCH', '/api/jobs/api_test_job', true, {
    cron: 'not-a-cron',
  });
  assert.equal(r.status, 400);
});

test('POST /api/jobs/:name/run triggers handler', async () => {
  const r = await authedRequest('POST', '/api/jobs/api_test_job/run', true);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('POST /api/jobs/:unknown/run returns 404', async () => {
  const r = await authedRequest('POST', '/api/jobs/nope/run', true);
  assert.equal(r.status, 404);
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/integration/jobsApi.test.ts
```

Expected: FAIL (`../../src/jobs/api` missing).

- [ ] **Step 3: Implement API router**

`backend/src/jobs/api.ts`:

```ts
import { Router, type Request, type Response } from 'express';
import cron from 'node-cron';
import { Job } from '../models';
import { isSuperadmin } from '../auth/scope';
import { listJobs, runJobByName, listDefinitions } from './registry';

const router = Router();

router.use((req: Request, res: Response, next) => {
  if (!isSuperadmin(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
});

router.get('/', async (_req, res) => {
  const views = await listJobs();
  res.json(views);
});

router.patch('/:name', async (req, res) => {
  const name = req.params.name;
  const def = listDefinitions().find((d) => d.name === name);
  if (!def) {
    res.status(404).json({ error: 'unknown_job' });
    return;
  }
  const body = req.body as { enabled?: boolean | null; cron?: string | null };
  if (body.cron !== undefined && body.cron !== null && !cron.validate(body.cron)) {
    res.status(400).json({ error: 'invalid_cron' });
    return;
  }
  const patch: Partial<{ enabledOverride: boolean | null; cronOverride: string | null }> = {};
  if (body.enabled !== undefined) patch.enabledOverride = body.enabled;
  if (body.cron !== undefined) patch.cronOverride = body.cron;

  const [row] = await Job.findOrCreate({
    where: { name },
    defaults: {
      name,
      enabledOverride: null,
      cronOverride: null,
      lastRunAt: null,
      lastFinishedAt: null,
      lastStatus: null,
      lastDurationMs: null,
      lastError: null,
      lastResultJson: null,
    },
  });
  await row.update(patch);

  const views = await listJobs();
  const view = views.find((v) => v.name === name);
  res.json(view);
});

router.post('/:name/run', async (req, res) => {
  const name = req.params.name;
  const def = listDefinitions().find((d) => d.name === name);
  if (!def) {
    res.status(404).json({ error: 'unknown_job' });
    return;
  }
  const outcome = await runJobByName(name);
  res.json(outcome);
});

export default router;
```

- [ ] **Step 4: Mount router in `app.ts`**

In `backend/src/app.ts`, after the other `app.use('/api/...')` lines (around line 90 where `portfolioRouter` is mounted), add:

```ts
import jobsRouter from './jobs/api';
// ...
app.use('/api/jobs', jobsRouter);
```

Order: place after `app.use('/api', requireAuth);` (line 74) so the auth middleware runs first. The router itself enforces the superadmin gate.

- [ ] **Step 5: Re-run integration test, verify pass**

```bash
cd backend && yarn run tsx --import ./test/setup.ts --test test/integration/jobsApi.test.ts
```

Expected: 6/6 passing.

- [ ] **Step 6: Full backend test + typecheck**

```bash
cd backend && yarn run typecheck
yarn run test
yarn run test:integration
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add backend/src/jobs/api.ts backend/src/app.ts \
        backend/test/integration/jobsApi.test.ts
git commit -m "feat(jobs): add /api/jobs routes gated on superadmin"
```

---

## Task 13: Frontend `JobsTab` + types + routing

**Files:**
- Create: `frontend/src/types/jobs.ts`
- Create: `frontend/src/pages/settings/tabs/JobsTab.tsx`
- Create: `frontend/src/pages/settings/tabs/JobsTab.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/settings/SettingsPage.tsx`
- Modify: `frontend/src/pages/settings/useActiveSettingsTopTab.ts`

- [ ] **Step 1: Define API types**

`frontend/src/types/jobs.ts`:

```ts
export type JobStatus =
  | 'ok'
  | 'error'
  | 'skipped_disabled'
  | 'skipped_locked'
  | 'skipped_reentrant'

export interface JobView {
  name: string
  cron: string
  enabled: boolean
  source: { enabled: 'env' | 'db'; cron: 'env' | 'db' }
  lastRunAt: string | null
  lastFinishedAt: string | null
  lastStatus: JobStatus | null
  lastDurationMs: number | null
  lastError: string | null
  lastResultJson: string | null
  nextRunAt: string | null
}

export interface JobRunOutcome {
  status: JobStatus
  durationMs: number
  result?: Record<string, unknown>
  error?: string
}
```

- [ ] **Step 2: Write the failing tab test**

`frontend/src/pages/settings/tabs/JobsTab.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { JobsTab } from './JobsTab'
import * as api from '../../../lib/api'
import type { JobView } from '../../../types/jobs'

const baseJob: JobView = {
  name: 'daily_snapshot',
  cron: '0 3 * * *',
  enabled: true,
  source: { enabled: 'env', cron: 'env' },
  lastRunAt: '2026-05-26T03:00:00.000Z',
  lastFinishedAt: '2026-05-26T03:00:01.000Z',
  lastStatus: 'ok',
  lastDurationMs: 1234,
  lastError: null,
  lastResultJson: null,
  nextRunAt: '2026-05-27T03:00:00.000Z',
}

describe('JobsTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the job row from the API', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    render(<JobsTab />)
    await waitFor(() => expect(screen.getByText('daily_snapshot')).toBeInTheDocument())
    expect(screen.getByText('0 3 * * *')).toBeInTheDocument()
    expect(screen.getByText('ok')).toBeInTheDocument()
  })

  it('toggling enabled PATCHes the API', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    const patch = vi.spyOn(api, 'patchJson').mockResolvedValue({ ...baseJob, enabled: false })
    render(<JobsTab />)
    await waitFor(() => screen.getByText('daily_snapshot'))
    fireEvent.click(screen.getByRole('switch', { name: /daily_snapshot enabled/i }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/jobs/daily_snapshot', { enabled: false }))
  })

  it('Run now POSTs and shows the outcome', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue([baseJob])
    const post = vi.spyOn(api, 'postJson').mockResolvedValue({ status: 'ok', durationMs: 50 })
    render(<JobsTab />)
    await waitFor(() => screen.getByText('daily_snapshot'))
    fireEvent.click(screen.getByRole('button', { name: /run now: daily_snapshot/i }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/daily_snapshot/run'))
  })
})
```

- [ ] **Step 3: Run test, verify failure**

```bash
cd frontend && yarn run test -- JobsTab.test.tsx
```

Expected: FAIL (module not found).

- [ ] **Step 4: Implement `JobsTab`**

`frontend/src/pages/settings/tabs/JobsTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getJson, patchJson, postJson } from '../../../lib/api'
import type { JobView, JobRunOutcome } from '../../../types/jobs'

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  const diffMs = Date.now() - t
  if (diffMs < 0) return new Date(iso).toLocaleString()
  const s = Math.floor(diffMs / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(iso).toLocaleString()
}

export function JobsTab() {
  const [jobs, setJobs] = useState<JobView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    try {
      setJobs(await getJson<JobView[]>('/api/jobs'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load jobs')
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => {
      if (!document.hidden) void load()
    }, 10_000)
    return () => clearInterval(id)
  }, [load])

  const toggleEnabled = async (job: JobView) => {
    setBusy((b) => ({ ...b, [job.name]: true }))
    try {
      const updated = await patchJson<JobView>(`/api/jobs/${job.name}`, {
        enabled: !job.enabled,
      })
      setJobs((js) => js.map((j) => (j.name === job.name ? updated : j)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed')
    } finally {
      setBusy((b) => ({ ...b, [job.name]: false }))
    }
  }

  const runNow = async (job: JobView) => {
    setBusy((b) => ({ ...b, [job.name]: true }))
    try {
      const outcome = await postJson<JobRunOutcome>(`/api/jobs/${job.name}/run`)
      setError(outcome.status === 'error' ? `Run failed: ${outcome.error}` : null)
      await load()
      void outcome
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setBusy((b) => ({ ...b, [job.name]: false }))
    }
  }

  const resetOverrides = async (job: JobView) => {
    setBusy((b) => ({ ...b, [job.name]: true }))
    try {
      const updated = await patchJson<JobView>(`/api/jobs/${job.name}`, {
        enabled: null,
        cron: null,
      })
      setJobs((js) => js.map((j) => (j.name === job.name ? updated : j)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setBusy((b) => ({ ...b, [job.name]: false }))
    }
  }

  return (
    <div className="jobsTabRoot">
      {error && <p className="error" role="alert">{error}</p>}
      <table className="dataTable">
        <thead>
          <tr>
            <th>Job</th>
            <th>Cron</th>
            <th>Enabled</th>
            <th>Last Run</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Next Run</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.name}>
              <td>{j.name}</td>
              <td>
                <span>{j.cron}</span>{' '}
                <span className={`badge badge-${j.source.cron}`}>{j.source.cron}</span>
              </td>
              <td>
                <button
                  role="switch"
                  aria-checked={j.enabled}
                  aria-label={`${j.name} enabled`}
                  disabled={busy[j.name]}
                  onClick={() => void toggleEnabled(j)}
                >
                  {j.enabled ? 'on' : 'off'}
                </button>
                <span className={`badge badge-${j.source.enabled}`}>{j.source.enabled}</span>
              </td>
              <td>{formatRelative(j.lastRunAt)}</td>
              <td>{j.lastStatus ?? '—'}</td>
              <td>{j.lastDurationMs != null ? `${j.lastDurationMs}ms` : '—'}</td>
              <td>{formatRelative(j.nextRunAt)}</td>
              <td>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Run now: ${j.name}`}
                  disabled={busy[j.name]}
                  onClick={() => void runNow(j)}
                >
                  Run now
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy[j.name] || (j.source.enabled === 'env' && j.source.cron === 'env')}
                  onClick={() => void resetOverrides(j)}
                >
                  Reset to env
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 5: Re-run frontend test, verify pass**

```bash
cd frontend && yarn run test -- JobsTab.test.tsx
```

Expected: 3/3 passing.

- [ ] **Step 6: Add route, tab strip entry, and matcher**

In `frontend/src/App.tsx`:
1. Add import after the other tab imports (~line 28):

```ts
import { JobsTab } from './pages/settings/tabs/JobsTab'
```

2. Add route inside the `<Route path="settings" element={<SettingsPage />}>` block (next to the other `Route path="..." element={<XTab />}` lines, around line 70):

```tsx
<Route path="jobs" element={<JobsTab />} />
```

In `frontend/src/pages/settings/SettingsPage.tsx`:
1. Replace the `TOP_TABS` and `TOP_TAB_PATHS` constants with versions that include the Jobs tab and filter it by superadmin:

```tsx
const ALL_TOP_TABS: Array<TabItem & { superadminOnly?: boolean }> = [
  { value: 'settings', label: 'Settings' },
  { value: 'imports', label: 'Imports' },
  { value: 'enrichment', label: 'Enrichment' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'budgets', label: 'Budgets' },
  { value: 'categories', label: 'Categories' },
  { value: 'jobs', label: 'Jobs', superadminOnly: true },
]

const TOP_TAB_PATHS: Record<SettingsTopTab, string> = {
  settings: '/settings/display',
  imports: '/settings/imports',
  enrichment: '/settings/enrichment',
  contacts: '/settings/contacts',
  budgets: '/settings/budgets',
  categories: '/settings/categories',
  jobs: '/settings/jobs',
}
```

2. Inside the component, filter the tabs:

```tsx
const isSuperadmin = auth.user?.globalRole === 'superadmin'
const TOP_TABS: TabItem[] = ALL_TOP_TABS
  .filter((t) => !t.superadminOnly || isSuperadmin)
  .map(({ superadminOnly: _omit, ...t }) => t)
```

(Leave the rest of the file unchanged — `Tabs` still receives `TOP_TABS`.)

In `frontend/src/pages/settings/useActiveSettingsTopTab.ts`:
1. Add `'jobs'` to the `SettingsTopTab` union.
2. Add the matcher:

```ts
const isJobs = useMatch('/settings/jobs')
// ... below other branches:
if (isJobs) return 'jobs'
```

- [ ] **Step 7: Frontend typecheck + full test**

```bash
cd frontend && yarn run lint && yarn run test
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/types/jobs.ts \
        frontend/src/pages/settings/tabs/JobsTab.tsx \
        frontend/src/pages/settings/tabs/JobsTab.test.tsx \
        frontend/src/App.tsx \
        frontend/src/pages/settings/SettingsPage.tsx \
        frontend/src/pages/settings/useActiveSettingsTopTab.ts
git commit -m "feat(jobs): add superadmin-only Jobs tab to Settings"
```

---

## Task 14: End-to-end smoke + full CI run

**Files:** none (verification only).

- [ ] **Step 1: Run the full CI script**

```bash
yarn ci
```

Expected: all green (typecheck, backend unit + integration, frontend test, both builds, workflows).

- [ ] **Step 2: Manual smoke via dev server**

```bash
yarn dev &
DEV_PID=$!
sleep 6
# Hit the API as a superadmin (use a real session from your local DB or
# follow auth flow; if you have a superadmin user seeded, log in via the UI
# and visit /settings/jobs).
kill $DEV_PID 2>/dev/null
wait $DEV_PID 2>/dev/null
```

Expected: Settings tab strip shows a "Jobs" tab (only for superadmin); the page renders the five registered jobs (`yahoo_quote_refresh`, `daily_snapshot`, `forward_income`, `enrichment_backfill`, `usdcad_backfill`). "Run now" returns a status; toggling enabled flips the DB override and the source badge changes from `env` to `db`.

- [ ] **Step 3: Final commit (only if smoke turned up nothing)**

No code change in this task; nothing to commit.

---

## Self-Review (executed during plan authoring)

- **Spec coverage**
  - "Kill boilerplate" → Tasks 1, 4, 5 + per-job Tasks 6–10. ✓
  - "Runtime visibility (Settings tab)" → Tasks 12, 13. ✓
  - "Multi-instance safety (pg advisory lock)" → Task 2 (lock primitive) + Task 4 (runner uses it). ✓
  - "Env defaults + DB overrides" → Task 3 (configResolver). ✓
  - "Last-run upsert per Job row" → Task 1 (model) + Task 4 (runner upserts). ✓
  - "isSuperadmin gate" → Task 12 (router middleware) + Task 13 (frontend tab filter). ✓
  - "cron-parser nextRunAt" → Task 0 (dep) + Task 5 (`listJobs` uses it). ✓
  - "USD/CAD backfill becomes daily job" → Task 10. ✓
- **Placeholder scan:** No TBDs. All code present. Test commands have expected outcomes. ✓
- **Type consistency:** `JobLastStatus` (model) and `JobStatus` (types/runner) are intentionally the same string union. `tick` returns `TickOutcome`; API `POST /run` returns it verbatim. `JobStatusView` field names match between backend and frontend types. ✓
- **Open risk:** If any of the existing scheduler test files import the `start*` functions directly, the conversion tasks (6–9) leave a grep step + remove-line instructions. The plan does not enumerate those test files by name because they may not exist; the grep step is the explicit verification.
