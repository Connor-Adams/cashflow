# Net Worth Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a CAD-unified net worth view (current + time series) at `/net-worth` plus a compact tile on the existing dashboard, deriving balances from the transaction stream + portfolio market value.

**Architecture:** Pure aggregator under `backend/src/networth/` composes contributors (cash, liability, portfolio) into per-currency totals; FX-unifies to CAD via the existing `ensureFxRate` path. Hard-fails on missing rate/price with `partial=true` rather than silent coercion. Two new columns on `Account` (`opening_balance`, `opening_balance_date`); no new tables for MVP.

**Tech Stack:** Backend: Node 20 + TypeScript + Express + Sequelize (Postgres prod / SQLite dev). Frontend: React + Vite + react-router-dom v6, existing `frontend/src/lib/api.ts` helpers, chart lib already used on PortfolioPage. Tests: Vitest (both sides), in-memory SQLite for backend route/integration tests.

**Spec:** [docs/superpowers/specs/2026-05-24-net-worth-dashboard-design.md](../specs/2026-05-24-net-worth-dashboard-design.md)

---

## File Structure

**Backend — new files:**
- `backend/src/migrations/20260524000001-account-opening-balance.js` — adds `opening_balance` + `opening_balance_date` to `accounts`
- `backend/src/networth/accountKind.ts` — `accountType` → `'asset' | 'liability'` switch
- `backend/src/networth/balanceAtDate.ts` — sums openingBalance + txns ≤ asOf per currency
- `backend/src/networth/portfolioMarketValueAt.ts` — quantity × price at asOf per account-security
- `backend/src/networth/unifyToCad.ts` — FX-unifies per-currency totals via `ensureFxRate`
- `backend/src/networth/aggregate.ts` — `buildNetWorthAt` + `buildSeries`
- `backend/src/routes/netWorth.ts` — `GET /current`, `GET /series`, `PATCH /accounts/:id/opening-balance`

**Backend — modified files:**
- `backend/src/models/Account.ts` — declare + init `openingBalance` + `openingBalanceDate`
- `backend/src/app.ts:80` — register `netWorthRouter` next to `portfolioRouter`

**Backend — tests:**
- `backend/test/accountKind.test.ts`
- `backend/test/balanceAtDate.test.ts`
- `backend/test/portfolioMarketValueAt.test.ts`
- `backend/test/unifyToCad.test.ts`
- `backend/test/networthAggregate.test.ts`
- `backend/test/netWorthRoutes.test.ts`

**Frontend — new files:**
- `frontend/src/hooks/useNetWorth.ts` — `useNetWorthCurrent`, `useNetWorthSeries`
- `frontend/src/pages/NetWorthPage.tsx`
- `frontend/src/pages/NetWorthPage.test.tsx`
- `frontend/src/components/dashboard/NetWorthTile.tsx`
- `frontend/src/components/dashboard/NetWorthTile.test.tsx`

**Frontend — modified files:**
- `frontend/src/types/api.ts` — add `NetWorthCurrent`, `NetWorthSeries`, supporting types
- `frontend/src/App.tsx:50` — add `<Route path="net-worth" element={<NetWorthPage />} />` (after portfolio route)
- `frontend/src/components/Sidebar.tsx:38-51` — insert `{ to: '/net-worth', label: 'Net worth', icon: Coins }` above Reports
- `frontend/src/pages/DashboardPage.tsx` — mount `<NetWorthTile />` near existing summary tiles (exact insertion point to be located in Task 12)

---

## Conventions used in this plan

- **Backend tests use `node:test` (not vitest).** Imports: `import { test, before, after } from 'node:test'; import assert from 'node:assert/strict';`. There is no `describe`/`it`/`expect`/`vi.mock`. Single test per call: `test('name', () => { assert.equal(...) })`. Per-file run: `cd backend && yarn run -s tsx --test test/foo.test.ts`. Whole suite: `yarn workspace cashflow-backend test`.
- **Integration / route tests** (anything that boots the Express app) follow the pattern in `backend/test/integration/portfolioUnifiedTotal.test.ts` and `backend/test/tax/routes.test.ts`: a per-test sqlite file under `backend/data/test-*.sqlite`, `execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], ...)` in `before()`, then `await import('../../src/app.js')`. Auth cookie via `request.agent(app).jar.setCookie(...)`. Reusable seeders live in `backend/test/integration/portfolioFixtures.ts` (`seedHousehold`, `seedAccount`, `seedSecurity`, `seedHolding`).
- **No module mocking** for backend. Pure helpers that depend on `ensureFxRate` take an `fxLookup` parameter (DI); tests pass a stub. Tests that go through `ensureFxRate` end-to-end pre-seed `FxRate` rows in the test sqlite — `ensureFxRate` returns the cached row without hitting the network.
- Frontend tests use **vitest** (already configured in `frontend/vitest.config.ts`). Per-file run: `yarn workspace frontend test path/to/file --run`. Whole suite: `yarn workspace frontend test`.
- All money math uses native `number` for now (matches existing portfolio/summary code). Switch to `decimal.js` only if a test reveals rounding pain — out of scope here.
- Commit messages follow Conventional Commits — `feat(networth):`, `test(networth):`, etc. — matching recent repo history (`feat(tax):`, etc.).
- No `Co-Authored-By` trailer on any commit (per user CLAUDE.md).

---

### Task 1: Migration + Account model columns

**Files:**
- Create: `backend/src/migrations/20260524000001-account-opening-balance.js`
- Modify: `backend/src/models/Account.ts` (add field declarations and init entries)

- [ ] **Step 1: Write the migration**

Create `backend/src/migrations/20260524000001-account-opening-balance.js`:

```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('accounts', 'opening_balance', {
      type: Sequelize.DECIMAL(18, 4),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('accounts', 'opening_balance_date', {
      type: Sequelize.DATEONLY,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('accounts', 'opening_balance_date');
    await queryInterface.removeColumn('accounts', 'opening_balance');
  },
};
```

- [ ] **Step 2: Update Account model**

In `backend/src/models/Account.ts`, add two `declare` lines inside the class body (next to `declare taxStatus`):

```ts
declare openingBalance: CreationOptional<string>;
declare openingBalanceDate: CreationOptional<string | null>;
```

(Sequelize DECIMAL serializes as string in this codebase — see `Transaction.amount: string`.)

In the `Account.init({...})` block, after the `taxStatus` entry and before the closing `}`, add:

```ts
openingBalance: {
  type: DataTypes.DECIMAL(18, 4),
  field: 'opening_balance',
  allowNull: false,
  defaultValue: 0,
},
openingBalanceDate: {
  type: DataTypes.DATEONLY,
  field: 'opening_balance_date',
  allowNull: true,
  defaultValue: null,
},
```

- [ ] **Step 3: Run migration locally to verify it applies**

Run: `yarn workspace cashflow-backend run db:migrate`
Expected: prints `== 20260524000001-account-opening-balance: migrating =======` and `== ... migrated`.

If `db:migrate` is not the exact script name, run `yarn workspace cashflow-backend run` to list available scripts and pick the migration runner. Document the exact script discovered.

- [ ] **Step 4: Run existing Account tests to confirm no regression**

Run: `yarn workspace cashflow-backend test backend/test/applyRules.test.ts --run`
Expected: PASS (this test loads Account via Sequelize associations and would surface init errors).

- [ ] **Step 5: Commit**

```bash
git add backend/src/migrations/20260524000001-account-opening-balance.js backend/src/models/Account.ts
git commit -m "feat(networth): add opening_balance columns to accounts"
```

---

### Task 2: `accountKind` helper

**Files:**
- Create: `backend/src/networth/accountKind.ts`
- Create: `backend/test/accountKind.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/accountKind.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { accountKind } from '../src/networth/accountKind';

describe('accountKind', () => {
  it.each([
    ['checking', 'asset'],
    ['savings', 'asset'],
    ['investment', 'asset'],
  ])('classifies %s as %s', (input, expected) => {
    expect(accountKind(input)).toBe(expected);
  });

  it.each([
    ['credit_card', 'liability'],
    ['loan', 'liability'],
  ])('classifies %s as %s', (input, expected) => {
    expect(accountKind(input)).toBe(expected);
  });

  it('defaults unknown accountType to asset and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(accountKind('mystery')).toBe('asset');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[networth] unknown accountType: mystery — defaulting to asset')
    );
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend test backend/test/accountKind.test.ts --run`
Expected: FAIL with module-not-found for `../src/networth/accountKind`.

- [ ] **Step 3: Implement `accountKind`**

Create `backend/src/networth/accountKind.ts`:

```ts
export type AccountKind = 'asset' | 'liability';

const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'mortgage']);
const KNOWN_ASSET_TYPES = new Set(['checking', 'savings', 'investment', 'cash']);

export function accountKind(accountType: string): AccountKind {
  if (LIABILITY_TYPES.has(accountType)) return 'liability';
  if (!KNOWN_ASSET_TYPES.has(accountType)) {
    console.warn(`[networth] unknown accountType: ${accountType} — defaulting to asset`);
  }
  return 'asset';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend test backend/test/accountKind.test.ts --run`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/networth/accountKind.ts backend/test/accountKind.test.ts
git commit -m "feat(networth): add accountKind classifier"
```

---

### Task 3: `balanceAtDate` helper

**Files:**
- Create: `backend/src/networth/balanceAtDate.ts`
- Create: `backend/test/balanceAtDate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/balanceAtDate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Account, Transaction, sequelize } from '../src/models';
import { balanceAtDate } from '../src/networth/balanceAtDate';

async function seedAccount(opts: {
  defaultCurrency?: string;
  openingBalance?: number;
  openingBalanceDate?: string | null;
}) {
  return Account.create({
    name: 'Test',
    owner: 'me',
    accountType: 'checking',
    defaultCurrency: opts.defaultCurrency ?? 'CAD',
    openingBalance: String(opts.openingBalance ?? 0),
    openingBalanceDate: opts.openingBalanceDate ?? null,
  } as Parameters<typeof Account.create>[0]);
}

async function seedTxn(accountId: number, date: string, amount: number, currency = 'CAD') {
  await Transaction.create({
    accountId,
    date,
    amount: String(amount),
    currency,
    description: 't',
    rawDescription: 't',
    importBatch: 'test',
    sourceRowFingerprint: `${accountId}-${date}-${amount}-${Math.random()}`,
  } as Parameters<typeof Transaction.create>[0]);
}

