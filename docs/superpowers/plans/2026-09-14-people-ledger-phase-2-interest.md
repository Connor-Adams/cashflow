# People Ledger Phase 2: LoC interest allocation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split the line-of-credit interest Connor actually paid across the people whose outstanding balances caused it.

**Architecture:** Line-of-credit interest charges get tagged `loc_interest` on the existing `counterparty_role` column. An allocator walks each tagged charge, computes every lending contact's outstanding balance **as of that charge's date**, and writes `Reimbursement` rows with `kind='interest'` keyed to the source charge. The ledger's balance then includes allocated interest alongside principal.

**Tech Stack:** Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx` for backend, Vite + React 19 + vitest for frontend, DTOs in `shared/api-types.ts`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-14-people-ledger-loan-accounting-design.md`, "Interest allocation".
- Phase 1 shipped: `transactions.counterparty_role`, `contacts.loan_default`, `computeLoanBalance`, `resolveLedgerRole`, `findCancelledTransferIds`, and a ledger route returning `loanBalance`.
- Migrations are JavaScript in `backend/src/migrations/`, named `YYYYMMDD...-slug.js`, and must run on **both** SQLite and Postgres.
- Migration tests live in `backend/src/migrations/__tests__/`, never in `src/migrations/`.
- Unit tests are colocated: `foo.test.ts` beside `foo.ts` under `backend/src/`.
- Money math uses integer arithmetic scaled by `10_000`, matching `computeLoanBalance` and `computeTransferNet`. Never accumulate floats.
- DTO amounts are strings fixed to 4 decimal places, dialect-independent (`Number(x).toFixed(4)`).
- **Grep `backend/test/` as well as `backend/src` before deleting or changing any shared behaviour.** `yarn workspace cashflow-backend run test` is unit-only; the integration tier is a separate required CI gate.
- Never touch `transactions.transfer_purpose` — a different column with a different vocabulary.
- Allocated interest is **derived**. Re-running the allocator must recompute, never accumulate.

## Production facts this must handle

15 `LOAN INTEREST` charges on `RBC Day to Day Banking 6985`, totalling **662.58**, from 2023-12-05 to 2026-07-06. Five of them (2023-12 to 2025-09) predate any tagged loan and must allocate nothing. Current tagged principal: `STEPHEN MASSEUR` 6,700.00 CAD (one `loan` row dated 2026-04-15) and `Caelan Iten-McGrath` 26,438.58 CAD (untagged rows under `loan_default = true`).

---

### Task 1: Schema — `kind` and `source_transaction_id` on reimbursements

**Files:**
- Create: `backend/src/migrations/20260916000001-reimbursement-interest-rows.js`
- Create: `backend/src/migrations/__tests__/reimbursementInterestRows.test.ts`
- Modify: `backend/src/models/Reimbursement.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Reimbursement.kind: 'principal' | 'interest'`, `Reimbursement.sourceTransactionId: number | null`.

- [ ] **Step 1: Write the failing migration test**

Create `backend/src/migrations/__tests__/reimbursementInterestRows.test.ts`:

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
  await qi.createTable('reimbursements', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    transaction_id: { type: DataTypes.INTEGER, allowNull: false },
    contact_id: { type: DataTypes.INTEGER, allowNull: true },
    amount: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, created_at, updated_at)
    VALUES (1, 1, 100, 4, 500.0000, 'CAD', 'expected', datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260916000001-reimbursement-interest-rows.js');
});
after(async () => { await sequelize.close(); });

test('up defaults existing rows to principal with no source', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query('SELECT kind, source_transaction_id FROM reimbursements WHERE id = 1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (rows as any[])[0];
  assert.equal(r.kind, 'principal', 'pre-existing claims are principal, not interest');
  assert.equal(r.source_transaction_id, null);
});

