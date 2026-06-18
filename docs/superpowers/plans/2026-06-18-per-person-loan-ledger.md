# Per-person Loan Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Contact a per-person ledger showing two numbers side by side — raw net transfer flow (auto) and tracked-loan balance (marked loans) — backed by a one-time pass that links legacy transfers to contacts by name terms.

**Architecture:** No new primitive. A "loan" is an existing `Reimbursement` (Expectation) created from an outflow transfer; "net owed per person" is a derived aggregate over transfers linked via `transactions.counterparty_contact_id`. Legacy transfers are unlinked today, so a term-based link pass (distinct from the existing regex `extractCounterparty` backfill — RBC "ONLINE TRANSFER SENT/RECEIVED" lines don't match those regexes) sets the FK by matching merchant text against each Contact's name + aliases. A new ledger endpoint and a new frontend page expose the numbers and the mark-as-loan / ambiguous-resolve actions.

**Tech Stack:** Backend — Express + Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx`, colocated `*.test.ts`. Frontend — Vite + React 19, react-router-dom v7, Tailwind v4, design-system primitives. Shared DTOs in `shared/api-types.ts`.

## Global Constraints

- Money is per-currency throughout; **no FX conversion** in this feature. Mixed currencies render as separate rows.
- Sequelize must run on **both SQLite and Postgres**. No dialect-specific SQL.
- All routes are **household-scoped** via `householdWhere(req)` / `visibleTransactionWhere(req)` and sit behind the global `requireAuth` at `/api`.
- Backend tests are colocated `foo.test.ts` beside `foo.ts` under `backend/src/`, run via `node:test`/`tsx`.
- Contact match terms must require a **minimum length of 3 characters** to avoid noise matches.
- The link pass is **idempotent** and never relinks an already-linked row (`counterparty_contact_id IS NULL` guard at the SQL write boundary).
- Frontend uses design-system primitives; **no raw inline styles or legacy `App.css` classes**.
- NEVER add a `Co-Authored-By` trailer to commits.
- Commit shell note: this worktree has no `node_modules`; prefix commits with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH` so the husky/lint-staged pre-commit hook resolves.

---

### Task 1: Contact term-matcher (pure helper)

The matcher decides which contacts a transfer's merchant text belongs to. Pure and DB-free so it unit-tests without a database.

**Files:**
- Create: `backend/src/contacts/contactTermMatch.ts`
- Test: `backend/src/contacts/contactTermMatch.test.ts`

**Interfaces:**
- Consumes: `normalizeContactName` from `backend/src/contacts/normalizeContactName.ts`.
- Produces:
  - `interface MatchableContact { id: number; name: string; normalizedName: string | null; aliases: string | null }`
  - `contactMatchTerms(c: MatchableContact): string[]` — normalized terms (name + comma-split aliases), deduped, each length ≥ 3.
  - `matchContactsByTerms(merchantText: string, contacts: MatchableContact[]): number[]` — ids of every contact with a term that is a substring of the normalized merchant text. Length 1 = unambiguous, >1 = ambiguous, 0 = no match.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactMatchTerms, matchContactsByTerms } from './contactTermMatch';

const caelan = { id: 1, name: 'Caelan', normalizedName: 'caelan', aliases: 'iten-mcgrath' };
const stephen = { id: 4, name: 'STEPHEN MASSEUR', normalizedName: 'stephen masseur', aliases: null };

test('contactMatchTerms includes name + aliases, drops <3 char terms', () => {
  assert.deepEqual(contactMatchTerms({ id: 9, name: 'Al', normalizedName: 'al', aliases: 'jo, xavier' }), ['xavier']);
  assert.deepEqual(contactMatchTerms(caelan).sort(), ['caelan', 'iten-mcgrath'].sort());
});

test('matchContactsByTerms finds unambiguous matches in merchant text', () => {
  assert.deepEqual(matchContactsByTerms('ONLINE TRANSFER RECEIVED - 5552 CAELAN ANTHONY ITEN-MCGRATH', [caelan, stephen]), [1]);
  assert.deepEqual(matchContactsByTerms('E-TRANSFER RECEIVED STEPHEN MASSEUR', [caelan, stephen]), [4]);
});

test('matchContactsByTerms returns multiple ids when ambiguous', () => {
  const steph2 = { id: 7, name: 'Stephen B', normalizedName: 'stephen b', aliases: 'masseur' };
  const ids = matchContactsByTerms('PAYMENT STEPHEN MASSEUR', [stephen, steph2]).sort();
  assert.deepEqual(ids, [4, 7]);
});

