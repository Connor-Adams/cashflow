# Portfolio Tax Buckets (Slice D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new "By account type" tab that groups holdings by `Account.taxStatus`, surfaces tax-placement warnings, and lists tax-loss-harvest candidates with superficial-loss-rule annotations. Backed by a new `GET /api/portfolio/by-account-type` endpoint.

**Architecture:** New `backend/src/portfolio/tax-buckets.ts` module hosts the pure tax-classification helpers (`isUsDomiciled` with symbol-suffix fallback, `isFixedIncome` substring detection, `rowFlags`, `harvestCandidate`). The new route assembles bucketed holdings, computes warnings + harvest candidates (with a single batched ±30d superficial-loss query), and returns `{ buckets, warnings, harvestCandidates }`. Frontend extracts the existing inline `<AllocationDonut>` into a shared component, then composes five new components (`TaxWarningsStrip`, `HarvestCandidatesStrip`, `BucketCard`, `BucketBreakdownTable`, `AccountTypePanel`) into a new tab inserted between Allocation and Income.

**Tech Stack:** Backend Sequelize 6 + Express + TypeScript + `node:test` + `supertest`. Frontend React 19 + TypeScript + Vite + Vitest + recharts.

**Spec:** [docs/superpowers/specs/2026-05-24-portfolio-tax-buckets-design.md](../specs/2026-05-24-portfolio-tax-buckets-design.md)

---

## File Structure

### Backend — new files

| Path | Responsibility |
|---|---|
| `backend/src/portfolio/tax-buckets.ts` | `TAX_STATUS_LABELS`, `TAX_STATUS_ORDER`, `isUsDomiciled`, `isFixedIncome`, `rowFlags`, `harvestCandidate` + `TAX_LOSS_THRESHOLD_CAD` constant |
| `backend/test/portfolio/tax-buckets.test.ts` | Unit tests for the four pure helpers |
| `backend/test/integration/portfolioByAccountType.test.ts` | Integration test for the new endpoint |

### Backend — modified files

| Path | Change |
|---|---|
| `backend/src/routes/portfolio.ts` | Add `GET /by-account-type` route handler |

### Frontend — new files

| Path | Responsibility |
|---|---|
| `frontend/src/components/ui/allocation-donut.tsx` | Extracted reusable donut (currently inline in PortfolioPage) |
| `frontend/src/components/ui/allocation-donut.test.tsx` | Smoke test for the extracted component |
| `frontend/src/pages/portfolio-account-type/AccountTypePanel.tsx` | Top-level: owns fetch + composition |
| `frontend/src/pages/portfolio-account-type/AccountTypePanel.test.tsx` | Tests |
| `frontend/src/pages/portfolio-account-type/TaxWarningsStrip.tsx` | Renders `warnings[]` |
| `frontend/src/pages/portfolio-account-type/TaxWarningsStrip.test.tsx` | Tests |
| `frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.tsx` | Renders `harvestCandidates[]` |
| `frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.test.tsx` | Tests |
| `frontend/src/pages/portfolio-account-type/BucketCard.tsx` | Single bucket card |
| `frontend/src/pages/portfolio-account-type/BucketCard.test.tsx` | Tests |
| `frontend/src/pages/portfolio-account-type/BucketBreakdownTable.tsx` | All-buckets concatenated table |
| `frontend/src/pages/portfolio-account-type/BucketBreakdownTable.test.tsx` | Tests |

### Frontend — modified files

| Path | Change |
|---|---|
| `shared/api-types.ts` | Add `PortfolioByAccountType` + sub-types |
| `frontend/src/pages/PortfolioPage.tsx` | Replace inline `AllocationDonut` with import; add `'by-account-type'` tab to `TAB_ITEMS`; add `<TabPanel>` rendering `<AccountTypePanel />` |

---

## Phase 1 — Backend tax-buckets helpers

### Task 1: `tax-buckets.ts` module + unit tests

**Files:**
- Create: `backend/src/portfolio/tax-buckets.ts`
- Create: `backend/test/portfolio/tax-buckets.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `backend/test/portfolio/tax-buckets.test.ts`:

```ts
/**
 * Unit tests for the pure tax-classification helpers in tax-buckets.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUsDomiciled,
  isFixedIncome,
  rowFlags,
  harvestCandidate,
  TAX_STATUS_LABELS,
  TAX_LOSS_THRESHOLD_CAD,
} from '../../src/portfolio/tax-buckets';

// isUsDomiciled
test('isUsDomiciled: metadata.country=USA → true', () => {
  assert.equal(isUsDomiciled({ symbol: 'VTI', currency: 'USD', metadata: { country: 'USA' } }), true);
});
test('isUsDomiciled: metadata.country=United States → true', () => {
  assert.equal(isUsDomiciled({ symbol: 'VTI', currency: 'USD', metadata: { country: 'United States' } }), true);
});
test('isUsDomiciled: metadata.country=Canada → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'XEQT.TO', currency: 'CAD', metadata: { country: 'Canada' } }), false);
});
test('isUsDomiciled: no metadata, .TO suffix → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'XEQT.TO', currency: 'CAD', metadata: null }), false);
});
test('isUsDomiciled: no metadata, .NEO suffix → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'HQU.NEO', currency: 'CAD', metadata: null }), false);
});
test('isUsDomiciled: no metadata, .L suffix → false (UK)', () => {
  assert.equal(isUsDomiciled({ symbol: 'VWRL.L', currency: 'GBP', metadata: null }), false);
});
test('isUsDomiciled: no metadata, bare symbol + USD → true', () => {
  assert.equal(isUsDomiciled({ symbol: 'VTI', currency: 'USD', metadata: null }), true);
});
test('isUsDomiciled: no metadata, bare symbol + CAD → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'BNS', currency: 'CAD', metadata: null }), false);
});
test('isUsDomiciled: no metadata, unknown suffix → false', () => {
  assert.equal(isUsDomiciled({ symbol: 'NSRGY.OTC', currency: 'USD', metadata: null }), false);
});
test('isUsDomiciled: BRK.A US dotted symbol with USD → false (has suffix)', () => {
  // BRK.A has a dot, so heuristic returns false (no country metadata case).
  // This is acceptable v1 — real users have OVERVIEW.country populated.
  assert.equal(isUsDomiciled({ symbol: 'BRK.A', currency: 'USD', metadata: null }), false);
});

// isFixedIncome
test('isFixedIncome: BOND → true', () => assert.equal(isFixedIncome('BOND'), true));
test('isFixedIncome: bond fund (lowercase) → true', () => assert.equal(isFixedIncome('bond fund'), true));
test('isFixedIncome: GIC → true', () => assert.equal(isFixedIncome('GIC'), true));
test('isFixedIncome: Fixed Income → true', () => assert.equal(isFixedIncome('Fixed Income'), true));
test('isFixedIncome: Treasury → true', () => assert.equal(isFixedIncome('Treasury'), true));
test('isFixedIncome: Debenture → true', () => assert.equal(isFixedIncome('Debenture'), true));
test('isFixedIncome: ETF → false', () => assert.equal(isFixedIncome('ETF'), false));
test('isFixedIncome: EQUITY → false', () => assert.equal(isFixedIncome('EQUITY'), false));
test('isFixedIncome: null → false', () => assert.equal(isFixedIncome(null), false));

// rowFlags
test('rowFlags: US security in non-reg → us_withholding', () => {
  const f = rowFlags({
    security: { symbol: 'VTI', currency: 'USD', assetType: 'ETF', metadata: null },
    account: { taxStatus: 'non_registered' },
    hasDividends: false,
  });
  assert.deepEqual(f.sort(), ['us_withholding']);
});
test('rowFlags: bond in non-reg → fixed_income_in_non_reg', () => {
  const f = rowFlags({
    security: { symbol: 'XBB.TO', currency: 'CAD', assetType: 'BOND', metadata: null },
    account: { taxStatus: 'non_registered' },
    hasDividends: false,
  });
  assert.deepEqual(f.sort(), ['fixed_income_in_non_reg']);
});
test('rowFlags: US dividend payer in TFSA → us_payer_in_tfsa', () => {
  const f = rowFlags({
    security: { symbol: 'VOO', currency: 'USD', assetType: 'ETF', metadata: null },
    account: { taxStatus: 'registered_tfsa' },
    hasDividends: true,
  });
  assert.deepEqual(f.sort(), ['us_payer_in_tfsa']);
});
test('rowFlags: US dividend payer in TFSA but no dividends → no flag', () => {
  const f = rowFlags({
    security: { symbol: 'VOO', currency: 'USD', assetType: 'ETF', metadata: null },
    account: { taxStatus: 'registered_tfsa' },
    hasDividends: false,
  });
  assert.deepEqual(f.sort(), []);
});
test('rowFlags: Cdn equity in RRSP → no flags', () => {
  const f = rowFlags({
    security: { symbol: 'BNS', currency: 'CAD', assetType: 'EQUITY', metadata: null },
    account: { taxStatus: 'registered_rrsp' },
    hasDividends: true,
  });
  assert.deepEqual(f.sort(), []);
});

// harvestCandidate
test('harvestCandidate: loss > $500 → candidate', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: 400,
  });
  assert.deepEqual(c, { unrealizedLossCad: 600 });
});
test('harvestCandidate: loss == $500 → not a candidate (strict >)', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: 500,
  });
  assert.equal(c, null);
});
test('harvestCandidate: gain → null', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: 1500,
  });
  assert.equal(c, null);
});
test('harvestCandidate: null costBasisCad → null', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: null, marketValueCad: 500,
  });
  assert.equal(c, null);
});
test('harvestCandidate: null marketValueCad → null', () => {
  const c = harvestCandidate({
    securityId: 1, symbol: 'VTI', accountId: 10, accountName: 'NR',
    costBasisCad: 1000, marketValueCad: null,
  });
  assert.equal(c, null);
});

// Exports sanity
test('TAX_STATUS_LABELS has all six statuses', () => {
  assert.equal(TAX_STATUS_LABELS.registered_tfsa, 'TFSA');
  assert.equal(TAX_STATUS_LABELS.registered_rrsp, 'RRSP');
  assert.equal(TAX_STATUS_LABELS.non_registered, 'Non-registered');
  assert.equal(TAX_STATUS_LABELS.n_a, 'Other');
});
test('TAX_LOSS_THRESHOLD_CAD is 500', () => {
  assert.equal(TAX_LOSS_THRESHOLD_CAD, 500);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test test/portfolio/tax-buckets.test.ts 2>&1 | tail -15
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `tax-buckets.ts`**

Create `backend/src/portfolio/tax-buckets.ts`:

```ts
/**
 * Pure tax-classification helpers for the by-account-type view.
 *
 * Used by the /api/portfolio/by-account-type route handler to derive
 * per-row flags, identify tax-loss-harvest candidates, and label
 * buckets.
 */
