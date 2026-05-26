# Tax Foundation (Phase P6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the runtime `FX rate missing for USD→CAD` error blocking the Tax page and expand the Reconciliation tab to surface missing-slip, slip-vs-transaction, and category misclassification issues.

**Architecture:** Replace the two private `toCad` functions in tax builders with a shared, robust FX helper that uses the existing `ensureFxRate` BoC fetcher and falls back to historical rates rather than throwing. Add an idempotent backfill service that seeds 5 years of USD/CAD daily rates on first boot. Build a reconciliation report layer (one detector per concern) wired through a new endpoint and a richer Reconciliation tab.

**Tech Stack:** TypeScript, Sequelize, Node's built-in `node:test` runner, Express, React + Vite. Decimal arithmetic via existing `decimal.js`-backed `D()` helper.

**Spec reference:** [docs/superpowers/specs/2026-05-25-tax-planning-platform-design.md](../specs/2026-05-25-tax-planning-platform-design.md) section 4 (P6) + section 7 (FX fix) + section 8.7 (Reconciliation expansion). Scenario-actuals-drift detector slides to P7 because scenarios don't exist yet.

---

## File Structure

**Created:**
- `backend/src/fx/toCad.ts` — shared FX helper used by both tax builders
- `backend/test/fx/toCad.test.ts` — unit tests for the helper
- `backend/src/fx/backfillUsdCadHistory.ts` — idempotent historical backfill service
- `backend/test/fx/backfillUsdCadHistory.test.ts` — backfill tests
- `backend/src/tax/reconciliation/types.ts` — shared types for the reconciliation report
- `backend/src/tax/reconciliation/missingSlipDetector.ts` — find txns categorised as slip-type income with no matching slip
- `backend/test/tax/reconciliation/missingSlipDetector.test.ts`
- `backend/src/tax/reconciliation/slipDivergenceDetector.ts` — compare slip box totals against categorised txn totals
- `backend/test/tax/reconciliation/slipDivergenceDetector.test.ts`
- `backend/src/tax/reconciliation/categoryMisclassDetector.ts` — flag dividend txns whose Security record contradicts the category eligibility
- `backend/test/tax/reconciliation/categoryMisclassDetector.test.ts`
- `backend/src/tax/reconciliation/buildReport.ts` — orchestrator that runs all detectors and returns a `ReconciliationReport`
- `backend/test/tax/reconciliation/buildReport.test.ts`
- `backend/test/routes/tax-reconciliation.test.ts` — route integration test
- `frontend/src/hooks/useReconciliation.ts` — fetches the report

**Modified:**
- `backend/src/tax/builders/buildPersonalFacts.ts` — replace local `toCad` with import; drop the local function
- `backend/src/tax/builders/buildCorpFacts.ts` — same
- `backend/src/index.ts` (or wherever app boot lives — engineer must locate during Task 5) — invoke backfill once on startup, non-blocking
- `backend/src/routes/tax.ts` — add `GET /api/tax/personal/:year/reconciliation` route
- `frontend/src/pages/tax/ReconciliationTab.tsx` — render expanded report with sections per detector

---

## Conventions to follow

- Test framework: Node's built-in `node:test`. Pattern (mirrors `backend/test/unifyToCad.test.ts`):
  ```ts
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  ```
- DB-touching tests: `await sequelize.sync({ force: true })` inside `beforeEach`. Reference: `backend/test/tax/buildPersonalFacts.test.ts:11`.
- Decimal arithmetic: `import { D } from '../../tax/util/decimal'` then `D('123.45')`. Never use raw `number` in money math.
- FxRate `.rate` column is a string (DECIMAL(20,8)). Cast via `Number(row.rate)` or pass to `.times(row.rate as unknown as string)`.
- Commit messages: conventional commits (`fix:`, `feat:`, `test:`, `refactor:`). No `Co-Authored-By` line ever (per `~/.claude/CLAUDE.md`).
- Each task ends with a commit; do not batch.

---

## Part A — Shared FX helper (replaces both broken `toCad` locals)

### Task 1: Create the shared FX helper

**Files:**
- Create: `backend/src/fx/toCad.ts`
- Create: `backend/test/fx/toCad.test.ts`

The current local `toCad` in `buildPersonalFacts.ts:196-204` and the identical one in `buildCorpFacts.ts:184-196` query `FxRate` directly with a `Op.lte` lookup and throw if no row exists. That's the bug producing the `FX rate missing for USD→CAD on/before 2025-01-01` error.

The fix follows the same shape as `backend/src/networth/aggregate.ts:67-91` `looseHistoricalFxLookup`: try `ensureFxRate` first (which itself does DB cache + BoC fetch), then fall back to nearest historical row on/before the date, then any row for the pair, only throwing if zero rows exist at all.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/fx/toCad.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { FxRate } from '../../src/models';
import { D } from '../../src/tax/util/decimal';
import { toCad } from '../../src/fx/toCad';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('CAD short-circuits without DB or HTTP', async () => {
  const result = await toCad(D('100'), 'CAD', '2025-06-15');
  assert.equal(result.cad.toFixed(2), '100.00');
  assert.equal(result.source, 'cad_identity');
  assert.equal(result.rate, 1);
});

test('uses cached recent FxRate when available', async () => {
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2025-06-14',
    rate: '1.36',
    source: 'bank_of_canada',
    fetchedAt: new Date(),
  });
  const result = await toCad(D('100'), 'USD', '2025-06-15');
  assert.equal(result.cad.toFixed(2), '136.00');
  assert.equal(result.rate, 1.36);
  // Source should be 'cached' or 'fetched' — both come from ensureFxRate.
  assert.ok(['cached', 'fetched'].includes(result.source));
});

test('falls back to nearest historical row when ensureFxRate cannot find one', async () => {
  // Old rate from 2020, well outside ensureFxRate's 7-day cache window.
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2020-03-15',
    rate: '1.40',
    source: 'manual_seed',
    fetchedAt: new Date(),
  });
  // Asking for a rate in 2025: ensureFxRate's 7-day window won't match the 2020 row.
  // ensureFxRate will also attempt to fetch from BoC; in this test we don't have
  // network. The fallback path should still find the 2020 row and use it.
  const result = await toCad(D('100'), 'USD', '2025-06-15');
  assert.equal(result.cad.toFixed(2), '140.00');
  assert.equal(result.source, 'fallback_nearest');
  assert.equal(result.ratedDate, '2020-03-15');
});

