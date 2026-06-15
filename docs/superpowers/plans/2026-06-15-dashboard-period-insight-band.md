# Dashboard Period Insight Band Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's opaque hero net-spend number with a range-aware Period Insight Band that decomposes spend into real-cost vs loaned-out, compares against smart baselines, and names what changed.

**Architecture:** One new backend endpoint `GET /api/summary/period-insight` computes everything deterministically (no LLM) from existing data: pure helpers for range-kind detection + baseline windows (`periodRanges.ts`), owed-back decomposition (`periodInsight.ts`), and category movers, assembled in a `routes/summary.ts` handler. The frontend adds a `PeriodInsightBand` component that replaces the retired `HeroTile`. No new tables, no new primitive — pure derivations on Transaction + Counterparty (Reimbursement / partner splits).

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via tsx (backend unit tests, plain-object fixtures, no DB), React 19 + Vite + Tailwind v4 + recharts, vitest + @testing-library/react (frontend).

**Spec:** `docs/superpowers/specs/2026-06-15-dashboard-period-insight-band-design.md`

**Key conventions (verified against the codebase):**
- Backend summary aggregators are **pure functions** tested with plain-object fixtures — **no `Transaction.create`, no DB** in unit tests. Import `test` from `node:test`, `assert` from `node:assert/strict`.
- Decimal columns (`amount`, `partnerShareAmount`) are **strings**; parse with `num()` from `backend/src/util/numbers`.
- Transaction `date` is a `YYYY-MM-DD` string (DATEONLY). Account type is reached via the Account map, not on Transaction.
- `netSpend = totalSpend − totalCredits` is canonical in `aggregateDashboard.ts`; `realCost` derives **from** netSpend (`realCost = netSpend − owedBack`) — never redefine spend classification.
- There are **no** `getCalendarMonthRange`-style helpers; build range logic with UTC `Date` arithmetic.
- The shared DTO contract is `shared/api-types.ts`, imported as `@cashflow/shared`.

**Run commands:**
- One backend test file: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/<file>.test.ts`
- Filter by name: append `--test-name-pattern '<regex>'`
- Backend typecheck: `yarn workspace cashflow-backend run typecheck`
- One frontend test: `yarn workspace frontend run test PeriodInsightBand`
- Commit (this worktree has no node_modules — husky/lint-staged need the hoisted bin): prefix every commit with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`

---

## File Structure

**Backend (new):**
- `backend/src/summary/periodRanges.ts` — range-kind detection + baseline window computation (pure).
- `backend/src/summary/periodRanges.test.ts` — colocated tests.
- `backend/src/summary/periodInsight.ts` — owed-back decomposition + category movers (pure).
- `backend/src/summary/periodInsight.test.ts` — colocated tests.

**Backend (modified):**
- `backend/src/routes/summary.ts` — add the `/period-insight` handler.
- `backend/src/routeRegistry.ts` — no change needed (handler lives on the already-mounted `summaryRouter`); verify with a route test.

**Shared (modified):**
- `shared/api-types.ts` — add `PeriodInsightResp` and member types.

**Frontend (new):**
- `frontend/src/components/dashboard/PeriodInsightBand.tsx` — the band.
- `frontend/src/components/dashboard/PeriodInsightBand.test.tsx` — colocated tests.

**Frontend (modified):**
- `frontend/src/pages/DashboardPage.tsx` — fetch the endpoint, render the band, remove `HeroTile`.

**Frontend (deleted):**
- `frontend/src/components/dashboard/HeroTile.tsx` + `HeroTile.test.tsx` — retired.

---

## Phase 1 — Backend: period ranges (pure)

### Task 1: Range-kind detection

**Files:**
- Create: `backend/src/summary/periodRanges.ts`
- Test: `backend/src/summary/periodRanges.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/summary/periodRanges.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRangeKind } from './periodRanges';

test('detectRangeKind identifies a full calendar month', () => {
  assert.equal(detectRangeKind('2026-05-01', '2026-05-31'), 'calendar-month');
  assert.equal(detectRangeKind('2026-02-01', '2026-02-28'), 'calendar-month'); // non-leap Feb
});

test('detectRangeKind identifies a full calendar quarter', () => {
  assert.equal(detectRangeKind('2026-04-01', '2026-06-30'), 'calendar-quarter');
});

test('detectRangeKind identifies a full calendar year', () => {
  assert.equal(detectRangeKind('2026-01-01', '2026-12-31'), 'calendar-year');
});

test('detectRangeKind falls back to custom for partial ranges', () => {
  assert.equal(detectRangeKind('2026-05-03', '2026-05-31'), 'custom');
  assert.equal(detectRangeKind('2026-05-01', '2026-06-15'), 'custom');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodRanges.test.ts`
Expected: FAIL — `Cannot find module './periodRanges'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/summary/periodRanges.ts
export type PeriodRangeKind =
  | 'calendar-month'
  | 'calendar-quarter'
  | 'calendar-year'
  | 'custom';

export type DateRange = { from: string; to: string };

function parts(d: string): { y: number; m: number; day: number } {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m, day };
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function fmt(y: number, m: number, day: number): string {
  return `${y}-${pad(m)}-${pad(day)}`;
}
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based; day 0 of next month
}

export function detectRangeKind(from: string, to: string): PeriodRangeKind {
  const a = parts(from);
  const b = parts(to);
  // calendar year
  if (a.m === 1 && a.day === 1 && b.m === 12 && b.day === 31 && a.y === b.y) {
    return 'calendar-year';
  }
  // calendar quarter (same year, quarter-aligned start, quarter-end)
  const qStart = [1, 4, 7, 10];
  if (a.y === b.y && qStart.includes(a.m) && a.day === 1) {
    const endMonth = a.m + 2;
    if (b.m === endMonth && b.day === lastDay(b.y, b.m)) return 'calendar-quarter';
  }
  // calendar month
  if (a.y === b.y && a.m === b.m && a.day === 1 && b.day === lastDay(b.y, b.m)) {
    return 'calendar-month';
  }
  return 'custom';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodRanges.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/periodRanges.ts backend/src/summary/periodRanges.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(summary): detect calendar-aligned range kinds for period insight"
```

---

### Task 2: Prior-period and same-period-last-year windows

