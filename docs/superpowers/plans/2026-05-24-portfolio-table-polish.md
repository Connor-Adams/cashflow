# Portfolio Table Polish (Slice E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `<SecurityLogo>` to four portfolio tables (Holdings, By-security, Income by-security, Realized by-security) and a 30-day `<Sparkline>` column to two of them (Holdings, By-security), backed by one new batch endpoint.

**Architecture:** New `GET /api/portfolio/sparklines?range=30d` returns `{ bySecurityId: { [id]: [{date, close}] } }` for every security in the caller's visible accounts that has any `security_daily_prices` rows. Frontend fetches it in parallel with the existing portfolio fetches, builds a `Map`, passes down to panels. No backfill is triggered — securities with no daily-price history render a blank sparkline cell. All UI primitives (`<SecurityLogo>`, `<Sparkline>`) ship as-is from slice F.

**Tech Stack:** Backend Sequelize 6 + Express + TypeScript + `node:test` + `supertest`. Frontend React 19 + TypeScript + Vite + Vitest + recharts.

**Spec:** [docs/superpowers/specs/2026-05-24-portfolio-table-polish-design.md](../specs/2026-05-24-portfolio-table-polish-design.md)

---

## File Structure

### Backend — new files

| Path | Responsibility |
|---|---|
| `backend/test/integration/portfolioSparklines.test.ts` | Integration tests for the new endpoint |

### Backend — modified files

| Path | Change |
|---|---|
| `backend/src/routes/portfolio.ts` | Add `GET /sparklines` handler. Reuse `visibleAccountWhere`, `SecurityDailyPrice`, `Op`. |

### Frontend — modified files

| Path | Change |
|---|---|
| `shared/api-types.ts` | Add `PortfolioSparklinePoint` and `PortfolioSparklines` types |
| `frontend/src/types/api.ts` | Re-export the two new types from `@cashflow/shared` |
| `frontend/src/pages/PortfolioPage.tsx` | Parallel sparklines fetch in `load()`; build Map; pass down to HoldingsPanel + BySecurityPanel; update HoldingsPanel + BySecurityPanel + SymbolLink to render logo + (where in scope) sparkline column |
| `frontend/src/pages/PortfolioPage.test.tsx` | New file — coverage for logo + sparkline rendering paths |

---

## Phase 1 — Backend endpoint