test('the unique index rejects two interest rows for the same charge and contact', async () => {
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, kind, source_transaction_id, created_at, updated_at)
    VALUES (2, 1, 200, 4, 12.3400, 'CAD', 'expected', 'interest', 999, datetime('now'), datetime('now'))`);
  await sequelize.query(`INSERT INTO reimbursements
    (id, household_id, transaction_id, contact_id, amount, currency, status, kind, source_transaction_id, created_at, updated_at)
    VALUES (3, 1, 201, 4, 12.3400, 'CAD', 'expected', 'interest', 999, datetime('now'), datetime('now'))`).then(
    () => assert.fail('expected a unique-index violation — re-running the allocator must not double-charge'),
    () => { /* expected */ },
  );
});

test('down removes both columns and the index', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.equal(desc.kind, undefined);
  assert.equal(desc.source_transaction_id, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/reimbursementInterestRows.test.ts
```

Expected: FAIL — cannot find the migration module.

- [ ] **Step 3: Write the migration**

Create `backend/src/migrations/20260916000001-reimbursement-interest-rows.js`:

```js
'use strict';

/**
 * People ledger phase 2. Lets a Reimbursement represent allocated line-of-credit
 * interest as well as principal.
 *
 *   - kind STRING(16) NOT NULL DEFAULT 'principal': 'principal' | 'interest'.
 *     Existing rows are principal by definition — they were hand-logged claims.
 *   - source_transaction_id INTEGER NULL: the LOAN INTEREST charge an interest
 *     row was derived from. Null for principal rows.
 *
 * The partial unique index on (source_transaction_id, contact_id) is what makes
 * the allocator idempotent: re-running it recomputes rather than stacking a
 * second charge on the same contact for the same month. Partial so the many
 * principal rows, which share a null source, do not collide.
 *
 * Spine note: discriminator + provenance fields on the existing Expectation
 * primitive (physical table `reimbursements`). No new primitive.
 *
 * Dialect-agnostic: runs on SQLite and Postgres.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('reimbursements', 'kind', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'principal',
    });
    await queryInterface.addColumn('reimbursements', 'source_transaction_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex('reimbursements', ['source_transaction_id', 'contact_id'], {
      unique: true,
      name: 'idx_reimbursements_interest_source',
      where: { source_transaction_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('reimbursements', 'idx_reimbursements_interest_source');
    await queryInterface.removeColumn('reimbursements', 'source_transaction_id');
    await queryInterface.removeColumn('reimbursements', 'kind');
  },
};
```

If the partial-index `where` clause does not work on SQLite through `addIndex`, fall back to a raw `CREATE UNIQUE INDEX ... WHERE source_transaction_id IS NOT NULL` issued per dialect, and say so in your report. Do NOT drop the partial condition — a plain unique index would collide on the null-source principal rows.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/reimbursementInterestRows.test.ts
```

Expected: PASS, 3/3.

- [ ] **Step 5: Add the model fields**

In `backend/src/models/Reimbursement.ts`, beside the existing declarations:

```ts
  /**
   * `principal` for a hand-logged claim; `interest` for a row the LoC interest
   * allocator derived. Interest rows are generated — never edit them by hand,
   * they are recomputed on the next allocator run.
   */
  declare kind: CreationOptional<string>;
  /** The LOAN INTEREST transaction this interest row was apportioned from. */
  declare sourceTransactionId: CreationOptional<number | null>;
```

and in the column block:

```ts
      kind: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'principal',
      },
      sourceTransactionId: {
        type: DataTypes.INTEGER,
        field: 'source_transaction_id',
        allowNull: true,
      },
