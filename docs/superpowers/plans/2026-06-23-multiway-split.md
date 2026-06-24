# Multiway transaction split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class "split this transaction among self + N people" action that mints one Reimbursement claim per other participant (payer fronts, others owe back).

**Architecture:** No new primitive. A multiway split is an *operation* on a Transaction that derives a set of `reimbursements` rows. A new `reimbursements.from_split` boolean marks split-generated claims so re-splitting replaces them idempotently. Two new endpoints (`POST`/`DELETE /api/transactions/:id/split`) sit in the existing reimbursements router; the share math is a pure, unit-tested helper. The frontend extends the existing split editor with a `multiway` mode.

**Tech Stack:** Backend — Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx`. Frontend — React 19 + Vite + vitest, design-system primitives. Shared DTOs in `shared/api-types.ts` (`@cashflow/shared`).

## Global Constraints

- Run all commands from the **repo root**: `/Users/connoradams/Developer/cashflow/.claude/worktrees/awesome-bardeen-3f4c49`.
- Backend unit tests are **colocated** (`foo.test.ts` beside `foo.ts` under `backend/src/`). Migration tests live in `backend/src/migrations/__tests__/`. Route/integration tests needing Postgres live in `backend/test/integration/`.
- Write Sequelize that runs on **both** SQLite and Postgres.
- Money columns are `DECIMAL(14,4)`; serialize amounts as fixed-4 strings (`toFixed(4)`).
- Claim amounts are rounded to **2 decimals** then stored as fixed-4 (e.g. `100.90` → `"100.9000"`), matching existing claim data.
- A multiway split sets the txn to `ownership_type='me'` / `final_split_type='me'` — it must NOT leave the txn in the partner `shared` pool.
- Self never gets a claim. Participants are Contacts; "me" is the implicit remainder holder.
- Commit messages: no `Co-Authored-By` / attribution trailers. Commit with `--no-verify` is acceptable in this worktree (husky/lint-staged can't run without local `node_modules`); otherwise prefix git with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH`.

---

### Task 1: `from_split` column — migration, model field, migration test

**Files:**
- Create: `backend/src/migrations/20260623000001-add-reimbursements-from-split.js`
- Create: `backend/src/migrations/__tests__/reimbursementsFromSplitMigration.test.ts`
- Modify: `backend/src/models/Reimbursement.ts` (add `fromSplit` declaration ~line 56 and init field ~line 104)

**Interfaces:**
- Produces: `reimbursements.from_split` BOOLEAN NOT NULL DEFAULT false; Sequelize attribute `fromSplit: boolean`.

- [ ] **Step 1: Write the failing migration test**

Create `backend/src/migrations/__tests__/reimbursementsFromSplitMigration.test.ts`:

```ts
/**
 * Round-trip test for migration 20260623000001-add-reimbursements-from-split.
 * In-memory SQLite: stub parents, create the base reimbursements table, run the
 * add-column migration up/down.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

let sequelize: Sequelize;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let base: { up: (...a: any[]) => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let migration: { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const qi = sequelize.getQueryInterface();
  for (const t of ['households', 'users', 'contacts', 'transactions']) {
    await qi.createTable(t, { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true } });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  base = require('../20260607000000-create-reimbursements.js');
  await base.up(qi, Sequelize);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../20260623000001-add-reimbursements-from-split.js');
});

after(async () => { await sequelize.close(); });

test('up adds from_split with default false', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.ok('from_split' in cols, 'expected from_split column');
  await sequelize.query(`INSERT INTO households (id) VALUES (1)`);
  await sequelize.query(`INSERT INTO transactions (id) VALUES (1)`);
  await sequelize.query(
    `INSERT INTO reimbursements (household_id, transaction_id, amount, currency, status, created_at, updated_at)
     VALUES (1, 1, '5.0000', 'CAD', 'expected', datetime('now'), datetime('now'))`,
  );
  const [rows] = (await sequelize.query(
    `SELECT from_split FROM reimbursements WHERE household_id = 1`,
  )) as [{ from_split: number }[], unknown];
  assert.equal(Number(rows[0]?.from_split), 0, 'default should be false/0');
});

test('down removes from_split', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const cols = await sequelize.getQueryInterface().describeTable('reimbursements');
  assert.ok(!('from_split' in cols), 'from_split should be gone');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/reimbursementsFromSplitMigration.test.ts`
Expected: FAIL — `Cannot find module '../20260623000001-add-reimbursements-from-split.js'`.

- [ ] **Step 3: Write the migration**

Create `backend/src/migrations/20260623000001-add-reimbursements-from-split.js`:

```js
'use strict';

/**
 * Add `from_split` to reimbursements: marks a claim created by the multiway
 * transaction-split action (vs. a manually-created claim). Lets the split
 * action replace only its own claims when a transaction is re-split, leaving
 * ad-hoc claims untouched. Boolean NOT NULL default false (existing rows
 * backfill to false).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('reimbursements', 'from_split', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('reimbursements', 'from_split');
  },
};
```

- [ ] **Step 4: Run the migration test, verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/migrations/__tests__/reimbursementsFromSplitMigration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the model attribute**

In `backend/src/models/Reimbursement.ts`, add after the `notes` declaration (~line 62):

```ts
  /** True when this claim was generated by the multiway split action. */
  declare fromSplit: CreationOptional<boolean>;
```

And in the `Reimbursement.init({...})` attribute map, after the `notes` attribute (~line 127):

```ts
      fromSplit: {
        type: DataTypes.BOOLEAN,
        field: 'from_split',
        allowNull: false,
        defaultValue: false,
      },
```

- [ ] **Step 6: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/migrations/20260623000001-add-reimbursements-from-split.js \
        backend/src/migrations/__tests__/reimbursementsFromSplitMigration.test.ts \
        backend/src/models/Reimbursement.ts
git commit --no-verify -m "feat(reimbursements): add from_split column for multiway split"
```

---

### Task 2: Share-math + request validator (pure helper)

**Files:**
- Create: `backend/src/reimbursements/splitShares.ts`
- Create: `backend/src/reimbursements/splitShares.test.ts`

**Interfaces:**
- Produces:
  - `type SplitMethod = 'even' | 'percent'`
  - `interface SplitParticipantInput { contactId: number; pct?: number }`
  - `interface SplitShare { contactId: number; amount: string }` — `amount` positive fixed-4.
  - `interface ComputedSplit { shares: SplitShare[]; selfAmount: string }`
  - `interface ValidSplitRequest { method: SplitMethod; participants: SplitParticipantInput[]; includeSelf: boolean }`
  - `type SplitValidation = { ok: true; value: ValidSplitRequest } | { ok: false; status: number; error: string }`
  - `function validateSplitRequest(raw: Record<string, unknown>): SplitValidation`
  - `function computeSplitShares(totalAbs: string | number, method: SplitMethod, participants: SplitParticipantInput[], includeSelf: boolean): ComputedSplit`

**Computation rules (deterministic):**
- `total = abs(Number(totalAbs))`. `round2(n) = Math.round(n * 100) / 100`. Store via `.toFixed(4)`.
- **even:** `N = participants.length + (includeSelf ? 1 : 0)`. Each contact `amount = round2(total / N)`.
  - `includeSelf=true`: `selfAmount = round2(total - sumShares)` (self absorbs the rounding remainder).
  - `includeSelf=false`: add `round2(total - sumShares)` to the **last** participant; `selfAmount = 0`.
- **percent:** each contact `amount = round2(total * pct / 100)`. `selfPct = 100 - Σpct`.
  - `selfPct <= 0`: add `round2(total - sumShares)` residual to the **last** participant; `selfAmount = 0`.
  - else: `selfAmount = round2(total - sumShares)`.

**Validation rules:**
- `method` must be `'even'` or `'percent'` → else `{status:400}`.
- `includeSelf` defaults to `true`; coerce only an explicit `false` to false.
- `participants` must be a non-empty array; each entry needs a positive-integer `contactId`; duplicate `contactId`s rejected.
- `percent`: each `pct` must be a finite number `> 0 && <= 100`; `Σpct <= 100` (allow exactly 100) → else `{status:400}`.
- `even`: `pct` is ignored.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/reimbursements/splitShares.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSplitRequest, computeSplitShares } from './splitShares';

test('even 3-way includes self: equal thirds, self absorbs remainder', () => {
  const r = computeSplitShares('302.71', 'even', [{ contactId: 3 }, { contactId: 7 }], true);
  assert.deepEqual(r.shares, [
    { contactId: 3, amount: '100.9000' },
    { contactId: 7, amount: '100.9000' },
  ]);
  assert.equal(r.selfAmount, '100.9100'); // 302.71 - 201.80
});

test('even exclude self: participants cover full total, residual on last', () => {
  const r = computeSplitShares('100.00', 'even', [{ contactId: 3 }, { contactId: 7 }, { contactId: 9 }], false);
  const sum = r.shares.reduce((a, s) => a + Number(s.amount), 0);
  assert.equal(sum.toFixed(2), '100.00');
  assert.equal(r.selfAmount, '0.0000');
});

test('percent: shares by pct, self gets remainder', () => {
  const r = computeSplitShares('200.00', 'percent', [{ contactId: 3, pct: 25 }, { contactId: 7, pct: 25 }], true);
  assert.deepEqual(r.shares, [
    { contactId: 3, amount: '50.0000' },
    { contactId: 7, amount: '50.0000' },
  ]);
  assert.equal(r.selfAmount, '100.0000');
});

test('percent summing to 100: self is zero, residual on last participant', () => {
  const r = computeSplitShares('100.00', 'percent', [{ contactId: 3, pct: 100 }], true);
  assert.equal(r.shares[0].amount, '100.0000');
  assert.equal(r.selfAmount, '0.0000');
});

test('amount sign is normalised (negative outlay -> positive shares)', () => {
  const r = computeSplitShares(-90, 'even', [{ contactId: 3 }, { contactId: 7 }], true);
  assert.equal(r.shares[0].amount, '30.0000');
});

test('validate: rejects bad method', () => {
  const v = validateSplitRequest({ method: 'wat', participants: [{ contactId: 1 }] });
  assert.equal(v.ok, false);
});

test('validate: rejects empty participants', () => {
  const v = validateSplitRequest({ method: 'even', participants: [] });
  assert.equal(v.ok, false);
});

test('validate: rejects duplicate contactId', () => {
  const v = validateSplitRequest({ method: 'even', participants: [{ contactId: 1 }, { contactId: 1 }] });
  assert.equal(v.ok, false);
});

test('validate: percent sum over 100 rejected', () => {
  const v = validateSplitRequest({ method: 'percent', participants: [{ contactId: 1, pct: 60 }, { contactId: 2, pct: 60 }] });
  assert.equal(v.ok, false);
});

test('validate: defaults includeSelf true, passes a good even body', () => {
  const v = validateSplitRequest({ method: 'even', participants: [{ contactId: 3 }, { contactId: 7 }] });
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.value.includeSelf, true);
    assert.equal(v.value.method, 'even');
  }
});

test('validate: explicit includeSelf false respected', () => {
  const v = validateSplitRequest({ method: 'even', participants: [{ contactId: 3 }], includeSelf: false });
  assert.ok(v.ok && v.value.includeSelf === false);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/reimbursements/splitShares.test.ts`
