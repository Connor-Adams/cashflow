# Enrichment Tab Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only enrichment settings tab into an actionable launchpad — clickable buckets that deep-link into filtered transactions, a "needs attention" worklist, and a coverage-over-spend-date trend — while rendering data the endpoint already returns but the UI throws away.

**Architecture:** Two backend surfaces grow (one filter helper gains 4 enum params; the stats endpoint gains 3 aggregates) plus one new coverage timeseries endpoint. The frontend tab is restructured into four stacked sections; every count/bar/row becomes a `<Link>` into `/transactions` (or `/rules`) via a single href helper. TransactionsPage gains a non-dropdown `enrichmentFilters` state consumed from the URL and shown as a dismissable chip.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), React 19 + react-router-dom v7, Tailwind v4, recharts, `@cashflow/shared` DTO contract. Backend tests: `node:test` via `tsx`, colocated. Frontend tests: vitest, colocated.

## Global Constraints

- Run all commands from repo root. Never install/run from a sub-directory.
- Sequelize must run on both SQLite (default) and Postgres (`DATABASE_URL` set). Branch on `sequelize.getDialect() === 'postgres'` for dialect-specific SQL.
- DTOs shared across front/back live ONLY in `shared/api-types.ts`, imported as `@cashflow/shared`. `frontend/src/types/api.ts` re-exports from there.
- Stats buckets key null values as the string `'(none)'`. The filter round-trip must treat `'(none)'` as `IS NULL`.
- No new primitive, no new table, no migration. This is derived views over the Transaction primitive + a read over `rules`.
- No `enriched_at` column exists. The trend is **coverage by spend date** (`transactions.date`), and chart copy must say "spend date".
- Backend single-file test: `cd backend && yarn tsx --import ./test/setup.ts --test src/<path>.test.ts`
- Frontend single-file test: `yarn workspace frontend run test <Name>`
- Household scoping: `householdId = isSuperadmin(req) ? null : currentAuth(req).household.id`. Superadmin (`null`) sees all rows; otherwise filter `household_id = ?`.

---

### Task 1: Backend — 4 enum filters in `buildTransactionFilterWhere`

**Files:**
- Modify: `backend/src/routes/transactions.ts` (function at line 127)
- Test: `backend/src/routes/buildTransactionFilterWhere.test.ts` (create)

**Interfaces:**
- Produces: `buildTransactionFilterWhere(req, source)` now honors `source.autoSource`, `source.autoConfidence`, `source.txnType`, `source.merchantCanonical`; each value `'(none)'` maps to `{ [Op.is]: null }`, any other string maps to exact equality on the corresponding column (`autoSource`, `autoConfidence`, `txnType`, `merchantCanonical`).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/routes/buildTransactionFilterWhere.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { buildTransactionFilterWhere } from './transactions';

// Minimal req stub: buildTransactionFilterWhere only uses visibleTransactionWhere(req),
// which for a superadmin-less stub returns a household clause. We assert only the
// keys this task adds, so a bare stub with no auth context is sufficient here:
// visibleTransactionWhere tolerates the test auth shape used elsewhere in this suite.
function reqStub() {
  return { } as unknown as import('express').Request;
}

test('autoConfidence exact match', () => {
  const w = buildTransactionFilterWhere(reqStub(), { autoConfidence: 'low' });
  assert.equal((w as Record<string, unknown>).autoConfidence, 'low');
});

test('autoSource (none) maps to IS NULL', () => {
  const w = buildTransactionFilterWhere(reqStub(), { autoSource: '(none)' });
  assert.deepEqual((w as Record<string, unknown>).autoSource, { [Op.is]: null });
});