test('falls back to any rate for the pair when no on-or-before row exists', async () => {
  // Only future-dated row exists. Real-world: a freshly-seeded test DB with one
  // present-day BoC row, asked for an early historical date.
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2026-01-01',
    rate: '1.38',
    source: 'manual_seed',
    fetchedAt: new Date(),
  });
  const result = await toCad(D('100'), 'USD', '2020-06-15');
  assert.equal(result.cad.toFixed(2), '138.00');
  assert.equal(result.source, 'fallback_any');
});

test('throws only when zero rows exist for the currency pair', async () => {
  // Empty FxRate table. ensureFxRate will attempt a BoC fetch which in CI
  // either succeeds (unexpected, harmless) or fails. Either way, no DB rows
  // exist for the pair, so the final fallback must throw.
  await assert.rejects(
    () => toCad(D('100'), 'XYZ', '2025-06-15'),
    /FX rate missing/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn workspace cashflow-backend run test test/fx/toCad.test.ts
```

Expected: FAIL with `Cannot find module '../../src/fx/toCad'` (file doesn't exist yet).

- [ ] **Step 3: Implement the helper**

```ts
// backend/src/fx/toCad.ts
import { Op } from 'sequelize';
import type { Decimal } from '../tax/util/decimal';
import { FxRate } from '../models/FxRate';
import { ensureFxRate } from './bankOfCanada';

export type ToCadSource =
  | 'cad_identity'
  | 'cached'
  | 'fetched'
  | 'fallback_nearest'
  | 'fallback_any';

export interface ToCadResult {
  /** Amount converted to CAD. */
  cad: Decimal;
  /** The FX rate used (1 for CAD→CAD). */
  rate: number;
  /** The publication date of the rate used. */
  ratedDate: string;
  /** Where the rate came from — useful for surfacing freshness warnings. */
  source: ToCadSource;
}

/**
 * Convert an amount to CAD using a robust historical FX lookup.
 *
 * Order of attempts:
 *   1. CAD short-circuit (no DB or HTTP).
 *   2. ensureFxRate(): same-day cache + BoC API fetch + persist. Returns
 *      `cached` if hit, `fetched` if it made an HTTP call.
 *   3. Nearest FxRate row on/before the date, no staleness cap.
 *   4. Any FxRate row for the pair (even future-dated, last resort).
 *   5. Throw only if zero rows exist for the pair anywhere.
 *
 * The throw is the last-resort signal that the system truly has no data for
 * this currency. Backfill / manual seeding fixes it.
 */
export async function toCad(
  amount: Decimal,
  currency: string,
  date: string,
): Promise<ToCadResult> {
  if (currency === 'CAD') {
    return { cad: amount, rate: 1, ratedDate: date, source: 'cad_identity' };
  }

  // Snapshot the existing cached row (if any) so we can tell `cached` from
  // `fetched` after ensureFxRate returns.
  const sevenDaysAgo = subtractDays(date, 7);
  const preExisting = await FxRate.findOne({
    where: {
      fromCurrency: currency,
      toCurrency: 'CAD',
      ratedDate: { [Op.gte]: sevenDaysAgo, [Op.lte]: date },
    },
    order: [['ratedDate', 'DESC']],
  });

  const fresh = await ensureFxRate(currency, 'CAD', date);
  if (fresh) {
    const source: ToCadSource =
      preExisting && preExisting.ratedDate === fresh.ratedDate ? 'cached' : 'fetched';
    return {
      cad: amount.times(String(fresh.rate)),
      rate: fresh.rate,
      ratedDate: fresh.ratedDate,
      source,
    };
  }

  // Fallback 1: nearest historical row, no staleness cap.
  const nearest = await FxRate.findOne({
    where: {
      fromCurrency: currency,
      toCurrency: 'CAD',
      ratedDate: { [Op.lte]: date },
    },
    order: [['ratedDate', 'DESC']],
  });
  if (nearest) {
    return {
      cad: amount.times(nearest.rate as unknown as string),
      rate: Number(nearest.rate),
      ratedDate: nearest.ratedDate,
      source: 'fallback_nearest',
    };
  }

  // Fallback 2: any row for the pair (even future-dated).
  const any = await FxRate.findOne({
    where: { fromCurrency: currency, toCurrency: 'CAD' },
    order: [['ratedDate', 'DESC']],
  });
  if (any) {
    return {
      cad: amount.times(any.rate as unknown as string),
      rate: Number(any.rate),
      ratedDate: any.ratedDate,
      source: 'fallback_any',
    };
  }

  throw new Error(
    `FX rate missing for ${currency}→CAD on/before ${date} (no rows for pair at all)`,
  );
}

function subtractDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn workspace cashflow-backend run test test/fx/toCad.test.ts
```

Expected: 5 tests PASS. (The `falls back to any rate` test depends on `ensureFxRate` returning null for `2020-06-15` — which it will because the only seeded row is `2026-01-01` which is outside the 7-day window and BoC fetch in tests will be a no-op or null.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/fx/toCad.ts backend/test/fx/toCad.test.ts
git commit --message="feat(fx): add shared toCad helper with historical fallback"
```

---

### Task 2: Replace `toCad` in `buildPersonalFacts.ts` with the shared helper

**Files:**
- Modify: `backend/src/tax/builders/buildPersonalFacts.ts:196-204` (remove local) and `:52, :88` (call sites)

The local function returns a `Decimal` directly. The new helper returns a `ToCadResult`. Call sites must extract `.cad`.

- [ ] **Step 1: Verify existing tests pass first (baseline)**

```bash
yarn workspace cashflow-backend run test test/tax/buildPersonalFacts.test.ts
```

Expected: PASS (some tests are `test.skip`'d; that's fine — they should remain skipped or pass).

- [ ] **Step 2: Edit `buildPersonalFacts.ts` to import the helper and remove the local**

Replace lines 196-204 (the entire local `async function toCad(...)` block) with nothing. Then at the top of the file (around line 14), add:

```ts
import { toCad } from '../../fx/toCad';
```

Replace line 52:

```ts
    const cad = await toCad(D(t.amount as unknown as string), t.currency ?? 'CAD', t.date as unknown as string);
```

with:

```ts
    const { cad } = await toCad(D(t.amount as unknown as string), t.currency ?? 'CAD', t.date as unknown as string);
```

Replace line 88 similarly:

```ts
    const { cad } = await toCad(D(a.amount as unknown as string), (a as any).currency ?? 'CAD', a.tradeDate as unknown as string);
```

- [ ] **Step 3: Run the existing tax tests to confirm no regression**

```bash
yarn workspace cashflow-backend run test test/tax/
```

Expected: All existing tax tests PASS (same set as before the edit).

- [ ] **Step 4: Run typecheck**

```bash
yarn workspace cashflow-backend run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/builders/buildPersonalFacts.ts
git commit --message="refactor(tax): use shared toCad in buildPersonalFacts"
```

---

### Task 3: Replace `toCad` in `buildCorpFacts.ts` with the shared helper

**Files:**
- Modify: `backend/src/tax/builders/buildCorpFacts.ts:184-196` (remove local) and `:44, :72` (call sites)

Identical pattern to Task 2.

- [ ] **Step 1: Edit `buildCorpFacts.ts` to import the helper and remove the local**

Delete lines 184-196. Add at the top of the file (around line 12):

```ts
import { toCad } from '../../fx/toCad';
```

Replace line 44 (the `await toCad(...)` call inside the `txns` loop):

```ts
      const { cad } = await toCad(
        D(t.amount as unknown as string),
        t.currency ?? 'CAD',
        t.date as unknown as string,
      );
```

Replace line 72 (the `await toCad(...)` call inside the `activity` loop):

```ts
    const { cad } = await toCad(
      D(a.amount as unknown as string),
      (a as unknown as { currency?: string }).currency ?? 'CAD',
      a.tradeDate as unknown as string,
    );
```

- [ ] **Step 2: Run the existing corp tests**

```bash
yarn workspace cashflow-backend run test test/tax/buildCorpFacts.test.ts test/tax/t2-scenarios.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

```bash
yarn workspace cashflow-backend run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/tax/builders/buildCorpFacts.ts
git commit --message="refactor(tax): use shared toCad in buildCorpFacts"
```

---

## Part B — FX backfill service

### Task 4: Create the USD/CAD historical backfill service

**Files:**
- Create: `backend/src/fx/backfillUsdCadHistory.ts`
- Create: `backend/test/fx/backfillUsdCadHistory.test.ts`

Calls Bank of Canada's Valet API once for a large date range and bulk-upserts rows. Idempotent: subsequent runs skip dates already present. Logs progress; returns count inserted.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/fx/backfillUsdCadHistory.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { FxRate } from '../../src/models';
import { backfillUsdCadHistory } from '../../src/fx/backfillUsdCadHistory';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('inserts rows for each observation returned from a stub fetcher', async () => {
  const stubFetcher = async (_start: string, _end: string) => ({
    observations: [
      { d: '2024-01-02', FXUSDCAD: { v: '1.3300' } },
      { d: '2024-01-03', FXUSDCAD: { v: '1.3320' } },
      { d: '2024-01-04', FXUSDCAD: { v: '1.3315' } },
    ],
  });

  const inserted = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });

  assert.equal(inserted, 3);
  const rows = await FxRate.findAll({
    where: { fromCurrency: 'USD', toCurrency: 'CAD' },
    order: [['ratedDate', 'ASC']],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].ratedDate, '2024-01-02');
  assert.equal(Number(rows[0].rate), 1.33);
});

test('is idempotent: a second run inserts zero new rows', async () => {
  const stubFetcher = async (_start: string, _end: string) => ({
    observations: [{ d: '2024-01-02', FXUSDCAD: { v: '1.3300' } }],
  });

  const first = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });
  assert.equal(first, 1);

  const second = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });
  assert.equal(second, 0);

  const rows = await FxRate.findAll();
  assert.equal(rows.length, 1);
});

test('skips observations that already exist (partial overlap)', async () => {
  await FxRate.create({
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    ratedDate: '2024-01-02',
    rate: '1.3300',
    source: 'manual_seed',
    fetchedAt: new Date(),
  });

  const stubFetcher = async (_start: string, _end: string) => ({
    observations: [
      { d: '2024-01-02', FXUSDCAD: { v: '1.3300' } }, // already exists
      { d: '2024-01-03', FXUSDCAD: { v: '1.3320' } }, // new
    ],
  });

  const inserted = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: stubFetcher,
  });
  assert.equal(inserted, 1);

  const rows = await FxRate.findAll({ order: [['ratedDate', 'ASC']] });
  assert.equal(rows.length, 2);
});

test('returns zero on fetcher hard failure (no throw)', async () => {
  const failingFetcher = async () => null;
  const inserted = await backfillUsdCadHistory({
    startDate: '2024-01-01',
    endDate: '2024-01-05',
    fetcher: failingFetcher,
  });
  assert.equal(inserted, 0);
  const rows = await FxRate.findAll();
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn workspace cashflow-backend run test test/fx/backfillUsdCadHistory.test.ts
```

Expected: FAIL with `Cannot find module '../../src/fx/backfillUsdCadHistory'`.

- [ ] **Step 3: Implement the backfill service**

```ts
// backend/src/fx/backfillUsdCadHistory.ts
import { FxRate } from '../models/FxRate';

interface BoCObservation {
  d: string;
  [series: string]: { v: string } | string;
}

interface BoCWindowResponse {
  observations?: BoCObservation[];
}

export type WindowFetcher = (
  startDate: string,
  endDate: string,
) => Promise<BoCWindowResponse | null>;

const SERIES = 'FXUSDCAD';

/**
 * Fetch a USD/CAD daily-rate window from the Bank of Canada Valet API.
 * Exported for use as the default fetcher; injectable via the `fetcher`
 * option for tests.
 */
export const defaultBoCWindowFetcher: WindowFetcher = async (startDate, endDate) => {
  const url = `https://www.bankofcanada.ca/valet/observations/${SERIES}/json?start_date=${startDate}&end_date=${endDate}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[backfillUsdCadHistory] HTTP ${response.status} for ${url}`);
      return null;
    }
    return (await response.json()) as BoCWindowResponse;
  } catch (err) {
    console.error('[backfillUsdCadHistory] fetch error', err);
    return null;
  }
};

