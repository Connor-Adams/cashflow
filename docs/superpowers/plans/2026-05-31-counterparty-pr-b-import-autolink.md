# Counterparty PR B — Auto-detect counterparty on import (find-or-create) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On statement import, auto-create-and-link a canonical `Contact` for person-to-person counterparties (Interac/Zelle/Venmo/CashApp), deduped by a normalized name, leaving payroll/direct-deposit as raw-only.

**Architecture:** Introduce a canonical normalized identity for contacts: a new `contacts.normalized_name` column + unique index `(household_id, normalized_name)`, auto-populated by a Contact model `beforeValidate` hook. A single shared `normalizeContactName` util backs both the hook and the existing promotion matcher. A `findOrCreateContactByName` helper (race-safe via the unique index) becomes the one way contacts get created from a name — used by import, the promote endpoints, and `POST /contacts`. `extractCounterparty` grows a `kind` discriminator so import only auto-creates for `person` lines; a thin `resolveCounterpartyContact` calls the helper and is wired into the import commit loop.

**Tech Stack:** Express + Sequelize (backend), `node:test` + `tsx` runner, in-memory SQLite for migration/unit tests, Postgres (`setupPgTestDb`) for integration tests.

**Spine note:** Counterparty primitive. Adds a column + index to the existing `contacts` table and a derivation; no new table, no new status machine. Not a spine change.

---

## Pre-req
PR A (`counterpartyContactId` PATCH + `CounterpartyCell`) is already merged/in-flight. This branch builds on it.

## File Structure
- Create: `backend/src/contacts/normalizeContactName.ts` — the single normalization function.
- Create: `backend/src/contacts/findOrCreateContact.ts` — `findOrCreateContactByName` + `resolveCounterpartyContact`.
- Create: `backend/src/migrations/20260531120000-contacts-normalized-name.js` — column + backfill + unique index.
- Modify: `backend/src/ai/counterpartyPromotions.ts` — `normalizeCounterpartyName` delegates to the util.
- Modify: `backend/src/models/Contact.ts` — `normalizedName` attribute + `beforeValidate` hook.
- Modify: `backend/src/import/extractCounterparty.ts` — return `{ name, kind }`.
- Modify: `backend/src/import/commitStatementImport.ts` — resolve + set `counterpartyContactId` on import.
- Modify: `backend/src/import/counterpartyBackfill.ts` — adapt to the new `extractCounterparty` return shape (raw extraction only; Contact linking is PR C).
- Modify: `backend/src/routes/transactions.ts` (promote single + bulk) and `backend/src/routes/contacts.ts` (POST) — route creation through `findOrCreateContactByName`.
- Tests: `backend/test/normalizeContactName.test.ts`, `backend/test/migrations/contactsNormalizedNameMigration.test.ts`, `backend/test/contactHookNormalizedName.test.ts`, `backend/test/extractCounterpartyKind.test.ts`, `backend/test/integration/counterpartyImportAutolink.test.ts`.

**Backend test commands** (from `backend/`): single file → `npx tsx --import ./test/setup.ts --test test/<path>.test.ts`. Integration tests need a local Postgres (available). Typecheck: `yarn typecheck`. Lint: `yarn lint`. Husky is broken in this worktree → commit with `--no-verify`. No `Co-Authored-By` (Connor sole author).

---

## Task 1: Shared `normalizeContactName` util

**Files:** Create `backend/src/contacts/normalizeContactName.ts`; Test `backend/test/normalizeContactName.test.ts`; Modify `backend/src/ai/counterpartyPromotions.ts`.

- [ ] **Step 1: Write the failing test** — `backend/test/normalizeContactName.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContactName } from '../src/contacts/normalizeContactName.js';

test('lowercases and collapses whitespace', () => {
  assert.equal(normalizeContactName('  JANE   DOE '), 'jane doe');
});
test('null/empty -> null', () => {
  assert.equal(normalizeContactName(null), null);
  assert.equal(normalizeContactName('   '), null);
});
test('casing variants collapse to the same key', () => {
  assert.equal(normalizeContactName('Jane Doe'), normalizeContactName('JANE DOE'));
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx tsx --import ./test/setup.ts --test test/normalizeContactName.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — `backend/src/contacts/normalizeContactName.ts`:
```ts
/**
 * Canonical contact-name normalization key: lowercase + whitespace-collapsed.
 * Used by the Contact `normalized_name` column/hook AND the counterparty
 * promotion matcher so import-created and promote-matched contacts dedupe
 * identically. Returns null for empty/whitespace input.
 */