test('txnType and merchantCanonical exact match', () => {
  const w = buildTransactionFilterWhere(reqStub(), {
    txnType: 'refund',
    merchantCanonical: 'Costco',
  });
  assert.equal((w as Record<string, unknown>).txnType, 'refund');
  assert.equal((w as Record<string, unknown>).merchantCanonical, 'Costco');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/buildTransactionFilterWhere.test.ts`
Expected: FAIL — `w.autoConfidence` is `undefined`.

> If `visibleTransactionWhere(req)` throws on the bare stub, copy the req stub shape from an existing transactions-route test (search `buildTransactionFilterWhere` / `visibleTransactionWhere` usage in `backend/test/`) and use that instead. Do not weaken the assertions.

- [ ] **Step 3: Add the four filters**

Insert immediately before `return where;` (currently line 229) in `buildTransactionFilterWhere`:

```ts
  // Enrichment deep-link filters (enrichment settings tab). Each bucket value is
  // matched exactly; the stats endpoint keys null buckets as '(none)', so that
  // sentinel maps to IS NULL to round-trip the link.
  for (const [param, column] of [
    ['autoSource', 'autoSource'],
    ['autoConfidence', 'autoConfidence'],
    ['txnType', 'txnType'],
    ['merchantCanonical', 'merchantCanonical'],
  ] as const) {
    const raw = source[param];
    if (typeof raw === 'string' && raw.length > 0) {
      where[column] = raw === '(none)' ? { [Op.is]: null } : raw;
    }
  }
```

(`Op` is already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/buildTransactionFilterWhere.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add backend/src/routes/transactions.ts backend/src/routes/buildTransactionFilterWhere.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(transactions): enrichment enum filters (autoSource/autoConfidence/txnType/merchantCanonical)"
```

---

### Task 2: Backend — extend `EnrichmentStats` with needs-attention aggregates

**Files:**
- Modify: `shared/api-types.ts` (`EnrichmentStats`, line 379)
- Modify: `backend/src/routes/transactions.ts` (`/enrichment/stats` handler, line 1911)
- Test: `backend/test/integration/enrichmentStats.test.ts` (create — needs a DB; integration tier)

**Interfaces:**
- Produces: `EnrichmentStats` gains `uncategorizedCount: number`, `merchantsMissingCanonical: number`, `deadRules: Array<{ ruleId: number; pattern: string; category: string | null }>`.

- [ ] **Step 1: Extend the DTO**

In `shared/api-types.ts`, add to `EnrichmentStats` (after `topRules`):

```ts
  uncategorizedCount: number
  merchantsMissingCanonical: number
  deadRules: Array<{ ruleId: number; pattern: string; category: string | null }>
```

- [ ] **Step 2: Write the failing integration test**

```ts
// backend/test/integration/enrichmentStats.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
// Reuse this suite's existing app + auth-cookie helpers. Match the import paths
// and login helper already used by other files in backend/test/integration/.
import { makeApp, loginAsHousehold } from './_helpers'; // adjust to actual helper module

test('enrichment stats reports needs-attention aggregates', async () => {
  const { app, agent } = await loginAsHousehold(makeApp());
  const res = await request(app).get('/api/transactions/enrichment/stats').set(agent);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.uncategorizedCount, 'number');
  assert.equal(typeof res.body.merchantsMissingCanonical, 'number');
  assert.ok(Array.isArray(res.body.deadRules));
});
```

> If `backend/test/integration/` has no shared app/login helper, copy the setup
> from the nearest existing integration test (e.g. one that hits an authed
> `/api/transactions/*` route) verbatim rather than inventing `_helpers`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn workspace cashflow-backend run test:integration`
(or the single-file integration invocation this repo uses)
Expected: FAIL — `uncategorizedCount` is `undefined`.

- [ ] **Step 4: Add the three queries**

In the `/enrichment/stats` handler, add three entries to the `Promise.all` array (alongside `topMerchants`, `topRules`):

```ts
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} final_category IS NULL`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions t ${hhClause}${hhClause ? ' AND' : ' WHERE'} merchant_canonical IS NULL`,
        { replacements: reps, type: QueryTypes.SELECT },
      ),
      sequelize.query<{ ruleId: number; pattern: string; category: string | null }>(
        `SELECT r.id AS "ruleId", r.merchant_pattern AS pattern, r.category AS category
         FROM rules r
         ${householdId == null ? '' : 'WHERE r.household_id = ?'}
         ${householdId == null ? 'WHERE' : 'AND'} r.id NOT IN (
           SELECT applied_rule_id FROM transactions WHERE applied_rule_id IS NOT NULL
         )
         ORDER BY r.id DESC LIMIT 15`,
        { replacements: householdId == null ? [] : [householdId], type: QueryTypes.SELECT },
      ),
```

Destructure them into the `const [ ... ] = await Promise.all([...])` binding as
`uncategorizedRow`, `missingCanonicalRow`, `deadRulesRows` (append to the list in
the same order).

Add to the `res.json({ ... })` payload:

```ts
      uncategorizedCount: Number(uncategorizedRow[0]?.n ?? 0),
      merchantsMissingCanonical: Number(missingCanonicalRow[0]?.n ?? 0),
      deadRules: deadRulesRows.map((r) => ({
        ruleId: r.ruleId,
        pattern: r.pattern,
        category: r.category,
      })),
```

- [ ] **Step 5: Run test to verify it passes**

Run the integration command from Step 3. Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add shared/api-types.ts backend/src/routes/transactions.ts backend/test/integration/enrichmentStats.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(enrichment): stats endpoint reports uncategorized, missing-canonical, dead-rule counts"
```

---

### Task 3: Backend — new `GET /enrichment/coverage` timeseries endpoint

**Files:**
- Modify: `shared/api-types.ts` (add `EnrichmentCoverage` type)
- Modify: `backend/src/routes/transactions.ts` (add route near the stats route)
- Test: `backend/test/integration/enrichmentCoverage.test.ts` (create)

**Interfaces:**
- Produces: `GET /api/transactions/enrichment/coverage?bucket=month|week` →
  `EnrichmentCoverage = { bucket: 'month' | 'week'; series: Array<{ period: string; total: number; cleared: number; withCanonical: number }> }`.
  `cleared` counts `NOT review_flag`; `withCanonical` counts `merchant_canonical IS NOT NULL`. Newest 12 buckets, ascending by period.

- [ ] **Step 1: Add the DTO**

In `shared/api-types.ts`:

```ts
export type EnrichmentCoverage = {
  bucket: 'month' | 'week'
  series: Array<{
    period: string
    total: number
    cleared: number
    withCanonical: number
  }>
}
```

- [ ] **Step 2: Write the failing integration test**

```ts
// backend/test/integration/enrichmentCoverage.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { makeApp, loginAsHousehold } from './_helpers'; // match Task 2's helper choice

test('coverage returns ascending monthly buckets with the four counts', async () => {
  const { app, agent } = await loginAsHousehold(makeApp());
  const res = await request(app)
    .get('/api/transactions/enrichment/coverage?bucket=month')
    .set(agent);
  assert.equal(res.status, 200);
  assert.equal(res.body.bucket, 'month');
  assert.ok(Array.isArray(res.body.series));
  for (const pt of res.body.series) {
    assert.equal(typeof pt.period, 'string');
    assert.ok(pt.cleared <= pt.total);
    assert.ok(pt.withCanonical <= pt.total);
  }
});

test('invalid bucket falls back to month', async () => {
  const { app, agent } = await loginAsHousehold(makeApp());
  const res = await request(app)
    .get('/api/transactions/enrichment/coverage?bucket=nonsense')
    .set(agent);
  assert.equal(res.body.bucket, 'month');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run the integration command. Expected: FAIL — 404 (route absent).

- [ ] **Step 4: Add the route**

Insert directly after the `/enrichment/stats` route (after line 2019) in `transactions.ts`:

```ts
/**
 * GET /api/transactions/enrichment/coverage?bucket=month|week
 *
 * Enrichment coverage bucketed by SPEND DATE (transactions.date). There is no
 * enrichment-event timestamp, so this answers "is recent spend better enriched
 * than old spend?" — not "when did enrichment run". Newest 12 buckets, ascending.
 */
router.get('/enrichment/coverage', async (req, res, next) => {
  try {
    const bucket: 'month' | 'week' = req.query.bucket === 'week' ? 'week' : 'month';
    const householdId = isSuperadmin(req) ? null : currentAuth(req).household.id;
    const hhClause = householdId == null ? '' : 'WHERE t.household_id = ?';
    const reps = householdId == null ? [] : [householdId];

    const isPg = sequelize.getDialect() === 'postgres';
    const periodExpr = isPg
      ? bucket === 'week'
        ? `to_char(t.date, 'IYYY-"W"IW')`
        : `to_char(t.date, 'YYYY-MM')`
      : bucket === 'week'
        ? `strftime('%Y-W%W', t.date)`
        : `strftime('%Y-%m', t.date)`;

    const rows = await sequelize.query<{
      period: string;
      total: number;
      cleared: number;
      withCanonical: number;
    }>(
      `SELECT ${periodExpr} AS period,
              COUNT(*) AS total,
              SUM(CASE WHEN NOT t.review_flag THEN 1 ELSE 0 END) AS cleared,
              SUM(CASE WHEN t.merchant_canonical IS NOT NULL THEN 1 ELSE 0 END) AS "withCanonical"
       FROM transactions t
       ${hhClause}
       GROUP BY period
       ORDER BY period DESC
       LIMIT 12`,
      { replacements: reps, type: QueryTypes.SELECT },
    );

    res.json({
      bucket,
      series: rows
        .map((r) => ({
          period: r.period,
          total: Number(r.total),
          cleared: Number(r.cleared),
          withCanonical: Number(r.withCanonical),
        }))
        .reverse(), // ascending for the chart x-axis
    });
  } catch (e) {
    next(e);
  }
});
```

> `NOT t.review_flag` works on both dialects (boolean in PG, 0/1 in SQLite). If
> the SQLite suite rejects `NOT` on an integer column, switch to
> `t.review_flag = 0` (SQLite) / `NOT t.review_flag` (PG) via the `isPg` branch.

- [ ] **Step 5: Run test to verify it passes**

Run the integration command. Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
yarn workspace cashflow-backend run typecheck
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add shared/api-types.ts backend/src/routes/transactions.ts backend/test/integration/enrichmentCoverage.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(enrichment): coverage-by-spend-date timeseries endpoint"
```

---

### Task 4: Frontend — TransactionsPage consumes enrichment filters + chip

**Files:**
- Modify: `frontend/src/pages/TransactionsPage.tsx` (URL-consume effect ~line 268; `load()` qs ~line 353; render area)
- Test: `frontend/src/pages/TransactionsPage.test.tsx` (add cases)

**Interfaces:**
- Consumes: backend filters from Task 1.
- Produces: arriving at `/transactions?autoConfidence=low` (or `autoSource`, `txnType`, `merchantCanonical`) filters the list and shows a dismissable chip; clearing it reloads unfiltered.

- [ ] **Step 1: Write the failing test**

```tsx
// add to frontend/src/pages/TransactionsPage.test.tsx
it('sends enrichment filter from the URL and shows a clearable chip', async () => {
  // Render the page at /transactions?autoConfidence=low using this suite's
  // existing router+render helper (match how other tests mount it).
  // Assert the list request URL carried autoConfidence=low:
  const reqUrl = await captureNextTransactionsRequest('/transactions?autoConfidence=low');
  expect(new URL(reqUrl, 'http://x').searchParams.get('autoConfidence')).toBe('low');
  // Assert a chip is shown and is clearable:
  expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
});
```