interface BackfillOptions {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  fetcher?: WindowFetcher;
}

/**
 * Backfill historical USD→CAD rates from BoC for the given window.
 *
 * Idempotent: existing FxRate rows for the same (currency pair, rated_date)
 * are skipped. Returns the count of newly inserted rows.
 *
 * Non-fatal: a hard fetch failure logs and returns 0.
 */
export async function backfillUsdCadHistory(opts: BackfillOptions): Promise<number> {
  const fetcher = opts.fetcher ?? defaultBoCWindowFetcher;
  const data = await fetcher(opts.startDate, opts.endDate);
  if (!data?.observations) return 0;

  // Find which rated_dates we already have, so we skip them.
  const incomingDates = data.observations.map((o) => o.d);
  const existing = await FxRate.findAll({
    where: { fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: incomingDates },
    attributes: ['ratedDate'],
  });
  const existingSet = new Set(existing.map((r) => r.ratedDate));

  const rowsToCreate: Array<{
    fromCurrency: string;
    toCurrency: string;
    ratedDate: string;
    rate: string;
    source: string;
    fetchedAt: Date;
  }> = [];

  for (const obs of data.observations) {
    if (existingSet.has(obs.d)) continue;
    const seriesValue = obs[SERIES];
    if (!seriesValue || typeof seriesValue !== 'object' || !('v' in seriesValue)) continue;
    const rate = Number(seriesValue.v);
    if (!Number.isFinite(rate)) continue;
    rowsToCreate.push({
      fromCurrency: 'USD',
      toCurrency: 'CAD',
      ratedDate: obs.d,
      rate: String(rate),
      source: 'bank_of_canada_backfill',
      fetchedAt: new Date(),
    });
  }

  if (rowsToCreate.length === 0) return 0;
  await FxRate.bulkCreate(rowsToCreate);
  console.log(
    `[backfillUsdCadHistory] inserted ${rowsToCreate.length} USD→CAD rows ` +
      `(${opts.startDate}..${opts.endDate})`,
  );
  return rowsToCreate.length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn workspace cashflow-backend run test test/fx/backfillUsdCadHistory.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/fx/backfillUsdCadHistory.ts backend/test/fx/backfillUsdCadHistory.test.ts
git commit --message="feat(fx): add idempotent USD/CAD historical backfill service"
```

---

### Task 5: Wire backfill into application boot

**Files:**
- Modify: backend entrypoint (likely `backend/src/index.ts` or `backend/src/server.ts` — engineer must locate)

The service should run once, in the background, on first boot. It must not block server startup. It is idempotent so running it on every boot is acceptable (cheap when DB is already populated).

- [ ] **Step 1: Locate the backend entrypoint**

```bash
grep -rln "app.listen\|server.listen" backend/src | head -3
```

Pick the file where the server starts listening. Confirm by reading the first 30 lines.

- [ ] **Step 2: Add the backfill invocation after `app.listen`**

In the located entrypoint, immediately after `app.listen(...)`, add:

```ts
import { backfillUsdCadHistory } from './fx/backfillUsdCadHistory';

// ...existing app.listen call...

// Backfill USD→CAD daily noon rates for the last 5 years. Idempotent: skips
// existing rows. Runs in the background; failures are non-fatal (logged).
const today = new Date().toISOString().slice(0, 10);
const fiveYearsAgo = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
})();
backfillUsdCadHistory({ startDate: fiveYearsAgo, endDate: today }).catch((err) => {
  console.error('[boot] USD/CAD backfill failed (non-fatal):', err);
});
```

- [ ] **Step 3: Verify the backend still starts**

```bash
yarn workspace cashflow-backend run typecheck
```

Expected: no errors.

If the project has a quick "boot smoke" test, run it; otherwise typecheck is the gate.

- [ ] **Step 4: Commit**

```bash
git add backend/src/<entrypoint>.ts
git commit --message="feat(fx): backfill 5yr USD/CAD history on app boot"
```

---

## Part C — Reconciliation expansion

### Task 6: Create reconciliation report types

**Files:**
- Create: `backend/src/tax/reconciliation/types.ts`

Shared shape for all detectors so the orchestrator can collect uniformly and the frontend can render generically.

- [ ] **Step 1: Create the types file**

```ts
// backend/src/tax/reconciliation/types.ts

