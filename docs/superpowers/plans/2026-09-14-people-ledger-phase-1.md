# People Ledger Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the People page's numbers correct — a transfer counts as a debt only when its role says so, and the balance is signed.

**Architecture:** A `counterparty_role` discriminator on Transaction and a `loan_default` flag on Contact. Pure functions resolve a role per row and fold rows into a signed per-currency balance; the ledger route calls them. Category-based exclusion is deleted. The transfer list starts showing `merchant_raw` so a mis-tag is visible.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx` for backend, Vite + React 19 + vitest for frontend, DTOs in `shared/api-types.ts`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-14-people-ledger-loan-accounting-design.md`.
- Migrations are JavaScript in `backend/src/migrations/`, named `YYYYMMDD...-slug.js`, and must run on **both** SQLite and Postgres.
- Migration tests live in `backend/src/migrations/__tests__/`, never directly in `src/migrations/` — `sequelize-cli` scans that directory and would try to load a `.test.ts` as a migration.
- Unit tests are **colocated**: `foo.test.ts` beside `foo.ts` under `backend/src/`.
- Money math uses integer arithmetic scaled by `10_000`, matching `computeTransferNet` in `backend/src/contacts/transferLedger.ts`. Never accumulate floats.
- Amounts are strings in DTOs, fixed to 4 decimal places.
- Any test asserting a model hook persisted a derived column must re-read the row (`findByPk`), never assert on the in-memory instance.
- Run all commands from the repo root unless a step says otherwise.
- Do **not** touch `transactions.transfer_purpose`. It is a different column with a different vocabulary, read by `reciprocity.ts`, `routes/transfers.ts`, `routes/reports.ts`, `routes/statements.ts` and `sync/tables.ts`.

---

### Task 1: Schema — `counterparty_role` and `loan_default`

**Files:**
- Create: `backend/src/migrations/20260915000001-counterparty-role-and-loan-default.js`
- Create: `backend/src/migrations/__tests__/counterpartyRoleAndLoanDefault.test.ts`
- Modify: `backend/src/models/Transaction.ts` (declaration block near line 44; column block near line 339)
- Modify: `backend/src/models/Contact.ts` (declaration block; column block)

**Interfaces:**
- Consumes: nothing.
- Produces: `Transaction.counterpartyRole: string | null`, `Contact.loanDefault: boolean`.

- [ ] **Step 1: Write the failing migration test**

Create `backend/src/migrations/__tests__/counterpartyRoleAndLoanDefault.test.ts`:

```ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  await qi.createTable('transactions', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await qi.createTable('contacts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await sequelize.query(`INSERT INTO transactions (id, household_id, amount, currency, created_at, updated_at)
    VALUES (1, 1, -40.0000, 'CAD', datetime('now'), datetime('now'))`);
  await sequelize.query(`INSERT INTO contacts (id, household_id, name, created_at, updated_at)
    VALUES (1, 1, 'Caelan Iten-McGrath', datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260915000001-counterparty-role-and-loan-default.js');
});
after(async () => { await sequelize.close(); });