> Mirror the existing `dateFrom`/`dateTo` URL test (around line 106) for the
> request-capture mechanism; reuse it rather than inventing `captureNextTransactionsRequest`.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test TransactionsPage`
Expected: FAIL — request lacks `autoConfidence`; no chip.

- [ ] **Step 3: Add state + URL consumption + request wiring + chip**

Add state near the other filter state:

```tsx
  const [enrichmentFilters, setEnrichmentFilters] = useState<Record<string, string>>({})
```

In the URL-consume effect (line 268), add reads and apply:

```tsx
    const urlEnrich: Record<string, string> = {}
    for (const k of ['autoSource', 'autoConfidence', 'txnType', 'merchantCanonical'] as const) {
      const v = searchParams.get(k)
      if (v != null) urlEnrich[k] = v
    }
    const hasEnrich = Object.keys(urlEnrich).length > 0
```

Include `hasEnrich` in the `hasAny` OR; apply with `if (hasEnrich) setEnrichmentFilters(urlEnrich)`; add `setEnrichmentFilters` to the dep array.

In `load()`'s querystring builder (after line 365):

```tsx
      for (const [k, v] of Object.entries(enrichmentFilters)) {
        if (v) qs.set(k, v)
      }
```

Add `enrichmentFilters` to `load`'s `useCallback` dependency array.

Render a chip above the table when active:

```tsx
  {Object.keys(enrichmentFilters).length > 0 && (
    <div className="flex items-center gap-2 mb-2 text-sm">
      <span className="text-muted-foreground">Filtered:</span>
      {Object.entries(enrichmentFilters).map(([k, v]) => (
        <span key={k} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5">
          {ENRICH_FILTER_LABEL[k] ?? k}: {v === '(none)' ? 'none' : v}
        </span>
      ))}
      <button
        type="button"
        className="text-[var(--primary)] hover:underline"
        onClick={() => { setEnrichmentFilters({}); setPage(1) }}
      >
        Clear
      </button>
    </div>
  )}
