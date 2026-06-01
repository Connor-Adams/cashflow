# Fix business_amount Sign Bug + Business/Personal Income+Spend Tiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `business_amount` sign double-flip that makes business spend render negative, then split the dashboard "Business vs personal" tile into separate Income and Spend tiles.

**Architecture:** Part 1 is a one-line fix in `splitTxnByItems` (the no-linked-items branch re-applies a sign to an already-signed value). Part 2 peels `txnType='income'` out of the per-business credit bucket into a new `income` field and renders two tiles via a new pure frontend helper. Scope is confined to `netSpendByBusiness` and its single consumer.

**Tech Stack:** TypeScript. Backend tests: `node:test` + `node:assert/strict` run via `tsx`. Frontend: React + Vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-business-personal-income-spend-split-design.md`

**Note on commits:** the pre-commit hook (`lint-staged`) is not installed in this environment and aborts commits. Run lint/typecheck explicitly (steps below) and commit with `--no-verify`.

---

### Task 1: Fix the business_amount sign double-flip (Part 1)

**Files:**
- Test: `backend/test/aggregateDashboard.test.ts` (create — no test exists for this aggregator)
- Modify: `backend/src/import/splitTxnByItems.ts:91`

- [ ] **Step 1: Write the failing regression test**

Create `backend/test/aggregateDashboard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateDashboard,
  type SummaryTxnRow,
  type AccountRow,
} from '../src/summary/aggregateDashboard';
import type { ItemAllocationContext } from '../src/summary/loadItemAllocations';

function row(o: Partial<SummaryTxnRow>): SummaryTxnRow {
  return {
    id: 1,
    accountId: 1,
    date: '2026-05-10',
    currency: 'CAD',
    finalCategory: 'Shopping',
    finalBusiness: true,
    finalSplitType: 'me',
    merchantRaw: 'M',
    merchantClean: 'M',
    merchantCanonical: 'M',
    amount: '-100.00',
    reviewFlag: false,
    txnType: 'purchase',
    businessAmount: '0',
    ...o,
  };
}

const accounts = new Map<number, AccountRow>([
  [1, { id: 1, name: 'A', shortCode: null, accountType: 'chequing' }],
]);

// An itemContext with empty maps forces splitTxnByItems down the no-linked-items
// branch, which is the path that reads txn.businessAmount (the prod scenario:
// all business rows have signed business_amount and no order links).
const emptyCtx: ItemAllocationContext = {
  linksByTxn: new Map(),
  ordersById: new Map(),
  itemsByOrder: new Map(),
};

const biz = (out: ReturnType<typeof aggregateDashboard>, b: boolean) =>
  out.netSpendByBusiness.get(`CAD\0${b ? '1' : '0'}`) ?? null;

test('no-item business expense (signed business_amount) counts as business SPEND, not a credit', () => {
  const out = aggregateDashboard(
    [row({ amount: '-100.00', businessAmount: '-100.00' })],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b, 'business bucket should exist');
  assert.equal(b.totalSpend, 100);
  assert.equal(b.totalCredits, 0);
  assert.equal(b.netSpend, 100);
  // personal must NOT be inflated by the flipped half
  assert.equal(biz(out, false), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/aggregateDashboard.test.ts`
Expected: FAIL — pre-fix the business bucket has `totalCredits=100, netSpend=-100` and a personal bucket with `totalSpend=200`.

- [ ] **Step 3: Apply the fix**

In `backend/src/import/splitTxnByItems.ts`, the `usable.length === 0` branch (~line 91), change:

```ts
        businessAmount: bizAmt === 0 ? 0 : bizAmt * sign,
```

to:

```ts
        businessAmount: bizAmt,
```

`bizAmt` (= `n(txn.businessAmount)`) is already signed to match `amount`; the `* sign` was double-applying it. Positive rows (`sign = +1`) are unchanged; only negative rows are corrected.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/aggregateDashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite to confirm no regressions**

Run: `cd backend && npm test`
Expected: all pass (the itemized path is unchanged; `insights`/`budgets`/`aggregateMonthly` read only `alloc.amount`).

- [ ] **Step 6: Commit**

```bash
git add backend/src/import/splitTxnByItems.ts backend/test/aggregateDashboard.test.ts
git commit --no-verify -m "fix(dashboard): business_amount sign double-flip miscounted business expenses as credits"
```

---

### Task 2: Add income bucket to the per-business aggregate (Part 2 backend)

**Files:**
- Modify: `backend/src/summary/aggregateDashboard.ts` (type ~108, initializer ~418, loop ~425-429)
- Test: `backend/test/aggregateDashboard.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/aggregateDashboard.test.ts`:

```ts
test('business income (txnType=income) lands in income bucket, not netSpend', () => {
  const out = aggregateDashboard(
    [row({ amount: '500.00', txnType: 'income', businessAmount: '500.00' })],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b);
  assert.equal(b.income, 500);
  assert.equal(b.totalCredits, 0);
  assert.equal(b.totalSpend, 0);
  assert.equal(b.netSpend, 0);
});

test('refund (positive, non-income) nets against spend, not income', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-100.00', businessAmount: '-100.00', txnType: 'purchase' }),
      row({ id: 2, amount: '30.00', businessAmount: '30.00', txnType: 'refund' }),
    ],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b);
  assert.equal(b.totalSpend, 100);
  assert.equal(b.totalCredits, 30);
  assert.equal(b.netSpend, 70);
  assert.equal(b.income, 0);
});

