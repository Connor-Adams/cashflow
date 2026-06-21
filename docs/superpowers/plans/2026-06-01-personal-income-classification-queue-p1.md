# Personal Income Classification Queue — P1 (Backend Wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real payroll + corp→personal distributions into the *baseline* Personal T1 (and corp T2 + shareholder-loan balance) via a per-transfer `taxTreatment` field on `Transaction`, plus the API to set it and the queue to surface unclassified items.

**Architecture:** Approach 1 (treatment on the transfer pair). One nullable `taxTreatment` column on `Transaction` is the single source of truth. `buildPersonalFacts` and `buildCorpFacts` each derive their own view; the shareholder-loan balance derives from loan-tagged transfers. No new primitive, no new table. Spec: `docs/superpowers/specs/2026-06-01-personal-income-classification-queue-design.md`.

**Tech Stack:** TypeScript, Express, Sequelize (postgres prod / sqlite test), `node:test` + `node:assert/strict` via `tsx`.

**Run tests (single file):**
```bash
cd backend && npx tsx --import ./test/setup.ts --test test/tax/<file>.test.ts
```

**Scope:** This is P1 only (backend). P2 (queue UI) and P3 (auto-suggest/bulk) are separate plans.

**`taxTreatment` vocabulary (final):** `eligible_dividend`, `non_eligible_dividend`, `salary`, `loan_advance`, `loan_repayment`, `employment_income`, `not_income`. `null` = unclassified.

**Routing summary (the contract every task must honor):**

| treatment | personal T1 (`buildPersonalFacts`) | corp T2 (`buildCorpFacts`) | loan balance |
|---|---|---|---|
| `salary`, `employment_income` | → `employmentIncome[]` (L10100) | `salary` → `salaryPaid` | — |
| `eligible_dividend` | → `eligibleDividends[]` (L12000) | → `dividendsPaid` kind `eligible` | — |
| `non_eligible_dividend` | → `nonEligibleDividends[]` (L12010) | → `dividendsPaid` kind `non_eligible` | — |
| `loan_advance` | ignored | ignored | **+** |
| `loan_repayment` | ignored | ignored | **−** |
| `not_income` | ignored | ignored | — |

**No-double-count guard:** in `buildPersonalFacts`, a row with non-null `taxTreatment` is routed by the treatment branch and `continue`s — it never reaches the `finalCategory` routing. Pre-existing `finalCategory='employment_income'` rows (treatment null) still count. A corp salary deposit auto-tagged `txnType='income'` but classified `taxTreatment='salary'` therefore counts exactly once.

---

## File Structure

- **Modify** `backend/src/transactions/types.ts` — add `TAX_TREATMENTS` const, `TaxTreatment` type, `isTaxTreatment` guard (single source of truth for the enum, imported by model + routes).
- **Modify** `backend/src/models/Transaction.ts` — add `taxTreatment` field (declare + init attribute, column `tax_treatment`).
- **Create** `backend/src/migrations/20260601000000-transactions-tax-treatment.js` — `addColumn`/`removeColumn`.
- **Modify** `backend/src/tax/builders/buildPersonalFacts.ts` — hoist dividend arrays; add treatment-first routing in the txn loop.
- **Modify** `backend/src/tax/builders/buildCorpFacts.ts` — derive `dividendsPaid` (correct kind) + `salaryPaid` from classified corp-side txns.
- **Create** `backend/src/tax/services/shareholderLoanBalance.ts` — `computeShareholderLoanBalance(corpEntityId)`.
- **Modify** `backend/src/routes/transfers.ts` — add `PATCH /:id/tax-treatment` (sets the pair, or a single unlinked row).
- **Modify** `backend/src/routes/tax.ts` — add `GET /classification-queue`.
- **Tests:** `backend/test/tax/taxTreatment-personal.test.ts`, `taxTreatment-corp.test.ts`, `shareholderLoanBalance.test.ts`, `backend/test/tax/routes-tax-treatment.test.ts`, `backend/test/tax/routes-classification-queue.test.ts`.

---

### Task 1: `taxTreatment` enum + `Transaction` column + migration