export type ReconciliationSeverity = 'info' | 'warning' | 'error';

export type ReconciliationCategory =
  | 'missing_slip'
  | 'slip_divergence'
  | 'category_misclass';

/**
 * A single detected reconciliation issue for a tax year.
 * `subjectRef` is a human-readable pointer ("Transaction #1234", "T4 from
 * EMPLOYER INC."); `details` is structured for the UI to render contextually.
 */
export interface ReconciliationFinding {
  category: ReconciliationCategory;
  severity: ReconciliationSeverity;
  subjectRef: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReconciliationReport {
  entityId: number;
  year: number;
  generatedAt: string;
  findings: ReconciliationFinding[];
  counts: Record<ReconciliationCategory, number>;
}
```

- [ ] **Step 2: Commit (types-only commit is fine; later tasks depend on this)**

```bash
git add backend/src/tax/reconciliation/types.ts
git commit --message="feat(tax-reconciliation): add report types"
```

---

### Task 7: Implement the missing-slip detector

**Files:**
- Create: `backend/src/tax/reconciliation/missingSlipDetector.ts`
- Create: `backend/test/tax/reconciliation/missingSlipDetector.test.ts`

Rule: if any transaction in the year has `finalCategory ∈ {employment_income}` for the entity but there is no `TaxSlip` of type `T4` for that entity+year, emit a `missing_slip` finding. Same for interest → T5 (any-issuer aggregate), dividend → T5 or T3 (engineer to decide initial scope: T5 only for v1).

Initial scope for P6: only the employment_income → T4 check. Other slip types can land in follow-ups.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/reconciliation/missingSlipDetector.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, TaxSlip, Transaction,
} from '../../../src/models';
import { detectMissingSlips } from '../../../src/tax/reconciliation/missingSlipDetector';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seedEntity() {
  const household = await Household.create({ name: 'Test' });
  const entity = await Entity.create({
    householdId: household.id,
    kind: 'personal',
    legalName: 'P',
    jurisdiction: 'CA-ON',
    fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

test('flags employment_income txn with no matching T4 slip', async () => {
  const { entity, account, household } = await seedEntity();
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'EMP', merchantClean: 'EMP',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);

  const findings = await detectMissingSlips(entity.id, 2024);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'missing_slip');
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].message, /T4/);
});

test('does not flag when matching T4 slip exists', async () => {
  const { entity, account, household } = await seedEntity();
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'EMP', merchantClean: 'EMP',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  await TaxSlip.create({
    entityId: entity.id, year: 2024, slipType: 'T4', issuer: 'EMP',
    boxValues: { box14: 5000 },
  } as never);

  const findings = await detectMissingSlips(entity.id, 2024);
  assert.equal(findings.length, 0);
});

test('does not flag when no employment_income txns exist', async () => {
  const { entity } = await seedEntity();
  const findings = await detectMissingSlips(entity.id, 2024);
  assert.equal(findings.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/missingSlipDetector.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the detector**

```ts
// backend/src/tax/reconciliation/missingSlipDetector.ts
import { Op } from 'sequelize';
import { TaxSlip, Transaction } from '../../models';
import type { ReconciliationFinding } from './types';

/**
 * Detect transactions whose category implies a slip should exist for the
 * year but no matching slip is recorded. Initial scope: employment_income → T4.
 */
export async function detectMissingSlips(
  entityId: number,
  year: number,
): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const employmentTxns = await Transaction.findAll({
    where: {
      entityId,
      date: { [Op.between]: [yearStart, yearEnd] },
      finalCategory: 'employment_income',
    },
  });