import type { AccountTaxStatus } from '../models/Account';

export const TAX_STATUS_LABELS: Record<AccountTaxStatus, string> = {
  registered_tfsa: 'TFSA',
  registered_rrsp: 'RRSP',
  registered_fhsa: 'FHSA',
  registered_rrif: 'RRIF',
  non_registered: 'Non-registered',
  n_a: 'Other',
};

// Display order for bucket cards.
export const TAX_STATUS_ORDER: AccountTaxStatus[] = [
  'registered_tfsa',
  'registered_rrsp',
  'registered_fhsa',
  'registered_rrif',
  'non_registered',
  'n_a',
];

export const TAX_LOSS_THRESHOLD_CAD = 500;

const CANADIAN_SUFFIXES = ['.TO', '.NEO', '.CSE', '.V', '.TRT'];
const UK_SUFFIXES = ['.L', '.LON'];

export type SecurityForClassification = {
  symbol: string
  currency: string
  metadata: Record<string, unknown> | null
};

export function isUsDomiciled(security: SecurityForClassification): boolean {
  const country = (security.metadata?.['country'] as string | undefined)?.toLowerCase();
  if (country) {
    return country === 'usa' || country === 'united states' || country === 'us';
  }
  const sym = security.symbol.toUpperCase();
  if (CANADIAN_SUFFIXES.some((s) => sym.endsWith(s))) return false;
  if (UK_SUFFIXES.some((s) => sym.endsWith(s))) return false;
  if (sym.includes('.')) return false;
  return security.currency === 'USD';
}

export function isFixedIncome(assetType: string | null): boolean {
  if (!assetType) return false;
  return /bond|gic|fixed|treasury|note|debent/i.test(assetType);
}

export type RowFlag = 'us_withholding' | 'fixed_income_in_non_reg' | 'us_payer_in_tfsa';

export type RowFlagsInput = {
  security: SecurityForClassification & { assetType: string | null }
  account: { taxStatus: AccountTaxStatus }
  hasDividends: boolean
};

export function rowFlags(input: RowFlagsInput): RowFlag[] {
  const flags: RowFlag[] = [];
  const us = isUsDomiciled(input.security);
  if (us && input.account.taxStatus === 'non_registered') flags.push('us_withholding');
  if (isFixedIncome(input.security.assetType) && input.account.taxStatus === 'non_registered') {
    flags.push('fixed_income_in_non_reg');
  }
  if (us && input.hasDividends && input.account.taxStatus === 'registered_tfsa') {
    flags.push('us_payer_in_tfsa');
  }
  return flags;
}

export type HarvestInput = {
  securityId: number
  symbol: string
  accountId: number
  accountName: string
  costBasisCad: number | null
  marketValueCad: number | null
};