**Files:**
- Modify: `backend/src/summary/periodRanges.ts`
- Test: `backend/src/summary/periodRanges.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/summary/periodRanges.test.ts
import { priorPeriod, samePeriodLastYear } from './periodRanges';

test('priorPeriod returns the previous calendar month', () => {
  assert.deepEqual(priorPeriod('2026-05-01', '2026-05-31', 'calendar-month'), {
    from: '2026-04-01',
    to: '2026-04-30',
  });
  assert.deepEqual(priorPeriod('2026-01-01', '2026-01-31', 'calendar-month'), {
    from: '2025-12-01',
    to: '2025-12-31',
  });
});

test('priorPeriod returns previous quarter and year', () => {
  assert.deepEqual(priorPeriod('2026-04-01', '2026-06-30', 'calendar-quarter'), {
    from: '2026-01-01',
    to: '2026-03-31',
  });
  assert.deepEqual(priorPeriod('2026-01-01', '2026-12-31', 'calendar-year'), {
    from: '2025-01-01',
    to: '2025-12-31',
  });
});

test('priorPeriod for custom returns the prior equal-length span ending the day before', () => {
  // 2026-05-10..2026-05-19 is 10 days; prior span is 2026-04-30..2026-05-09
  assert.deepEqual(priorPeriod('2026-05-10', '2026-05-19', 'custom'), {
    from: '2026-04-30',
    to: '2026-05-09',
  });
});

test('samePeriodLastYear shifts calendar periods back one year, clamping Feb', () => {
  assert.deepEqual(samePeriodLastYear('2026-06-01', '2026-06-30', 'calendar-month'), {
    from: '2025-06-01',
    to: '2025-06-30',
  });
  // leap-day clamp: 2024-02-29 -> 2023-02-28
  assert.deepEqual(samePeriodLastYear('2024-02-01', '2024-02-29', 'calendar-month'), {
    from: '2023-02-01',
    to: '2023-02-28',
  });
  assert.equal(samePeriodLastYear('2026-05-10', '2026-05-19', 'custom'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodRanges.test.ts`
Expected: FAIL — `priorPeriod is not exported`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to backend/src/summary/periodRanges.ts
function addDays(d: string, n: number): string {
  const p = parts(d);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.day + n));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function dayCount(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  const ms =
    Date.UTC(b.y, b.m - 1, b.day) - Date.UTC(a.y, a.m - 1, a.day);
  return Math.round(ms / 86_400_000) + 1; // inclusive
}
function monthRange(y: number, m: number): DateRange {
  return { from: fmt(y, m, 1), to: fmt(y, m, lastDay(y, m)) };
}

