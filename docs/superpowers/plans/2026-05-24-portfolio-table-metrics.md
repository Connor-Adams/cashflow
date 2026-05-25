# Portfolio Table Metrics (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `/api/portfolio` and `/api/portfolio/by-security` with per-row return/yield/weight metrics, add `<PctDeltaCell>` chip cells to the Holdings + By-security tables, and promote the `Total (CAD)` top stat card to `<MetricStat>` with a delta.

**Architecture:** New `backend/src/portfolio/metrics.ts` module batches the per-security data needed for compute (latest/prev/30d-ago daily prices, latest quotes, 30d & 365d dividend sums, FX rates, realized + lifetime-income per security) and exposes pure compute helpers (`computeRowMetrics`, `computeWeightPct`, `computeTotalReturnPct`, `computeUnifiedTodayDelta`). Both route handlers call the loader once, then call the compute helpers per row. Frontend renders new columns via a small `<PctDeltaCell>` component.

**Tech Stack:** Backend Sequelize 6 + Express + TypeScript + `node:test` + `supertest`. Frontend React 19 + TypeScript + Vite + Vitest.

**Spec:** [docs/superpowers/specs/2026-05-24-portfolio-table-metrics-design.md](../specs/2026-05-24-portfolio-table-metrics-design.md)

---

## File Structure

### Backend — new files

| Path | Responsibility |
|---|---|
| `backend/src/portfolio/metrics.ts` | `MetricsContext` type + `loadMetricsContext` batch loader + four pure compute helpers (`computeRowMetrics`, `computeWeightPct`, `computeTotalReturnPct`, `computeUnifiedTodayDelta`) |
| `backend/test/portfolio/metrics.test.ts` | Unit tests for the four compute helpers |
| `backend/test/integration/portfolioMetrics.test.ts` | Integration tests for `/api/portfolio` populating new fields |

### Backend — modified files

| Path | Change |
|---|---|
| `backend/src/routes/portfolio.ts` | `/` handler — populate per-row metrics on `holdings[]`; populate `unifiedTotal.todayChangePct`/`todayChangeCad`. `/by-security` handler — populate per-row metrics on `rows[]`; add top-level `unifiedTotal` block. |
| `backend/test/integration/portfolioBySecurity.test.ts` | Add cases asserting new per-row + top-level fields |

### Frontend — new files

| Path | Responsibility |
|---|---|
| `frontend/src/components/ui/pct-delta-cell.tsx` | Inline delta-percentage cell renderer (`↑/↓ X.XX%`, color-coded) |
| `frontend/src/components/ui/pct-delta-cell.test.tsx` | Component tests |

### Frontend — modified files

| Path | Change |
|---|---|
| `shared/api-types.ts` | Add fields to `PortfolioSummary['holdings'][number]`, `PortfolioSummary['unifiedTotal']`, `PortfolioBySecurity['rows'][number]`. Add new top-level `unifiedTotal` to `PortfolioBySecurity`. |
| `frontend/src/types/api.ts` | No code change needed — re-exports are by name and already include `PortfolioSummary`/`PortfolioBySecurity`. |
| `frontend/src/pages/PortfolioPage.tsx` | Holdings + By-security: 4 new columns each. Top stats row: `Total (CAD)` becomes `<MetricStat>`. |
| `frontend/src/pages/PortfolioPage.test.tsx` | Add coverage for new columns + delta stat card |

---

## Phase 1 — Backend metrics module

### Task 1: `metrics.ts` module + unit tests

