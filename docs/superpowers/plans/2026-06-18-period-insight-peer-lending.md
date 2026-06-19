# Period-Insight peer-lending figures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface period-scoped peer lending (money lent to / received back from contacts) as two separate figures in the dashboard `PeriodInsightBand`, sourced from contact-linked transfers instead of the empty `reimbursements` table.

**Architecture:** A pure helper `computePeerLending` aggregates the period window's contact-linked transactions into per-currency `{ lent, received }`, excluding partner contacts and non-loan categories. The existing `/api/summary/period-insight` route calls it over rows it already loads and attaches `peerLending` to each currency in the response DTO. `PeriodInsightBand` renders the two figures. Reimbursable `owedBack` / `realCost` logic is untouched.

**Tech Stack:** Express + Sequelize backend (`node:test` via `tsx`), React 19 + Vite frontend (vitest), shared DTO in `shared/api-types.ts`.

## Global Constraints

- Dual-dialect Sequelize (SQLite + Postgres) — write queries that run on both.
- Multi-currency throughout; aggregate per `currency`.
- Money math: plain `number` accumulation, matching the existing `computeOwedBack` style in the same file.
- `lent` = Σ |amount| for `amount < 0`; `received` = Σ amount for `amount > 0`.
- Exclusions: `counterpartyContactId == null` rows skipped; partner contacts (`is_partner = true`) skipped; `isNonLoanCategory(finalCategory)` rows skipped.
- Period-scoped only — no all-time stock, no cross-period comparison.
- Run all commands from the repo root unless a `cd backend` is shown.

---

### Task 1: `computePeerLending` pure helper

**Files:**
- Modify: `backend/src/summary/periodInsight.ts`
- Test: `backend/src/summary/periodInsight.test.ts`

**Interfaces:**
- Consumes: `isNonLoanCategory` from `../contacts/transferLedger`.
- Produces:
  - `type PeerLendingRow = { currency: string; amount: string | number; counterpartyContactId?: number | null; finalCategory?: string | null }`
  - `type PeerLendingTotals = { lent: number; received: number }`
  - `function computePeerLending(rows: PeerLendingRow[], partnerContactIds: ReadonlySet<number>): Map<string, PeerLendingTotals>`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/summary/periodInsight.test.ts` (keep existing imports; add the named import if the file does not already import from `./periodInsight`):

```ts
import { computePeerLending } from './periodInsight';

test('computePeerLending splits non-partner transfers into lent/received per currency', () => {
  const out = computePeerLending(
    [
      { currency: 'CAD', amount: '-500.0000', counterpartyContactId: 1, finalCategory: null },
      { currency: 'CAD', amount: '200.0000', counterpartyContactId: 1, finalCategory: null },
      { currency: 'USD', amount: '-50.0000', counterpartyContactId: 2, finalCategory: null },
    ],
    new Set<number>(),
  );
  assert.deepEqual(out.get('CAD'), { lent: 500, received: 200 });
  assert.deepEqual(out.get('USD'), { lent: 50, received: 0 });
});

test('computePeerLending excludes partner contacts', () => {
  const out = computePeerLending(
    [{ currency: 'CAD', amount: '-1000.0000', counterpartyContactId: 7, finalCategory: null }],
    new Set<number>([7]),
  );
  assert.equal(out.has('CAD'), false);
});

test('computePeerLending excludes non-loan categories and null counterparties', () => {
  const out = computePeerLending(
    [
      { currency: 'CAD', amount: '-300.0000', counterpartyContactId: 1, finalCategory: 'Rent' },
      { currency: 'CAD', amount: '-40.0000', counterpartyContactId: null, finalCategory: null },
      { currency: 'CAD', amount: '0', counterpartyContactId: 1, finalCategory: null },
    ],
    new Set<number>(),
  );
  assert.equal(out.has('CAD'), false);
});
```

> If `periodInsight.test.ts` does not already have `import test from 'node:test'` / `import assert from 'node:assert/strict'`, add them at the top (match the style of the file's existing tests).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts`
Expected: FAIL — `computePeerLending is not a function` / not exported.

- [ ] **Step 3: Implement the helper**