**Files:**
- Modify: `backend/src/transactions/types.ts`
- Modify: `backend/src/models/Transaction.ts:44-45` (declare) and the `init` attributes block
- Create: `backend/src/migrations/20260601000000-transactions-tax-treatment.js`
- Test: `backend/test/tax/taxTreatment-personal.test.ts` (field round-trip lives here; reused in Task 2)

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/taxTreatment-personal.test.ts`:

```typescript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Account, Entity, Household, Transaction } from '../../src/models';

async function seedPersonal() {
  const household = await Household.create({ name: 'TT' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'personal', legalName: 'P',
    jurisdiction: 'CA-ON', fiscalYearEnd: null,
  } as never);
  const account = await Account.create({
    name: 'Chq', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('taxTreatment persists on a Transaction', async () => {
  const { household, entity, account } = await seedPersonal();
  const txn = await Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-06-15', amount: '1000.0000', currency: 'CAD',
    merchantRaw: 'CORP', merchantClean: 'CORP', taxTreatment: 'salary',
    importBatch: 'seed', sourceRowFingerprint: 'fp-tt-1', sourceIdentityFingerprint: 'sif-tt-1',
  } as never);
  const reloaded = await Transaction.findByPk(txn.id);
  assert.equal(reloaded?.taxTreatment, 'salary');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatment-personal.test.ts`
Expected: FAIL — `taxTreatment` is not a known attribute (column missing on synced model).

- [ ] **Step 3: Add the enum to `backend/src/transactions/types.ts`**

Append:

```typescript
export const TAX_TREATMENTS = [
  'eligible_dividend',
  'non_eligible_dividend',
  'salary',
  'loan_advance',
  'loan_repayment',
  'employment_income',
  'not_income',
] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export function isTaxTreatment(value: unknown): value is TaxTreatment {
  return (
    typeof value === 'string' &&
    (TAX_TREATMENTS as readonly string[]).includes(value)
  );
}
```

- [ ] **Step 4: Add the field to `backend/src/models/Transaction.ts`**

After `declare transferLinkedAt: Date | null;` (line 45) add:

```typescript
  /** Per-transfer tax treatment (#income-queue). One of TAX_TREATMENTS or null. */
  declare taxTreatment: string | null;
```

In the `Transaction.init({...})` attributes object, after the `transferLinkedAt` attribute, add:

```typescript
      taxTreatment: {
        type: DataTypes.STRING(24),
        field: 'tax_treatment',
        allowNull: true,
      },
```

- [ ] **Step 5: Create the migration**

Create `backend/src/migrations/20260601000000-transactions-tax-treatment.js`:

```javascript
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'tax_treatment', {
      type: Sequelize.STRING(24),
      allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('transactions', 'tax_treatment');
  },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatment-personal.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/transactions/types.ts backend/src/models/Transaction.ts \
  backend/src/migrations/20260601000000-transactions-tax-treatment.js \
  backend/test/tax/taxTreatment-personal.test.ts
git commit -m "feat(tax): add Transaction.taxTreatment field + enum"
```

---

### Task 2: `buildPersonalFacts` treatment-first routing

**Files:**
- Modify: `backend/src/tax/builders/buildPersonalFacts.ts:44-70,83-85`
- Test: `backend/test/tax/taxTreatment-personal.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/tax/taxTreatment-personal.test.ts`:

```typescript
import { buildPersonalFacts } from '../../src/tax/builders/buildPersonalFacts';

async function addTxn(account: any, entity: any, household: any, fields: Record<string, unknown>, n: number) {
  return Transaction.create({
    accountId: account.id, householdId: household.id, entityId: entity.id,
    date: '2025-05-01', amount: '1000.0000', currency: 'CAD',
    merchantRaw: 'X', merchantClean: 'X',
    importBatch: 'seed', sourceRowFingerprint: `fp-${n}`, sourceIdentityFingerprint: `sif-${n}`,
    ...fields,
  } as never);
}

test('salary treatment routes to employment income', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household, { amount: '6000.0000', taxTreatment: 'salary' }, 1);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '6000.00');
  assert.equal(facts.eligibleDividends.length, 0);
});