export function normalizeContactName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed === '' ? null : trimmed;
}
```

- [ ] **Step 4: Make the promotion matcher delegate** — in `backend/src/ai/counterpartyPromotions.ts`, replace the body of `normalizeCounterpartyName` (lines 54–58) so it calls the util (keep the export name + signature for its callers):
```ts
import { normalizeContactName } from '../contacts/normalizeContactName';
// ...
export function normalizeCounterpartyName(raw: string | null | undefined): string | null {
  return normalizeContactName(raw);
}
```

- [ ] **Step 5: Run + typecheck** — the util test PASSES; `npx tsx --import ./test/setup.ts --test test/counterpartyPromotionInbox.test.ts` still PASSES (delegation is behavior-preserving); `yarn typecheck` clean.

- [ ] **Step 6: Commit**
```bash
git add backend/src/contacts/normalizeContactName.ts backend/test/normalizeContactName.test.ts backend/src/ai/counterpartyPromotions.ts
git commit -m "feat(contacts): shared normalizeContactName util; promotion matcher delegates to it"
```

---

## Task 2: `contacts.normalized_name` column + unique index + model hook

**Files:** Create `backend/src/migrations/20260531120000-contacts-normalized-name.js`; Modify `backend/src/models/Contact.ts`; Tests `backend/test/migrations/contactsNormalizedNameMigration.test.ts`, `backend/test/contactHookNormalizedName.test.ts`.

- [ ] **Step 1: Write the failing migration test** — `backend/test/migrations/contactsNormalizedNameMigration.test.ts` (mirrors `contactsIsPartnerMigration.test.ts`):
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
  await qi.createTable('contacts', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    household_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  // Seed three contacts in household 1: two that normalize to the SAME key
  // ("Jane Doe" and "JANE DOE") to exercise collision disambiguation, plus one distinct.
  await sequelize.query(`INSERT INTO contacts (id, household_id, name, notes, created_at, updated_at) VALUES
    (1, 1, 'Jane Doe', NULL, datetime('now'), datetime('now')),
    (2, 1, 'JANE DOE', NULL, datetime('now'), datetime('now')),
    (3, 1, 'Mike Smith', NULL, datetime('now'), datetime('now'))`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  migration = require('../../src/migrations/20260531120000-contacts-normalized-name.js');
});
after(async () => { await sequelize.close(); });

test('up backfills normalized_name and disambiguates per-household collisions', async () => {
  await migration.up(sequelize.getQueryInterface(), Sequelize);
  const [rows] = await sequelize.query(`SELECT id, normalized_name FROM contacts ORDER BY id ASC`);
  const byId = Object.fromEntries((rows as any[]).map((r) => [r.id, r.normalized_name]));
  assert.equal(byId[1], 'jane doe', 'oldest keeps the base key');
  assert.equal(byId[2], 'jane doe#2', 'younger collision gets disambiguated');
  assert.equal(byId[3], 'mike smith');
});

test('unique index rejects a duplicate (household_id, normalized_name)', async () => {
  await sequelize.query(`INSERT INTO contacts (id, household_id, name, normalized_name, notes, created_at, updated_at)
    VALUES (4, 1, 'Mike Smith 2', 'mike smith', NULL, datetime('now'), datetime('now'))`).then(
    () => assert.fail('expected unique-index violation'),
    () => { /* expected */ },
  );
});

test('down removes the column + index cleanly', async () => {
  await migration.down(sequelize.getQueryInterface(), Sequelize);
  const desc = await sequelize.getQueryInterface().describeTable('contacts');
  assert.equal(desc.normalized_name, undefined);
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx tsx --import ./test/setup.ts --test test/migrations/contactsNormalizedNameMigration.test.ts` → FAIL (migration module missing).

