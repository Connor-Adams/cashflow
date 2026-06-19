# Statement → Calendar Auto-Fill (Credit Cards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Importing a Wealthsimple credit-card statement auto-extracts the payment due date + statement balance + minimum payment, writes them onto the card, and auto-places a calendar payment for the statement balance on the due date — no manual entry, no click.

**Architecture:** Three links. (1) The parser contract gains three optional summary fields; the Wealthsimple parser populates them. (2) A new `applyCreditCardStatementSummary` runs at the shared account-resolution chokepoint (`resolvePdfAccountFromHeader`), persisting the fields onto `LiabilityAccount` with a newer-statement-wins staleness guard. (3) The materialize-payment logic is extracted from the HTTP route into a shared `materializeCreditCardPayment` service that both the route and the import path call.

**Tech Stack:** TypeScript, Express, Sequelize (dual-dialect SQLite/Postgres), `node:test` via `tsx` for backend unit tests (colocated `*.test.ts`).

## Global Constraints

- Backend unit tests use `node:test` via `tsx`, colocated as `foo.test.ts` beside `foo.ts` under `backend/src/`. Run a single file: `cd backend && yarn tsx --import ./test/setup.ts --test src/<path>.test.ts`.
- Sequelize must run on both SQLite and Postgres — no dialect-specific SQL.
- Monetary columns are `DECIMAL(14,4)` carried as strings for transport; `PlannedEvent.amount` is stored via `amount.toFixed(4)`.
- ISO dates are `YYYY-MM-DD`; `DATEONLY` columns compare correctly as lexicographic strings.
- New parser summary fields are **optional** and default to `null` — they must never break existing parsers or the transaction path, and a present-but-unparseable value resolves to `null` (no separate error channel).
- No `Co-Authored-By` / co-author trailers on commits.
- Commit with the husky PATH prefix: `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …` (worktree has no local `node_modules`).

---

## File Structure

- `backend/src/import/pdf/types.ts` — **modify**: add `statementBalance?`, `paymentDueDate?`, `minimumPayment?` to `PdfStatementHeader`.
- `backend/src/import/pdf/wealthsimpleCreditCard.ts` — **modify**: extract the three summary fields in `parseWsCreditCardHeader`.
- `backend/src/import/pdf/pdfWealthsimpleCreditCard.test.ts` — **modify**: assert extraction + absence.
- `backend/src/cards/materializePayment.ts` — **create**: `materializeCreditCardPayment(...)` + `cardPaymentTag(...)` (extracted from the route).
- `backend/src/cards/materializePayment.test.ts` — **create**: service unit test (idempotent replace).
- `backend/src/routes/creditCards.ts` — **modify**: route calls the service instead of inlining destroy + create.
- `backend/src/cards/applyStatementSummary.ts` — **create**: `applyCreditCardStatementSummary(...)` (persist + staleness + auto-place guard).
- `backend/src/cards/applyStatementSummary.test.ts` — **create**: persist, guard (no due date → no event), idempotency, staleness.
- `backend/src/import/runImport.ts` — **modify**: call `applyCreditCardStatementSummary` at the end of `resolvePdfAccountFromHeader` (covers both the bundle path and the async worker path, which both call it).

---

## Task 1: Parser contract + Wealthsimple summary extraction

**Files:**
- Modify: `backend/src/import/pdf/types.ts:41-66`
- Modify: `backend/src/import/pdf/wealthsimpleCreditCard.ts:46-56`
- Test: `backend/src/import/pdf/pdfWealthsimpleCreditCard.test.ts`

**Interfaces:**
- Produces: `PdfStatementHeader` gains `statementBalance?: number | null`, `paymentDueDate?: string | null` (ISO `YYYY-MM-DD`), `minimumPayment?: number | null`. `parseWsCreditCardHeader(lines)` populates them (each `null` when not found/unparseable).