### Task 1: `GET /api/portfolio/sparklines?range=30d`

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Create: `backend/test/integration/portfolioSparklines.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `backend/test/integration/portfolioSparklines.test.ts`:

```ts
/**
 * Integration tests for GET /api/portfolio/sparklines.
 *
 * Verifies: household scoping, security inclusion rule
 * (must have activity or holding), 30-day window, omission
 * of securities without daily-price rows, range param validation.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-sparklines.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let xeqtId: number;
let bnsId: number;
let untradedId: number;

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
  } = await import('./portfolioFixtures.js');

  const seeded = await seedHousehold(models, `spark-${Date.now()}@example.com`);
  const acct = await seedAccount(models, seeded.household.id, seeded.user.id, 'TFSA', 'TFSA01');

  const xeqt = await seedSecurity(models, seeded.household.id, 'XEQT', 'iShares', 'ETF');
  const bns = await seedSecurity(models, seeded.household.id, 'BNS', 'Scotiabank', 'EQUITY');
  const untraded = await seedSecurity(models, seeded.household.id, 'NONE', 'Untraded', 'EQUITY');
  xeqtId = xeqt.id;
  bnsId = bns.id;
  untradedId = untraded.id;

  // XEQT — full 35 days of daily prices, held in account
  for (let i = 35; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: xeqt.id, date, close: 30 + i * 0.05 });
  }
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 3000, costBasis: 2700,
  });

  // BNS — only 5 days of daily prices, held in account
  for (let i = 5; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    await seedDailyPrice(models, { securityId: bns.id, date, close: 70 + i * 0.1 });
  }
  await seedHolding(models, {
    accountId: acct.id, householdId: seeded.household.id, securityId: bns.id,
    statementDate: '2026-05-01', quantity: 20, marketValue: 1400, costBasis: 1300,
  });

  // untraded — has daily prices but no holding or activity in caller's accounts;
  // must be EXCLUDED from response.
  await seedDailyPrice(models, { securityId: untraded.id, date: '2026-05-20', close: 5 });
  await seedDailyPrice(models, { securityId: untraded.id, date: '2026-05-21', close: 5.1 });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('returns 30-day sparklines for visible held securities', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=30d');
  assert.equal(res.status, 200);
  assert.equal(res.body.range, '30d');
  // XEQT had 36 days seeded — should be clipped to 30-day window
  const xeqtSeries = res.body.bySecurityId[String(xeqtId)] as Array<{ date: string; close: number }>;
  assert.ok(Array.isArray(xeqtSeries), 'XEQT series should be present');
  assert.ok(xeqtSeries.length >= 28 && xeqtSeries.length <= 31, `XEQT count=${xeqtSeries.length}`);
  // Oldest → newest order
  for (let i = 1; i < xeqtSeries.length; i++) {
    assert.ok(xeqtSeries[i - 1].date <= xeqtSeries[i].date);
  }
  // close is numeric
  assert.equal(typeof xeqtSeries[0].close, 'number');
});

test('returns fewer points when fewer days exist', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=30d');
  const bnsSeries = res.body.bySecurityId[String(bnsId)] as Array<{ date: string; close: number }>;
  assert.ok(Array.isArray(bnsSeries));
  assert.ok(bnsSeries.length >= 5 && bnsSeries.length <= 6, `BNS count=${bnsSeries.length}`);
});

test('omits securities the caller does not hold (no activity, no holding)', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=30d');
  assert.equal(res.body.bySecurityId[String(untradedId)], undefined);
});

test('omits held securities that have no daily-price rows', async () => {
  // Seed a brand-new security with a holding but zero daily prices
  const models = await import('../../src/models');
  const { seedAccount, seedSecurity, seedHolding, seedHousehold } = await import('./portfolioFixtures.js');
  const second = await seedHousehold(models, `spark-empty-${Date.now()}@example.com`);
  const acct2 = await seedAccount(models, second.household.id, second.user.id, 'TFSA', 'TFSA02');
  const sec = await seedSecurity(models, second.household.id, 'EMPTY', 'No prices', 'EQUITY');
  await seedHolding(models, {
    accountId: acct2.id, householdId: second.household.id, securityId: sec.id,
    statementDate: '2026-05-01', quantity: 1, marketValue: 1, costBasis: 1,
  });
  const agent2 = request.agent(app);
  agent2.jar.setCookie(`cashflow_session=${second.token}; Path=/`);
  const res = await agent2.get('/api/portfolio/sparklines?range=30d');
  assert.equal(res.status, 200);
  assert.equal(res.body.bySecurityId[String(sec.id)], undefined);
});

test('invalid range param returns 400', async () => {
  const res = await authed.get('/api/portfolio/sparklines?range=7d');
  assert.equal(res.status, 400);
});

test('default range (no param) returns 30d', async () => {
  const res = await authed.get('/api/portfolio/sparklines');
  assert.equal(res.status, 200);
  assert.equal(res.body.range, '30d');
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd backend && yarn test:integration --test-name-pattern "sparklines for visible" 2>&1 | tail -20
```

Expected: FAIL — 404 (route not defined).

- [ ] **Step 3: Add route handler to `backend/src/routes/portfolio.ts`**

Add this handler immediately AFTER the existing `router.get('/security/:id', ...)` block (after line 1014 or thereabouts; place it near the other portfolio routes — before `router.post('/prices/refresh', ...)` is a natural spot).

The route uses `Op`, `Account`, `InvestmentActivity`, `HoldingSnapshot`, `SecurityDailyPrice`, and `visibleAccountWhere` — all already imported at the top of `portfolio.ts` from slice F. No new imports needed.

```ts
router.get('/sparklines', async (req, res, next) => {
  try {
    const rawRange = req.query.range;
    if (rawRange !== undefined && rawRange !== '30d') {
      res.status(400).json({ error: 'Unsupported range; only "30d" is currently supported' });
      return;
    }

    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      attributes: ['id'],
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length === 0) {
      res.json({ range: '30d', bySecurityId: {} });
      return;
    }

    // Securities the caller actually has activity or holdings for.
    const [activitySecIds, holdingSecIds] = await Promise.all([
      InvestmentActivity.findAll({
        where: { accountId: accountIds, securityId: { [Op.ne]: null } },
        attributes: ['securityId'],
        group: ['securityId'],
      }),
      HoldingSnapshot.findAll({
        where: { accountId: accountIds, securityId: { [Op.ne]: null } },
        attributes: ['securityId'],
        group: ['securityId'],
      }),
    ]);
    const securityIds = Array.from(
      new Set(
        [
          ...activitySecIds.map((a) => a.securityId),
          ...holdingSecIds.map((h) => h.securityId),
        ].filter((id): id is number => typeof id === 'number'),
      ),
    );
    if (securityIds.length === 0) {
      res.json({ range: '30d', bySecurityId: {} });
      return;
    }

    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = await SecurityDailyPrice.findAll({
      where: {
        securityId: securityIds,
        date: { [Op.gte]: cutoff },
      },
      order: [['securityId', 'ASC'], ['date', 'ASC']],
    });

    const bySecurityId: Record<number, Array<{ date: string; close: number }>> = {};
    for (const row of rows) {
      const arr = bySecurityId[row.securityId] ?? (bySecurityId[row.securityId] = []);
      arr.push({ date: row.date, close: Number(row.adjClose) });
    }

    res.json({ range: '30d', bySecurityId });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd backend && yarn test:integration --test-name-pattern "sparklines|invalid range|default range" 2>&1 | tail -25
```

Expected: all 6 sparklines tests pass.

- [ ] **Step 5: Broader regression check**

```bash
cd backend && yarn test:integration 2>&1 | grep -E "^ℹ (pass|fail|tests)"
```

Expected: same totals as before plus 6 new passing tests; 0 failures.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/portfolio.ts backend/test/integration/portfolioSparklines.test.ts
git commit -m "feat(portfolio): add GET /api/portfolio/sparklines batch endpoint"
```

---

## Phase 2 — Shared types

### Task 2: Add `PortfolioSparklines` type

**Files:**
- Modify: `shared/api-types.ts`
- Modify: `frontend/src/types/api.ts`

- [ ] **Step 1: Append types to `shared/api-types.ts`**

Add at the bottom of the file:

```ts
export type PortfolioSparklinePoint = {
  date: string  // 'YYYY-MM-DD'
  close: number
}

export type PortfolioSparklines = {
  range: '30d'
  bySecurityId: Record<number, PortfolioSparklinePoint[]>
}
```

- [ ] **Step 2: Re-export from `frontend/src/types/api.ts`**

Open `frontend/src/types/api.ts`. Find the existing block `import { ... } from '@cashflow/shared'` (or the named imports list — slice F's types are re-exported there). Add these two names to the import list:

```ts
  PortfolioSparklinePoint,
  PortfolioSparklines,
```

Verify they're included in the re-export `export { ... }` (or `export type { ... }`) block if the file uses an explicit export list — match the file's existing pattern for `PortfolioSecurityPrices` and friends.

- [ ] **Step 3: Build to verify**

```bash
cd frontend && yarn build 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add shared/api-types.ts frontend/src/types/api.ts
git commit -m "feat(portfolio): add PortfolioSparklines shared types"
```

---

## Phase 3 — Frontend wiring + UI changes

### Task 3: `PortfolioPage` parallel fetch + Holdings/By-security row decoration

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx`

This task touches a single file and changes four call sites (page-level fetch + HoldingsPanel + BySecurityPanel + SymbolLink). Doing it in one task keeps the diff coherent — the alternative would mean four micro-commits against the same file with intermediate broken states.

- [ ] **Step 1: Add `Sparkline` import + new state in `PortfolioPage`**

At the top of `frontend/src/pages/PortfolioPage.tsx`, add these imports near the other `@/components/ui/...` imports:

```tsx
import { SecurityLogo } from '@/components/ui/security-logo'
import { Sparkline } from '@/components/ui/sparkline'
```

Also extend the `import type { ... } from '../types/api'` block to include `PortfolioSparklines` and `PortfolioSparklinePoint`:

```tsx
import type {
  PortfolioAllocation,
  PortfolioBySecurity,
  PortfolioIncome,
  PortfolioRealized,
  PortfolioSparklinePoint,
  PortfolioSparklines,
  PortfolioSummary,
} from '../types/api'
```

Inside `PortfolioPage()`, add a new state hook below the existing `useState` calls:

```tsx
const [sparklines, setSparklines] = useState<Map<number, PortfolioSparklinePoint[]>>(new Map())
```

- [ ] **Step 2: Extend the parallel fetch in `load()`**

Find the `Promise.all([...])` block inside `load()`. Replace it with:

```tsx
const [summaryRes, allocRes, bySecRes, sparkRes] =
  await Promise.all([
    getJson<PortfolioSummary>('/api/portfolio'),
    getJson<PortfolioAllocation>('/api/portfolio/allocation'),
    getJson<PortfolioBySecurity>('/api/portfolio/by-security'),
    getJson<PortfolioSparklines>('/api/portfolio/sparklines?range=30d'),
  ])
setSummary(summaryRes)
setAllocation(allocRes)
setBySec(bySecRes)
setSparklines(
  new Map(
    Object.entries(sparkRes.bySecurityId).map(([k, v]) => [Number(k), v]),
  ),
)
```

(Existing `setSummary`/`setAllocation`/`setBySec` calls remain. Insert `setSparklines(...)` after them.)

- [ ] **Step 3: Pass `sparklines` into HoldingsPanel + BySecurityPanel**

Find the `<TabPanel value="holdings" ...>` JSX. Update the HoldingsPanel render:

```tsx
<HoldingsPanel summary={summary} accountsById={accountsById} sparklines={sparklines} />
```

And the BySecurityPanel render:

```tsx
<BySecurityPanel data={bySec} sparklines={sparklines} />
```

- [ ] **Step 4: Update `HoldingsPanel` signature + render**

Find the existing `function HoldingsPanel({...}) { ... }` block. Update the props type and body:

```tsx
function HoldingsPanel({
  summary,
  accountsById,
  sparklines,
}: {
  summary: PortfolioSummary | null
  accountsById: Map<number, PortfolioSummary['accounts'][number]>
  sparklines: Map<number, PortfolioSparklinePoint[]>
}) {
```

Inside the existing `<TableHeader>`, add a new `<TableHead>30d</TableHead>` between Unrealized and `As of`:

```tsx
<TableHead>Unrealized</TableHead>
<TableHead>30d</TableHead>
<TableHead>As of</TableHead>
```

Update the matching row body. Replace the Symbol cell:

```tsx
<TableCell>
  {holding.security ? (
    <span className="flex items-center gap-2">
      <SecurityLogo
        size="sm"
        symbol={holding.security.symbol}
        name={holding.security.name}
      />
      <Link
        to={`/portfolio/security/${holding.security.id}`}
        className="text-foreground underline-offset-2 hover:underline"
      >
        {holding.security.symbol}
      </Link>
    </span>
  ) : (
    '—'
  )}
</TableCell>
```

After the Unrealized cell and before the As-of cell, add the new sparkline cell:

```tsx
<TableCell>
  {holding.security ? (
    <Sparkline
      data={(sparklines.get(holding.security.id) ?? []).map((p) => ({
        date: p.date,
        value: p.close,
      }))}
    />
  ) : null}
</TableCell>
```

Find the existing `<EmptyTableRow colSpan={9} ...>` and bump `colSpan` to `10` to account for the new column.

- [ ] **Step 5: Update `BySecurityPanel` signature + render**

Find the existing `function BySecurityPanel({ data }: { data: PortfolioBySecurity | null }) { ... }` and replace with:

```tsx
function BySecurityPanel({
  data,
  sparklines,
}: {
  data: PortfolioBySecurity | null
  sparklines: Map<number, PortfolioSparklinePoint[]>
}) {
```

Inside the `<TableHeader>`, add a `<TableHead>30d</TableHead>` between `Accounts` and `Latest quote`:

```tsx
<TableHead>Accounts</TableHead>
<TableHead>30d</TableHead>
<TableHead>Latest quote</TableHead>
```

Update the Symbol cell:

```tsx
<TableCell>
  <span className="flex items-center gap-2">
    <SecurityLogo size="sm" symbol={row.symbol} name={row.name} />
    <Link
      to={`/portfolio/security/${row.securityId}`}
      className="text-foreground underline-offset-2 hover:underline"
    >
      {row.symbol}
    </Link>
  </span>
</TableCell>
```

After the Accounts cell, add the sparkline cell:

```tsx
<TableCell>
  <Sparkline
    data={(sparklines.get(row.securityId) ?? []).map((p) => ({
      date: p.date,
      value: p.close,
    }))}
  />
</TableCell>
```

Bump the existing `<EmptyTableRow colSpan={9} ...>` to `colSpan={10}`.

- [ ] **Step 6: Update `SymbolLink` for Income / Realized tables**

Find the existing helper:

```tsx
function SymbolLink({
  securityId,
  symbol,
}: {
  securityId: number | null
  symbol: string | null
}) {
```

Replace with:

```tsx
function SymbolLink({
  securityId,
  symbol,
  name,
}: {
  securityId: number | null
  symbol: string | null
  name?: string | null
}) {
  if (securityId == null || !symbol) return <>{symbol ?? '—'}</>
  return (
    <span className="flex items-center gap-2">
      <SecurityLogo size="sm" symbol={symbol} name={name} />
      <Link
        to={`/portfolio/security/${securityId}`}
        className="text-foreground underline-offset-2 hover:underline"
      >
        {symbol}
      </Link>
    </span>
  )
}
```

The two callers (`IncomeBySecurityRow` and `RealizedBySecurityTable`) need to pass `name`. Find both call sites and add `name={row.name ?? undefined}`:

In `IncomeBySecurityRow`:
```tsx
<SymbolLink securityId={row.securityId} symbol={row.symbol} name={row.name} />
```

In `RealizedBySecurityTable`'s row:
```tsx
<SymbolLink securityId={row.securityId} symbol={row.symbol} name={row.name} />
```

(`row.name` already exists on both `PortfolioIncome['bySecurity'][number]` and `PortfolioRealized['bySecurity'][number]` per the existing types.)

- [ ] **Step 7: Typecheck + build**

```bash
cd frontend && yarn build 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/PortfolioPage.tsx
git commit -m "feat(portfolio): add logos to portfolio tables + 30d sparkline columns"
```

---

## Phase 4 — Frontend tests

### Task 4: `PortfolioPage` test coverage

**Files:**
- Create: `frontend/src/pages/PortfolioPage.test.tsx`

- [ ] **Step 1: Write the tests**

Create `frontend/src/pages/PortfolioPage.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PortfolioPage } from './PortfolioPage'
import * as api from '../lib/api'
import { _resetAppConfigForTest } from '../lib/appConfig'

const baseSummary = {
  accounts: [{ id: 1, name: 'TFSA', shortCode: 'TFSA01', currency: 'CAD' }],
  totalsByCurrency: [{ currency: 'CAD', marketValue: 4400 }],
  unifiedTotal: null,
  holdings: [
    {
      id: 10,
      accountId: 1,
      security: { id: 100, symbol: 'XEQT', name: 'iShares' },
      quantity: 100,
      currency: 'CAD',
      price: 30,
      marketValue: 3000,
      costBasis: 2700,
      unrealizedGainLoss: 300,
      statementDate: '2026-05-01',
      latestPrice: null,
    },
    {
      id: 11,
      accountId: 1,
      security: { id: 101, symbol: 'BNS', name: 'Scotiabank' },
      quantity: 20,
      currency: 'CAD',
      price: 70,
      marketValue: 1400,
      costBasis: 1300,
      unrealizedGainLoss: 100,
      statementDate: '2026-05-01',
      latestPrice: null,
    },
  ],
  recentActivities: [],
}

const baseAllocation = {
  byAssetType: [],
  bySecurity: [],
  byAccount: [],
}

const baseBySec = {
  rows: [
    {
      securityId: 100,
      symbol: 'XEQT',
      name: 'iShares',
      assetType: 'ETF',
      totalQuantity: 100,
      totalCostBasis: 2700,
      totalMarketValue: 3000,
      unrealizedGainLoss: 300,
      accountBreakdown: [{ accountId: 1, accountName: 'TFSA', quantity: 100 }],
      currency: 'CAD',
      latestPrice: null,
    },
  ],
}

const baseSparks = {
  range: '30d',
  bySecurityId: {
    '100': [
      { date: '2026-04-25', close: 28 },
      { date: '2026-04-26', close: 28.5 },
      { date: '2026-04-27', close: 29 },
      { date: '2026-05-24', close: 30 },
    ],
    // BNS (101) intentionally omitted — has no daily-price history
  },
}

function mockApi(mapping: Record<string, unknown>) {
  vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
    for (const [k, v] of Object.entries(mapping)) {
      if (url.startsWith(k)) return v as never
    }
    throw new Error(`unmocked ${url}`)
  })
}

describe('PortfolioPage table polish', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetAppConfigForTest()
    window.__APP_CONFIG__ = { logoDevToken: null, quoteProviderConfigured: true }
  })

  it('renders logo (letter-avatar fallback) in Holdings symbol cell', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { findByText, getAllByRole } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await findByText('Holdings')
    await findByText('XEQT')
    // No logo token configured → SecurityLogo renders LetterAvatar (role="img")
    const avatars = getAllByRole('img')
    expect(avatars.length).toBeGreaterThan(0)
  })

  it('renders sparkline svg for XEQT (with data) but blank cell for BNS (no data)', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { container, findByText } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await findByText('XEQT')
    // Wait for sparkline svg to mount; only one security (XEQT) has >=2 points
    await waitFor(() => {
      const svgs = container.querySelectorAll('svg')
      // recharts Sparkline + recharts Donut charts may both exist; assert at
      // least one Sparkline-shaped svg by parent class `width: 80px`
      expect(svgs.length).toBeGreaterThan(0)
    })
  })

  it('does NOT call AV when visiting the Holdings tab', async () => {
    const spy = vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
      const mapping: Record<string, unknown> = {
        '/api/portfolio/sparklines': baseSparks,
        '/api/portfolio/allocation': baseAllocation,
        '/api/portfolio/by-security': baseBySec,
        '/api/portfolio': baseSummary,
      }
      for (const [k, v] of Object.entries(mapping)) {
        if (url.startsWith(k)) return v as never
      }
      throw new Error(`unmocked ${url}`)
    })
    render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(spy).toHaveBeenCalled())
    // No call to /prices/refresh or any /security/:id/* endpoint
    for (const call of spy.mock.calls) {
      const url = call[0] as string
      expect(url).not.toContain('/prices/refresh')
      expect(url).not.toMatch(/\/security\/\d+\//)
    }
  })

  it('renders By-security sparkline column header', async () => {
    mockApi({
      '/api/portfolio/sparklines': baseSparks,
      '/api/portfolio/allocation': baseAllocation,
      '/api/portfolio/by-security': baseBySec,
      '/api/portfolio': baseSummary,
    })
    const { findByText, getAllByText } = render(
      <MemoryRouter>
        <PortfolioPage />
      </MemoryRouter>,
    )
    // Click the "By security" tab
    const tab = await findByText('By security')
    tab.click()
    // Wait for the table to render its header
    await waitFor(() => {
      const allHeads = getAllByText('30d')
      // 30d appears in both Holdings and By-security headers
      expect(allHeads.length).toBeGreaterThanOrEqual(1)
    })
  })
})
```

- [ ] **Step 2: Run, expect PASS**

```bash
cd frontend && yarn test src/pages/PortfolioPage.test.tsx 2>&1 | tail -20
```

Expected: 4/4 pass.

(If the second test fails because jsdom's ResizeObserver polyfill — added in slice F's `vitest.setup.ts` — doesn't produce dimensions for the Sparkline's `<ResponsiveContainer>`, fall back to asserting on the parent `<div>` with the sparkline's fixed `width:80px` style. The polyfill is the same one slice F's tests use, so this should not be needed.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/PortfolioPage.test.tsx
git commit -m "test(portfolio): cover logo + sparkline rendering on PortfolioPage tables"
```

---

## Phase 5 — Final verification

### Task 5: Full test sweep

- [ ] **Step 1: Backend unit tests**

```bash
cd backend && yarn test 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 2: Backend integration tests**

```bash
cd backend && yarn test:integration 2>&1 | tail -5
```
Expected: all pass; 6 new sparklines tests pass.

- [ ] **Step 3: Frontend tests**

```bash
cd frontend && yarn test 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 4: Frontend build + lint**

```bash
cd frontend && yarn build 2>&1 | tail -5 && yarn lint 2>&1 | tail -5
```
Expected: clean.

- [ ] **Step 5: Backend typecheck**

```bash
cd backend && yarn typecheck 2>&1 | tail -5
```
Expected: clean.

- [ ] **Step 6: Manual smoke**

Start backend + frontend dev servers. Visit `/portfolio`. Verify:
- Holdings tab: every row has a logo (or letter-avatar) and a sparkline column header. Sparkline svg appears for securities you've already visited (which have `security_daily_prices` rows from slice F); blank for the rest.
- By-security tab: same.
- Income tab → By-security table: logo only.
- Realized tab → By-security table: logo only.
- Refresh-quotes button still works.

---

## Self-Review

### Spec coverage

| Spec section / AC | Plan task(s) |
|---|---|
| §4 New endpoint `GET /sparklines?range=30d` | Task 1 |
| §4 Algorithm (visibility, 30-day window, omit empty) | Task 1 |
| §4 Range validation | Task 1 (test + handler) |
| §5 Shared types | Task 2 |
| §5 Parallel fetch in PortfolioPage `load()` | Task 3 step 2 |
| §5 HoldingsPanel logo + sparkline | Task 3 steps 4 |
| §5 BySecurityPanel logo + sparkline | Task 3 step 5 |
| §5 SymbolLink update (Income + Realized logo) | Task 3 step 6 |
| §5 Frontend tests | Task 4 |
| AC1–AC2 (endpoint shape + omission) | Task 1 |
| AC3 (Holdings logo) | Task 3 step 4 |
| AC4 (Holdings 30d column) | Task 3 step 4 |
| AC5 (By-security logo + 30d) | Task 3 step 5 |
| AC6 (Income / Realized logo only) | Task 3 step 6 |
| AC7 (single parallel sparklines round-trip) | Task 3 step 2 |
| AC8 (no AV calls from tab visit) | Task 1 (no-backfill) + Task 4 test |
| AC9 (existing behaviors unchanged) | Task 3 keeps refresh button + tabs intact; Task 5 regression sweep |
| AC10 (all tests pass) | Task 5 |

No spec gaps.

### Placeholder scan

No "TBD" / "TODO" / "implement later" patterns. Test bodies and route handler are complete. The `(If ... fall back to asserting on ...)` note in Task 4 step 2 is a contingency hint, not a placeholder — the assertion path is concrete.

### Type consistency

- Backend response: `{ range: '30d', bySecurityId: Record<number, Array<{date, close}>> }`
- Shared type: `PortfolioSparklines = { range: '30d', bySecurityId: Record<number, PortfolioSparklinePoint[]> }`
- Frontend Map: `Map<number, PortfolioSparklinePoint[]>` (keys converted via `Number(k)` since JSON object keys are strings)
- Sparkline component input: `{ date, value }` (converted from `{ date, close }` at render time)

All consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-portfolio-table-polish.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