- [ ] **Step 3: Implement the migration** — `backend/src/migrations/20260531120000-contacts-normalized-name.js`:
```js
'use strict';

/**
 * Adds contacts.normalized_name (lowercase + whitespace-collapsed key) and a
 * UNIQUE index (household_id, normalized_name) so Contact find-or-create by
 * normalized name is race-safe (mirrors accounts shortCode unique index).
 *
 * Backfill is done in JS to match normalizeContactName exactly (SQL lower()
 * cannot collapse internal whitespace portably). Per-household collisions
 * (e.g. "Jane Doe" + "JANE DOE") are disambiguated: the oldest id keeps the
 * base key, later rows get `${key}#${id}` so the unique index can be created
 * without data loss. NULLs are distinct in unique indexes on both PG + SQLite,
 * but the backfill leaves no NULLs.
 */
// Inlined to keep the migration self-contained (mirrors src/contacts/normalizeContactName.ts).
function normalize(raw) {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contacts', 'normalized_name', {
      type: Sequelize.STRING(160),
      allowNull: true,
    });

    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, household_id, name FROM contacts ORDER BY id ASC',
    );
    const seen = new Map(); // householdId -> Set<key>
    for (const row of rows) {
      const base = normalize(row.name) || `contact-${row.id}`;
      let set = seen.get(row.household_id);
      if (!set) { set = new Set(); seen.set(row.household_id, set); }
      let key = base;
      if (set.has(key)) key = `${base}#${row.id}`;
      set.add(key);
      await queryInterface.sequelize.query(
        'UPDATE contacts SET normalized_name = :nn WHERE id = :id',
        { replacements: { nn: key, id: row.id } },
      );
    }

    await queryInterface.addIndex('contacts', ['household_id', 'normalized_name'], {
      unique: true,
      name: 'idx_contacts_household_normalized_name',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('contacts', 'idx_contacts_household_normalized_name');
    await queryInterface.removeColumn('contacts', 'normalized_name');
  },
};
```

- [ ] **Step 4: Run the migration test, verify it passes** — same command as Step 2 → all 3 PASS.

- [ ] **Step 5: Write the failing model-hook test** — `backend/test/contactHookNormalizedName.test.ts`:
```ts
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import { initContact } from '../src/models/Contact.js';

let sequelize: Sequelize;
let Contact: ReturnType<typeof initContact>;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  Contact = initContact(sequelize);
  await sequelize.sync();
});
after(async () => { await sequelize.close(); });

test('beforeValidate sets normalizedName from name', async () => {
  const c = await Contact.create({ householdId: 1, name: '  Jane   DOE ', notes: null } as never);
  assert.equal(c.normalizedName, 'jane doe');
});
test('rename updates normalizedName', async () => {
  const c = await Contact.create({ householdId: 1, name: 'Bob', notes: null } as never);
  c.set('name', 'Bobby Tables');
  await c.save();
  assert.equal(c.normalizedName, 'bobby tables');
});
```

- [ ] **Step 6: Run it, verify it fails** — `npx tsx --import ./test/setup.ts --test test/contactHookNormalizedName.test.ts` → FAIL (`normalizedName` undefined).

- [ ] **Step 7: Add the attribute + hook to the model** — in `backend/src/models/Contact.ts`:
  1. Add the class field after `isPartner`:
```ts
  /** Lowercase + whitespace-collapsed key for dedup; auto-set by a hook. */
  declare normalizedName: CreationOptional<string | null>;
```
  2. Add the attribute in `Contact.init` (after `isPartner`):
```ts
      normalizedName: {
        type: DataTypes.STRING(160),
        field: 'normalized_name',
        allowNull: true,
      },
```
  3. Import the util at the top: `import { normalizeContactName } from '../contacts/normalizeContactName';`
  4. After `Contact.init(...)` and before `return Contact;`, register the hook:
```ts
  Contact.beforeValidate((contact) => {
    contact.set('normalizedName', normalizeContactName(contact.get('name')));
  });