In `backend/src/summary/periodInsight.ts`, add the import at the top (below the existing `import { num } from '../util/numbers';`):

```ts
import { isNonLoanCategory } from '../contacts/transferLedger';
```

Append at the end of the file:

```ts
export type PeerLendingRow = {
  currency: string;
  amount: string | number;
  counterpartyContactId?: number | null;
  finalCategory?: string | null;
};

export type PeerLendingTotals = { lent: number; received: number };

/**
 * Per-currency peer-lending split for one window: money LENT (amount<0) vs
 * RECEIVED back (amount>0) on contact-linked transfers. Skips rows with no
 * counterparty, transfers to/from partner contacts (shared-life money, not
 * loans), and non-loan categories (rent/household). Period-scoped: caller
 * passes only the window's rows.
 */
export function computePeerLending(
  rows: PeerLendingRow[],
  partnerContactIds: ReadonlySet<number>,
): Map<string, PeerLendingTotals> {
  const out = new Map<string, PeerLendingTotals>();
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null) continue;
    if (partnerContactIds.has(cid)) continue;
    if (isNonLoanCategory(r.finalCategory)) continue;
    const n = Number(r.amount);
    if (!Number.isFinite(n) || n === 0) continue;
    const acc = out.get(r.currency) ?? { lent: 0, received: 0 };
    if (n < 0) acc.lent += -n;
    else acc.received += n;
    out.set(r.currency, acc);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/periodInsight.test.ts`
Expected: PASS — all existing + 3 new tests green.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git -C /Users/connoradams/Developer/cashflow/.claude/worktrees/musing-nash-a1af19 \
  commit -am "feat(summary): computePeerLending helper for period peer-lending split"
```

---

### Task 2: DTO + `/period-insight` route wiring

**Files:**
- Modify: `shared/api-types.ts:1799-1809` (`PeriodInsightCurrency`)
- Modify: `backend/src/routes/summary.ts` (`PeriodRow` type ~line 205-210, `loadPeriodRows` select ~line 229-247, handler assembly ~line 352-369)
- Test: `backend/test/integration/periodInsight.test.ts`

**Interfaces:**
- Consumes: `computePeerLending` (Task 1); `Contact`, `householdWhere` (already imported in `summary.ts`).
- Produces: `PeriodInsightCurrency.peerLending: { lent: number; received: number }` in the API response.

- [ ] **Step 1: Add `peerLending` to the DTO**

In `shared/api-types.ts`, edit `PeriodInsightCurrency` (lines 1799-1809) to add the field after `owedBackBreakdown`:

```ts
export type PeriodInsightCurrency = {
  currency: string;
  netSpend: number;
  realCost: number; // netSpend - owedBack
  owedBack: number;
  owedBackBreakdown: { reimbursable: number; partnerShare: number };
  peerLending: { lent: number; received: number };
  totalSpend: number;
  totalCredits: number;
  totalIncome: number;
  totalPayments: number;
};
```

- [ ] **Step 2: Write the failing integration test**

In `backend/test/integration/periodInsight.test.ts`:

(a) Add `counterpartyContactId` to the `TxnSeed` type (after `txnType?: string;`):

```ts
  counterpartyContactId?: number | null;
```

(b) Add it to the `Transaction.create` call inside `createTxn` (after `linkedTransactionId: null,`):

```ts
    counterpartyContactId: seed.counterpartyContactId ?? null,
