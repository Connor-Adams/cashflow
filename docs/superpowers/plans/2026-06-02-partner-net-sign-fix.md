# Partner-net sign fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the partner-split Net (Reports page) and the Partner Fairness dashboard show the correct owed-direction — an expense you paid that is the partner's share reads as "partner owes you," not "you owe partner."

**Architecture:** Negate at the interpretation layer only. `partner_share_amount` stays the raw signed spend (purchases negative); the owed-balance is its negation. Two source edits (`partnerMath.rawNetForRow`, `partnerFairness` balance + monthly), aligning both with `queryBuilders.executePartnerBalance`, which already negates. No data migration. Tests that lock the inverted sign are rewritten.

**Tech Stack:** TypeScript, Node `node:test` via `tsx` (backend), Vitest (frontend), Sequelize + Postgres (prod on Railway).

**Spec:** `docs/superpowers/specs/2026-06-02-partner-net-sign-design.md`

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `backend/src/summary/partnerMath.ts` | per-row partner net + settlement adjust | `rawNetForRow` returns `-sumPartner` |
| `backend/src/summary/partnerFairness.ts` | fairness dashboard rollups | `balance` + monthly `netDelta` negate partner-share |
| `backend/test/partnerNet.test.ts` | unit: rawNetForRow / applySettlements | full rewrite to corrected convention |
| `backend/test/partnerFairness.test.ts` | unit: fairness rollups | flip `balance`/`cumulativeBalance`/`netDelta` asserts |
| `backend/test/integration/partner.test.ts` | fairness route | flip balance/direction asserts (per rule) |
| `backend/test/integration/settlements.test.ts` | settlements + resulting balance | flip balance/direction asserts if any (per rule) |
| `frontend/src/pages/PartnerFairnessPage.test.tsx` | fairness page render | optional mock refresh; component logic unchanged |

**Untouched (verified):** `queryBuilders.executePartnerBalance` (already correct), `insights.detectSettlementImbalance` (settlement-only), `backend/test/integration/summary.test.ts` (`/partner` tests assert `settledAmount`/`settlementCount`, sign-independent), frontend partner-split table (no `ReportsPage.test.tsx`).

---

### Task 0: Prep the worktree

**Files:** none (environment).

- [ ] **Step 1: Install deps** (worktree has no `node_modules`; needed for tests + the husky pre-commit hook)

Run: `cd /Users/connoradams/Developer/cashflow/.claude/worktrees/adoring-hermann-59d8a0 && yarn install`
Expected: completes; `node_modules/.bin/tsx`, `vitest`, `lint-staged` present.