test('matchContactsByTerms returns empty when no term matches', () => {
  assert.deepEqual(matchContactsByTerms('TIM HORTONS #123', [caelan, stephen]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/contactTermMatch.test.ts`
Expected: FAIL — `contactMatchTerms`/`matchContactsByTerms` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
import { normalizeContactName } from './normalizeContactName';

export interface MatchableContact {
  id: number;
  name: string;
  normalizedName: string | null;
  aliases: string | null;
}

const MIN_TERM_LEN = 3;

/** Normalized, deduped match terms for a contact: its name plus any aliases.
 *  Terms shorter than 3 chars are dropped to avoid noise substring hits. */
export function contactMatchTerms(c: MatchableContact): string[] {
  const raw = [c.normalizedName ?? normalizeContactName(c.name), ...(c.aliases ?? '').split(',')];
  const terms = new Set<string>();
  for (const t of raw) {
    const n = normalizeContactName(t);
    if (n && n.length >= MIN_TERM_LEN) terms.add(n);
  }
  return [...terms];
}

/** Contact ids whose any term is a substring of the normalized merchant text.
 *  1 id = unambiguous, >1 = ambiguous, 0 = no match. */
export function matchContactsByTerms(
  merchantText: string,
  contacts: MatchableContact[],
): number[] {
  const hay = normalizeContactName(merchantText) ?? '';
  if (!hay) return [];
  const out: number[] = [];
  for (const c of contacts) {
    if (contactMatchTerms(c).some((t) => hay.includes(t))) out.push(c.id);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/contactTermMatch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/contacts/contactTermMatch.ts backend/src/contacts/contactTermMatch.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(contacts): term-based contact matcher for transfer linking"
```

---

### Task 2: `aliases` column on Contact + API plumbing

Adds the user-editable alias terms the matcher reads, with a migration and contact route support.

**Files:**
- Create: `backend/src/migrations/20260624000001-add-contact-aliases.js`
- Modify: `backend/src/models/Contact.ts`
- Modify: `backend/src/routes/contacts.ts` (POST + PATCH accept `aliases`; GET detail returns it)
- Test: `backend/test/integration/contactsAliases.test.ts` (integration — Postgres, exercises the column round-trip)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Contact.aliases: string | null` (comma-separated terms); `PATCH /api/contacts/:id` accepts `{ aliases?: string | null }`; contact detail response includes `aliases`.

- [ ] **Step 1: Write the migration**

```js
'use strict';

/**
 * Adds a nullable comma-separated `aliases` column to `contacts`. Feeds the
 * term-based transfer link pass (per-person loan ledger): a contact's aliases
 * plus its name become the substrings matched against transfer merchant text.
 *
 * Null/empty means "match on name only". Runs on SQLite + Postgres.
 *
 * Spine note: extends the existing Contact primitive with a field; NOT a new
 * primitive.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('contacts', 'aliases', {
      type: Sequelize.STRING(500),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('contacts', 'aliases');
  },
};
```

- [ ] **Step 2: Add the model field**

In `backend/src/models/Contact.ts`, add the declaration after `notes` (line 19) and the init attribute after `notes` (line 44):

```ts
// in the class body, after `declare notes: string | null;`
/** Comma-separated extra match terms for the transfer link pass (per-person
 *  loan ledger). Null means match on name only. */
declare aliases: CreationOptional<string | null>;
```

```ts
// in Contact.init attributes, after the `notes` entry
aliases: { type: DataTypes.STRING(500), allowNull: true },
```

- [ ] **Step 3: Thread `aliases` through the contact routes**

In `backend/src/routes/contacts.ts`:

In the `GET /:id` JSON response (after `isPartner: contact.isPartner,`), add:
```ts
      aliases: contact.aliases,
```

In `POST /` (after the `notes` set, near line 133), add:
```ts
    if (b.aliases != null) { row.set('aliases', String(b.aliases).slice(0, 500)); changed = true; }
```

In `PATCH /:id` (after the `notes` set, near line 159), add:
```ts
    if (b.aliases !== undefined) {
      row.set('aliases', b.aliases != null ? String(b.aliases).slice(0, 500) : null);
    }
```

- [ ] **Step 4: Write the integration test**

```ts
// backend/test/integration/contactsAliases.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contact } from '../../src/models';

test('Contact persists aliases round-trip', async () => {
  const c = await Contact.create({ householdId: 1, name: 'Caelan', aliases: 'iten-mcgrath' });
  const reloaded = await Contact.findByPk(c.id);
  assert.equal(reloaded?.aliases, 'iten-mcgrath');
});
```

- [ ] **Step 5: Run the migration + test**

Run: `yarn db:migrate && cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn tsx --import ./test/setup.ts --test test/integration/contactsAliases.test.ts`
Expected: migration applies; test PASSES. Also run `yarn workspace cashflow-backend run typecheck` — expect no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/migrations/20260624000001-add-contact-aliases.js backend/src/models/Contact.ts backend/src/routes/contacts.ts backend/test/integration/contactsAliases.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(contacts): add editable aliases column + API plumbing"
```

---

### Task 3: Transfer link-pass planner (pure helper)

The planner partitions unlinked transfer rows into unambiguous (auto-link) and ambiguous (manual-pick) buckets. Pure, so the linking decision is unit-tested without a DB.

**Files:**
- Create: `backend/src/import/planTransferLinks.ts`
- Test: `backend/src/import/planTransferLinks.test.ts`

**Interfaces:**
- Consumes: `matchContactsByTerms`, `MatchableContact` from Task 1.
- Produces:
  - `interface LinkCandidateRow { id: number; merchantText: string }`
  - `interface TransferLinkPlan { unambiguous: Array<{ txnId: number; contactId: number }>; ambiguous: Array<{ txnId: number; merchantText: string; contactIds: number[] }> }`
  - `planTransferLinks(rows: LinkCandidateRow[], contacts: MatchableContact[]): TransferLinkPlan`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransferLinks } from './planTransferLinks';

const caelan = { id: 1, name: 'Caelan', normalizedName: 'caelan', aliases: 'iten-mcgrath' };
const stephen = { id: 4, name: 'STEPHEN MASSEUR', normalizedName: 'stephen masseur', aliases: null };

test('partitions rows into unambiguous and ambiguous', () => {
  const plan = planTransferLinks(
    [
      { id: 10, merchantText: 'ONLINE TRANSFER RECEIVED - CAELAN ANTHONY ITEN-MCGRATH' },
      { id: 11, merchantText: 'E-TRANSFER STEPHEN MASSEUR' },
      { id: 12, merchantText: 'TIM HORTONS' },
    ],
    [caelan, stephen],
  );
  assert.deepEqual(plan.unambiguous, [
    { txnId: 10, contactId: 1 },
    { txnId: 11, contactId: 4 },
  ]);
  assert.deepEqual(plan.ambiguous, []);
});

test('rows matching >1 contact go to ambiguous, not unambiguous', () => {
  const steph2 = { id: 7, name: 'Stephen B', normalizedName: 'stephen b', aliases: 'masseur' };
  const plan = planTransferLinks([{ id: 20, merchantText: 'PAY STEPHEN MASSEUR' }], [stephen, steph2]);
  assert.deepEqual(plan.unambiguous, []);
  assert.deepEqual(plan.ambiguous, [{ txnId: 20, merchantText: 'PAY STEPHEN MASSEUR', contactIds: [4, 7] }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/planTransferLinks.test.ts`
Expected: FAIL — `planTransferLinks` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
import { matchContactsByTerms, type MatchableContact } from '../contacts/contactTermMatch';

export interface LinkCandidateRow {
  id: number;
  merchantText: string;
}

export interface TransferLinkPlan {
  unambiguous: Array<{ txnId: number; contactId: number }>;
  ambiguous: Array<{ txnId: number; merchantText: string; contactIds: number[] }>;
}

/** Partition candidate transfer rows by how many contacts their merchant text
 *  matches: exactly one → auto-linkable; more than one → manual-pick queue;
 *  zero → dropped (not in either bucket). */
export function planTransferLinks(
  rows: LinkCandidateRow[],
  contacts: MatchableContact[],
): TransferLinkPlan {
  const plan: TransferLinkPlan = { unambiguous: [], ambiguous: [] };
  for (const r of rows) {
    const ids = matchContactsByTerms(r.merchantText, contacts);
    if (ids.length === 1) plan.unambiguous.push({ txnId: r.id, contactId: ids[0] });
    else if (ids.length > 1) plan.ambiguous.push({ txnId: r.id, merchantText: r.merchantText, contactIds: ids });
  }
  return plan;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/planTransferLinks.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/planTransferLinks.ts backend/src/import/planTransferLinks.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(import): transfer link-pass planner (unambiguous vs ambiguous)"
```

---

### Task 4: Transfer link-pass job (DB)

Loads unlinked transfer rows, runs the planner, writes the FK for unambiguous matches (or previews), and returns the ambiguous queue. Mirrors the `counterpartyBackfill.ts` job shape (in-flight guard + per-row transaction + `ProviderJobLog`).

**Files:**
- Create: `backend/src/import/transferContactLink.ts`
- Test: `backend/test/integration/transferContactLink.test.ts` (Postgres — exercises the SQL filter + write)

**Interfaces:**
- Consumes: `planTransferLinks`, `TransferLinkPlan` (Task 3); models `Transaction`, `Account`, `Contact`, `ProviderJobLog`, `sequelize`.
- Produces:
  - `interface TransferLinkResult { processed: number; linked: number; ambiguous: TransferLinkPlan['ambiguous']; dryRun: boolean; elapsedMs: number }`
  - `runTransferContactLink(opts: { householdId: number; dryRun?: boolean }): Promise<TransferLinkResult>`
  - `isTransferLinkRunning(householdId: number): boolean`
  - `_resetTransferLinkInFlightForTest(): void`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/integration/transferContactLink.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Account, Contact, Transaction } from '../../src/models';
import { runTransferContactLink, _resetTransferLinkInFlightForTest } from '../../src/import/transferContactLink';

test('links unambiguous transfers and reports ambiguous ones', async () => {
  _resetTransferLinkInFlightForTest();
  const hh = 1;
  const acct = await Account.create({ householdId: hh, name: 'Chequing', accountType: 'checking', currency: 'CAD' });
  const caelan = await Contact.create({ householdId: hh, name: 'Caelan', aliases: 'iten-mcgrath' });
  const t1 = await Transaction.create({
    householdId: hh, accountId: acct.id, date: '2019-07-22', amount: '-200.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'ONLINE TRANSFER SENT - 5552 CAELAN ANTHONY ITEN-MCGRATH', merchantClean: 'Online transfer sent',
  });

  const dry = await runTransferContactLink({ householdId: hh, dryRun: true });
  assert.equal(dry.linked, 1);
  assert.equal((await Transaction.findByPk(t1.id))?.counterpartyContactId, null, 'dry run writes nothing');

  const wet = await runTransferContactLink({ householdId: hh });
  assert.equal(wet.linked, 1);
  assert.equal((await Transaction.findByPk(t1.id))?.counterpartyContactId, caelan.id);

  const again = await runTransferContactLink({ householdId: hh });
  assert.equal(again.linked, 0, 'idempotent — already linked rows skipped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn tsx --import ./test/setup.ts --test test/integration/transferContactLink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { Op } from 'sequelize';
import { Account, Contact, ProviderJobLog, Transaction, sequelize } from '../models';
import { planTransferLinks, type LinkCandidateRow, type TransferLinkPlan } from './planTransferLinks';
import type { MatchableContact } from '../contacts/contactTermMatch';
import { logger } from '../observability/logger';

export const TRANSFER_LINK_PROVIDER = 'transfer_contact_link' as const;

/** Account types whose lines plausibly carry a person-to-person transfer. */
const IN_SCOPE_ACCOUNT_TYPES = ['checking', 'savings', 'cash'] as const;
/** Merchant substrings (lowercased) that mark a row as a person-to-person flow. */
const TRANSFER_HINTS = ['transfer', 'e-transfer', 'etransfer', 'interac'];

export interface TransferLinkResult {
  processed: number;
  linked: number;
  ambiguous: TransferLinkPlan['ambiguous'];
  dryRun: boolean;
  elapsedMs: number;
}

const inFlight = new Set<number>();
export function isTransferLinkRunning(householdId: number): boolean {
  return inFlight.has(householdId);
}
export function _resetTransferLinkInFlightForTest(): void {
  inFlight.clear();
}

function isTransferLike(txnType: string | null, merchant: string): boolean {
  if (txnType === 'transfer') return true;
  const m = merchant.toLowerCase();
  return TRANSFER_HINTS.some((h) => m.includes(h));
}

export async function runTransferContactLink(
  opts: { householdId: number; dryRun?: boolean },
): Promise<TransferLinkResult> {
  const { householdId, dryRun = false } = opts;
  if (inFlight.has(householdId)) {
    throw new Error(`transfer contact link already running for household ${householdId}`);
  }
  inFlight.add(householdId);
  const startedAt = Date.now();
  let processed = 0;
  let linked = 0;
  let ambiguous: TransferLinkPlan['ambiguous'] = [];
  let status: 'ok' | 'error' = 'ok';

  try {
    const contactRows = await Contact.findAll({ where: { householdId } });
    const contacts: MatchableContact[] = contactRows.map((c) => ({
      id: c.id, name: c.name, normalizedName: c.normalizedName ?? null, aliases: c.aliases ?? null,
    }));
    if (contacts.length === 0) {
      return { processed: 0, linked: 0, ambiguous: [], dryRun, elapsedMs: Date.now() - startedAt };
    }

    const txns = await Transaction.findAll({
      where: { householdId, counterpartyContactId: { [Op.is]: null } },
      include: [{
        model: Account, as: 'account', attributes: ['accountType'], required: true,
        where: { accountType: { [Op.in]: [...IN_SCOPE_ACCOUNT_TYPES] } },
      }],
      order: [['date', 'ASC'], ['id', 'ASC']],
    });

    const candidates: LinkCandidateRow[] = [];
    for (const t of txns) {
      const merchant = `${t.merchantClean ?? ''} ${t.merchantRaw ?? ''} ${t.counterpartyRaw ?? ''}`.trim();
      if (!isTransferLike(t.txnType ?? null, merchant)) continue;
      candidates.push({ id: t.id, merchantText: merchant });
    }
    processed = candidates.length;

    const plan = planTransferLinks(candidates, contacts);
    ambiguous = plan.ambiguous;

    if (!dryRun) {
      for (const { txnId, contactId } of plan.unambiguous) {
        const [count] = await Transaction.update(
          { counterpartyContactId: contactId },
          { where: { id: txnId, householdId, counterpartyContactId: { [Op.is]: null } } },
        );
        if (count > 0) linked++;
      }
    } else {
      linked = plan.unambiguous.length;
    }
  } catch (err) {
    status = 'error';
    logger.error({ err, householdId, module: 'transfer_contact_link' }, 'transfer_contact_link_failed');
    throw err;
  } finally {
    inFlight.delete(householdId);
  }

  const elapsedMs = Date.now() - startedAt;
  if (!dryRun) {
    await ProviderJobLog.create({
      provider: TRANSFER_LINK_PROVIDER, function: 'link', symbol: String(householdId),
      status, httpStatus: null,
      errorMessage: JSON.stringify({ processed, linked, ambiguous: ambiguous.length, elapsedMs }),
      fetchedAt: new Date(),
    });
  }
  return { processed, linked, ambiguous, dryRun, elapsedMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn tsx --import ./test/setup.ts --test test/integration/transferContactLink.test.ts`
Expected: PASS. Also `yarn workspace cashflow-backend run typecheck` — no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/import/transferContactLink.ts backend/test/integration/transferContactLink.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(import): term-based transfer→contact link pass job"
```

---

### Task 5: Transfer-net aggregator (pure helper)

Computes the raw net flow per currency from a contact's linked transfers. Pure → unit-tested without a DB.

**Files:**
- Create: `backend/src/contacts/transferLedger.ts`
- Test: `backend/src/contacts/transferLedger.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface TransferRow { amount: string | number; currency: string }`
  - `interface TransferNet { currency: string; sent: string; received: string; net: string }`
  - `computeTransferNet(rows: TransferRow[]): TransferNet[]` — per currency: `sent` = Σ abs(amount<0), `received` = Σ amount>0, `net` = sent − received, all fixed-4 strings, sorted by currency.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTransferNet } from './transferLedger';

test('nets sent minus received per currency', () => {
  const out = computeTransferNet([
    { amount: '-200.0000', currency: 'CAD' },
    { amount: '-350.0000', currency: 'CAD' },
    { amount: '70.0000', currency: 'CAD' },
    { amount: '-100.0000', currency: 'USD' },
  ]);
  assert.deepEqual(out, [
    { currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' },
    { currency: 'USD', sent: '100.0000', received: '0.0000', net: '100.0000' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/transferLedger.test.ts`
Expected: FAIL — `computeTransferNet` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface TransferRow {
  amount: string | number;
  currency: string;
}

export interface TransferNet {
  currency: string;
  sent: string;
  received: string;
  net: string;
}

function toCents(n: number): number {
  return Math.round(n * 10_000);
}

/** Per-currency raw net flow: sent (money out, amount<0) minus received
 *  (money in, amount>0). Positive net = the person owes you. Fixed-4 strings,
 *  integer-cents math to avoid float drift, sorted by currency. */
export function computeTransferNet(rows: TransferRow[]): TransferNet[] {
  const sent = new Map<string, number>();
  const recv = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.amount);
    if (!Number.isFinite(n) || n === 0) continue;
    const m = n < 0 ? sent : recv;
    m.set(r.currency, (m.get(r.currency) ?? 0) + toCents(Math.abs(n)));
  }
  const currencies = new Set([...sent.keys(), ...recv.keys()]);
  return [...currencies].sort().map((currency) => {
    const s = sent.get(currency) ?? 0;
    const rc = recv.get(currency) ?? 0;
    return {
      currency,
      sent: (s / 10_000).toFixed(4),
      received: (rc / 10_000).toFixed(4),
      net: ((s - rc) / 10_000).toFixed(4),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/contacts/transferLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contacts/transferLedger.ts backend/src/contacts/transferLedger.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(contacts): per-currency transfer-net aggregator"
```

---

### Task 6: Ledger + link-pass endpoints

Exposes the two numbers per contact, the linked transfer rows (each flagged whether already a loan), and the link-pass preview/commit. Reuses `summarize()` for the tracked-loan balance.

**Files:**
- Modify: `backend/src/routes/contacts.ts` (add `GET /:id/ledger`)
- Create: `backend/src/routes/transferLink.ts` (preview/commit/status router)
- Modify: `backend/src/routeRegistry.ts` (mount the new router)
- Test: `backend/test/integration/contactLedger.test.ts`

**Interfaces:**
- Consumes: `computeTransferNet` (Task 5), `runTransferContactLink`/`isTransferLinkRunning` (Task 4), `summarize`/`ReimbursementRow` (`reimbursements/serialize`), models.
- Produces (response DTOs — also added to shared types in Task 7):
  - `GET /api/contacts/:id/ledger` → `{ contactId, name, transferNet: TransferNet[], trackedOutstandingByCurrency: Record<string,string>, transfers: LedgerTransferRow[] }`
    where `LedgerTransferRow = { id: number; date: string; amount: string; currency: string; merchant: string | null; direction: 'out' | 'in'; isLoan: boolean }`
  - `POST /api/transfer-link/preview` → `{ processed, linked, ambiguous }` (dry run; ambiguous entries carry `{ txnId, merchantText, contactIds }`)
  - `POST /api/transfer-link/commit` → `TransferLinkResult`
  - `GET /api/transfer-link/status` → `{ running: boolean }`
  - Ambiguous rows are resolved by the **existing** `PATCH /api/transactions/:id { counterpartyContactId }` — no new endpoint.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/integration/contactLedger.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app } from '../../src/app';
import { Account, Contact, Transaction, Reimbursement } from '../../src/models';
import { authCookie } from '../helpers/authCookie'; // existing integration helper

test('GET /api/contacts/:id/ledger returns net + tracked + flagged transfers', async () => {
  const cookie = await authCookie(); // seeds/returns a logged-in household session
  const hh = 1;
  const acct = await Account.create({ householdId: hh, name: 'Chequing', accountType: 'checking', currency: 'CAD' });
  const caelan = await Contact.create({ householdId: hh, name: 'Caelan' });
  const out = await Transaction.create({
    householdId: hh, accountId: acct.id, date: '2020-01-01', amount: '-200.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER CAELAN', merchantClean: 'Transfer', counterpartyContactId: caelan.id,
  });
  await Transaction.create({
    householdId: hh, accountId: acct.id, date: '2020-02-01', amount: '50.0000', currency: 'CAD',
    txnType: 'transfer', merchantRaw: 'TRANSFER CAELAN', merchantClean: 'Transfer', counterpartyContactId: caelan.id,
  });
  await Reimbursement.create({ householdId: hh, transactionId: out.id, contactId: caelan.id, amount: '200.0000', currency: 'CAD', status: 'expected' });

  const res = await request(app).get(`/api/contacts/${caelan.id}/ledger`).set('Cookie', cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.transferNet, [{ currency: 'CAD', sent: '200.0000', received: '50.0000', net: '150.0000' }]);
  assert.equal(res.body.trackedOutstandingByCurrency.CAD, '200.0000');
  const loanRow = res.body.transfers.find((t: { id: number }) => t.id === out.id);
  assert.equal(loanRow.isLoan, true);
  assert.equal(loanRow.direction, 'out');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn tsx --import ./test/setup.ts --test test/integration/contactLedger.test.ts`
Expected: FAIL — route 404 / router not mounted. (If `authCookie` helper name differs, match the one used by other files in `backend/test/integration/` — grep `Cookie` there.)

- [ ] **Step 3a: Add the ledger route to `contacts.ts`**

Add imports at the top of `backend/src/routes/contacts.ts`:
```ts
import { Op } from 'sequelize';
import { visibleTransactionWhere } from '../auth/scope';
import { computeTransferNet, type TransferRow } from '../contacts/transferLedger';
import { summarize, type ReimbursementRow } from '../reimbursements/serialize';
```
(Keep the existing `summarizeOpenForContact`/`resolveToday` import; add `summarize` and `ReimbursementRow` to it if not already present.)

Add the route before `export default router;`:
```ts
/**
 * Per-person loan ledger (per-person loan ledger feature). Two numbers side by
 * side: raw net transfer flow (auto, over transfers linked via
 * counterparty_contact_id) and tracked-loan outstanding (Reimbursements for
 * this contact). Plus the linked transfer rows, each flagged whether it is
 * already a tracked loan. Per-currency; no FX.
 */
router.get('/:id/ledger', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const contact = await Contact.findOne({ where: { id, ...householdWhere(req) } });
    if (!contact) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const txns = await Transaction.findAll({
      where: { ...visibleTransactionWhere(req), counterpartyContactId: id },
      attributes: ['id', 'date', 'amount', 'currency', 'merchantClean', 'merchantRaw'],
      order: [['date', 'ASC'], ['id', 'ASC']],
    });
    const reimbs = await Reimbursement.findAll({ where: { ...householdWhere(req), contactId: id } });

    const loanTxnIds = new Set(reimbs.map((r) => r.transactionId));
    const transfers = txns.map((t) => {
      const amt = Number(t.amount);
      return {
        id: t.id,
        date: t.date,
        amount: String(t.amount),
        currency: t.currency,
        merchant: t.merchantClean ?? t.merchantRaw ?? null,
        direction: amt < 0 ? ('out' as const) : ('in' as const),
        isLoan: loanTxnIds.has(t.id),
      };
    });
    const transferNet = computeTransferNet(
      txns.map((t) => ({ amount: t.amount, currency: t.currency }) as TransferRow),
    );
    const summary = summarize(reimbs.map((r) => r as unknown as ReimbursementRow));

    res.json({
      contactId: contact.id,
      name: contact.name,
      transferNet,
      trackedOutstandingByCurrency: summary.outstandingByCurrency,
      transfers,
    });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 3b: Create the transfer-link router**

```ts
// backend/src/routes/transferLink.ts
import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { runTransferContactLink, isTransferLinkRunning } from '../import/transferContactLink';

const router = Router();

router.get('/status', (req, res) => {
  const { household } = currentAuth(req);
  res.json({ running: isTransferLinkRunning(household.id) });
});

router.post('/preview', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    res.json(await runTransferContactLink({ householdId: household.id, dryRun: true }));
  } catch (e) {
    next(e);
  }
});

router.post('/commit', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    if (isTransferLinkRunning(household.id)) {
      res.status(409).json({ error: 'Transfer link already running for this household' });
      return;
    }
    res.json(await runTransferContactLink({ householdId: household.id }));
  } catch (e) {
    next(e);
  }
});

export default router;
```

- [ ] **Step 3c: Mount the router in `routeRegistry.ts`**

Add the import beside the other route imports (near line 62):
```ts
import transferLinkRouter from './routes/transferLink';
```
Add the mount entry next to the contacts entry (near line 244), inside `gatedRoutes`:
```ts
  { paths: '/api/transfer-link', handlers: [transferLinkRouter], why: 'term-based transfer→contact link pass for the per-person loan ledger' },
```

- [ ] **Step 4: Run the test + route-order lock**

Run: `cd backend && TEST_DATABASE_URL=$TEST_DATABASE_URL yarn tsx --import ./test/setup.ts --test test/integration/contactLedger.test.ts`
Expected: PASS.
Run: `cd backend && yarn tsx --import ./test/setup.ts --test test/appRouteOrder.test.ts`
Expected: PASS (new mount doesn't violate ordering invariants).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/contacts.ts backend/src/routes/transferLink.ts backend/src/routeRegistry.ts backend/test/integration/contactLedger.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(api): per-person ledger endpoint + transfer-link preview/commit"
```

---

### Task 7: Shared DTOs + frontend API client

Adds the response types to the shared contract and the client functions the page calls.

**Files:**
- Modify: `shared/api-types.ts` (add ledger + transfer-link DTOs)
- Modify: `frontend/src/lib/api.ts` (add typed client calls)
- Test: `frontend/src/lib/peopleLedger.test.ts` (vitest — pure shape/type guard for the net formatter helper)

**Interfaces:**
- Consumes: `getJson`, `postJson` from `frontend/src/lib/api.ts`.
- Produces (in `@cashflow/shared`):
  - `interface LedgerTransferRow { id: number; date: string; amount: string; currency: string; merchant: string | null; direction: 'out' | 'in'; isLoan: boolean }`
  - `interface TransferNet { currency: string; sent: string; received: string; net: string }`
  - `interface ContactLedgerResponse { contactId: number; name: string; transferNet: TransferNet[]; trackedOutstandingByCurrency: Record<string, string>; transfers: LedgerTransferRow[] }`
  - `interface TransferLinkAmbiguous { txnId: number; merchantText: string; contactIds: number[] }`
  - `interface TransferLinkResult { processed: number; linked: number; ambiguous: TransferLinkAmbiguous[]; dryRun: boolean; elapsedMs: number }`
- Produces (in `frontend/src/lib/api.ts`):
  - `getContactLedger(id: number): Promise<ContactLedgerResponse>`
  - `previewTransferLink(): Promise<TransferLinkResult>`
  - `commitTransferLink(): Promise<TransferLinkResult>`
  - `markTransactionAsLoan(txnId: number, contactId: number): Promise<unknown>` (POST `/api/transactions/:id/reimbursable` with `{ contactId }`)
  - `setTransactionContact(txnId: number, contactId: number): Promise<unknown>` (PATCH `/api/transactions/:id` with `{ counterpartyContactId }`)

- [ ] **Step 1: Add DTOs to `shared/api-types.ts`**

Append the five interfaces above to `shared/api-types.ts` (follow the file's existing export style).

- [ ] **Step 2: Add client functions to `frontend/src/lib/api.ts`**

```ts
import type {
  ContactLedgerResponse,
  TransferLinkResult,
} from '@cashflow/shared';

export function getContactLedger(id: number): Promise<ContactLedgerResponse> {
  return getJson<ContactLedgerResponse>(`/api/contacts/${id}/ledger`);
}
export function previewTransferLink(): Promise<TransferLinkResult> {
  return postJson<TransferLinkResult>('/api/transfer-link/preview');
}
export function commitTransferLink(): Promise<TransferLinkResult> {
  return postJson<TransferLinkResult>('/api/transfer-link/commit');
}
export function markTransactionAsLoan(txnId: number, contactId: number): Promise<unknown> {
  return postJson(`/api/transactions/${txnId}/reimbursable`, { contactId });
}
export function setTransactionContact(txnId: number, contactId: number): Promise<unknown> {
  return patchJson(`/api/transactions/${txnId}`, { counterpartyContactId: contactId });
}
```

- [ ] **Step 3: Write + run the formatter test**

```ts
// frontend/src/lib/peopleLedger.test.ts
import { describe, it, expect } from 'vitest';
import { formatNetLabel } from './peopleLedger';

describe('formatNetLabel', () => {
  it('labels a positive net as owed to you', () => {
    expect(formatNetLabel({ currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' }))
      .toBe('CAD 480.00 owed to you');
  });
  it('labels a negative net as you owe', () => {
    expect(formatNetLabel({ currency: 'USD', sent: '0.0000', received: '100.0000', net: '-100.0000' }))
      .toBe('USD 100.00 you owe');
  });
});
```

Create `frontend/src/lib/peopleLedger.ts`:
```ts
import type { TransferNet } from '@cashflow/shared';

/** Human label for a per-currency net: positive = the person owes you. */
export function formatNetLabel(n: TransferNet): string {
  const v = Number(n.net);
  const abs = Math.abs(v).toFixed(2);
  return `${n.currency} ${abs} ${v >= 0 ? 'owed to you' : 'you owe'}`;
}
```

Run: `yarn workspace frontend run test peopleLedger`
Expected: PASS (2 tests).

- [ ] **Step 4: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck && yarn workspace frontend run lint`
Expected: no errors (shared types compile on both sides).

- [ ] **Step 5: Commit**

```bash
git add shared/api-types.ts frontend/src/lib/api.ts frontend/src/lib/peopleLedger.ts frontend/src/lib/peopleLedger.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(shared): ledger + transfer-link DTOs and client functions"
```

---

### Task 8: People ledger page (frontend)

The one-stop page: contact list with the two numbers, drill-in transfer list with mark-as-loan per outflow, a "Link transfers" action with the ambiguous manual-pick queue.

**Files:**
- Create: `frontend/src/pages/PeopleLedgerPage.tsx`
- Modify: `frontend/src/App.tsx` (add the route)
- Modify: the sidebar nav source (add a "People" link near Reimbursements — locate via `grep -rln "reimbursements" frontend/src/components`)
- Test: `frontend/src/pages/PeopleLedgerPage.test.tsx` (vitest + Testing Library — renders the two numbers and the mark-as-loan button)

**Interfaces:**
- Consumes: `getContactLedger`, `previewTransferLink`, `commitTransferLink`, `markTransactionAsLoan`, `setTransactionContact` (Task 7); `getJson('/api/contacts')` for the contact list; `formatNetLabel` (Task 7); design-system primitives (`Card`, `Button`, `Table*` — match imports used in `ReimbursementsPage.tsx`).
- Produces: a route at `/planned/people` (selected contact via `?contact=<id>` query param).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/pages/PeopleLedgerPage.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PeopleLedgerPage } from './PeopleLedgerPage';
import * as api from '../lib/api';

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof api>()), }));

beforeEach(() => {
  vi.spyOn(api, 'getJson').mockResolvedValue([{ id: 1, name: 'Caelan' }] as never);
  vi.spyOn(api, 'getContactLedger').mockResolvedValue({
    contactId: 1, name: 'Caelan',
    transferNet: [{ currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' }],
    trackedOutstandingByCurrency: { CAD: '200.0000' },
    transfers: [{ id: 10, date: '2020-01-01', amount: '-200.0000', currency: 'CAD', merchant: 'Transfer', direction: 'out', isLoan: false }],
  } as never);
});

describe('PeopleLedgerPage', () => {
  it('shows raw net and tracked balance for a selected contact', async () => {
    render(
      <MemoryRouter initialEntries={['/planned/people?contact=1']}>
        <PeopleLedgerPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/CAD 480.00 owed to you/)).toBeInTheDocument();
    expect(await screen.findByText(/200\.00/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /mark as loan/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test PeopleLedgerPage`
Expected: FAIL — module `./PeopleLedgerPage` not found.

- [ ] **Step 3: Implement the page**

Create `frontend/src/pages/PeopleLedgerPage.tsx`. Mirror the data-loading + primitive usage in `ReimbursementsPage.tsx`. Structure:

```tsx
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ContactLedgerResponse, TransferLinkResult } from '@cashflow/shared';
import {
  getJson, getContactLedger, previewTransferLink, commitTransferLink,
  markTransactionAsLoan, setTransactionContact,
} from '../lib/api';
import { formatNetLabel } from '../lib/peopleLedger';
// import design-system primitives the same way ReimbursementsPage.tsx does
// (e.g. Card, Button, Table, TableHead, TableRow, TableCell)

interface ContactLite { id: number; name: string }

export function PeopleLedgerPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('contact') ? Number(params.get('contact')) : null;
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [ledger, setLedger] = useState<ContactLedgerResponse | null>(null);
  const [linkResult, setLinkResult] = useState<TransferLinkResult | null>(null);

  useEffect(() => { getJson<ContactLite[]>('/api/contacts').then(setContacts); }, []);
  useEffect(() => {
    if (selectedId == null) { setLedger(null); return; }
    getContactLedger(selectedId).then(setLedger);
  }, [selectedId]);

  const reload = () => { if (selectedId != null) getContactLedger(selectedId).then(setLedger); };

  async function onMarkLoan(txnId: number) {
    if (selectedId == null) return;
    await markTransactionAsLoan(txnId, selectedId);
    reload();
  }
  async function onResolveAmbiguous(txnId: number, contactId: number) {
    await setTransactionContact(txnId, contactId);
    const r = await previewTransferLink();
    setLinkResult(r);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header + "Link transfers" action: preview then commit */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">People</h1>
        <div className="flex gap-2">
          <button onClick={async () => setLinkResult(await previewTransferLink())}>Preview link</button>
          <button onClick={async () => { setLinkResult(await commitTransferLink()); reload(); }}>Link transfers</button>
        </div>
      </div>

      {/* Ambiguous manual-pick queue (surfaced, never silently dropped) */}
      {linkResult && linkResult.ambiguous.length > 0 && (
        <section aria-label="Ambiguous matches">
          {linkResult.ambiguous.map((a) => (
            <div key={a.txnId} className="flex items-center gap-2">
              <span>{a.merchantText}</span>
              {a.contactIds.map((cid) => (
                <button key={cid} onClick={() => onResolveAmbiguous(a.txnId, cid)}>
                  {contacts.find((c) => c.id === cid)?.name ?? `#${cid}`}
                </button>
              ))}
            </div>
          ))}
        </section>
      )}

      {/* Landing: contact list (each links to ?contact=id). Two numbers per row
          come from getContactLedger when expanded, or render the selected one. */}
      {selectedId == null ? (
        <ul>
          {contacts.map((c) => (
            <li key={c.id}>
              <button onClick={() => setParams({ contact: String(c.id) })}>{c.name}</button>
            </li>
          ))}
        </ul>
      ) : ledger && (
        <section>
          <h2>{ledger.name}</h2>
          {/* Two numbers side by side */}
          <div className="flex gap-8">
            <div>
              <div className="text-sm text-muted-foreground">Raw net flow</div>
              {ledger.transferNet.map((n) => <div key={n.currency}>{formatNetLabel(n)}</div>)}
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Tracked loans outstanding</div>
              {Object.entries(ledger.trackedOutstandingByCurrency).map(([cur, amt]) => (
                <div key={cur}>{cur} {Number(amt).toFixed(2)}</div>
              ))}
            </div>
          </div>

          {/* Transfer rows: outflows get "Mark as loan" unless already a loan */}
          <table>
            <tbody>
              {ledger.transfers.map((t) => (
                <tr key={t.id}>
                  <td>{t.date}</td>
                  <td>{t.merchant}</td>
                  <td>{t.currency} {Number(t.amount).toFixed(2)}</td>
                  <td>{t.direction}</td>
                  <td>
                    {t.direction === 'out' && !t.isLoan && (
                      <button onClick={() => onMarkLoan(t.id)}>Mark as loan</button>
                    )}
                    {t.isLoan && <span>Loan</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
```

Replace the placeholder HTML elements with the design-system primitives used in `ReimbursementsPage.tsx` (Card/Button/Table*). No raw inline styles.

- [ ] **Step 4: Wire the route + nav**

In `frontend/src/App.tsx`, add inside the `planned` route group (after line 133):
```tsx
            <Route path="people" element={<PeopleLedgerPage />} />
```
And the import beside the other page imports (near line 65):
```tsx
import { PeopleLedgerPage } from './pages/PeopleLedgerPage'
```
Add a "People" nav entry pointing to `/planned/people` in the sidebar nav source next to the Reimbursements entry.

- [ ] **Step 5: Run the test + build**

Run: `yarn workspace frontend run test PeopleLedgerPage`
Expected: PASS.
Run: `yarn workspace frontend run lint && yarn workspace frontend run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/PeopleLedgerPage.tsx frontend/src/pages/PeopleLedgerPage.test.tsx frontend/src/App.tsx frontend/src/components
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(ui): per-person loan ledger page with mark-as-loan + ambiguous resolve"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the whole CI gate**

Run: `yarn ci`
Expected: typecheck, all backend + frontend tests, and both production builds pass.

- [ ] **Step 2: Manual smoke against a dev DB (optional but recommended)**

Run `yarn dev`, set aliases on a contact, hit **Preview link** then **Link transfers**, open the contact, confirm the two numbers render and **Mark as loan** moves an outflow into the tracked balance.

- [ ] **Step 3: Commit any fixups, then finish the branch**

Push the branch, open a PR, enable auto-merge with a merge commit (per repo convention).

---

## Self-Review

**Spec coverage:**
- Component 1 (Contact match-terms) → Tasks 1, 2. ✓
- Component 2 (extended link pass, dry-run preview + commit, idempotent, ambiguous surfaced for manual pick, manual-resolve reuses per-txn counterparty link) → Tasks 3, 4, 6 (routes), 8 (queue UI). ✓
- Component 3 (ledger derivation: rawNet per currency + trackedBalance via summarize + transfers) → Tasks 5, 6. ✓
- Component 4 (per-person ledger page: landing, drill-in, mark-as-loan on outflows, repayment via existing flow) → Tasks 7, 8. (Repayment linking reuses existing ReimbursementsPage match flow; not rebuilt here.) ✓
- Component 5 (dashboard unchanged; owedBack populates as loans are marked) → no code; verified by Task 9 smoke. ✓
- Per-currency, no FX → Tasks 5, 7 (`TransferNet[]`), Global Constraints. ✓
- Min term length 3 → Task 1. ✓

**Placeholder scan:** No TBD/TODO; every code step carries real code. Frontend Task 8 explicitly instructs swapping placeholder HTML for design-system primitives mirroring `ReimbursementsPage.tsx` (concrete reference, not a vague "style it nicely").

**Type consistency:** `TransferNet`, `LedgerTransferRow`, `ContactLedgerResponse`, `TransferLinkResult`, `TransferLinkAmbiguous` defined once in shared (Task 7) and consumed by backend route (Task 6) and frontend (Tasks 7, 8). `runTransferContactLink` / `isTransferLinkRunning` signatures match between Task 4 (definition) and Task 6 (consumption). `matchContactsByTerms` / `MatchableContact` consistent across Tasks 1, 3, 4. `computeTransferNet` / `TransferRow` consistent across Tasks 5, 6.