```

(c) Append this test at the end of the file:

```ts
test('peerLending splits non-partner transfers, excludes partners + non-loan categories', async () => {
  const models = await import('../../src/models');
  const friend = await models.Contact.create({ householdId: householdAId, name: 'Lend Friend' });
  const partner = await models.Contact.create({
    householdId: householdAId,
    name: 'Lend Partner',
    isPartner: true,
  });

  // Non-partner: lent 500, received 200 back (both inside the window).
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-05',
    amount: -500, currency: 'CAD', merchantRaw: 'Cash sent', txnType: 'transfer',
    counterpartyContactId: friend.id,
  });
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-12',
    amount: 200, currency: 'CAD', merchantRaw: 'Cash received', txnType: 'transfer',
    counterpartyContactId: friend.id,
  });
  // Partner transfer — excluded.
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-08',
    amount: -1000, currency: 'CAD', merchantRaw: 'Cash sent', txnType: 'transfer',
    counterpartyContactId: partner.id,
  });
  // Non-loan category (rent) to the friend — excluded.
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2026-08-09',
    amount: -300, currency: 'CAD', merchantRaw: 'Rent', finalCategory: 'rent',
    txnType: 'transfer', counterpartyContactId: friend.id,
  });

  const res = await agentA
    .get('/api/summary/period-insight')
    .query({ currency: 'CAD', dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    peerLending: { lent: number; received: number };
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad, `expected CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  assert.equal(cad.peerLending.lent, 500, 'only the non-partner, non-rent send counts');
  assert.equal(cad.peerLending.received, 200);
});
```

- [ ] **Step 3: Run the integration test to verify it fails**

Run: `cd backend && yarn workspace cashflow-backend run test:integration`
(Requires Postgres + `TEST_DATABASE_URL`.)
Expected: FAIL — new test errors (`cad.peerLending` undefined) and/or backend typecheck fails because `peerLending` is missing from the assembled object.

- [ ] **Step 4: Wire the route**

In `backend/src/routes/summary.ts`:

(a) Import the helper — add `computePeerLending` to the existing import from `../summary/periodInsight` (the block that currently imports `computeOwedBack, realCostOf`):

```ts
import {
  computeOwedBack,
  realCostOf,
  computePeerLending,
} from '../summary/periodInsight';
```

(b) Add `counterpartyContactId` to the `PeriodRow` type (the inline `& { ... }` near line 205-210):

```ts
type PeriodRow = SummaryTxnRow &
  OwedBackRow & {
    accountId: number;
    partnerShareAmount: string | null;
    accountType?: string | null;
    counterpartyContactId: number | null;
  };
```

(c) Add `'counterpartyContactId'` to the `loadPeriodRows` `attributes` array (near line 229-247), after `'linkedTransactionId',`:

```ts
      'linkedTransactionId',
      'counterpartyContactId',
```

(d) In the `/period-insight` handler, after `const owed = computeOwedBack(mainRows, reimbursableByTxn);` (line 352), add partner-id load + lending compute:

```ts
    const partnerContacts = await Contact.findAll({
      where: householdWhere(req),
      attributes: ['id', 'isPartner'],
      raw: true,
    });
    const partnerContactIds = new Set<number>(
      (partnerContacts as Array<{ id: number; isPartner: boolean | number }>)
        .filter((c) => Boolean(c.isPartner))
        .map((c) => c.id),
    );
    const lending = computePeerLending(mainRows, partnerContactIds);
```

(e) In the `byCurrency.push({ ... })` assembly (line 358-368), add the field after `owedBackBreakdown`:

```ts
        owedBackBreakdown: { reimbursable: o.reimbursable, partnerShare: o.partnerShare },
        peerLending: lending.get(cur) ?? { lent: 0, received: 0 },
```

- [ ] **Step 5: Run typecheck + integration test to verify pass**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS (no type errors).

Run: `cd backend && yarn workspace cashflow-backend run test:integration`
Expected: PASS — new `peerLending` test green; existing period-insight tests still green.

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git -C /Users/connoradams/Developer/cashflow/.claude/worktrees/musing-nash-a1af19 \
  commit -am "feat(summary): expose peerLending in /period-insight DTO + route"
```

---

### Task 3: `PeriodInsightBand` lent/received figures

**Files:**
- Modify: `frontend/src/components/dashboard/PeriodInsightBand.tsx`
- Modify: `frontend/src/components/dashboard/PeriodInsightBand.test.tsx`
- Modify (fixtures): any `PeriodInsightCurrency` object literal in `frontend/src/pages/DashboardPage.tsx` (the DTO now requires `peerLending`)

**Interfaces:**
- Consumes: `data.peerLending.lent`, `data.peerLending.received` from `PeriodInsightCurrency` (Task 2).

- [ ] **Step 1: Update test fixtures + write failing tests**

In `frontend/src/components/dashboard/PeriodInsightBand.test.tsx`, add `peerLending` to the `base` fixture (after `owedBackBreakdown`):

```ts
  owedBackBreakdown: { reimbursable: 4000, partnerShare: 0 },
  peerLending: { lent: 0, received: 0 },
```

Add two tests inside the `describe` block:

```ts
  it('shows lent-out and received-back figures when peerLending > 0', () => {
    const { getByText } = render(
      <PeriodInsightBand
        data={{ ...base, peerLending: { lent: 2500, received: 800 } }}
        currency="CAD"
      />,
    )
    expect(getByText('Lent out')).toBeTruthy()
    expect(getByText('$2,500.00')).toBeTruthy()
    expect(getByText('Received back')).toBeTruthy()
    expect(getByText('$800.00')).toBeTruthy()
  })

  it('hides lent/received figures when peerLending is zero', () => {
    const { queryByText } = render(<PeriodInsightBand data={base} currency="CAD" />)
    expect(queryByText('Lent out')).toBeNull()
    expect(queryByText('Received back')).toBeNull()
  })
```

- [ ] **Step 2: Run the frontend test to verify it fails**

Run: `yarn workspace frontend run test PeriodInsightBand`
Expected: FAIL — "Lent out" / "Received back" not found.

- [ ] **Step 3: Render the figures**

In `frontend/src/components/dashboard/PeriodInsightBand.tsx`, insert this block immediately after the closing `</div>` of the "Real-spend headline + loaned split" block (after line 62, before the `<hr ... />`):

```tsx
      {(data.peerLending.lent > 0 || data.peerLending.received > 0) && (
        <div className="flex flex-wrap gap-3">
          {data.peerLending.lent > 0 && (
            <div className="flex flex-col gap-1 rounded-md bg-negative-bg p-3">
              <span className="text-xs text-muted-foreground">Lent out</span>
              <span className="text-xl font-semibold tabular-nums text-negative">
                {money(data.peerLending.lent)}
              </span>
            </div>
          )}
          {data.peerLending.received > 0 && (
            <div className="flex flex-col gap-1 rounded-md bg-success-bg p-3">
              <span className="text-xs text-muted-foreground">Received back</span>
              <span className="text-xl font-semibold tabular-nums text-positive">
                {money(data.peerLending.received)}
              </span>
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 4: Run the frontend test to verify it passes**

Run: `yarn workspace frontend run test PeriodInsightBand`
Expected: PASS — all existing + 2 new tests green.

- [ ] **Step 5: Fix any other `PeriodInsightCurrency` literals**

Run: `grep -rn "owedBackBreakdown" frontend/src --include=*.ts --include=*.tsx`
For every object literal that builds a `PeriodInsightCurrency` (e.g. a default/fallback in `DashboardPage.tsx`) and does NOT yet set `peerLending`, add `peerLending: { lent: 0, received: 0 },`. Then typecheck:

Run: `yarn workspace frontend run build`
Expected: PASS — no TS errors about missing `peerLending`.

> If the grep shows no literals beyond the test fixture and the component itself, this step is a no-op confirmation.

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git -C /Users/connoradams/Developer/cashflow/.claude/worktrees/musing-nash-a1af19 \
  commit -am "feat(dashboard): show period lent-out / received-back figures"
```

---

## Final verification

- [ ] Run `yarn ci` from repo root (typecheck, all tests, both production builds). Expected: green.

## Self-review notes

- **Spec coverage:** data source/filters → Task 1 helper; partner exclusion → Task 1 + Task 2 partner-id load; DTO + route → Task 2; two-figure display + period-scoped → Task 3; reimbursable `owedBack`/`realCost` untouched → no task modifies them. Tests: unit (Task 1), route (Task 2), frontend (Task 3). All covered.
- **Flagged risk resolved:** `loadPeriodRows` selects `finalCategory` but NOT `counterpartyContactId` — Task 2 step 4(c) adds it.
- **Type consistency:** `computePeerLending(rows, partnerContactIds)` and `peerLending: { lent, received }` used identically across backend helper, route, DTO, and frontend.