- [ ] **Step 2: Baseline the affected unit tests (they currently pass with the WRONG sign)**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/partnerNet.test.ts test/partnerFairness.test.ts`
Expected: PASS (this is the inverted baseline we are about to correct).

---

### Task 1: Fix `rawNetForRow` + rewrite its unit test

**Files:**
- Modify: `backend/src/summary/partnerMath.ts:42-45`
- Test: `backend/test/partnerNet.test.ts` (full rewrite)

- [ ] **Step 1: Rewrite `backend/test/partnerNet.test.ts` to the corrected convention**

Replace the ENTIRE file with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettlements,
  rawNetForRow,
  type RawPartnerRow,
  type SettlementSummary,
} from '../src/summary/partnerMath';

function makeRow(over: Partial<RawPartnerRow> = {}): RawPartnerRow {
  return {
    currency: 'CAD',
    ownershipType: 'me',
    ownershipContactId: null,
    contactName: null,
    sumMy: 0,
    sumPartner: 0,
    ...over,
  };
}

// Single-payer model: I (the uploader) always pay. Spend is stored NEGATIVE
// (purchase amount < 0), so partner_share_amount is negative for a purchase the
// partner shares. "What the partner owes me" is the NEGATION of the signed
// partner-share sum: net = -sumPartner.
//   - purchase the partner shares (sumPartner < 0)      → net > 0 → partner owes me
//   - refund/inflow partly theirs (sumPartner > 0)      → net < 0 → I owe partner
// sumMy is my own portion and never enters the net.

test('rawNetForRow: purchase the partner shares (sumPartner<0) → partner owes me', () => {
  assert.equal(rawNetForRow(makeRow({ sumMy: -10_991.53, sumPartner: -250 })), 250);
});

test('rawNetForRow: refund/inflow partly theirs (sumPartner>0) → I owe partner', () => {
  assert.equal(rawNetForRow(makeRow({ sumMy: 0, sumPartner: 250 })), -250);
});

test('rawNetForRow: ownershipType is irrelevant under single-payer', () => {
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'me', sumPartner: -100 })), 100);
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'partner', sumPartner: -100 })), 100);
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'shared', sumPartner: -100 })), 100);
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'contact', ownershipContactId: 1, sumPartner: -100 })), 100);
});

test('rawNetForRow: zero / null sumPartner → 0', () => {
  assert.equal(rawNetForRow(makeRow({ sumPartner: 0 })), 0);
  assert.equal(rawNetForRow(makeRow({ sumPartner: null })), 0);
});

// applySettlements: only contact-tagged rows match a settlement (settlements carry a contactId).
// Settlement signs: iPaid raises net (I paid partner → they owe me more);
//                   partnerPaid lowers net (partner paid me → they owe me less).

test('applySettlements: contact row + I paid partner → net rises', () => {
  // Partner's share = -100 (purchase) → partner owes me 100. I paid them 30 → they owe me 130.
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 30, partnerPaid: 0 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 30);
  assert.equal(adj.net, 130);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: contact row + partner paid me → net falls', () => {
  // Partner owes me 100. They paid me 40 → they now owe me 60.
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 40 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, -40);
  assert.equal(adj.net, 60);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: settled to exactly zero is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 100 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.net, 0);
  assert.equal(adj.direction, 'even');
});

test('applySettlements: me-owned row gets no settlement (no contactId)', () => {
  const rows = [makeRow({ sumMy: -10_991.53, sumPartner: -7_273.64 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 999, partnerPaid: 0 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 7_273.64);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.settlementCount, 0);
  assert.equal(adj.net, 7_273.64);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: orphan settlement with no matching row does NOT create a new row', () => {
  const adjusted = applySettlements([], [{ contactId: 1, currency: 'CAD', iPaid: 25, partnerPaid: 0 }]);
  assert.equal(adjusted.length, 0);
});

test('applySettlements: settlement in a different currency does not adjust the row', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'USD', iPaid: 50, partnerPaid: 0 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.net, 100);
  assert.equal(adj.settlementCount, 0);
});

test('applySettlements: both settlement directions on same key collapse via signed sum', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 0 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 80, partnerPaid: 30 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 0);
  assert.equal(adj.settledAmount, 50);
  assert.equal(adj.net, 50);
  assert.equal(adj.direction, 'partner_owes_me');
  assert.equal(adj.settlementCount, 2);
});

test('applySettlements: sub-cent diff is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -0.001 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 0.005 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.direction, 'even');
});

// Regression: the 2026-05-22 screenshot scenario, re-derived under the corrected
// sign. A me-owned row with partner=-$7,273.64 is purchase-dominated: the
// partner's share of spend I paid → partner owes me $7,273.64.
test('regression: me-owned purchase-dominated row → partner owes me', () => {
  const rows = [makeRow({ sumMy: -10_991.53, sumPartner: -7_273.64 })];
  const [adj] = applySettlements(rows, []);
  assert.equal(adj.rawNet, 7_273.64);
  assert.equal(adj.net, 7_273.64);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: rollup across multiple rows sums -sumPartner totals', () => {
  const rows = [
    makeRow({ ownershipType: 'me', sumMy: -1_000, sumPartner: -250 }),
    makeRow({ ownershipType: 'shared', sumMy: -500, sumPartner: -500 }),
    makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumMy: 0, sumPartner: 100 }),
  ];
  const adjusted = applySettlements(rows, []);
  const rollup = adjusted.reduce((sum, r) => sum + r.net, 0);
  // 250 (their share of my-tagged purchase) + 500 (their half of shared purchase)
  //   − 100 (refund/inflow partly theirs → I owe them) = 650.
  assert.equal(rollup, 650);
});
```