test('dividend treatments route to eligible/non-eligible buckets', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household, { amount: '500.0000', taxTreatment: 'eligible_dividend' }, 2);
  await addTxn(s.account, s.entity, s.household, { amount: '300.0000', taxTreatment: 'non_eligible_dividend' }, 3);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.eligibleDividends.length, 1);
  assert.equal(facts.eligibleDividends[0].cadAmount.toFixed(2), '500.00');
  assert.equal(facts.nonEligibleDividends.length, 1);
  assert.equal(facts.nonEligibleDividends[0].cadAmount.toFixed(2), '300.00');
});

test('loan_advance is not income', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household, { amount: '9000.0000', taxTreatment: 'loan_advance' }, 4);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 0);
  assert.equal(facts.eligibleDividends.length, 0);
  assert.equal(facts.nonEligibleDividends.length, 0);
});

test('treatment beats finalCategory — counts once (guard)', async () => {
  const s = await seedPersonal();
  // a corp salary deposit auto-tagged employment_income AND classified salary
  await addTxn(s.account, s.entity, s.household,
    { amount: '4000.0000', finalCategory: 'employment_income', taxTreatment: 'salary' }, 5);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1, 'must not double-count');
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '4000.00');
});

test('legacy finalCategory employment_income still counts (treatment null)', async () => {
  const s = await seedPersonal();
  await addTxn(s.account, s.entity, s.household,
    { amount: '7000.0000', finalCategory: 'employment_income' }, 6);
  const facts = await buildPersonalFacts(s.entity.id, 2025);
  assert.equal(facts.employmentIncome.length, 1);
  assert.equal(facts.employmentIncome[0].cadAmount.toFixed(2), '7000.00');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatment-personal.test.ts`
Expected: FAIL — treatment rows fall through to category routing (dividends/salary land nowhere; `eligibleDividends` is `undefined`/empty).

- [ ] **Step 3: Hoist the dividend arrays**

In `backend/src/tax/builders/buildPersonalFacts.ts`, in the declaration block at lines 44-49 (next to `employmentIncome`), add:

```typescript
  const eligibleDividends: IncomeItem[] = [];
  const nonEligibleDividends: IncomeItem[] = [];
```

Then **delete** the later duplicate declarations of `eligibleDividends` and `nonEligibleDividends` (currently at lines 84-85), keeping `const interestIncome: IncomeItem[] = [];` where it is.

- [ ] **Step 4: Add treatment-first routing in the txn loop**

In the `for (const t of txns)` loop, immediately after the `item` object is constructed and before `const cat = t.finalCategory ?? '';`, insert:

```typescript
    // Tax-treatment classification (corp→personal distributions + confirmed
    // payroll) takes precedence and short-circuits the category routing below.
    // This is the no-double-count guard: a classified row is handled here only.
    const tt = t.taxTreatment;
    if (tt != null) {
      if (tt === 'salary' || tt === 'employment_income') employmentIncome.push(item);
      else if (tt === 'eligible_dividend') eligibleDividends.push(item);
      else if (tt === 'non_eligible_dividend') nonEligibleDividends.push(item);
      // loan_advance | loan_repayment | not_income → no income effect
      continue;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatment-personal.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/tax/builders/buildPersonalFacts.ts backend/test/tax/taxTreatment-personal.test.ts
git commit -m "feat(tax): route classified transactions into personal T1 income"
```

---

### Task 3: `buildCorpFacts` classified corp distributions

**Files:**
- Modify: `backend/src/tax/builders/buildCorpFacts.ts:151-165`
- Test: `backend/test/tax/taxTreatment-corp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/taxTreatment-corp.test.ts`:

```typescript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Account, Entity, Household, Transaction } from '../../src/models';
import { buildCorpFacts } from '../../src/tax/builders/buildCorpFacts';

beforeEach(async () => { await sequelize.sync({ force: true }); });

async function seedCorp() {
  const household = await Household.create({ name: 'C' });
  const entity = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Corp',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  } as never);
  const account = await Account.create({
    name: 'Corp Chq', householdId: household.id, accountType: 'checking',
    entityId: entity.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  return { household, entity, account };
}

test('classified corp dividend legs feed dividendsPaid with correct kind', async () => {
  const s = await seedCorp();
  // corp leg of a corp→personal transfer is an outflow (negative)
  await Transaction.create({
    accountId: s.account.id, householdId: s.household.id, entityId: s.entity.id,
    date: '2025-04-01', amount: '-20000.0000', currency: 'CAD',
    merchantRaw: 'OWNER', merchantClean: 'OWNER', taxTreatment: 'eligible_dividend',
    importBatch: 'seed', sourceRowFingerprint: 'fp-c1', sourceIdentityFingerprint: 'sif-c1',
  } as never);
  const facts = await buildCorpFacts(s.entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.dividendsPaid.length, 1);
  assert.equal(facts.dividendsPaid[0].kind, 'eligible');
  assert.equal(facts.dividendsPaid[0].amount.toFixed(2), '20000.00');
});

test('classified corp salary leg feeds salaryPaid', async () => {
  const s = await seedCorp();
  await Transaction.create({
    accountId: s.account.id, householdId: s.household.id, entityId: s.entity.id,
    date: '2025-04-01', amount: '-5000.0000', currency: 'CAD',
    merchantRaw: 'OWNER', merchantClean: 'OWNER', taxTreatment: 'salary',
    importBatch: 'seed', sourceRowFingerprint: 'fp-c2', sourceIdentityFingerprint: 'sif-c2',
  } as never);
  const facts = await buildCorpFacts(s.entity.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.equal(facts.salaryPaid.toFixed(2), '5000.00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatment-corp.test.ts`
Expected: FAIL — `dividendsPaid` empty, `salaryPaid` is `0.00` (classified txns not read).

- [ ] **Step 3: Read classified corp-side txns**

In `backend/src/tax/builders/buildCorpFacts.ts`, immediately after the existing `for (const loan of loanRows) { ... }` loop (ends ~line 165), add:

```typescript
  // Classified corp→personal distributions (income-queue actuals). The corp
  // leg is an outflow (negative); distributions/remuneration are positive.
  for (const t of txns) {
    const tt = t.taxTreatment;
    if (tt == null) continue;
    const { cad } = await toCad(
      D(t.amount as unknown as string),
      t.currency ?? 'CAD',
      t.date as unknown as string,
    );
    const amt = cad.abs();
    if (tt === 'eligible_dividend') {
      dividendsPaid.push({
        source: `Txn #${t.id} eligible dividend`,
        date: t.date as unknown as string,
        amount: amt,
        kind: 'eligible',
      });
    } else if (tt === 'non_eligible_dividend') {
      dividendsPaid.push({
        source: `Txn #${t.id} non-eligible dividend`,
        date: t.date as unknown as string,
        amount: amt,
        kind: 'non_eligible',
      });
    } else if (tt === 'salary') {
      salaryPaid = salaryPaid.plus(amt);
    }
    // loan_advance | loan_repayment | employment_income | not_income → no T2 effect
  }
```

(`txns`, `dividendsPaid`, `salaryPaid`, `toCad`, `D` are all already in scope in this function.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/taxTreatment-corp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/builders/buildCorpFacts.ts backend/test/tax/taxTreatment-corp.test.ts
git commit -m "feat(tax): derive corp dividends/salary from classified transfers"
```

> **Known P1 limitation (document in PR):** `buildCorpFacts` reads *both* manual `ShareholderLoan` rows and classified txns additively. The manual ledger is now for non-transaction entries only; do not enter manual `dividend_credit`/`salary_credit` rows for cash distributions that are also classified, or they will double-count. Automatic dedup is deferred to P3.

---

### Task 4: shareholder-loan balance derivation

**Files:**
- Create: `backend/src/tax/services/shareholderLoanBalance.ts`
- Test: `backend/test/tax/shareholderLoanBalance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/shareholderLoanBalance.test.ts`:

```typescript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize } from '../../src/db';
import { Account, Entity, Household, ShareholderLoan, Transaction } from '../../src/models';
import { computeShareholderLoanBalance } from '../../src/tax/services/shareholderLoanBalance';

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('balance = manual ledger + classified loan transfers', async () => {
  const household = await Household.create({ name: 'L' });
  const corp = await Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Corp',
    jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  } as never);
  const acct = await Account.create({
    name: 'Corp', householdId: household.id, accountType: 'checking',
    entityId: corp.id, taxStatus: 'non_registered', defaultCurrency: 'CAD',
  } as never);
  // manual: advance 10000, repayment 2000 → +8000
  await ShareholderLoan.create({ entityId: corp.id, date: '2025-01-01', kind: 'advance', amount: '10000.0000' } as never);
  await ShareholderLoan.create({ entityId: corp.id, date: '2025-02-01', kind: 'repayment', amount: '2000.0000' } as never);
  // classified transfers: loan_advance 3000 (corp outflow), loan_repayment 1000 (corp inflow) → +2000
  await Transaction.create({
    accountId: acct.id, householdId: household.id, entityId: corp.id,
    date: '2025-03-01', amount: '-3000.0000', currency: 'CAD', merchantRaw: 'O', merchantClean: 'O',
    taxTreatment: 'loan_advance', importBatch: 's', sourceRowFingerprint: 'fp-l1', sourceIdentityFingerprint: 'sif-l1',
  } as never);
  await Transaction.create({
    accountId: acct.id, householdId: household.id, entityId: corp.id,
    date: '2025-04-01', amount: '1000.0000', currency: 'CAD', merchantRaw: 'O', merchantClean: 'O',
    taxTreatment: 'loan_repayment', importBatch: 's', sourceRowFingerprint: 'fp-l2', sourceIdentityFingerprint: 'sif-l2',
  } as never);

  const balance = await computeShareholderLoanBalance(corp.id);
  assert.equal(balance.toFixed(2), '10000.00'); // 8000 + 2000
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/shareholderLoanBalance.test.ts`
Expected: FAIL — module `shareholderLoanBalance` does not exist.

- [ ] **Step 3: Implement the helper**

Create `backend/src/tax/services/shareholderLoanBalance.ts`:

```typescript
import { Op } from 'sequelize';
import { ShareholderLoan, Transaction } from '../../models';
import { D, type Decimal } from '../util/decimal';

/**
 * Shareholder-loan running balance for a corp entity:
 *   manual(advance + dividend_credit + salary_credit − repayment)
 *   + classified transfers(loan_advance − loan_repayment)
 * Per-transfer dividends/salary are cash distributions and do NOT move the
 * loan balance — only loan_advance/loan_repayment treatments do.
 */
export async function computeShareholderLoanBalance(corpEntityId: number): Promise<Decimal> {
  let balance = D(0);

  const rows = await ShareholderLoan.findAll({ where: { entityId: corpEntityId } });
  for (const r of rows) {
    const amt = D(r.amount);
    balance = r.kind === 'repayment' ? balance.minus(amt) : balance.plus(amt);
  }

  const txns = await Transaction.findAll({
    where: { entityId: corpEntityId, taxTreatment: { [Op.in]: ['loan_advance', 'loan_repayment'] } },
  });
  for (const t of txns) {
    const amt = D(t.amount as unknown as string).abs();
    balance = t.taxTreatment === 'loan_repayment' ? balance.minus(amt) : balance.plus(amt);
  }

  return balance;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/shareholderLoanBalance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tax/services/shareholderLoanBalance.ts backend/test/tax/shareholderLoanBalance.test.ts
git commit -m "feat(tax): derive shareholder-loan balance from ledger + classified transfers"
```

---

### Task 5: `PATCH /api/transfers/:id/tax-treatment`

Sets `taxTreatment` on a linked pair (both legs) or on a single unlinked row (payroll). Lives beside the existing `/:id/purpose` handler to reuse `sequelize`, `Transaction`, `visibleTransactionWhere`, `serializeTransaction`, `asNumberId`.

> Note: the spec wrote `/api/transactions/:id/tax-treatment`; it lives at `/api/transfers/:id/tax-treatment` to sit with its sibling purpose endpoint and reuse helpers. Functionally identical.

**Files:**
- Modify: `backend/src/routes/transfers.ts` (add handler after the `/:id/purpose` handler, ~line 582)
- Test: `backend/test/tax/routes-tax-treatment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/routes-tax-treatment.test.ts`:

```typescript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { sequelize } from '../../src/db';
import { Account, Entity, Household, Transaction } from '../../src/models';
import { app } from '../../src/app';

beforeEach(async () => { await sequelize.sync({ force: true }); });

async function seedLinkedPair() {
  const household = await Household.create({ name: 'PR' });
  const personal = await Entity.create({ householdId: household.id, kind: 'personal', legalName: 'P', jurisdiction: 'CA-ON', fiscalYearEnd: null } as never);
  const acct = await Account.create({ name: 'Chq', householdId: household.id, accountType: 'checking', entityId: personal.id, taxStatus: 'non_registered', defaultCurrency: 'CAD' } as never);
  const a = await Transaction.create({ accountId: acct.id, householdId: household.id, entityId: personal.id, date: '2025-05-01', amount: '5000.0000', currency: 'CAD', merchantRaw: 'C', merchantClean: 'C', txnType: 'transfer', importBatch: 's', sourceRowFingerprint: 'fp-a', sourceIdentityFingerprint: 'sif-a' } as never);
  const b = await Transaction.create({ accountId: acct.id, householdId: household.id, entityId: personal.id, date: '2025-05-01', amount: '-5000.0000', currency: 'CAD', merchantRaw: 'C', merchantClean: 'C', txnType: 'transfer', linkedTransactionId: a.id, importBatch: 's', sourceRowFingerprint: 'fp-b', sourceIdentityFingerprint: 'sif-b' } as never);
  await a.update({ linkedTransactionId: b.id });
  return { household, a, b };
}

test('PATCH sets taxTreatment on both legs of a pair', async () => {
  const { a, b } = await seedLinkedPair();
  const res = await request(app).patch(`/api/transfers/${a.id}/tax-treatment`).send({ taxTreatment: 'non_eligible_dividend' });
  assert.equal(res.status, 200);
  assert.equal((await Transaction.findByPk(a.id))?.taxTreatment, 'non_eligible_dividend');
  assert.equal((await Transaction.findByPk(b.id))?.taxTreatment, 'non_eligible_dividend');
});

test('PATCH rejects an invalid treatment', async () => {
  const { a } = await seedLinkedPair();
  const res = await request(app).patch(`/api/transfers/${a.id}/tax-treatment`).send({ taxTreatment: 'bogus' });
  assert.equal(res.status, 400);
});
```

> If `app` is not exported from `backend/src/app.ts`, mirror the import used by the existing `backend/test/tax/routes-scenarios.test.ts` (open it to copy the exact app/supertest bootstrap), and use that same pattern here.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-tax-treatment.test.ts`
Expected: FAIL — route returns 404 (handler not registered).

- [ ] **Step 3: Add the handler**

In `backend/src/routes/transfers.ts`, add `isTaxTreatment` to the existing import from `../transactions/types` (or add the import), then after the `/:id/purpose` handler insert:

```typescript
import { isTaxTreatment } from '../transactions/types';

/**
 * PATCH /api/transfers/:id/tax-treatment
 *
 * Sets `tax_treatment` on a transaction. If the row is linked (a transfer
 * pair), both legs get the same value. Unlinked rows (e.g. a payroll deposit)
 * are allowed — only that row is updated. `null`/'' clears the treatment.
 */
router.patch('/:id/tax-treatment', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const raw = (req.body || {}).taxTreatment;
    let treatment: string | null;
    if (raw === null || raw === undefined || raw === '') {
      treatment = null;
    } else if (isTaxTreatment(raw)) {
      treatment = raw;
    } else {
      res.status(400).json({ error: 'invalid taxTreatment' });
      return;
    }

    const result = await sequelize.transaction(async (t) => {
      const a = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) }, transaction: t });
      if (!a) {
        const err = new Error('Not found') as Error & { status?: number };
        err.status = 404;
        throw err;
      }
      a.set('taxTreatment', treatment);
      a.set('reviewedAt', new Date());
      await a.save({ transaction: t });
      let b = null;
      if (a.linkedTransactionId != null) {
        b = await Transaction.findOne({ where: { id: a.linkedTransactionId, ...visibleTransactionWhere(req) }, transaction: t });
        if (b) {
          b.set('taxTreatment', treatment);
          b.set('reviewedAt', new Date());
          await b.save({ transaction: t });
        }
      }
      return { a, b };
    });

    res.json({ a: serializeTransaction(result.a), b: result.b ? serializeTransaction(result.b) : null });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-tax-treatment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/transfers.ts backend/test/tax/routes-tax-treatment.test.ts
git commit -m "feat(tax): PATCH endpoint to set transaction taxTreatment on a pair"
```

---

### Task 6: `GET /api/tax/classification-queue`

Returns unclassified corp→personal transfer pairs + detected payroll deposits for a personal entity/year.

**Files:**
- Modify: `backend/src/routes/tax.ts` (add handler; mirror an existing `router.get` in this file for auth/household scoping)
- Test: `backend/test/tax/routes-classification-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/tax/routes-classification-queue.test.ts`:

```typescript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { sequelize } from '../../src/db';
import { Account, Entity, Household, Transaction } from '../../src/models';
import { app } from '../../src/app';

beforeEach(async () => { await sequelize.sync({ force: true }); });

test('queue returns unclassified corp→personal pairs and payroll', async () => {
  const household = await Household.create({ name: 'Q' });
  const personal = await Entity.create({ householdId: household.id, kind: 'personal', legalName: 'P', jurisdiction: 'CA-ON', fiscalYearEnd: null } as never);
  const corp = await Entity.create({ householdId: household.id, kind: 'corp', legalName: 'Corp', jurisdiction: 'CA-ON', fiscalYearEnd: '12-31' } as never);
  const pAcct = await Account.create({ name: 'P', householdId: household.id, accountType: 'checking', entityId: personal.id, taxStatus: 'non_registered', defaultCurrency: 'CAD' } as never);
  const cAcct = await Account.create({ name: 'C', householdId: household.id, accountType: 'checking', entityId: corp.id, taxStatus: 'non_registered', defaultCurrency: 'CAD' } as never);

  // corp→personal pair (unclassified)
  const pLeg = await Transaction.create({ accountId: pAcct.id, householdId: household.id, entityId: personal.id, date: '2025-06-01', amount: '5000.0000', currency: 'CAD', merchantRaw: 'C', merchantClean: 'C', txnType: 'transfer', importBatch: 's', sourceRowFingerprint: 'fp-p', sourceIdentityFingerprint: 'sif-p' } as never);
  const cLeg = await Transaction.create({ accountId: cAcct.id, householdId: household.id, entityId: corp.id, date: '2025-06-01', amount: '-5000.0000', currency: 'CAD', merchantRaw: 'C', merchantClean: 'C', txnType: 'transfer', linkedTransactionId: pLeg.id, importBatch: 's', sourceRowFingerprint: 'fp-c', sourceIdentityFingerprint: 'sif-c' } as never);
  await pLeg.update({ linkedTransactionId: cLeg.id });

  // payroll deposit (unclassified)
  await Transaction.create({ accountId: pAcct.id, householdId: household.id, entityId: personal.id, date: '2025-06-15', amount: '3000.0000', currency: 'CAD', merchantRaw: 'EMPLOYER', merchantClean: 'EMPLOYER', txnType: 'income', importBatch: 's', sourceRowFingerprint: 'fp-pay', sourceIdentityFingerprint: 'sif-pay' } as never);

  const res = await request(app).get(`/api/tax/classification-queue?entityId=${personal.id}&year=2025`);
  assert.equal(res.status, 200);
  assert.equal(res.body.corpDistributions.length, 1);
  assert.equal(res.body.corpDistributions[0].personal.id, pLeg.id);
  assert.equal(res.body.corpDistributions[0].corp.id, cLeg.id);
  assert.equal(res.body.payroll.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-classification-queue.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add the handler**

In `backend/src/routes/tax.ts`, ensure these are imported: `Op` from `sequelize`; `Account`, `Entity`, `Transaction` from `../models`. Add:

```typescript
// GET /api/tax/classification-queue?entityId=&year=
// Unclassified corp→personal transfer pairs + detected payroll deposits for a
// personal entity in a calendar year. Read-only derivation (no table).
router.get('/classification-queue', async (req, res, next) => {
  try {
    const entityId = Number(req.query.entityId);
    const year = Number(req.query.year);
    if (!Number.isInteger(entityId) || !Number.isInteger(year)) {
      res.status(400).json({ error: 'entityId and year query params required' });
      return;
    }
    const personal = await Entity.findByPk(entityId);
    if (!personal || personal.kind !== 'personal') {
      res.status(404).json({ error: 'personal entity not found' });
      return;
    }
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;

    const corpEntities = await Entity.findAll({ where: { householdId: personal.householdId, kind: 'corp' } });
    const corpEntityIds = new Set(corpEntities.map((e) => e.id));

    const personalLegs = await Transaction.findAll({
      where: {
        entityId,
        date: { [Op.between]: [start, end] },
        linkedTransactionId: { [Op.ne]: null },
        taxTreatment: null,
      },
    });
    const corpDistributions: Array<{ personal: unknown; corp: unknown }> = [];
    for (const leg of personalLegs) {
      const other = await Transaction.findByPk(leg.linkedTransactionId as number);
      if (other && other.entityId != null && corpEntityIds.has(other.entityId)) {
        corpDistributions.push({ personal: leg, corp: other });
      }
    }

    const payroll = await Transaction.findAll({
      where: { entityId, date: { [Op.between]: [start, end] }, txnType: 'income', taxTreatment: null },
    });

    res.json({ corpDistributions, payroll });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/routes-classification-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full tax suite (regression)**

Run: `cd backend && npx tsx --import ./test/setup.ts --test test/tax/*.test.ts`
Expected: PASS (no regressions in scenarios/integration).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/tax.ts backend/test/tax/routes-classification-queue.test.ts
git commit -m "feat(tax): classification-queue endpoint for unclassified income"
```

---

## Self-Review

**Spec coverage:**
- `taxTreatment` field + vocabulary → Task 1. ✓
- Personal T1 derivation + double-count guard → Task 2. ✓
- Corp T2 derivation + correct dividend kind + coexistence limitation → Task 3 (documented). ✓
- Shareholder-loan balance derivation → Task 4. ✓
- Treatment-set API → Task 5. ✓
- Classification-queue derivation → Task 6. ✓
- Eligible-vs-non-eligible default + GRIP warning: the field carries the user's per-transfer choice; the GRIP-overflow warning reuse is a P2 concern (no actuals warning surface yet) — **noted as deferred**, not in P1.
- UI, payroll IncomeEntry gross/withheld, auto-suggest → P2/P3 (out of P1 scope). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only "open" instructions are the `app`/supertest bootstrap fallback (Task 5 Step 1) which points at a concrete existing file to copy — acceptable since the repo's test-app wiring is established and must be matched, not invented.

**Type consistency:** `taxTreatment` values are identical across Tasks 1/2/3/4/5 and match `TAX_TREATMENTS`. `computeShareholderLoanBalance(corpEntityId)` signature consistent. `CorpDividendPaid.kind` uses `'eligible'`/`'non_eligible'` matching `buildCorpFacts` existing usage (line 160). Personal income arrays (`employmentIncome`, `eligibleDividends`, `nonEligibleDividends`) match `TaxYearFacts`/`buildPersonalFacts` names.

**Deferred to P2/P3 (explicit):** queue UI + per-row assignment + balance widget (P2); auto-suggest, bulk, per-counterparty defaults, capital_dividend, auto-gen T4/T5, manual-ledger dedup, GRIP-overflow actuals warning (P3).