Expected: FAIL — cannot find `./splitShares`.

- [ ] **Step 3: Implement the helper**

Create `backend/src/reimbursements/splitShares.ts`:

```ts
/**
 * Pure share-math + request validation for the multiway transaction split.
 * No I/O — DB-touching checks (contact-in-household, is_self) live in the route.
 *
 * Semantics: the payer ("me") fronts the outlay; each *other* participant owes
 * a share back (one Reimbursement claim each). "me" never gets a claim — the
 * remainder is `selfAmount`. Amounts round to 2 decimals, stored fixed-4.
 */

export type SplitMethod = 'even' | 'percent';

export interface SplitParticipantInput {
  contactId: number;
  pct?: number;
}

export interface SplitShare {
  contactId: number;
  /** Positive fixed-4 string. */
  amount: string;
}

export interface ComputedSplit {
  shares: SplitShare[];
  /** The payer's remainder (fixed-4). '0.0000' when self is excluded. */
  selfAmount: string;
}

export interface ValidSplitRequest {
  method: SplitMethod;
  participants: SplitParticipantInput[];
  includeSelf: boolean;
}

export type SplitValidation =
  | { ok: true; value: ValidSplitRequest }
  | { ok: false; status: number; error: string };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeSplitShares(
  totalAbs: string | number,
  method: SplitMethod,
  participants: SplitParticipantInput[],
  includeSelf: boolean,
): ComputedSplit {
  const total = Math.abs(Number(totalAbs)) || 0;
  const shares: SplitShare[] = [];

  if (method === 'even') {
    const n = participants.length + (includeSelf ? 1 : 0);
    for (const p of participants) {
      shares.push({ contactId: p.contactId, amount: round2(total / n).toFixed(4) });
    }
  } else {
    for (const p of participants) {
      const pct = Number(p.pct ?? 0);
      shares.push({ contactId: p.contactId, amount: round2((total * pct) / 100).toFixed(4) });
    }
  }

  const sumShares = shares.reduce((a, s) => a + Number(s.amount), 0);
  const selfExcluded =
    (method === 'even' && !includeSelf) ||
    (method === 'percent' && 100 - participants.reduce((a, p) => a + Number(p.pct ?? 0), 0) <= 0);

  let selfAmount = '0.0000';
  if (selfExcluded) {
    // Residual cents go to the last participant so the shares sum to the total.
    const residual = round2(total - sumShares);
    if (shares.length > 0 && residual !== 0) {
      const last = shares[shares.length - 1];
      last.amount = round2(Number(last.amount) + residual).toFixed(4);
    }
  } else {
    selfAmount = round2(total - sumShares).toFixed(4);
  }

  return { shares, selfAmount };
}

export function validateSplitRequest(raw: Record<string, unknown>): SplitValidation {
  const method = raw.method;
  if (method !== 'even' && method !== 'percent') {
    return { ok: false, status: 400, error: "method must be 'even' or 'percent'" };
  }
  const includeSelf = raw.includeSelf === false ? false : true;

  if (!Array.isArray(raw.participants) || raw.participants.length === 0) {
    return { ok: false, status: 400, error: 'participants must be a non-empty array' };
  }

  const participants: SplitParticipantInput[] = [];
  const seen = new Set<number>();
  let pctSum = 0;
  for (const entry of raw.participants as unknown[]) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = Number(e.contactId);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, status: 400, error: 'each participant needs a positive integer contactId' };
    }
    if (seen.has(id)) {
      return { ok: false, status: 400, error: `duplicate contactId ${id}` };
    }
    seen.add(id);
    const p: SplitParticipantInput = { contactId: id };
    if (method === 'percent') {
      const pct = Number(e.pct);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return { ok: false, status: 400, error: 'each percent must be a number in (0, 100]' };
      }
      p.pct = pct;
      pctSum += pct;
    }
    participants.push(p);
  }

  if (method === 'percent' && pctSum > 100 + 1e-9) {
    return { ok: false, status: 400, error: 'percentages must sum to at most 100' };
  }

  return { ok: true, value: { method, participants, includeSelf } };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/reimbursements/splitShares.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/reimbursements/splitShares.ts backend/src/reimbursements/splitShares.test.ts
git commit --no-verify -m "feat(reimbursements): pure share-math + validator for multiway split"
```