- [ ] **Step 2: Run the test — verify it FAILS against current code**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/partnerNet.test.ts`
Expected: FAIL — e.g. `rawNetForRow ... → partner owes me` expects `250` but receives `-250`.

- [ ] **Step 3: Fix `backend/src/summary/partnerMath.ts`**

Replace the body of `rawNetForRow` (lines 42-45):

```ts
export function rawNetForRow(r: RawPartnerRow): number {
  // What the partner owes me = the NEGATION of their signed share-sum. Spend is
  // stored negative, so a partner share of a purchase I paid (negative) means the
  // partner owes me that amount (positive); a positive partner share (refund/inflow
  // partly theirs) means I owe them. Mirrors queryBuilders.executePartnerBalance.
  const partner = r.sumPartner ?? 0;
  return partner === 0 ? 0 : -partner;
}
```

Also update the function's doc-comment above it (lines 30-41) so the prose says *net = −sumPartner* instead of *net = sumPartner*. Leave `applySettlements`, `directionFromNet`, and the types unchanged.

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/partnerNet.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerMath.ts backend/test/partnerNet.test.ts
git commit -m "fix(partner-net): net = -sumPartner so partner-owed expenses read 'partner owes you'"
```

---

### Task 2: Fix `partnerFairness` balance + monthly + update its unit test

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts:389` (balance), `:489` (netDelta)
- Test: `backend/test/partnerFairness.test.ts` (targeted edits)

- [ ] **Step 1: Update the failing assertions in `backend/test/partnerFairness.test.ts`**

Apply these exact edits (spend totals and inflow fields stay; only the owed-balance values flip):

**F1 — test "single shared purchase produces partner_owes_me balance" (~L115-135):** delete the long confused comment block (L117-133) and set:
```ts
  // partnerShare sum = -50 (a purchase I paid). balance = -partnerShareTotal = 50 → partner owes me.
  assert.equal(cad.partnerShareTotal, -50);
  assert.equal(cad.balance, 50);
  assert.equal(cad.direction, 'partner_owes_me');
```

**F2 — test "settlement i_paid_partner raises balance" (~L137-147):**
```ts
  // balance = -partnerShareTotal(-50) + (iPaid 80 - partnerPaid 0) = 50 + 80 = 130
  assert.equal(cad.balance, 130);
  assert.equal(cad.direction, 'partner_owes_me');
```

**F3 — test "cumulativeBalance accumulates ..." (~L247-248):**
```ts
  assert.equal(apr.cumulativeBalance, 50);
  assert.equal(may.cumulativeBalance, 150);
```

**F4 — test "settlements modify cumulativeBalance" (~L257-262):**
```ts
  assert.equal(apr.cumulativeBalance, 50);
  const may = result.find((p) => p.month === '2026-05')!;
  assert.equal(may.settlementDelta, 70);
  assert.equal(may.netDelta, 70);
  assert.equal(may.cumulativeBalance, 120);
```

**F5 — test "multi-currency cumulatives ..." (~L275-277):**
```ts
  assert.equal(cadApr.cumulativeBalance, 50);
  assert.equal(cadMay.cumulativeBalance, 150);
  assert.equal(usdApr.cumulativeBalance, 40);
```

**F6 — test "excludeNonPartnerInflows drops non-partner inflow rows from totals" (~L463-464):** keep `partnerShareTotal`/`sharedSpendTotal`/inflow asserts; change only balance:
```ts
  // Balance reflects the cleaned set: -partnerShareTotal(150) + 0 settlements = -150.
  assert.equal(cad.balance, -150);
```

**F7 — test "excludeNonPartnerInflows drops non-partner rows from monthly trend" (~L547,L551):** keep the `partnerShare` asserts; change cumulatives:
```ts
  assert.equal(apr.cumulativeBalance, -250);
  ...
  assert.equal(may.cumulativeBalance, -200);
```

Leave unchanged: all `buildSettlementRecommendation` tests (they pass `balance` directly), `aggregateCategoryBreakdown`, `topLargestShared`, `paidMore`, `currentMonthSharedSpend`, inflow-classification, and the sub-cent "even" test.

- [ ] **Step 2: Run the test — verify it FAILS against current code**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/partnerFairness.test.ts`
Expected: FAIL on the F1–F7 assertions (e.g. balance expected `50`, received `-50`).

- [ ] **Step 3: Fix `backend/src/summary/partnerFairness.ts`**