export function harvestCandidate(input: HarvestInput): { unrealizedLossCad: number } | null {
  if (input.costBasisCad == null || input.marketValueCad == null) return null;
  const loss = input.costBasisCad - input.marketValueCad;
  if (loss <= TAX_LOSS_THRESHOLD_CAD) return null;
  return { unrealizedLossCad: loss };
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test test/portfolio/tax-buckets.test.ts 2>&1 | tail -10
```
Expected: all tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn typecheck 2>&1 | tail -3
```

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add backend/src/portfolio/tax-buckets.ts backend/test/portfolio/tax-buckets.test.ts && git commit -m "feat(portfolio): add tax-buckets classification helpers"
```

---

## Phase 2 — Backend endpoint

### Task 2: `GET /api/portfolio/by-account-type` route + integration test

**Files:**
- Modify: `backend/src/routes/portfolio.ts`
- Create: `backend/test/integration/portfolioByAccountType.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `backend/test/integration/portfolioByAccountType.test.ts`:

```ts
/**
 * Integration tests for GET /api/portfolio/by-account-type.
 *
 * Verifies: bucket grouping by taxStatus, warnings,
 * harvestCandidates with superficial-loss check, household scoping.
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
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-bytax.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let tfsaId: number;
let rrspId: number;
let nrId: number;
let xeqtId: number;
let vtiId: number;
let xbbId: number;
let vooId: number;
let householdId: number;

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
    seedActivity,
    seedDividend,
  } = await import('./portfolioFixtures.js');

  const seeded = await seedHousehold(models, `bytax-${Date.now()}@example.com`);
  householdId = seeded.household.id;

  // Three accounts, three taxStatuses
  const tfsa = await models.Account.create({
    householdId, ownerUserId: seeded.user.id, owner: 'me', visibility: 'shared',
    name: 'TFSA01', accountType: 'investment', defaultCurrency: 'CAD',
    shortCode: 'TFSA01', taxStatus: 'registered_tfsa',
  });
  const rrsp = await models.Account.create({
    householdId, ownerUserId: seeded.user.id, owner: 'me', visibility: 'shared',
    name: 'RRSP01', accountType: 'investment', defaultCurrency: 'CAD',
    shortCode: 'RRSP01', taxStatus: 'registered_rrsp',
  });
  const nr = await models.Account.create({
    householdId, ownerUserId: seeded.user.id, owner: 'me', visibility: 'shared',
    name: 'Margin', accountType: 'investment', defaultCurrency: 'CAD',
    shortCode: 'NR01', taxStatus: 'non_registered',
  });
  tfsaId = tfsa.id;
  rrspId = rrsp.id;
  nrId = nr.id;

  // Securities
  const xeqt = await seedSecurity(models, householdId, 'XEQT.TO', 'iShares', 'ETF', 'CAD');
  const vti = await seedSecurity(models, householdId, 'VTI', 'Vanguard Total', 'ETF', 'USD');
  const xbb = await seedSecurity(models, householdId, 'XBB.TO', 'Cdn Bond', 'BOND', 'CAD');
  const voo = await seedSecurity(models, householdId, 'VOO', 'Vanguard S&P', 'ETF', 'USD');
  xeqtId = xeqt.id;
  vtiId = vti.id;
  xbbId = xbb.id;
  vooId = voo.id;

  // VOO has dividends → triggers us_payer_in_tfsa flag
  await seedDividend(models, { securityId: voo.id, exDividendDate: '2026-03-01', amount: 1.5, currency: 'USD' });

  // Holdings:
  // TFSA: VOO (US payer → us_payer_in_tfsa flag)
  await seedHolding(models, {
    accountId: tfsa.id, householdId, securityId: voo.id,
    statementDate: '2026-05-01', quantity: 10, marketValue: 4500, costBasis: 4000,
  });
  // RRSP: XEQT
  await seedHolding(models, {
    accountId: rrsp.id, householdId, securityId: xeqt.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 3400, costBasis: 3000,
  });
  // Non-reg: VTI (us_withholding) + XBB (fixed_income_in_non_reg, with a big loss for harvest)
  await seedHolding(models, {
    accountId: nr.id, householdId, securityId: vti.id,
    statementDate: '2026-05-01', quantity: 20, marketValue: 5000, costBasis: 4500,
  });
  await seedHolding(models, {
    accountId: nr.id, householdId, securityId: xbb.id,
    statementDate: '2026-05-01', quantity: 100, marketValue: 2500, costBasis: 3500,  // loss = $1000 CAD
  });

  // Recent buy of XBB in RRSP within ±30d → superficial loss warning when XBB is a harvest candidate
  await seedActivity(models, {
    accountId: rrsp.id, householdId, securityId: xbb.id,
    activityType: 'buy', tradeDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
    description: 'Buy XBB', quantity: 10, price: 25, amount: 250, currency: 'CAD',
  });

  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) { try { fs.unlinkSync(dbPath); } catch { /* ignore */ } }
});

test('returns buckets keyed by taxStatus with correct labels', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  assert.equal(res.status, 200);
  const taxStatuses = res.body.buckets.map((b: { taxStatus: string }) => b.taxStatus).sort();
  assert.deepEqual(taxStatuses, ['non_registered', 'registered_rrsp', 'registered_tfsa']);
  const tfsa = res.body.buckets.find((b: { taxStatus: string }) => b.taxStatus === 'registered_tfsa');
  assert.equal(tfsa.label, 'TFSA');
});

test('bucket includes allocationByAssetType + rows + holdingsCount', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const nr = res.body.buckets.find((b: { taxStatus: string }) => b.taxStatus === 'non_registered');
  assert.equal(nr.holdingsCount, 2);
  assert.ok(Array.isArray(nr.allocationByAssetType));
  assert.ok(Array.isArray(nr.rows));
  assert.equal(nr.rows.length, 2);
});

test('warnings include fixed_income_in_non_reg (XBB) + us_payer_in_tfsa (VOO)', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const kinds = res.body.warnings.map((w: { kind: string; symbol: string }) => `${w.kind}:${w.symbol}`).sort();
  assert.ok(kinds.includes('fixed_income_in_non_reg:XBB.TO'), `kinds=${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('us_payer_in_tfsa:VOO'), `kinds=${JSON.stringify(kinds)}`);
});

test('row flags include us_withholding for VTI in non-reg', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const nr = res.body.buckets.find((b: { taxStatus: string }) => b.taxStatus === 'non_registered');
  const vti = nr.rows.find((r: { symbol: string }) => r.symbol === 'VTI');
  assert.ok(vti);
  assert.ok(vti.flags.includes('us_withholding'), `flags=${JSON.stringify(vti.flags)}`);
});

