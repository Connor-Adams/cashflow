# Partner balance — fold direct transfers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold a partner's direct money transfers into the existing Partner Fairness balance (period-scoped) and remove partner contacts from the People Ledger loan list.

**Architecture:** A pure helper `computePartnerTransferDelta` aggregates partner-tagged transfer rows (`counterpartyContactId ∈ partnerIds AND partnerShare === 0`) into per-currency `{ in, out }`. `buildFairnessByCurrency` and `buildFairnessMonthly` fold `(out − in)` into the balance/netDelta. The `/api/partner/fairness` route computes the delta from rows it already loads. The frontend shows a transfer line and the People Ledger excludes partners.

**Tech Stack:** Express + Sequelize backend (`node:test` via `tsx`), React 19 + Vite frontend (vitest), frontend-local DTO types in `frontend/src/types/api.ts`.

## Global Constraints

- Sign: `out` = money I sent partner (`amount < 0` → `Σ|amount|`) → `+balance`; `in` = money partner sent me (`amount > 0` → `Σ amount`) → `−balance`. New balance term: `+ (out − in)`.
- Row selection for transfers: `counterpartyContactId ∈ partnerContactIds AND partnerShare === 0`. Do NOT exclude non-loan categories here (rent/cash between partners is real settlement money).
- No double-count: shared-split rows (`partnerShare !== 0`) stay in the existing fairness path, untouched.
- Period-scoped: reuse the fairness route's existing `dateFrom`/`dateTo`. No all-time/cumulative balance.
- Money math: plain `number`, matching the existing `partnerFairness.ts` style.
- Dual-dialect Sequelize (SQLite + Postgres); multi-currency (aggregate per `currency`).
- Run commands from the repo root unless a `cd backend` is shown. The worktree has no node_modules — commit with the `PATH=…` prefix shown in each commit step.

---