```

- [ ] **Step 8: Run the hook test + typecheck** — Step 6 command → PASSES; `yarn typecheck` clean.

- [ ] **Step 9: Commit**
```bash
git add backend/src/migrations/20260531120000-contacts-normalized-name.js backend/src/models/Contact.ts backend/test/migrations/contactsNormalizedNameMigration.test.ts backend/test/contactHookNormalizedName.test.ts
git commit -m "feat(contacts): normalized_name column, unique index, auto-populating model hook"
```

---

## Task 3: `extractCounterparty` returns `{ name, kind }`

**Files:** Modify `backend/src/import/extractCounterparty.ts`; Test `backend/test/extractCounterpartyKind.test.ts`; update callers.

- [ ] **Step 1: Write the failing test** — `backend/test/extractCounterpartyKind.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCounterparty } from '../src/import/extractCounterparty.js';

test('person pattern -> kind person', () => {
  assert.deepEqual(
    extractCounterparty('INTERAC E-TRANSFER FROM JANE DOE REF 8842', 'checking'),
    { name: 'JANE DOE', kind: 'person' },
  );
});
test('payroll pattern -> kind payroll', () => {
  assert.deepEqual(
    extractCounterparty('PAYROLL DEPOSIT ACME CORP', 'checking'),
    { name: 'ACME CORP', kind: 'payroll' },
  );
});
test('out-of-scope account -> null', () => {
  assert.equal(extractCounterparty('INTERAC E-TRANSFER FROM JANE DOE', 'credit_card'), null);
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx tsx --import ./test/setup.ts --test test/extractCounterpartyKind.test.ts` → FAIL (returns a string, not an object).

- [ ] **Step 3: Implement** — in `backend/src/import/extractCounterparty.ts`, change the `PATTERNS` array to carry a `kind` and change the return type. Replace the `PATTERNS` const and the `extractCounterparty` function:
```ts
export type CounterpartyKind = 'person' | 'payroll';
export type ExtractedCounterparty = { name: string; kind: CounterpartyKind };

const PATTERNS: { re: RegExp; kind: CounterpartyKind }[] = [
  { re: /\b(?:INTERAC\s+)?(?:E-?TFR|E-?TRANSFER)\s+(?:FROM|TO|FRM)\s+(.+)/i, kind: 'person' },
  { re: /\b(?:SEND|RECV|RECEIVED?)\s+(?:E-?TFR|E-?TRANSFER)\s+(.+)/i, kind: 'person' },
  { re: /\b(?:ZELLE|VENMO)\s+(?:(?:PAYMENT|CASHOUT|PMT)\s+)?(?:FROM|TO)\s+(.+)/i, kind: 'person' },
  { re: /\bCASH\s*APP\s*\*\s*(.+)/i, kind: 'person' },
  { re: /\bCASH\s*APP\s+(?:FROM|TO)\s+(.+)/i, kind: 'person' },
  { re: /\b(?:PAYROLL\s+DEP(?:OSIT)?|DIRECT\s+DEP(?:OSIT)?)\s+(.+)/i, kind: 'payroll' },
];

export function extractCounterparty(
  merchantRaw: string,
  accountType: AccountType,
): ExtractedCounterparty | null {
  if (!IN_SCOPE_ACCOUNT_TYPES.has(accountType)) return null;
  if (!merchantRaw || merchantRaw.trim() === '') return null;
  for (const { re, kind } of PATTERNS) {
    const match = merchantRaw.match(re);
    if (match && match[1]) {
      const normalized = normalize(match[1]);
      if (normalized) return { name: normalized, kind };
    }
  }
  return null;
}
```
(Keep the existing `normalize()` helper and `IN_SCOPE_ACCOUNT_TYPES` unchanged.)

- [ ] **Step 4: Update all callers** — grep `extractCounterparty(` across `backend/src` and `backend/test`. Each caller that used the returned string must now use `?.name`. Known sites:
  - `backend/src/import/commitStatementImport.ts` (handled fully in Task 5 — for now just make it compile: `const _extracted = extractCounterparty(...)` then `counterpartyRaw: _extracted?.name ?? null`).
  - `backend/src/import/counterpartyBackfill.ts` — wherever it calls `extractCounterparty` and assigns `counterpartyRaw`, change to `?.name ?? null`. (Contact-linking in backfill is PR C; here only keep raw extraction working.)
  - Any existing `backend/test/*extractCounterparty*.test.ts` that asserts a string return — update to the `{name, kind}` shape (or leave the new kind test as the canonical one and adjust old assertions).

- [ ] **Step 5: Run affected tests + typecheck** — the kind test PASSES; `yarn typecheck` clean; run any pre-existing extractCounterparty/backfill tests and fix assertions to the new shape until green.

- [ ] **Step 6: Commit**
```bash
git add backend/src/import/extractCounterparty.ts backend/test/extractCounterpartyKind.test.ts backend/src/import/counterpartyBackfill.ts backend/src/import/commitStatementImport.ts
git commit -m "feat(import): extractCounterparty returns {name, kind}; gate downstream on person vs payroll"
```

---

## Task 4: `findOrCreateContactByName` + `resolveCounterpartyContact`; route all creation through it

**Files:** Create `backend/src/contacts/findOrCreateContact.ts`; Modify `backend/src/routes/transactions.ts` (promote single + bulk), `backend/src/routes/contacts.ts` (POST); Test `backend/test/integration/counterpartyImportAutolink.test.ts` (resolver-level cases here; import wiring in Task 5).

- [ ] **Step 1: Implement the helpers** — `backend/src/contacts/findOrCreateContact.ts`:
```ts
import type { Transaction } from 'sequelize';
import { Contact } from '../models';
import { normalizeContactName } from './normalizeContactName';
import type { ExtractedCounterparty } from '../import/extractCounterparty';

/**
 * Race-safe find-or-create of a Contact by its normalized name within a
 * household. Relies on the unique index (household_id, normalized_name) and
 * the model's beforeValidate hook (which sets normalized_name from name).
 * `rawName` supplies the display casing for a freshly created Contact.
 */
export async function findOrCreateContactByName(
  householdId: number,
  rawName: string,
  options?: { transaction?: Transaction },
): Promise<Contact> {
  const name = rawName.trim();
  const normalized = normalizeContactName(name) ?? name.toLowerCase();
  const [contact] = await Contact.findOrCreate({
    where: { householdId, normalizedName: normalized },
    defaults: { householdId, name, notes: null, normalizedName: normalized } as never,
    transaction: options?.transaction,
  });
  return contact;
}

/**
 * Import-time resolver: only person-kind counterparties get a Contact.
 * Returns the contact id, or null (payroll, no household, or no match).
 */
export async function resolveCounterpartyContact(
  householdId: number | null,
  extracted: ExtractedCounterparty | null,
  options?: { transaction?: Transaction },
): Promise<number | null> {
  if (!extracted || extracted.kind !== 'person' || householdId == null) return null;
  const contact = await findOrCreateContactByName(householdId, extracted.name, options);
  return contact.id;
}
```

- [ ] **Step 2: Route the promote endpoints + POST /contacts through the helper**
  - `backend/src/routes/transactions.ts` — in BOTH `POST /:id/counterparty/promote` (the auto-create branch, ~line 2378–2387) and `POST /counterparty/promote-bulk` (the auto-create branch, ~line 2498–2509), replace the `Contact.findOne({where:{householdId, name: raw}})` + `Contact.create({...})` pair with `await findOrCreateContactByName(household.id, rawName, { transaction: t })` (the bulk path is inside a `sequelize.transaction(async (t) => ...)`, so pass `t`; the single path has no transaction, omit it). Import the helper at the top of the file.
  - `backend/src/routes/contacts.ts` — in `POST /` (lines 105–133), after validating `name`, replace `Contact.create({ householdId, name, notes, isPartner })` with: find-or-create by normalized name, then apply `notes`/`isPartner` if provided. Concretely:
```ts
    const row = await findOrCreateContactByName(household.id, name);
    let changed = false;
    if (b.notes != null) { row.set('notes', String(b.notes)); changed = true; }
    if (isPartner) { row.set('isPartner', true); changed = true; }
    if (changed) await row.save();
    res.status(201).json(row);
```
  This makes manual create idempotent on normalized name (returns the existing contact instead of a 500 on the unique index).

- [ ] **Step 3: Write resolver + dedup tests** — `backend/test/integration/counterpartyImportAutolink.test.ts` (start with resolver-level cases; Task 5 adds the import-path cases to the same file). Mirror the harness from `backend/test/integration/counterpartyBackfill.test.ts` (`setupPgTestDb`, `seedHousehold`, bootstrap superadmin). Cases:
```ts
test('resolveCounterpartyContact creates one contact and dedupes casing variants', async () => {
  const models = await import('../../src/models');
  const { resolveCounterpartyContact } = await import('../../src/contacts/findOrCreateContact.js');
  const id1 = await resolveCounterpartyContact(householdAId, { name: 'JANE DOE', kind: 'person' });
  const id2 = await resolveCounterpartyContact(householdAId, { name: 'Jane Doe', kind: 'person' });
  assert.equal(id1, id2, 'casing variants resolve to the same contact');
  const count = await models.Contact.count({ where: { householdId: householdAId, normalizedName: 'jane doe' } });
  assert.equal(count, 1);
});
test('resolveCounterpartyContact returns null for payroll kind', async () => {
  const { resolveCounterpartyContact } = await import('../../src/contacts/findOrCreateContact.js');
  assert.equal(await resolveCounterpartyContact(householdAId, { name: 'ACME CORP', kind: 'payroll' }), null);
});
```

- [ ] **Step 4: Run tests + the existing promote/contacts integration tests + typecheck**
  - `npx tsx --import ./test/setup.ts --test test/integration/counterpartyImportAutolink.test.ts` → PASS.
  - `npx tsx --import ./test/setup.ts --test test/integration/transactionCounterpartyPromote.test.ts` and `.../contacts.test.ts` → still PASS (the find-or-create refactor must not regress them; fix assertions only if they asserted a hard 2nd-contact-create that is now deduped — verify behavior is still correct).
  - `yarn typecheck` clean.

- [ ] **Step 5: Commit**
```bash
git add backend/src/contacts/findOrCreateContact.ts backend/src/routes/transactions.ts backend/src/routes/contacts.ts backend/test/integration/counterpartyImportAutolink.test.ts
git commit -m "feat(contacts): race-safe findOrCreateContactByName; route promote + POST /contacts through it"
```

---

## Task 5: Wire `resolveCounterpartyContact` into the import commit loop

**Files:** Modify `backend/src/import/commitStatementImport.ts`; extend `backend/test/integration/counterpartyImportAutolink.test.ts`.

- [ ] **Step 1: Write the failing integration tests** — append to `counterpartyImportAutolink.test.ts`. These drive the real import path; mirror how `backend/test/integration/` tests invoke `commitStatementImport`/the import route (inspect a sibling import test for the exact entry point and preview/commit fixture shape before writing — e.g. the import flow used in `counterpartyBackfill.test.ts` neighbours). Assert:
  - importing a checking-account row `INTERAC E-TRANSFER TO JOHN DOE REF 11` creates exactly one Contact (`normalized_name = 'john doe'`) and the resulting transaction's `counterpartyContactId` points at it.
  - importing a second row `INTERAC E-TRANSFER TO JOHN DOE REF 77` links to the SAME contact (no duplicate).
  - importing `PAYROLL DEPOSIT ACME CORP` sets `counterpartyRaw='ACME CORP'` but leaves `counterpartyContactId = null` (payroll is not person-kind).
  - re-importing the same statement is idempotent (no duplicate contact; link unchanged).

- [ ] **Step 2: Run them, verify they fail** — they fail because import never sets `counterpartyContactId`.

- [ ] **Step 3: Implement the wiring** — in `backend/src/import/commitStatementImport.ts` at the `counterpartyRaw`/`Transaction.build` site (around lines 328–333):
  1. Capture the full extraction: `const extracted = extractCounterparty(row.merchantRaw, account.accountType as AccountType);`
  2. Resolve the contact id (people-only) BEFORE the build: `const counterpartyContactId = await resolveCounterpartyContact(account.householdId ?? null, extracted, { transaction: <the import txn if one exists> });`
  3. In the `Transaction.build({...})` object set `counterpartyRaw: extracted?.name ?? null` and `counterpartyContactId` (the resolved value) instead of the hardcoded `null`.
  - Import `resolveCounterpartyContact` from `../contacts/findOrCreateContact`. **Determine whether `commitStatementImport` runs inside a `sequelize.transaction`**: search the function for `sequelize.transaction(` / a `transaction` variable threaded into the `Transaction.build`/`save`/`bulkCreate`. If it does, pass that transaction to `resolveCounterpartyContact` so the contact create participates in the same atomic unit; if it does not, call it without a transaction. Do NOT introduce a new transaction.

- [ ] **Step 4: Run the integration tests, verify they pass** — `npx tsx --import ./test/setup.ts --test test/integration/counterpartyImportAutolink.test.ts` → all PASS. Then run the broader import integration test(s) you mirrored to confirm no regression.

- [ ] **Step 5: Commit**
```bash
git add backend/src/import/commitStatementImport.ts backend/test/integration/counterpartyImportAutolink.test.ts
git commit -m "feat(import): auto-create + link person counterparty Contact on statement import"
```

---

## Task 6: Verify + open PR

- [ ] **Step 1: Full backend gate** (from `backend/`)
  - `yarn typecheck` → clean.
  - `yarn lint` → no new warnings.
  - Run the touched integration + unit files:
    `npx tsx --import ./test/setup.ts --test test/normalizeContactName.test.ts test/extractCounterpartyKind.test.ts test/contactHookNormalizedName.test.ts test/migrations/contactsNormalizedNameMigration.test.ts test/integration/counterpartyImportAutolink.test.ts test/integration/transactionCounterpartyPromote.test.ts test/integration/contacts.test.ts test/integration/counterpartyBackfill.test.ts test/integration/counterpartyPromotionInbox.test.ts` → all PASS.

- [ ] **Step 2: Push + PR with auto-merge (merge commit, no squash)**
```bash
git push -u origin refs/heads/claude/competent-cohen-a6b692:refs/heads/claude/competent-cohen-a6b692
gh pr create --base main --head claude/competent-cohen-a6b692 \
  --title "feat(counterparty): auto-detect + link person counterparty on import (PR B)" \
  --body "Adds normalized_name canonical identity to contacts (column + unique index + model hook + backfill migration), a race-safe findOrCreateContactByName routed through import/promote/POST, extractCounterparty {name,kind}, and import-time auto-create+link for person counterparties (people-only; payroll stays raw). Spec: docs/superpowers/specs/2026-05-31-canonical-counterparty-on-transactions-design.md. Next: PR C (backfill existing rows)."
gh pr merge --auto --merge
```
(If PR A is still open on the same branch, this PR's commits stack on it — confirm the branch/PR strategy first: PR B may need to wait for PR A to merge, or target a fresh branch off updated main. Decide at execution time based on PR A's state.)

---

## Self-review (completed during planning)
- **Spec coverage:** Implements spec §"PR B" fully: normalized_name migration + unique index + backfill/collision handling, extractCounterparty kind, resolveCounterpartyContact, import wiring (people-only), and POST /contacts normalized_name find-or-create. The promote-endpoint routing is added because the unique index requires every create site to dedupe by normalized name.
- **One normalization everywhere:** the model hook, the resolver, and the promotion matcher all use `normalizeContactName`, so import-created and promote-matched contacts dedupe identically (no divergence bug).
- **Migration safety:** column added nullable then JS-backfilled (matches the normalizer exactly; SQL `lower()` can't collapse internal whitespace), per-household collisions disambiguated before the unique index is added; `down` reverses both. No `changeColumn` (avoids the SQLite footgun).
- **Types:** `extractCounterparty` now returns `ExtractedCounterparty | null`; every caller updated to `?.name`. `resolveCounterpartyContact` returns `number | null` matching `counterpartyContactId`.
- **Open integration detail (flagged, not a placeholder):** Task 5 Step 3 requires the implementer to read `commitStatementImport`'s transaction handling and thread it — this is genuine integration judgment, with explicit instructions, not a TODO.
- **Branch/PR strategy:** Task 6 flags that PR B stacks on PR A's branch; resolve at execution time.