test('harvestCandidates includes XBB with superficialLossWarning=true', async () => {
  const res = await authed.get('/api/portfolio/by-account-type');
  const xbb = res.body.harvestCandidates.find((c: { symbol: string }) => c.symbol === 'XBB.TO');
  assert.ok(xbb, `candidates=${JSON.stringify(res.body.harvestCandidates)}`);
  assert.ok(xbb.unrealizedLossCad > 500);
  assert.equal(xbb.superficialLossWarning, true);
  assert.ok(xbb.superficialLossDetail && xbb.superficialLossDetail.length > 0);
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration --test-name-pattern "returns buckets keyed" 2>&1 | tail -20
```
Expected: FAIL (404).

- [ ] **Step 3: Add the route handler**

Read existing handlers first to identify where to place + what's in scope:
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && grep -nE "^router\\.|loadVisibleLatestHoldings|loadMetricsContext|^import " backend/src/routes/portfolio.ts | head -30
```

Add imports at the top of `backend/src/routes/portfolio.ts`:

```ts
import {
  TAX_STATUS_LABELS,
  TAX_STATUS_ORDER,
  rowFlags,
  harvestCandidate,
  type RowFlag,
} from '../portfolio/tax-buckets';
```

Place the new handler AFTER the existing `/sparklines` handler (or any sibling slot — order doesn't affect routing). Use existing helpers: `visibleAccountWhere`, `loadVisibleLatestHoldings`, `loadMetricsContext`, `latestPricesBySecurity`, `valueHolding`, `n`, `buildUnifiedCadTotal`.

```ts
router.get('/by-account-type', async (req, res, next) => {
  try {
    const accounts = await Account.findAll({
      where: { ...visibleAccountWhere(req), accountType: 'investment' },
      order: [['name', 'ASC']],
    });
    if (accounts.length === 0) {
      res.json({ buckets: [], warnings: [], harvestCandidates: [] });
      return;
    }
    const accountIds = accounts.map((a) => a.id);
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    const { latestHoldings } = await loadVisibleLatestHoldings(req);
    const securityIdsRaw = [...new Set(latestHoldings.map((h) => h.securityId))];

    // Need full Security objects (metadata, currency) for classification
    const securities = await Security.findAll({ where: { id: securityIdsRaw } });
    const securityById = new Map(securities.map((s) => [s.id, s]));

    // Per-security price (for marketValue), then loadMetricsContext for FX
    const prices = await latestPricesBySecurity(securityIdsRaw);
    const currencies = [...new Set(latestHoldings.map((h) => {
      const lp = prices.get(h.securityId);
      return (lp?.currency ?? h.currency) as string;
    }))];
    const metricsCtx = await loadMetricsContext({
      securityIds: securityIdsRaw,
      currencies,
      accountIds,
    });

    // Which securities have dividend events? (powers us_payer_in_tfsa flag)
    const dividendRows = await SecurityDividend.findAll({
      where: { securityId: securityIdsRaw },
      attributes: ['securityId'],
      group: ['securityId'],
    });
    const hasDividendsSet = new Set(dividendRows.map((d) => d.securityId));

    type BucketRow = {
      securityId: number
      symbol: string
      name: string | null
      assetType: string | null
      accountId: number
      accountName: string
      quantity: number
      currency: string
      marketValue: number
      marketValueCad: number | null
      costBasis: number | null
      unrealizedGainCad: number | null
      weightInBucketPct: number | null
      flags: RowFlag[]
    };

    type Bucket = {
      taxStatus: typeof TAX_STATUS_ORDER[number]
      label: string
      accounts: Array<{ id: number; name: string; currency: string }>
      holdingsCount: number
      totalCadMV: number | null
      allocationByAssetType: Array<{ assetType: string | null; marketValueCad: number; percentage: number }>
      rows: BucketRow[]
    };

    const bucketMap = new Map<string, Bucket>();
    for (const acct of accounts) {
      let bucket = bucketMap.get(acct.taxStatus);
      if (!bucket) {
        bucket = {
          taxStatus: acct.taxStatus,
          label: TAX_STATUS_LABELS[acct.taxStatus],
          accounts: [],
          holdingsCount: 0,
          totalCadMV: 0,
          allocationByAssetType: [],
          rows: [],
        };
        bucketMap.set(acct.taxStatus, bucket);
      }
      bucket.accounts.push({
        id: acct.id,
        name: acct.name,
        currency: acct.defaultCurrency ?? 'CAD',
      });
    }

    const warnings: Array<{ kind: RowFlag; securityId: number; symbol: string; accountName: string; text: string }> = [];

    for (const holding of latestHoldings) {
      const security = securityById.get(holding.securityId);
      const account = accountById.get(holding.accountId);
      if (!security || !account) continue;
      const bucket = bucketMap.get(account.taxStatus);
      if (!bucket) continue;

      const latestPrice = prices.get(holding.securityId);
      const { marketValue, currency } = valueHolding(holding, latestPrice);
      const qty = n(holding.quantity) ?? 0;
      const cost = n(holding.costBasis);
      const fxRate = currency === 'CAD' ? 1 : metricsCtx.fxRates.get(currency);
      const marketValueCad = fxRate != null ? marketValue * fxRate : null;
      const costBasisCad = fxRate != null && cost != null ? cost * fxRate : null;
      const unrealizedGainCad =
        marketValueCad != null && costBasisCad != null ? marketValueCad - costBasisCad : null;

      const flags = rowFlags({
        security: {
          symbol: security.symbol,
          currency: security.currency,
          assetType: security.assetType,
          metadata: (security.metadata ?? null) as Record<string, unknown> | null,
        },
        account: { taxStatus: account.taxStatus },
        hasDividends: hasDividendsSet.has(security.id),
      });

      bucket.rows.push({
        securityId: security.id,
        symbol: security.symbol,
        name: security.name,
        assetType: security.assetType,
        accountId: holding.accountId,
        accountName: account.name,
        quantity: qty,
        currency,
        marketValue,
        marketValueCad,
        costBasis: cost,
        unrealizedGainCad,
        weightInBucketPct: null,  // backfilled after bucket total is known
        flags,
      });
      bucket.holdingsCount += 1;

      // Update bucket total
      if (bucket.totalCadMV != null && marketValueCad != null) {
        bucket.totalCadMV += marketValueCad;
      } else {
        bucket.totalCadMV = null;
      }

      // Surface warning entries (not us_withholding — that's a row-flag only, not a top warning).
      for (const flag of flags) {
        if (flag === 'fixed_income_in_non_reg' || flag === 'us_payer_in_tfsa') {
          warnings.push({
            kind: flag,
            securityId: security.id,
            symbol: security.symbol,
            accountName: account.name,
            text:
              flag === 'fixed_income_in_non_reg'
                ? `Fixed income (${security.symbol}) held in non-registered account ${account.name} — consider moving to a registered account.`
                : `US dividend payer (${security.symbol}) held in TFSA ${account.name} — 15% US withholding tax cannot be recovered.`,
          });
        }
      }
    }

    // Backfill weight + allocationByAssetType per bucket
    for (const bucket of bucketMap.values()) {
      if (bucket.totalCadMV != null && bucket.totalCadMV > 0) {
        for (const row of bucket.rows) {
          if (row.marketValueCad != null) {
            row.weightInBucketPct = (row.marketValueCad / bucket.totalCadMV) * 100;
          }
        }
      }
      // Group rows by assetType
      const byAssetType = new Map<string, number>();
      let allocatableTotal = 0;
      for (const row of bucket.rows) {
        if (row.marketValueCad == null) continue;
        const key = row.assetType ?? 'Other';
        byAssetType.set(key, (byAssetType.get(key) ?? 0) + row.marketValueCad);
        allocatableTotal += row.marketValueCad;
      }
      bucket.allocationByAssetType = [...byAssetType.entries()].map(([assetType, marketValueCad]) => ({
        assetType: assetType === 'Other' ? null : assetType,
        marketValueCad,
        percentage: allocatableTotal > 0 ? (marketValueCad / allocatableTotal) * 100 : 0,
      }));
    }

    // Sort buckets by canonical order
    const buckets = TAX_STATUS_ORDER
      .map((status) => bucketMap.get(status))
      .filter((b): b is Bucket => b != null);

    // Harvest candidates from non-reg rows
    const nrBucket = bucketMap.get('non_registered');
    const candidatesRaw = (nrBucket?.rows ?? [])
      .map((row) => {
        const c = harvestCandidate({
          securityId: row.securityId,
          symbol: row.symbol,
          accountId: row.accountId,
          accountName: row.accountName,
          costBasisCad: row.unrealizedGainCad != null && row.marketValueCad != null
            ? row.marketValueCad - row.unrealizedGainCad
            : null,
          marketValueCad: row.marketValueCad,
        });
        if (!c) return null;
        return { row, unrealizedLossCad: c.unrealizedLossCad };
      })
      .filter((x): x is { row: BucketRow; unrealizedLossCad: number } => x != null);

    // Batched superficial-loss check: one query for all candidate securities
    const windowStart = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const windowEnd = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const candidateSecIds = candidatesRaw.map((c) => c.row.securityId);
    const recentBuys = candidateSecIds.length > 0
      ? await InvestmentActivity.findAll({
          where: {
            accountId: accountIds,
            securityId: candidateSecIds,
            activityType: ['buy', 'reinvestment'],
            tradeDate: { [Op.between]: [windowStart, windowEnd] },
          },
          attributes: ['securityId', 'accountId', 'tradeDate'],
        })
      : [];
    const buysBySec = new Map<number, Array<{ accountId: number; tradeDate: string }>>();
    for (const b of recentBuys) {
      const arr = buysBySec.get(b.securityId) ?? [];
      arr.push({ accountId: b.accountId, tradeDate: b.tradeDate });
      buysBySec.set(b.securityId, arr);
    }

    const harvestCandidates = candidatesRaw.map(({ row, unrealizedLossCad }) => {
      const buys = buysBySec.get(row.securityId) ?? [];
      const warningBuys = buys.filter((b) =>
        // Exclude the candidate's own holding's account if you'd want pure cross-account.
        // CRA rule covers same account too, so keep all matches.
        true,
      );
      const superficialLossWarning = warningBuys.length > 0;
      const detail = superficialLossWarning
        ? `Buy/reinvestment in ${warningBuys.map((b) => {
            const acctName = accountById.get(b.accountId)?.name ?? `account ${b.accountId}`;
            return `${acctName} on ${b.tradeDate}`;
          }).join('; ')} within ±30 days of today.`
        : null;
      return {
        securityId: row.securityId,
        symbol: row.symbol,
        accountId: row.accountId,
        accountName: row.accountName,
        unrealizedLossCad,
        superficialLossWarning,
        superficialLossDetail: detail,
      };
    });

    res.json({ buckets, warnings, harvestCandidates });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration --test-name-pattern "buckets keyed|allocationByAssetType|warnings include|us_withholding|harvestCandidates includes XBB" 2>&1 | tail -15
```
Expected: 5/5 pass.

- [ ] **Step 5: Broader regression**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration 2>&1 | grep -E "^ℹ (pass|fail)"
```
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add backend/src/routes/portfolio.ts backend/test/integration/portfolioByAccountType.test.ts && git commit -m "feat(portfolio): add GET /api/portfolio/by-account-type endpoint"
```

---

## Phase 3 — Shared types

### Task 3: Add `PortfolioByAccountType` types

**Files:**
- Modify: `shared/api-types.ts`

- [ ] **Step 1: Append types to `shared/api-types.ts`**

```ts
export type PortfolioByAccountTypeRow = {
  securityId: number
  symbol: string
  name: string | null
  assetType: string | null
  accountId: number
  accountName: string
  quantity: number
  currency: string
  marketValue: number
  marketValueCad: number | null
  costBasis: number | null
  unrealizedGainCad: number | null
  weightInBucketPct: number | null
  flags: Array<'us_withholding' | 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'>
}

export type PortfolioByAccountTypeBucket = {
  taxStatus: 'registered_tfsa' | 'registered_rrsp' | 'registered_fhsa' | 'registered_rrif' | 'non_registered' | 'n_a'
  label: string
  accounts: Array<{ id: number; name: string; currency: string }>
  holdingsCount: number
  totalCadMV: number | null
  allocationByAssetType: Array<{ assetType: string | null; marketValueCad: number; percentage: number }>
  rows: PortfolioByAccountTypeRow[]
}

export type PortfolioByAccountTypeWarning = {
  kind: 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'
  securityId: number
  symbol: string
  accountName: string
  text: string
}

export type PortfolioByAccountTypeHarvestCandidate = {
  securityId: number
  symbol: string
  accountId: number
  accountName: string
  unrealizedLossCad: number
  superficialLossWarning: boolean
  superficialLossDetail: string | null
}

export type PortfolioByAccountType = {
  buckets: PortfolioByAccountTypeBucket[]
  warnings: PortfolioByAccountTypeWarning[]
  harvestCandidates: PortfolioByAccountTypeHarvestCandidate[]
}
```

- [ ] **Step 2: Re-export in `frontend/src/types/api.ts`**

In `frontend/src/types/api.ts`, find the existing `export type { ... } from '@cashflow/shared'` block. Add these names (alphabetized to match file style):

```ts
PortfolioByAccountType,
PortfolioByAccountTypeBucket,
PortfolioByAccountTypeHarvestCandidate,
PortfolioByAccountTypeRow,
PortfolioByAccountTypeWarning,
```

- [ ] **Step 3: Build to verify**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn build 2>&1 | tail -10
```

- [ ] **Step 4: Backend typecheck**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn typecheck 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add shared/api-types.ts frontend/src/types/api.ts && git commit -m "feat(portfolio): add PortfolioByAccountType shared types"
```

---

## Phase 4 — Frontend extraction

### Task 4: Extract `AllocationDonut` to shared component

**Files:**
- Create: `frontend/src/components/ui/allocation-donut.tsx`
- Create: `frontend/src/components/ui/allocation-donut.test.tsx`
- Modify: `frontend/src/pages/PortfolioPage.tsx`

The inline `AllocationDonut` in `PortfolioPage.tsx` (around line 699) needs to become a shared component so slice D's `<BucketCard>` can use the same renderer.

- [ ] **Step 1: Read current implementation**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && sed -n '690,750p' frontend/src/pages/PortfolioPage.tsx
```

Confirm the signature: `function AllocationDonut({ title, slices }: { title: string; slices: DonutSlice[] })` where `DonutSlice = { key, name, value, currency, percentage }`.

- [ ] **Step 2: Create the extracted component**

Create `frontend/src/components/ui/allocation-donut.tsx`. Copy the existing `AllocationDonut` function body verbatim and add the `DonutSlice` type as an export. Also export the `colorFor` helper used by the donut.

```tsx
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Card } from './card'
import { formatMoney } from '../../lib/formatMoney'

export type DonutSlice = {
  key: string
  name: string
  value: number
  currency: string
  percentage: number
}

const CHART_COLORS = [
  'var(--chart-line-1)',
  'var(--chart-line-2)',
  'var(--chart-line-3)',
  'var(--chart-line-4)',
  'var(--chart-line-5)',
  'var(--chart-line-6)',
]

function colorFor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length]
}