test('up adds counterparty_role null and loan_default false', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [txns] = await sequelize.query('SELECT counterparty_role FROM transactions WHERE id = 1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal((txns as any[])[0].counterparty_role, null, 'existing rows start untagged');
  const [contacts] = await sequelize.query('SELECT loan_default FROM contacts WHERE id = 1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v = (contacts as any[])[0].loan_default;
  assert.ok(v === 0 || v === false, 'existing contacts default to not-a-lending-relationship');
});

test('down removes both columns', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const txnDesc = await sequelize.getQueryInterface().describeTable('transactions');
  assert.equal(txnDesc.counterparty_role, undefined);
  const contactDesc = await sequelize.getQueryInterface().describeTable('contacts');
  assert.equal(contactDesc.loan_default, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/counterpartyRoleAndLoanDefault.test.ts
```

Expected: FAIL — `Cannot find module '../20260915000001-counterparty-role-and-loan-default.js'`.

- [ ] **Step 3: Write the migration**

Create `backend/src/migrations/20260915000001-counterparty-role-and-loan-default.js`:

```js
'use strict';

/**
 * People ledger phase 1. Adds the two discriminators that decide whether a
 * transfer creates a debt.
 *
 *   - transactions.counterparty_role STRING(16): what this transfer means
 *     between the user and another person — loan, repayment, purchase,
 *     business, rent, gift, self — or, on a line-of-credit interest charge,
 *     loc_interest to mark it allocatable. Null means untagged, in which case
 *     the contact's loan_default decides.
 *   - contacts.loan_default BOOLEAN: treat this person's untagged transfers as
 *     loans. False keeps existing behaviour of contributing nothing.
 *
 * NOT to be confused with transactions.transfer_purpose (issue #222), which
 * carries owner_draw/owner_contribution/reimbursement/investment/internal/
 * income and describes movement between the user's OWN accounts. Eleven rows
 * are both contact-linked and pair-linked, so the vocabularies must not share
 * a column.
 *
 * Spine note: discriminator fields on the existing Transaction and
 * Counterparty primitives. No new primitive, no new status machine.
 *
 * Both columns are additive and defaulted, so no backfill is required.
 * Dialect-agnostic: runs on SQLite and Postgres.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('transactions', 'counterparty_role', {
      type: Sequelize.STRING(16),
      allowNull: true,
    });
    await queryInterface.addColumn('contacts', 'loan_default', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('contacts', 'loan_default');
    await queryInterface.removeColumn('transactions', 'counterparty_role');
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/counterpartyRoleAndLoanDefault.test.ts
```

Expected: PASS, 2/2.

- [ ] **Step 5: Add the model fields**

In `backend/src/models/Transaction.ts`, beside `declare transferPurpose: string | null;`:

```ts
  /**
   * People-ledger role: what this transfer means between the user and another
   * person. See COUNTERPARTY_ROLES. Null = untagged; the contact's loanDefault
   * decides. Distinct from `transferPurpose`, which describes movement between
   * the user's own accounts.
   */
  declare counterpartyRole: string | null;
```

and in the column block beside `transferPurpose`:

```ts
      counterpartyRole: {
        type: DataTypes.STRING(16),
        field: 'counterparty_role',
        allowNull: true,
      },
```

In `backend/src/models/Contact.ts`, beside `declare isSelf`:

```ts
  /**
   * Treat this contact's untagged transfers as loans. False (default) means an
   * untagged transfer contributes nothing to the balance; true means outflows
   * count as loans and inflows as repayments unless a row says otherwise.
   */
  declare loanDefault: CreationOptional<boolean>;
```

and in the column block:

```ts
      loanDefault: {
        type: DataTypes.BOOLEAN,
        field: 'loan_default',
        allowNull: false,
        defaultValue: false,
      },
```

- [ ] **Step 6: Typecheck and commit**

```bash
yarn workspace cashflow-backend run typecheck
git add backend/src/migrations/20260915000001-counterparty-role-and-loan-default.js backend/src/migrations/__tests__/counterpartyRoleAndLoanDefault.test.ts backend/src/models/Transaction.ts backend/src/models/Contact.ts
git commit -m "feat(contacts): add counterparty_role and loan_default columns"
```

---

### Task 2: Role resolution

**Files:**
- Create: `backend/src/contacts/counterpartyRole.ts`
- Create: `backend/src/contacts/counterpartyRole.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `COUNTERPARTY_ROLES: readonly string[]` and `type CounterpartyRole`
  - `isCounterpartyRole(v: unknown): v is CounterpartyRole`
  - `resolveLedgerRole(args: { role: string | null; amount: number; loanDefault: boolean }): { effect: 'loan' | 'repayment' | 'none'; mismatch: boolean }`

- [ ] **Step 1: Write the failing test**

Create `backend/src/contacts/counterpartyRole.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCounterpartyRole, resolveLedgerRole } from './counterpartyRole';

test('isCounterpartyRole accepts the vocabulary and rejects anything else', () => {
  assert.equal(isCounterpartyRole('loan'), true);
  assert.equal(isCounterpartyRole('loc_interest'), true);
  assert.equal(isCounterpartyRole('owner_draw'), false, 'that belongs to transfer_purpose');
  assert.equal(isCounterpartyRole(''), false);
  assert.equal(isCounterpartyRole(null), false);
});

test('an explicit loan on an outflow counts as a loan', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'loan', amount: -40, loanDefault: false }),
    { effect: 'loan', mismatch: false },
  );
});

test('an explicit repayment on an inflow counts as a repayment', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'repayment', amount: 600, loanDefault: false }),
    { effect: 'repayment', mismatch: false },
  );
});

test('a non-debt role never counts, whatever the direction', () => {
  for (const role of ['purchase', 'business', 'rent', 'gift', 'self', 'loc_interest']) {
    assert.deepEqual(
      resolveLedgerRole({ role, amount: -3648, loanDefault: true }),
      { effect: 'none', mismatch: false },
      `${role} must not create a debt`,
    );
  }
});

test('a role contradicting its direction resolves by direction and reports a mismatch', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'loan', amount: 600, loanDefault: false }),
    { effect: 'repayment', mismatch: true },
  );
  assert.deepEqual(
    resolveLedgerRole({ role: 'repayment', amount: -600, loanDefault: false }),
    { effect: 'loan', mismatch: true },
  );
});

test('untagged rows follow the contact default', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: null, amount: -200, loanDefault: true }),
    { effect: 'loan', mismatch: false },
  );
  assert.deepEqual(
    resolveLedgerRole({ role: null, amount: 200, loanDefault: true }),
    { effect: 'repayment', mismatch: false },
  );
  assert.deepEqual(
    resolveLedgerRole({ role: null, amount: -200, loanDefault: false }),
    { effect: 'none', mismatch: false },
  );
});

test('zero-amount rows never count', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'loan', amount: 0, loanDefault: true }),
    { effect: 'none', mismatch: false },
  );
});

test('an unknown stored role is inert rather than throwing', () => {
  assert.deepEqual(
    resolveLedgerRole({ role: 'nonsense', amount: -40, loanDefault: true }),
    { effect: 'none', mismatch: false },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/counterpartyRole.test.ts
```

Expected: FAIL — cannot find module `./counterpartyRole`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/contacts/counterpartyRole.ts`:

```ts
/**
 * People-ledger role vocabulary. Answers "what does this transfer mean between
 * me and this person", which is a different question from
 * `transactions.transfer_purpose` (issue #222), which answers "what role does
 * this movement play between my own accounts". The two must not share a column:
 * rows exist that are both contact-linked and pair-linked.
 *
 * `loc_interest` is the one value that lives on a row with no counterparty — it
 * marks a line-of-credit interest charge as allocatable in phase 2.
 */
export const COUNTERPARTY_ROLES = [
  'loan',
  'repayment',
  'purchase',
  'business',
  'rent',
  'gift',
  'self',
  'loc_interest',
] as const;

export type CounterpartyRole = (typeof COUNTERPARTY_ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(COUNTERPARTY_ROLES);

export function isCounterpartyRole(v: unknown): v is CounterpartyRole {
  return typeof v === 'string' && ROLE_SET.has(v);
}

/** How a row contributes to a contact's balance. */
export type LedgerEffect = 'loan' | 'repayment' | 'none';

export interface ResolvedLedgerRole {
  effect: LedgerEffect;
  /**
   * True when an explicit `loan`/`repayment` tag contradicts the transaction's
   * direction. The direction wins — a sign is harder to get wrong than a
   * dropdown — but the caller surfaces the conflict rather than swallowing it.
   */
  mismatch: boolean;
}

const NONE: ResolvedLedgerRole = { effect: 'none', mismatch: false };

/**
 * Resolve one row's balance effect. Explicit role wins, then the contact's
 * loanDefault, then nothing. Direction decides between loan and repayment in
 * every branch, so a mis-set dropdown cannot invert a balance.
 */
export function resolveLedgerRole(args: {
  role: string | null;
  amount: number;
  loanDefault: boolean;
}): ResolvedLedgerRole {
  const { role, amount, loanDefault } = args;
  if (!Number.isFinite(amount) || amount === 0) return NONE;
  const byDirection: LedgerEffect = amount < 0 ? 'loan' : 'repayment';

  if (role == null) {
    return loanDefault ? { effect: byDirection, mismatch: false } : NONE;
  }
  if (role !== 'loan' && role !== 'repayment') {
    // Every other role — including an unrecognised stored value — is inert.
    return NONE;
  }
  return { effect: byDirection, mismatch: role !== byDirection };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/counterpartyRole.test.ts
```

Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contacts/counterpartyRole.ts backend/src/contacts/counterpartyRole.test.ts
git commit -m "feat(contacts): resolve a transfer's ledger role from tag and direction"
```

---

### Task 3: Signed balance

**Files:**
- Create: `backend/src/contacts/loanBalance.ts`
- Create: `backend/src/contacts/loanBalance.test.ts`

**Interfaces:**
- Consumes: `resolveLedgerRole` from Task 2.
- Produces:
  - `interface BalanceInputRow { amount: string | number; currency: string; counterpartyRole: string | null }`
  - `interface LoanBalance { currency: string; lent: string; repaid: string; balance: string }`
  - `computeLoanBalance(rows: BalanceInputRow[], loanDefault: boolean): LoanBalance[]`
  - `mismatchedRowCount(rows: BalanceInputRow[], loanDefault: boolean): number`

- [ ] **Step 1: Write the failing test**

Create `backend/src/contacts/loanBalance.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLoanBalance, mismatchedRowCount } from './loanBalance';

test('a lending contact nets outflows against inflows', () => {
  const rows = [
    { amount: -200, currency: 'CAD', counterpartyRole: null },
    { amount: 50, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, true), [
    { currency: 'CAD', lent: '200.0000', repaid: '50.0000', balance: '150.0000' },
  ]);
});

test('a non-lending contact has no balance at all', () => {
  const rows = [
    { amount: -4000, currency: 'CAD', counterpartyRole: null },
    { amount: 4000, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, false), []);
});

test('repayment beyond principal carries the balance through zero', () => {
  const rows = [
    { amount: -3648, currency: 'CAD', counterpartyRole: 'loan' },
    { amount: 3904.17, currency: 'CAD', counterpartyRole: 'repayment' },
  ];
  assert.deepEqual(computeLoanBalance(rows, false), [
    { currency: 'CAD', lent: '3648.0000', repaid: '3904.1700', balance: '-256.1700' },
  ]);
});

test('non-debt roles are excluded even when the contact lends', () => {
  const rows = [
    { amount: -4550, currency: 'CAD', counterpartyRole: 'purchase' },
    { amount: -2081.31, currency: 'CAD', counterpartyRole: 'business' },
    { amount: -200, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, true), [
    { currency: 'CAD', lent: '200.0000', repaid: '0.0000', balance: '200.0000' },
  ]);
});

test('currencies are isolated and sorted, never summed', () => {
  const rows = [
    { amount: -100, currency: 'USD', counterpartyRole: null },
    { amount: -200, currency: 'CAD', counterpartyRole: null },
  ];
  assert.deepEqual(computeLoanBalance(rows, true), [
    { currency: 'CAD', lent: '200.0000', repaid: '0.0000', balance: '200.0000' },
    { currency: 'USD', lent: '100.0000', repaid: '0.0000', balance: '100.0000' },
  ]);
});

test('repeated fractional cents do not drift', () => {
  const rows = Array.from({ length: 3 }, () => ({
    amount: -0.1, currency: 'CAD', counterpartyRole: 'loan' as string | null,
  }));
  assert.deepEqual(computeLoanBalance(rows, false), [
    { currency: 'CAD', lent: '0.3000', repaid: '0.0000', balance: '0.3000' },
  ]);
});

test('string amounts are accepted', () => {
  const rows = [{ amount: '-40.0000', currency: 'CAD', counterpartyRole: 'loan' }];
  assert.deepEqual(computeLoanBalance(rows, false), [
    { currency: 'CAD', lent: '40.0000', repaid: '0.0000', balance: '40.0000' },
  ]);
});

test('mismatchedRowCount counts tags contradicting their direction', () => {
  const rows = [
    { amount: 600, currency: 'CAD', counterpartyRole: 'loan' },
    { amount: -600, currency: 'CAD', counterpartyRole: 'loan' },
    { amount: -600, currency: 'CAD', counterpartyRole: 'purchase' },
  ];
  assert.equal(mismatchedRowCount(rows, false), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/loanBalance.test.ts
```

Expected: FAIL — cannot find module `./loanBalance`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/contacts/loanBalance.ts`:

```ts
import { resolveLedgerRole } from './counterpartyRole';

export interface BalanceInputRow {
  amount: string | number;
  currency: string;
  counterpartyRole: string | null;
}

export interface LoanBalance {
  currency: string;
  /** Total tagged as lent, absolute. */
  lent: string;
  /** Total tagged as repaid, absolute. */
  repaid: string;
  /** lent − repaid. Positive: they owe you. Negative: you owe them. */
  balance: string;
}

/** Scale matches computeTransferNet so both numbers round identically. */
const SCALE = 10_000;

function toUnits(n: number): number {
  return Math.round(n * SCALE);
}

/**
 * Signed per-currency loan balance, folded straight from tagged rows.
 *
 * There is deliberately no overpaid/unapplied state: a repayment exceeding
 * principal carries the balance through zero and the UI reads it as "you owe
 * them". A sign already expresses that; a holding pen would be a state machine
 * modelling arithmetic.
 *
 * Currencies never mix — no FX here, same as computeTransferNet.
 */
export function computeLoanBalance(
  rows: BalanceInputRow[],
  loanDefault: boolean,
): LoanBalance[] {
  const lent = new Map<string, number>();
  const repaid = new Map<string, number>();

  for (const r of rows) {
    const amount = Number(r.amount);
    const { effect } = resolveLedgerRole({
      role: r.counterpartyRole,
      amount,
      loanDefault,
    });
    if (effect === 'none') continue;
    const target = effect === 'loan' ? lent : repaid;
    target.set(r.currency, (target.get(r.currency) ?? 0) + toUnits(Math.abs(amount)));
  }

  const currencies = new Set([...lent.keys(), ...repaid.keys()]);
  return [...currencies].sort().map((currency) => {
    const l = lent.get(currency) ?? 0;
    const p = repaid.get(currency) ?? 0;
    return {
      currency,
      lent: (l / SCALE).toFixed(4),
      repaid: (p / SCALE).toFixed(4),
      balance: ((l - p) / SCALE).toFixed(4),
    };
  });
}

/**
 * How many rows carry a loan/repayment tag contradicting their direction. The
 * balance already resolves these by direction; this is what the UI uses to say
 * so out loud instead of silently disagreeing with the user's dropdown.
 */
export function mismatchedRowCount(
  rows: BalanceInputRow[],
  loanDefault: boolean,
): number {
  let n = 0;
  for (const r of rows) {
    const { mismatch } = resolveLedgerRole({
      role: r.counterpartyRole,
      amount: Number(r.amount),
      loanDefault,
    });
    if (mismatch) n++;
  }
  return n;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/loanBalance.test.ts
```

Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contacts/loanBalance.ts backend/src/contacts/loanBalance.test.ts
git commit -m "feat(contacts): signed per-currency loan balance from tagged rows"
```

---

### Task 4: Cancelled e-transfer pairing

**Files:**
- Create: `backend/src/contacts/cancelPairing.ts`
- Create: `backend/src/contacts/cancelPairing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `findCancelledTransferIds(rows: Array<{ id: number; merchantText: string | null }>): Set<number>`

**Background:** RBC writes `E-TRANSFER SENT EVAN LEROSE DPKGQG` and, when the transfer is cancelled, `E-TRANSFER CANCEL EVAN LEROSE DPKGQG`. The trailing token is a confirmation code shared by both legs. Today the cancel reads as money received, i.e. a repayment that never happened. Both legs must drop out.

- [ ] **Step 1: Write the failing test**

Create `backend/src/contacts/cancelPairing.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCancelledTransferIds } from './cancelPairing';

test('a cancel and its original both drop out', () => {
  const ids = findCancelledTransferIds([
    { id: 1, merchantText: 'E-TRANSFER SENT EVAN LEROSE DPKGQG' },
    { id: 2, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE DPKGQG' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2]);
});

test('request-fulfilled originals pair too', () => {
  const ids = findCancelledTransferIds([
    { id: 3, merchantText: 'E-TRANSFER REQUEST FULFILLED EVAN LEROSE B2ZVYD' },
    { id: 4, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE B2ZVYD' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [3, 4]);
});

test('a cancel with no matching original is left alone', () => {
  const ids = findCancelledTransferIds([
    { id: 5, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE ZZZZZZ' },
  ]);
  assert.equal(ids.size, 0, 'dropping a lone cancel would hide real money');
});

test('unrelated transfers are untouched', () => {
  const ids = findCancelledTransferIds([
    { id: 6, merchantText: 'E-TRANSFER SENT EVAN ADCOCK' },
    { id: 7, merchantText: 'ONLINE TRANSFER SENT - 8807 CAELAN ITEN-MCGRATH' },
    { id: 8, merchantText: null },
  ]);
  assert.equal(ids.size, 0);
});

test('two sends sharing one code both pair with a single cancel', () => {
  const ids = findCancelledTransferIds([
    { id: 9, merchantText: 'E-TRANSFER SENT EVAN LEROSE W8XN3J' },
    { id: 10, merchantText: 'E-TRANSFER CANCEL EVAN LEROSE W8XN3J' },
    { id: 11, merchantText: 'E-TRANSFER SENT EVAN LEROSE W8XN3J' },
  ]);
  assert.deepEqual([...ids].sort((a, b) => a - b), [9, 10, 11]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/cancelPairing.test.ts
```

Expected: FAIL — cannot find module `./cancelPairing`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/contacts/cancelPairing.ts`:

```ts
/**
 * Interac e-transfer cancellations. RBC writes the original as
 * `E-TRANSFER SENT <NAME> <CODE>` (or `E-TRANSFER REQUEST FULFILLED ...`) and
 * the reversal as `E-TRANSFER CANCEL <NAME> <CODE>`, sharing a confirmation
 * code. Counting the reversal as an inflow reads as a repayment that never
 * happened, so both legs are excluded from the balance.
 *
 * A cancel with no matching original is deliberately NOT excluded: without its
 * pair we cannot tell a reversal from a real inbound transfer, and dropping it
 * would hide money.
 */

/** Trailing alphanumeric confirmation code, at least 5 chars. */
const CODE = /\b([A-Z0-9]{5,})\s*$/;

function codeOf(text: string | null, marker: RegExp): string | null {
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!marker.test(upper)) return null;
  const m = CODE.exec(upper.trim());
  return m ? m[1] : null;
}

const CANCEL = /E-?TRANSFER\s+CANCEL/;
const ORIGINAL = /E-?TRANSFER\s+(SENT|REQUEST FULFILLED)/;

export function findCancelledTransferIds(
  rows: Array<{ id: number; merchantText: string | null }>,
): Set<number> {
  const cancelsByCode = new Map<string, number[]>();
  const originalsByCode = new Map<string, number[]>();

  for (const r of rows) {
    const cancelCode = codeOf(r.merchantText, CANCEL);
    if (cancelCode) {
      const list = cancelsByCode.get(cancelCode) ?? [];
      list.push(r.id);
      cancelsByCode.set(cancelCode, list);
      continue;
    }
    const originalCode = codeOf(r.merchantText, ORIGINAL);
    if (originalCode) {
      const list = originalsByCode.get(originalCode) ?? [];
      list.push(r.id);
      originalsByCode.set(originalCode, list);
    }
  }

  const out = new Set<number>();
  for (const [code, cancelIds] of cancelsByCode) {
    const originalIds = originalsByCode.get(code);
    if (!originalIds || originalIds.length === 0) continue;
    for (const id of cancelIds) out.add(id);
    for (const id of originalIds) out.add(id);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/cancelPairing.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contacts/cancelPairing.ts backend/src/contacts/cancelPairing.test.ts
git commit -m "feat(contacts): pair cancelled e-transfers out of the ledger"
```

---

### Task 5: Shared DTOs and the ledger route

The DTO change and the route rewrite are one deliverable: a DTO nothing serves
does not typecheck, so splitting them would mean committing a knowingly broken
intermediate state.

**Files:**
- Modify: `shared/api-types.ts:1948-1973` (the per-person loan ledger block)
- Modify: `backend/src/routes/contacts.ts:272-330` (the `GET /:id/ledger` handler)
- Modify: `backend/src/contacts/transferLedger.ts` (delete `NON_LOAN_LEDGER_CATEGORIES` and `isNonLoanCategory`)
- Modify: `backend/src/contacts/transferLedger.test.ts` (drop the tests for the deleted exports)
- Create: `backend/src/routes/contactsLedger.test.ts`

**Interfaces:**
- Consumes: `computeLoanBalance`, `mismatchedRowCount` (Task 3); `resolveLedgerRole` (Task 2); `findCancelledTransferIds` (Task 4).
- Produces: `CounterpartyRole`, `LoanBalance`, extended `LedgerTransferRow`, extended `ContactLedgerResponse`; `GET /api/contacts/:id/ledger` returning `ContactLedgerResponse`.

- [ ] **Step 1: Replace the ledger DTO block**

Replace lines 1948–1973 of `shared/api-types.ts` with:

```ts
// ── Per-person loan ledger (per-person loan ledger feature) ──────────────────

/**
 * What a transfer means between the user and another person. Distinct from
 * {@link TransferPurpose}, which describes movement between the user's own
 * accounts. `loc_interest` marks a line-of-credit interest charge as
 * allocatable and sits on rows with no counterparty.
 */
export type CounterpartyRole =
  | 'loan'
  | 'repayment'
  | 'purchase'
  | 'business'
  | 'rent'
  | 'gift'
  | 'self'
  | 'loc_interest'

export interface LedgerTransferRow {
  id: number;
  date: string;
  amount: string;
  currency: string;
  /** Raw bank text — `merchant_clean` strips the counterparty name off RBC transfers. */
  merchant: string | null;
  direction: 'out' | 'in';
  isLoan: boolean;
  /** Explicit tag, or null when the contact's default decides. */
  counterpartyRole: CounterpartyRole | null;
  /** How this row actually landed in the balance after direction resolution. */
  ledgerEffect: 'loan' | 'repayment' | 'none';
  /** True when the tag contradicted the direction; direction won. */
  roleMismatch: boolean;
  /** True when this row is one leg of a cancelled e-transfer pair. */
  cancelled: boolean;
}

export interface TransferNet {
  currency: string;
  sent: string;
  received: string;
  net: string;
}

/** Signed per-currency loan balance. Positive: they owe you. */
export interface LoanBalance {
  currency: string;
  lent: string;
  repaid: string;
  balance: string;
}

export interface ContactLedgerResponse {
  contactId: number;
  name: string;
  /** Treat untagged transfers with this contact as loans. */
  loanDefault: boolean;
  /** Descriptive raw flow. Carries no owed/owe claim. */
  transferNet: TransferNet[];
  /** The number that means "owes you". */
  loanBalance: LoanBalance[];
  trackedOutstandingByCurrency: Record<string, string>;
  transfers: LedgerTransferRow[];
}
```

Do not run typecheck or commit yet — the route below is what makes this DTO valid.

- [ ] **Step 2: Write the failing route test**

This must exercise the **route**, not re-test Tasks 3 and 4. A test that only calls `computeLoanBalance` would pass the moment it is written, which proves nothing about the handler.

First read a neighbouring route test in `backend/src/routes/` that boots the app and makes an authenticated request, and reuse its bootstrap helper verbatim. Then create `backend/src/routes/contactsLedger.test.ts` asserting on the HTTP response:

```ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
// Import the app/auth bootstrap helper used by the neighbouring route tests.
// Seed, in the test household: one contact with loanDefault = true, and the
// Evan-shaped rows below linked to it via counterpartyContactId.
//
//   -4550.00  counterpartyRole 'purchase'   E-TRANSFER SENT EVAN PHONE NUMBER YAMRKV
//   -3648.00  counterpartyRole 'loan'       CHEXY*ARVIND MALLYA   HAMILTON
//   -2081.31  counterpartyRole 'business'   Sent money to Evan Adcock
//   +3904.17  counterpartyRole 'repayment'  Cash received
//      -40.00 counterpartyRole null         E-TRANSFER SENT EVAN LEROSE DPKGQG
//      +40.00 counterpartyRole null         E-TRANSFER CANCEL EVAN LEROSE DPKGQG

test('GET /:id/ledger returns a signed balance excluding non-debt roles', async () => {
  const res = await getLedger(contactId);
  assert.equal(res.status, 200);
  const cad = res.body.loanBalance.find((b: { currency: string }) => b.currency === 'CAD');
  assert.equal(cad.balance, '-256.1700', 'purchase and business legs must not create a debt');
});

test('GET /:id/ledger excludes both legs of a cancelled e-transfer', async () => {
  const res = await getLedger(contactId);
  const legs = res.body.transfers.filter((t: { cancelled: boolean }) => t.cancelled);
  assert.equal(legs.length, 2, 'both legs are listed so the user can see why they count for nothing');
  for (const leg of legs) assert.equal(leg.ledgerEffect, 'none');
});

test('GET /:id/ledger returns raw bank text, not the stripped merchant', async () => {
  const res = await getLedger(contactId);
  const row = res.body.transfers.find((t: { amount: string }) => t.amount === '-3648.0000');
  assert.match(row.merchant, /ARVIND MALLYA/, 'merchant_clean would hide the counterparty');
});

test('GET /:id/ledger echoes the contact loan default', async () => {
  const res = await getLedger(contactId);
  assert.equal(res.body.loanDefault, true);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/routes/contactsLedger.test.ts
```

Expected: FAIL — `res.body.loanBalance` is `undefined` and `res.body.merchant` still holds the stripped `merchant_clean`. If it fails on import instead, finish Tasks 2–4 first.

- [ ] **Step 4: Rewrite the ledger handler**

In `backend/src/routes/contacts.ts`, replace the body of `router.get('/:id/ledger', ...)` between loading `contact` and `res.json(...)`:

```ts
    // Ledger is household-scoped to match the link pass and tracked-loan balance,
    // so raw-net and loan balance are computed over the same row set.
    const txnsRaw = await Transaction.findAll({
      where: { ...householdWhere(req), counterpartyContactId: id },
      attributes: [
        'id', 'date', 'amount', 'currency',
        'merchantClean', 'merchantRaw', 'counterpartyRole',
      ],
      order: [['date', 'ASC'], ['id', 'ASC']],
    });

    // Cancelled e-transfer pairs drop out entirely: the reversal is not a
    // repayment, and the original never moved money.
    const cancelled = findCancelledTransferIds(
      txnsRaw.map((t) => ({ id: t.id, merchantText: t.merchantRaw ?? t.merchantClean ?? null })),
    );
    const txns = txnsRaw.filter((t) => !cancelled.has(t.id));

    const loanDefault = contact.loanDefault ?? false;
    const balanceRows = txns.map((t) => ({
      amount: t.amount,
      currency: t.currency,
      counterpartyRole: t.counterpartyRole ?? null,
    }));
    const loanBalance = computeLoanBalance(balanceRows, loanDefault);

    const reimbs = await Reimbursement.findAll({
      where: { ...householdWhere(req), contactId: id },
    });
    const loanTxnIds = new Set(reimbs.map((r) => r.transactionId));

    // Every linked row is listed, cancelled ones included, so the user can see
    // why a pair contributed nothing rather than wondering where it went.
    const transfers = txnsRaw.map((t) => {
      const amt = Number(t.amount);
      const { effect, mismatch } = resolveLedgerRole({
        role: t.counterpartyRole ?? null,
        amount: amt,
        loanDefault,
      });
      const isCancelled = cancelled.has(t.id);
      return {
        id: t.id,
        date: t.date,
        amount: String(t.amount),
        currency: t.currency,
        // Raw text: merchantClean strips the counterparty name off RBC transfers,
        // which is what made 157 Stephen rows indistinguishable.
        merchant: t.merchantRaw ?? t.merchantClean ?? null,
        direction: amt < 0 ? ('out' as const) : ('in' as const),
        isLoan: loanTxnIds.has(t.id),
        counterpartyRole: (t.counterpartyRole ?? null) as ContactLedgerResponse['transfers'][number]['counterpartyRole'],
        ledgerEffect: isCancelled ? ('none' as const) : effect,
        roleMismatch: isCancelled ? false : mismatch,
        cancelled: isCancelled,
      };
    });

    const transferNet = computeTransferNet(
      txns.map((t) => ({ amount: t.amount, currency: t.currency }) as TransferRow),
    );
```

and the response:

```ts
    res.json({
      contactId: contact.id,
      name: contact.name,
      loanDefault,
      transferNet,
      loanBalance,
      trackedOutstandingByCurrency: summary.outstandingByCurrency,
      transfers,
    });
```

Update the imports at the top of the file:

```ts
import { computeTransferNet, type TransferRow } from '../contacts/transferLedger';
import { computeLoanBalance } from '../contacts/loanBalance';
import { resolveLedgerRole } from '../contacts/counterpartyRole';
import { findCancelledTransferIds } from '../contacts/cancelPairing';
import type { ContactLedgerResponse } from '@cashflow/shared';
```

Note `isNonLoanCategory` is gone from that import and `finalCategory` is gone from the `attributes` list.

- [ ] **Step 5: Delete the dead category exclusion**

In `backend/src/contacts/transferLedger.ts`, delete `NON_LOAN_LEDGER_CATEGORIES` and `isNonLoanCategory` entirely, keeping `TransferRow`, `TransferNet` and `computeTransferNet`. Delete the corresponding tests from `backend/src/contacts/transferLedger.test.ts`.

Verify nothing else referenced them:

```bash
grep -rn "isNonLoanCategory\|NON_LOAN_LEDGER_CATEGORIES" backend/src frontend/src shared
```

Expected: no output.

- [ ] **Step 6: Run the backend suite**

```bash
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

Expected: typecheck clean, suite green.

- [ ] **Step 7: Commit**

```bash
git add shared/api-types.ts backend/src/routes/contacts.ts backend/src/contacts/transferLedger.ts backend/src/contacts/transferLedger.test.ts backend/src/routes/contactsLedger.test.ts
git commit -m "feat(contacts): serve a signed loan balance and raw merchant text"
```

---

### Task 6: Write endpoints for role and default

**Files:**
- Modify: `backend/src/routes/transactions.ts:430-445` (the patchable-field list) and the validation branch near line 500
- Modify: `backend/src/routes/contacts.ts:206-245` (the `PATCH /:id` handler)
- Create: `backend/src/routes/counterpartyRolePatch.test.ts`

**Interfaces:**
- Consumes: `isCounterpartyRole` (Task 2).
- Produces: `PATCH /api/transactions/:id { counterpartyRole }`, `PATCH /api/contacts/:id { loanDefault }`.

- [ ] **Step 1: Write the failing endpoint test**

This must exercise the endpoints. A test that only calls `isCounterpartyRole` would pass the moment it is written and would prove nothing about the routes.

Reuse the app/auth bootstrap helper from the route test written in Task 5. Create `backend/src/routes/counterpartyRolePatch.test.ts`:

```ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
// Same app/auth bootstrap helper as backend/src/routes/contactsLedger.test.ts.
// Seed: one contact and one transaction in the test household.

test('PATCH /api/transactions/:id accepts a ledger role and persists it', async () => {
  const res = await patchTransaction(txnId, { counterpartyRole: 'loan' });
  assert.equal(res.status, 200);
  const fresh = await Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, 'loan');
});

test('PATCH /api/transactions/:id clears the role on null', async () => {
  await patchTransaction(txnId, { counterpartyRole: 'loan' });
  const res = await patchTransaction(txnId, { counterpartyRole: null });
  assert.equal(res.status, 200);
  const fresh = await Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, null);
});

test('PATCH /api/transactions/:id rejects transfer_purpose vocabulary', async () => {
  // owner_draw belongs to transfer_purpose — a different column answering a
  // different question. Accepting it here would silently cross the two.
  const res = await patchTransaction(txnId, { counterpartyRole: 'owner_draw' });
  assert.equal(res.status, 400);
  const fresh = await Transaction.findByPk(txnId);
  assert.equal(fresh?.counterpartyRole, null, 'a rejected patch must not write');
});

test('a retag is recorded in the audit log', async () => {
  await patchTransaction(txnId, { counterpartyRole: 'repayment' });
  const entry = await AuditLog.findOne({
    where: { entityType: 'transaction', entityId: txnId },
    order: [['createdAt', 'DESC']],
  });
  assert.ok(entry, 'untraceable retags are what made this audit necessary');
  assert.match(JSON.stringify(entry?.after), /counterpartyRole/);
});

test('PATCH /api/contacts/:id sets loanDefault', async () => {
  const res = await patchContact(contactId, { loanDefault: true });
  assert.equal(res.status, 200);
  const fresh = await Contact.findByPk(contactId);
  assert.equal(fresh?.loanDefault, true);
});

test('PATCH /api/contacts/:id rejects a non-boolean loanDefault', async () => {
  const res = await patchContact(contactId, { loanDefault: 'maybe' });
  assert.equal(res.status, 400);
});

test('GET /api/contacts returns loanDefault so the list can render the toggle', async () => {
  await patchContact(contactId, { loanDefault: true });
  const res = await getContacts();
  const row = res.body.find((c: { id: number }) => c.id === contactId);
  assert.equal(row.loanDefault, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/routes/counterpartyRolePatch.test.ts
```

Expected: FAIL — `counterpartyRole` is not a patchable field, so it is silently ignored and `fresh.counterpartyRole` stays null; `loanDefault` likewise, and it is absent from the contact list projection.

- [ ] **Step 3: Add `counterpartyRole` to the transaction patch**

In `backend/src/routes/transactions.ts`, add `'counterpartyRole'` to the patchable-field list beside `'counterpartyContactId'`, then add a validation branch beside the `counterpartyContactId` branch:

```ts
      } else if (k === 'counterpartyRole') {
        if (b[k] == null || b[k] === '') {
          txn.set('counterpartyRole', null);
        } else if (isCounterpartyRole(b[k])) {
          txn.set('counterpartyRole', b[k]);
        } else {
          const err = new Error(
            'counterpartyRole must be one of: ' + COUNTERPARTY_ROLES.join(', '),
          ) as Error & { status?: number };
          err.status = 400;
          throw err;
        }
```

Import at the top:

```ts
import { COUNTERPARTY_ROLES, isCounterpartyRole } from '../contacts/counterpartyRole';
```

Add `'counterpartyRole'` to `AUDIT_DIFF_FIELDS` so a retag is traceable — the audit gap on contact tagging is what made this session's provenance work necessary.

- [ ] **Step 4: Add `loanDefault` to the contact patch**

In `backend/src/routes/contacts.ts`, inside `router.patch('/:id', ...)`, beside the `isSelf` branch:

```ts
    if (b.loanDefault !== undefined) {
      const parsed = coerceBool(b.loanDefault);
      if (parsed === null) {
        res.status(400).json({ error: 'loanDefault must be boolean' });
        return;
      }
      row.set('loanDefault', parsed);
    }
```

Also add `loanDefault: r.loanDefault` to the `GET /` contact list projection so the frontend can render the toggle without a second fetch.

- [ ] **Step 5: Run typecheck and the suite**

```bash
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

Expected: clean, green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/transactions.ts backend/src/routes/contacts.ts backend/src/routes/counterpartyRolePatch.test.ts
git commit -m "feat(api): patch counterpartyRole on transactions and loanDefault on contacts"
```

---

### Task 7: Frontend

**Files:**
- Modify: `frontend/src/lib/api.ts` (add two client calls)
- Modify: `frontend/src/pages/PeopleLedgerPage.tsx` (metrics, bar, transfer table, contact header)
- Modify: `frontend/src/pages/PeopleLedgerPage.test.tsx`
- Modify: `frontend/src/lib/peopleLedger.ts` and `frontend/src/lib/peopleLedger.test.ts`

**Interfaces:**
- Consumes: `ContactLedgerResponse`, `LoanBalance`, `CounterpartyRole` (Task 5); the endpoints from Task 6.
- Produces: no exports other tasks depend on.

- [ ] **Step 1: Write the failing label test**

In `frontend/src/lib/peopleLedger.test.ts`, add:

```ts
import { formatBalanceLabel, formatNetFlowLabel } from './peopleLedger'

test('a positive balance means they owe you', () => {
  expect(formatBalanceLabel({ currency: 'CAD', lent: '3648.0000', repaid: '0.0000', balance: '3648.0000' }))
    .toBe('CAD 3648.00 owed to you')
})

test('a negative balance means you owe them', () => {
  expect(formatBalanceLabel({ currency: 'CAD', lent: '3648.0000', repaid: '3904.1700', balance: '-256.1700' }))
    .toBe('CAD 256.17 you owe')
})

test('a zero balance is settled', () => {
  expect(formatBalanceLabel({ currency: 'CAD', lent: '40.0000', repaid: '40.0000', balance: '0.0000' }))
    .toBe('CAD 0.00 settled')
})

test('net flow carries no owed or owe claim', () => {
  expect(formatNetFlowLabel({ currency: 'CAD', sent: '117506.17', received: '73871.32', net: '43634.85' }))
    .toBe('CAD 43634.85 net out')
  expect(formatNetFlowLabel({ currency: 'CAD', sent: '0.00', received: '8425.00', net: '-8425.00' }))
    .toBe('CAD 8425.00 net in')
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn workspace frontend run test peopleLedger
```

Expected: FAIL — `formatBalanceLabel` and `formatNetFlowLabel` are not exported.

- [ ] **Step 3: Implement the labels**

Replace `frontend/src/lib/peopleLedger.ts`:

```ts
import type { LoanBalance, TransferNet } from '@cashflow/shared'

/** Human label for a signed loan balance. Positive: they owe you. */
export function formatBalanceLabel(b: LoanBalance): string {
  const v = Number(b.balance)
  const abs = Math.abs(v).toFixed(2)
  const label = v > 0 ? 'owed to you' : v < 0 ? 'you owe' : 'settled'
  return `${b.currency} ${abs} ${label}`
}

/**
 * Human label for raw flow. Deliberately says nothing about debt — this is a
 * description of movement, and calling it "owed" is the bug this page had.
 */
export function formatNetFlowLabel(n: TransferNet): string {
  const v = Number(n.net)
  const abs = Math.abs(v).toFixed(2)
  const label = v >= 0 ? 'net out' : 'net in'
  return `${n.currency} ${abs} ${label}`
}
```

Delete `formatNetLabel` and update its call sites in `PeopleLedgerPage.tsx`.

- [ ] **Step 4: Run it to verify it passes**

```bash
yarn workspace frontend run test peopleLedger
```

Expected: PASS.

- [ ] **Step 5: Rewire the page**

> This is the one step in the plan specified as a change list rather than as
> literal code. `PeopleLedgerPage.tsx` is a large existing component and the
> edits are localised to functions the implementer must read in place. Read the
> whole file before starting, and follow the existing Tailwind + design-system
> idiom rather than introducing new styling — the DS is used as-is, never
> overridden via `className`.

In `frontend/src/pages/PeopleLedgerPage.tsx`:

- `deriveMetrics` sums `ledger.loanBalance` across **every** currency instead of picking CAD, and returns `Map<string, number>` keyed by currency. The landing headline renders one metric per currency. This removes the silent drop of Stephen's USD −3,570.51.
- `computeBarSegments` reads `loanBalance` rather than `transferNet`, and returns null when the contact has no balance so non-lending contacts render net flow text only.
- The transfer table gains a role `<select>` per row, options `COUNTERPARTY_ROLES` plus an empty "auto" entry, calling `setCounterpartyRole(txn.id, value)` and reloading the ledger.
- A row with `cancelled: true` renders struck-through with the title "cancelled e-transfer pair".
- A row with `roleMismatch: true` renders a warning badge reading "tag disagrees with direction".
- The contact header gains a `loanDefault` toggle calling `setContactLoanDefault(contact.id, next)`.
- `TRANSFER_COL_COUNT` goes from 5 to 6 for the new column.

In `frontend/src/lib/api.ts`:

```ts
export function setCounterpartyRole(txnId: number, role: CounterpartyRole | null): Promise<unknown> {
  return patchJson(`/api/transactions/${txnId}`, { counterpartyRole: role })
}
export function setContactLoanDefault(id: number, loanDefault: boolean): Promise<unknown> {
  return patchJson(`/api/contacts/${id}`, { loanDefault })
}
```

- [ ] **Step 6: Update the page test**

In `frontend/src/pages/PeopleLedgerPage.test.tsx`, update the mocked `ContactLedgerResponse` fixtures to include `loanDefault`, `loanBalance`, and the new row fields. Add a test asserting a contact whose `loanBalance` is `[]` renders no owed/owe language.

- [ ] **Step 7: Run frontend checks**

```bash
yarn workspace frontend run test
yarn workspace frontend run lint
```

Expected: green, clean.

- [ ] **Step 8: Full CI and commit**

```bash
yarn ci
git add frontend/src shared
git commit -m "feat(people): lead with the signed loan balance, show raw bank text"
```

---

### Task 8: Place Reimbursement in the primitives spine

**Files:**
- Modify: `docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md:69` (the Expectation row of the fold table)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

`Reimbursement` appears nowhere in the spine spec's fold table, so there is no
written answer to "which primitive owns a loan owed to you". This design settles
it; the spec should say so, or the next person adding a loan-shaped model has to
re-derive it.

- [ ] **Step 1: Amend the Expectation row**

In the fold table, extend the Expectation row's "Folds (current models)" cell to
include `Reimbursement`, and append to the cell:

```
Reimbursement (a loan owed to you is expected money movement: expected → received → waived mirrors planned → posted → cancelled)
```

- [ ] **Step 2: Verify the table still renders**

```bash
grep -n "Expectation" docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md
```

Expected: the row still has the same number of `|` separators as its neighbours.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-05-30-cashflow-primitives-design.md
git commit -m "docs(spine): place Reimbursement under the Expectation primitive"
```

---

## Post-implementation

After merge and deploy, set the production defaults — these are data, not code:

```sql
UPDATE contacts SET loan_default = TRUE  WHERE id IN (1, 2);  -- Caelan, Evan
UPDATE contacts SET loan_default = FALSE WHERE id = 4;        -- Stephen (tag his few real loans individually)
```

Then tag the known exceptions:

```sql
UPDATE transactions SET counterparty_role = 'business' WHERE id IN (11700, 11701);  -- CDG Labs payout split
UPDATE transactions SET counterparty_role = 'purchase' WHERE id = 11314;            -- chair, Chexy leg
```

Transaction `5392` (−4,550.00, 2025-05-05) stays untagged until Connor resolves what it was — see the spec's open question. Untagged with `loan_default = true` means it currently counts as a loan, which is the conservative reading.