test('refund exceeding spend yields negative netSpend with zero income', () => {
  const out = aggregateDashboard(
    [
      row({ id: 1, amount: '-50.00', businessAmount: '-50.00', txnType: 'purchase' }),
      row({ id: 2, amount: '80.00', businessAmount: '80.00', txnType: 'refund' }),
    ],
    accounts,
    emptyCtx,
  );
  const b = biz(out, true);
  assert.ok(b);
  assert.equal(b.netSpend, -30);
  assert.equal(b.income, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/aggregateDashboard.test.ts`
Expected: FAIL — `b.income` is `undefined` (field does not exist yet).

- [ ] **Step 3: Add the `income` field to the type**

In `backend/src/summary/aggregateDashboard.ts`, the `netSpendByBusiness` map value type (~line 108-117), add `income`:

```ts
  netSpendByBusiness: Map<
    string,
    {
      currency: string;
      business: boolean;
      totalSpend: number;
      totalCredits: number;
      netSpend: number;
      income: number;
    }
  >;
```

- [ ] **Step 4: Add `income: 0` to the bucket initializer**

In the per-business loop (~line 418), the bucket default:

```ts
        const business = netSpendByBusiness.get(businessKey) ?? {
          currency,
          business: isBiz,
          totalSpend: 0,
          totalCredits: 0,
          netSpend: 0,
          income: 0,
        };
```

- [ ] **Step 5: Peel income out of the credit branch**

In the same loop (~line 425-430), change:

```ts
        if (part < 0 && !nonSpend) {
          business.totalSpend += -part;
        } else if (part > 0) {
          business.totalCredits += part;
        }
        business.netSpend = business.totalSpend - business.totalCredits;
```

to:

```ts
        if (part < 0 && !nonSpend) {
          business.totalSpend += -part;
        } else if (part > 0) {
          if (row.txnType === 'income') {
            business.income += part;
          } else {
            business.totalCredits += part;
          }
        }
        business.netSpend = business.totalSpend - business.totalCredits;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/aggregateDashboard.test.ts`
Expected: PASS (all five tests).

- [ ] **Step 7: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/summary/aggregateDashboard.ts backend/test/aggregateDashboard.test.ts
git commit --no-verify -m "feat(dashboard): track business/personal income separately from offset credits"
```

---

### Task 3: Frontend pure helper `businessIncomeSpend` (Part 2 frontend logic)

**Files:**
- Create: `frontend/src/lib/businessIncomeSpend.ts`
- Test: `frontend/src/lib/businessIncomeSpend.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/businessIncomeSpend.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { businessIncomeSpend, type BusinessIncomeSpendRow } from './businessIncomeSpend'

const r = (o: Partial<BusinessIncomeSpendRow>): BusinessIncomeSpendRow => ({
  currency: 'CAD',
  business: false,
  totalSpend: 0,
  totalCredits: 0,
  netSpend: 0,
  income: 0,
  ...o,
})

describe('businessIncomeSpend', () => {
  it('splits income and spend by business flag', () => {
    const out = businessIncomeSpend(
      [
        r({ business: true, netSpend: 3100, income: 8200 }),
        r({ business: false, netSpend: 4800, income: 5400 }),
      ],
      'CAD',
    )
    expect(out.income).toEqual({ business: 8200, personal: 5400 })
    expect(out.spend).toEqual({ business: 3100, personal: 4800 })
    expect(Math.round(out.incomeShare)).toBe(60)
    expect(Math.round(out.spendShare)).toBe(39)
  })

  it('filters by currency', () => {
    const out = businessIncomeSpend(
      [
        r({ currency: 'CAD', business: true, netSpend: 100, income: 0 }),
        r({ currency: 'USD', business: true, netSpend: 999, income: 0 }),
      ],
      'CAD',
    )
    expect(out.spend.business).toBe(100)
  })

  it('clamps share to 0 when business spend is negative', () => {
    const out = businessIncomeSpend(
      [
        r({ business: true, netSpend: -30 }),
        r({ business: false, netSpend: 100 }),
      ],
      'CAD',
    )
    expect(out.spendShare).toBe(0)
  })

  it('returns zero shares for empty input', () => {
    const out = businessIncomeSpend([], 'CAD')
    expect(out.income).toEqual({ business: 0, personal: 0 })
    expect(out.spend).toEqual({ business: 0, personal: 0 })
    expect(out.incomeShare).toBe(0)
    expect(out.spendShare).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/businessIncomeSpend.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/lib/businessIncomeSpend.ts`:

```ts
/**
 * Split the dashboard's per-business rows into Income vs Spend, each broken out
 * by business/personal, with business-share percentages for the tile bars.
 *
 * `netSpend` is the Spend value (gross outflows minus offset credits — income
 * is excluded by the backend aggregate). `income` is true earned income
 * (txnType='income'). Shares are clamped to [0, 100] and guard divide-by-zero.
 */
export type BusinessIncomeSpendRow = {
  currency: string
  business: boolean
  totalSpend: number
  totalCredits: number
  netSpend: number
  income: number
}

export type BusinessIncomeSpend = {
  income: { business: number; personal: number }
  spend: { business: number; personal: number }
  incomeShare: number
  spendShare: number
}

function businessShare(business: number, personal: number): number {
  const total = business + personal
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (business / total) * 100))
}

export function businessIncomeSpend(
  rows: BusinessIncomeSpendRow[],
  currency: string,
): BusinessIncomeSpend {
  let bizIncome = 0
  let perIncome = 0
  let bizSpend = 0
  let perSpend = 0
  for (const row of rows) {
    if (currency && row.currency !== currency) continue
    if (row.business) {
      bizIncome += row.income
      bizSpend += row.netSpend
    } else {
      perIncome += row.income
      perSpend += row.netSpend
    }
  }
  return {
    income: { business: bizIncome, personal: perIncome },
    spend: { business: bizSpend, personal: perSpend },
    incomeShare: businessShare(bizIncome, perIncome),
    spendShare: businessShare(bizSpend, perSpend),
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run src/lib/businessIncomeSpend.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/businessIncomeSpend.ts frontend/src/lib/businessIncomeSpend.test.ts
git commit --no-verify -m "feat(dashboard): businessIncomeSpend helper for income/spend split"
```

---

### Task 4: Render two tiles in DashboardPage

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx` — `BusinessReportRow` type (~86-92), `businessReportData` + `businessSpotlight` memos (~542-605), the "Business vs personal" `<BentoTile>` (~1212-1300).

- [ ] **Step 1: Add `income` to the `BusinessReportRow` type**

`frontend/src/pages/DashboardPage.tsx` (~line 86):

```ts
type BusinessReportRow = {
  currency: string
  business: boolean
  totalSpend: number
  totalCredits: number
  netSpend: number
  income: number
}
```

- [ ] **Step 2: Import the helper**

Near the existing `rankByNetSpend` import (~line 39):

```ts
import { businessIncomeSpend } from '../lib/businessIncomeSpend'
```

- [ ] **Step 3: Replace the two memos with one helper call**

Delete the `businessReportData` memo (~542-570) and the `businessSpotlight` memo (~572-605). Replace with:

```ts
  const bizSplit = useMemo(
    () => businessIncomeSpend(data?.netSpendByBusiness ?? [], currency),
    [data?.netSpendByBusiness, currency]
  )
```

- [ ] **Step 4: Replace the single tile with two tiles**

Replace the entire `<BentoTile label="Business vs personal" ...>...</BentoTile>` block (~1212-1300) with:

```tsx
        <BentoTile
          label="Income · business vs personal"
          description="Earned income split by business vs personal."
        >
          <div className="businessSpotlightGrid">
            {([
              ['Business', bizSplit.income.business, 'business'] as const,
              ['Personal', bizSplit.income.personal, 'personal'] as const,
            ]).map(([label, value, tone]) => (
              <article key={label} className={`businessFocusCard businessFocusCard--${tone}`}>
                <p className="businessFocusLabel">{label}</p>
                <p className="businessFocusValue">{formatDashboardAmount(value)}</p>
              </article>
            ))}
          </div>
          <div className="businessSharePanel">
            <div className="businessShareLabels" aria-hidden="true">
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                Business {bizSplit.incomeShare.toFixed(0)}%
              </span>
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                Personal {(100 - bizSplit.incomeShare).toFixed(0)}%
              </span>
            </div>
            <div
              className="businessShareBar"
              role="img"
              aria-label={`Business ${bizSplit.incomeShare.toFixed(0)} percent of income`}
            >
              <span
                className="businessShareFill businessShareFill--business"
                style={{ width: `${bizSplit.incomeShare}%` }}
              />
              <span
                className="businessShareFill businessShareFill--personal"
                style={{ width: `${100 - bizSplit.incomeShare}%` }}
              />
            </div>
            {bizSplit.income.business === 0 && bizSplit.income.personal === 0 && (
              <p className="muted businessShareCaption">No income in current filters.</p>
            )}
          </div>
        </BentoTile>

        <BentoTile
          label="Spend · business vs personal"
          description="Spend (gross outflows net of refunds) split by business vs personal."
        >
          <div className="businessSpotlightGrid">
            {([
              ['Business', bizSplit.spend.business, 'business'] as const,
              ['Personal', bizSplit.spend.personal, 'personal'] as const,
            ]).map(([label, value, tone]) => (
              <article key={label} className={`businessFocusCard businessFocusCard--${tone}`}>
                <p className="businessFocusLabel">{label}</p>
                <p className="businessFocusValue">{formatDashboardAmount(value)}</p>
              </article>
            ))}
          </div>
          <div className="businessSharePanel">
            <div className="businessShareLabels" aria-hidden="true">
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                Business {bizSplit.spendShare.toFixed(0)}%
              </span>
              <span className="font-semibold" style={{ color: 'var(--foreground)' }}>
                Personal {(100 - bizSplit.spendShare).toFixed(0)}%
              </span>
            </div>
            <div
              className="businessShareBar"
              role="img"
              aria-label={`Business ${bizSplit.spendShare.toFixed(0)} percent of spend`}
            >
              <span
                className="businessShareFill businessShareFill--business"
                style={{ width: `${bizSplit.spendShare}%` }}
              />
              <span
                className="businessShareFill businessShareFill--personal"
                style={{ width: `${100 - bizSplit.spendShare}%` }}
              />
            </div>
          </div>
        </BentoTile>
```

- [ ] **Step 5: Verify no dangling references**

Run: `cd frontend && grep -n "businessSpotlight\|businessReportData" src/pages/DashboardPage.tsx`
Expected: no matches (both memos fully removed).

- [ ] **Step 6: Typecheck, lint, and run the frontend test suite**

Run: `cd frontend && npx tsc -b && npx vitest run && yarn lint`
Expected: no type errors, all tests pass, no new lint errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/DashboardPage.tsx
git commit --no-verify -m "feat(dashboard): render separate business/personal Income and Spend tiles"
```

---

### Task 5: Full verification

- [ ] **Step 1: Backend — full suite + typecheck**

Run: `cd backend && npm test && npm run typecheck`
Expected: all pass, no type errors.

- [ ] **Step 2: Frontend — tests + types + lint**

Run: `cd frontend && npx vitest run && npx tsc -b && yarn lint`
Expected: all pass.

- [ ] **Step 3: Prod sanity check (read-only) after deploy**

After this is deployed, re-run the per-business aggregate check against prod to confirm the business tile now reads positive spend (~+$10,288) with $0 income:

```bash
PGURL=$(railway variables --service Postgres --json | python3 -c "import sys,json;print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])")
psql "$PGURL" -P pager=off -c "SELECT (amount<0) amt_neg, COUNT(*) n, ROUND(SUM(amount)::numeric,2) sum_amt FROM transactions WHERE final_business=true GROUP BY 1;"
```

Expected: confirms the 48 business rows are all expenses; the dashboard Spend tile should now show business ≈ +$10,288, Income tile $0.

---

## Self-Review

- **Spec coverage:** Part 1 fix → Task 1. Income bucket (type/init/loop) → Task 2. API passthrough → automatic (`Array.from(values)`, covered by Task 2's shape). Frontend helper → Task 3. Two tiles + type + memo replacement → Task 4. Tests (backend regression + income cases, frontend helper) → Tasks 1-3. Edge cases (negative spend, empty income, currency) → Task 3 tests. Verification → Task 5.
- **Type consistency:** `BusinessIncomeSpendRow`/`BusinessReportRow` both carry `income: number`; backend map value type carries `income: number`; helper returns `{ income, spend, incomeShare, spendShare }` consumed verbatim in Task 4.
- **No placeholders:** all steps contain runnable code and exact commands.