export function AllocationDonut({
  title,
  slices,
}: {
  title: string
  slices: DonutSlice[]
}) {
  if (slices.length === 0) {
    return (
      <Card>
        <div className="transactionsPanelHeader">
          <h2>{title}</h2>
        </div>
        <p className="muted">No data.</p>
      </Card>
    )
  }
  return (
    <Card>
      <div className="transactionsPanelHeader">
        <h2 className="text-base">{title}</h2>
      </div>
      <div style={{ width: '100%', height: 240 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={48}
              outerRadius={84}
              paddingAngle={2}
            >
              {slices.map((s, i) => (
                <Cell key={s.key} fill={colorFor(i)} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, _name, ctx) => {
                const v = typeof value === 'number' ? value : Number(value)
                if (!Number.isFinite(v)) return ''
                const slice = (ctx?.payload ?? {}) as DonutSlice
                return [
                  `${formatMoney(v, slice.currency || 'CAD')} (${slice.percentage?.toFixed(1) ?? '0.0'}%)`,
                  slice.name ?? '',
                ]
              }}
            />
            <Legend verticalAlign="bottom" height={36} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}
```

- [ ] **Step 3: Modify `PortfolioPage.tsx` to use the import**

In `frontend/src/pages/PortfolioPage.tsx`:

1. Add import near the other `@/components/ui/...`:
```tsx
import { AllocationDonut, type DonutSlice } from '@/components/ui/allocation-donut'
```

2. Delete the inline `function AllocationDonut(...)` block, the `type DonutSlice = {...}` block, the inline `colorFor` helper, AND the `CHART_COLORS` constant — all are now imported. If `colorFor` is used elsewhere in `PortfolioPage.tsx` (it might be — slice F or earlier used it for sparkline color picks), inspect first:

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && grep -n "colorFor\|CHART_COLORS" frontend/src/pages/PortfolioPage.tsx
```

If `colorFor` IS used outside the inline donut block (e.g., `IncomeMonthlyChart` references it), KEEP the local `colorFor` + `CHART_COLORS` for those callers. Only delete the duplicate that's now in the shared component.

- [ ] **Step 4: Write a smoke test for the extracted component**

Create `frontend/src/components/ui/allocation-donut.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AllocationDonut, type DonutSlice } from './allocation-donut'

describe('AllocationDonut', () => {
  it('renders empty placeholder when slices is empty', () => {
    const { getByText } = render(<AllocationDonut title="By type" slices={[]} />)
    expect(getByText('No data.')).not.toBeNull()
  })

  it('renders pie chart when slices present', () => {
    const slices: DonutSlice[] = [
      { key: 'a', name: 'A (CAD)', value: 500, currency: 'CAD', percentage: 50 },
      { key: 'b', name: 'B (CAD)', value: 500, currency: 'CAD', percentage: 50 },
    ]
    const { container, getByText } = render(<AllocationDonut title="By type" slices={slices} />)
    expect(getByText('By type')).not.toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
```

- [ ] **Step 5: Run tests + build, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/components/ui/allocation-donut.test.tsx 2>&1 | tail -10
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn build 2>&1 | tail -10
```

- [ ] **Step 6: Run existing PortfolioPage tests to verify no regression**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/PortfolioPage.test.tsx 2>&1 | tail -10
```
Expected: all existing PortfolioPage tests still pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/components/ui/allocation-donut.tsx frontend/src/components/ui/allocation-donut.test.tsx frontend/src/pages/PortfolioPage.tsx && git commit -m "refactor(portfolio): extract AllocationDonut to shared component"
```

---

## Phase 5 — Frontend strips (warnings + harvest)

### Task 5: `<TaxWarningsStrip>` + `<HarvestCandidatesStrip>`

**Files:**
- Create: `frontend/src/pages/portfolio-account-type/TaxWarningsStrip.tsx`
- Create: `frontend/src/pages/portfolio-account-type/TaxWarningsStrip.test.tsx`
- Create: `frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.tsx`
- Create: `frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.test.tsx`

- [ ] **Step 1: Write failing tests for both components**

Create `frontend/src/pages/portfolio-account-type/TaxWarningsStrip.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TaxWarningsStrip } from './TaxWarningsStrip'

describe('TaxWarningsStrip', () => {
  it('returns null when warnings is empty', () => {
    const { container } = render(<TaxWarningsStrip warnings={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders one row per warning with text', () => {
    const { getByText } = render(
      <TaxWarningsStrip
        warnings={[
          { kind: 'fixed_income_in_non_reg', securityId: 1, symbol: 'BND', accountName: 'NR', text: 'Bond in NR' },
          { kind: 'us_payer_in_tfsa', securityId: 2, symbol: 'VOO', accountName: 'TFSA01', text: 'US payer in TFSA' },
        ]}
      />,
    )
    expect(getByText('Bond in NR')).not.toBeNull()
    expect(getByText('US payer in TFSA')).not.toBeNull()
  })
})
```

Create `frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { HarvestCandidatesStrip } from './HarvestCandidatesStrip'

describe('HarvestCandidatesStrip', () => {
  it('returns null when candidates empty', () => {
    const { container } = render(<HarvestCandidatesStrip candidates={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders loss amount per candidate', () => {
    const { container, getByText } = render(
      <HarvestCandidatesStrip
        candidates={[
          {
            securityId: 1, symbol: 'BND', accountId: 5, accountName: 'NR',
            unrealizedLossCad: 612.5,
            superficialLossWarning: false, superficialLossDetail: null,
          },
        ]}
      />,
    )
    expect(getByText(/BND/)).not.toBeNull()
    expect(container.textContent).toContain('$612.50')
  })

  it('renders superficial-loss detail when warning is true', () => {
    const { getByText } = render(
      <HarvestCandidatesStrip
        candidates={[
          {
            securityId: 1, symbol: 'BND', accountId: 5, accountName: 'NR',
            unrealizedLossCad: 612.5,
            superficialLossWarning: true,
            superficialLossDetail: 'Buy in RRSP01 on 2026-05-10 within ±30 days of today.',
          },
        ]}
      />,
    )
    expect(getByText(/Superficial loss risk/i)).not.toBeNull()
    expect(getByText(/RRSP01/)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/portfolio-account-type/TaxWarningsStrip.test.tsx src/pages/portfolio-account-type/HarvestCandidatesStrip.test.tsx 2>&1 | tail -10
```

- [ ] **Step 3: Write `TaxWarningsStrip.tsx`**

```tsx
import { Card } from '@/components/ui/card'
import type { PortfolioByAccountTypeWarning } from '../../types/api'

export type TaxWarningsStripProps = {
  warnings: PortfolioByAccountTypeWarning[]
}

export function TaxWarningsStrip({ warnings }: TaxWarningsStripProps) {
  if (warnings.length === 0) return null
  return (
    <Card className="my-3" style={{ borderLeft: '3px solid var(--accent-warm)' }}>
      <ul className="text-sm" style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
        {warnings.map((w, i) => (
          <li key={`${w.kind}-${w.securityId}-${i}`}>
            ⚠️ {w.text}
          </li>
        ))}
      </ul>
    </Card>
  )
}
```

- [ ] **Step 4: Write `HarvestCandidatesStrip.tsx`**

```tsx
import { Card } from '@/components/ui/card'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioByAccountTypeHarvestCandidate } from '../../types/api'

export type HarvestCandidatesStripProps = {
  candidates: PortfolioByAccountTypeHarvestCandidate[]
}

export function HarvestCandidatesStrip({ candidates }: HarvestCandidatesStripProps) {
  if (candidates.length === 0) return null
  return (
    <Card className="my-3">
      <div className="transactionsPanelHeader">
        <h2 className="text-base">Tax-loss harvest candidates</h2>
        <p className="muted">
          Non-registered holdings with unrealized loss greater than $500 CAD.
        </p>
      </div>
      <ul className="text-sm" style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
        {candidates.map((c) => (
          <li key={`${c.securityId}-${c.accountId}`} className="mb-2">
            💰 <strong>{c.symbol}</strong> ({c.accountName}): unrealized loss{' '}
            {formatMoney(c.unrealizedLossCad, 'CAD')}
            {c.superficialLossWarning && (
              <div className="muted" style={{ color: 'var(--accent-warm)', marginLeft: '1.5em' }}>
                ⚠️ Superficial loss risk: {c.superficialLossDetail}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
```

- [ ] **Step 5: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/portfolio-account-type/TaxWarningsStrip.test.tsx src/pages/portfolio-account-type/HarvestCandidatesStrip.test.tsx 2>&1 | tail -10
```
Expected: 5/5 pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/pages/portfolio-account-type/TaxWarningsStrip.tsx frontend/src/pages/portfolio-account-type/TaxWarningsStrip.test.tsx frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.tsx frontend/src/pages/portfolio-account-type/HarvestCandidatesStrip.test.tsx && git commit -m "feat(portfolio): add TaxWarningsStrip + HarvestCandidatesStrip"
```

---

## Phase 6 — Bucket card + breakdown table

### Task 6: `<BucketCard>` + `<BucketBreakdownTable>`

**Files:**
- Create: `frontend/src/pages/portfolio-account-type/BucketCard.tsx`
- Create: `frontend/src/pages/portfolio-account-type/BucketCard.test.tsx`
- Create: `frontend/src/pages/portfolio-account-type/BucketBreakdownTable.tsx`
- Create: `frontend/src/pages/portfolio-account-type/BucketBreakdownTable.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/pages/portfolio-account-type/BucketCard.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BucketCard } from './BucketCard'

const bucket = {
  taxStatus: 'registered_tfsa' as const,
  label: 'TFSA',
  accounts: [{ id: 1, name: 'TFSA01', currency: 'CAD' }],
  holdingsCount: 3,
  totalCadMV: 42300,
  allocationByAssetType: [
    { assetType: 'ETF', marketValueCad: 30000, percentage: 70.9 },
    { assetType: 'BOND', marketValueCad: 12300, percentage: 29.1 },
  ],
  rows: [],
}

describe('BucketCard', () => {
  it('renders label + total + holdings count', () => {
    const { getByText } = render(<BucketCard bucket={bucket} />)
    expect(getByText('TFSA')).not.toBeNull()
    expect(getByText(/\$42,300/)).not.toBeNull()
    expect(getByText(/3 holdings/)).not.toBeNull()
  })

  it('renders donut when allocationByAssetType has slices', () => {
    const { container } = render(<BucketCard bucket={bucket} />)
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('renders dash for null totalCadMV', () => {
    const { getByText } = render(<BucketCard bucket={{ ...bucket, totalCadMV: null }} />)
    expect(getByText('—')).not.toBeNull()
  })
})
```

Create `frontend/src/pages/portfolio-account-type/BucketBreakdownTable.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BucketBreakdownTable } from './BucketBreakdownTable'

const buckets = [
  {
    taxStatus: 'registered_tfsa' as const,
    label: 'TFSA',
    accounts: [{ id: 1, name: 'TFSA01', currency: 'CAD' }],
    holdingsCount: 1,
    totalCadMV: 4500,
    allocationByAssetType: [],
    rows: [
      {
        securityId: 100, symbol: 'VOO', name: 'Vanguard S&P', assetType: 'ETF',
        accountId: 1, accountName: 'TFSA01', quantity: 10, currency: 'USD',
        marketValue: 4500, marketValueCad: 6075,
        costBasis: 4000, unrealizedGainCad: 1500, weightInBucketPct: 100,
        flags: ['us_payer_in_tfsa' as const],
      },
    ],
  },
]

describe('BucketBreakdownTable', () => {
  it('renders one row per holding with bucket label prefix', () => {
    const { getByText, container } = render(<BucketBreakdownTable buckets={buckets} />)
    expect(getByText('VOO')).not.toBeNull()
    expect(getByText('TFSA')).not.toBeNull()
    expect(container.textContent).toContain('us_payer_in_tfsa')
  })

  it('renders empty message when no buckets have rows', () => {
    const { getByText } = render(<BucketBreakdownTable buckets={[]} />)
    expect(getByText(/No holdings/i)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/portfolio-account-type/BucketCard.test.tsx src/pages/portfolio-account-type/BucketBreakdownTable.test.tsx 2>&1 | tail -15
```

- [ ] **Step 3: Write `BucketCard.tsx`**

```tsx
import { AllocationDonut } from '@/components/ui/allocation-donut'
import { Card } from '@/components/ui/card'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioByAccountTypeBucket } from '../../types/api'

export type BucketCardProps = {
  bucket: PortfolioByAccountTypeBucket
}

export function BucketCard({ bucket }: BucketCardProps) {
  const totalLabel =
    bucket.totalCadMV != null ? formatMoney(bucket.totalCadMV, 'CAD') : '—'
  const acctCount = bucket.accounts.length
  return (
    <Card>
      <div className="transactionsPanelHeader">
        <div>
          <h2 className="text-base">{bucket.label}</h2>
          <p className="muted">
            {totalLabel} · {bucket.holdingsCount} holdings · {acctCount}{' '}
            {acctCount === 1 ? 'account' : 'accounts'}
          </p>
        </div>
      </div>
      <AllocationDonut
        title={`Allocation by asset type`}
        slices={bucket.allocationByAssetType.map((row, i) => ({
          key: `${row.assetType ?? 'other'}-${i}`,
          name: row.assetType ?? 'Other',
          value: row.marketValueCad,
          currency: 'CAD',
          percentage: row.percentage,
        }))}
      />
    </Card>
  )
}
```

- [ ] **Step 4: Write `BucketBreakdownTable.tsx`**

```tsx
import { Card } from '@/components/ui/card'
import { EmptyTableRow } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatMoney } from '../../lib/formatMoney'
import type { PortfolioByAccountTypeBucket } from '../../types/api'

export type BucketBreakdownTableProps = {
  buckets: PortfolioByAccountTypeBucket[]
}

export function BucketBreakdownTable({ buckets }: BucketBreakdownTableProps) {
  const allRows = buckets.flatMap((b) =>
    b.rows.map((r) => ({ ...r, bucketLabel: b.label })),
  )
  return (
    <Card className="transactionsTableCard mt-4">
      <div className="transactionsPanelHeader">
        <div>
          <h2>Breakdown</h2>
          <p className="muted">All holdings grouped by bucket label.</p>
        </div>
      </div>
      <div className="transactionsTableWrap">
        <Table className="table transactionsTable">
          <TableHeader>
            <TableRow>
              <TableHead>Bucket</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Symbol</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>MV (CAD)</TableHead>
              <TableHead>Weight</TableHead>
              <TableHead>Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allRows.map((r) => (
              <TableRow key={`${r.bucketLabel}-${r.accountId}-${r.securityId}`}>
                <TableCell>{r.bucketLabel}</TableCell>
                <TableCell>{r.accountName}</TableCell>
                <TableCell>{r.symbol}</TableCell>
                <TableCell>{r.quantity}</TableCell>
                <TableCell>
                  {r.marketValueCad != null ? formatMoney(r.marketValueCad, 'CAD') : '—'}
                </TableCell>
                <TableCell>
                  {r.weightInBucketPct != null
                    ? `${r.weightInBucketPct.toFixed(1)}%`
                    : '—'}
                </TableCell>
                <TableCell style={{ fontSize: '0.75em' }}>
                  {r.flags.length > 0 ? r.flags.join(', ') : '—'}
                </TableCell>
              </TableRow>
            ))}
            {allRows.length === 0 && (
              <EmptyTableRow
                colSpan={7}
                title="No holdings."
                description="Import an investment statement to populate this view."
              />
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}
```

- [ ] **Step 5: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/portfolio-account-type/BucketCard.test.tsx src/pages/portfolio-account-type/BucketBreakdownTable.test.tsx 2>&1 | tail -10
```
Expected: 5/5 pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/pages/portfolio-account-type/BucketCard.tsx frontend/src/pages/portfolio-account-type/BucketCard.test.tsx frontend/src/pages/portfolio-account-type/BucketBreakdownTable.tsx frontend/src/pages/portfolio-account-type/BucketBreakdownTable.test.tsx && git commit -m "feat(portfolio): add BucketCard + BucketBreakdownTable"
```

---

## Phase 7 — Top-level panel

### Task 7: `<AccountTypePanel>`

**Files:**
- Create: `frontend/src/pages/portfolio-account-type/AccountTypePanel.tsx`
- Create: `frontend/src/pages/portfolio-account-type/AccountTypePanel.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `frontend/src/pages/portfolio-account-type/AccountTypePanel.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AccountTypePanel } from './AccountTypePanel'
import * as api from '../../lib/api'

const baseData = {
  buckets: [
    {
      taxStatus: 'registered_tfsa' as const,
      label: 'TFSA',
      accounts: [{ id: 1, name: 'TFSA01', currency: 'CAD' }],
      holdingsCount: 1,
      totalCadMV: 4500,
      allocationByAssetType: [
        { assetType: 'ETF', marketValueCad: 4500, percentage: 100 },
      ],
      rows: [
        {
          securityId: 100, symbol: 'VOO', name: 'Vanguard', assetType: 'ETF',
          accountId: 1, accountName: 'TFSA01', quantity: 10, currency: 'USD',
          marketValue: 4500, marketValueCad: 6075,
          costBasis: 4000, unrealizedGainCad: 2075, weightInBucketPct: 100,
          flags: ['us_payer_in_tfsa' as const],
        },
      ],
    },
  ],
  warnings: [
    { kind: 'us_payer_in_tfsa' as const, securityId: 100, symbol: 'VOO', accountName: 'TFSA01', text: 'US payer in TFSA' },
  ],
  harvestCandidates: [],
}

describe('AccountTypePanel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders bucket cards + warnings strip on happy path', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue(baseData)
    const { findByText } = render(
      <MemoryRouter>
        <AccountTypePanel />
      </MemoryRouter>,
    )
    expect(await findByText('TFSA')).not.toBeNull()
    expect(await findByText(/US payer in TFSA/i)).not.toBeNull()
  })

  it('renders empty state when buckets is empty', async () => {
    vi.spyOn(api, 'getJson').mockResolvedValue({ buckets: [], warnings: [], harvestCandidates: [] })
    const { findByText } = render(
      <MemoryRouter>
        <AccountTypePanel />
      </MemoryRouter>,
    )
    expect(await findByText(/No investment accounts/i)).not.toBeNull()
  })

  it('renders error state when fetch rejects', async () => {
    vi.spyOn(api, 'getJson').mockRejectedValue(new Error('boom'))
    const { findByText } = render(
      <MemoryRouter>
        <AccountTypePanel />
      </MemoryRouter>,
    )
    expect(await findByText(/boom|Could not load/i)).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/portfolio-account-type/AccountTypePanel.test.tsx 2>&1 | tail -10
```

- [ ] **Step 3: Write `AccountTypePanel.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { getJson } from '../../lib/api'
import type { PortfolioByAccountType } from '../../types/api'
import { BucketBreakdownTable } from './BucketBreakdownTable'
import { BucketCard } from './BucketCard'
import { HarvestCandidatesStrip } from './HarvestCandidatesStrip'
import { TaxWarningsStrip } from './TaxWarningsStrip'

export function AccountTypePanel() {
  const [data, setData] = useState<PortfolioByAccountType | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await getJson<PortfolioByAccountType>('/api/portfolio/by-account-type')
      setData(res)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load by-account-type view')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Card><p className="muted">Loading…</p></Card>
  if (err) return <p className="error">{err}</p>
  if (!data) return null

  if (data.buckets.length === 0) {
    return (
      <Card>
        <p className="muted">
          No investment accounts. Add one via the Accounts page and import a statement to see this view.
        </p>
      </Card>
    )
  }

  return (
    <>
      <TaxWarningsStrip warnings={data.warnings} />
      <HarvestCandidatesStrip candidates={data.harvestCandidates} />
      <div className="grid gap-4 lg:grid-cols-2 mt-3">
        {data.buckets.map((b) => (
          <BucketCard key={b.taxStatus} bucket={b} />
        ))}
      </div>
      <BucketBreakdownTable buckets={data.buckets} />
    </>
  )
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/portfolio-account-type/AccountTypePanel.test.tsx 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/pages/portfolio-account-type/AccountTypePanel.tsx frontend/src/pages/portfolio-account-type/AccountTypePanel.test.tsx && git commit -m "feat(portfolio): add AccountTypePanel orchestrator"
```

---

## Phase 8 — Wire the tab

### Task 8: Add `'by-account-type'` tab to PortfolioPage

**Files:**
- Modify: `frontend/src/pages/PortfolioPage.tsx`

- [ ] **Step 1: Add import**

In `frontend/src/pages/PortfolioPage.tsx`, near the other portfolio-sub-page imports:

```tsx
import { AccountTypePanel } from './portfolio-account-type/AccountTypePanel'
```

- [ ] **Step 2: Extend the `TabKey` type**

Find the existing `type TabKey = ...` definition. Add `'by-account-type'`:

```ts
type TabKey = 'holdings' | 'by-security' | 'allocation' | 'by-account-type' | 'income' | 'realized'
```

- [ ] **Step 3: Extend `TAB_ITEMS`**

Find the `const TAB_ITEMS: TabItem[] = [...]` array. Add the new tab between Allocation and Income:

```tsx
const TAB_ITEMS: TabItem[] = [
  { value: 'holdings', label: 'Holdings' },
  { value: 'by-security', label: 'By security' },
  { value: 'allocation', label: 'Allocation' },
  { value: 'by-account-type', label: 'By account type' },
  { value: 'income', label: 'Income' },
  { value: 'realized', label: 'Realized P&L' },
]
```

- [ ] **Step 4: Add the TabPanel**

Find the existing `<TabPanel value="allocation" ...>` block. Add directly after its closing `</TabPanel>`:

```tsx
<TabPanel value="by-account-type" active={activeTab}>
  <AccountTypePanel />
</TabPanel>
```

- [ ] **Step 5: Build + typecheck**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn build 2>&1 | tail -10
```

- [ ] **Step 6: Verify existing tests still pass**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test src/pages/PortfolioPage.test.tsx 2>&1 | tail -10
```

- [ ] **Step 7: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git add frontend/src/pages/PortfolioPage.tsx && git commit -m "feat(portfolio): wire By account type tab into PortfolioPage"
```

---

## Phase 9 — Final verification

### Task 9: Full sweep

- [ ] **Step 1:** Backend unit tests
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test 2>&1 | tail -10
```

- [ ] **Step 2:** Backend integration tests
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn test:integration 2>&1 | tail -10
```

- [ ] **Step 3:** Frontend tests
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn test 2>&1 | tail -10
```

- [ ] **Step 4:** Typechecks + build + lint
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/backend && yarn typecheck 2>&1 | tail -3
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn build 2>&1 | tail -5
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad/frontend && yarn lint 2>&1 | tail -5
```

- [ ] **Step 5:** Git state
```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/relaxed-hopper-6ea4ad && git status && git fetch origin main -q && git log origin/main..HEAD --oneline
```

End with **ALL GREEN — ready for PR** or **BLOCKED — [step]**.

---

## Self-Review

### Spec coverage

| Spec section / AC | Plan task |
|---|---|
| §4.1 New endpoint response shape | Task 2 |
| §4.2 Bucket assembly algorithm | Task 2 |
| §4.3 `tax-buckets.ts` helpers | Task 1 |
| §4.4 Harvest candidate + superficial-loss check | Task 2 (route handler) + Task 1 (helper unit) |
| §4.5 Backend tests | Task 1 (unit) + Task 2 (integration) |
| §5.1 Shared types | Task 3 |
| §5.2 New tab in TAB_ITEMS | Task 8 |
| §5.3 New components | Tasks 5, 6, 7 |
| §5.4 Layout | Tasks 5, 6, 7 (per-component); Task 7 composes |
| §5.5 Empty states | Task 7 (panel) + Task 6 (table empty row) |
| §5.6 Frontend tests | Tasks 5, 6, 7 |
| AC 1–6 (backend) | Task 1 + Task 2 |
| AC 7 (tab inserted) | Task 8 |
| AC 8 (panel composition) | Task 7 |
| AC 9 (empty states) | Task 7 |
| AC 10 (all tests pass) | Task 9 |

Bonus: Task 4 (extract `AllocationDonut`) — not strictly in the spec but enables `<BucketCard>` to reuse the same donut without code duplication. Included as refactor before Task 6.

No spec gaps.

### Placeholder scan

No `TBD`/`TODO`/`implement later`. All code blocks complete. Task 4 step 3's "If `colorFor` IS used outside..." note is a real conditional adjustment, not a placeholder.

### Type consistency

- Backend helpers: `RowFlag = 'us_withholding' | 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'`
- Shared type `PortfolioByAccountTypeRow.flags`: matching union
- Frontend `<TaxWarningsStrip>`: `kind: 'fixed_income_in_non_reg' | 'us_payer_in_tfsa'` (us_withholding is row-flag only, not warning kind — consistent with route handler logic)
- `taxStatus` union: `registered_tfsa | registered_rrsp | registered_fhsa | registered_rrif | non_registered | n_a` — matches model + shared type
- `<HarvestCandidatesStrip>`: `superficialLossWarning: boolean` + `superficialLossDetail: string | null` — matches backend response

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-24-portfolio-tax-buckets.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, hardened worktree protocol.

**2. Inline execution** — Run tasks in this session.

Which?