export function priorPeriod(
  from: string,
  to: string,
  kind: PeriodRangeKind,
): DateRange {
  const a = parts(from);
  if (kind === 'calendar-month') {
    const m = a.m === 1 ? 12 : a.m - 1;
    const y = a.m === 1 ? a.y - 1 : a.y;
    return monthRange(y, m);
  }
  if (kind === 'calendar-quarter') {
    const startM = a.m - 3;
    const y = startM < 1 ? a.y - 1 : a.y;
    const m = startM < 1 ? startM + 12 : startM;
    return { from: fmt(y, m, 1), to: fmt(y, m + 2, lastDay(y, m + 2)) };
  }
  if (kind === 'calendar-year') {
    return { from: fmt(a.y - 1, 1, 1), to: fmt(a.y - 1, 12, 31) };
  }
  // custom: prior equal-length span ending the day before `from`
  const span = dayCount(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  return { from: prevFrom, to: prevTo };
}

export function samePeriodLastYear(
  from: string,
  to: string,
  kind: PeriodRangeKind,
): DateRange | null {
  if (kind === 'custom') return null;
  const a = parts(from);
  if (kind === 'calendar-month') return monthRange(a.y - 1, a.m);
  if (kind === 'calendar-quarter') {
    return { from: fmt(a.y - 1, a.m, 1), to: fmt(a.y - 1, a.m + 2, lastDay(a.y - 1, a.m + 2)) };
  }
  // calendar-year
  return { from: fmt(a.y - 1, 1, 1), to: fmt(a.y - 1, 12, 31) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodRanges.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/periodRanges.ts backend/src/summary/periodRanges.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(summary): prior-period and same-period-last-year window helpers"
```

---

### Task 3: Typical-baseline windows

**Files:**
- Modify: `backend/src/summary/periodRanges.ts`
- Test: `backend/src/summary/periodRanges.test.ts`

Rules (from spec §2): month → trailing complete months, **min 3, cap 12**; quarter → **min 2, cap 4**; year → **none**; custom → **none**. Windows exclude the in-progress period and are returned most-recent-first. The caller drops the `typical` baseline when fewer than the minimum are available.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/summary/periodRanges.test.ts
import { typicalWindows } from './periodRanges';

test('typicalWindows returns up to 12 trailing complete months, newest first', () => {
  const w = typicalWindows('2026-05-01', '2026-05-31', 'calendar-month');
  assert.equal(w.minRequired, 3);
  assert.equal(w.windows.length, 12);
  assert.deepEqual(w.windows[0], { from: '2026-04-01', to: '2026-04-30' });
  assert.deepEqual(w.windows[11], { from: '2025-05-01', to: '2025-05-31' });
});

test('typicalWindows returns up to 4 trailing quarters with min 2', () => {
  const w = typicalWindows('2026-04-01', '2026-06-30', 'calendar-quarter');
  assert.equal(w.minRequired, 2);
  assert.equal(w.windows.length, 4);
  assert.deepEqual(w.windows[0], { from: '2026-01-01', to: '2026-03-31' });
});

test('typicalWindows returns none for year and custom', () => {
  assert.deepEqual(typicalWindows('2026-01-01', '2026-12-31', 'calendar-year').windows, []);
  assert.deepEqual(typicalWindows('2026-05-10', '2026-05-19', 'custom').windows, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodRanges.test.ts`
Expected: FAIL — `typicalWindows is not exported`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to backend/src/summary/periodRanges.ts
export type TypicalWindows = { windows: DateRange[]; minRequired: number };

export function typicalWindows(
  from: string,
  to: string,
  kind: PeriodRangeKind,
): TypicalWindows {
  const a = parts(from);
  if (kind === 'calendar-month') {
    const windows: DateRange[] = [];
    let y = a.y;
    let m = a.m;
    for (let i = 0; i < 12; i++) {
      m = m === 1 ? 12 : m - 1;
      if (m === 12) y -= 1;
      windows.push(monthRange(y, m));
    }
    return { windows, minRequired: 3 };
  }
  if (kind === 'calendar-quarter') {
    const windows: DateRange[] = [];
    let y = a.y;
    let startM = a.m;
    for (let i = 0; i < 4; i++) {
      startM -= 3;
      if (startM < 1) {
        startM += 12;
        y -= 1;
      }
      windows.push({ from: fmt(y, startM, 1), to: fmt(y, startM + 2, lastDay(y, startM + 2)) });
    }
    return { windows, minRequired: 2 };
  }
  return { windows: [], minRequired: Infinity };
}
```

Note the month-loop decrement order: decrement `m` first, then roll the year when `m` wrapped to 12. Verified by the `windows[11]` assertion (`2025-05`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodRanges.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/periodRanges.ts backend/src/summary/periodRanges.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(summary): typical-baseline trailing windows for period insight"
```

---

## Phase 2 — Backend: decomposition + movers (pure)

### Task 4: Owed-back decomposition with dedup

**Files:**
- Create: `backend/src/summary/periodInsight.ts`
- Test: `backend/src/summary/periodInsight.test.ts`

`owedBack` per currency over in-range rows: reimbursable claim wins per txn; otherwise the partner share. Counted regardless of repayment status (the flow). `reimbursableByTxnId` maps a txn id to its summed reimbursable amount (positive).

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/summary/periodInsight.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOwedBack, type OwedBackRow } from './periodInsight';

function row(o: Partial<OwedBackRow>): OwedBackRow {
  return { id: 1, currency: 'CAD', amount: '-100.00', partnerShareAmount: null, ...o };
}

test('computeOwedBack sums partner share for shared spend', () => {
  const out = computeOwedBack(
    [row({ id: 1, amount: '-100.00', partnerShareAmount: '-40.00' })],
    new Map(),
  );
  assert.equal(out.get('CAD')?.partnerShare, 40);
  assert.equal(out.get('CAD')?.reimbursable, 0);
  assert.equal(out.get('CAD')?.owedBack, 40);
});

test('computeOwedBack sums reimbursable claims', () => {
  const out = computeOwedBack(
    [row({ id: 7, amount: '-100.00' })],
    new Map([[7, 60]]),
  );
  assert.equal(out.get('CAD')?.reimbursable, 60);
  assert.equal(out.get('CAD')?.owedBack, 60);
});

test('computeOwedBack dedups: reimbursable wins, partner share ignored on same txn', () => {
  const out = computeOwedBack(
    [row({ id: 9, amount: '-100.00', partnerShareAmount: '-40.00' })],
    new Map([[9, 70]]),
  );
  assert.equal(out.get('CAD')?.reimbursable, 70);
  assert.equal(out.get('CAD')?.partnerShare, 0);
  assert.equal(out.get('CAD')?.owedBack, 70);
});

test('computeOwedBack splits by currency', () => {
  const out = computeOwedBack(
    [
      row({ id: 1, currency: 'CAD', partnerShareAmount: '-10.00' }),
      row({ id: 2, currency: 'USD', partnerShareAmount: '-5.00' }),
    ],
    new Map(),
  );
  assert.equal(out.get('CAD')?.owedBack, 10);
  assert.equal(out.get('USD')?.owedBack, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts`
Expected: FAIL — `Cannot find module './periodInsight'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// backend/src/summary/periodInsight.ts
import { num } from '../util/numbers';

export type OwedBackRow = {
  id: number;
  currency: string;
  amount: string;
  partnerShareAmount?: string | null;
};

export type OwedBackTotals = {
  owedBack: number;
  reimbursable: number;
  partnerShare: number;
};

export function computeOwedBack(
  rows: OwedBackRow[],
  reimbursableByTxnId: Map<number, number>,
): Map<string, OwedBackTotals> {
  const out = new Map<string, OwedBackTotals>();
  for (const r of rows) {
    const acc =
      out.get(r.currency) ?? { owedBack: 0, reimbursable: 0, partnerShare: 0 };
    const reimb = reimbursableByTxnId.get(r.id);
    if (reimb != null && reimb > 0) {
      acc.reimbursable += reimb;
      acc.owedBack += reimb;
    } else {
      const ps = Math.abs(num(r.partnerShareAmount) ?? 0);
      if (ps > 0) {
        acc.partnerShare += ps;
        acc.owedBack += ps;
      }
    }
    out.set(r.currency, acc);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/periodInsight.ts backend/src/summary/periodInsight.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(summary): owed-back decomposition with reimbursable-wins dedup"
```

---

### Task 5: Decomposition assembly (realCost identity + delta)

**Files:**
- Modify: `backend/src/summary/periodInsight.ts`
- Test: `backend/src/summary/periodInsight.test.ts`

`realCost = netSpend − owedBack`. `deltaPct(current, baseline)` = `((current − baseline) / |baseline|) × 100`, and `null` when baseline is 0 (the caller renders "new"/"n/a", never a fake percent).

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/summary/periodInsight.test.ts
import { realCostOf, deltaPct } from './periodInsight';

test('realCostOf satisfies the identity netSpend = realCost + owedBack', () => {
  assert.equal(realCostOf(10_000, 4_000), 6_000);
  assert.equal(realCostOf(10_000, 4_000) + 4_000, 10_000);
});

test('deltaPct computes percent change vs baseline', () => {
  assert.equal(deltaPct(120, 100), 20);
  assert.equal(deltaPct(80, 100), -20);
});

test('deltaPct returns null when baseline is zero', () => {
  assert.equal(deltaPct(50, 0), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts --test-name-pattern 'realCost|deltaPct'`
Expected: FAIL — `realCostOf is not exported`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to backend/src/summary/periodInsight.ts
export function realCostOf(netSpend: number, owedBack: number): number {
  return netSpend - owedBack;
}

export function deltaPct(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/periodInsight.ts backend/src/summary/periodInsight.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(summary): realCost identity and delta-pct helpers"
```

---

### Task 6: Category movers with driver

**Files:**
- Modify: `backend/src/summary/periodInsight.ts`
- Test: `backend/src/summary/periodInsight.test.ts`

**Implementation decision (refines spec §3):** movers compare **category spend** (gross categorical spend, matching the existing dashboard `byCategory` chart) — not per-category realCost — because owed-back is not cleanly allocable per category. Non-categorical flows (transfers/investments/dividends) are excluded via `isNonCategorical`. Driver = the merchant with the largest spend in that category in the current window, plus its txn count.

- [ ] **Step 1: Write the failing test**

```ts
// append to backend/src/summary/periodInsight.test.ts
import { topCategoryMovers, type MoverRow } from './periodInsight';

function mrow(o: Partial<MoverRow>): MoverRow {
  return {
    currency: 'CAD',
    amount: '-50.00',
    finalCategory: 'Groceries',
    merchantClean: 'Costco',
    txnType: 'purchase',
    accountType: 'chequing',
    ...o,
  };
}

test('topCategoryMovers ranks categories by absolute spend delta with driver', () => {
  const current = [
    mrow({ amount: '-300.00', finalCategory: 'Groceries', merchantClean: 'Costco' }),
    mrow({ amount: '-120.00', finalCategory: 'Groceries', merchantClean: 'Costco' }),
    mrow({ amount: '-40.00', finalCategory: 'Dining', merchantClean: 'Sushi' }),
  ];
  const baseline = [
    mrow({ amount: '-100.00', finalCategory: 'Groceries', merchantClean: 'Loblaws' }),
    mrow({ amount: '-220.00', finalCategory: 'Dining', merchantClean: 'Sushi' }),
  ];
  const movers = topCategoryMovers(current, baseline, 'CAD', 2);
  assert.equal(movers[0].category, 'Groceries');
  assert.equal(movers[0].currentRealCost, 420);
  assert.equal(movers[0].baselineRealCost, 100);
  assert.equal(movers[0].deltaAbs, 320);
  assert.equal(movers[0].driver.topMerchant, 'Costco');
  assert.equal(movers[0].driver.txnCount, 2);
  assert.equal(movers[1].category, 'Dining');
  assert.equal(movers[1].deltaAbs, -180);
});

test('topCategoryMovers excludes non-categorical flows and other currencies', () => {
  const current = [
    mrow({ amount: '-500.00', finalCategory: 'Transfers', txnType: 'transfer' }),
    mrow({ amount: '-500.00', currency: 'USD', finalCategory: 'Groceries' }),
    mrow({ amount: '-30.00', finalCategory: 'Groceries' }),
  ];
  const movers = topCategoryMovers(current, [], 'CAD', 5);
  assert.equal(movers.length, 1);
  assert.equal(movers[0].category, 'Groceries');
  assert.equal(movers[0].currentRealCost, 30);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts --test-name-pattern 'topCategoryMovers'`
Expected: FAIL — `topCategoryMovers is not exported`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to backend/src/summary/periodInsight.ts
import { isNonCategorical } from './classifyTransactionFlow';

export type MoverRow = {
  currency: string;
  amount: string;
  finalCategory: string | null;
  merchantClean?: string | null;
  txnType?: string | null;
  accountType?: string | null;
};

export type CategoryMover = {
  category: string;
  currentRealCost: number;
  baselineRealCost: number;
  deltaAbs: number;
  deltaPct: number | null;
  driver: { topMerchant: string | null; txnCount: number };
};

function categorySpend(rows: MoverRow[], currency: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.currency !== currency) continue;
    if (isNonCategorical(r.txnType, r.accountType)) continue;
    const amt = num(r.amount) ?? 0;
    if (amt >= 0) continue; // spend only
    const cat = r.finalCategory ?? 'Uncategorized';
    m.set(cat, (m.get(cat) ?? 0) + Math.abs(amt));
  }
  return m;
}

function driverFor(
  rows: MoverRow[],
  currency: string,
  category: string,
): { topMerchant: string | null; txnCount: number } {
  const byMerchant = new Map<string, number>();
  let count = 0;
  for (const r of rows) {
    if (r.currency !== currency) continue;
    if (isNonCategorical(r.txnType, r.accountType)) continue;
    const amt = num(r.amount) ?? 0;
    if (amt >= 0) continue;
    if ((r.finalCategory ?? 'Uncategorized') !== category) continue;
    count += 1;
    const merch = r.merchantClean ?? 'Unknown';
    byMerchant.set(merch, (byMerchant.get(merch) ?? 0) + Math.abs(amt));
  }
  let top: string | null = null;
  let best = -Infinity;
  for (const [merch, total] of byMerchant) {
    if (total > best) {
      best = total;
      top = merch;
    }
  }
  return { topMerchant: top, txnCount: count };
}

export function topCategoryMovers(
  current: MoverRow[],
  baseline: MoverRow[],
  currency: string,
  limit: number,
): CategoryMover[] {
  const cur = categorySpend(current, currency);
  const base = categorySpend(baseline, currency);
  const cats = new Set<string>([...cur.keys(), ...base.keys()]);
  const movers: CategoryMover[] = [];
  for (const cat of cats) {
    const c = cur.get(cat) ?? 0;
    const b = base.get(cat) ?? 0;
    movers.push({
      category: cat,
      currentRealCost: c,
      baselineRealCost: b,
      deltaAbs: c - b,
      deltaPct: deltaPct(c, b),
      driver: driverFor(current, currency, cat),
    });
  }
  movers.sort((a, b) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs));
  return movers.slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Verify `isNonCategorical` signature matches**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors. If `isNonCategorical` is not exported from `classifyTransactionFlow.ts`, open that file and confirm the export name (the explorer reported it at `classifyTransactionFlow.ts:74`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/summary/periodInsight.ts backend/src/summary/periodInsight.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(summary): top category movers with driver merchant"
```

---

## Phase 3 — Backend: route + DTO

### Task 7: Add the shared DTO

**Files:**
- Modify: `shared/api-types.ts`

- [ ] **Step 1: Add the response types**

Append to `shared/api-types.ts` (match the existing `export type` block style, e.g. `BudgetProgress` at lines 759–784):

```ts
export type PeriodInsightRangeKind =
  | 'calendar-month'
  | 'calendar-quarter'
  | 'calendar-year'
  | 'custom';

export type PeriodInsightBaselineKey =
  | 'prior-period'
  | 'same-period-last-year'
  | 'typical'
  | 'per-day-rate';

export type PeriodInsightBaseline = {
  key: PeriodInsightBaselineKey;
  label: string;
  realCost: number;
  realCostDeltaPct: number | null;
  owedBack: number;
  owedBackDeltaPct: number | null;
};

export type PeriodInsightMover = {
  category: string;
  currentRealCost: number;
  baselineRealCost: number;
  deltaAbs: number;
  deltaPct: number | null;
  driver: { topMerchant: string | null; txnCount: number };
};

export type PeriodInsightCurrency = {
  currency: string;
  netSpend: number;
  realCost: number;
  owedBack: number;
  owedBackBreakdown: { reimbursable: number; partnerShare: number };
  collectedThisPeriod: number;
  receivablesOutstanding: number;
  rangeKind: PeriodInsightRangeKind;
  baselines: PeriodInsightBaseline[];
  movers: PeriodInsightMover[];
};

export type PeriodInsightResp = {
  byCurrency: PeriodInsightCurrency[];
};
```

- [ ] **Step 2: Typecheck both workspaces**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace frontend run build`
Expected: PASS (no usage yet, just type availability).

- [ ] **Step 3: Commit**

```bash
git add shared/api-types.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(shared): PeriodInsightResp DTO"
```

---

### Task 8: Route handler `GET /api/summary/period-insight`

**Files:**
- Modify: `backend/src/routes/summary.ts`
- Test: `backend/test/integration/periodInsight.test.ts` (integration — needs Postgres + real rows; the pure logic is already unit-covered)

The handler: read `currency`/`dateFrom`/`dateTo` from `req.query`; load main-range rows + account map; compute canonical `netSpend` via `aggregateDashboard`; compute `owedBack` (reimbursables joined to in-range txns + partner shares); compute `receivablesOutstanding` (all-time outstanding reimbursements + partner balance); detect range kind; for each available baseline window, load rows and compute baseline realCost/owedBack + deltas; compute movers vs the primary baseline (typical if available, else prior-period). Assemble `PeriodInsightResp`.

- [ ] **Step 1: Add the handler**

Add to `backend/src/routes/summary.ts`. Use the existing imports plus add `Reimbursement` and the new helpers. Insert near the other `router.get('/...')` handlers (after `/dashboard`). Use the existing scoping helpers already used by `/dashboard` (`visibleTransactionWhere(req)`, `visibleAccountWhere(req)` — confirm the exact names at the top of the file; the explorer reported `dateWhere(req)` building `{currency, date}` from query, and `visibleTransactionWhere`/`visibleAccountWhere` from `../auth/scope`).

```ts
import { Reimbursement } from '../models';
import {
  detectRangeKind,
  priorPeriod,
  samePeriodLastYear,
  typicalWindows,
  type DateRange,
} from '../summary/periodRanges';
import {
  computeOwedBack,
  realCostOf,
  deltaPct,
  topCategoryMovers,
  type OwedBackRow,
  type MoverRow,
} from '../summary/periodInsight';
import type {
  PeriodInsightResp,
  PeriodInsightBaseline,
  PeriodInsightCurrency,
} from '@cashflow/shared';

// --- helpers local to this handler ---

type PiRow = OwedBackRow &
  MoverRow & { id: number; finalCategory: string | null; accountType?: string | null };

async function loadPeriodRows(req: Request, range: DateRange, currency: string | null) {
  const where: Record<string, unknown> = {
    ...visibleTransactionWhere(req),
    date: { [Op.between]: [range.from, range.to] },
  };
  if (currency) where.currency = currency;
  const rows = await Transaction.findAll({
    where,
    attributes: [
      'id',
      'accountId',
      'currency',
      'amount',
      'partnerShareAmount',
      'finalCategory',
      'merchantClean',
      'txnType',
    ],
    raw: true,
  });
  return rows as unknown as Array<PiRow & { accountId: number }>;
}

// Sum reimbursable claim amount per txn for txns dated in the range (any status).
async function loadReimbursableByTxn(
  req: Request,
  range: DateRange,
  currency: string | null,
): Promise<Map<number, number>> {
  const rows = await Reimbursement.findAll({
    where: { ...householdWhere(req) },
    include: [
      {
        model: Transaction,
        as: 'transaction',
        attributes: ['id', 'date', 'currency'],
        where: {
          date: { [Op.between]: [range.from, range.to] },
          ...(currency ? { currency } : {}),
        },
        required: true,
      },
    ],
    raw: true,
  });
  const map = new Map<number, number>();
  for (const r of rows as Array<{ transactionId: number; amount: string }>) {
    const amt = Math.abs(num(r.amount) ?? 0);
    map.set(r.transactionId, (map.get(r.transactionId) ?? 0) + amt);
  }
  return map;
}
```

Then the route body:

```ts
router.get('/period-insight', async (req, res, next) => {
  try {
    const currency = typeof req.query.currency === 'string' && req.query.currency
      ? req.query.currency.toUpperCase().slice(0, 3)
      : null;
    const from = String(req.query.dateFrom ?? '');
    const to = String(req.query.dateTo ?? '');
    if (!from || !to) {
      res.status(400).json({ error: 'dateFrom and dateTo are required' });
      return;
    }

    const kind = detectRangeKind(from, to);

    // main window
    const [mainRows, accounts] = await Promise.all([
      loadPeriodRows(req, { from, to }, currency),
      Account.findAll({ where: visibleAccountWhere(req), attributes: ['id', 'name', 'shortCode', 'accountType'], raw: true }),
    ]);
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const reimbursableByTxn = await loadReimbursableByTxn(req, { from, to }, currency);

    // canonical netSpend per currency via the existing aggregator
    const agg = aggregateDashboard(mainRows as unknown as SummaryTxnRow[], accountById, {
      linksByTxn: new Map(),
      ordersById: new Map(),
      itemsByOrder: new Map(),
    });

    const owed = computeOwedBack(mainRows, reimbursableByTxn);

    // baselines
    const baselineDefs: Array<{ key: PeriodInsightBaseline['key']; label: string; range: DateRange }> = [];
    baselineDefs.push({ key: 'prior-period', label: 'prior period', range: priorPeriod(from, to, kind) });
    const sply = samePeriodLastYear(from, to, kind);
    if (sply) baselineDefs.push({ key: 'same-period-last-year', label: 'same period last year', range: sply });

    const tw = typicalWindows(from, to, kind);
    // load + average typical windows if enough exist (caller-side min check)
    // ... (see Step 2 for the typical + per-day-rate assembly)

    // assemble per currency
    const byCurrency: PeriodInsightCurrency[] = [];
    for (const [cur, metrics] of agg.metricsByCurrency) {
      const o = owed.get(cur) ?? { owedBack: 0, reimbursable: 0, partnerShare: 0 };
      const realCost = realCostOf(metrics.netSpend, o.owedBack);
      // baselines computed per currency below (Step 2)
      byCurrency.push({
        currency: cur,
        netSpend: metrics.netSpend,
        realCost,
        owedBack: o.owedBack,
        owedBackBreakdown: { reimbursable: o.reimbursable, partnerShare: o.partnerShare },
        collectedThisPeriod: 0, // filled in Step 3
        receivablesOutstanding: 0, // filled in Step 3
        rangeKind: kind,
        baselines: [], // filled in Step 2
        movers: [], // filled in Step 2
      });
    }

    const body: PeriodInsightResp = { byCurrency };
    res.json(body);
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 2: Fill baselines + movers per currency**

Inside the `for (const [cur, metrics] ...)` loop, replace the `baselines: []` / `movers: []` placeholders by computing them. Load each baseline window's rows once (outside the currency loop, cache by range key), then per currency compute realCost/owedBack and deltas:

```ts
// before the currency loop: load baseline rows once
const baselineRowsByKey = new Map<string, Array<PiRow & { accountId: number }>>();
const baselineReimbByKey = new Map<string, Map<number, number>>();
for (const def of baselineDefs) {
  baselineRowsByKey.set(def.key, await loadPeriodRows(req, def.range, currency));
  baselineReimbByKey.set(def.key, await loadReimbursableByTxn(req, def.range, currency));
}
// typical: load each window, keep only if count >= minRequired
const typicalLoaded: Array<Array<PiRow & { accountId: number }>> = [];
const typicalReimb: Array<Map<number, number>> = [];
for (const w of tw.windows) {
  typicalLoaded.push(await loadPeriodRows(req, w, currency));
  typicalReimb.push(await loadReimbursableByTxn(req, w, currency));
}
const typicalAvailable = tw.windows.length > 0 && tw.windows.length >= tw.minRequired;
```

Per currency, helper to compute a window's realCost/owedBack for `cur`:

```ts
function windowTotals(rows: Array<PiRow>, reimb: Map<number, number>, cur: string) {
  const wAgg = aggregateDashboard(rows as unknown as SummaryTxnRow[], accountById, {
    linksByTxn: new Map(), ordersById: new Map(), itemsByOrder: new Map(),
  });
  const m = wAgg.metricsByCurrency.get(cur);
  const o = computeOwedBack(rows, reimb).get(cur) ?? { owedBack: 0, reimbursable: 0, partnerShare: 0 };
  const netSpend = m?.netSpend ?? 0;
  return { realCost: realCostOf(netSpend, o.owedBack), owedBack: o.owedBack };
}
```

Then, for the current currency (`cur`, with current `realCost` and `o.owedBack` already computed):

```ts
const baselines: PeriodInsightBaseline[] = [];
for (const def of baselineDefs) {
  const wt = windowTotals(baselineRowsByKey.get(def.key)!, baselineReimbByKey.get(def.key)!, cur);
  if (wt.realCost === 0 && wt.owedBack === 0) continue; // insufficient/no data -> omit
  baselines.push({
    key: def.key,
    label: def.label,
    realCost: wt.realCost,
    realCostDeltaPct: deltaPct(realCost, wt.realCost),
    owedBack: wt.owedBack,
    owedBackDeltaPct: deltaPct(o.owedBack, wt.owedBack),
  });
}
if (typicalAvailable) {
  let sumReal = 0;
  let sumOwed = 0;
  for (let i = 0; i < typicalLoaded.length; i++) {
    const wt = windowTotals(typicalLoaded[i], typicalReimb[i], cur);
    sumReal += wt.realCost;
    sumOwed += wt.owedBack;
  }
  const avgReal = sumReal / typicalLoaded.length;
  const avgOwed = sumOwed / typicalLoaded.length;
  baselines.push({
    key: 'typical',
    label: 'typical',
    realCost: avgReal,
    realCostDeltaPct: deltaPct(realCost, avgReal),
    owedBack: avgOwed,
    owedBackDeltaPct: deltaPct(o.owedBack, avgOwed),
  });
}
// per-day-rate baseline only for custom ranges
if (kind === 'custom' && baselines.length > 0) {
  // prior-period already gives a same-length comparison; per-day-rate is informational.
  // Keep prior-period; no extra baseline needed for v1 custom.
}

// movers: vs typical window-set if available, else prior-period rows
const moverBaselineRows = typicalAvailable
  ? typicalLoaded.flat()
  : baselineRowsByKey.get('prior-period')!;
const movers = topCategoryMovers(
  mainRows as unknown as MoverRow[],
  moverBaselineRows as unknown as MoverRow[],
  cur,
  3,
);
```

Assign `baselines` and `movers` into the pushed `PeriodInsightCurrency`. (Restructure the loop so these are computed before the `byCurrency.push(...)`.)

**Note on movers vs typical:** when typical is the baseline, `moverBaselineRows` is the concatenation of all typical windows, so `baselineRealCost` is a *sum* across N periods, not an average. Divide the baseline category totals by `typicalLoaded.length` for an apples-to-apples per-period comparison — implement by passing a `baselineDivisor` to `topCategoryMovers` (add an optional 5th arg defaulting to 1 that divides `baselineRealCost`, `deltaAbs`, `deltaPct` baseline). Add a unit test for the divisor in `periodInsight.test.ts` before wiring it here.

- [ ] **Step 3: Receivables outstanding + collected-this-period**

```ts
// all-time outstanding reimbursements per currency (expected | overdue), + collected within range
const allReimb = await Reimbursement.findAll({ where: { ...householdWhere(req) }, raw: true });
const today = todayIso(); // import from the same util reimbursements.ts uses
// outstanding per currency
const outstandingByCur = new Map<string, number>();
const collectedByCur = new Map<string, number>(); // received with receivedAt in range
for (const r of allReimb as Array<{ amount: string; currency: string; status: string; dueDate: string | null; receivedAt: Date | null }>) {
  const eff = effectiveStatus(r, today); // reuse helper from reimbursements/serialize.ts if exported; else inline: overdue if status==='expected' && dueDate < today
  const amt = Math.abs(num(r.amount) ?? 0);
  if (eff === 'expected' || eff === 'overdue') {
    outstandingByCur.set(r.currency, (outstandingByCur.get(r.currency) ?? 0) + amt);
  }
}
```

Wire `receivablesOutstanding: outstandingByCur.get(cur) ?? 0` and `collectedThisPeriod: collectedByCur.get(cur) ?? 0` into each `PeriodInsightCurrency`. If `effectiveStatus`/`computeEffectiveStatus` is exported from `backend/src/reimbursements/serialize.ts` (the explorer found `computeEffectiveStatus(r, today)` at serialize.ts:571–605), import and reuse it; otherwise inline the overdue rule (`status === 'expected' && dueDate != null && dueDate < today` ⇒ `overdue`). **Partner balance is intentionally deferred from `receivablesOutstanding` in v1** — log a one-line note in the PR; reimbursement outstanding is the dominant, cleanly-summable component.

- [ ] **Step 4: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS. Fix any signature mismatches (confirm `aggregateDashboard`'s `metricsByCurrency` value type has `netSpend`; confirm the `ItemAllocationContext` empty shape from `loadItemAllocations`).

- [ ] **Step 5: Integration test**

```ts
// backend/test/integration/periodInsight.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest'; // confirm the integration test http pattern in an existing test/integration/*.test.ts
import { app } from '../../src/app';
// ...auth/session setup following an existing integration test (e.g. seed a household + login cookie)...

test('GET /api/summary/period-insight decomposes net spend into realCost + owedBack', async () => {
  // seed: one -100 CAD purchase with partnerShareAmount -40 dated inside May 2026
  // ...create Account, Transaction via models, attach session...
  const res = await agent.get('/api/summary/period-insight?currency=CAD&dateFrom=2026-05-01&dateTo=2026-05-31');
  assert.equal(res.status, 200);
  const cad = res.body.byCurrency.find((c: { currency: string }) => c.currency === 'CAD');
  assert.equal(cad.netSpend, 100);
  assert.equal(cad.owedBack, 40);
  assert.equal(cad.realCost, 60);
  assert.equal(cad.rangeKind, 'calendar-month');
});
```

Match the exact integration harness (app import, auth seeding, supertest agent) to an existing file under `backend/test/integration/`. Run with the Postgres-backed integration runner:
Run: `yarn workspace cashflow-backend run test:integration` (requires `TEST_DATABASE_URL`).
Expected: PASS.

- [ ] **Step 6: Route-order invariant**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/appRouteOrder.test.ts`
Expected: PASS — confirms `/api/summary/period-insight` resolves on `summaryRouter` (no registry change needed; the sub-path is under the already-mounted `/api/summary`). If the test asserts an allowlist of summary sub-paths, add `period-insight`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/summary.ts backend/test/integration/periodInsight.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(summary): GET /api/summary/period-insight endpoint"
```

---

## Phase 4 — Frontend: band component

### Task 9: PeriodInsightBand component

**Files:**
- Create: `frontend/src/components/dashboard/PeriodInsightBand.tsx`
- Test: `frontend/src/components/dashboard/PeriodInsightBand.test.tsx`

Pure presentational component — takes the resolved `PeriodInsightCurrency` (the entry matching the selected currency, or a multi-currency note) plus a `currency` string for formatting. Reuses `DeltaBadge`. Renders: decomposition headline (`realCost` large, owed sublines), comparison + trend chips, mover rows. Prefer Tailwind utilities.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/dashboard/PeriodInsightBand.test.tsx
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PeriodInsightBand } from './PeriodInsightBand';
import type { PeriodInsightCurrency } from '@cashflow/shared';

const base: PeriodInsightCurrency = {
  currency: 'CAD',
  netSpend: 10000,
  realCost: 6000,
  owedBack: 4000,
  owedBackBreakdown: { reimbursable: 4000, partnerShare: 0 },
  collectedThisPeriod: 0,
  receivablesOutstanding: 1200,
  rangeKind: 'calendar-month',
  baselines: [
    { key: 'prior-period', label: 'last month', realCost: 6500, realCostDeltaPct: -7.7, owedBack: 3000, owedBackDeltaPct: 33.3 },
    { key: 'typical', label: 'typical', realCost: 5350, realCostDeltaPct: 12.1, owedBack: 2000, owedBackDeltaPct: 100 },
  ],
  movers: [
    { category: 'Groceries', currentRealCost: 420, baselineRealCost: 320, deltaAbs: 100, deltaPct: 31.3, driver: { topMerchant: 'Costco', txnCount: 3 } },
  ],
};

describe('PeriodInsightBand', () => {
  it('renders the realCost headline and owed-back subline', () => {
    const { getByText } = render(<PeriodInsightBand data={base} currency="CAD" />);
    expect(getByText(/6,000/)).toBeTruthy();
    expect(getByText(/loaned out/i)).toBeTruthy();
    expect(getByText(/4,000/)).toBeTruthy();
  });

  it('renders one comparison chip per available baseline', () => {
    const { container } = render(<PeriodInsightBand data={base} currency="CAD" />);
    expect(container.querySelectorAll('[data-slot="delta-badge"]').length).toBeGreaterThanOrEqual(2);
  });

  it('renders mover rows with driver text', () => {
    const { getByText } = render(<PeriodInsightBand data={base} currency="CAD" />);
    expect(getByText(/Groceries/)).toBeTruthy();
    expect(getByText(/Costco/)).toBeTruthy();
  });

  it('omits baselines that are not present', () => {
    const { queryByText } = render(
      <PeriodInsightBand data={{ ...base, baselines: [] }} currency="CAD" />,
    );
    expect(queryByText(/typical/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test PeriodInsightBand`
Expected: FAIL — cannot resolve `./PeriodInsightBand`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// frontend/src/components/dashboard/PeriodInsightBand.tsx
import { DeltaBadge } from '@/components/ui/DeltaBadge';
import { formatCurrency } from '@/lib/format'; // confirm the exact formatter path used by DeltaBadge
import type { PeriodInsightCurrency } from '@cashflow/shared';

type Props = { data: PeriodInsightCurrency; currency: string };

export function PeriodInsightBand({ data, currency }: Props) {
  const money = (n: number) => formatCurrency(n, currency);
  return (
    <div className="flex flex-col gap-3">
      {/* Decomposition headline */}
      <div>
        <p className="text-sm text-muted-foreground">Real spend · this period</p>
        <p className="text-3xl font-semibold tabular-nums">{money(data.realCost)}</p>
        <p className="text-sm text-muted-foreground">
          {data.owedBack > 0 ? (
            <>loaned out {money(data.owedBack)} this period</>
          ) : (
            <>nothing loaned out this period</>
          )}
          {data.receivablesOutstanding > 0 && (
            <> · {money(data.receivablesOutstanding)} owed to you overall</>
          )}
        </p>
      </div>

      {/* Comparison + trend chips */}
      {data.baselines.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {data.baselines.map((b) => (
            <span key={b.key} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              vs {b.label}
              {b.realCostDeltaPct != null && (
                <DeltaBadge delta={b.realCostDeltaPct} metricKind="spend" />
              )}
            </span>
          ))}
        </div>
      )}

      {/* Movers */}
      {data.movers.length > 0 && (
        <ul className="flex flex-col gap-1">
          {data.movers.map((m) => (
            <li key={m.category} className="flex items-center justify-between text-sm">
              <a
                href={`/transactions?category=${encodeURIComponent(m.category)}`}
                className="hover:underline"
              >
                {m.category}
              </a>
              <span className="flex items-center gap-2 text-muted-foreground">
                {m.deltaPct != null && <DeltaBadge delta={m.deltaPct} metricKind="spend" />}
                {m.driver.topMerchant && (
                  <span>
                    {m.driver.txnCount}× {m.driver.topMerchant}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`DeltaBadge` with a numeric percent and no `currency` prop renders the rounded integer with an arrow (per its implementation). If a `%` suffix is desired, that's a follow-up styling tweak; v1 keeps the existing badge formatting. Confirm `formatCurrency`'s import path matches what `DeltaBadge.tsx` imports (the explorer showed `DeltaBadge` calling `formatCurrency`).

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test PeriodInsightBand`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/dashboard/PeriodInsightBand.tsx frontend/src/components/dashboard/PeriodInsightBand.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(dashboard): PeriodInsightBand component"
```

---

## Phase 5 — Frontend: integration + retire HeroTile

### Task 10: Fetch the endpoint in DashboardPage

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Add the fetch**

In the existing `useEffect` data-loading block (around lines 312–346, the `Promise.all([...])`), add the period-insight call alongside the dashboard/monthly calls:

```tsx
import type { PeriodInsightResp, PeriodInsightCurrency } from '@cashflow/shared';
// ...
const [insight, setInsight] = useState<PeriodInsightResp | null>(null);
// inside the async loader, extend the Promise.all:
const [d, m, prev, pi] = await Promise.all([
  getJson<DashResp>(`/api/summary/dashboard${summaryQs}`),
  getJson<MonthlyResp>(`/api/summary/monthly${summaryQs}`),
  previousRange
    ? getJson<DashResp>(`/api/summary/dashboard${summaryQueryString({ currency, dateFrom: previousRange.from, dateTo: previousRange.to })}`)
    : Promise.resolve<DashResp | null>(null),
  // only fetch insight when both dates are set (band needs a bounded range)
  dateFrom && dateTo
    ? getJson<PeriodInsightResp>(`/api/summary/period-insight${summaryQs}`)
    : Promise.resolve<PeriodInsightResp | null>(null),
]);
// after setting other state:
if (!cancelled) setInsight(pi);
```

Add a resolver for the currency-matching entry:

```tsx
const insightForCurrency: PeriodInsightCurrency | null = useMemo(() => {
  if (!insight) return null;
  if (currency) return insight.byCurrency.find((c) => c.currency === currency) ?? null;
  return insight.byCurrency[0] ?? null; // multi-currency: show the first; full breakdown is a follow-up
}, [insight, currency]);
```

- [ ] **Step 2: Typecheck**

Run: `yarn workspace frontend run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(dashboard): fetch period-insight in DashboardPage"
```

---

### Task 11: Render the band, retire HeroTile

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Delete: `frontend/src/components/dashboard/HeroTile.tsx`, `frontend/src/components/dashboard/HeroTile.test.tsx`

- [ ] **Step 1: Replace the HeroTile JSX**

At the `<BentoTile span={8} rows={2} variant="hero" ...>` block (lines ~1013–1067), replace the `<HeroTile .../>` child with the band, keeping the `<BentoTile>` wrapper:

```tsx
<BentoTile span={8} rows={2} variant="hero" aria-busy={loading} aria-label="This period at a glance">
  {insightForCurrency ? (
    <PeriodInsightBand data={insightForCurrency} currency={currency} />
  ) : (
    <div className="text-sm text-muted-foreground">
      Pick a start and end date to see the period breakdown.
    </div>
  )}
</BentoTile>
```

Add the import:

```tsx
import { PeriodInsightBand } from '@/components/dashboard/PeriodInsightBand';
```

Remove the `import { HeroTile } from '@/components/dashboard/HeroTile'` line.

- [ ] **Step 2: Delete HeroTile and its test**

```bash
git rm frontend/src/components/dashboard/HeroTile.tsx frontend/src/components/dashboard/HeroTile.test.tsx
```

- [ ] **Step 3: Remove now-dead `summaryStats` fields feeding HeroTile**

The `summaryStats` object built only HeroTile-specific labels (`netSpendLabel`, `netSpendDelta`, `spendLabel`, sub-metric deltas, `comparisonHint`, `moneyHint`, `sparklineData` mapping). Remove fields no longer referenced anywhere after Step 1. Run the dead-code check to find them:

Run: `yarn workspace frontend run lint`
Expected: surfaces unused vars; delete each until lint is clean. Do NOT remove fields still used by other tiles (e.g. KpiStack, charts).

- [ ] **Step 4: Build + frontend tests**

Run: `yarn workspace frontend run build && yarn workspace frontend run test`
Expected: PASS. No reference to `HeroTile` remains (`grep -r HeroTile frontend/src` returns nothing).

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(dashboard): render PeriodInsightBand, retire HeroTile"
```

---

## Phase 6 — Full verification

### Task 12: Run the full CI gate

- [ ] **Step 1: Backend unit + typecheck**

Run: `yarn workspace cashflow-backend run typecheck && cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodRanges.test.ts src/summary/periodInsight.test.ts`
Expected: PASS.

- [ ] **Step 2: Full CI**

Run: `yarn ci`
Expected: typecheck, all tests, both production builds PASS. Address any failure before proceeding.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Run: `yarn dev`, open `http://localhost:5173`, select "last month", confirm the band shows realCost headline, loaned-out subline, comparison chips, and movers. Switch currency and date range; confirm it refetches and baselines hide when history is short.

- [ ] **Step 4: Final commit if any fixes**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -am "test: period insight band CI fixes"
```

---

## Self-Review Notes (spec coverage)

- **Honest decomposition (spec §1)** → Tasks 4, 5, 8 (Step 1–2). Identity `realCost + owedBack = netSpend` tested in Task 5; dedup in Task 4.
- **owedBack regardless of repayment** → Task 8 Step 1 `loadReimbursableByTxn` filters by txn date only (any status). Outstanding (status-filtered) is the separate `receivablesOutstanding` in Step 3.
- **Smart comparisons / range-aware (spec §2)** → Tasks 1–3 (ranges), Task 8 Step 2 (baselines + typical min-count gating + insufficient-history omission).
- **Loaned-out trend (spec §2)** → `owedBack` + `owedBackDeltaPct` carried on every baseline (DTO Task 7, computed Task 8 Step 2). Surfacing in UI: the band currently renders realCost chips; an owed-back trend chip is a thin add in `PeriodInsightBand` — **add it in Task 9 Step 3** if not already (render `b.owedBackDeltaPct` when notable). *Gap closed: extend the chip row to show owed-back trend.*
- **What changed / movers (spec §3)** → Task 6 (with driver), rendered Task 9.
- **One endpoint, one component, no new table/primitive (spec §4)** → Tasks 7–11.
- **Error handling (spec)** → 400 on missing dates (Task 8), insufficient-history omission (Task 8 Step 2), zero-baseline `deltaPct` null (Task 5), empty-state band (Task 11 Step 1).
- **Deferred (logged in PR):** partner balance in `receivablesOutstanding`; multi-currency full breakdown (shows first currency); per-day-rate custom baseline (prior-period covers same-length custom comparison).

> **Action for the implementer:** in Task 9, ensure the comparison chip row also renders the owed-back trend (`owedBackDeltaPct`) so spec §2's "lending more than usual" is visible — the data is already on each baseline.