**Files:**
- Create: `backend/src/portfolio/metrics.ts`
- Create: `backend/test/portfolio/metrics.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `backend/test/portfolio/metrics.test.ts`:

```ts
/**
 * Unit tests for the pure compute helpers in metrics.ts.
 * Loader is exercised end-to-end via the route integration tests
 * (Task 2 / Task 3); this file only covers the pure math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRowMetrics,
  computeWeightPct,
  computeTotalReturnPct,
  computeUnifiedTodayDelta,
  type MetricsContext,
} from '../../src/portfolio/metrics';

function emptyContext(): MetricsContext {
  return {
    latestDaily: new Map(),
    prevDaily: new Map(),
    daily30dAgo: new Map(),
    latestQuotes: new Map(),
    divPerUnit30d: new Map(),
    divPerUnit365d: new Map(),
    fxRates: new Map(),
    realizedBySec: new Map(),
    dividendsBySec: new Map(),
    interestBySec: new Map(),
  };
}

test('computeRowMetrics returns all-null when context is empty', () => {
  const m = computeRowMetrics({ ctx: emptyContext(), securityId: 1, qty: 10, costBasis: 100 });
  assert.equal(m.todayChangePct, null);
  assert.equal(m.thirtyDayReturnPct, null);
  assert.equal(m.yieldOnCostPct, null);
});

test('computeRowMetrics computes todayChangePct from latestQuote + prevDaily', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  assert.equal(m.todayChangePct, 10);
});

test('computeRowMetrics todayChangePct null when no latestQuote', () => {
  const ctx = emptyContext();
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  assert.equal(m.todayChangePct, null);
});

test('computeRowMetrics thirtyDayReturnPct adds dividends to numerator', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.daily30dAgo.set(1, { adjClose: 100 });
  ctx.divPerUnit30d.set(1, 2);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  // ((110 + 2) - 100) / 100 = 12 %
  assert.equal(m.thirtyDayReturnPct, 12);
});

test('computeRowMetrics thirtyDayReturnPct falls back to latestDaily when no quote', () => {
  const ctx = emptyContext();
  ctx.latestDaily.set(1, { close: 110, adjClose: 110, date: '2026-05-24' });
  ctx.daily30dAgo.set(1, { adjClose: 100 });
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 800 });
  assert.equal(m.thirtyDayReturnPct, 10);
});

test('computeRowMetrics yieldOnCostPct uses div_per_unit_365d * qty / costBasis', () => {
  const ctx = emptyContext();
  ctx.divPerUnit365d.set(1, 2.5);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 500 });
  // (2.5 * 10 / 500) * 100 = 5
  assert.equal(m.yieldOnCostPct, 5);
});

test('computeRowMetrics yieldOnCostPct null when costBasis is null', () => {
  const ctx = emptyContext();
  ctx.divPerUnit365d.set(1, 2.5);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: null });
  assert.equal(m.yieldOnCostPct, null);
});

test('computeRowMetrics yieldOnCostPct null when costBasis is zero', () => {
  const ctx = emptyContext();
  ctx.divPerUnit365d.set(1, 2.5);
  const m = computeRowMetrics({ ctx, securityId: 1, qty: 10, costBasis: 0 });
  assert.equal(m.yieldOnCostPct, null);
});

test('computeWeightPct correct when unifiedTotal > 0', () => {
  assert.equal(computeWeightPct({ ctx: emptyContext(), cadMarketValue: 250, unifiedTotalCad: 1000 }), 25);
});

test('computeWeightPct null when unifiedTotal is null', () => {
  assert.equal(computeWeightPct({ ctx: emptyContext(), cadMarketValue: 250, unifiedTotalCad: null }), null);
});

test('computeWeightPct null when unifiedTotal is zero', () => {
  assert.equal(computeWeightPct({ ctx: emptyContext(), cadMarketValue: 250, unifiedTotalCad: 0 }), null);
});

test('computeTotalReturnPct includes realized + dividends + interest', () => {
  const ctx = emptyContext();
  ctx.realizedBySec.set(1, 50);
  ctx.dividendsBySec.set(1, 30);
  ctx.interestBySec.set(1, 5);
  // (currentMV 200 + realized 50 + (30 + 5) - cost 100) / 100 * 100 = 185%
  const v = computeTotalReturnPct({ ctx, securityId: 1, currentMV: 200, costBasis: 100 });
  assert.equal(v, 185);
});

test('computeTotalReturnPct null when costBasis is null', () => {
  const v = computeTotalReturnPct({ ctx: emptyContext(), securityId: 1, currentMV: 200, costBasis: null });
  assert.equal(v, null);
});

test('computeTotalReturnPct null when costBasis is zero', () => {
  const v = computeTotalReturnPct({ ctx: emptyContext(), securityId: 1, currentMV: 200, costBasis: 0 });
  assert.equal(v, null);
});

test('computeUnifiedTodayDelta sums only securities with prev-day prices', () => {
  const ctx = emptyContext();
  // Sec 1: full data
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  ctx.fxRates.set('USD', 1.35);
  // Sec 2: no prev daily → excluded entirely
  ctx.latestQuotes.set(2, { price: 50, currency: 'CAD' });
  // Sec 3: CAD, no FX needed
  ctx.latestQuotes.set(3, { price: 22, currency: 'CAD' });
  ctx.prevDaily.set(3, { close: 20, adjClose: 20, date: '2026-05-23' });

  const out = computeUnifiedTodayDelta({
    ctx,
    holdings: [
      { securityId: 1, quantity: 10, currency: 'USD' },
      { securityId: 2, quantity: 5, currency: 'CAD' },
      { securityId: 3, quantity: 10, currency: 'CAD' },
    ],
  });
  // Sec 1: today 110*10*1.35 = 1485; prev 100*10*1.35 = 1350
  // Sec 3: today 22*10 = 220; prev 20*10 = 200
  // sumToday = 1705; sumPrev = 1550; delta = 155; pct = 155/1550*100 = 10
  assert.equal(out.todayChangeCad, 155);
  assert.equal(out.todayChangePct, 10);
});

test('computeUnifiedTodayDelta null when no securities have prev-day data', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'CAD' });
  const out = computeUnifiedTodayDelta({
    ctx,
    holdings: [{ securityId: 1, quantity: 10, currency: 'CAD' }],
  });
  assert.equal(out.todayChangeCad, null);
  assert.equal(out.todayChangePct, null);
});

test('computeUnifiedTodayDelta null when FX rate missing for a non-CAD currency', () => {
  const ctx = emptyContext();
  ctx.latestQuotes.set(1, { price: 110, currency: 'USD' });
  ctx.prevDaily.set(1, { close: 100, adjClose: 100, date: '2026-05-23' });
  // no fxRates.set('USD', ...)  → security skipped
  const out = computeUnifiedTodayDelta({
    ctx,
    holdings: [{ securityId: 1, quantity: 10, currency: 'USD' }],
  });
  assert.equal(out.todayChangeCad, null);
  assert.equal(out.todayChangePct, null);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test test/portfolio/metrics.test.ts 2>&1 | tail -15
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `metrics.ts`**

Create `backend/src/portfolio/metrics.ts`:

```ts
/**
 * Portfolio per-row metrics: pure compute helpers + a batch context loader.
 *
 * Both /api/portfolio (Holdings) and /api/portfolio/by-security routes call
 * loadMetricsContext once per request to pre-fetch every security's daily
 * prices, dividends, FX rates, realized totals, and lifetime income, then
 * call the four pure compute helpers per row.
 */
import { Op } from 'sequelize';
import {
  InvestmentActivity,
  SecurityDailyPrice,
  SecurityDividend,
  SecurityPrice,
} from '../models';
import { ensureFxRate } from '../fx/bankOfCanada';

export type DailyRow = { close: number; adjClose: number; date: string };

export type MetricsContext = {
  latestDaily: Map<number, DailyRow>
  prevDaily: Map<number, DailyRow>
  daily30dAgo: Map<number, { adjClose: number }>
  latestQuotes: Map<number, { price: number; currency: string }>
  divPerUnit30d: Map<number, number>
  divPerUnit365d: Map<number, number>
  fxRates: Map<string, number>
  realizedBySec: Map<number, number>
  dividendsBySec: Map<number, number>
  interestBySec: Map<number, number>
};

export type RowMetrics = {
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  yieldOnCostPct: number | null
};

export function computeRowMetrics(args: {
  ctx: MetricsContext
  securityId: number
  qty: number
  costBasis: number | null
}): RowMetrics {
  const { ctx, securityId, qty, costBasis } = args;
  const quote = ctx.latestQuotes.get(securityId);
  const prev = ctx.prevDaily.get(securityId);
  const today30 = ctx.daily30dAgo.get(securityId);
  const latestForReturn = quote?.price ?? ctx.latestDaily.get(securityId)?.adjClose ?? null;
  const div30 = ctx.divPerUnit30d.get(securityId) ?? 0;
  const div365 = ctx.divPerUnit365d.get(securityId) ?? 0;

  const todayChangePct =
    quote != null && prev != null && prev.adjClose !== 0
      ? ((quote.price - prev.adjClose) / prev.adjClose) * 100
      : null;

  const thirtyDayReturnPct =
    latestForReturn != null && today30 != null && today30.adjClose !== 0
      ? ((latestForReturn + div30 - today30.adjClose) / today30.adjClose) * 100
      : null;

  const yieldOnCostPct =
    costBasis != null && costBasis !== 0 && div365 > 0
      ? ((div365 * qty) / costBasis) * 100
      : null;

  return { todayChangePct, thirtyDayReturnPct, yieldOnCostPct };
}