---

### Task 3: Split endpoints (`POST`/`DELETE /api/transactions/:id/split`)

**Files:**
- Modify: `backend/src/routes/reimbursements.ts` (add two handlers + a `from_split=true` create path; reuse `contactInHousehold`)
- Modify: `backend/src/reimbursements/serialize.ts` (add `fromSplit` to `ReimbursementRow` ~line 396 and `ReimbursementView` ~line 372, set it in `serializeReimbursement` ~line 457)
- Create: `backend/test/integration/transactionSplit.test.ts`

**Interfaces:**
- Consumes: `validateSplitRequest`, `computeSplitShares` (Task 2); `Reimbursement.fromSplit` (Task 1); `recomputeTransactionAmounts` from `../import/calculateShares`.
- Produces:
  - `POST /api/transactions/:id/split` → `201 { transaction: { id, ownershipType, finalSplitType }, claims: ReimbursementView[] }`
  - `DELETE /api/transactions/:id/split` → `200 { transaction: { id, ownershipType, finalSplitType }, claims: [] }`

- [ ] **Step 1: Write the failing integration test**

Create `backend/test/integration/transactionSplit.test.ts`. Reuse the seed/`createTransaction` helpers pattern from `backend/test/integration/reimbursements.test.ts` (copy the `seed`, `createTransaction`, and agent-bootstrap setup from that file's top ~lines 15–140; it boots `testAgent` + `setupPgTestDb`). Then:

```ts
test('POST /split even 3-way creates 2 claims + sets txn to me', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-01', -302.71, {
    createdByUserId: primaryUserId,
  });
  const dad = primaryContactId;
  const alex = await createContact(primaryHouseholdId, 'Alex'); // helper: models.Contact.create -> id
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: dad }, { contactId: alex }], includeSelf: true })
    .expect(201);
  assert.equal(res.body.claims.length, 2);
  assert.equal(res.body.transaction.finalSplitType, 'me');
  const amounts = res.body.claims.map((c: { amount: string }) => c.amount).sort();
  assert.deepEqual(amounts, ['100.9000', '100.9000']);
  assert.ok(res.body.claims.every((c: { fromSplit: boolean }) => c.fromSplit === true));
});

test('re-split replaces prior from_split claims, keeps manual ones', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-02', -90, {
    createdByUserId: primaryUserId,
  });
  // a manual claim (from_split defaults false)
  await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ contactId: primaryContactId, amount: '10.00' })
    .expect(201);
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: primaryContactId }], includeSelf: true })
    .expect(201);
  // re-split with a different shape
  const res = await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'percent', participants: [{ contactId: primaryContactId, pct: 50 }], includeSelf: true })
    .expect(201);
  assert.equal(res.body.claims.length, 1);
  // list all claims for the txn: 1 manual + 1 split = 2
  const list = await primaryAgent.get(`/api/reimbursements?transactionId=${txnId}`).expect(200);
  assert.equal(list.body.data.length, 2);
});

test('DELETE /split removes only split claims', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-03', -60, {
    createdByUserId: primaryUserId,
  });
  await primaryAgent
    .post(`/api/transactions/${txnId}/reimbursable`)
    .send({ contactId: primaryContactId, amount: '5.00' })
    .expect(201);
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: primaryContactId }], includeSelf: true })
    .expect(201);
  await primaryAgent.delete(`/api/transactions/${txnId}/split`).expect(200);
  const list = await primaryAgent.get(`/api/reimbursements?transactionId=${txnId}`).expect(200);
  assert.equal(list.body.data.length, 1); // only the manual one survives
});

test('rejects self-contact participant', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-04', -40, {
    createdByUserId: primaryUserId,
  });
  const selfContact = await createContact(primaryHouseholdId, 'Me', { isSelf: true });
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: selfContact }], includeSelf: true })
    .expect(400);
});

test('rejects contact from another household', async () => {
  const txnId = await createTransaction(primaryHouseholdId, primaryAccountId, '2026-04-05', -40, {
    createdByUserId: primaryUserId,
  });
  await primaryAgent
    .post(`/api/transactions/${txnId}/split`)
    .send({ method: 'even', participants: [{ contactId: otherContactId }], includeSelf: true })
    .expect(400);
});
```

Add a small `createContact` helper near `createTransaction` in this test file:

```ts
async function createContact(
  householdId: number,
  name: string,
  opts: { isSelf?: boolean } = {},
): Promise<number> {
  const models = await import('../../src/models');
  const c = await models.Contact.create({ householdId, name, notes: null, isSelf: opts.isSelf ?? false });
  return c.id;
}
```

- [ ] **Step 2: Run, verify fail**

Run (needs Postgres + `TEST_DATABASE_URL`): `yarn workspace cashflow-backend run test:integration` (or target this file per the integration runner). 
Expected: FAIL — `/split` routes 404 / handler missing.

- [ ] **Step 3: Add `fromSplit` to the serializer**

In `backend/src/reimbursements/serialize.ts`:
- Add to `ReimbursementView` (after `notes`, ~line 372): `fromSplit: boolean;`
- Add to `ReimbursementRow` (after `notes`, ~line 396): `fromSplit?: boolean | null;`
- In `serializeReimbursement` return object (after `notes: r.notes,`, ~line 457): `fromSplit: Boolean(r.fromSplit),`

- [ ] **Step 4: Add the two route handlers**

In `backend/src/routes/reimbursements.ts`, add imports near the top:

```ts
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { validateSplitRequest, computeSplitShares } from '../reimbursements/splitShares';
```

Add a helper after `contactInHousehold` (~line 105):

```ts
/** True iff every contactId is in the caller's household and none is is_self. */
async function splitContactsOk(
  req: Request,
  contactIds: number[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await Contact.findAll({
    where: { id: contactIds, ...householdWhere(req) },
    attributes: ['id', 'isSelf'],
  });
  if (rows.length !== contactIds.length) {
    return { ok: false, error: 'contactId not found in household' };
  }
  if (rows.some((c) => c.isSelf)) {
    return { ok: false, error: 'cannot split a share to yourself (is_self contact)' };
  }
  return { ok: true };
}
```

Add the handlers (place after the `promote-counterparty` handler, ~line 274):

```ts
// ----- POST /api/transactions/:id/split -----------------------------------
// Multiway split: payer fronts the outlay, each other participant owes a share
// back (one Reimbursement per participant, from_split=true). Replaces any prior
// from_split claims on this txn. Sets the txn to ownership 'me' so it leaves the
// partner-fairness shared pool (no double-count of a partner participant).
router.post('/transactions/:id/split', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (txn.householdId == null) {
      res.status(400).json({ error: 'Transaction has no household' });
      return;
    }
    const v = validateSplitRequest((req.body || {}) as Record<string, unknown>);
    if (!v.ok) {
      res.status(v.status).json({ error: v.error });
      return;
    }
    const ids = v.value.participants.map((p) => p.contactId);
    const contactsOk = await splitContactsOk(req, ids);
    if (!contactsOk.ok) {
      res.status(400).json({ error: contactsOk.error });
      return;
    }
    const auth = currentAuth(req);
    const { shares } = computeSplitShares(
      txn.amount,
      v.value.method,
      v.value.participants,
      v.value.includeSelf,
    );
    await sequelize.transaction(async (t) => {
      await Reimbursement.destroy({
        where: { transactionId: txn.id, fromSplit: true },
        transaction: t,
      });
      await Reimbursement.bulkCreate(
        shares.map((s) => ({
          householdId: txn.householdId!,
          transactionId: txn.id,
          contactId: s.contactId,
          partyName: null,
          amount: s.amount,
          currency: txn.currency,
          dueDate: null,
          status: 'expected' as const,
          repaymentTransactionId: null,
          receivedAt: null,
          createdByUserId: auth.user.id,
          notes: `Multiway split (${v.value.method})`,
          fromSplit: true,
        })),
        { transaction: t },
      );
      txn.ownershipType = 'me';
      txn.splitOverride = 'me';
      recomputeTransactionAmounts(txn);
      await txn.save({ transaction: t });
    });
    const claims = await Reimbursement.findAll({
      where: { transactionId: txn.id, fromSplit: true },
      include: INCLUDE,
      order: [['id', 'ASC']],
    });
    res.status(201).json({
      transaction: { id: txn.id, ownershipType: txn.ownershipType, finalSplitType: txn.finalSplitType },
      claims: claims.map((r) => serializeReimbursement(toRow(r))),
    });
  } catch (e) {
    next(e);
  }
});

// ----- DELETE /api/transactions/:id/split ---------------------------------
router.delete('/transactions/:id/split', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const txn = await Transaction.findOne({ where: { id, ...visibleTransactionWhere(req) } });
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await sequelize.transaction(async (t) => {
      await Reimbursement.destroy({
        where: { transactionId: txn.id, fromSplit: true },
        transaction: t,
      });
      txn.ownershipType = 'me';
      txn.splitOverride = 'me';
      recomputeTransactionAmounts(txn);
      await txn.save({ transaction: t });
    });
    res.status(200).json({
      transaction: { id: txn.id, ownershipType: txn.ownershipType, finalSplitType: txn.finalSplitType },
      claims: [],
    });
  } catch (e) {
    next(e);
  }
});
```

> Note: `serializeReimbursement` and `toRow` are already imported/defined in this file. `INCLUDE`, `currentAuth`, `visibleTransactionWhere`, `householdWhere`, `sequelize`, `Contact`, `Reimbursement`, `Transaction` are already in scope.

- [ ] **Step 5: Add a route-order entry if required**

The `/transactions/:id/split` paths are served by the reimbursements router already mounted on `/api`. No new mount. If `backend/test/appRouteOrder.test.ts` enumerates exact paths, add the two new paths there; run it to check:

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/auth/appRouteOrder.test.ts`
Expected: PASS (adjust the expected-path list only if it fails on the new routes).

- [ ] **Step 6: Run the integration test, verify pass**

Run: `yarn workspace cashflow-backend run test:integration`
Expected: PASS for `transactionSplit.test.ts`.

- [ ] **Step 7: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/reimbursements.ts backend/src/reimbursements/serialize.ts \
        backend/test/integration/transactionSplit.test.ts
git commit --no-verify -m "feat(reimbursements): POST/DELETE transactions/:id/split endpoints"
```

---

### Task 4: Shared DTO types

**Files:**
- Modify: `shared/api-types.ts` (add split request/response DTOs; add `fromSplit` to the reimbursement DTO if one is declared there)

**Interfaces:**
- Produces: `SplitTransactionRequest`, `SplitShareDTO`, `SplitTransactionResponse`.

- [ ] **Step 1: Add the types**

Append to `shared/api-types.ts` (match the file's existing export style):

```ts
export interface SplitParticipantDTO {
  contactId: number;
  /** Required only for method 'percent'; a number in (0, 100]. */
  pct?: number;
}

export interface SplitTransactionRequest {
  method: 'even' | 'percent';
  participants: SplitParticipantDTO[];
  /** Default true. When false, "me" keeps $0 and participants cover the full amount. */
  includeSelf?: boolean;
}

export interface SplitTransactionResponse {
  transaction: { id: number; ownershipType: string | null; finalSplitType: string | null };
  /** Reimbursement view rows generated by the split (shape mirrors the
   *  reimbursements list endpoint's `data[]`). */
  claims: unknown[];
}
```

> If `shared/api-types.ts` already declares a reimbursement view interface, add `fromSplit: boolean;` to it and type `claims` as that interface instead of `unknown[]`. Grep first: `grep -n "Reimbursement" shared/api-types.ts`.

- [ ] **Step 2: Typecheck both workspaces**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace frontend run build`
Expected: no errors (build may take a bit; types must resolve).

- [ ] **Step 3: Commit**

```bash
git add shared/api-types.ts
git commit --no-verify -m "feat(shared): multiway split request/response DTOs"
```

---

### Task 5: Frontend — multiway split editor

**Files:**
- Create: `frontend/src/components/MultiwaySplitEditor.tsx`
- Create: `frontend/src/components/MultiwaySplitEditor.test.tsx`
- Modify: `frontend/src/lib/api.ts` (add `splitTransaction` + `unsplitTransaction`)
- Modify: `frontend/src/pages/TransactionsPage.tsx` (add `multiway` option to the split-type select ~line 2242; render `MultiwaySplitEditor` when selected; show a multiway badge on the row)

**Interfaces:**
- Consumes: `SplitTransactionRequest`, `SplitTransactionResponse` (Task 4).
- Produces: `MultiwaySplitEditor` component; `api.splitTransaction(txnId, body)`, `api.unsplitTransaction(txnId)`.

- [ ] **Step 1: Add the API client methods**

In `frontend/src/lib/api.ts`, add (mirror the file's existing fetch-wrapper style — reuse its `request`/`apiFetch` helper and base path):

```ts
import type { SplitTransactionRequest, SplitTransactionResponse } from '@cashflow/shared';

export async function splitTransaction(
  txnId: number,
  body: SplitTransactionRequest,
): Promise<SplitTransactionResponse> {
  return request(`/api/transactions/${txnId}/split`, { method: 'POST', body: JSON.stringify(body) });
}

export async function unsplitTransaction(txnId: number): Promise<SplitTransactionResponse> {
  return request(`/api/transactions/${txnId}/split`, { method: 'DELETE' });
}
```

> Use whatever the existing exported helper is named (e.g. `request`, `apiFetch`, `http`). Grep first: `grep -n "export async function\|function request\|apiFetch" frontend/src/lib/api.ts` and follow that pattern exactly (headers, error handling, JSON parsing).

- [ ] **Step 2: Write the failing component test**

Create `frontend/src/components/MultiwaySplitEditor.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultiwaySplitEditor } from './MultiwaySplitEditor';

const contacts = [
  { id: 3, name: 'Dad' },
  { id: 7, name: 'Alex' },
];

describe('MultiwaySplitEditor', () => {
  it('even split shows each participant + your share read-out', () => {
    render(
      <MultiwaySplitEditor
        amountAbs={302.71}
        contacts={contacts}
        onApply={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    // add two participants
    fireEvent.click(screen.getByText('+ Add person'));
    fireEvent.change(screen.getAllByLabelText(/person/i)[0], { target: { value: '3' } });
    fireEvent.click(screen.getByText('+ Add person'));
    fireEvent.change(screen.getAllByLabelText(/person/i)[1], { target: { value: '7' } });
    // even split of 302.71 / 3 -> your share 100.91
    expect(screen.getByText(/your share/i)).toHaveTextContent('100.91');
  });

  it('apply calls onApply with method even and participant ids', () => {
    const onApply = vi.fn();
    render(
      <MultiwaySplitEditor amountAbs={90} contacts={contacts} onApply={onApply} onClear={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('+ Add person'));
    fireEvent.change(screen.getAllByLabelText(/person/i)[0], { target: { value: '3' } });
    fireEvent.click(screen.getByText(/apply split/i));
    expect(onApply).toHaveBeenCalledWith({
      method: 'even',
      participants: [{ contactId: 3 }],
      includeSelf: true,
    });
  });
});
```

- [ ] **Step 3: Run, verify fail**

Run: `yarn workspace frontend run test MultiwaySplitEditor`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the component**

Create `frontend/src/components/MultiwaySplitEditor.tsx`. Use design-system primitives already used in `TransactionsPage` (`NativeSelect`, `Input`, `Button`) — match their import paths. Behavior:

```tsx
import { useMemo, useState } from 'react';
import type { SplitTransactionRequest } from '@cashflow/shared';
// Adjust these imports to the DS paths used elsewhere in the app:
import { NativeSelect, Input, Button } from '@/components/ds';

export interface MultiwaySplitEditorProps {
  amountAbs: number;
  contacts: Array<{ id: number; name: string }>;
  onApply: (body: SplitTransactionRequest) => void;
  onClear: () => void;
}

interface Row {
  contactId: number | '';
  pct: string; // percent input as string; ignored when even
}

export function MultiwaySplitEditor({ amountAbs, contacts, onApply, onClear }: MultiwaySplitEditorProps) {
  const [even, setEven] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);

  const valid = rows.filter((r) => r.contactId !== '');

  const yourShare = useMemo(() => {
    if (valid.length === 0) return amountAbs;
    if (even) {
      const n = valid.length + 1; // include self
      const each = Math.round((amountAbs / n) * 100) / 100;
      return Math.round((amountAbs - each * valid.length) * 100) / 100;
    }
    const others = valid.reduce((a, r) => a + (Number(r.pct) || 0), 0);
    return Math.round((amountAbs * (100 - others)) / 100 * 100) / 100;
  }, [valid, even, amountAbs]);

  function addRow() {
    setRows((rs) => [...rs, { contactId: '', pct: '' }]);
  }
  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function apply() {
    const participants = valid.map((r) =>
      even ? { contactId: Number(r.contactId) } : { contactId: Number(r.contactId), pct: Number(r.pct) },
    );
    onApply({ method: even ? 'even' : 'percent', participants, includeSelf: true });
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={even} onChange={(e) => setEven(e.target.checked)} />
        Even split
      </label>

      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <NativeSelect
            aria-label={`person ${i + 1}`}
            value={String(r.contactId)}
            onChange={(e) => setRow(i, { contactId: e.target.value ? Number(e.target.value) : '' })}
          >
            <option value="">Select person…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </NativeSelect>
          {!even && (
            <Input
              type="number"
              aria-label={`percent ${i + 1}`}
              value={r.pct}
              onChange={(e) => setRow(i, { pct: e.target.value })}
              placeholder="%"
            />
          )}
        </div>
      ))}

      <Button type="button" variant="ghost" onClick={addRow}>+ Add person</Button>

      <div className="text-sm text-muted-foreground">
        Your share: {yourShare.toFixed(2)}
      </div>

      <div className="flex gap-2">
        <Button type="button" onClick={apply} disabled={valid.length === 0}>Apply split</Button>
        <Button type="button" variant="ghost" onClick={onClear}>Clear split</Button>
      </div>
    </div>
  );
}
```

> Replace `@/components/ds`, `NativeSelect`, `Input`, `Button`, and the `variant`/className conventions with the exact ones used in `TransactionsPage.tsx`. Grep there first: `grep -n "NativeSelect\|from '@\|Button" frontend/src/pages/TransactionsPage.tsx | head`.

- [ ] **Step 5: Run, verify pass**

Run: `yarn workspace frontend run test MultiwaySplitEditor`
Expected: PASS (2 tests). Adjust the `yourShare` read-out assertion (`100.91`) only if the rounding rule above yields a different displayed value — it should be `302.71 - 2×100.90 = 100.91`.

- [ ] **Step 6: Wire it into TransactionsPage**

In `frontend/src/pages/TransactionsPage.tsx`:
- Add `<option value="multiway">multiway</option>` to the split-type `<NativeSelect>` (~line 2242–2247).
- When `split === 'multiway'`, render `<MultiwaySplitEditor amountAbs={Math.abs(Number(t.amount))} contacts={contacts} onApply={(body) => splitTransaction(t.id, body).then(refresh)} onClear={() => unsplitTransaction(t.id).then(refresh)} />` in place of the me/partner percent inputs. Use the page's existing contact list (the same source feeding the `ownershipContactId` dropdown ~line 2280) and its existing refresh/reload callback.
- Show a small **"multiway"** badge on rows whose `finalSplitType === 'me'` AND that have `fromSplit` claims — if the row data doesn't already include a claim count, gate the badge on a lightweight flag from the split response/local state; do NOT add a new per-row fetch.

- [ ] **Step 7: Frontend typecheck + tests + lint**

Run: `yarn workspace frontend run build && yarn workspace frontend run test MultiwaySplitEditor && yarn workspace frontend run lint`
Expected: build succeeds, tests pass, lint clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/MultiwaySplitEditor.tsx \
        frontend/src/components/MultiwaySplitEditor.test.tsx \
        frontend/src/lib/api.ts frontend/src/pages/TransactionsPage.tsx
git commit --no-verify -m "feat(frontend): multiway split editor on transactions"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the whole CI gate**

Run: `yarn ci`
Expected: typecheck, all tests (backend unit + frontend), and both production builds pass. Integration tests need Postgres (`TEST_DATABASE_URL`); if running locally without it, run `yarn workspace cashflow-backend run test` (unit) + `yarn workspace frontend run test` and run integration in the Postgres-backed job.

- [ ] **Step 2: Sanity-check the migration applies**

Run: `yarn db:migrate`
Expected: `20260623000001-add-reimbursements-from-split` applies cleanly.

- [ ] **Step 3: Commit any lint/format fixups, then the branch is ready for PR.**

---

## Self-Review notes

- **Spec coverage:** `from_split` column (Task 1) ✓; even/percent share math + validation incl. exclude-self and Σ≤100 (Task 2) ✓; `POST`/`DELETE /split`, idempotent replace, ownership→me, is_self & household guards (Task 3) ✓; DTOs (Task 4) ✓; multiway UI on existing editor + Reimbursements page reuse (Task 5) ✓; tests at every layer ✓. Out-of-scope (bulk, custom $, partner weighting) intentionally omitted.
- **Type consistency:** `computeSplitShares`/`validateSplitRequest` signatures identical across Tasks 2–3; `fromSplit` added in Task 1 (model), Task 3 (serializer), Task 4 (DTO) consistently; route response shape `{ transaction, claims }` matches the Task 5 consumer.
- **Known adaptation points (call out in review):** exact DS import paths and the `api.ts` fetch-helper name are environment-specific — each is flagged with a grep-first note rather than a guessed import.