```

- [ ] **Step 6: Typecheck, run the reimbursement tests, commit**

```bash
yarn workspace cashflow-backend run typecheck
cd backend && yarn tsx --import ./test/setup.ts --test src/reimbursements/*.test.ts
```

```bash
git add backend/src/migrations/20260916000001-reimbursement-interest-rows.js backend/src/migrations/__tests__/reimbursementInterestRows.test.ts backend/src/models/Reimbursement.ts
git commit -m "feat(reimbursements): carry allocated interest alongside principal"
```

---

### Task 2: The allocator

**Files:**
- Create: `backend/src/contacts/interestAllocation.ts`
- Create: `backend/src/contacts/interestAllocation.test.ts`

**Interfaces:**
- Consumes: `resolveLedgerRole` from `backend/src/contacts/counterpartyRole.ts`.
- Produces:
  - `interface InterestCharge { id: number; date: string; amount: string | number; currency: string }`
  - `interface LedgerRow { contactId: number; date: string; amount: string | number; currency: string; counterpartyRole: string | null; loanDefault: boolean }`
  - `interface InterestAllocation { sourceTransactionId: number; contactId: number; currency: string; amount: string }`
  - `allocateInterest(charges: InterestCharge[], rows: LedgerRow[]): InterestAllocation[]`

- [ ] **Step 1: Write the failing test**

Create `backend/src/contacts/interestAllocation.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateInterest } from './interestAllocation';

const stephen = (over: Partial<{ date: string; amount: number; counterpartyRole: string | null }> = {}) => ({
  contactId: 4, currency: 'CAD', loanDefault: false,
  date: '2026-04-15', amount: -6700, counterpartyRole: 'loan' as string | null, ...over,
});
const caelan = (over: Partial<{ date: string; amount: number; counterpartyRole: string | null }> = {}) => ({
  contactId: 1, currency: 'CAD', loanDefault: true,
  date: '2025-08-14', amount: -1150, counterpartyRole: null as string | null, ...over,
});

test('a charge with no outstanding balance allocates nothing', () => {
  const out = allocateInterest(
    [{ id: 900, date: '2023-12-05', amount: -1.32, currency: 'CAD' }],
    [stephen()],
  );
  assert.deepEqual(out, [], 'the loan postdates the charge — that interest is Connor\'s own');
});

test('a single outstanding balance takes the whole charge', () => {
  const out = allocateInterest(
    [{ id: 901, date: '2026-05-05', amount: -80.9, currency: 'CAD' }],
    [stephen()],
  );
  assert.deepEqual(out, [
    { sourceTransactionId: 901, contactId: 4, currency: 'CAD', amount: '80.9000' },
  ]);
});

test('two balances split pro rata and the parts sum to the charge exactly', () => {
  const out = allocateInterest(
    [{ id: 902, date: '2026-05-05', amount: -100, currency: 'CAD' }],
    [stephen(), caelan({ amount: -3300 })],
  );
  const total = out.reduce((n, a) => n + Number(a.amount), 0);
  assert.equal(Number(total.toFixed(4)), 100, 'allocations must sum to the charge');
  const byContact = Object.fromEntries(out.map((a) => [a.contactId, a.amount]));
  assert.equal(byContact[4], '67.0000', '6700 of 10000');
  assert.equal(byContact[1], '33.0000', '3300 of 10000');
});

test('the rounding remainder goes to the largest balance, never lost', () => {
  const out = allocateInterest(
    [{ id: 903, date: '2026-05-05', amount: -10, currency: 'CAD' }],
    [stephen({ amount: -2 }), caelan({ amount: -1 })],
  );
  const total = out.reduce((n, a) => n + Number(a.amount), 0);
  assert.equal(Number(total.toFixed(4)), 10);
});

test('balance is measured as of the charge date, not today', () => {
  const out = allocateInterest(
    [{ id: 904, date: '2026-04-01', amount: -50, currency: 'CAD' }],
    [stephen(), caelan({ date: '2025-08-14', amount: -1000 })],
  );
  assert.deepEqual(out, [
    { sourceTransactionId: 904, contactId: 1, currency: 'CAD', amount: '50.0000' },
  ], 'Stephen\'s loan is dated 2026-04-15, after this charge');
});

test('repayments before the charge reduce the weight', () => {
  const out = allocateInterest(
    [{ id: 905, date: '2026-06-05', amount: -90, currency: 'CAD' }],
    [
      stephen(),
      stephen({ date: '2026-05-01', amount: 3700, counterpartyRole: 'repayment' }),
      caelan({ amount: -3000 }),
    ],
  );
  const byContact = Object.fromEntries(out.map((a) => [a.contactId, a.amount]));
  assert.equal(byContact[4], '30.0000', '6700 - 3700 = 3000 of 6000');
  assert.equal(byContact[1], '60.0000');
});

test('non-debt roles never earn interest weight', () => {
  const out = allocateInterest(
    [{ id: 906, date: '2026-05-05', amount: -40, currency: 'CAD' }],
    [stephen({ counterpartyRole: 'purchase' }), caelan({ amount: -500 })],
  );
  assert.deepEqual(out, [
    { sourceTransactionId: 906, contactId: 1, currency: 'CAD', amount: '40.0000' },
  ]);
});

test('a negative balance earns no interest', () => {
  const out = allocateInterest(
    [{ id: 907, date: '2026-05-05', amount: -25, currency: 'CAD' }],
    [
      stephen({ amount: 500, counterpartyRole: 'repayment' }),
      caelan({ amount: -1000 }),
    ],
  );
  assert.deepEqual(out, [
    { sourceTransactionId: 907, contactId: 1, currency: 'CAD', amount: '25.0000' },
  ], 'you cannot charge interest to someone you owe');
});

test('currencies are allocated independently', () => {
  const out = allocateInterest(
    [{ id: 908, date: '2026-05-05', amount: -30, currency: 'CAD' }],
    [stephen(), { ...caelan(), currency: 'USD', amount: -6700 }],
  );
  assert.deepEqual(out, [
    { sourceTransactionId: 908, contactId: 4, currency: 'CAD', amount: '30.0000' },
  ], 'a CAD charge is not shared with a USD balance');
});

test('re-running over the same inputs is stable', () => {
  const charges = [{ id: 909, date: '2026-05-05', amount: -80.9, currency: 'CAD' }];
  const rows = [stephen(), caelan({ amount: -3300 })];
  assert.deepEqual(allocateInterest(charges, rows), allocateInterest(charges, rows));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/interestAllocation.test.ts
```

Expected: FAIL — cannot find module `./interestAllocation`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/contacts/interestAllocation.ts`. Requirements the tests pin:

- For each charge, in date order, compute every contact's outstanding balance **from rows dated on or before the charge date**, per currency, reusing `resolveLedgerRole` so the loan/repayment/none decision is identical to `computeLoanBalance`'s.
- Only positive balances earn weight; a contact you owe earns nothing.
- Only rows in the **charge's own currency** participate.
- Weight each contact by its balance; allocate in integer units scaled by `10_000`; give the rounding remainder to the largest balance so the parts sum to the charge exactly.
- A charge with no positive balance in its currency yields no allocations.
- Output sorted deterministically by `contactId` so re-runs are byte-identical.
- Amounts are absolute values as fixed-4 strings.

Do not accumulate floats. Do not import `computeLoanBalance` — it folds all dates at once and has no date cutoff; share `resolveLedgerRole` instead.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/interestAllocation.test.ts
```

Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contacts/interestAllocation.ts backend/src/contacts/interestAllocation.test.ts
git commit -m "feat(contacts): apportion line-of-credit interest across outstanding balances"
```

---

### Task 3: Persist the allocation and expose it

**Files:**
- Create: `backend/src/contacts/runInterestAllocation.ts`
- Create: `backend/src/routes/interestAllocation.test.ts`
- Modify: `backend/src/routes/contacts.ts` (the `GET /:id/ledger` handler; add `POST /api/contacts/interest-allocation`)
- Modify: `shared/api-types.ts` (extend `ContactLedgerResponse`)

**Interfaces:**
- Consumes: `allocateInterest` (Task 2); `Reimbursement.kind` / `.sourceTransactionId` (Task 1).
- Produces:
  - `runInterestAllocation({ householdId, dryRun }): Promise<{ charges: number; allocations: number; totalAllocated: string; dryRun: boolean }>`
  - `ContactLedgerResponse.interestBalance: LoanBalance[]` and `POST /api/contacts/interest-allocation`.

- [ ] **Step 1: Write the failing route test**

Reuse the app/auth bootstrap from `backend/src/routes/contactsLedger.test.ts`. Create `backend/src/routes/interestAllocation.test.ts` seeding, in one household: a contact with `loan_default = false`, one `-6700` transaction tagged `loan` dated `2026-04-15`, and two transactions on a chequing account tagged `loc_interest` — one dated `2026-03-05` for `-17.24` and one dated `2026-05-05` for `-80.90`.

```ts
test('POST allocates only charges that postdate an outstanding balance', async () => {
  const res = await postAllocation();
  assert.equal(res.status, 200);
  assert.equal(res.body.allocations, 1, 'the March charge predates the loan');
  assert.equal(res.body.totalAllocated, '80.9000');
});

test('the allocation lands on the ledger as interest, separate from principal', async () => {
  await postAllocation();
  const res = await getLedger(contactId);
  const cad = res.body.interestBalance.find((b: { currency: string }) => b.currency === 'CAD');
  assert.equal(cad.balance, '80.9000');
  const principal = res.body.loanBalance.find((b: { currency: string }) => b.currency === 'CAD');
  assert.equal(principal.balance, '6700.0000', 'interest must not inflate principal');
});

test('re-running recomputes rather than double-charging', async () => {
  await postAllocation();
  await postAllocation();
  const res = await getLedger(contactId);
  const cad = res.body.interestBalance.find((b: { currency: string }) => b.currency === 'CAD');
  assert.equal(cad.balance, '80.9000', 'the unique index and the delete-then-write must hold');
});

test('dryRun reports what it would do and writes nothing', async () => {
  const res = await postAllocation({ dryRun: true });
  assert.equal(res.body.allocations, 1);
  const ledger = await getLedger(contactId);
  assert.deepEqual(ledger.body.interestBalance, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/routes/interestAllocation.test.ts
```

Expected: FAIL — the route does not exist.

- [ ] **Step 3: Write `runInterestAllocation`**

In `backend/src/contacts/runInterestAllocation.ts`:

- Load every transaction in the household tagged `counterparty_role = 'loc_interest'` as the charges.
- Load every transaction with a `counterparty_contact_id`, joined to its contact's `loanDefault`, as the rows.
- Call `allocateInterest`.
- In a transaction: delete existing `reimbursements` rows where `kind='interest'` and `source_transaction_id` is in the charge id set, then insert the new allocations with `kind='interest'`, `status='expected'`, `transactionId` = the source charge, `sourceTransactionId` = the source charge, `contactId`, `amount`, `currency`.
- Delete-then-insert is what makes a re-run recompute. The unique index is the backstop, not the mechanism.
- `dryRun` returns the same counts without writing.
- Mirror the `ProviderJobLog` + in-flight-guard pattern from `backend/src/import/transferContactLink.ts` so two concurrent runs cannot interleave.

- [ ] **Step 4: Wire the route and the DTO**

Add `POST /api/contacts/interest-allocation` accepting `{ dryRun?: boolean }`. Extend `ContactLedgerResponse` with `interestBalance: LoanBalance[]`, computed in the ledger handler from that contact's `kind='interest'` reimbursement rows, per currency. Keep `loanBalance` principal-only — the tests above pin that separation.

- [ ] **Step 5: Run the tests and the full backend suite**

```bash
cd backend && yarn tsx --import ./test/setup.ts --test src/routes/interestAllocation.test.ts
yarn workspace cashflow-backend run typecheck
yarn workspace cashflow-backend run test
```

Also grep `backend/test/integration/` for anything asserting the `ContactLedgerResponse` shape and update it.

- [ ] **Step 6: Commit**

```bash
git add backend/src/contacts/runInterestAllocation.ts backend/src/routes/interestAllocation.test.ts backend/src/routes/contacts.ts shared/api-types.ts
git commit -m "feat(contacts): persist and serve allocated line-of-credit interest"
```

---

### Task 4: Surface interest in the UI

**Files:**
- Modify: `frontend/src/pages/PeopleLedgerPage.tsx`
- Modify: `frontend/src/pages/PeopleLedgerPage.test.tsx`
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Consumes: `ContactLedgerResponse.interestBalance`; `POST /api/contacts/interest-allocation`.

- [ ] **Step 1: Write the failing test**

In `PeopleLedgerPage.test.tsx`, add fixtures carrying `interestBalance` and assert:
- the contact row shows principal and interest as distinct figures, never summed into one unlabelled number;
- a contact with no interest shows no interest element rather than `CAD 0.00`;
- the total owed states principal and interest separately.

- [ ] **Step 2: Run it to verify it fails**

```bash
yarn workspace frontend run test PeopleLedgerPage
```

- [ ] **Step 3: Implement**

Render interest beside the loan balance with its own caption naming where it came from — apportioned from line-of-credit interest actually paid, not a modelled rate. Add a "Reallocate interest" action calling the new endpoint and reloading.

Project rules: design system used as-is, never restyled via `className`; Tailwind variant classes must be literal strings in lookup tables; only a balance may carry debt language.

- [ ] **Step 4: Verify**

```bash
yarn workspace frontend run test
yarn workspace frontend run lint
TEST_DATABASE_URL="postgres://postgres@127.0.0.1:55432/cashflow_test" yarn ci
```

`yarn ci` includes the integration tier and needs Postgres. If none is running, start a throwaway cluster — `initdb` into a scratch dir and launch with `-c unix_socket_directories=''` (the default socket path is over the 103-byte limit). Do not claim a run you did not perform.

- [ ] **Step 5: Commit**

```bash
git add frontend/src shared
git commit -m "feat(people): show apportioned line-of-credit interest beside principal"
```

---

## Post-implementation

Tag the 15 `LOAN INTEREST` charges and run the allocator:

```sql
UPDATE transactions SET counterparty_role = 'loc_interest', updated_at = now()
WHERE merchant_raw ILIKE 'loan interest' AND amount < 0 AND household_id = 1;
```

Then `POST /api/contacts/interest-allocation` with `{"dryRun": true}` first and check the counts before committing the write.

Expect the five charges from 2023-12 to 2025-09 to allocate nothing — they predate every tagged loan. Of the 662.58 total, only the portion after the first outstanding balance is apportionable; the rest was Connor's own borrowing cost.

## Known gap

The `RBC Royal Credit Line` account is missing every transaction between 2025-11-26 and 2026-05-08, including the 6,700 advance that funded the Stephen loan (visible only on the chequing side as `ONLINE BANKING TRANSFER - 0819`, 2026-04-16). The allocator does not read the LoC balance — it apportions the charges themselves by who owed what — so the gap does not affect its arithmetic. It does mean the LoC account balance shown elsewhere in the app is understated by at least 6,700.