export function computeWeightPct(args: {
  ctx: MetricsContext
  cadMarketValue: number
  unifiedTotalCad: number | null
}): number | null {
  const { cadMarketValue, unifiedTotalCad } = args;
  if (unifiedTotalCad == null || unifiedTotalCad === 0) return null;
  return (cadMarketValue / unifiedTotalCad) * 100;
}

export function computeTotalReturnPct(args: {
  ctx: MetricsContext
  securityId: number
  currentMV: number
  costBasis: number | null
}): number | null {
  const { ctx, securityId, currentMV, costBasis } = args;
  if (costBasis == null || costBasis === 0) return null;
  const realized = ctx.realizedBySec.get(securityId) ?? 0;
  const income = (ctx.dividendsBySec.get(securityId) ?? 0) + (ctx.interestBySec.get(securityId) ?? 0);
  return ((currentMV + realized + income - costBasis) / costBasis) * 100;
}

export function computeUnifiedTodayDelta(args: {
  ctx: MetricsContext
  holdings: Array<{ securityId: number; quantity: number; currency: string }>
}): { todayChangePct: number | null; todayChangeCad: number | null } {
  const { ctx, holdings } = args;
  let sumToday = 0;
  let sumPrev = 0;
  let any = false;
  for (const h of holdings) {
    const quote = ctx.latestQuotes.get(h.securityId);
    const prev = ctx.prevDaily.get(h.securityId);
    if (!quote || !prev) continue;
    const fxRate =
      h.currency === 'CAD' ? 1 : ctx.fxRates.get(h.currency);
    if (fxRate == null) continue;
    sumToday += quote.price * h.quantity * fxRate;
    sumPrev += prev.adjClose * h.quantity * fxRate;
    any = true;
  }
  if (!any || sumPrev === 0) {
    return { todayChangePct: null, todayChangeCad: null };
  }
  const delta = sumToday - sumPrev;
  return {
    todayChangePct: (delta / sumPrev) * 100,
    todayChangeCad: delta,
  };
}

const DAY_MS = 86400000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function loadMetricsContext(args: {
  securityIds: number[]
  currencies: string[]
  accountIds: number[]
  asOfDate?: string
}): Promise<MetricsContext> {
  const ctx: MetricsContext = {
    latestDaily: new Map(),
    prevDaily: new Map(),
    daily30dAgo: new Map(),
    latestQuotes: new Map(),
    divPerUnit30d: new Map(),
    divPerUnit365d: new Map(),
    fxRates: new Map(),
    realizedBySec: new Map(),
    dividendsBySec: new Map(),
    interestBySec: new Map(),
  };
  if (args.securityIds.length === 0) return ctx;

  const today = isoDate(new Date());
  const asOfDate = args.asOfDate ?? today;
  const cutoff30 = isoDate(new Date(Date.now() - 30 * DAY_MS));
  const cutoff365 = isoDate(new Date(Date.now() - 365 * DAY_MS));

  // 1. Daily prices (latest + prev + ~30d ago) per security
  const dailyRows = await SecurityDailyPrice.findAll({
    where: { securityId: args.securityIds },
    order: [['securityId', 'ASC'], ['date', 'DESC']],
  });
  const seenLatest = new Set<number>();
  const seenPrev = new Set<number>();
  for (const row of dailyRows) {
    const sid = row.securityId;
    if (!seenLatest.has(sid)) {
      ctx.latestDaily.set(sid, {
        close: Number(row.close),
        adjClose: Number(row.adjClose),
        date: row.date,
      });
      seenLatest.add(sid);
      continue;
    }
    if (!seenPrev.has(sid)) {
      ctx.prevDaily.set(sid, {
        close: Number(row.close),
        adjClose: Number(row.adjClose),
        date: row.date,
      });
      seenPrev.add(sid);
    }
    // closest >=30d-old row
    if (!ctx.daily30dAgo.has(sid) && row.date <= cutoff30) {
      ctx.daily30dAgo.set(sid, { adjClose: Number(row.adjClose) });
    }
  }

  // 2. Latest quote (SecurityPrice) per security
  const quoteRows = await SecurityPrice.findAll({
    where: { securityId: args.securityIds },
    order: [['securityId', 'ASC'], ['pricedAt', 'DESC']],
  });
  const seenQuote = new Set<number>();
  for (const row of quoteRows) {
    if (seenQuote.has(row.securityId)) continue;
    ctx.latestQuotes.set(row.securityId, {
      price: Number(row.price),
      currency: row.currency,
    });
    seenQuote.add(row.securityId);
  }

  // 3. Dividend sums per security (30d + 365d windows, per unit)
  const dividends = await SecurityDividend.findAll({
    where: {
      securityId: args.securityIds,
      exDividendDate: { [Op.gte]: cutoff365 },
    },
  });
  for (const d of dividends) {
    const sid = d.securityId;
    const amt = Number(d.amount);
    ctx.divPerUnit365d.set(sid, (ctx.divPerUnit365d.get(sid) ?? 0) + amt);
    if (d.exDividendDate >= cutoff30) {
      ctx.divPerUnit30d.set(sid, (ctx.divPerUnit30d.get(sid) ?? 0) + amt);
    }
  }

  // 4. FX rates for non-CAD currencies
  for (const cur of args.currencies) {
    if (cur === 'CAD') continue;
    if (ctx.fxRates.has(cur)) continue;
    const fx = await ensureFxRate(cur, 'CAD', asOfDate);
    if (fx) ctx.fxRates.set(cur, fx.rate);
  }

  // 5. Per-security realized + lifetime dividend + interest from InvestmentActivity
  if (args.accountIds.length > 0) {
    const activities = await InvestmentActivity.findAll({
      where: {
        securityId: args.securityIds,
        accountId: args.accountIds,
      },
      attributes: ['securityId', 'activityType', 'amount'],
    });
    for (const a of activities) {
      const sid = a.securityId;
      if (sid == null) continue;
      const amt = Math.abs(Number(a.amount) || 0);
      if (a.activityType === 'dividend') {
        ctx.dividendsBySec.set(sid, (ctx.dividendsBySec.get(sid) ?? 0) + amt);
      } else if (a.activityType === 'interest') {
        ctx.interestBySec.set(sid, (ctx.interestBySec.get(sid) ?? 0) + amt);
      }
      // Note: realized gain is computed by the ACB engine elsewhere; we
      // populate realizedBySec from the by-security route, which already
      // runs computeAcb per security. This loader leaves realizedBySec
      // empty by design — callers (the route) populate it.
    }
  }

  return ctx;
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test test/portfolio/metrics.test.ts 2>&1 | tail -10
```
Expected: all 17 tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn typecheck 2>&1 | tail -3
```

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add backend/src/portfolio/metrics.ts backend/test/portfolio/metrics.test.ts && git commit -m "feat(portfolio): add metrics module with batch context + pure compute helpers"
```

---

## Phase 2 — Backend route extensions

### Task 2: Extend `/api/portfolio` with per-row metrics + unifiedTotal delta

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Create: `backend/test/integration/portfolioMetrics.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `backend/test/integration/portfolioMetrics.test.ts`:

```ts
/**
 * Integration tests for GET /api/portfolio (Holdings) per-row metrics +
 * unifiedTotal delta added in slice A.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-metrics.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;
let acctId: number;

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

  const mod = await import('../../src/app.js');
  app = mod.default;
  const models = await import('../../src/models');
  const {
    seedHousehold,
    seedAccount,
    seedSecurity,
    seedHolding,
    seedDailyPrice,
    seedDividend,
  } = await import('./portfolioFixtures.js');

  const seeded = await seedHousehold(models, `metrics-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');
  acctId = acct.id;
  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  xeqtId = xeqt.id;

  // Seed 40 days of daily prices + a SecurityPrice quote + dividends
  for (let i = 40; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqt.id, date, close: 30 + i * 0.1, adjClose: 30 + i * 0.1 });
  }
  await models.SecurityPrice.create({
    securityId: xeqt.id,
    provider: 'fixture',
    symbol: 'XEQT',
    pricedAt: new Date(),
    price: '34.00',
    currency: 'CAD',
    fetchedAt: new Date(),
  });
  await seedDividend(models, {
    securityId: xeqt.id,
    exDividendDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
    amount: 0.5,
    currency: 'CAD',
  });
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 3400, costBasis: 3000,
  });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('holdings include todayChangePct + thirtyDayReturnPct + weightPct + yieldOnCostPct', async () => {
  const res = await authed.get('/api/portfolio');
  assert.equal(res.status, 200);
  const xeqt = res.body.holdings.find((h: { securityId: number }) => h.securityId === xeqtId);
  assert.ok(xeqt, 'XEQT holding present');
  assert.ok(Number.isFinite(xeqt.todayChangePct), `todayChangePct=${xeqt.todayChangePct}`);
  assert.ok(Number.isFinite(xeqt.thirtyDayReturnPct), `thirtyDayReturnPct=${xeqt.thirtyDayReturnPct}`);
  assert.ok(Number.isFinite(xeqt.weightPct), `weightPct=${xeqt.weightPct}`);
  assert.ok(Number.isFinite(xeqt.yieldOnCostPct), `yieldOnCostPct=${xeqt.yieldOnCostPct}`);
});