### Task 1: `computePartnerTransferDelta` + fold into fairness calc

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts`
- Test: `backend/src/summary/partnerFairness.test.ts`

**Interfaces:**
- Produces:
  - `type PartnerTransferTotals = { in: number; out: number }`
  - `function computePartnerTransferDelta(rows: SharedTxnRow[], partnerContactIds: Set<number>): Map<string, PartnerTransferTotals>`
  - `FairnessByCurrency` gains `partnerTransfers: PartnerTransferTotals`
  - `FairnessOptions` gains `partnerTransfersByCurrency?: Map<string, PartnerTransferTotals>`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/summary/partnerFairness.test.ts` (reuse the file's existing `test`/`assert` imports; check the top of the file and add `import { computePartnerTransferDelta } from './partnerFairness'` to the existing import from `./partnerFairness` if helpers are imported there, otherwise add a new import line):

```ts
test('computePartnerTransferDelta splits partner transfers into in/out per currency', () => {
  const rows = [
    { date: '2026-09-01', currency: 'CAD', category: null, merchant: 'Cash received', amount: 2000, myShare: 2000, partnerShare: 0, txnId: 1, ownershipType: 'me', ownershipContactId: null, contactName: null, counterpartyContactId: 7 },
    { date: '2026-09-02', currency: 'CAD', category: null, merchant: 'Cash sent', amount: -500, myShare: -500, partnerShare: 0, txnId: 2, ownershipType: 'me', ownershipContactId: null, contactName: null, counterpartyContactId: 7 },
    { date: '2026-09-03', currency: 'USD', category: null, merchant: 'Cash received', amount: 100, myShare: 100, partnerShare: 0, txnId: 3, ownershipType: 'me', ownershipContactId: null, contactName: null, counterpartyContactId: 7 },
  ];
  const out = computePartnerTransferDelta(rows, new Set([7]));
  assert.deepEqual(out.get('CAD'), { in: 2000, out: 500 });
  assert.deepEqual(out.get('USD'), { in: 100, out: 0 });
});

test('computePartnerTransferDelta excludes shared-split rows, non-partners, and zero amounts', () => {
  const rows = [
    // shared-split row (partnerShare != 0) — excluded
    { date: '2026-09-01', currency: 'CAD', category: 'Groceries', merchant: 'Shared', amount: -100, myShare: -60, partnerShare: -40, txnId: 1, ownershipType: 'me', ownershipContactId: null, contactName: null, counterpartyContactId: 7 },
    // non-partner counterparty — excluded
    { date: '2026-09-02', currency: 'CAD', category: null, merchant: 'Friend', amount: 300, myShare: 300, partnerShare: 0, txnId: 2, ownershipType: 'me', ownershipContactId: null, contactName: null, counterpartyContactId: 9 },
    // null counterparty — excluded
    { date: '2026-09-03', currency: 'CAD', category: null, merchant: 'x', amount: 50, myShare: 50, partnerShare: 0, txnId: 3, ownershipType: 'me', ownershipContactId: null, contactName: null, counterpartyContactId: null },
    // zero amount — skipped
    { date: '2026-09-04', currency: 'CAD', category: null, merchant: 'x', amount: 0, myShare: 0, partnerShare: 0, txnId: 4, ownershipType: 'me', ownershipContactId: null, contactName: null, counterpartyContactId: 7 },
  ];
  const out = computePartnerTransferDelta(rows, new Set([7]));
  assert.equal(out.has('CAD'), false);
});

test('buildFairnessByCurrency folds partner transfers into balance', () => {
  // No shared rows; only a partner transfer-in of 2000 → balance -2000.
  const transfers = new Map([['CAD', { in: 2000, out: 0 }]]);
  const out = buildFairnessByCurrency([], [], '2026-09-01', '2026-10-01', {
    partnerContactIds: new Set([7]),
    partnerTransfersByCurrency: transfers,
  });
  const cad = out.find((c) => c.currency === 'CAD');
  assert.ok(cad, 'expected a CAD entry from transfers-only input');
  assert.equal(cad.balance, -2000);
  assert.deepEqual(cad.partnerTransfers, { in: 2000, out: 0 });
});
```

> The third test references `buildFairnessByCurrency`, already imported/used in this test file. If it is not yet imported, add it to the existing `./partnerFairness` import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: FAIL — `computePartnerTransferDelta` not exported; `partnerTransfers`/`partnerTransfersByCurrency` not on the types.

- [ ] **Step 3: Implement the helper + type changes**

In `backend/src/summary/partnerFairness.ts`:

(a) Add the type + helper (place the type near `SettlementTotals`, and the helper after `classifyInflow`):

```ts
export type PartnerTransferTotals = { in: number; out: number };

/**
 * Per-currency direct partner transfers: money the partner sent me (`in`,
 * amount>0) vs money I sent the partner (`out`, amount<0), over rows where the
 * counterparty is a partner Contact AND partnerShare === 0 (pure transfers;
 * shared-split rows stay in the fairness path to avoid double-counting). Non-loan
 * categories are intentionally NOT excluded — cash between partners is real
 * settlement money.
 */
export function computePartnerTransferDelta(
  rows: SharedTxnRow[],
  partnerContactIds: Set<number>,
): Map<string, PartnerTransferTotals> {
  const out = new Map<string, PartnerTransferTotals>();
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null || !partnerContactIds.has(cid)) continue;
    if (r.partnerShare !== 0) continue;
    const n = r.amount;
    if (!Number.isFinite(n) || n === 0) continue;
    const acc = out.get(r.currency) ?? { in: 0, out: 0 };
    if (n < 0) acc.out += -n;
    else acc.in += n;
    out.set(r.currency, acc);
  }
  return out;
}
```

(b) Add `partnerTransfers` to the `FairnessByCurrency` type (after `nonPartnerInflows`):

```ts
  /** Direct partner transfers folded into balance (in = partner sent me, out = I sent partner). */
  partnerTransfers: PartnerTransferTotals;
```

(c) Add the option field to `FairnessOptions`:

```ts
export type FairnessOptions = {
  partnerContactIds?: Set<number>;
  excludeNonPartnerInflows?: boolean;
  partnerTransfersByCurrency?: Map<string, PartnerTransferTotals>;
};
```

(d) In `buildFairnessByCurrency`, read the transfers, union their currencies, fold into balance, set the field:

After `const excludeNonPartnerInflows = options.excludeNonPartnerInflows ?? false;` add:
```ts
  const partnerTransfers = options.partnerTransfersByCurrency ?? new Map<string, PartnerTransferTotals>();
```

Add `...partnerTransfers.keys(),` to the `allCurrencies` Set construction (alongside the rows/inflows/settlements keys).

Inside the `for (const currency of allCurrencies)` loop, after `const inflowSplit = ...`:
```ts
    const tr = partnerTransfers.get(currency) ?? { in: 0, out: 0 };
```

Change the balance line to add the transfer term:
```ts
    const balance = -partnerShareTotal + (settlement.iPaid - settlement.partnerPaid) + (tr.out - tr.in);
```

Add `partnerTransfers: tr,` to the `byCurrency.set(currency, { ... })` object (after `nonPartnerInflows`).

(e) In `buildFairnessMonthly`, fold transfers into `settlementDelta` per (currency, month). Add this loop AFTER the existing settlements loop (around line 479, before the "Sort by (currency, month)" comment).

The fold is a single `acc.settlementDelta += -n`. This is correct for both directions: a transfer I sent the partner has `n < 0`, so `-n > 0` adds to the delta (iPaid-like, +balance); a transfer the partner sent me has `n > 0`, so `-n < 0` subtracts from the delta (partnerPaid-like, −balance). This matches the `(out − in)` fold in the headline balance.

```ts
  // Partner direct transfers behave like settlements (same (out − in) fold as
  // the headline balance): one `+= -n` handles both directions.
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null || !partnerContactIds.has(cid)) continue;
    if (r.partnerShare !== 0) continue;
    const n = r.amount;
    if (!Number.isFinite(n) || n === 0) continue;
    const month = r.date.slice(0, 7);
    const key = `${r.currency}\0${month}`;
    const acc =
      byKey.get(key) ??
      ({ sharedSpend: 0, myShare: 0, partnerShare: 0, settlementDelta: 0 } satisfies Acc);
    acc.settlementDelta += -n;
    byKey.set(key, acc);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: PASS — all existing + 3 new tests green.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git -C /Users/connoradams/Developer/cashflow/.claude/worktrees/musing-nash-a1af19 \
  commit -am "feat(partner): fold direct partner transfers into fairness balance"
```

---

### Task 2: Route wiring + frontend DTO + integration test

**Files:**
- Modify: `backend/src/routes/partner.ts` (handlers at `/fairness` ~238-251, `/monthly` ~268-275, `/settlement-recommendation` ~290-301)
- Modify: `frontend/src/types/api.ts:536-558` (`PartnerFairnessByCurrency`)
- Test: `backend/test/integration/partner.test.ts`

**Interfaces:**
- Consumes: `computePartnerTransferDelta`, `PartnerTransferTotals` (Task 1).
- Produces: `/api/partner/fairness` `byCurrency[].partnerTransfers`; frontend `PartnerFairnessByCurrency.partnerTransfers`.

- [ ] **Step 1: Add `partnerTransfers` to the frontend DTO**

In `frontend/src/types/api.ts`, in `PartnerFairnessByCurrency` (after `nonPartnerInflows: number` at line 552):
```ts
  /** Direct partner transfers folded into balance (in = partner sent you, out = you sent partner). */
  partnerTransfers: { in: number; out: number }
```

- [ ] **Step 2: Write the failing integration test**

In `backend/test/integration/partner.test.ts`, append:

```ts
test('partner direct transfer nets into fairness balance (period-scoped)', async () => {
  const models = await import('../../src/models');
  const partner = await models.Contact.create({
    householdId: householdAId,
    name: 'Fairness Partner',
    isPartner: true,
  });
  // Partner sent me 2000 in an isolated window; pure transfer (split 'me', partnerShare 0).
  await createTxn({
    householdId: householdAId, accountId: accountAId, date: '2027-03-10',
    amount: 2000, currency: 'CAD', merchantRaw: 'Cash received', txnType: 'transfer',
    finalSplitType: 'me', myShareAmount: 2000, partnerShareAmount: 0,
    counterpartyContactId: partner.id,
  });

  const res = await agentA
    .get('/api/partner/fairness')
    .query({ dateFrom: '2027-03-01', dateTo: '2027-03-31', currency: 'CAD' });
  assert.equal(res.status, 200);
  const cad = (res.body.byCurrency as Array<{
    currency: string;
    balance: number;
    partnerTransfers: { in: number; out: number };
  }>).find((c) => c.currency === 'CAD');
  assert.ok(cad, `expected CAD entry: ${JSON.stringify(res.body.byCurrency)}`);
  assert.deepEqual(cad.partnerTransfers, { in: 2000, out: 0 });
  assert.equal(cad.balance, -2000, 'partner-sent money reduces balance (I owe partner)');
});
```

- [ ] **Step 3: Run the integration test to verify it fails**

Run: `cd backend && yarn tsx --test test/integration/partner.test.ts`
(Needs local Postgres; the harness self-bootstraps a test DB from the default admin URL.)
Expected: FAIL — `cad.partnerTransfers` undefined / route does not compute it.

- [ ] **Step 4: Wire the route**

In `backend/src/routes/partner.ts`:

(a) Add `computePartnerTransferDelta` to the existing import from `../summary/partnerFairness` (the block importing `buildFairnessByCurrency` etc.).

(b) In the `/fairness` handler, after destructuring `{ sharedRows, settlementTotals, partnerContactIds }` and before `buildFairnessByCurrency(...)`:
```ts
    const partnerTransfersByCurrency = computePartnerTransferDelta(sharedRows, partnerContactIds);
```
Pass it in the options object:
```ts
      { partnerContactIds, excludeNonPartnerInflows, partnerTransfersByCurrency },
```

(c) In the `/settlement-recommendation` handler (which also calls `buildFairnessByCurrency`), do the same: compute `partnerTransfersByCurrency` from its `sharedRows`/`partnerContactIds` and add it to that call's options object — so the recommendation reflects transfers.

(d) In the `/monthly` handler, after destructuring `{ sharedRows, monthlySettlements, partnerContactIds }`, the monthly fold reads transfers directly from `sharedRows` inside `buildFairnessMonthly` (Task 1 step 3e), so no extra arg is needed — `buildFairnessMonthly` already receives `partnerContactIds` via options. Leave `/monthly` as-is.

- [ ] **Step 5: Run typecheck + integration to verify pass**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: PASS.

Run: `cd backend && yarn tsx --test test/integration/partner.test.ts`
Expected: PASS — new test green; existing partner tests still green.

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git -C /Users/connoradams/Developer/cashflow/.claude/worktrees/musing-nash-a1af19 \
  commit -am "feat(partner): compute partner-transfer delta in fairness route + DTO"
```

---

### Task 3: Frontend — transfer line + People Ledger partner exclusion

**Files:**
- Modify: `frontend/src/pages/PartnerFairnessPage.tsx` (the per-currency card, near the `partnerInflows` metric ~line 345)
- Modify: `frontend/src/pages/PeopleLedgerPage.tsx` (`ContactLite` ~49; loop ~103; filters ~256, ~383)
- Test: `frontend/src/pages/PartnerFairnessPage.test.tsx`, `frontend/src/pages/PeopleLedgerPage.test.tsx`

**Interfaces:**
- Consumes: `PartnerFairnessByCurrency.partnerTransfers`; `ContactLite.isPartner`.

- [ ] **Step 1: People Ledger — exclude partners (write failing test first)**

In `frontend/src/pages/PeopleLedgerPage.test.tsx`, add a test that a partner contact is not listed. Match the file's existing render/fetch-mock setup (read the top of the test file for its helper); the assertion is:
```ts
// after rendering with a contacts list that includes one isPartner:true contact
expect(queryByText('Fairness Partner')).toBeNull()
```
Seed the mocked `/api/contacts` response to include a contact `{ id, name: 'Fairness Partner', isSelf: false, isPartner: true }` alongside a normal one, and assert the normal one renders while the partner does not.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn workspace frontend run test PeopleLedgerPage`
Expected: FAIL — partner contact still listed.

- [ ] **Step 3: People Ledger — implement exclusion**

In `frontend/src/pages/PeopleLedgerPage.tsx`:

(a) Add `isPartner` to `ContactLite` (after `isSelf: boolean`):
```ts
  isPartner: boolean
```

(b) The summary loop (~line 103): change
```ts
    if (contact.isSelf || !ledger) continue
```
to
```ts
    if (contact.isSelf || contact.isPartner || !ledger) continue
```

(c) The two list filters (~line 256 and ~line 383): change each
```ts
.filter((c) => !c.isSelf)
```
to
```ts
.filter((c) => !c.isSelf && !c.isPartner)
```

- [ ] **Step 4: Run to verify People Ledger passes**

Run: `yarn workspace frontend run test PeopleLedgerPage`
Expected: PASS.

- [ ] **Step 5: Partner Fairness — transfer line (write failing test first)**

In `frontend/src/pages/PartnerFairnessPage.test.tsx`, find the fixture object(s) of type `PartnerFairnessByCurrency` and add `partnerTransfers: { in: 0, out: 0 }` to each (the field is now required). Then add a test rendering a currency card with `partnerTransfers: { in: 8425, out: 0 }` and assert the value shows:
```ts
expect(getByText(/8,425/)).toBeTruthy()
```
(Match the card-rendering harness the existing tests use — read the test file for how it renders a single `PartnerFairnessByCurrency`.)

- [ ] **Step 6: Run to verify it fails**

Run: `yarn workspace frontend run test PartnerFairnessPage`
Expected: FAIL — transfer value not rendered.

- [ ] **Step 7: Partner Fairness — render the transfer line**

In `frontend/src/pages/PartnerFairnessPage.tsx`, near the existing `partnerInflows` metric (~line 345), add a line/metric for direct transfers, mirroring the existing metric component used there. Display both directions when non-zero, e.g.:
```tsx
{(data.partnerTransfers.in > 0 || data.partnerTransfers.out > 0) && (
  <Metric
    label="Direct transfers"
    value={`${formatMoney(data.partnerTransfers.in, cur)} in · ${formatMoney(data.partnerTransfers.out, cur)} out`}
  />
)}
```
> Use whatever metric/label component the surrounding code uses (read lines ~340-350 for the exact component and prop names; the snippet above is the shape, adapt to the real component). The headline balance already nets the transfers — this line is for transparency only.

- [ ] **Step 8: Run to verify Partner Fairness passes**

Run: `yarn workspace frontend run test PartnerFairnessPage`
Expected: PASS.

- [ ] **Step 9: Frontend build (typecheck)**

Run: `yarn workspace frontend run build`
Expected: PASS — no TS errors (confirms `partnerTransfers` added everywhere it's required, incl. any other fixtures).

> If the build reports a missing `partnerTransfers` on another `PartnerFairnessByCurrency` literal, add `partnerTransfers: { in: 0, out: 0 }` there.

- [ ] **Step 10: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH \
  git -C /Users/connoradams/Developer/cashflow/.claude/worktrees/musing-nash-a1af19 \
  commit -am "feat(partner): show direct-transfer line; exclude partners from People Ledger"
```

---

## Final verification

- [ ] Run `yarn ci` from repo root (typecheck, all tests, both builds). Expected: green.

## Self-review notes

- **Spec coverage:** helper + balance fold → Task 1; monthly fold → Task 1 step 3e; route + DTO → Task 2; transfer line + People Ledger exclusion → Task 3. Tests at each layer. All covered.
- **DTO location corrected:** the frontend uses `frontend/src/types/api.ts` (`PartnerFairnessByCurrency`), NOT `@cashflow/shared` — Task 2 step 1 targets the right file.
- **Sign discipline:** every fold is `+= -n` / `+ (out − in)`; verified both branches in Task 1 step 3e resolve to `+= -n`.
- **Type consistency:** `PartnerTransferTotals` / `partnerTransfers: { in, out }` / `partnerTransfersByCurrency` used consistently across helper, types, route, DTO, frontend.