Line 389 — `buildFairnessByCurrency`:
```ts
    const balance = -partnerShareTotal + (settlement.iPaid - settlement.partnerPaid);
```
Line 489 — `buildFairnessMonthly`:
```ts
    const netDelta = -acc.partnerShare + acc.settlementDelta;
```
Update the `balance`/`netDelta` doc-comments (the `FairnessByCurrency.balance` jsdoc ~L130-134 and the `FairnessMonthlyPoint.netDelta` jsdoc ~L156-157) to say the owed-balance is `−partnerShare(+settlements)`. Leave `youCovered`, `partnerCovered`, spend totals, inflow tallies, and `directionFromBalance` unchanged.

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/partnerFairness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/test/partnerFairness.test.ts
git commit -m "fix(partner-fairness): owed balance = -partnerShare so dashboard direction matches"
```

---

### Task 3: Update integration tests to the corrected convention

**Files:**
- Test: `backend/test/integration/partner.test.ts`
- Test: `backend/test/integration/settlements.test.ts`

These hit the real routes over a seeded DB (purchases stored negative), so every asserted owed-balance flips. **Deterministic rule for each failing assertion:**

- `net` / `balance` / `netBalance` / `cumulativeBalance` / `netDelta` derived from partner shares → **negate** (purchase-seeded values flip sign).
- `direction`: `i_owe_partner` ↔ `partner_owes_me` for purchase-derived spend; `even`/`settled` stay.
- **Unchanged:** `settledAmount`, `settlementCount`, `iPaid`/`partnerPaid`, `sharedSpendTotal`, `partnerShareTotal`, `myShareTotal`, `partnerInflows`, `nonPartnerInflows`, category/largest breakdowns.

- [ ] **Step 1: Run `partner.test.ts`, fix each failure per the rule**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/integration/partner.test.ts`
For each failing assertion (clusters near lines 198, 216, 349, 389–400, 437–487, 653–693): read the reported "actual," confirm it matches the rule above (it is the corrected owed value/direction), and set the expectation to it. Do **not** blindly accept an actual that contradicts the rule — if one does, stop and investigate.
Re-run until PASS.

- [ ] **Step 2: Run `settlements.test.ts`, fix each failure per the rule**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/integration/settlements.test.ts`
Apply the same rule to any balance/direction assertions (clusters near lines 60–111, 143, 165). Settlement CRUD assertions (status codes, stored amount/direction) are unchanged.
Re-run until PASS.

- [ ] **Step 3: Confirm `summary.test.ts` still passes unchanged**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/integration/summary.test.ts`
Expected: PASS with no edits (its `/partner` tests assert `settledAmount`/`settlementCount`).

- [ ] **Step 4: Commit**

```bash
git add backend/test/integration/partner.test.ts backend/test/integration/settlements.test.ts
git commit -m "test(partner): update integration expectations to corrected owed-balance sign"
```

---

### Task 4: Full verification + optional frontend mock refresh

**Files:**
- (optional) `frontend/src/pages/PartnerFairnessPage.test.tsx`

- [ ] **Step 1: Backend typecheck**

Run: `cd backend && yarn typecheck`
Expected: no errors.

- [ ] **Step 2: Full backend suite (unit + integration)**

Run: `cd backend && yarn test && yarn test:integration`
Expected: PASS. If any other test seeded partner data and asserted a balance/direction, fix it with the Task 3 rule and amend.

- [ ] **Step 3: Frontend suite**

Run: `cd frontend && yarn test`
Expected: PASS. `PartnerFairnessPage.test.tsx` mocks the API and renders the `direction` it is given, so it is unaffected.

- [ ] **Step 4 (optional hygiene): refresh the frontend mock to realistic post-fix data**

In `PartnerFairnessPage.test.tsx`, the `FAIRNESS_PAYLOAD` (balance `-400`, direction `i_owe_partner`) is now an unrealistic pairing for all-purchase shares. If refreshing: set `balance: 400`, `direction: 'partner_owes_me'`, and change the "renders the running-balance stat" test (L131-139) to assert `'Partner owes you'`; update `MONTHLY_PAYLOAD` cumulatives to `+100`/`+400` and `RECOMMENDATION_PAYLOAD` to `partner_pays_you` / `outstandingBalance: 400`. Keep one test exercising the `i_owe_partner` render path with a refund-dominated mock (positive partnerShare). Re-run `cd frontend && yarn test`.

- [ ] **Step 5: Commit (if Step 4 done)**

```bash
git add frontend/src/pages/PartnerFairnessPage.test.tsx
git commit -m "test(partner-fairness): refresh page mock to post-fix owed-balance sign"
```

---