```

Add the label lookup near the top of the module:

```tsx
const ENRICH_FILTER_LABEL: Record<string, string> = {
  autoSource: 'Source',
  autoConfidence: 'Confidence',
  txnType: 'Type',
  merchantCanonical: 'Merchant',
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test TransactionsPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/pages/TransactionsPage.tsx frontend/src/pages/TransactionsPage.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(transactions): consume enrichment deep-link filters with clearable chip"
```

---

### Task 5: Frontend — `enrichmentFilterHref` helper + clickable confidence/source/txnType charts

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/enrichmentFilterHref.ts`
- Create: `frontend/src/pages/settings/tabs/enrichment/enrichmentFilterHref.test.ts`
- Modify: `EnrichmentConfidenceChart.tsx`, `EnrichmentSourceChart.tsx`
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentTxnTypeChart.tsx` (+ test)

**Interfaces:**
- Produces: `enrichmentFilterHref(param: string, value: string): string` → `/transactions?<param>=<encoded value>`, passing `'(none)'` through literally (backend maps it to IS NULL). Charts render their bars/segments as `<Link to={enrichmentFilterHref(...)}>`.

- [ ] **Step 1: Write the failing helper test**

```ts
// enrichmentFilterHref.test.ts
import { test } from 'vitest';
import { expect } from 'vitest';
import { enrichmentFilterHref } from './enrichmentFilterHref';

test('encodes value', () => {
  expect(enrichmentFilterHref('autoConfidence', 'low')).toBe('/transactions?autoConfidence=low');
});
test('passes (none) through', () => {
  expect(enrichmentFilterHref('autoSource', '(none)')).toBe('/transactions?autoSource=%28none%29');
});
test('encodes spaces in merchant', () => {
  expect(enrichmentFilterHref('merchantCanonical', 'Whole Foods'))
    .toBe('/transactions?merchantCanonical=Whole+Foods');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace frontend run test enrichmentFilterHref`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// enrichmentFilterHref.ts
export function enrichmentFilterHref(param: string, value: string): string {
  const qs = new URLSearchParams({ [param]: value })
  return `/transactions?${qs.toString()}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn workspace frontend run test enrichmentFilterHref`
Expected: PASS (3 tests).

- [ ] **Step 5: Make SourceChart bars clickable**

In `EnrichmentSourceChart.tsx`, import `Link` and the helper, and wrap each row's content in a `Link` to `enrichmentFilterHref('autoSource', key)`. Replace the `<div key={key} className="flex items-center gap-[0.625rem]">` wrapper with:

```tsx
              <Link
                key={key}
                to={enrichmentFilterHref('autoSource', key)}
                className="flex items-center gap-[0.625rem] no-underline hover:opacity-80"
                aria-label={`View ${label} transactions`}
              >
```

(close with `</Link>`). Imports:

```tsx
import { Link } from 'react-router-dom'
import { enrichmentFilterHref } from './enrichmentFilterHref'
```

- [ ] **Step 6: Make ConfidenceChart legend clickable**

In `EnrichmentConfidenceChart.tsx`, import `Link` + helper. Wrap each legend `span` (the `counts.map` in the bottom legend row) so each band links to `enrichmentFilterHref('autoConfidence', c.key)`:

```tsx
          <Link
            key={c.key}
            to={enrichmentFilterHref('autoConfidence', c.key)}
            className="inline-flex items-center gap-[0.35rem] no-underline hover:opacity-80"
            aria-label={`View ${c.label} confidence transactions`}
          >
```

(close with `</Link>`, drop the now-duplicate `key` on the inner span.)

- [ ] **Step 7: Create the txn-type chart**

```tsx
// EnrichmentTxnTypeChart.tsx
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { enrichmentFilterHref } from './enrichmentFilterHref'

type Props = { byTxnType: Record<string, number> }

export function EnrichmentTxnTypeChart({ byTxnType }: Props) {
  const entries = Object.entries(byTxnType).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((acc, [, n]) => acc + n, 0)
  return (
    <Card>
      <div className="flex justify-between items-baseline mb-3">
        <h3 className="text-[0.95rem] font-semibold m-0">By type</h3>
      </div>
      {entries.length === 0 ? (
        <p className="muted text-sm m-0">No transactions yet.</p>
      ) : (
        <div className="grid gap-2 text-[0.78rem]">
          {entries.map(([key, n]) => {
            const pct = total > 0 ? Math.round((n / total) * 100) : 0
            const label = key === '(none)' ? 'none' : key
            return (
              <Link
                key={key}
                to={enrichmentFilterHref('txnType', key)}
                className="flex items-center gap-[0.625rem] no-underline hover:opacity-80"
                aria-label={`View ${label} transactions`}
              >
                <span className="w-[5rem] text-right text-[var(--muted-foreground)] truncate">{label}</span>
                <div className="flex-1 bg-[var(--muted)] h-[14px] rounded-[3px] overflow-hidden">
                  <div className="h-full rounded-[3px] bg-[var(--chart-4)]" style={{ width: `${pct}%` }} />
                </div>
                <span className="w-[6rem] text-[var(--foreground)] tabular-nums">{n.toLocaleString()} · {pct}%</span>
              </Link>
            )
          })}
        </div>
      )}
    </Card>
  )
}
```

- [ ] **Step 8: Write the txn-type chart test**

```tsx
// EnrichmentTxnTypeChart.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentTxnTypeChart } from './EnrichmentTxnTypeChart'

describe('EnrichmentTxnTypeChart', () => {
  it('links each type to a filtered transactions view', () => {
    render(
      <MemoryRouter>
        <EnrichmentTxnTypeChart byTxnType={{ purchase: 10, refund: 2 }} />
      </MemoryRouter>,
    )
    const link = screen.getByLabelText('View purchase transactions')
    expect(link).toHaveAttribute('href', '/transactions?txnType=purchase')
  })

  it('renders empty state', () => {
    render(<MemoryRouter><EnrichmentTxnTypeChart byTxnType={{}} /></MemoryRouter>)
    expect(screen.getByText(/no transactions yet/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 9: Run all five enrichment-chart tests**

Run: `yarn workspace frontend run test enrichment`
Expected: PASS (helper + txn-type + existing source/confidence still green).

- [ ] **Step 10: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/pages/settings/tabs/enrichment/enrichmentFilterHref.ts \
          frontend/src/pages/settings/tabs/enrichment/enrichmentFilterHref.test.ts \
          frontend/src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.tsx \
          frontend/src/pages/settings/tabs/enrichment/EnrichmentSourceChart.tsx \
          frontend/src/pages/settings/tabs/enrichment/EnrichmentTxnTypeChart.tsx \
          frontend/src/pages/settings/tabs/enrichment/EnrichmentTxnTypeChart.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(enrichment): clickable confidence/source/txnType charts deep-link to filtered transactions"
```

---

### Task 6: Frontend — `EnrichmentNeedsAttention` worklist section

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentNeedsAttention.tsx` (+ test)

**Interfaces:**
- Consumes: `EnrichmentStats` (needs `reviewFlagTrue`, `uncategorizedCount`, `merchantsMissingCanonical`, `deadRules`) from Task 2.
- Produces: `<EnrichmentNeedsAttention stats={stats} />` — a row of clickable cards, each linking to the relevant filtered view; cards with a zero count render muted and non-link.

- [ ] **Step 1: Write the failing test**

```tsx
// EnrichmentNeedsAttention.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentNeedsAttention } from './EnrichmentNeedsAttention'
import type { EnrichmentStats } from '../../../../types/api'

const base: EnrichmentStats = {
  total: 100, reviewFlagTrue: 5, reviewFlagFalse: 95, reviewedTrue: 0,
  bySource: {}, byConfidence: {}, byTxnType: {},
  isRecurringCount: 0, refundLinkedCount: 0, transferLinkedCount: 0,
  topCanonicalMerchants: [], topRules: [],
  uncategorizedCount: 7, merchantsMissingCanonical: 3, deadRules: [{ ruleId: 9, pattern: 'foo', category: null }],
}

describe('EnrichmentNeedsAttention', () => {
  it('links uncategorized to the null-category filter', () => {
    render(<MemoryRouter><EnrichmentNeedsAttention stats={base} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /uncategorized/i }))
      .toHaveAttribute('href', '/transactions?category=%28none%29')
  })
  it('links missing canonical to the merchantCanonical=(none) filter', () => {
    render(<MemoryRouter><EnrichmentNeedsAttention stats={base} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /missing canonical/i }))
      .toHaveAttribute('href', '/transactions?merchantCanonical=%28none%29')
  })
  it('renders dead-rule count linking to /rules', () => {
    render(<MemoryRouter><EnrichmentNeedsAttention stats={base} /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /dead rules/i })).toHaveAttribute('href', '/rules')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace frontend run test EnrichmentNeedsAttention`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// EnrichmentNeedsAttention.tsx
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import type { EnrichmentStats } from '../../../../types/api'

type Props = { stats: EnrichmentStats }

type Tile = { label: string; count: number; href: string }

export function EnrichmentNeedsAttention({ stats }: Props) {
  const tiles: Tile[] = [
    { label: 'Needs review', count: stats.reviewFlagTrue, href: '/transactions?reviewFlag=true' },
    { label: 'Uncategorized', count: stats.uncategorizedCount, href: '/transactions?category=%28none%29' },
    { label: 'Missing canonical', count: stats.merchantsMissingCanonical, href: '/transactions?merchantCanonical=%28none%29' },
    { label: 'Dead rules', count: stats.deadRules.length, href: '/rules' },
  ]
  return (
    <div className="grid gap-[0.625rem] [grid-template-columns:repeat(4,1fr)] max-[760px]:grid-cols-2 max-[420px]:grid-cols-1">
      {tiles.map((t) => {
        const body = (
          <>
            <p className="text-[0.72rem] font-semibold uppercase tracking-normal text-muted-foreground m-0">{t.label}</p>
            <p className="m-0 text-[1.55rem] font-bold tabular-nums">{t.count.toLocaleString()}</p>
          </>
        )
        return t.count > 0 ? (
          <Link key={t.label} to={t.href} aria-label={t.label}
            className="no-underline hover:opacity-80">
            <Card className="mb-0 border-[color-mix(in_srgb,var(--warning)_40%,var(--border))]">{body}</Card>
          </Link>
        ) : (
          <Card key={t.label} className="mb-0 opacity-60">{body}</Card>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn workspace frontend run test EnrichmentNeedsAttention`
Expected: PASS (3 tests).

> Note: `category=%28none%29` requires the list to treat `category=(none)` as
> `final_category IS NULL`. Task 1 added that only for the 4 enrichment columns,
> NOT for `category`. So in Task 8's integration step, verify the Uncategorized
> link lands on an empty-or-correct list; if `category=(none)` does not filter to
> nulls, change this tile's href to `/transactions?` with a dedicated
> `finalCategory` null filter OR add a `category === '(none)'` IS NULL branch to
> `buildTransactionFilterWhere`'s existing `source.category` block. Prefer the
> latter (one line: `where.finalCategory = v === '(none)' ? { [Op.is]: null } : v`).

- [ ] **Step 5: Apply the category null-filter branch (resolves the note above)**

In `buildTransactionFilterWhere`, change the existing category block (line 140-142) to:

```ts
  if (source.category) {
    const c = String(source.category);
    where.finalCategory = c === '(none)' ? { [Op.is]: null } : c;
  }
```

Add a backend test case to `buildTransactionFilterWhere.test.ts`:

```ts
test('category (none) maps to IS NULL', () => {
  const w = buildTransactionFilterWhere(reqStub(), { category: '(none)' });
  assert.deepEqual((w as Record<string, unknown>).finalCategory, { [Op.is]: null });
});
```

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/buildTransactionFilterWhere.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/pages/settings/tabs/enrichment/EnrichmentNeedsAttention.tsx \
          frontend/src/pages/settings/tabs/enrichment/EnrichmentNeedsAttention.test.tsx \
          backend/src/routes/transactions.ts backend/src/routes/buildTransactionFilterWhere.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(enrichment): needs-attention worklist + category=(none) null filter"
```

---

### Task 7: Frontend — `EnrichmentCoverageChart` (recharts)

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentCoverageChart.tsx` (+ test)

**Interfaces:**
- Consumes: `GET /api/transactions/enrichment/coverage` (Task 3) and the `EnrichmentCoverage` DTO.
- Produces: `<EnrichmentCoverageChart />` — self-fetching recharts area of `% cleared` and `% with canonical` over spend-date buckets, with a month/week toggle.

- [ ] **Step 1: Write the failing test**

```tsx
// EnrichmentCoverageChart.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnrichmentCoverageChart } from './EnrichmentCoverageChart'
import * as api from '../../../../lib/api'

describe('EnrichmentCoverageChart', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getJson').mockResolvedValue({
      bucket: 'month',
      series: [
        { period: '2026-04', total: 100, cleared: 80, withCanonical: 60 },
        { period: '2026-05', total: 50, cleared: 45, withCanonical: 40 },
      ],
    } as never)
  })
  it('renders the heading and notes spend date', async () => {
    render(<EnrichmentCoverageChart />)
    await waitFor(() => expect(screen.getByText(/coverage/i)).toBeInTheDocument())
    expect(screen.getByText(/spend date/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace frontend run test EnrichmentCoverageChart`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// EnrichmentCoverageChart.tsx
import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '@/components/ui/card'
import { getJson } from '../../../../lib/api'
import type { EnrichmentCoverage } from '../../../../types/api'

type Bucket = 'month' | 'week'

export function EnrichmentCoverageChart() {
  const [bucket, setBucket] = useState<Bucket>('month')
  const [data, setData] = useState<EnrichmentCoverage | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setErr(null)
    getJson<EnrichmentCoverage>(`/api/transactions/enrichment/coverage?bucket=${bucket}`)
      .then((d) => { if (live) setData(d) })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load coverage') })
    return () => { live = false }
  }, [bucket])

  const rows = (data?.series ?? []).map((p) => ({
    period: p.period,
    clearedPct: p.total > 0 ? Math.round((p.cleared / p.total) * 100) : 0,
    canonicalPct: p.total > 0 ? Math.round((p.withCanonical / p.total) * 100) : 0,
  }))

  return (
    <Card>
      <div className="flex justify-between items-baseline mb-3">
        <h3 className="text-[0.95rem] font-semibold m-0">Coverage over time</h3>
        <div className="flex gap-1 text-[0.72rem]">
          {(['month', 'week'] as Bucket[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBucket(b)}
              className={`px-2 py-0.5 rounded-full border ${b === bucket ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--muted-foreground)]'}`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>
      {err ? (
        <p className="error m-0" role="alert">{err}</p>
      ) : rows.length === 0 ? (
        <p className="muted text-sm m-0">No coverage data yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="period" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <Tooltip />
            <Area type="monotone" dataKey="clearedPct" name="% cleared" stroke="var(--success)" fill="var(--success)" fillOpacity={0.2} />
            <Area type="monotone" dataKey="canonicalPct" name="% canonical" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.15} />
          </AreaChart>
        </ResponsiveContainer>
      )}
      <p className="muted text-[0.7rem] mt-2 mb-0">Bucketed by spend date.</p>
    </Card>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `yarn workspace frontend run test EnrichmentCoverageChart`
Expected: PASS.

> If recharts `ResponsiveContainer` warns/zeroes height in jsdom, the test only
> asserts heading + "spend date" copy (always rendered), so it stays green.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/pages/settings/tabs/enrichment/EnrichmentCoverageChart.tsx \
          frontend/src/pages/settings/tabs/enrichment/EnrichmentCoverageChart.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(enrichment): coverage-over-spend-date area chart"
```

---

### Task 8: Frontend — assemble the restructured `EnrichmentTab` + top-list links + dead-rules list

**Files:**
- Modify: `frontend/src/pages/settings/tabs/EnrichmentTab.tsx`
- Modify: `frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.tsx` (merchant links + dead-rules list)
- Modify: `frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx`

**Interfaces:**
- Consumes: every component from Tasks 5-7 and the extended `EnrichmentStats`.
- Produces: the final four-section tab.

- [ ] **Step 1: Add merchant links + dead-rules list to EnrichmentTopLists**

Change the `Props` to also accept dead rules:

```tsx
type Props = {
  topRules: EnrichmentStats['topRules']
  topMerchants: EnrichmentStats['topCanonicalMerchants']
  deadRules: EnrichmentStats['deadRules']
}
```

Wrap each merchant row's name in a `Link` to `enrichmentFilterHref('merchantCanonical', m.name)`
(import the helper). Under the rules card, after the rules list, add:

```tsx
        {deadRules.length > 0 && (
          <div className="mt-3 pt-3 border-t border-[var(--border)]">
            <p className="text-[0.75rem] font-semibold text-[var(--warning-foreground)] m-0 mb-1">
              Dead rules ({deadRules.length}) — never fired
            </p>
            {deadRules.slice(0, MAX_ROWS).map((r) => (
              <div key={r.ruleId} className="flex justify-between text-[0.78rem] py-1">
                <code className="bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] px-[6px] py-[1px] rounded-[3px]">{r.pattern}</code>
                <Link to={`/rules?focus=${r.ruleId}`} className="text-[var(--primary)] no-underline hover:underline">View</Link>
              </div>
            ))}
          </div>
        )}
```

(import `enrichmentFilterHref`.)

- [ ] **Step 2: Rewrite EnrichmentTab to the four-section layout**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getJson } from '../../../lib/api'
import type { EnrichmentStats } from '../../../types/api'
import { EnrichmentStatRow } from './enrichment/EnrichmentStatRow'
import { EnrichmentNeedsAttention } from './enrichment/EnrichmentNeedsAttention'
import { EnrichmentCoverageChart } from './enrichment/EnrichmentCoverageChart'
import { EnrichmentConfidenceChart } from './enrichment/EnrichmentConfidenceChart'
import { EnrichmentSourceChart } from './enrichment/EnrichmentSourceChart'
import { EnrichmentTxnTypeChart } from './enrichment/EnrichmentTxnTypeChart'
import { EnrichmentTopLists } from './enrichment/EnrichmentTopLists'
import { EnrichmentBackfillCard } from './enrichment/EnrichmentBackfillCard'

export function EnrichmentTab() {
  const [stats, setStats] = useState<EnrichmentStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      setStats(await getJson<EnrichmentStats>('/api/transactions/enrichment/stats'))
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : 'Could not load stats')
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => { void loadStats() }, [loadStats])

  return (
    <div className="flex flex-col gap-[0.875rem]">
      <div className="flex justify-between items-center">
        <h2 className="text-[1.05rem] font-semibold m-0">Enrichment</h2>
        <Button type="button" variant="outline" size="sm" disabled={statsLoading} onClick={() => void loadStats()}>
          Refresh stats
        </Button>
      </div>

      {statsError && <p className="error" role="alert">{statsError}</p>}

      {stats ? (
        <>
          <EnrichmentNeedsAttention stats={stats} />
          <EnrichmentStatRow stats={stats} />
          <EnrichmentCoverageChart />
          <div className="grid grid-cols-3 gap-[0.625rem] max-[900px]:grid-cols-1">
            <EnrichmentConfidenceChart byConfidence={stats.byConfidence} />
            <EnrichmentSourceChart bySource={stats.bySource} />
            <EnrichmentTxnTypeChart byTxnType={stats.byTxnType} />
          </div>
          <EnrichmentTopLists topRules={stats.topRules} topMerchants={stats.topCanonicalMerchants} deadRules={stats.deadRules} />
        </>
      ) : statsLoading ? (
        <p className="muted">Loading enrichment stats…</p>
      ) : null}

      <EnrichmentBackfillCard onComplete={() => void loadStats()} />
    </div>
  )
}
```

- [ ] **Step 3: Update the tab test for the new sections**

In `EnrichmentTab.test.tsx`, ensure the mocked `/enrichment/stats` response includes the new fields (`uncategorizedCount`, `merchantsMissingCanonical`, `deadRules: []`, plus a non-empty `byTxnType`), mock `/enrichment/coverage` to return `{ bucket: 'month', series: [] }`, and assert the needs-attention "Uncategorized" label and the "By type" heading render. Keep existing assertions.

- [ ] **Step 4: Run the tab + full enrichment suite**

Run: `yarn workspace frontend run test EnrichmentTab` then `yarn workspace frontend run test enrichment`
Expected: PASS.

- [ ] **Step 5: Manual integration check**

Run `yarn dev`, open Settings → Enrichment. Verify: needs-attention tiles link through; a confidence/source/type bar opens `/transactions` filtered with a chip; the coverage chart renders with a month/week toggle; the Uncategorized tile lands on a genuinely uncategorized list (confirms Task 6 Step 5's `category=(none)` branch).

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git add frontend/src/pages/settings/tabs/EnrichmentTab.tsx \
          frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx \
          frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git commit -m "feat(enrichment): four-section tab with worklist, coverage, clickable breakdown, dead-rule list"
```

---

### Task 9: Full CI gate

- [ ] **Step 1: Run the whole suite**

Run: `yarn ci`
Expected: typecheck clean, all backend + frontend tests pass, both production builds succeed.

- [ ] **Step 2: Fix any fallout, re-run `yarn ci` until green.**

- [ ] **Step 3: Final commit if any fixes were needed.**

---

## Self-Review

**Spec coverage:**
- Backend 4 filters → Task 1 ✓
- Stats 3 new fields → Task 2 ✓
- Coverage endpoint (dual-dialect, spend-date) → Task 3 ✓
- TransactionsPage reads params → Task 4 ✓
- `enrichmentFilterHref` + clickable confidence/source + unused `byTxnType` rendered → Task 5 ✓
- Needs-attention worklist → Task 6 ✓ (+ category null-filter, the one spec gap surfaced during planning)
- Coverage chart → Task 7 ✓
- Four-section restructure + merchant links + dead-rules list + chrome consolidation → Task 8 ✓
- Error/empty independence → each component owns its empty/error state ✓
- Testing strategy → per-task colocated + integration + CI gate (Task 9) ✓

**Placeholder scan:** No TBD/TODO. Two steps reference "match the existing helper/test pattern" (Task 2 `_helpers`, Task 4 request-capture) — these point at concrete existing code to copy rather than inventing an interface, which is correct for an unread test-harness detail; assertions are fully specified.

**Type consistency:** `EnrichmentStats` extended once (Task 2), consumed with identical field names in Tasks 6 & 8. `EnrichmentCoverage` defined in Task 3, consumed in Task 7. `enrichmentFilterHref(param, value)` defined Task 5, used Tasks 5/6/8. `enrichmentFilters` state shape (`Record<string,string>`) consistent across Task 4.

**Scope:** Single tab + its endpoints. No decomposition needed.