  if (employmentTxns.length === 0) return findings;

  const t4Count = await TaxSlip.count({
    where: { entityId, year, slipType: 'T4' },
  });

  if (t4Count === 0) {
    findings.push({
      category: 'missing_slip',
      severity: 'warning',
      subjectRef: `${employmentTxns.length} employment_income txn(s) in ${year}`,
      message: `Employment-income transactions exist but no T4 slip recorded for ${year}.`,
      details: {
        slipType: 'T4',
        txnCount: employmentTxns.length,
        txnIds: employmentTxns.map((t) => t.id),
      },
    });
  }

  return findings;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/missingSlipDetector.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/reconciliation/missingSlipDetector.ts backend/test/tax/reconciliation/missingSlipDetector.test.ts
git commit --message="feat(tax-reconciliation): detect missing T4 slips"
```

---

### Task 8: Implement the slip-vs-transaction divergence detector

**Files:**
- Create: `backend/src/tax/reconciliation/slipDivergenceDetector.ts`
- Create: `backend/test/tax/reconciliation/slipDivergenceDetector.test.ts`

Rule: compare `sum(boxValues.box14)` across all T4 slips for the entity+year against `sum(amount)` of `employment_income` transactions. If they differ by more than `$50` (matches threshold used by existing engine warning), emit a `slip_divergence` finding.

For P6 scope: T4 box14 only. T5 interest divergence is a fast follow-up.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/reconciliation/slipDivergenceDetector.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import { Account, Entity, Household, TaxSlip, Transaction } from '../../../src/models';
import { detectSlipDivergence } from '../../../src/tax/reconciliation/slipDivergenceDetector';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seed(opts: { txnAmount: string; slipBox14: number }) {
  const household = await Household.create({ name: 'Test' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: opts.txnAmount, currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'EMP', merchantClean: 'EMP',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);
  await TaxSlip.create({
    entityId: entity.id, year: 2024, slipType: 'T4', issuer: 'EMP',
    boxValues: { box14: opts.slipBox14 },
  } as never);
  return { entity };
}

test('no finding when slip and txn match within $50', async () => {
  const { entity } = await seed({ txnAmount: '5000', slipBox14: 5020 });
  const findings = await detectSlipDivergence(entity.id, 2024);
  assert.equal(findings.length, 0);
});

test('emits finding when slip and txn differ by more than $50', async () => {
  const { entity } = await seed({ txnAmount: '5000', slipBox14: 6000 });
  const findings = await detectSlipDivergence(entity.id, 2024);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'slip_divergence');
  assert.equal(findings[0].severity, 'warning');
  assert.match(findings[0].message, /1000\.00/);
});

test('no finding when neither slip nor txns exist', async () => {
  const household = await Household.create({ name: 'Empty' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const findings = await detectSlipDivergence(entity.id, 2024);
  assert.equal(findings.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/slipDivergenceDetector.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the detector**

```ts
// backend/src/tax/reconciliation/slipDivergenceDetector.ts
import { Op } from 'sequelize';
import { TaxSlip, Transaction } from '../../models';
import { D, sumD } from '../util/decimal';
import type { ReconciliationFinding } from './types';

const DIVERGENCE_THRESHOLD = D('50');

/**
 * Compare slip box totals against categorised transaction totals for the year.
 * Initial scope: T4 box14 vs sum(employment_income txns).
 */
export async function detectSlipDivergence(
  entityId: number,
  year: number,
): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const t4Slips = await TaxSlip.findAll({
    where: { entityId, year, slipType: 'T4' },
  });
  const employmentTxns = await Transaction.findAll({
    where: {
      entityId,
      date: { [Op.between]: [yearStart, yearEnd] },
      finalCategory: 'employment_income',
    },
  });

  if (t4Slips.length === 0 && employmentTxns.length === 0) return findings;