> **Note on labels:** the exact Wealthsimple wording for the new-balance and due-date lines is assumed here (`New balance`, `Payment due date`). The confirmed label `Minimum payment` comes from the existing fixture. If the real statement differs, only these regexes change; the downstream guard fails safe (no event) rather than wrong.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/import/pdf/pdfWealthsimpleCreditCard.test.ts`:

```ts
test('header extracts statement balance, payment due date, minimum payment', () => {
  const h = parseWsCreditCardHeader([
    mk('Credit card statement'),
    mk(' Wealthsimple    Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk(' Statement date   May 15, 2026          Minimum payment   $10.00'),
    mk(' New balance   $1,234.56'),
    mk(' Payment due date   Jun 11, 2026'),
  ]);
  assert.equal(h.statementBalance, 1234.56);
  assert.equal(h.paymentDueDate, '2026-06-11');
  assert.equal(h.minimumPayment, 10);
});

test('header summary fields are null when the summary block is absent', () => {
  const h = parseWsCreditCardHeader([
    mk('Credit card statement'),
    mk(' Wealthsimple    Apr 15 — May 14, 2026'),
    mk('4126 50** **** 3338'),
    mk(' Statement date   May 15, 2026'),
  ]);
  assert.equal(h.statementBalance, null);
  assert.equal(h.paymentDueDate, null);
  assert.equal(h.minimumPayment, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/pdf/pdfWealthsimpleCreditCard.test.ts`
Expected: FAIL — `statementBalance` etc. are `undefined`, not the asserted values.

- [ ] **Step 3: Add the optional fields to the contract**

In `backend/src/import/pdf/types.ts`, inside the `PdfStatementHeader` type (after `accountHolder?`):

```ts
  /**
   * Credit-card statement summary fields, when the parser can read the bill
   * block. Drive the statement→calendar auto-fill (#243 follow-up). `null` when
   * absent or unparseable — never throw, never break the transaction path.
   */
  /** New balance owed for the cycle (positive). */
  statementBalance?: number | null;
  /** ISO YYYY-MM-DD payment due date as printed on the statement. */
  paymentDueDate?: string | null;
  /** Minimum payment due for the cycle (positive). */
  minimumPayment?: number | null;
```

- [ ] **Step 4: Extract the fields in the Wealthsimple parser**

In `backend/src/import/pdf/wealthsimpleCreditCard.ts`, add these helpers above `parseWsCreditCardHeader` (reuse the existing `MONTHS` map and `toIso`):

```ts
// "$1,234.56" → 1234.56; null when no money token present.
function parseSummaryMoney(lines: PdfLine[], label: RegExp): number | null {
  for (const l of lines) {
    const m = label.exec(l.text);
    if (m) {
      const n = Number(m[1].replace(/[,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

// "Jun 11, 2026" → "2026-06-11"; null when missing/unparseable.
function parseSummaryDate(lines: PdfLine[], label: RegExp): string | null {
  for (const l of lines) {
    const m = label.exec(l.text);
    if (!m) continue;
    const month = MONTHS[m[1]];
    if (month === undefined) return null;
    return toIso(Number(m[3]), month, Number(m[2]));
  }
  return null;
}
```

Then update `parseWsCreditCardHeader` to populate the new fields:

```ts
export function parseWsCreditCardHeader(lines: PdfLine[]): PdfStatementHeader {
  const period = parsePeriod(lines);
  return {
    accountSuffix: parseLast4(lines),
    productLabel: 'Wealthsimple Credit Card',
    accountType: 'credit_card',
    periodStart: period.start,
    periodEnd: period.end,
    currency: 'CAD',
    statementBalance: parseSummaryMoney(lines, /New balance\s+\$?([\d,]+\.\d{2})/),
    minimumPayment: parseSummaryMoney(lines, /Minimum payment\s+\$?([\d,]+\.\d{2})/),
    paymentDueDate: parseSummaryDate(lines, /Payment due date\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/pdf/pdfWealthsimpleCreditCard.test.ts`
Expected: PASS (all tests in the file, including the pre-existing ones).

- [ ] **Step 6: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/goofy-borg-7e3de5
git add backend/src/import/pdf/types.ts backend/src/import/pdf/wealthsimpleCreditCard.ts backend/src/import/pdf/pdfWealthsimpleCreditCard.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(import): extract statement balance, due date, min payment from WS credit-card statements"
```

---

## Task 2: Extract the materialize-payment service

**Files:**
- Create: `backend/src/cards/materializePayment.ts`
- Create: `backend/src/cards/materializePayment.test.ts`
- Modify: `backend/src/routes/creditCards.ts:471-548`

**Interfaces:**
- Produces: `materializeCreditCardPayment(input: MaterializeCardPaymentInput): Promise<InstanceType<typeof PlannedEvent>>` where
  ```ts
  type MaterializeCardPaymentInput = {
    accountId: number;
    accountName: string;
    userId: number;
    householdId: number;
    amount: number;        // must be > 0
    currency: string;
    expectedDate: string;  // ISO YYYY-MM-DD
  };
  ```
  Owns per-card idempotency (destroys prior `planned` `source=credit_card` events for the card) then creates the new `debt_payment` event. Also exports `cardPaymentTag(accountId: number): string`.
- Consumes (Task 3): the same function, called with `expectedDate = paymentDueDate` and `amount = statementBalance`.

- [ ] **Step 1: Write the failing service test**

Create `backend/src/cards/materializePayment.test.ts`:

```ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Account, PlannedEvent } from '../models';
import { materializeCreditCardPayment } from './materializePayment';

let accountId: number;
const householdId = 9001;
const userId = 9001;

before(async () => {
  const acct = await Account.create({
    householdId, name: 'Test Card', accountType: 'credit_card',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD',
    ownerUserId: userId, shortCode: 'CARD1',
  });
  accountId = acct.id;
});

test('materialize creates a planned credit_card debt_payment', async () => {
  const ev = await materializeCreditCardPayment({
    accountId, accountName: 'Test Card', userId, householdId,
    amount: 1234.56, currency: 'CAD', expectedDate: '2026-06-11',
  });
  assert.equal(ev.type, 'debt_payment');
  assert.equal(ev.source, 'credit_card');
  assert.equal(ev.status, 'planned');
  assert.equal(ev.expectedDate, '2026-06-11');
  assert.equal(String(ev.amount), '1234.5600');
});

test('materialize is idempotent per card (replaces prior planned event)', async () => {
  await materializeCreditCardPayment({
    accountId, accountName: 'Test Card', userId, householdId,
    amount: 50, currency: 'CAD', expectedDate: '2026-07-11',
  });
  const planned = await PlannedEvent.findAll({
    where: { accountId, source: 'credit_card', status: 'planned' },
  });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].expectedDate, '2026-07-11');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cards/materializePayment.test.ts`
Expected: FAIL — `Cannot find module './materializePayment'`.

- [ ] **Step 3: Create the service**

Create `backend/src/cards/materializePayment.ts`:

```ts
import { PlannedEvent } from '../models';

export type MaterializeCardPaymentInput = {
  accountId: number;
  accountName: string;
  userId: number;
  householdId: number;
  amount: number;        // must be > 0
  currency: string;
  expectedDate: string;  // ISO YYYY-MM-DD
};

/** Marker embedded in a planned event's notes to make the feed idempotent. */
export function cardPaymentTag(accountId: number): string {
  return `[cc-payment:${accountId}]`;
}

/**
 * Materialize (or replace) a single planned credit-card payment for a card.
 * Idempotent per card: destroys any prior `planned` `source=credit_card` event
 * for the account, then creates the new one. Posted (paid) events are preserved
 * as history. Shared by the HTTP route and the statement-import path.
 */
export async function materializeCreditCardPayment(
  input: MaterializeCardPaymentInput,
): Promise<InstanceType<typeof PlannedEvent>> {
  const { accountId, accountName, userId, householdId, amount, currency, expectedDate } = input;

  await PlannedEvent.destroy({
    where: { householdId, accountId, source: 'credit_card', status: 'planned' },
  });

  return PlannedEvent.create({
    userId,
    householdId,
    accountId,
    type: 'debt_payment',
    name: `${accountName} payment`,
    amount: amount.toFixed(4),
    currency,
    expectedDate,
    recurrenceRule: null,
    source: 'credit_card',
    status: 'planned',
    linkedTransactionId: null,
    notes: cardPaymentTag(accountId),
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cards/materializePayment.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor the route to call the service**

In `backend/src/routes/creditCards.ts`: remove the local `cardPaymentTag` definition (lines 471-474) and import the service at the top with the other imports:

```ts
import { materializeCreditCardPayment } from '../cards/materializePayment';
```

Then replace the inline destroy + create block (lines 520-548) with:

```ts
    const plannedEvent = await materializeCreditCardPayment({
      accountId,
      accountName: account.name,
      userId: user.id,
      householdId: household.id,
      amount,
      currency,
      expectedDate,
    });
```

Leave the surrounding handler (validation, `safeToSpend` computation, the 201 response shape) untouched.

- [ ] **Step 6: Run the credit-card route tests to verify no regression**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cards/materializePayment.test.ts` and the credit-card integration suite if Postgres is available: `cd backend && TEST_DATABASE_URL=... yarn test:integration` (or rely on CI's integration job).
Expected: PASS — route behavior unchanged.

- [ ] **Step 7: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/goofy-borg-7e3de5
git add backend/src/cards/materializePayment.ts backend/src/cards/materializePayment.test.ts backend/src/routes/creditCards.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "refactor(cards): extract materializeCreditCardPayment service from the route"
```

---

## Task 3: Apply statement summary on import (persist + staleness + auto-place)

**Files:**
- Create: `backend/src/cards/applyStatementSummary.ts`
- Create: `backend/src/cards/applyStatementSummary.test.ts`
- Modify: `backend/src/import/runImport.ts:1135-1138` (end of `resolvePdfAccountFromHeader`)

**Interfaces:**
- Consumes: `materializeCreditCardPayment` (Task 2), `PdfStatementHeader` summary fields (Task 1).
- Produces: `applyCreditCardStatementSummary(opts: { account: InstanceType<typeof Account>; header: PdfStatementHeader; userId: number; householdId: number }): Promise<void>`. No-op for non-`credit_card` accounts and for strictly-older statements.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/cards/applyStatementSummary.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfStatementHeader } from '../import/pdf/types';
import { Account, LiabilityAccount, PlannedEvent } from '../models';
import { applyCreditCardStatementSummary } from './applyStatementSummary';

const householdId = 7001;
const userId = 7001;

function baseHeader(over: Partial<PdfStatementHeader> = {}): PdfStatementHeader {
  return {
    accountSuffix: '3338',
    productLabel: 'Wealthsimple Credit Card',
    accountType: 'credit_card',
    periodStart: '2026-04-15',
    periodEnd: '2026-05-14',
    statementBalance: 1234.56,
    paymentDueDate: '2026-06-11',
    minimumPayment: 10,
    ...over,
  };
}

async function makeCard(shortCode: string) {
  return Account.create({
    householdId, name: 'WS Card', accountType: 'credit_card',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD',
    ownerUserId: userId, shortCode,
  });
}

test('persists summary fields and auto-places the calendar payment', async () => {
  const account = await makeCard('CC-A');
  await applyCreditCardStatementSummary({ account, header: baseHeader(), userId, householdId });

  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(String(liab!.statementBalance), '1234.5600');
  assert.equal(String(liab!.minimumPayment), '10.0000');
  assert.equal(liab!.dueDay, 11);
  assert.equal(liab!.statementDate, '2026-05-14');

  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card', status: 'planned' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].expectedDate, '2026-06-11');
  assert.equal(String(events[0].amount), '1234.5600');
});

test('no due date → fields persisted but no calendar payment (guard)', async () => {
  const account = await makeCard('CC-B');
  await applyCreditCardStatementSummary({
    account, header: baseHeader({ paymentDueDate: null }), userId, householdId,
  });
  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(String(liab!.statementBalance), '1234.5600');
  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card' },
  });
  assert.equal(events.length, 0);
});

test('re-import of the same statement keeps exactly one planned payment', async () => {
  const account = await makeCard('CC-C');
  await applyCreditCardStatementSummary({ account, header: baseHeader(), userId, householdId });
  await applyCreditCardStatementSummary({ account, header: baseHeader(), userId, householdId });
  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card', status: 'planned' },
  });
  assert.equal(events.length, 1);
});

test('a strictly-older statement is a no-op (newer-wins)', async () => {
  const account = await makeCard('CC-D');
  // Newer statement first.
  await applyCreditCardStatementSummary({
    account,
    header: baseHeader({ periodEnd: '2026-05-14', statementBalance: 999, paymentDueDate: '2026-06-11' }),
    userId, householdId,
  });
  // Older statement second — must not clobber.
  await applyCreditCardStatementSummary({
    account,
    header: baseHeader({ periodEnd: '2026-04-14', statementBalance: 111, paymentDueDate: '2026-05-11' }),
    userId, householdId,
  });
  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(String(liab!.statementBalance), '999.0000');
  assert.equal(liab!.statementDate, '2026-05-14');
  const events = await PlannedEvent.findAll({
    where: { accountId: account.id, source: 'credit_card', status: 'planned' },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].expectedDate, '2026-06-11');
});

test('non-credit_card account is ignored', async () => {
  const account = await Account.create({
    householdId, name: 'Chequing', accountType: 'checking',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD',
    ownerUserId: userId, shortCode: 'CHQ-1',
  });
  await applyCreditCardStatementSummary({
    account, header: baseHeader({ accountType: 'checking' }), userId, householdId,
  });
  const liab = await LiabilityAccount.findOne({ where: { accountId: account.id } });
  assert.equal(liab, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cards/applyStatementSummary.test.ts`
Expected: FAIL — `Cannot find module './applyStatementSummary'`.

- [ ] **Step 3: Create the applier**

Create `backend/src/cards/applyStatementSummary.ts`:

```ts
import type { Account } from '../models';
import { LiabilityAccount } from '../models';
import type { PdfStatementHeader } from '../import/pdf/types';
import { materializeCreditCardPayment } from './materializePayment';
import { logger } from '../observability/logger';

type Opts = {
  account: InstanceType<typeof Account>;
  header: PdfStatementHeader;
  userId: number;
  householdId: number;
};

/**
 * On credit-card statement import: persist the parsed summary fields onto the
 * card's LiabilityAccount sidecar (import is source of truth), then auto-place a
 * calendar payment for the statement balance on the parsed due date.
 *
 * Guards:
 *  - non-credit_card accounts: no-op.
 *  - strictly-older statement than the stored statementDate: no-op (newer-wins).
 *  - missing statement balance OR due date: persist what parsed, but DO NOT
 *    auto-place an event (never trust a partial parse to write money to the
 *    calendar).
 */
export async function applyCreditCardStatementSummary(opts: Opts): Promise<void> {
  const { account, header, userId, householdId } = opts;
  if (header.accountType !== 'credit_card') return;

  const statementBalance = header.statementBalance ?? null;
  const minimumPayment = header.minimumPayment ?? null;
  const paymentDueDate = header.paymentDueDate ?? null;
  // The statement cycle date used for both storage and staleness ordering.
  const incomingStatementDate = header.periodEnd;

  const existing = await LiabilityAccount.findOne({ where: { accountId: account.id } });

  // Staleness guard: a strictly-older statement must not clobber the current bill.
  if (existing?.statementDate && incomingStatementDate < existing.statementDate) {
    logger.info(
      { accountId: account.id, incomingStatementDate, stored: existing.statementDate },
      'cc-statement: skipping older statement (newer-wins)',
    );
    return;
  }

  const dueDay = paymentDueDate ? Number(paymentDueDate.slice(8, 10)) : null;

  // Upsert only the fields that parsed (non-null), never wiping existing values.
  const updates: Partial<{
    statementBalance: string; minimumPayment: string; dueDay: number; statementDate: string;
  }> = { statementDate: incomingStatementDate };
  if (statementBalance != null) updates.statementBalance = statementBalance.toFixed(4);
  if (minimumPayment != null) updates.minimumPayment = minimumPayment.toFixed(4);
  if (dueDay != null) updates.dueDay = dueDay;

  if (existing) {
    await existing.update(updates);
  } else {
    await LiabilityAccount.create({ accountId: account.id, householdId, ...updates });
  }

  // Auto-place guard: both balance AND due date must be clean to write the event.
  if (statementBalance != null && statementBalance > 0 && paymentDueDate != null) {
    await materializeCreditCardPayment({
      accountId: account.id,
      accountName: account.name,
      userId,
      householdId,
      amount: statementBalance,
      currency: account.defaultCurrency ?? 'CAD',
      expectedDate: paymentDueDate,
    });
  } else {
    logger.info(
      { accountId: account.id, hasBalance: statementBalance != null, hasDueDate: paymentDueDate != null },
      'cc-statement: fields persisted but auto-place skipped (incomplete parse)',
    );
  }
}
```

> If the logger import path differs, match the existing one used in `backend/src/import/runImport.ts` (grep `import { logger }` there); the calls are plain `logger.info(obj, msg)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/cards/applyStatementSummary.test.ts`
Expected: PASS (all six tests).

- [ ] **Step 5: Wire the applier into the shared resolution chokepoint**

In `backend/src/import/runImport.ts`, import the applier near the other imports:

```ts
import { applyCreditCardStatementSummary } from '../cards/applyStatementSummary';
```

Then in `resolvePdfAccountFromHeader`, just before `return { account, accountCreated, overrideBusiness };` (currently line 1138), add:

```ts
  // Credit-card statement → calendar auto-fill (#243 follow-up). Runs for both
  // the bundle path and the async pdfImportProcessor worker, since both resolve
  // their account through this function. Self-guards on accountType.
  await applyCreditCardStatementSummary({ account, header, userId, householdId });
```

- [ ] **Step 6: Typecheck + run the affected unit tests**

Run: `cd backend && yarn run typecheck && yarn tsx --import ./test/setup.ts --test src/cards/applyStatementSummary.test.ts src/cards/materializePayment.test.ts src/import/pdf/pdfWealthsimpleCreditCard.test.ts`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/connoradams/Developer/cashflow/.claude/worktrees/goofy-borg-7e3de5
git add backend/src/cards/applyStatementSummary.ts backend/src/cards/applyStatementSummary.test.ts backend/src/import/runImport.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(cards): auto-fill statement balance + due date onto the calendar on credit-card statement import"
```

---

## Final verification

- [ ] Run the full backend unit suite: `cd backend && yarn test` (or the repo-root `yarn test`).
- [ ] If Postgres is available, run integration: `cd backend && TEST_DATABASE_URL=... yarn test:integration` — confirm the existing credit-card route suite is green (proves the Task 2 service refactor preserved behavior).
- [ ] Manual smoke (optional): import a real Wealthsimple credit-card statement, confirm the card's statement balance / due date populate and a `debt_payment` appears on the calendar at the due date. If the new-balance / due-date fields stay null, the assumed labels (Task 1 note) need correcting against the real PDF text.

## Spec coverage check

- Link 1 (extract) → Task 1. Link 2 (persist) → Task 3 steps 3+5. Link 3 (auto-place) → Tasks 2 + 3.
- Decision 1 (auto-place no click) → Task 3 wiring. Decision 2 (amount = statement balance) → Task 3 `amount: statementBalance`. Decision 3 (import source of truth) → Task 3 upsert. Decision 4 (exact date + dueDay) → Task 3 `expectedDate: paymentDueDate` + `dueDay`. Decision 5 (hard guard) → Task 3 auto-place guard. Decision 6 (no pay-from) → service sets none. Decision 7 (WS only via seam) → Task 1 contract + WS-only extraction. Staleness guard → Task 3.
- Out-of-scope items (Costco/Visa, RBC credit line, pay-from auto-attach, notifications) → not implemented, as specified.
```