describe('balanceAtDate', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  it('sums openingBalance + txns ≤ asOf in defaultCurrency', async () => {
    const acc = await seedAccount({ openingBalance: 1000 });
    await seedTxn(acc.id, '2026-01-01', -100);
    await seedTxn(acc.id, '2026-02-01', 200);
    await seedTxn(acc.id, '2026-03-01', -50); // after asOf

    const result = await balanceAtDate(acc, '2026-02-15');
    expect(result).toEqual([{ currency: 'CAD', amount: 1100 }]);
  });

  it('excludes txns ≤ openingBalanceDate', async () => {
    const acc = await seedAccount({ openingBalance: 500, openingBalanceDate: '2026-01-31' });
    await seedTxn(acc.id, '2026-01-15', -999); // excluded by openingBalanceDate
    await seedTxn(acc.id, '2026-02-15', 100);

    const result = await balanceAtDate(acc, '2026-03-01');
    expect(result).toEqual([{ currency: 'CAD', amount: 600 }]);
  });

  it('groups multi-currency txns separately, opening goes to defaultCurrency', async () => {
    const acc = await seedAccount({ defaultCurrency: 'CAD', openingBalance: 1000 });
    await seedTxn(acc.id, '2026-01-01', 200, 'USD');
    await seedTxn(acc.id, '2026-01-02', -50, 'CAD');

    const result = await balanceAtDate(acc, '2026-02-01');
    expect(result.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: 'CAD', amount: 950 },
      { currency: 'USD', amount: 200 },
    ]);
  });

  it('returns single zero-amount row when no txns and no opening balance', async () => {
    const acc = await seedAccount({});
    const result = await balanceAtDate(acc, '2026-02-01');
    expect(result).toEqual([{ currency: 'CAD', amount: 0 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend test backend/test/balanceAtDate.test.ts --run`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `balanceAtDate`**

Create `backend/src/networth/balanceAtDate.ts`:

```ts
import { Op, type WhereOptions } from 'sequelize';
import { Account, Transaction } from '../models';

export type CurrencyAmount = { currency: string; amount: number };

export async function balanceAtDate(
  account: Account,
  asOf: string
): Promise<CurrencyAmount[]> {
  const where: WhereOptions = { accountId: account.id };
  if (account.openingBalanceDate) {
    where.date = { [Op.gt]: account.openingBalanceDate, [Op.lte]: asOf };
  } else {
    where.date = { [Op.lte]: asOf };
  }

  const txns = await Transaction.findAll({
    where,
    attributes: ['currency', 'amount'],
  });

  const byCurrency = new Map<string, number>();
  for (const t of txns) {
    byCurrency.set(t.currency, (byCurrency.get(t.currency) ?? 0) + Number(t.amount));
  }

  const defCcy = account.defaultCurrency ?? 'CAD';
  const opening = Number(account.openingBalance) || 0;
  byCurrency.set(defCcy, (byCurrency.get(defCcy) ?? 0) + opening);

  return Array.from(byCurrency, ([currency, amount]) => ({ currency, amount }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend test backend/test/balanceAtDate.test.ts --run`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/networth/balanceAtDate.ts backend/test/balanceAtDate.test.ts
git commit -m "feat(networth): add balanceAtDate helper deriving balances from txn stream"
```

---

### Task 4: `portfolioMarketValueAt` helper

**Files:**
- Create: `backend/src/networth/portfolioMarketValueAt.ts`
- Create: `backend/test/portfolioMarketValueAt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/portfolioMarketValueAt.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Account, HoldingSnapshot, Security, SecurityPrice, sequelize } from '../src/models';
import { portfolioMarketValueAt } from '../src/networth/portfolioMarketValueAt';

async function seedSecurity(symbol: string, currency = 'CAD') {
  return Security.create({
    symbol,
    name: symbol,
    currency,
  } as Parameters<typeof Security.create>[0]);
}

async function seedAccount(name: string) {
  return Account.create({
    name,
    owner: 'me',
    accountType: 'investment',
    defaultCurrency: 'CAD',
  } as Parameters<typeof Account.create>[0]);
}

async function seedHolding(accountId: number, securityId: number, date: string, qty: number) {
  await HoldingSnapshot.create({
    accountId,
    securityId,
    statementDate: date,
    quantity: String(qty),
    currency: 'CAD',
    sourceRowFingerprint: `${accountId}-${securityId}-${date}-${qty}`,
    importBatch: 'test',
  } as Parameters<typeof HoldingSnapshot.create>[0]);
}

async function seedPrice(securityId: number, pricedAt: string, price: number) {
  await SecurityPrice.create({
    securityId,
    provider: 'test',
    symbol: 'X',
    pricedAt: new Date(pricedAt),
    price: String(price),
    currency: 'CAD',
    fetchedAt: new Date(pricedAt),
  } as Parameters<typeof SecurityPrice.create>[0]);
}

describe('portfolioMarketValueAt', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  it('uses latest holding ≤ asOf × latest price ≤ asOf', async () => {
    const acc = await seedAccount('RRSP');
    const sec = await seedSecurity('VFV');
    await seedHolding(acc.id, sec.id, '2026-01-31', 10);
    await seedHolding(acc.id, sec.id, '2026-02-28', 12); // after asOf
    await seedPrice(sec.id, '2026-01-30T16:00:00Z', 100);
    await seedPrice(sec.id, '2026-02-15T16:00:00Z', 110); // after asOf

    const result = await portfolioMarketValueAt('2026-02-10', [acc.id]);
    expect(result.rows).toEqual([
      expect.objectContaining({ accountId: acc.id, securityId: sec.id, marketValue: 10 * 100, currency: 'CAD' }),
    ]);
    expect(result.gaps).toEqual([]);
  });

  it('emits price_unavailable gap when no price ≤ asOf', async () => {
    const acc = await seedAccount('RRSP');
    const sec = await seedSecurity('NEW');
    await seedHolding(acc.id, sec.id, '2026-02-01', 5);
    await seedPrice(sec.id, '2026-03-01T16:00:00Z', 50); // after asOf

    const result = await portfolioMarketValueAt('2026-02-15', [acc.id]);
    expect(result.rows).toEqual([]);
    expect(result.gaps).toEqual([
      { date: '2026-02-15', currency: 'CAD', reason: 'price_unavailable', securityId: sec.id },
    ]);
  });

  it('treats missing holding ≤ asOf as zero position (no gap)', async () => {
    const acc = await seedAccount('RRSP');
    const sec = await seedSecurity('FUTURE');
    await seedHolding(acc.id, sec.id, '2026-04-01', 5); // after asOf
    await seedPrice(sec.id, '2026-02-01T16:00:00Z', 50);

    const result = await portfolioMarketValueAt('2026-03-01', [acc.id]);
    expect(result.rows).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('only includes holdings for given accountIds', async () => {
    const a1 = await seedAccount('A1');
    const a2 = await seedAccount('A2');
    const sec = await seedSecurity('VFV');
    await seedHolding(a1.id, sec.id, '2026-01-01', 10);
    await seedHolding(a2.id, sec.id, '2026-01-01', 99);
    await seedPrice(sec.id, '2026-01-01T16:00:00Z', 100);

    const result = await portfolioMarketValueAt('2026-02-01', [a1.id]);
    expect(result.rows).toEqual([
      expect.objectContaining({ accountId: a1.id, marketValue: 1000 }),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend test backend/test/portfolioMarketValueAt.test.ts --run`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `portfolioMarketValueAt`**

Create `backend/src/networth/portfolioMarketValueAt.ts`:

```ts
import { Op } from 'sequelize';
import { HoldingSnapshot, SecurityPrice } from '../models';

export type PortfolioRow = {
  accountId: number;
  securityId: number;
  marketValue: number;
  currency: string;
};

export type PortfolioGap = {
  date: string;
  currency: string;
  reason: 'price_unavailable';
  securityId: number;
};

export type PortfolioMarketValueResult = {
  rows: PortfolioRow[];
  gaps: PortfolioGap[];
};

export async function portfolioMarketValueAt(
  asOf: string,
  accountIds: number[]
): Promise<PortfolioMarketValueResult> {
  if (accountIds.length === 0) return { rows: [], gaps: [] };

  // Get all holdings on/before asOf for these accounts
  const allHoldings = await HoldingSnapshot.findAll({
    where: {
      accountId: accountIds,
      statementDate: { [Op.lte]: asOf },
    },
    order: [['statementDate', 'DESC']],
  });

  // Reduce to latest per (accountId, securityId)
  const latest = new Map<string, HoldingSnapshot>();
  for (const h of allHoldings) {
    const key = `${h.accountId}:${h.securityId}`;
    if (!latest.has(key)) latest.set(key, h);
  }

  if (latest.size === 0) return { rows: [], gaps: [] };

  // Get latest price ≤ asOf per security
  const securityIds = Array.from(new Set(Array.from(latest.values(), (h) => h.securityId)));
  const asOfEndOfDay = `${asOf}T23:59:59.999Z`;
  const allPrices = await SecurityPrice.findAll({
    where: {
      securityId: securityIds,
      pricedAt: { [Op.lte]: asOfEndOfDay },
    },
    order: [['pricedAt', 'DESC']],
  });
  const priceBySecurity = new Map<number, SecurityPrice>();
  for (const p of allPrices) {
    if (!priceBySecurity.has(p.securityId)) priceBySecurity.set(p.securityId, p);
  }

  const rows: PortfolioRow[] = [];
  const gaps: PortfolioGap[] = [];

  for (const h of latest.values()) {
    const price = priceBySecurity.get(h.securityId);
    if (!price) {
      gaps.push({
        date: asOf,
        currency: h.currency,
        reason: 'price_unavailable',
        securityId: h.securityId,
      });
      continue;
    }
    const qty = Number(h.quantity);
    const px = Number(price.price);
    rows.push({
      accountId: h.accountId,
      securityId: h.securityId,
      marketValue: qty * px,
      currency: price.currency,
    });
  }

  return { rows, gaps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend test backend/test/portfolioMarketValueAt.test.ts --run`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/networth/portfolioMarketValueAt.ts backend/test/portfolioMarketValueAt.test.ts
git commit -m "feat(networth): add portfolioMarketValueAt for historical market values"
```

---

### Task 5: `unifyToCad` FX helper

**Files:**
- Create: `backend/src/networth/unifyToCad.ts`
- Create: `backend/test/unifyToCad.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/unifyToCad.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { unifyToCad } from '../src/networth/unifyToCad';

vi.mock('../src/fx/bankOfCanada', () => ({
  ensureFxRate: vi.fn(async (from: string, to: string, asOf: string) => {
    if (from === 'CAD' && to === 'CAD') return { rate: 1, ratedDate: asOf };
    if (from === 'USD' && to === 'CAD') return { rate: 1.36, ratedDate: asOf };
    return null; // anything else missing
  }),
}));

describe('unifyToCad', () => {
  it('sums per-currency amounts split by kind, includes rates used', async () => {
    const input = {
      CAD: { asset: 1000, liability: -200 },
      USD: { asset: 500, liability: 0 },
    };
    const result = await unifyToCad(input, '2026-05-24');
    expect(result.totalAssets).toBeCloseTo(1000 + 500 * 1.36, 4);
    expect(result.totalLiabilities).toBeCloseTo(-200, 4);
    expect(result.gaps).toEqual([]);
    expect(result.fxRatesUsed).toEqual([
      { from: 'USD', to: 'CAD', rate: 1.36, ratedDate: '2026-05-24' },
    ]);
  });

  it('excludes a currency that has no FX rate and emits a gap', async () => {
    const input = {
      CAD: { asset: 100, liability: 0 },
      EUR: { asset: 50, liability: 0 },
    };
    const result = await unifyToCad(input, '2026-05-24');
    expect(result.totalAssets).toBe(100);
    expect(result.gaps).toEqual([
      { date: '2026-05-24', currency: 'EUR', reason: 'fx_rate_unavailable' },
    ]);
  });

  it('does not record an FX rate entry for CAD→CAD identity', async () => {
    const input = { CAD: { asset: 100, liability: 0 } };
    const result = await unifyToCad(input, '2026-05-24');
    expect(result.fxRatesUsed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend test backend/test/unifyToCad.test.ts --run`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `unifyToCad`**

Create `backend/src/networth/unifyToCad.ts`:

```ts
import { ensureFxRate } from '../fx/bankOfCanada';

export type PerCurrencyByKind = Record<string, { asset: number; liability: number }>;

export type FxRateUsed = {
  from: string;
  to: 'CAD';
  rate: number;
  ratedDate: string;
};

export type UnifyGap = {
  date: string;
  currency: string;
  reason: 'fx_rate_unavailable';
};

export type UnifyResult = {
  totalAssets: number;
  totalLiabilities: number;
  fxRatesUsed: FxRateUsed[];
  gaps: UnifyGap[];
};

export async function unifyToCad(
  perCurrency: PerCurrencyByKind,
  asOf: string
): Promise<UnifyResult> {
  let totalAssets = 0;
  let totalLiabilities = 0;
  const fxRatesUsed: FxRateUsed[] = [];
  const gaps: UnifyGap[] = [];

  for (const [currency, { asset, liability }] of Object.entries(perCurrency)) {
    if (currency === 'CAD') {
      totalAssets += asset;
      totalLiabilities += liability;
      continue;
    }
    const fx = await ensureFxRate(currency, 'CAD', asOf);
    if (!fx) {
      gaps.push({ date: asOf, currency, reason: 'fx_rate_unavailable' });
      continue;
    }
    totalAssets += asset * fx.rate;
    totalLiabilities += liability * fx.rate;
    fxRatesUsed.push({ from: currency, to: 'CAD', rate: fx.rate, ratedDate: fx.ratedDate });
  }

  return { totalAssets, totalLiabilities, fxRatesUsed, gaps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend test backend/test/unifyToCad.test.ts --run`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/networth/unifyToCad.ts backend/test/unifyToCad.test.ts
git commit -m "feat(networth): add unifyToCad FX aggregator with hard-fail on missing rate"
```

---

### Task 6: `buildNetWorthAt` aggregator

**Files:**
- Create: `backend/src/networth/aggregate.ts` (just `buildNetWorthAt` for this task; `buildSeries` in Task 7)
- Create: `backend/test/networthAggregate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/networthAggregate.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Account, Transaction, sequelize } from '../src/models';
import { buildNetWorthAt } from '../src/networth/aggregate';

vi.mock('../src/fx/bankOfCanada', () => ({
  ensureFxRate: vi.fn(async (from: string, to: string, asOf: string) => {
    if (from === 'USD' && to === 'CAD') return { rate: 1.36, ratedDate: asOf };
    return null;
  }),
}));

async function seed(opts: { accountType: string; defaultCurrency?: string; opening?: number }) {
  return Account.create({
    name: 'A',
    owner: 'me',
    accountType: opts.accountType,
    defaultCurrency: opts.defaultCurrency ?? 'CAD',
    openingBalance: String(opts.opening ?? 0),
  } as Parameters<typeof Account.create>[0]);
}

async function txn(accountId: number, date: string, amount: number, currency = 'CAD') {
  await Transaction.create({
    accountId, date,
    amount: String(amount),
    currency,
    description: 't',
    rawDescription: 't',
    importBatch: 'test',
    sourceRowFingerprint: `${accountId}-${date}-${amount}-${Math.random()}`,
  } as Parameters<typeof Transaction.create>[0]);
}

describe('buildNetWorthAt', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  it('sums a single CAD checking account', async () => {
    const acc = await seed({ accountType: 'checking', opening: 5000 });
    await txn(acc.id, '2026-01-01', -100);
    const result = await buildNetWorthAt('2026-01-15', [acc.id]);
    expect(result.total).toBe(4900);
    expect(result.assetsTotal).toBe(4900);
    expect(result.liabilitiesTotal).toBe(0);
    expect(result.partial).toBe(false);
  });

  it('subtracts credit_card debt from assets', async () => {
    const chq = await seed({ accountType: 'checking', opening: 5000 });
    const cc  = await seed({ accountType: 'credit_card', opening: 0 });
    await txn(cc.id, '2026-01-01', -200); // spent on card → balance now -200 (owe 200)
    const result = await buildNetWorthAt('2026-01-15', [chq.id, cc.id]);
    expect(result.assetsTotal).toBe(5000);
    expect(result.liabilitiesTotal).toBe(-200);
    expect(result.total).toBe(4800);
  });

  it('unifies multi-currency to CAD using mocked FX', async () => {
    const acc = await seed({ accountType: 'checking', defaultCurrency: 'CAD', opening: 100 });
    await txn(acc.id, '2026-01-01', 500, 'USD');
    const result = await buildNetWorthAt('2026-02-01', [acc.id]);
    expect(result.total).toBeCloseTo(100 + 500 * 1.36, 4);
    expect(result.fxRatesUsed).toContainEqual(
      expect.objectContaining({ from: 'USD', to: 'CAD', rate: 1.36 })
    );
  });

  it('marks partial when FX rate is missing', async () => {
    const acc = await seed({ accountType: 'checking', defaultCurrency: 'CAD', opening: 100 });
    await txn(acc.id, '2026-01-01', 50, 'EUR');
    const result = await buildNetWorthAt('2026-02-01', [acc.id]);
    expect(result.partial).toBe(true);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ currency: 'EUR', reason: 'fx_rate_unavailable' })
    );
    expect(result.total).toBe(100); // EUR excluded
  });

  it('returns empty breakdown for empty accountIds', async () => {
    const result = await buildNetWorthAt('2026-02-01', []);
    expect(result.total).toBe(0);
    expect(result.breakdown.assets).toEqual([]);
    expect(result.breakdown.liabilities).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace cashflow-backend test backend/test/networthAggregate.test.ts --run`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `buildNetWorthAt`**

Create `backend/src/networth/aggregate.ts`:

```ts
import { Account } from '../models';
import { accountKind } from './accountKind';
import { balanceAtDate } from './balanceAtDate';
import { portfolioMarketValueAt } from './portfolioMarketValueAt';
import { unifyToCad, type PerCurrencyByKind, type FxRateUsed } from './unifyToCad';

export type BreakdownRow = {
  source: 'account' | 'portfolio';
  accountId: number | null;
  label: string;
  currency: string;
  native: number | null;
  cadValue: number | null;
};

export type NetWorthGap =
  | { date: string; currency: string; reason: 'fx_rate_unavailable' }
  | { date: string; currency: string; reason: 'price_unavailable'; securityId: number };

export type NetWorthAtDate = {
  asOf: string;
  baseCurrency: 'CAD';
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
  breakdown: { assets: BreakdownRow[]; liabilities: BreakdownRow[] };
  fxRatesUsed: FxRateUsed[];
  partial: boolean;
  gaps: NetWorthGap[];
};

export async function buildNetWorthAt(
  asOf: string,
  accountIds: number[]
): Promise<NetWorthAtDate> {
  const assets: BreakdownRow[] = [];
  const liabilities: BreakdownRow[] = [];
  const perCurrency: PerCurrencyByKind = {};
  const gaps: NetWorthGap[] = [];

  const accounts = accountIds.length
    ? await Account.findAll({ where: { id: accountIds } })
    : [];

  for (const acc of accounts) {
    const kind = accountKind(acc.accountType);
    const balances = await balanceAtDate(acc, asOf);
    for (const { currency, amount } of balances) {
      perCurrency[currency] ??= { asset: 0, liability: 0 };
      perCurrency[currency][kind] += amount;
      (kind === 'asset' ? assets : liabilities).push({
        source: 'account',
        accountId: acc.id,
        label: acc.name,
        currency,
        native: amount,
        cadValue: null,
      });
    }
  }

  const portfolio = await portfolioMarketValueAt(asOf, accountIds);
  // Group portfolio market value per (accountId, currency) for breakdown
  const portfolioByAcc = new Map<string, { accountId: number; currency: string; total: number }>();
  for (const row of portfolio.rows) {
    perCurrency[row.currency] ??= { asset: 0, liability: 0 };
    perCurrency[row.currency].asset += row.marketValue;
    const key = `${row.accountId}:${row.currency}`;
    const acc = portfolioByAcc.get(key) ?? { accountId: row.accountId, currency: row.currency, total: 0 };
    acc.total += row.marketValue;
    portfolioByAcc.set(key, acc);
  }
  for (const { accountId, currency, total } of portfolioByAcc.values()) {
    const acc = accounts.find((a) => a.id === accountId);
    assets.push({
      source: 'portfolio',
      accountId,
      label: `Portfolio (${acc?.name ?? accountId})`,
      currency,
      native: total,
      cadValue: null,
    });
  }
  gaps.push(...portfolio.gaps);

  const unified = await unifyToCad(perCurrency, asOf);
  gaps.push(...unified.gaps);

  return {
    asOf,
    baseCurrency: 'CAD',
    total: unified.totalAssets + unified.totalLiabilities,
    assetsTotal: unified.totalAssets,
    liabilitiesTotal: unified.totalLiabilities,
    breakdown: { assets, liabilities },
    fxRatesUsed: unified.fxRatesUsed,
    partial: gaps.length > 0,
    gaps,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace cashflow-backend test backend/test/networthAggregate.test.ts --run`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/networth/aggregate.ts backend/test/networthAggregate.test.ts
git commit -m "feat(networth): add buildNetWorthAt aggregator"
```

---

### Task 7: `buildSeries` time series compute

**Files:**
- Modify: `backend/src/networth/aggregate.ts` (add `buildSeries` + bucket helpers)
- Modify: `backend/test/networthAggregate.test.ts` (append series tests)

- [ ] **Step 1: Add the failing tests**

Append to `backend/test/networthAggregate.test.ts`:

```ts
import { buildSeries, monthEndDatesInRange, daysInRange } from '../src/networth/aggregate';

describe('monthEndDatesInRange', () => {
  it('returns last day of each month in range, inclusive', () => {
    expect(monthEndDatesInRange('2026-01-15', '2026-03-10')).toEqual([
      '2026-01-31',
      '2026-02-28',
    ]);
  });
});

describe('daysInRange', () => {
  it('returns every date in range, inclusive', () => {
    expect(daysInRange('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02',
    ]);
  });
});

describe('buildSeries', () => {
  beforeEach(async () => {
    await sequelize.sync({ force: true });
  });

  it('emits one point per monthly bucket with expected totals', async () => {
    const acc = await seed({ accountType: 'checking', opening: 1000 });
    await txn(acc.id, '2026-01-15', 100);
    await txn(acc.id, '2026-02-15', -50);
    const result = await buildSeries('2026-01-01', '2026-02-28', 'monthly', [acc.id]);
    expect(result.points).toEqual([
      { date: '2026-01-31', total: 1100, assetsTotal: 1100, liabilitiesTotal: 0 },
      { date: '2026-02-28', total: 1050, assetsTotal: 1050, liabilitiesTotal: 0 },
    ]);
    expect(result.partial).toBe(false);
  });

  it('marks partial=true and lists gaps when any bucket has FX/price issues', async () => {
    const acc = await seed({ accountType: 'checking', defaultCurrency: 'CAD', opening: 100 });
    await txn(acc.id, '2026-01-15', 10, 'EUR');
    const result = await buildSeries('2026-01-01', '2026-02-28', 'monthly', [acc.id]);
    expect(result.partial).toBe(true);
    expect(result.gaps.length).toBeGreaterThan(0);
  });
});
```

(Note: the existing helper imports `seed` and `txn` from the file's outer scope; keep them defined once at the top of the file.)

- [ ] **Step 2: Run tests to verify failure**

Run: `yarn workspace cashflow-backend test backend/test/networthAggregate.test.ts --run`
Expected: FAIL — `buildSeries`, `monthEndDatesInRange`, `daysInRange` not exported.

- [ ] **Step 3: Add `buildSeries` and helpers to aggregate.ts**

Append to `backend/src/networth/aggregate.ts`:

```ts
export type SeriesPoint = {
  date: string;
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
};

export type NetWorthSeries = {
  baseCurrency: 'CAD';
  granularity: 'monthly' | 'daily';
  points: SeriesPoint[];
  partial: boolean;
  gaps: NetWorthGap[];
};

export function monthEndDatesInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // Walk month by month starting at first month-end ≥ from
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    cursor.setUTCDate(0); // last day of next month
    // Re-advance to last day of the new month
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 0);
  }
  return out;
}

export function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export async function buildSeries(
  from: string,
  to: string,
  granularity: 'monthly' | 'daily',
  accountIds: number[]
): Promise<NetWorthSeries> {
  const buckets = granularity === 'monthly' ? monthEndDatesInRange(from, to) : daysInRange(from, to);
  const points: SeriesPoint[] = [];
  const gaps: NetWorthGap[] = [];
  for (const date of buckets) {
    const snap = await buildNetWorthAt(date, accountIds);
    points.push({
      date,
      total: snap.total,
      assetsTotal: snap.assetsTotal,
      liabilitiesTotal: snap.liabilitiesTotal,
    });
    gaps.push(...snap.gaps);
  }
  return {
    baseCurrency: 'CAD',
    granularity,
    points,
    partial: gaps.length > 0,
    gaps,
  };
}
```

The month-end loop above is fiddly; simplify if a cleaner approach occurs to you, but keep the test as truth: input `('2026-01-15', '2026-03-10')` must yield exactly `['2026-01-31', '2026-02-28']`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn workspace cashflow-backend test backend/test/networthAggregate.test.ts --run`
Expected: PASS, all tests (previous 5 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/networth/aggregate.ts backend/test/networthAggregate.test.ts
git commit -m "feat(networth): add buildSeries with monthly + daily bucket helpers"
```

---

### Task 8: Routes + integration tests + mount in app.ts

**Files:**
- Create: `backend/src/routes/netWorth.ts`
- Create: `backend/test/netWorthRoutes.test.ts`
- Modify: `backend/src/app.ts:80` (add `app.use('/api/net-worth', netWorthRouter)`)

- [ ] **Step 1: Write the failing route tests**

Create `backend/test/netWorthRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { Account, Transaction, User, Household, HouseholdMember, sequelize } from '../src/models';
import { loginAsUser } from './helpers/loginAsUser'; // assume existing test helper

vi.mock('../src/fx/bankOfCanada', () => ({
  ensureFxRate: vi.fn(async (from, to, asOf) => {
    if (from === 'USD' && to === 'CAD') return { rate: 1.36, ratedDate: asOf };
    return null;
  }),
}));

describe('GET /api/net-worth/current', () => {
  let agent: request.SuperAgentTest;
  let userId: number;

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    ({ agent, userId } = await loginAsUser());
  });

  it('returns 401 unauthenticated', async () => {
    const res = await request(app).get('/api/net-worth/current');
    expect(res.status).toBe(401);
  });

  it('returns total derived from seeded accounts', async () => {
    const acc = await Account.create({
      name: 'Chq', owner: 'me', accountType: 'checking',
      defaultCurrency: 'CAD', openingBalance: '1000', ownerUserId: userId,
    } as Parameters<typeof Account.create>[0]);
    await Transaction.create({
      accountId: acc.id, date: '2026-01-01', amount: '-100', currency: 'CAD',
      description: 't', rawDescription: 't', importBatch: 'test',
      sourceRowFingerprint: 'x1',
    } as Parameters<typeof Transaction.create>[0]);

    const res = await agent.get('/api/net-worth/current').query({ asOf: '2026-02-01' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(900);
    expect(res.body.baseCurrency).toBe('CAD');
  });

  it('rejects asOf in the future', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await agent.get('/api/net-worth/current').query({ asOf: tomorrow });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/);
  });
});

describe('GET /api/net-worth/series', () => {
  let agent: request.SuperAgentTest;

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    ({ agent } = await loginAsUser());
  });

  it('rejects daily granularity > 90 days', async () => {
    const res = await agent.get('/api/net-worth/series').query({
      from: '2025-01-01', to: '2026-01-01', granularity: 'daily',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/90 days/);
  });

  it('rejects monthly granularity > 240 buckets', async () => {
    const res = await agent.get('/api/net-worth/series').query({
      from: '2000-01-01', to: '2026-01-01', granularity: 'monthly',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/240/);
  });

  it('returns monthly bucket points', async () => {
    const res = await agent.get('/api/net-worth/series').query({
      from: '2026-01-01', to: '2026-03-31', granularity: 'monthly',
    });
    expect(res.status).toBe(200);
    expect(res.body.points.map((p: { date: string }) => p.date)).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31',
    ]);
  });
});

describe('PATCH /api/accounts/:id/opening-balance', () => {
  let agent: request.SuperAgentTest;
  let userId: number;

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    ({ agent, userId } = await loginAsUser());
  });

  it('updates openingBalance + openingBalanceDate', async () => {
    const acc = await Account.create({
      name: 'Chq', owner: 'me', accountType: 'checking',
      defaultCurrency: 'CAD', ownerUserId: userId,
    } as Parameters<typeof Account.create>[0]);

    const res = await agent.patch(`/api/accounts/${acc.id}/opening-balance`).send({
      openingBalance: 2500,
      openingBalanceDate: '2025-12-31',
    });
    expect(res.status).toBe(200);

    await acc.reload();
    expect(Number(acc.openingBalance)).toBe(2500);
    expect(acc.openingBalanceDate).toBe('2025-12-31');
  });

  it('returns 403 for an account not visible to caller', async () => {
    const acc = await Account.create({
      name: 'OtherUserAcc', owner: 'me', accountType: 'checking',
      defaultCurrency: 'CAD', ownerUserId: userId + 9999, // not this user
    } as Parameters<typeof Account.create>[0]);

    const res = await agent.patch(`/api/accounts/${acc.id}/opening-balance`).send({
      openingBalance: 1, openingBalanceDate: null,
    });
    expect(res.status).toBe(403);
  });
});
```

Note: `loginAsUser` is assumed to be an existing test helper that returns `{ agent, userId }`. If a helper with this exact name doesn't exist, locate the equivalent under `backend/test/helpers/` or replicate the pattern from another route test file (e.g. `backend/test/` files that already use supertest with auth). Update the import path to match what's actually there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn workspace cashflow-backend test backend/test/netWorthRoutes.test.ts --run`
Expected: FAIL — 404 on every route (router not mounted).

- [ ] **Step 3: Implement the router**

Create `backend/src/routes/netWorth.ts`:

```ts
import { Router } from 'express';
import { Account } from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
import { buildNetWorthAt, buildSeries } from '../networth/aggregate';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_MAX_BUCKETS = 90;
const MONTHLY_MAX_BUCKETS = 240;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function visibleAccountIds(req: Parameters<Router['get']>[1] extends (req: infer R, ...rest: unknown[]) => unknown ? R : never): Promise<number[]> {
  const where = visibleAccountWhere(req);
  const accounts = await Account.findAll({ where, attributes: ['id'] });
  return accounts.map((a) => a.id);
}

router.get('/current', async (req, res, next) => {
  try {
    const asOf = (req.query.asOf as string | undefined) ?? todayIso();
    if (!DATE_RE.test(asOf)) {
      return res.status(400).json({ error: 'asOf must be YYYY-MM-DD' });
    }
    if (asOf > todayIso()) {
      return res.status(400).json({ error: 'asOf cannot be in the future' });
    }
    const accountIds = await visibleAccountIds(req);
    const result = await buildNetWorthAt(asOf, accountIds);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/series', async (req, res, next) => {
  try {
    const from = req.query.from as string | undefined;
    let to = req.query.to as string | undefined;
    const granularity = (req.query.granularity as string | undefined) ?? 'monthly';
    if (!from || !DATE_RE.test(from)) return res.status(400).json({ error: 'from must be YYYY-MM-DD' });
    if (!to || !DATE_RE.test(to)) return res.status(400).json({ error: 'to must be YYYY-MM-DD' });
    if (granularity !== 'monthly' && granularity !== 'daily') {
      return res.status(400).json({ error: "granularity must be 'monthly' or 'daily'" });
    }
    if (to > todayIso()) to = todayIso();

    // Bound checks
    if (granularity === 'daily') {
      const ms = new Date(to).getTime() - new Date(from).getTime();
      const days = Math.floor(ms / 86_400_000) + 1;
      if (days > DAILY_MAX_BUCKETS) {
        return res.status(400).json({ error: 'daily granularity limited to 90 days; use monthly' });
      }
    } else {
      const months =
        (new Date(to).getUTCFullYear() - new Date(from).getUTCFullYear()) * 12 +
        (new Date(to).getUTCMonth() - new Date(from).getUTCMonth()) + 1;
      if (months > MONTHLY_MAX_BUCKETS) {
        return res.status(400).json({ error: 'monthly granularity limited to 240 buckets' });
      }
    }

    const accountIds = await visibleAccountIds(req);
    const result = await buildSeries(from, to, granularity, accountIds);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.patch('/accounts/:id/opening-balance', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });

    const account = await Account.findOne({
      where: { id, ...(visibleAccountWhere(req) as object) },
    });
    if (!account) return res.status(403).json({ error: 'forbidden' });

    const { openingBalance, openingBalanceDate } = req.body as {
      openingBalance: number;
      openingBalanceDate: string | null;
    };
    if (typeof openingBalance !== 'number' || !Number.isFinite(openingBalance)) {
      return res.status(400).json({ error: 'openingBalance must be a number' });
    }
    if (openingBalanceDate != null && !DATE_RE.test(openingBalanceDate)) {
      return res.status(400).json({ error: 'openingBalanceDate must be YYYY-MM-DD or null' });
    }

    account.openingBalance = String(openingBalance);
    account.openingBalanceDate = openingBalanceDate;
    await account.save();
    res.json(account.toJSON());
  } catch (err) {
    next(err);
  }
});

export { router as netWorthRouter };
```

Important: the bound check above uses naive arithmetic; the `buildSeries` test in Task 7 is authoritative on bucket counts. If route tests fail because the route's bucket math diverges from `buildSeries`, change the route to call a shared helper. For now, keep them parallel.

- [ ] **Step 4: Mount router in `backend/src/app.ts`**

Open `backend/src/app.ts`. Find the line:

```ts
app.use('/api/portfolio', portfolioRouter);
```

Add the import at the top (alphabetically with other route imports):

```ts
import { netWorthRouter } from './routes/netWorth';
```

After the `portfolioRouter` line, add:

```ts
app.use('/api/net-worth', netWorthRouter);
```

- [ ] **Step 5: Run route tests to verify they pass**

Run: `yarn workspace cashflow-backend test backend/test/netWorthRoutes.test.ts --run`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run typecheck and existing test suite to catch regressions**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend test --run`
Expected: typecheck passes, all backend tests green.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/netWorth.ts backend/src/app.ts backend/test/netWorthRoutes.test.ts
git commit -m "feat(networth): add /api/net-worth routes (current, series, opening-balance)"
```

---

### Task 9: Frontend types + data hooks

**Files:**
- Modify: `frontend/src/types/api.ts` (append net worth types)
- Create: `frontend/src/hooks/useNetWorth.ts`

- [ ] **Step 1: Add types to `frontend/src/types/api.ts`**

Append these types at the end of `frontend/src/types/api.ts`:

```ts
export type NetWorthBreakdownRow = {
  source: 'account' | 'portfolio';
  accountId: number | null;
  label: string;
  currency: string;
  native: number | null;
  cadValue: number | null;
};

export type NetWorthGap =
  | { date: string; currency: string; reason: 'fx_rate_unavailable' }
  | { date: string; currency: string; reason: 'price_unavailable'; securityId: number };

export type NetWorthCurrent = {
  asOf: string;
  baseCurrency: 'CAD';
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
  breakdown: { assets: NetWorthBreakdownRow[]; liabilities: NetWorthBreakdownRow[] };
  fxRatesUsed: { from: string; to: 'CAD'; rate: number; ratedDate: string }[];
  partial: boolean;
  gaps: NetWorthGap[];
};

export type NetWorthSeriesPoint = {
  date: string;
  total: number;
  assetsTotal: number;
  liabilitiesTotal: number;
};

export type NetWorthSeries = {
  baseCurrency: 'CAD';
  granularity: 'monthly' | 'daily';
  points: NetWorthSeriesPoint[];
  partial: boolean;
  gaps: NetWorthGap[];
};
```

- [ ] **Step 2: Create `useNetWorth.ts`**

Create `frontend/src/hooks/useNetWorth.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import { getJson, patchJson } from '@/lib/api'
import type { NetWorthCurrent, NetWorthSeries } from '@/types/api'

type AsyncState<T> = { data: T | null; loading: boolean; error: Error | null }

function useFetch<T>(path: string | null): AsyncState<T> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: path !== null, error: null })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (path === null) return
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    getJson<T>(path)
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }) })
      .catch((err: unknown) => {
        if (!cancelled) setState({ data: null, loading: false, error: err instanceof Error ? err : new Error(String(err)) })
      })
    return () => { cancelled = true }
  }, [path, nonce])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, refresh }
}

export function useNetWorthCurrent(asOf?: string) {
  const path = asOf ? `/api/net-worth/current?asOf=${asOf}` : '/api/net-worth/current'
  return useFetch<NetWorthCurrent>(path)
}

export function useNetWorthSeries(params: { from: string; to: string; granularity: 'monthly' | 'daily' } | null) {
  const path = params
    ? `/api/net-worth/series?from=${params.from}&to=${params.to}&granularity=${params.granularity}`
    : null
  return useFetch<NetWorthSeries>(path)
}

export async function updateOpeningBalance(
  accountId: number,
  body: { openingBalance: number; openingBalanceDate: string | null }
): Promise<void> {
  await patchJson(`/api/net-worth/accounts/${accountId}/opening-balance`, body)
}
```

- [ ] **Step 3: Typecheck**

Run: `yarn workspace frontend run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/api.ts frontend/src/hooks/useNetWorth.ts
git commit -m "feat(networth): add NetWorth types + useNetWorth hooks"
```

---

### Task 10: `NetWorthPage` UI

**Files:**
- Create: `frontend/src/pages/NetWorthPage.tsx`
- Create: `frontend/src/pages/NetWorthPage.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/pages/NetWorthPage.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NetWorthPage } from './NetWorthPage'

vi.mock('@/hooks/useNetWorth', () => ({
  useNetWorthCurrent: () => ({
    data: {
      asOf: '2026-05-24',
      baseCurrency: 'CAD',
      total: 152340.12,
      assetsTotal: 154440.12,
      liabilitiesTotal: -2100,
      breakdown: {
        assets: [
          { source: 'account', accountId: 1, label: 'Chq', currency: 'CAD', native: 5000, cadValue: 5000 },
        ],
        liabilities: [
          { source: 'account', accountId: 7, label: 'Visa', currency: 'CAD', native: -2100, cadValue: -2100 },
        ],
      },
      fxRatesUsed: [],
      partial: false,
      gaps: [],
    },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  useNetWorthSeries: () => ({
    data: { baseCurrency: 'CAD', granularity: 'monthly', points: [], partial: false, gaps: [] },
    loading: false,
    error: null,
    refresh: () => {},
  }),
  updateOpeningBalance: vi.fn(),
}))

describe('NetWorthPage', () => {
  it('renders the headline figure', async () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText(/152,340/)).toBeInTheDocument())
  })

  it('renders rows for both assets and liabilities', async () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>
    )
    expect(await screen.findByText('Chq')).toBeInTheDocument()
    expect(screen.getByText('Visa')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test frontend/src/pages/NetWorthPage.test.tsx --run`
Expected: FAIL — `NetWorthPage` not found.

- [ ] **Step 3: Implement `NetWorthPage.tsx`**

Create `frontend/src/pages/NetWorthPage.tsx`. Use existing `PortfolioPage.tsx` as a reference for header/table/chart patterns; do not import from it but match its visual conventions (Table component, PageHeader, formatting helpers).

Minimum viable structure (chart is a placeholder text node — the chart wiring lands in Task 11):

```tsx
import { useMemo, useState } from 'react'
import { useNetWorthCurrent, useNetWorthSeries } from '@/hooks/useNetWorth'
import { Table, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table'
import { formatMoney } from '@/lib/formatMoney'

type Range = '1M' | '3M' | '1Y' | 'All'

function rangeToParams(range: Range): { from: string; to: string; granularity: 'monthly' | 'daily' } {
  const today = new Date()
  const to = today.toISOString().slice(0, 10)
  const offsetDays: Record<Range, number | 'all'> = { '1M': 31, '3M': 92, '1Y': 365, All: 'all' }
  const from = (() => {
    if (range === 'All') {
      // Default to ~20 years if we don't know the first-txn date yet.
      const d = new Date(today); d.setUTCFullYear(d.getUTCFullYear() - 20)
      return d.toISOString().slice(0, 10)
    }
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - (offsetDays[range] as number))
    return d.toISOString().slice(0, 10)
  })()
  const granularity: 'monthly' | 'daily' = range === '1M' || range === '3M' ? 'daily' : 'monthly'
  return { from, to, granularity }
}

export function NetWorthPage() {
  const [range, setRange] = useState<Range>('1Y')
  const current = useNetWorthCurrent()
  const seriesParams = useMemo(() => rangeToParams(range), [range])
  const series = useNetWorthSeries(seriesParams)

  if (current.loading && !current.data) {
    return <div className="p-6">Loading net worth…</div>
  }

  const cur = current.data
  if (!cur) {
    return <div className="p-6">No data. {current.error?.message}</div>
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Net worth</h1>
          <p className="text-sm text-muted-foreground">As of {cur.asOf}</p>
        </div>
        <div className="flex gap-1">
          {(['1M', '3M', '1Y', 'All'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-sm rounded ${range === r ? 'bg-primary text-primary-foreground' : 'border'}`}
            >
              {r}
            </button>
          ))}
        </div>
      </header>

      {cur.partial && (
        <div className="rounded border border-amber-400 bg-amber-50 text-amber-900 p-3 text-sm">
          Some balances couldn’t be converted to CAD. {cur.gaps.length} gap(s).
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded border p-4">
          <div className="text-sm text-muted-foreground">Net worth (CAD)</div>
          <div className="text-3xl font-semibold">{formatMoney(cur.total, 'CAD')}</div>
        </div>
        <div className="rounded border p-4">
          <div className="text-sm text-muted-foreground">Assets</div>
          <div className="text-2xl font-semibold">{formatMoney(cur.assetsTotal, 'CAD')}</div>
        </div>
        <div className="rounded border p-4">
          <div className="text-sm text-muted-foreground">Liabilities</div>
          <div className="text-2xl font-semibold">{formatMoney(cur.liabilitiesTotal, 'CAD')}</div>
        </div>
      </div>

      <div className="rounded border p-4 min-h-[240px]">
        <div className="text-sm text-muted-foreground mb-2">Trend ({seriesParams.granularity})</div>
        {/* Chart wiring lands in Task 11 — placeholder showing point count for now */}
        <div>{series.data ? `${series.data.points.length} points` : 'Loading…'}</div>
      </div>

      <div className="rounded border">
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Source</TableCell>
              <TableCell>Currency</TableCell>
              <TableCell className="text-right">Native</TableCell>
              <TableCell className="text-right">CAD value</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {[...cur.breakdown.assets, ...cur.breakdown.liabilities].map((row, i) => (
              <TableRow key={`${row.source}-${row.accountId}-${row.currency}-${i}`}>
                <TableCell>{row.label}</TableCell>
                <TableCell>{row.currency}</TableCell>
                <TableCell className="text-right">{row.native != null ? formatMoney(row.native, row.currency) : '—'}</TableCell>
                <TableCell className="text-right">{row.cadValue != null ? formatMoney(row.cadValue, 'CAD') : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
```

Confirm the exact `Table` component import path and `formatMoney` signature from existing usage in `frontend/src/pages/PortfolioPage.tsx` (PortfolioPage uses `formatMoney` from `frontend/src/lib/formatMoney.ts` — check signature: `formatMoney(value: number, currency: string)`). Adjust if the actual signature differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend test frontend/src/pages/NetWorthPage.test.tsx --run`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/NetWorthPage.tsx frontend/src/pages/NetWorthPage.test.tsx
git commit -m "feat(networth): add NetWorthPage with headline, breakdown, range picker"
```

---

### Task 11: Wire chart, add route, sidebar entry, dashboard tile

**Files:**
- Modify: `frontend/src/pages/NetWorthPage.tsx` (replace placeholder with real chart)
- Modify: `frontend/src/App.tsx:50` (add route)
- Modify: `frontend/src/components/Sidebar.tsx:38-51` (add nav entry)
- Create: `frontend/src/components/dashboard/NetWorthTile.tsx`
- Create: `frontend/src/components/dashboard/NetWorthTile.test.tsx`
- Modify: `frontend/src/pages/DashboardPage.tsx` (mount the tile)

- [ ] **Step 1: Identify the line/area chart component PortfolioPage uses**

Run: `grep -n "import" frontend/src/pages/PortfolioPage.tsx | head -40`

Find the chart import (likely from `recharts` or a wrapper in `frontend/src/components/`). Note the component name and props shape (data array, dataKey for x and y, etc.). This is the chart to reuse in `NetWorthPage` and `NetWorthTile`.

`recharts` is already a frontend dependency (see `frontend/package.json`); use `<AreaChart>` from it without adding the package.

Document the choice here before continuing.

- [ ] **Step 2: Replace the chart placeholder in `NetWorthPage.tsx`**

In `frontend/src/pages/NetWorthPage.tsx`, swap the `<div className="rounded border p-4 min-h-[240px]">` block for the actual chart, using whatever chart component was identified in Step 1. Bind to `series.data?.points` with x=date, y=total. Skip rendering if `series.loading || !series.data`.

Example with recharts:

```tsx
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

// inside the component, replace the placeholder div with:
<div className="rounded border p-4 h-[280px]">
  <ResponsiveContainer width="100%" height="100%">
    <AreaChart data={series.data?.points ?? []}>
      <XAxis dataKey="date" />
      <YAxis />
      <Tooltip />
      <Area type="monotone" dataKey="total" />
    </AreaChart>
  </ResponsiveContainer>
</div>
```

- [ ] **Step 3: Add the route**

In `frontend/src/App.tsx`, after the line:

```tsx
<Route path="portfolio/security/:id" element={<PortfolioSecurityPage />} />
```

add:

```tsx
<Route path="net-worth" element={<NetWorthPage />} />
```

Add the import at the top of the file (alphabetically with other page imports):

```tsx
import { NetWorthPage } from './pages/NetWorthPage'
```

- [ ] **Step 4: Add sidebar nav entry**

In `frontend/src/components/Sidebar.tsx`, add `Coins` to the `lucide-react` import (alphabetically), then insert into `navItems` above the Reports entry:

```tsx
{ to: '/net-worth', label: 'Net worth', icon: Coins },
```

If `Coins` isn't available in your lucide-react version, fall back to `Wallet` or `PiggyBank`. PortfolioPage uses `LineChart`; pick something distinct.

- [ ] **Step 5: Write the tile test**

Create `frontend/src/components/dashboard/NetWorthTile.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { NetWorthTile } from './NetWorthTile'

vi.mock('@/hooks/useNetWorth', () => ({
  useNetWorthCurrent: () => ({
    data: { asOf: '2026-05-24', baseCurrency: 'CAD', total: 12345, assetsTotal: 13000, liabilitiesTotal: -655, breakdown: { assets: [], liabilities: [] }, fxRatesUsed: [], partial: false, gaps: [] },
    loading: false, error: null, refresh: () => {},
  }),
  useNetWorthSeries: () => ({
    data: { baseCurrency: 'CAD', granularity: 'monthly', points: [{ date: '2025-06-30', total: 10000, assetsTotal: 10000, liabilitiesTotal: 0 }, { date: '2026-05-31', total: 12345, assetsTotal: 13000, liabilitiesTotal: -655 }], partial: false, gaps: [] },
    loading: false, error: null, refresh: () => {},
  }),
}))

describe('NetWorthTile', () => {
  it('renders headline + click-through link', () => {
    render(<MemoryRouter><NetWorthTile /></MemoryRouter>)
    expect(screen.getByText(/12,345/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /net worth/i })).toHaveAttribute('href', '/net-worth')
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `yarn workspace frontend test frontend/src/components/dashboard/NetWorthTile.test.tsx --run`
Expected: FAIL — `NetWorthTile` not found.

- [ ] **Step 7: Implement `NetWorthTile.tsx`**

Create `frontend/src/components/dashboard/NetWorthTile.tsx`:

```tsx
import { Link } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { useNetWorthCurrent, useNetWorthSeries } from '@/hooks/useNetWorth'
import { formatMoney } from '@/lib/formatMoney'

function oneYearAgo(): { from: string; to: string } {
  const today = new Date()
  const from = new Date(today); from.setUTCFullYear(from.getUTCFullYear() - 1)
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) }
}

export function NetWorthTile() {
  const current = useNetWorthCurrent()
  const series = useNetWorthSeries({ ...oneYearAgo(), granularity: 'monthly' })

  if (current.loading && !current.data) {
    return <div className="rounded border p-4">Loading…</div>
  }
  const cur = current.data
  if (!cur) {
    return <div className="rounded border p-4 text-sm text-muted-foreground">Net worth unavailable. {current.error?.message}</div>
  }

  return (
    <Link to="/net-worth" className="block rounded border p-4 hover:bg-muted/40 transition-colors">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-muted-foreground">Net worth</div>
          <div className="text-2xl font-semibold">{formatMoney(cur.total, 'CAD')}</div>
        </div>
        <div className="w-32 h-12">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series.data?.points ?? []}>
              <Area type="monotone" dataKey="total" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Link>
  )
}
```

- [ ] **Step 8: Mount the tile in `DashboardPage.tsx`**

Open `frontend/src/pages/DashboardPage.tsx`. The file is large (1537 lines). Locate the existing summary tile grid (search for "tile" / "summary" / a grid of cards near the top of the rendered JSX). Add the tile inside that grid:

```tsx
import { NetWorthTile } from '@/components/dashboard/NetWorthTile'

// ... inside JSX, alongside other tiles ...
<NetWorthTile />
```

The exact insertion point depends on the current dashboard layout — choose a slot that gives the tile equivalent prominence to other top-level summary cards. Document the chosen line in the commit message.

- [ ] **Step 9: Run all frontend tests**

Run: `yarn workspace frontend test --run`
Expected: PASS, all green including new ones.

- [ ] **Step 10: Manual smoke test**

Run: `yarn dev` (from repo root)

Open `http://localhost:5173`. Verify:
- "Net worth" appears in the left sidebar above Reports.
- Clicking it loads `/net-worth` with headline + breakdown + chart (chart may be empty with no historical txns, that's fine).
- Range buttons (1M/3M/1Y/All) change the chart without errors.
- Dashboard page now shows a Net worth tile that links to `/net-worth`.

If the page errors or the chart fails to render, fix before continuing.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/pages/NetWorthPage.tsx frontend/src/components/dashboard/NetWorthTile.tsx frontend/src/components/dashboard/NetWorthTile.test.tsx frontend/src/App.tsx frontend/src/components/Sidebar.tsx frontend/src/pages/DashboardPage.tsx
git commit -m "feat(networth): wire NetWorthPage chart + sidebar + dashboard tile"
```

---

### Task 12: Opening-balance editor on NetWorthPage

**Files:**
- Modify: `frontend/src/pages/NetWorthPage.tsx` (add editor section)
- Modify: `frontend/src/pages/NetWorthPage.test.tsx` (add editor test)

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/pages/NetWorthPage.test.tsx`:

```tsx
import userEvent from '@testing-library/user-event'
import { updateOpeningBalance } from '@/hooks/useNetWorth'

describe('NetWorthPage opening-balance editor', () => {
  it('PATCHes the new opening balance on save', async () => {
    render(
      <MemoryRouter>
        <NetWorthPage />
      </MemoryRouter>
    )
    // Open the editor (assuming it's collapsed by default)
    await userEvent.click(screen.getByRole('button', { name: /opening balances/i }))
    const input = await screen.findByLabelText(/opening balance for chq/i)
    await userEvent.clear(input)
    await userEvent.type(input, '2500')
    await userEvent.click(screen.getByRole('button', { name: /save chq/i }))
    expect(updateOpeningBalance).toHaveBeenCalledWith(1, expect.objectContaining({ openingBalance: 2500 }))
  })
})
```

The mock at the top of the file currently uses `vi.fn()` for `updateOpeningBalance`; that mock will record the call.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test frontend/src/pages/NetWorthPage.test.tsx --run`
Expected: FAIL — editor not present.

- [ ] **Step 3: Add the editor section to `NetWorthPage.tsx`**

Below the breakdown table, add a collapsible section. State + handler at the top of the component:

```tsx
const [editorOpen, setEditorOpen] = useState(false)
const [draftOpenings, setDraftOpenings] = useState<Record<number, string>>({})
const accountRows = (cur?.breakdown.assets ?? []).concat(cur?.breakdown.liabilities ?? []).filter((r) => r.source === 'account')

async function saveOpening(accountId: number) {
  const raw = draftOpenings[accountId] ?? ''
  const val = Number(raw)
  if (!Number.isFinite(val)) return
  await updateOpeningBalance(accountId, { openingBalance: val, openingBalanceDate: null })
  current.refresh()
}
```

Add `import { updateOpeningBalance } from '@/hooks/useNetWorth'` at the top.

JSX (after the breakdown table):

```tsx
<div className="rounded border">
  <button
    type="button"
    onClick={() => setEditorOpen((v) => !v)}
    className="w-full text-left p-4 font-medium"
  >
    Opening balances {editorOpen ? '−' : '+'}
  </button>
  {editorOpen && (
    <div className="p-4 space-y-3 border-t">
      {accountRows.map((row) => (
        <div key={`${row.accountId}-${row.currency}`} className="flex items-center gap-3">
          <label className="w-40 truncate" htmlFor={`opening-${row.accountId}`}>{row.label}</label>
          <input
            id={`opening-${row.accountId}`}
            aria-label={`Opening balance for ${row.label}`}
            type="number"
            className="border rounded px-2 py-1"
            defaultValue=""
            onChange={(e) => setDraftOpenings((d) => ({ ...d, [row.accountId!]: e.target.value }))}
          />
          <button
            type="button"
            onClick={() => saveOpening(row.accountId!)}
            aria-label={`Save ${row.label}`}
            className="rounded border px-3 py-1 text-sm"
          >
            Save
          </button>
        </div>
      ))}
    </div>
  )}
</div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend test frontend/src/pages/NetWorthPage.test.tsx --run`
Expected: PASS, all NetWorthPage tests including the new one.

- [ ] **Step 5: Manual smoke test the editor**

Run `yarn dev`, open `/net-worth`, click "Opening balances", enter a value for an account, click Save. Watch the network panel for the PATCH request. Confirm 200 response and that the headline figure updates after refresh.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/NetWorthPage.tsx frontend/src/pages/NetWorthPage.test.tsx
git commit -m "feat(networth): add opening-balance editor to NetWorthPage"
```

---

### Task 13: Full-suite checks

**Files:** none new — runs existing checks.

- [ ] **Step 1: Lint, typecheck, and test the whole repo**

Run in parallel (separate terminals or `&&` chain):

```bash
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend test --run
yarn workspace frontend run typecheck
yarn workspace frontend run lint
yarn workspace frontend test --run
```

Expected: all green.

- [ ] **Step 2: Manual prod-DB spot-check (per `feedback_use_prod_db_not_local` memory)**

With prod `DATABASE_URL` exported, start backend + frontend, open `/net-worth`, and compare the headline figure to your actual bank reality. Note any divergence — if it's not explained by missing opening balances or known CSV gaps, halt and investigate.

- [ ] **Step 3: No commit needed unless fixes were made.**

If issues were found and fixed during this step, commit them with a clear message describing what was wrong.

---

## Self-review notes

- **Spec coverage:** All spec sections — data model (Task 1), accountKind helper (Task 2), balanceAtDate (Task 3), portfolioMarketValueAt (Task 4), unifyToCad (Task 5), buildNetWorthAt (Task 6), buildSeries (Task 7), routes (Task 8), frontend types + hook (Task 9), NetWorthPage (Tasks 10–12), DashboardPage tile + sidebar + router (Task 11). The "extensibility hook" `ManualWealthEntry` is explicitly out of scope per the spec.
- **No placeholders:** Every step has either a code block or an exact command. The only "to be located" notes (the chart library identification in Task 11 Step 1, the `loginAsUser` helper path in Task 8 Step 1, the DashboardPage insertion point in Task 11 Step 8) are flagged as research steps with a clear acceptance criterion, not TODOs.
- **Type consistency:** `CurrencyAmount` (Task 3), `PortfolioRow`/`PortfolioGap`/`PortfolioMarketValueResult` (Task 4), `PerCurrencyByKind`/`UnifyResult` (Task 5), `BreakdownRow`/`NetWorthGap`/`NetWorthAtDate`/`SeriesPoint`/`NetWorthSeries` (Tasks 6–7) flow through the route (Task 8) and into the frontend types (Task 9) without renaming. `accountId` is `number | null` in `BreakdownRow` to handle the portfolio source row; frontend mirrors that.
- **Open items deferred to plan-execution discovery:**
  - Exact `loginAsUser` helper path under `backend/test/helpers/` (Task 8).
  - Existing chart library or new `recharts` dep (Task 11).
  - DashboardPage tile insertion line (Task 11).
  - `formatMoney` exact signature confirmed against `frontend/src/lib/formatMoney.ts` (Task 10).