### Task 5: PR + auto-merge

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin claude/adoring-hermann-59d8a0
gh pr create --title "fix(partner-net): correct owed-balance sign (partner-owed expenses read 'partner owes you')" \
  --body "Fixes the partner-split Net and Partner Fairness dashboard showing the owed-direction backwards for expenses you paid on a partner's behalf. Root cause + design: docs/superpowers/specs/2026-06-02-partner-net-sign-design.md. Aligns both with queryBuilders.executePartnerBalance (already correct). No data migration."
```

- [ ] **Step 2: Enable auto-merge (merge commit, per Connor's policy)**

```bash
gh pr merge --auto --merge
```
If it errors with auto-merge disabled: `gh api -X PATCH repos/Connor-Adams/cashflow -f allow_auto_merge=true` then retry.

---

### Task 6: Prod data correction (AFTER merge + Railway redeploy)

**Manual ops step — not code.** Run only once the PR is merged and the `backend` service has redeployed on Railway (else the balance shows backwards until deploy). Connector: `railway run --service Postgres -- bash -lc 'psql "${DATABASE_PUBLIC_URL:-$DATABASE_URL}" -f <file>'`.

- [ ] **Step 1: Re-flip Dad's two transactions to "his share"** (guarded; exactly 2 rows)

```sql
\set ON_ERROR_STOP on
BEGIN;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM transactions WHERE ownership_contact_id = 3;
  IF n <> 2 THEN RAISE EXCEPTION 'ABORT: expected 2 rows for contact 3, found %', n; END IF;
END $$;
UPDATE transactions
   SET split_override='partner', final_split_type='partner',
       my_share_amount=0, partner_share_amount=amount, updated_at=now()
 WHERE ownership_contact_id = 3;
SELECT id, merchant_clean, final_split_type, my_share_amount, partner_share_amount
  FROM transactions WHERE ownership_contact_id = 3 ORDER BY id;
COMMIT;
```
Expected: `UPDATE 2`; both rows `final_split_type=partner`, `partner_share_amount` = the (negative) amount.

- [ ] **Step 2: Record the NORTHVUE squared-up settlement**

First fetch the household scope + confirm columns:
```sql
SELECT DISTINCT household_id FROM transactions WHERE ownership_contact_id = 3;  -- expect one value (call it :hh)
\d partner_settlements
```
Then insert (substitute `:hh`; if `household_id` is NULL on those rows, use NULL):
```sql
\set ON_ERROR_STOP on
INSERT INTO partner_settlements
  (household_id, contact_id, currency, direction, amount, settled_date, created_at, updated_at)
VALUES
  (:hh, 3, 'CAD', 'partner_paid_me', 11198.30, '2024-11-21', now(), now());
```

- [ ] **Step 3: Verify the resulting balance**

```sql
-- Replicates /api/summary/partner for contact 3, all-time:
SELECT
  -SUM(partner_share_amount)                                            AS raw_net,
  -SUM(partner_share_amount)
    + COALESCE((SELECT SUM(CASE direction WHEN 'i_paid_partner' THEN amount
                                          WHEN 'partner_paid_me' THEN -amount END)
                FROM partner_settlements WHERE contact_id=3 AND currency='CAD'), 0) AS net
FROM transactions WHERE ownership_contact_id=3 AND currency='CAD';
```
Expected: `raw_net = 11838.86`, `net = 640.56` (positive → "Dad owes you $640.56").

- [ ] **Step 4: Confirm in-app** — open the Reports partner-split page (and Partner Fairness): Dad's row reads **+$640.56 "partner owes you."**

**Rollback** (transactions): the pre-image restore is in the spec / `/tmp/cf_dad_ROLLBACK.sql`; to undo the settlement: `DELETE FROM partner_settlements WHERE contact_id=3 AND currency='CAD' AND amount=11198.30 AND settled_date='2024-11-21';`

---

## Self-review

- **Spec coverage:** rawNetForRow negate (T1), fairness balance+monthly negate (T2), unit tests rewritten (T1/T2), integration tests (T3), summary/frontend confirmed unaffected (T3/T4), data correction incl. settlement (T6) — all spec sections mapped.
- **Placeholders:** none — source edits and unit-test content are exact; integration updates are a deterministic rule + commands + line clusters (existing-test expectation updates verified against the rule).
- **Type/name consistency:** `rawNetForRow`, `applySettlements`, `buildFairnessByCurrency`, `buildFairnessMonthly`, `balance`, `netDelta`, `partnerShareTotal` match the source files; settlement signs (`iPaid`−`partnerPaid`) consistent across `partnerMath`, `partnerFairness`, and the verification SQL.