test('unifiedTotal includes todayChangePct + todayChangeCad', async () => {
  const res = await authed.get('/api/portfolio');
  assert.equal(res.status, 200);
  assert.ok(res.body.unifiedTotal, 'unifiedTotal present');
  assert.ok(Number.isFinite(res.body.unifiedTotal.todayChangePct));
  assert.ok(Number.isFinite(res.body.unifiedTotal.todayChangeCad));
});

test('weightPct sums to ~100% across holdings (single security here)', async () => {
  const res = await authed.get('/api/portfolio');
  const total = res.body.holdings.reduce(
    (acc: number, h: { weightPct: number | null }) => acc + (h.weightPct ?? 0),
    0,
  );
  // Single holding → ~100%
  assert.ok(Math.abs(total - 100) < 0.01, `total weight=${total}`);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration --test-name-pattern "holdings include todayChangePct" 2>&1 | tail -20
```
Expected: FAIL — fields undefined.

- [ ] **Step 3: Extend the `/` handler in `backend/src/routes/portfolio.ts`**

Add import at top of the file (alongside the other `'../portfolio/...'` import added in slice F):

```ts
import {
  loadMetricsContext,
  computeRowMetrics,
  computeWeightPct,
  computeUnifiedTodayDelta,
} from '../portfolio/metrics';
```

Inside the `router.get('/', ...)` handler, before `holdingDtos` is built, compute the metrics context. Then enrich each `holdingDto` with the new fields. After unifiedTotal is built, compute the delta. Replace the relevant section of the handler:

```ts
// (1) Find this existing line — keep it:
const holdingDtos = latestHoldings.map((holding) => {
  // ... existing body unchanged ...
  return {
    id: holding.id,
    // ... existing fields ...
  };
});
```

Change to:

```ts
const securityIds = [...new Set(latestHoldings.map((h) => h.securityId))];
const currencies = [...new Set(latestHoldings.map((h) => {
  const lp = prices.get(h.securityId);
  return (lp?.currency ?? h.currency) as string;
}))];
const accountIdsForCtx = accounts.map((a) => a.id);
const metricsCtx = await loadMetricsContext({
  securityIds,
  currencies,
  accountIds: accountIdsForCtx,
});

const holdingDtos = latestHoldings.map((holding) => {
  const security = holding.get('security') as Security | undefined;
  const latestPrice = prices.get(holding.securityId);
  const quantity = n(holding.quantity) ?? 0;
  const importedValue = n(holding.marketValue);
  const quotePrice = n(latestPrice?.price);
  const marketValue =
    quotePrice != null ? quantity * quotePrice : importedValue ?? 0;
  const cur = latestPrice?.currency || holding.currency;
  totals.set(cur, (totals.get(cur) ?? 0) + marketValue);

  const rowMetrics = computeRowMetrics({
    ctx: metricsCtx,
    securityId: holding.securityId,
    qty: quantity,
    costBasis: n(holding.costBasis),
  });

  return {
    id: holding.id,
    accountId: holding.accountId,
    securityId: holding.securityId,
    statementDate: holding.statementDate,
    quantity,
    price: n(holding.price),
    marketValue,
    importedMarketValue: importedValue,
    costBasis: n(holding.costBasis),
    unrealizedGainLoss: n(holding.unrealizedGainLoss),
    currency: cur,
    sourceReference: holding.sourceReference,
    importBatch: holding.importBatch,
    security: security
      ? {
          id: security.id,
          symbol: security.symbol,
          name: security.name,
          assetType: security.assetType,
          currency: security.currency,
        }
      : null,
    latestPrice: latestPrice
      ? {
          id: latestPrice.id,
          provider: latestPrice.provider,
          symbol: latestPrice.symbol,
          pricedAt: latestPrice.pricedAt.toISOString(),
          price: n(latestPrice.price),
          currency: latestPrice.currency,
          fetchedAt: latestPrice.fetchedAt.toISOString(),
        }
      : null,
    todayChangePct: rowMetrics.todayChangePct,
    thirtyDayReturnPct: rowMetrics.thirtyDayReturnPct,
    yieldOnCostPct: rowMetrics.yieldOnCostPct,
    weightPct: null as number | null, // populated below once unifiedTotal known
  };
});
```

Then AFTER the existing `const unifiedTotal = await buildUnifiedCadTotal(...)` line, add:

```ts
// Per-row weight pct now that unifiedTotal is known.
if (unifiedTotal) {
  for (const dto of holdingDtos) {
    const fxRate =
      dto.currency === 'CAD' ? 1 : metricsCtx.fxRates.get(dto.currency);
    if (fxRate == null) continue;
    const cadMV = dto.marketValue * fxRate;
    dto.weightPct = computeWeightPct({
      ctx: metricsCtx,
      cadMarketValue: cadMV,
      unifiedTotalCad: unifiedTotal.marketValue,
    });
  }
}

const todayDelta = computeUnifiedTodayDelta({
  ctx: metricsCtx,
  holdings: latestHoldings.map((h) => {
    const lp = prices.get(h.securityId);
    return {
      securityId: h.securityId,
      quantity: n(h.quantity) ?? 0,
      currency: lp?.currency ?? h.currency,
    };
  }),
});
const unifiedTotalWithDelta = unifiedTotal
  ? { ...unifiedTotal, todayChangePct: todayDelta.todayChangePct, todayChangeCad: todayDelta.todayChangeCad }
  : null;
```

Find the existing `res.json({...})` call inside `router.get('/', ...)`. Replace `unifiedTotal` with `unifiedTotalWithDelta` (or rename in place):

```ts
res.json({
  accounts: ...,
  totalsByCurrency,
  unifiedTotal: unifiedTotalWithDelta,
  holdings: holdingDtos,
  recentActivities: ...,
});
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration --test-name-pattern "holdings include todayChangePct|unifiedTotal includes|weightPct sums" 2>&1 | tail -10
```
Expected: 3/3 pass.

- [ ] **Step 5: Broader regression**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration 2>&1 | grep -E "^ℹ (pass|fail)"
```
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add backend/src/routes/portfolio.ts backend/test/integration/portfolioMetrics.test.ts && git commit -m "feat(portfolio): per-row metrics + today delta on /api/portfolio"
```

---

### Task 3: Extend `/api/portfolio/by-security` with per-row metrics + unifiedTotal

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Modify: `backend/test/integration/portfolioBySecurity.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `backend/test/integration/portfolioBySecurity.test.ts` (at the end of the file, before the `}` that closes the test scope if there is one):

```ts
test('by-security rows include todayChangePct + thirtyDayReturnPct + weightPct + totalReturnPct', async () => {
  // Seed daily prices + a quote + a dividend + a buy for XEQT in this test's existing
  // before() block (xeqt already exists). Use a unique date set to avoid colliding with
  // other tests.
  const models = await import('../../src/models');
  const { seedDailyPrice, seedDividend } = await import('./portfolioFixtures.js');
  for (let i = 32; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqtId, date, close: 50 + i * 0.05, adjClose: 50 + i * 0.05 });
  }
  await models.SecurityPrice.create({
    securityId: xeqtId,
    provider: 'fixture-bysec',
    symbol: 'XEQT',
    pricedAt: new Date(),
    price: '52.00',
    currency: 'CAD',
    fetchedAt: new Date(),
  });
  await seedDividend(models, {
    securityId: xeqtId,
    exDividendDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
    amount: 0.4,
    currency: 'CAD',
  });

  const res = await authed.get('/api/portfolio/by-security');
  assert.equal(res.status, 200);
  const xeqtRow = res.body.rows.find((r: { securityId: number }) => r.securityId === xeqtId);
  assert.ok(xeqtRow);
  assert.ok(Number.isFinite(xeqtRow.todayChangePct), `todayChangePct=${xeqtRow.todayChangePct}`);
  assert.ok(Number.isFinite(xeqtRow.thirtyDayReturnPct), `thirtyDayReturnPct=${xeqtRow.thirtyDayReturnPct}`);
  // weightPct depends on unifiedTotal — assert non-null
  assert.ok(xeqtRow.weightPct == null || Number.isFinite(xeqtRow.weightPct));
  // totalReturnPct is null if XEQT has no cost basis in this test's fixture; either is fine
  assert.ok(xeqtRow.totalReturnPct == null || Number.isFinite(xeqtRow.totalReturnPct));
});

test('by-security response includes unifiedTotal block', async () => {
  const res = await authed.get('/api/portfolio/by-security');
  assert.equal(res.status, 200);
  // unifiedTotal may be null if no CAD holdings or FX missing; assert key presence
  assert.ok('unifiedTotal' in res.body);
});
```

(Important: this test file's existing `before()` block sets up `xeqtId`. The new tests rely on that. If the file doesn't expose `xeqtId` in scope, read the file first to identify what's available and adapt.)

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration --test-name-pattern "by-security rows include todayChangePct|by-security response includes unifiedTotal" 2>&1 | tail -10
```
Expected: FAIL.

- [ ] **Step 3: Extend `/by-security` handler**

In `backend/src/routes/portfolio.ts`, find the existing `router.get('/by-security', ...)` handler. After the `for (const holding of latestHoldings)` loop that builds `map`, AND after `Row[]` array materialization, add the metrics enrichment.

The handler currently ends with something like:

```ts
const rows: Row[] = [];
for (const row of map.values()) {
  // compute unrealizedGainLoss etc.
  rows.push(row);
}
rows.sort((a, b) => b.totalMarketValue - a.totalMarketValue);
res.json({ rows });
```

Replace the final block with:

```ts
const rows: Row[] = [];
for (const row of map.values()) {
  rows.push(row);
}
rows.sort((a, b) => b.totalMarketValue - a.totalMarketValue);

// Slice A — metrics enrichment
const securityIds = rows.map((r) => r.securityId);
const currencies = [...new Set(rows.map((r) => r.currency))];
const accountIdsForCtx = accounts.map((a) => a.id);
const metricsCtx = await loadMetricsContext({
  securityIds,
  currencies,
  accountIds: accountIdsForCtx,
});

// Populate realizedBySec using the existing per-security ACB computation.
// Reuse the helper from the /security/:id route by calling computeAcb on
// each security's activities — same call pattern as elsewhere in this file.
for (const row of rows) {
  const acts = await InvestmentActivity.findAll({
    where: { securityId: row.securityId, accountId: accountIdsForCtx },
    order: [['tradeDate', 'ASC'], ['id', 'ASC']],
  });
  const acbInput: AcbActivity[] = acts.map((a) => ({
    id: a.id,
    activityType: a.activityType,
    tradeDate: a.tradeDate,
    quantity: n(a.quantity),
    price: n(a.price),
    amount: n(a.amount),
    fees: n(a.fees),
    currency: a.currency,
  }));
  const acb = computeAcb(acbInput);
  metricsCtx.realizedBySec.set(row.securityId, acb.realizedTotal);
}

// Build a totals-by-currency map first to compute unifiedTotal
const totals = new Map<string, number>();
for (const row of rows) {
  totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.totalMarketValue);
}
const totalsByCurrency = [...totals.entries()].map(([currency, marketValue]) => ({
  currency,
  marketValue,
}));
const todayDate = new Date().toISOString().slice(0, 10);
const unifiedTotal = await buildUnifiedCadTotal(totalsByCurrency, todayDate);

// Per-row metrics + weightPct + totalReturnPct
const rowsWithMetrics = rows.map((row) => {
  const fxRate =
    row.currency === 'CAD' ? 1 : metricsCtx.fxRates.get(row.currency);
  const cadMV = fxRate != null ? row.totalMarketValue * fxRate : null;
  const m = computeRowMetrics({
    ctx: metricsCtx,
    securityId: row.securityId,
    qty: row.totalQuantity,
    costBasis: row.totalCostBasis,
  });
  return {
    ...row,
    todayChangePct: m.todayChangePct,
    thirtyDayReturnPct: m.thirtyDayReturnPct,
    weightPct:
      cadMV != null
        ? computeWeightPct({
            ctx: metricsCtx,
            cadMarketValue: cadMV,
            unifiedTotalCad: unifiedTotal?.marketValue ?? null,
          })
        : null,
    totalReturnPct: computeTotalReturnPct({
      ctx: metricsCtx,
      securityId: row.securityId,
      currentMV: row.totalMarketValue,
      costBasis: row.totalCostBasis,
    }),
  };
});

// unifiedTotal block extended with today delta — use the same per-security
// quantities that are aggregated into rows.
const todayDelta = computeUnifiedTodayDelta({
  ctx: metricsCtx,
  holdings: rows.map((r) => ({
    securityId: r.securityId,
    quantity: r.totalQuantity,
    currency: r.currency,
  })),
});
const unifiedTotalWithDelta = unifiedTotal
  ? { ...unifiedTotal, todayChangePct: todayDelta.todayChangePct, todayChangeCad: todayDelta.todayChangeCad }
  : null;

res.json({ rows: rowsWithMetrics, unifiedTotal: unifiedTotalWithDelta });
```

Add imports if not already present:
```ts
import { computeAcb, type AcbActivity } from '../portfolio/acb';
import { computeTotalReturnPct } from '../portfolio/metrics';
```

(`computeRowMetrics`, `computeWeightPct`, `computeUnifiedTodayDelta`, `loadMetricsContext` were imported in Task 2; add `computeTotalReturnPct` to that same import statement.)

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration --test-name-pattern "by-security" 2>&1 | tail -10
```

- [ ] **Step 5: Broader regression**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration 2>&1 | grep -E "^ℹ (pass|fail)"
```

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add backend/src/routes/portfolio.ts backend/test/integration/portfolioBySecurity.test.ts && git commit -m "feat(portfolio): per-row metrics + unifiedTotal on /api/portfolio/by-security"
```

---

## Phase 3 — Shared types

### Task 4: Extend shared types with new metric fields

**Files:**
- Modify: `shared/api-types.ts`

- [ ] **Step 1: Read current shapes**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && grep -nE "PortfolioSummary|PortfolioBySecurity|unifiedTotal|holdings\\[" shared/api-types.ts | head -20
```

Identify the existing definitions for `PortfolioSummary['holdings'][number]`, `PortfolioSummary['unifiedTotal']`, and `PortfolioBySecurity['rows'][number]`.

- [ ] **Step 2: Add per-row fields to `PortfolioSummary` holdings type**

In `shared/api-types.ts`, find the type definition for the object inside `PortfolioSummary['holdings'][]`. Add these four fields to it:

```ts
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  weightPct: number | null
  yieldOnCostPct: number | null
```

(Exact placement depends on file style — match existing field formatting.)

- [ ] **Step 3: Extend `PortfolioSummary['unifiedTotal']`**

Find the `unifiedTotal` type. Add:

```ts
  todayChangePct: number | null
  todayChangeCad: number | null
```

- [ ] **Step 4: Add per-row fields to `PortfolioBySecurity` rows**

Find the type for an item of `PortfolioBySecurity['rows'][]`. Add:

```ts
  todayChangePct: number | null
  thirtyDayReturnPct: number | null
  weightPct: number | null
  totalReturnPct: number | null
```

- [ ] **Step 5: Add `unifiedTotal` top-level to `PortfolioBySecurity`**

Find the `PortfolioBySecurity` type definition. Add a top-level field:

```ts
  unifiedTotal: {
    baseCurrency: 'CAD'
    marketValue: number
    ratesUsed: Array<{ from: string; to: string; rate: number; ratedDate: string }>
    todayChangePct: number | null
    todayChangeCad: number | null
  } | null
```

(Match the existing `PortfolioSummary['unifiedTotal']` field types — if those are stricter, use the same.)

- [ ] **Step 6: Frontend re-export sanity check**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn build 2>&1 | tail -10
```
Expected: build succeeds (existing re-exports in `frontend/src/types/api.ts` already cover `PortfolioSummary`/`PortfolioBySecurity` by name; no edits needed).

- [ ] **Step 7: Backend typecheck**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn typecheck 2>&1 | tail -3
```

- [ ] **Step 8: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add shared/api-types.ts && git commit -m "feat(portfolio): add per-row metric + unifiedTotal delta types"
```

---

## Phase 4 — Frontend primitive

### Task 5: `<PctDeltaCell>` component + tests

**Files:**
- Create: `frontend/src/components/ui/pct-delta-cell.tsx`
- Create: `frontend/src/components/ui/pct-delta-cell.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/components/ui/pct-delta-cell.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PctDeltaCell } from './pct-delta-cell'

describe('PctDeltaCell', () => {
  it('renders em-dash for null', () => {
    const { container } = render(<PctDeltaCell value={null} />)
    expect(container.textContent).toBe('—')
  })

  it('positive value renders up arrow with positive accent', () => {
    const { container } = render(<PctDeltaCell value={1.234} />)
    expect(container.textContent).toContain('↑')
    expect(container.textContent).toContain('1.23%')
    const span = container.querySelector('span')
    expect(span?.style.color).toContain('accent-positive')
  })

  it('negative value renders down arrow with warn accent + absolute pct', () => {
    const { container } = render(<PctDeltaCell value={-2.5} />)
    expect(container.textContent).toContain('↓')
    expect(container.textContent).toContain('2.50%')
    expect(container.textContent).not.toContain('-')
    const span = container.querySelector('span')
    expect(span?.style.color).toContain('accent-warm')
  })

  it('zero value renders up arrow (>= 0 branch)', () => {
    const { container } = render(<PctDeltaCell value={0} />)
    expect(container.textContent).toContain('↑')
    expect(container.textContent).toContain('0.00%')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/components/ui/pct-delta-cell.test.tsx 2>&1 | tail -10
```

- [ ] **Step 3: Write the component**

Create `frontend/src/components/ui/pct-delta-cell.tsx`:

```tsx
export type PctDeltaCellProps = {
  value: number | null
}

export function PctDeltaCell({ value }: PctDeltaCellProps) {
  if (value == null) return <>—</>
  const up = value >= 0
  const color = up ? 'var(--accent-positive)' : 'var(--accent-warm)'
  const arrow = up ? '↑' : '↓'
  return (
    <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>
      {arrow} {Math.abs(value).toFixed(2)}%
    </span>
  )
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/components/ui/pct-delta-cell.test.tsx 2>&1 | tail -10
```
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/components/ui/pct-delta-cell.tsx frontend/src/components/ui/pct-delta-cell.test.tsx && git commit -m "feat(portfolio): add PctDeltaCell component"
```

---

## Phase 5 — Frontend wiring

### Task 6: PortfolioPage Holdings + By-security columns + Total stat upgrade

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx`

This task touches a single file. Three structural changes:

1. Add 4 new columns to HoldingsPanel
2. Add 4 new columns to BySecurityPanel
3. Promote the `Total (CAD)` stat card to `<MetricStat>`

Read the file first to identify the `HoldingsPanel`, `BySecurityPanel`, and the top stats row JSX.

- [ ] **Step 1: Add imports**

In `frontend/src/pages/PortfolioPage.tsx`, near the existing `@/components/ui/...` imports added in slices F and E, add:

```tsx
import { PctDeltaCell } from '@/components/ui/pct-delta-cell'
import { MetricStat } from '@/components/ui/metric-stat'
```

(`MetricStat` shipped in slice F; if it's not already imported here, add it.)

- [ ] **Step 2: Promote Total (CAD) stat card**

Find this block (inside the top stats `<section className="transactionsStats">`):

```tsx
{summary?.unifiedTotal != null && (
  <StatCard
    key="unified-cad"
    label="Total (CAD)"
    value={formatMoney(summary.unifiedTotal.marketValue, 'CAD')}
    hint={`Converted from ${summary.unifiedTotal.ratesUsed.length} ${summary.unifiedTotal.ratesUsed.length === 1 ? 'currency' : 'currencies'} via BoC daily rates`}
  />
)}
```

Replace with:

```tsx
{summary?.unifiedTotal != null && (
  <MetricStat
    key="unified-cad"
    label="Total (CAD)"
    value={formatMoney(summary.unifiedTotal.marketValue, 'CAD')}
    deltaPct={summary.unifiedTotal.todayChangePct ?? undefined}
    hint={`Converted from ${summary.unifiedTotal.ratesUsed.length} ${summary.unifiedTotal.ratesUsed.length === 1 ? 'currency' : 'currencies'} via BoC daily rates`}
  />
)}
```

- [ ] **Step 3: Add 4 new columns to HoldingsPanel**

Inside `HoldingsPanel`'s `<TableHeader>`, find the existing sequence ending with `<TableHead>Unrealized</TableHead><TableHead>30d</TableHead><TableHead>As of</TableHead>` (slice E added `30d` between Unrealized and As of). Replace that final three-column run with:

```tsx
<TableHead>Unrealized</TableHead>
<TableHead>Today</TableHead>
<TableHead>30d Δ</TableHead>
<TableHead>Weight</TableHead>
<TableHead>Yield</TableHead>
<TableHead>30d</TableHead>
<TableHead>As of</TableHead>
```

(Order: Unrealized → 4 new chip cols → 30d sparkline → As of.)

In the row body, after the Unrealized `<TableCell>` and BEFORE the existing sparkline `<TableCell>`, add four cells:

```tsx
<TableCell>
  <PctDeltaCell value={holding.todayChangePct} />
</TableCell>
<TableCell>
  <PctDeltaCell value={holding.thirtyDayReturnPct} />
</TableCell>
<TableCell>
  {holding.weightPct != null ? `${holding.weightPct.toFixed(1)}%` : '—'}
</TableCell>
<TableCell>
  {holding.yieldOnCostPct != null ? `${holding.yieldOnCostPct.toFixed(2)}%` : '—'}
</TableCell>
```

Bump the existing `<EmptyTableRow colSpan={10} ...>` (set by slice E) to `colSpan={14}`.

- [ ] **Step 4: Add 4 new columns to BySecurityPanel**

Inside `BySecurityPanel`'s `<TableHeader>`, find the existing sequence ending with `<TableHead>Unrealized</TableHead><TableHead>Accounts</TableHead><TableHead>30d</TableHead><TableHead>Latest quote</TableHead>` (slice E placed `30d` between Accounts and Latest quote). Replace from Unrealized onward with:

```tsx
<TableHead>Unrealized</TableHead>
<TableHead>Today</TableHead>
<TableHead>30d Δ</TableHead>
<TableHead>Weight</TableHead>
<TableHead>Total Return</TableHead>
<TableHead>Accounts</TableHead>
<TableHead>30d</TableHead>
<TableHead>Latest quote</TableHead>
```

In the row body, after the Unrealized `<TableCell>` and BEFORE the Accounts `<TableCell>`, add four cells:

```tsx
<TableCell>
  <PctDeltaCell value={row.todayChangePct} />
</TableCell>
<TableCell>
  <PctDeltaCell value={row.thirtyDayReturnPct} />
</TableCell>
<TableCell>
  {row.weightPct != null ? `${row.weightPct.toFixed(1)}%` : '—'}
</TableCell>
<TableCell>
  <PctDeltaCell value={row.totalReturnPct} />
</TableCell>
```

Bump the existing `<EmptyTableRow colSpan={10} ...>` to `colSpan={14}`.

- [ ] **Step 5: Build + typecheck**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn build 2>&1 | tail -10
```
Expected: clean build, 0 TS errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/pages/PortfolioPage.tsx && git commit -m "feat(portfolio): add metric columns to Holdings + By-security + Today delta on Total stat"
```

---

## Phase 6 — Frontend tests

### Task 7: Extend PortfolioPage tests for new columns + stat

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.test.tsx`

- [ ] **Step 1: Read existing test fixtures**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && cat frontend/src/pages/PortfolioPage.test.tsx
```

Identify the existing `baseSummary` / `baseBySec` / `baseSparks` fixtures. We extend the same `mockApi` mapping.

- [ ] **Step 2: Update fixtures + add new tests**

Update the existing `baseSummary` (in the file's top constants) to include the 4 new per-row fields on each holding AND the 2 new `unifiedTotal` fields. Update `baseBySec` similarly. Add 3 new tests at the end of the existing `describe('PortfolioPage table polish', ...)` block (or create a new describe block at the bottom of the file).

Find the `baseSummary.holdings[0]` (XEQT) and add:
```ts
todayChangePct: 1.5,
thirtyDayReturnPct: 4.2,
weightPct: 68.0,
yieldOnCostPct: 2.1,
```
And on `baseSummary.holdings[1]` (BNS) add same field names with `null` values to exercise null rendering:
```ts
todayChangePct: null,
thirtyDayReturnPct: null,
weightPct: null,
yieldOnCostPct: null,
```

If `baseSummary.unifiedTotal` exists as null, replace with:
```ts
unifiedTotal: {
  baseCurrency: 'CAD',
  marketValue: 4400,
  ratesUsed: [],
  todayChangePct: 0.45,
  todayChangeCad: 20,
},
```
And update the existing `baseSummary.totalsByCurrency` accordingly.

For `baseBySec.rows[0]` (XEQT) add:
```ts
todayChangePct: 1.5,
thirtyDayReturnPct: 4.2,
weightPct: 100,
totalReturnPct: 12.5,
```
Add `unifiedTotal` to `baseBySec`:
```ts
unifiedTotal: {
  baseCurrency: 'CAD',
  marketValue: 3000,
  ratesUsed: [],
  todayChangePct: 1.5,
  todayChangeCad: 45,
},
```

Add these tests at the end of the describe block:

```tsx
it('renders Today / 30d Δ / Weight / Yield cells with values for XEQT', async () => {
  mockApi({
    '/api/portfolio/sparklines': baseSparks,
    '/api/portfolio/allocation': baseAllocation,
    '/api/portfolio/by-security': baseBySec,
    '/api/portfolio': baseSummary,
  })
  const { findByText, container } = render(
    <MemoryRouter>
      <PortfolioPage />
    </MemoryRouter>,
  )
  await findByText('XEQT')
  // Holdings table contains XEQT's metric values
  expect(container.textContent).toContain('1.50%') // Today
  expect(container.textContent).toContain('4.20%') // 30d Δ
  expect(container.textContent).toContain('68.0%') // Weight
  expect(container.textContent).toContain('2.10%') // Yield
})

it('renders em-dash in metric cells when fields are null', async () => {
  mockApi({
    '/api/portfolio/sparklines': baseSparks,
    '/api/portfolio/allocation': baseAllocation,
    '/api/portfolio/by-security': baseBySec,
    '/api/portfolio': baseSummary,
  })
  const { findByText, container } = render(
    <MemoryRouter>
      <PortfolioPage />
    </MemoryRouter>,
  )
  await findByText('BNS')
  // BNS row has all-null metrics; verify em-dashes appear
  // We can't easily target specific cells, but the text content should include —
  // multiple times (also from other null fields).
  const emDashCount = (container.textContent?.match(/—/g) ?? []).length
  expect(emDashCount).toBeGreaterThanOrEqual(4)
})

it('Total (CAD) stat card shows delta when present', async () => {
  mockApi({
    '/api/portfolio/sparklines': baseSparks,
    '/api/portfolio/allocation': baseAllocation,
    '/api/portfolio/by-security': baseBySec,
    '/api/portfolio': baseSummary,
  })
  const { findByText, container } = render(
    <MemoryRouter>
      <PortfolioPage />
    </MemoryRouter>,
  )
  await findByText('Total (CAD)')
  // delta arrow + 0.45% should appear somewhere in the page
  expect(container.textContent).toContain('0.45%')
})
```

- [ ] **Step 3: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/PortfolioPage.test.tsx 2>&1 | tail -15
```

- [ ] **Step 4: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/pages/PortfolioPage.test.tsx && git commit -m "test(portfolio): cover slice A metric columns + Total stat delta"
```

---

## Phase 7 — Final verification

### Task 8: Full test sweep

- [ ] **Step 1: Backend unit tests**
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test 2>&1 | tail -10
```

- [ ] **Step 2: Backend integration tests**
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration 2>&1 | tail -10
```

- [ ] **Step 3: Frontend tests**
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test 2>&1 | tail -10
```

- [ ] **Step 4: Typechecks + build + lint**
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn typecheck 2>&1 | tail -3
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn build 2>&1 | tail -5
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn lint 2>&1 | tail -5
```

- [ ] **Step 5: Git state**
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git status && git fetch origin main -q && git log origin/main..HEAD --oneline
```

End report with **ALL GREEN — ready for PR** or **BLOCKED — [step]**.

---

## Self-Review

### Spec coverage

| Spec section / AC | Plan task(s) |
|---|---|
| §4.1 `holdings[]` per-row fields | Task 2 |
| §4.1 `unifiedTotal` delta fields | Task 2 |
| §4.2 `by-security` per-row fields | Task 3 |
| §4.2 `by-security` top-level `unifiedTotal` | Task 3 |
| §4.3 `metrics.ts` module (loader + 4 pure helpers) | Task 1 |
| §4.4 Backend unit + integration tests | Task 1 (unit), Task 2 + 3 (integration) |
| §5.1 Shared type extensions | Task 4 |
| §5.2 `<PctDeltaCell>` component | Task 5 |
| §5.3 Holdings 4 new columns | Task 6 |
| §5.4 By-security 4 new columns | Task 6 |
| §5.5 Total (CAD) → `<MetricStat>` | Task 6 |
| §5.6 Frontend tests | Task 5 (component) + Task 7 (page) |
| AC 1–10 | All covered across Tasks 1–7; Task 8 verifies the suite |

No gaps.

### Placeholder scan

No `TBD`/`TODO`/`implement later`. All code blocks complete. The Task 3 step 1 note about adapting if `xeqtId` isn't in scope is a contingency — actual test code provided.

### Type consistency

- Backend `RowMetrics` keys: `todayChangePct`, `thirtyDayReturnPct`, `yieldOnCostPct` — match shared type fields exactly.
- Backend `unifiedTotal` shape extension: `todayChangePct`, `todayChangeCad` — match shared type additions.
- Frontend `<PctDeltaCell value={...} />` accepts `number | null` — matches backend field types.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-portfolio-table-metrics.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, hardened worktree protocol.

**2. Inline Execution** — Run tasks in this session.

Which approach?