  const slipTotal = sumD(
    t4Slips.map((s) => {
      const box14 = (s.boxValues as Record<string, number | string> | undefined)?.box14;
      return box14 != null ? D(String(box14)) : D('0');
    }),
  );
  const txnTotal = sumD(employmentTxns.map((t) => D(t.amount as unknown as string)));

  const diff = slipTotal.minus(txnTotal).abs();
  if (diff.greaterThan(DIVERGENCE_THRESHOLD)) {
    findings.push({
      category: 'slip_divergence',
      severity: 'warning',
      subjectRef: `T4 box14 vs employment_income txns for ${year}`,
      message:
        `T4 box14 total ${slipTotal.toFixed(2)} differs from categorised ` +
        `employment_income transactions ${txnTotal.toFixed(2)} by ${diff.toFixed(2)}.`,
      details: {
        slipType: 'T4',
        box: 'box14',
        slipTotal: slipTotal.toFixed(2),
        txnTotal: txnTotal.toFixed(2),
        diff: diff.toFixed(2),
      },
    });
  }

  return findings;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/slipDivergenceDetector.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/reconciliation/slipDivergenceDetector.ts backend/test/tax/reconciliation/slipDivergenceDetector.test.ts
git commit --message="feat(tax-reconciliation): detect T4 vs txn divergence"
```

---

### Task 9: Implement the category-misclassification detector

**Files:**
- Create: `backend/src/tax/reconciliation/categoryMisclassDetector.ts`
- Create: `backend/test/tax/reconciliation/categoryMisclassDetector.test.ts`

Rule: for each dividend `InvestmentActivity` belonging to the entity's accounts in the year, check that `Security.dividendEligibility` matches what the categorisation implies. Initial scope: flag activities where `Security.dividendEligibility = 'non_eligible'` is set but the system would route to eligible (or vice versa) based on the source attribution. Concretely: if `dividendEligibility = 'unknown'`, emit `info` finding ("review needed"); if a dividend activity exists on a Security with `dividendEligibility = 'non_eligible'`, emit `info` finding noting it routed correctly but flag for user confirmation since that's the less common case.

For P6 scope: emit `info` findings for unknown-eligibility dividend activities, which is the highest-signal misclass risk.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/reconciliation/categoryMisclassDetector.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, InvestmentActivity, Security,
} from '../../../src/models';
import { detectCategoryMisclass } from '../../../src/tax/reconciliation/categoryMisclassDetector';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

async function seed() {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Inv', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { entity, account };
}

test('flags dividend activity whose Security has unknown eligibility', async () => {
  const { entity, account } = await seed();
  const security = await Security.create({
    symbol: 'FOO', name: 'Foo Corp', dividendEligibility: 'unknown',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'dividend', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
  } as never);

  const findings = await detectCategoryMisclass(entity.id, 2024);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'category_misclass');
  assert.equal(findings[0].severity, 'info');
  assert.match(findings[0].message, /unknown/i);
  assert.match(findings[0].subjectRef, /FOO/);
});

test('no finding when Security has explicit eligible/non_eligible setting', async () => {
  const { entity, account } = await seed();
  const security = await Security.create({
    symbol: 'BAR', name: 'Bar Corp', dividendEligibility: 'eligible',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'dividend', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
  } as never);

  const findings = await detectCategoryMisclass(entity.id, 2024);
  assert.equal(findings.length, 0);
});

test('ignores non-dividend activity types', async () => {
  const { entity, account } = await seed();
  const security = await Security.create({
    symbol: 'BAZ', name: 'Baz', dividendEligibility: 'unknown',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'interest', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
  } as never);

  const findings = await detectCategoryMisclass(entity.id, 2024);
  assert.equal(findings.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/categoryMisclassDetector.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the detector**

```ts
// backend/src/tax/reconciliation/categoryMisclassDetector.ts
import { Op } from 'sequelize';
import { Account, InvestmentActivity, Security } from '../../models';
import type { ReconciliationFinding } from './types';

/**
 * Detect dividend activities whose Security has `dividendEligibility = 'unknown'`,
 * meaning the engine routed them as eligible by default but the user should
 * confirm. Initial scope of category-misclassification detection.
 */
export async function detectCategoryMisclass(
  entityId: number,
  year: number,
): Promise<ReconciliationFinding[]> {
  const findings: ReconciliationFinding[] = [];
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const accounts = await Account.findAll({ where: { entityId } });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return findings;

  const activities = await InvestmentActivity.findAll({
    where: {
      accountId: accountIds,
      activityType: 'dividend',
      tradeDate: { [Op.between]: [yearStart, yearEnd] },
    },
    include: [{ model: Security, as: 'security' }],
  });

  for (const a of activities) {
    const security = (a as unknown as {
      security?: { symbol?: string; dividendEligibility?: string };
    }).security;
    const eligibility = security?.dividendEligibility ?? 'unknown';
    if (eligibility === 'unknown') {
      findings.push({
        category: 'category_misclass',
        severity: 'info',
        subjectRef: `${security?.symbol ?? '?'} dividend on ${a.tradeDate}`,
        message:
          `Dividend from ${security?.symbol ?? 'unknown security'} has ` +
          `dividendEligibility='unknown'. Defaulted to eligible — confirm or set explicitly.`,
        details: {
          securityId: a.securityId,
          symbol: security?.symbol,
          tradeDate: a.tradeDate,
          activityId: a.id,
        },
      });
    }
  }

  return findings;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/categoryMisclassDetector.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/reconciliation/categoryMisclassDetector.ts backend/test/tax/reconciliation/categoryMisclassDetector.test.ts
git commit --message="feat(tax-reconciliation): flag unknown dividend eligibility"
```

---

### Task 10: Implement the reconciliation report orchestrator

**Files:**
- Create: `backend/src/tax/reconciliation/buildReport.ts`
- Create: `backend/test/tax/reconciliation/buildReport.test.ts`

Runs all three detectors, aggregates findings, computes counts per category.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/tax/reconciliation/buildReport.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../../src/db';
import {
  Account, Entity, Household, InvestmentActivity, Security, Transaction,
} from '../../../src/models';
import { buildReconciliationReport } from '../../../src/tax/reconciliation/buildReport';

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('aggregates findings from all detectors and produces counts', async () => {
  const household = await Household.create({ name: 'T' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Inv', householdId: household.id, accountType: 'investment',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);

  // Trigger missing_slip
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E', merchantClean: 'E',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);

  // Trigger category_misclass
  const security = await Security.create({
    symbol: 'FOO', name: 'Foo', dividendEligibility: 'unknown',
  } as never);
  await InvestmentActivity.create({
    accountId: account.id, securityId: security.id,
    activityType: 'dividend', tradeDate: '2024-04-15',
    quantity: null, amount: '100', currency: 'CAD', fees: null,
  } as never);

  const report = await buildReconciliationReport(entity.id, 2024);
  assert.equal(report.entityId, entity.id);
  assert.equal(report.year, 2024);
  assert.equal(report.findings.length, 2);
  assert.equal(report.counts.missing_slip, 1);
  assert.equal(report.counts.category_misclass, 1);
  assert.equal(report.counts.slip_divergence, 0);
});

test('returns zero-finding report for an entity with no relevant data', async () => {
  const household = await Household.create({ name: 'Empty' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const report = await buildReconciliationReport(entity.id, 2024);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(report.counts, {
    missing_slip: 0,
    slip_divergence: 0,
    category_misclass: 0,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/buildReport.test.ts
```

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: Implement the orchestrator**

```ts
// backend/src/tax/reconciliation/buildReport.ts
import { detectMissingSlips } from './missingSlipDetector';
import { detectSlipDivergence } from './slipDivergenceDetector';
import { detectCategoryMisclass } from './categoryMisclassDetector';
import type {
  ReconciliationCategory,
  ReconciliationFinding,
  ReconciliationReport,
} from './types';

const ALL_CATEGORIES: ReconciliationCategory[] = [
  'missing_slip',
  'slip_divergence',
  'category_misclass',
];

export async function buildReconciliationReport(
  entityId: number,
  year: number,
): Promise<ReconciliationReport> {
  const [missing, divergence, misclass] = await Promise.all([
    detectMissingSlips(entityId, year),
    detectSlipDivergence(entityId, year),
    detectCategoryMisclass(entityId, year),
  ]);

  const findings: ReconciliationFinding[] = [...missing, ...divergence, ...misclass];

  const counts = ALL_CATEGORIES.reduce<Record<ReconciliationCategory, number>>(
    (acc, cat) => {
      acc[cat] = findings.filter((f) => f.category === cat).length;
      return acc;
    },
    { missing_slip: 0, slip_divergence: 0, category_misclass: 0 },
  );

  return {
    entityId,
    year,
    generatedAt: new Date().toISOString(),
    findings,
    counts,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn workspace cashflow-backend run test test/tax/reconciliation/buildReport.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/reconciliation/buildReport.ts backend/test/tax/reconciliation/buildReport.test.ts
git commit --message="feat(tax-reconciliation): aggregate report orchestrator"
```

---

### Task 11: Expose the report through a new API route

**Files:**
- Modify: `backend/src/routes/tax.ts` (add new route)
- Create: `backend/test/routes/tax-reconciliation.test.ts`

Add `GET /api/tax/personal/:year/reconciliation` that resolves the personal entity for the authenticated household and returns the report.

- [ ] **Step 1: Write the failing route test**

```ts
// backend/test/routes/tax-reconciliation.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { sequelize } from '../../src/db';
import { app } from '../../src/app'; // engineer: confirm app export path
import { Account, Entity, Household, Transaction } from '../../src/models';
import { createTestSession } from '../helpers/auth'; // engineer: use whatever existing helper

beforeEach(async () => {
  await sequelize.sync({ force: true });
});

test('GET /api/tax/personal/:year/reconciliation returns report shape', async () => {
  const household = await Household.create({ name: 'Test' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  });
  const account = await Account.create({
    name: 'Chk', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2024-03-15', amount: '5000', currency: 'CAD',
    finalCategory: 'employment_income',
    merchantRaw: 'E', merchantClean: 'E',
    importBatch: 'b', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'sif1',
  } as never);

  const agent = await createTestSession(household.id);
  const res = await agent.get('/api/tax/personal/2024/reconciliation');
  assert.equal(res.status, 200);
  assert.equal(res.body.entityId, entity.id);
  assert.equal(res.body.year, 2024);
  assert.equal(res.body.counts.missing_slip, 1);
  assert.equal(res.body.findings.length, 1);
});

test('returns 404 when no personal entity exists', async () => {
  const household = await Household.create({ name: 'NoEntity' });
  const agent = await createTestSession(household.id);
  const res = await agent.get('/api/tax/personal/2024/reconciliation');
  assert.equal(res.status, 404);
});
```

Engineer note: confirm the existing test-auth helper path. Pattern is mirrored in `backend/test/routes/tax.test.ts` and `backend/test/routes/routes-instalments.test.ts` — copy whichever pattern is in use.

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn workspace cashflow-backend run test test/routes/tax-reconciliation.test.ts
```

Expected: FAIL — route does not exist yet.

- [ ] **Step 3: Add the route to `backend/src/routes/tax.ts`**

At the top of `backend/src/routes/tax.ts` add the import:

```ts
import { buildReconciliationReport } from '../tax/reconciliation/buildReport';
```

Add the route handler (place it near the existing `/personal/:year/return` route for cohesion):

```ts
// GET /api/tax/personal/:year/reconciliation — slip / txn / categorisation issues.
router.get('/personal/:year/reconciliation', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      res.status(400).json({ error: 'invalid_year', message: 'Year must be between 2000 and 2100.' });
      return;
    }
    const entity = await Entity.findOne({
      where: { householdId: household.id, kind: 'personal' },
    });
    if (!entity) {
      res.status(404).json({
        error: 'no_personal_entity',
        message: 'No Personal entity for this household.',
      });
      return;
    }
    const report = await buildReconciliationReport(entity.id, year);
    res.json(report);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn workspace cashflow-backend run test test/routes/tax-reconciliation.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/tax.ts backend/test/routes/tax-reconciliation.test.ts
git commit --message="feat(tax-reconciliation): expose report via API endpoint"
```

---

### Task 12: Frontend hook + expanded ReconciliationTab

**Files:**
- Create: `frontend/src/hooks/useReconciliation.ts`
- Modify: `frontend/src/pages/tax/ReconciliationTab.tsx`

The hook follows the existing pattern in `frontend/src/hooks/useTaxReturn.ts` (loading/error/data shape). The tab renders the existing engine warnings (preserved for continuity) plus a new section per detector category, with collapsible details.

The frontend hook redefines `ReconciliationFinding`/`ReconciliationReport` as type-only mirrors of the backend types from Task 6. This matches existing project convention — `shared/api-types.ts` carries the heavyweight DTOs (`Account`, `Transaction`) but smaller, page-local types are commonly duplicated. If you prefer the shared route, add the three types to `shared/api-types.ts` and import from both backend and frontend; either is fine.

- [ ] **Step 1: Check the existing hook pattern**

```bash
cat frontend/src/hooks/useTaxReturn.ts
```

This tells you the API helper to use (likely `fetch` to a relative URL) and the expected loading/error/data return shape.

- [ ] **Step 2: Create the hook**

```ts
// frontend/src/hooks/useReconciliation.ts
import { useEffect, useState } from 'react';

export interface ReconciliationFinding {
  category: 'missing_slip' | 'slip_divergence' | 'category_misclass';
  severity: 'info' | 'warning' | 'error';
  subjectRef: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReconciliationReport {
  entityId: number;
  year: number;
  generatedAt: string;
  findings: ReconciliationFinding[];
  counts: Record<'missing_slip' | 'slip_divergence' | 'category_misclass', number>;
}

interface UseReconciliationResult {
  data: ReconciliationReport | null;
  error: string | null;
  loading: boolean;
}

export function useReconciliation(year: number): UseReconciliationResult {
  const [data, setData] = useState<ReconciliationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/tax/personal/${year}/reconciliation`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<ReconciliationReport>;
      })
      .then((report) => {
        if (!cancelled) setData(report);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [year]);

  return { data, error, loading };
}
```

- [ ] **Step 3: Replace `ReconciliationTab.tsx` with the expanded version**

Read the current file first (`frontend/src/pages/tax/ReconciliationTab.tsx`) so you preserve the existing engine-warnings rendering. Then write:

```tsx
// frontend/src/pages/tax/ReconciliationTab.tsx
import { useReconciliation, type ReconciliationFinding } from '../../hooks/useReconciliation';
import { useTaxReturn } from '../../hooks/useTaxReturn';

export function ReconciliationTab({ year }: { year: number }) {
  const taxReturn = useTaxReturn(year);
  const recon = useReconciliation(year);

  if (taxReturn.loading || recon.loading) return <p className="muted">Loading…</p>;

  const engineWarnings = taxReturn.data?.warnings ?? [];
  const report = recon.data;
  const reconError = recon.error;
  const returnError = taxReturn.error;

  const totalReconFindings = report?.findings.length ?? 0;

  return (
    <div>
      <h2>Reconciliation — {year}</h2>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <p>
          <strong>{engineWarnings.length}</strong>{' '}
          engine {engineWarnings.length === 1 ? 'warning' : 'warnings'} ·{' '}
          <strong>{totalReconFindings}</strong> reconciliation{' '}
          {totalReconFindings === 1 ? 'finding' : 'findings'}
        </p>
      </div>

      {returnError && <p className="error">Engine warnings unavailable: {returnError}</p>}
      {reconError && <p className="error">Reconciliation report unavailable: {reconError}</p>}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Engine warnings</h3>
        {engineWarnings.length === 0 ? (
          <p className="muted">No engine warnings for {year}.</p>
        ) : (
          <ul>
            {engineWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </section>

      {report && (
        <>
          <DetectorSection
            title="Missing slips"
            count={report.counts.missing_slip}
            findings={report.findings.filter((f) => f.category === 'missing_slip')}
          />
          <DetectorSection
            title="Slip vs. transaction divergence"
            count={report.counts.slip_divergence}
            findings={report.findings.filter((f) => f.category === 'slip_divergence')}
          />
          <DetectorSection
            title="Category review"
            count={report.counts.category_misclass}
            findings={report.findings.filter((f) => f.category === 'category_misclass')}
          />
        </>
      )}
    </div>
  );
}

function DetectorSection({
  title,
  count,
  findings,
}: {
  title: string;
  count: number;
  findings: ReconciliationFinding[];
}) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3>
        {title} <span className="muted">({count})</span>
      </h3>
      {findings.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {findings.map((f, i) => (
            <li key={i}>
              <strong>{f.subjectRef}</strong> — {f.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run frontend lint (lint-staged will run it on commit anyway)**

```bash
yarn workspace frontend run lint
```

Expected: no errors.

- [ ] **Step 5: Manual sanity check**

Start the app (`yarn dev`) and confirm:
1. The Tax tab loads without the original "FX rate missing for USD→CAD" banner.
2. The Reconciliation tab renders the three new sections plus the existing engine warnings.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/hooks/useReconciliation.ts frontend/src/pages/tax/ReconciliationTab.tsx
git commit --message="feat(tax-reconciliation): expanded ReconciliationTab UI"
```

---

## Self-review checklist (engineer: run before opening PR)

- [ ] All 12 task commits land on the branch in order.
- [ ] `yarn workspace cashflow-backend run test` passes (full suite, no regressions).
- [ ] `yarn workspace cashflow-backend run typecheck` passes.
- [ ] `yarn workspace frontend run lint` passes.
- [ ] Manual: launch dev, open Tax page, confirm the "FX rate missing" error is gone for a year that includes USD transactions.
- [ ] Manual: navigate to Reconciliation tab, confirm all four sections render (engine warnings + 3 detector sections) with appropriate empty states.
- [ ] No `Co-Authored-By` lines in any commit.
- [ ] Spec section P6 fully implemented; scenario-actuals-drift detector deferred to P7 (documented in plan header).
