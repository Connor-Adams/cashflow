# Smarter Email Search — Receipt Source Discovery (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Gmail "discovery pass" that finds receipts from senders not on the allowlist, auto-ingesting high-confidence ones and surfacing the rest as approvable sender suggestions.

**Architecture:** A new `discoverReceiptSources()` orchestrator runs a broad Gmail query (`category:purchases` OR receipt subject keywords, minus known senders) beside the untouched fast `scanInbox`. Each candidate is parsed with the existing deterministic/AI pipeline, then split by confidence: HIGH → create `ExternalOrder` + auto-learn its sender; LOW → upsert a `suggested` row in `receipt_sender_allowlist` (no order). New routes drive it; `GmailSection` gets a Discover button + suggestions list.

**Tech Stack:** TypeScript, Express, Sequelize (dual-dialect SQLite/Postgres), React 19 + Vite, `node:test` via `tsx` (backend) / vitest (frontend).

## Global Constraints

- Backend tests are `node:test` via `tsx`, colocated `*.test.ts` beside source under `backend/src/`. Run one file: `cd backend && yarn tsx --import ./test/setup.ts --test src/<path>.test.ts`.
- Unit tests get a per-process SQLite DB; schema is created by the models' `sequelize.sync()` — a new model attribute auto-creates its column in the test DB. The migration is for prod/Postgres.
- Sequelize must run on **both** SQLite and Postgres. Migrations are JS in `backend/src/migrations/`, named `YYYYMMDD...-slug.js`. Migration *tests* (if any) live in `backend/src/migrations/__tests__/`, never in `src/migrations/`.
- Multi-currency app; `DEFAULT_CURRENCY=CAD`. Never fabricate `'USD'` — use `receiptCurrencyOrDefault()`.
- No `Co-Authored-By` / co-author trailers in commits.
- Commits in this worktree need the repo-root bin on PATH (husky/lint-staged): prefix with `PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit …`.
- The fast `scanInbox` path is **not** modified by this plan — discovery reuses its exported helpers without touching it.

---

### Task 1: Schema — extend `receipt_sender_allowlist`

**Files:**
- Modify: `backend/src/models/ReceiptSenderAllowlist.ts`
- Create: `backend/src/migrations/20260618120000-receipt-sender-allowlist-discovery.js`
- Test: `backend/src/models/ReceiptSenderAllowlist.test.ts`

**Interfaces:**
- Produces: `ReceiptSenderAllowlist` gains `status: 'enabled' | 'suggested' | 'dismissed'` (default `'enabled'`), `source: 'user' | 'discovery'` (default `'user'`), `sampleSubject: string | null`, `candidateCount: number` (default `0`), `lastSeenAt: Date | null`. Column names: `status`, `source`, `sample_subject`, `candidate_count`, `last_seen_at`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/models/ReceiptSenderAllowlist.test.ts`:

```typescript
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ReceiptSenderAllowlist } from './index';

before(async () => {
  await sequelize.sync({ force: true });
});

test('new discovery columns default correctly', async () => {
  const row = await ReceiptSenderAllowlist.create({
    householdId: 1,
    emailAddress: 'shop@example.com',
  });
  assert.equal(row.status, 'enabled');
  assert.equal(row.source, 'user');
  assert.equal(row.candidateCount, 0);
  assert.equal(row.sampleSubject, null);
  assert.equal(row.lastSeenAt, null);
});

test('a suggested row persists its discovery fields', async () => {
  const row = await ReceiptSenderAllowlist.create({
    householdId: 1,
    emailAddress: 'invoices@vendor.test',
    status: 'suggested',
    source: 'discovery',
    sampleSubject: 'Your receipt',
    candidateCount: 3,
    lastSeenAt: new Date(),
  });
  const reloaded = await ReceiptSenderAllowlist.findByPk(row.id);
  assert.equal(reloaded?.status, 'suggested');
  assert.equal(reloaded?.candidateCount, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/models/ReceiptSenderAllowlist.test.ts`
Expected: FAIL — `status`/`candidateCount` undefined (columns/attributes don't exist yet).

- [ ] **Step 3: Add the model attributes**

In `backend/src/models/ReceiptSenderAllowlist.ts`, add declarations to the class (after `enabled`):

```typescript
  declare status: CreationOptional<'enabled' | 'suggested' | 'dismissed'>;
  declare source: CreationOptional<'user' | 'discovery'>;
  declare sampleSubject: CreationOptional<string | null>;
  declare candidateCount: CreationOptional<number>;
  declare lastSeenAt: CreationOptional<Date | null>;
```

And add to the `init` attributes object (after `enabled`):

```typescript
      status: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'enabled',
      },
      source: {
        type: DataTypes.STRING(16),
        allowNull: false,
        defaultValue: 'user',
      },
      sampleSubject: {
        type: DataTypes.STRING(256),
        field: 'sample_subject',
        allowNull: true,
        defaultValue: null,
      },
      candidateCount: {
        type: DataTypes.INTEGER,
        field: 'candidate_count',
        allowNull: false,
        defaultValue: 0,
      },
      lastSeenAt: {
        type: DataTypes.DATE,
        field: 'last_seen_at',
        allowNull: true,
        defaultValue: null,
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/models/ReceiptSenderAllowlist.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Write the production migration**

Create `backend/src/migrations/20260618120000-receipt-sender-allowlist-discovery.js`:

```javascript
'use strict';

/** Adds discovery columns to receipt_sender_allowlist: status/source
 *  discriminators plus suggestion metadata. Existing rows backfill to
 *  status='enabled', source='user' so the fast scan's enabled filter is
 *  unaffected. Dual-dialect (SQLite + Postgres). */
module.exports = {
  async up(queryInterface, Sequelize) {
    const t = 'receipt_sender_allowlist';
    await queryInterface.addColumn(t, 'status', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'enabled',
    });
    await queryInterface.addColumn(t, 'source', {
      type: Sequelize.STRING(16),
      allowNull: false,
      defaultValue: 'user',
    });
    await queryInterface.addColumn(t, 'sample_subject', {
      type: Sequelize.STRING(256),
      allowNull: true,
    });
    await queryInterface.addColumn(t, 'candidate_count', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn(t, 'last_seen_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    const t = 'receipt_sender_allowlist';
    await queryInterface.removeColumn(t, 'last_seen_at');
    await queryInterface.removeColumn(t, 'candidate_count');
    await queryInterface.removeColumn(t, 'sample_subject');
    await queryInterface.removeColumn(t, 'source');
    await queryInterface.removeColumn(t, 'status');
  },
};
```

- [ ] **Step 6: Verify the migration applies**

Run: `cd backend && yarn db:migrate`
Expected: migration `20260618120000-receipt-sender-allowlist-discovery` runs with no error (against the local SQLite dev DB).

- [ ] **Step 7: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/models/ReceiptSenderAllowlist.ts backend/src/models/ReceiptSenderAllowlist.test.ts backend/src/migrations/20260618120000-receipt-sender-allowlist-discovery.js
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): add discovery columns to receipt_sender_allowlist"
```

---

### Task 2: Broad query builder + exclusion helpers

**Files:**
- Modify: `backend/src/integrations/scanReceipts.ts` (add exports beside `buildGmailQuery`)
- Test: `backend/src/integrations/discoveryQuery.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_RECEIPT_SENDERS`, `getEffectiveAllowlist` (existing exports).
- Produces:
  - `DISCOVERY_SUBJECT_KEYWORDS: string[]`
  - `buildDiscoveryQuery(opts: { sinceDate: Date | null; excludeSenders: string[]; includePdfAttachments?: boolean }): string`
  - `getDismissedSenders(householdId: number): Promise<string[]>`
  - `getDiscoveryExclusions(householdId: number): Promise<string[]>` — union of effective allowlist (enabled + defaults) and dismissed senders, lowercased, deduped.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/discoveryQuery.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscoveryQuery } from './scanReceipts';

test('buildDiscoveryQuery ORs purchases + subject keywords and excludes senders', () => {
  const q = buildDiscoveryQuery({
    sinceDate: new Date('2026-06-01T00:00:00Z'),
    excludeSenders: ['a@x.com', 'b@y.com'],
  });
  assert.match(q, /category:purchases/);
  assert.match(q, /subject:\(/);
  assert.match(q, /"order confirmation"/);
  assert.match(q, /-from:a@x\.com/);
  assert.match(q, /-from:b@y\.com/);
  assert.match(q, /after:2026\/06\/01/);
});

test('buildDiscoveryQuery omits the PDF clause unless asked', () => {
  const base = buildDiscoveryQuery({ sinceDate: null, excludeSenders: [] });
  assert.doesNotMatch(base, /filename:pdf/);
  const withPdf = buildDiscoveryQuery({ sinceDate: null, excludeSenders: [], includePdfAttachments: true });
  assert.match(withPdf, /has:attachment filename:pdf/);
});

test('buildDiscoveryQuery with no exclusions still emits a valid signal clause', () => {
  const q = buildDiscoveryQuery({ sinceDate: null, excludeSenders: [] });
  assert.match(q, /category:purchases/);
  assert.doesNotMatch(q, /-from:/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoveryQuery.test.ts`
Expected: FAIL — `buildDiscoveryQuery` is not exported.

- [ ] **Step 3: Implement the helpers**

In `backend/src/integrations/scanReceipts.ts`, add after `buildGmailQuery` (and ensure `ReceiptSenderAllowlist` is already imported — it is):

```typescript
/** Receipt-ish subject keywords for the discovery net. Quoted phrases are kept
 *  as Gmail exact-phrase matches. */
export const DISCOVERY_SUBJECT_KEYWORDS = [
  'receipt',
  'invoice',
  '"order confirmation"',
  '"your order"',
  '"payment received"',
  '"tax invoice"',
];

/** Builds the broad discovery query: Gmail's purchases category OR receipt
 *  subject keywords (OR PDF-attachment invoices when enabled), minus senders we
 *  already handle, within the date window. */
export function buildDiscoveryQuery(opts: {
  sinceDate: Date | null;
  excludeSenders: string[];
  includePdfAttachments?: boolean;
}): string {
  const signals = [
    'category:purchases',
    `subject:(${DISCOVERY_SUBJECT_KEYWORDS.join(' OR ')})`,
  ];
  if (opts.includePdfAttachments) {
    signals.push('(has:attachment filename:pdf subject:(invoice OR receipt))');
  }
  const parts = [`(${signals.join(' OR ')})`];
  for (const addr of opts.excludeSenders) {
    parts.push(`-from:${addr}`);
  }
  if (opts.sinceDate) {
    const y = opts.sinceDate.getUTCFullYear();
    const m = String(opts.sinceDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(opts.sinceDate.getUTCDate()).padStart(2, '0');
    parts.push(`after:${y}/${m}/${d}`);
  }
  return parts.join(' ');
}

/** Senders the household explicitly dismissed during discovery — excluded from
 *  future discovery queries so they never re-surface. */
export async function getDismissedSenders(householdId: number): Promise<string[]> {
  const rows = await ReceiptSenderAllowlist.findAll({
    where: { householdId, status: 'dismissed' },
    attributes: ['emailAddress'],
  });
  return rows.map((r) => r.emailAddress.toLowerCase());
}

/** Everything the discovery query should exclude: senders the fast scan already
 *  covers (enabled allowlist + baked-in defaults) plus dismissed senders. */
export async function getDiscoveryExclusions(householdId: number): Promise<string[]> {
  const [allowed, dismissed] = await Promise.all([
    getEffectiveAllowlist(householdId),
    getDismissedSenders(householdId),
  ]);
  return [...new Set([...allowed, ...dismissed])];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoveryQuery.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/scanReceipts.ts backend/src/integrations/discoveryQuery.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): broad discovery Gmail query + exclusion helpers"
```

---

### Task 3: Confidence classifier + Gmail `labelIds`

**Files:**
- Modify: `backend/src/integrations/gmail.ts` (add `labelIds` to `GmailMessageFull`)
- Create: `backend/src/integrations/discoveryConfidence.ts`
- Test: `backend/src/integrations/discoveryConfidence.test.ts`

**Interfaces:**
- Produces:
  - `GmailMessageFull.labelIds?: string[]` (already returned by Gmail `messages.get`; just surface it on the type — the JSON cast in `fetchMessage` already carries it through).
  - `isPurchasesLabel(labelIds: string[] | null | undefined): boolean` — true iff `CATEGORY_PURCHASES` present.
  - `classifyDiscoveryConfidence(args: { parser: string; isPurchases: boolean; hasCleanExtract: boolean; amountMatched: boolean }): 'high' | 'low'`

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/discoveryConfidence.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPurchasesLabel, classifyDiscoveryConfidence } from './discoveryConfidence';

test('isPurchasesLabel detects the Gmail purchases category', () => {
  assert.equal(isPurchasesLabel(['INBOX', 'CATEGORY_PURCHASES']), true);
  assert.equal(isPurchasesLabel(['INBOX', 'CATEGORY_PROMOTIONS']), false);
  assert.equal(isPurchasesLabel(null), false);
  assert.equal(isPurchasesLabel(undefined), false);
});

test('a deterministic parser hit is always HIGH', () => {
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'amazon', isPurchases: false, hasCleanExtract: true, amountMatched: false }),
    'high',
  );
});

test('AI extract is HIGH only with purchases label + clean extract + amount match', () => {
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: true, hasCleanExtract: true, amountMatched: true }),
    'high',
  );
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: true, hasCleanExtract: true, amountMatched: false }),
    'low',
  );
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: false, hasCleanExtract: true, amountMatched: true }),
    'low',
  );
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: true, hasCleanExtract: false, amountMatched: true }),
    'low',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoveryConfidence.test.ts`
Expected: FAIL — module `./discoveryConfidence` not found.

- [ ] **Step 3: Implement the classifier**

Create `backend/src/integrations/discoveryConfidence.ts`:

```typescript
/**
 * Confidence tiering for the discovery pass. Pure — no DB, no network.
 *
 * HIGH (auto-ingest): a deterministic vendor parser matched (we trust those
 * regardless of sender), OR Gmail itself filed the mail under purchases AND we
 * got a clean structured extract AND its amount matches a real transaction.
 * Everything else is LOW (surface the sender as a suggestion, write no order).
 */
export function isPurchasesLabel(labelIds: string[] | null | undefined): boolean {
  return Array.isArray(labelIds) && labelIds.includes('CATEGORY_PURCHASES');
}

export function classifyDiscoveryConfidence(args: {
  parser: string;
  isPurchases: boolean;
  hasCleanExtract: boolean;
  amountMatched: boolean;
}): 'high' | 'low' {
  if (args.parser !== 'ai') return 'high';
  if (args.isPurchases && args.hasCleanExtract && args.amountMatched) return 'high';
  return 'low';
}
```

And in `backend/src/integrations/gmail.ts`, add `labelIds` to the `GmailMessageFull` interface (after `internalDate`):

```typescript
  labelIds?: string[];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoveryConfidence.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/discoveryConfidence.ts backend/src/integrations/discoveryConfidence.test.ts backend/src/integrations/gmail.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): discovery confidence classifier + Gmail labelIds"
```

---

### Task 4: Pre-persist transaction amount-match check

**Files:**
- Modify: `backend/src/import/matchReceiptToTransactions.ts` (add export)
- Test: `backend/src/import/hasMatchingTransaction.test.ts`

**Interfaces:**
- Consumes: existing `scoreReceiptMatch`, `txnMatchesVendor`, `MATCH_CONFIDENCE_THRESHOLD`, `DATE_WINDOW_DAYS`, `shiftDate` (all in this module).
- Produces: `hasMatchingTransaction(args: { householdId: number; vendor: string; total: number | null; currency: string; orderDate: string | null; paymentLast4: string | null }): Promise<boolean>` — true iff at least one transaction in the date window scores ≥ `MATCH_CONFIDENCE_THRESHOLD`. Does **not** persist anything.

- [ ] **Step 1: Write the failing test**

Create `backend/src/import/hasMatchingTransaction.test.ts`:

```typescript
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Transaction } from '../models';
import { hasMatchingTransaction } from './matchReceiptToTransactions';

before(async () => {
  await sequelize.sync({ force: true });
});
beforeEach(async () => {
  await Transaction.destroy({ where: {} });
});

test('returns true when a same-amount, in-window transaction exists', async () => {
  await Transaction.create({
    householdId: 1,
    date: '2026-06-10',
    amount: '42.00',
    currency: 'CAD',
    merchantRaw: 'FOOSHOP',
    merchantClean: 'Fooshop',
  } as never);
  const matched = await hasMatchingTransaction({
    householdId: 1,
    vendor: 'other',
    total: 42.0,
    currency: 'CAD',
    orderDate: '2026-06-10',
    paymentLast4: null,
  });
  assert.equal(matched, true);
});

test('returns false when no transaction is close in amount or date', async () => {
  await Transaction.create({
    householdId: 1,
    date: '2026-01-01',
    amount: '999.00',
    currency: 'CAD',
    merchantRaw: 'OTHER',
    merchantClean: 'Other',
  } as never);
  const matched = await hasMatchingTransaction({
    householdId: 1,
    vendor: 'other',
    total: 42.0,
    currency: 'CAD',
    orderDate: '2026-06-10',
    paymentLast4: null,
  });
  assert.equal(matched, false);
});

test('returns false when total is null', async () => {
  const matched = await hasMatchingTransaction({
    householdId: 1,
    vendor: 'other',
    total: null,
    currency: 'CAD',
    orderDate: '2026-06-10',
    paymentLast4: null,
  });
  assert.equal(matched, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/hasMatchingTransaction.test.ts`
Expected: FAIL — `hasMatchingTransaction` is not exported.

- [ ] **Step 3: Implement the helper**

In `backend/src/import/matchReceiptToTransactions.ts`, add at the end of the file (it reuses the module-private `scoreReceiptMatch`, `txnMatchesVendor`, `shiftDate`, `MATCH_CONFIDENCE_THRESHOLD`, `DATE_WINDOW_DAYS`):

```typescript
/**
 * Lightweight "is there a plausible card transaction for this receipt?" probe
 * used by the discovery pass to decide auto-ingest confidence BEFORE creating
 * any ExternalOrder. Mirrors the candidate query in
 * matchReceiptOrderToTransactions but scores against a synthesized single
 * payment and persists nothing.
 */
export async function hasMatchingTransaction(args: {
  householdId: number;
  vendor: string;
  total: number | null;
  currency: string;
  orderDate: string | null;
  paymentLast4: string | null;
}): Promise<boolean> {
  if (args.total == null || args.orderDate == null) return false;
  const from = shiftDate(args.orderDate, -DATE_WINDOW_DAYS);
  const to = shiftDate(args.orderDate, DATE_WINDOW_DAYS);
  const candidates = await Transaction.findAll({
    where: {
      householdId: args.householdId,
      date: { [Op.between]: [from, to] },
    },
  });
  // Score against a synthetic ExternalOrder-shaped object; only the fields the
  // scorers read are needed.
  const orderLike = {
    vendor: args.vendor,
    orderDate: args.orderDate,
    currency: args.currency,
    paymentLast4: args.paymentLast4,
  } as ExternalOrder;
  const payment: CandidatePayment = {
    paymentLast4: args.paymentLast4,
    amount: args.total,
    tenderId: null,
  };
  return candidates
    .filter((txn) => txnMatchesVendor(args.vendor, txn))
    .some((txn) => scoreReceiptMatch(txn, orderLike, payment).confidence >= MATCH_CONFIDENCE_THRESHOLD);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/import/hasMatchingTransaction.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/import/matchReceiptToTransactions.ts backend/src/import/hasMatchingTransaction.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): non-persisting transaction amount-match probe"
```

---

### Task 5: Sender-suggestion service

**Files:**
- Create: `backend/src/integrations/receiptSenderSuggestions.ts`
- Test: `backend/src/integrations/receiptSenderSuggestions.test.ts`

**Interfaces:**
- Consumes: `ReceiptSenderAllowlist` model (Task 1 columns).
- Produces:
  - `parseEmailAddress(fromHeader: string | null): string | null` — extracts the bare lowercased address from a `From` header like `"Foo <bar@baz.com>"`.
  - `upsertSenderSuggestion(args: { householdId: number; fromAddr: string | null; subject: string | null }): Promise<void>` — for a sender with no row: create `status='suggested', source='discovery', candidateCount=1`. For an existing `suggested` row: `candidateCount += 1`, refresh `sampleSubject`/`lastSeenAt`. For an existing `enabled` or `dismissed` row: **no-op** (never resurrect a dismissed sender, never touch an enabled one).
  - `SuggestionDTO = { id: number; emailAddress: string; label: string | null; sampleSubject: string | null; candidateCount: number; lastSeenAt: string | null }`
  - `listSenderSuggestions(householdId: number): Promise<SuggestionDTO[]>` — `status='suggested'`, ordered by `candidateCount` desc.
  - `promoteSuggestion(args: { householdId: number; id: number }): Promise<boolean>` — set `status='enabled', enabled=true`; returns false if the row isn't a suggestion for this household.
  - `dismissSuggestion(args: { householdId: number; id: number }): Promise<boolean>` — set `status='dismissed', enabled=false`; returns false if not a suggestion for this household.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/receiptSenderSuggestions.test.ts`:

```typescript
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ReceiptSenderAllowlist } from '../models';
import {
  parseEmailAddress,
  upsertSenderSuggestion,
  listSenderSuggestions,
  promoteSuggestion,
  dismissSuggestion,
} from './receiptSenderSuggestions';

before(async () => {
  await sequelize.sync({ force: true });
});
beforeEach(async () => {
  await ReceiptSenderAllowlist.destroy({ where: {} });
});

test('parseEmailAddress pulls the bare lowercased address', () => {
  assert.equal(parseEmailAddress('Foo Bar <Bar@Baz.com>'), 'bar@baz.com');
  assert.equal(parseEmailAddress('plain@addr.com'), 'plain@addr.com');
  assert.equal(parseEmailAddress(null), null);
  assert.equal(parseEmailAddress('no address here'), null);
});

test('upsert creates then increments a suggestion', async () => {
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'Shop <s@shop.com>', subject: 'Receipt 1' });
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 's@shop.com', subject: 'Receipt 2' });
  const list = await listSenderSuggestions(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].emailAddress, 's@shop.com');
  assert.equal(list[0].candidateCount, 2);
  assert.equal(list[0].sampleSubject, 'Receipt 2');
});

test('upsert never resurrects a dismissed sender', async () => {
  await ReceiptSenderAllowlist.create({
    householdId: 1, emailAddress: 'no@thanks.com', status: 'dismissed', enabled: false,
  });
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'no@thanks.com', subject: 'Receipt' });
  const list = await listSenderSuggestions(1);
  assert.equal(list.length, 0);
});

test('promote and dismiss flip status', async () => {
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'a@a.com', subject: 'x' });
  await upsertSenderSuggestion({ householdId: 1, fromAddr: 'b@b.com', subject: 'y' });
  const [a, b] = await listSenderSuggestions(1);
  assert.equal(await promoteSuggestion({ householdId: 1, id: a.id }), true);
  assert.equal(await dismissSuggestion({ householdId: 1, id: b.id }), true);
  const remaining = await listSenderSuggestions(1);
  assert.equal(remaining.length, 0);
  const promoted = await ReceiptSenderAllowlist.findByPk(a.id);
  assert.equal(promoted?.status, 'enabled');
  assert.equal(promoted?.enabled, true);
});

test('promote returns false for a non-suggestion row', async () => {
  const row = await ReceiptSenderAllowlist.create({ householdId: 1, emailAddress: 'e@e.com' });
  assert.equal(await promoteSuggestion({ householdId: 1, id: row.id }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/receiptSenderSuggestions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `backend/src/integrations/receiptSenderSuggestions.ts`:

```typescript
/**
 * Sender-suggestion lifecycle for the discovery pass. Low-confidence discovery
 * hits cluster by sender into 'suggested' rows of receipt_sender_allowlist; the
 * user promotes (→ enabled, joins the fast scan) or dismisses (→ never
 * re-suggested, excluded from future discovery queries). No new table — these
 * are the same allowlist rows under a status discriminator.
 */
import { ReceiptSenderAllowlist } from '../models';

export interface SuggestionDTO {
  id: number;
  emailAddress: string;
  label: string | null;
  sampleSubject: string | null;
  candidateCount: number;
  lastSeenAt: string | null;
}

const EMAIL_RE = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/;

/** Extract the bare lowercased address from a raw From header. */
export function parseEmailAddress(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const m = fromHeader.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

export async function upsertSenderSuggestion(args: {
  householdId: number;
  fromAddr: string | null;
  subject: string | null;
}): Promise<void> {
  const address = parseEmailAddress(args.fromAddr);
  if (!address) return;
  const existing = await ReceiptSenderAllowlist.findOne({
    where: { householdId: args.householdId, emailAddress: address },
  });
  if (!existing) {
    await ReceiptSenderAllowlist.create({
      householdId: args.householdId,
      emailAddress: address,
      status: 'suggested',
      source: 'discovery',
      enabled: false,
      sampleSubject: args.subject?.slice(0, 256) ?? null,
      candidateCount: 1,
      lastSeenAt: new Date(),
    });
    return;
  }
  // Only grow active suggestions; never touch enabled or dismissed rows.
  if (existing.status !== 'suggested') return;
  existing.set({
    candidateCount: existing.candidateCount + 1,
    sampleSubject: args.subject?.slice(0, 256) ?? existing.sampleSubject,
    lastSeenAt: new Date(),
  });
  await existing.save();
}

export async function listSenderSuggestions(householdId: number): Promise<SuggestionDTO[]> {
  const rows = await ReceiptSenderAllowlist.findAll({
    where: { householdId, status: 'suggested' },
    order: [
      ['candidate_count', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return rows.map((r) => ({
    id: r.id,
    emailAddress: r.emailAddress,
    label: r.label,
    sampleSubject: r.sampleSubject,
    candidateCount: r.candidateCount,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
  }));
}

async function flipSuggestion(
  householdId: number,
  id: number,
  next: 'enabled' | 'dismissed',
): Promise<boolean> {
  const row = await ReceiptSenderAllowlist.findOne({
    where: { id, householdId, status: 'suggested' },
  });
  if (!row) return false;
  row.set({ status: next, enabled: next === 'enabled' });
  await row.save();
  return true;
}

export function promoteSuggestion(args: { householdId: number; id: number }): Promise<boolean> {
  return flipSuggestion(args.householdId, args.id, 'enabled');
}

export function dismissSuggestion(args: { householdId: number; id: number }): Promise<boolean> {
  return flipSuggestion(args.householdId, args.id, 'dismissed');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/receiptSenderSuggestions.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/receiptSenderSuggestions.ts backend/src/integrations/receiptSenderSuggestions.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): sender-suggestion service (upsert/list/promote/dismiss)"
```

---

### Task 6: Discovery orchestrator

**Files:**
- Create: `backend/src/integrations/discoverReceiptSources.ts`
- Test: `backend/src/integrations/discoverReceiptSources.test.ts`

**Interfaces:**
- Consumes: `buildDiscoveryQuery`, `getDiscoveryExclusions`, `receiptCurrencyOrDefault` (scanReceipts.ts); `listMessageIds`, `fetchMessage`, `getHeader`, `extractMessageBody` (gmail.ts); `classifySubject` (subjectFilter); `tryDeterministicParse` (parsers); `extractReceiptFromText` (ai/extractReceiptItems); `isPurchasesLabel`, `classifyDiscoveryConfidence` (Task 3); `hasMatchingTransaction` (Task 4); `upsertSenderSuggestion` (Task 5); `matchReceiptOrderToTransactions` (matcher); `ExternalOrder`, `ExternalOrderItem`, `ProcessedEmailMessage`, `UserEmailIntegration`, `sequelize` (models).
- Produces:
  - `DiscoveryDeps`, `DiscoveryResult`, `DiscoveryResultMessage`, `DiscoveryCallbacks` types.
  - `discoverReceiptSources(opts: { userId: number; householdId: number; maxMessages?: number; sinceDateOverride?: Date | null }, callbacks?: DiscoveryCallbacks, deps?: Partial<DiscoveryDeps>): Promise<DiscoveryResult>`

> **Note on token reuse:** `ensureFreshAccessToken` is currently module-private in `scanReceipts.ts`. As part of Step 3, change its declaration from `async function ensureFreshAccessToken` to `export async function ensureFreshAccessToken` so the orchestrator can reuse it. No other change to `scanReceipts.ts`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/integrations/discoverReceiptSources.test.ts`. It injects fake Gmail + extractor deps and a real SQLite DB:

```typescript
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Transaction,
  ExternalOrder,
  ReceiptSenderAllowlist,
  ProcessedEmailMessage,
  UserEmailIntegration,
} from '../models';
import { discoverReceiptSources } from './discoverReceiptSources';
import { encryptSecret } from '../util/symmetricEncryption';
import type { GmailMessageFull, GmailMessageSummary } from './gmail';

before(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  await Promise.all([
    Transaction.destroy({ where: {} }),
    ExternalOrder.destroy({ where: {} }),
    ReceiptSenderAllowlist.destroy({ where: {} }),
    ProcessedEmailMessage.destroy({ where: {} }),
    UserEmailIntegration.destroy({ where: {} }),
  ]);
  await UserEmailIntegration.create({
    userId: 1,
    provider: 'google',
    accountEmail: 'me@gmail.com',
    accessTokenEncrypted: encryptSecret('fake-access-token'),
    refreshTokenEncrypted: encryptSecret('fake-refresh-token'),
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: 'gmail.readonly',
    lastScanAt: null,
    lastHistoryId: null,
    status: 'connected',
    statusReason: null,
  } as never);
});

function fakeMessage(over: Partial<GmailMessageFull> & { from: string; subject: string }): GmailMessageFull {
  return {
    id: over.id ?? 'm1',
    threadId: 't1',
    internalDate: '1718000000000',
    labelIds: over.labelIds ?? [],
    payload: {
      headers: [
        { name: 'From', value: over.from },
        { name: 'Subject', value: over.subject },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from('Thanks for your order at FooShop. Total $42.00').toString('base64url') },
    },
  } as GmailMessageFull;
}

function deps(messages: GmailMessageFull[], extract: () => Promise<unknown>) {
  const summaries: GmailMessageSummary[] = messages.map((m) => ({ id: m.id, threadId: m.threadId }));
  return {
    listMessageIds: async () => summaries,
    fetchMessage: async ({ messageId }: { messageId: string }) =>
      messages.find((m) => m.id === messageId)!,
    extractFromText: extract as never,
  };
}

const cleanExtract = {
  vendor: 'other',
  orderId: 'F-1',
  orderDate: '2026-06-10',
  total: 42.0,
  currency: 'CAD',
  paymentLast4: null,
  items: [{ title: 'Widget', quantity: 1, unitPrice: 42, totalPrice: 42 }],
  trip: null,
};

test('AI extract from a purchases-labelled mail with an amount match auto-ingests and learns the sender', async () => {
  await Transaction.create({
    householdId: 1, date: '2026-06-10', amount: '42.00', currency: 'CAD',
    merchantRaw: 'FOOSHOP', merchantClean: 'Fooshop',
  } as never);
  const msg = fakeMessage({ id: 'm1', from: 'FooShop <orders@fooshop.com>', subject: 'Your order confirmation', labelIds: ['CATEGORY_PURCHASES'] });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => cleanExtract),
  );
  assert.equal(result.autoIngested, 1);
  assert.equal(await ExternalOrder.count(), 1);
  const learned = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'orders@fooshop.com' } });
  assert.equal(learned?.status, 'enabled');
  assert.equal(learned?.source, 'discovery');
});

test('AI extract with NO amount match becomes a suggestion and writes no order', async () => {
  const msg = fakeMessage({ id: 'm2', from: 'Mystery <hello@mystery.test>', subject: 'Receipt', labelIds: ['CATEGORY_PURCHASES'] });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => cleanExtract),
  );
  assert.equal(result.autoIngested, 0);
  assert.equal(result.suggestionsAdded, 1);
  assert.equal(await ExternalOrder.count(), 0);
  const suggestion = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'hello@mystery.test' } });
  assert.equal(suggestion?.status, 'suggested');
});

test('an already-processed message id is skipped', async () => {
  await ProcessedEmailMessage.create({
    householdId: 1, provider: 'google', messageId: 'm3', status: 'suggested_sender',
    parser: 'ai', externalOrderId: null, errorMessage: null, subject: 'x', fromAddr: 'y', scannedAt: new Date(),
  } as never);
  const msg = fakeMessage({ id: 'm3', from: 'x@y.com', subject: 'Receipt' });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => cleanExtract),
  );
  assert.equal(result.skippedAlreadySeen, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoverReceiptSources.test.ts`
Expected: FAIL — module `./discoverReceiptSources` not found.

- [ ] **Step 3: Export `ensureFreshAccessToken`**

In `backend/src/integrations/scanReceipts.ts`, change:

```typescript
async function ensureFreshAccessToken(integ: UserEmailIntegration): Promise<string> {
```

to:

```typescript
export async function ensureFreshAccessToken(integ: UserEmailIntegration): Promise<string> {
```

- [ ] **Step 4: Implement the orchestrator**

Create `backend/src/integrations/discoverReceiptSources.ts`:

```typescript
/**
 * Discovery pass — the "smart" counterpart to scanInbox. Casts a broad Gmail
 * net (purchases category + receipt subject keywords, minus known senders) and
 * splits results by confidence:
 *   HIGH → create the ExternalOrder + auto-learn the sender (enabled).
 *   LOW  → upsert a 'suggested' sender row; write NO order.
 * Reuses scanInbox's parse pipeline; the fast scan path is untouched.
 *
 * Gmail access (list/fetch) and AI extraction are injectable via `deps` so the
 * orchestrator is unit-testable on SQLite without network.
 */
// Order-persist block intentionally parallels scanReceipts.ts; folding the two
// is a follow-up, not this task's scope.
// fallow-ignore-file code-duplication
import {
  sequelize,
  ExternalOrder,
  ExternalOrderItem,
  ProcessedEmailMessage,
  ReceiptSenderAllowlist,
  UserEmailIntegration,
} from '../models';
import {
  buildDiscoveryQuery,
  getDiscoveryExclusions,
  receiptCurrencyOrDefault,
  ensureFreshAccessToken,
} from './scanReceipts';
import {
  fetchMessage as realFetchMessage,
  listMessageIds as realListMessageIds,
  extractMessageBody,
  getHeader,
} from './gmail';
import { classifySubject } from './subjectFilter';
import { tryDeterministicParse } from './parsers';
import { extractReceiptFromText } from '../ai/extractReceiptItems';
import type { ExtractedReceiptOrder } from '../ai/extractReceiptItems';
import { isPurchasesLabel, classifyDiscoveryConfidence } from './discoveryConfidence';
import { hasMatchingTransaction, matchReceiptOrderToTransactions } from '../import/matchReceiptToTransactions';
import { categorizeAndApplyReceiptItems } from '../import/categorizeReceiptItems';
import { upsertSenderSuggestion, parseEmailAddress } from './receiptSenderSuggestions';
import { logger } from '../observability/logger';

export interface DiscoveryDeps {
  listMessageIds: typeof realListMessageIds;
  fetchMessage: typeof realFetchMessage;
  extractFromText: (body: string) => Promise<ExtractedReceiptOrder>;
}

export interface DiscoveryResultMessage {
  messageId: string;
  from: string | null;
  subject: string | null;
  /** 'auto_learned' | 'suggested_sender' | 'duplicate' | 'skipped_already_seen' | 'filtered_subject' | 'no_items' | 'extraction_failed' */
  status: string;
  parser: string | null;
  vendor: string;
  total: number | null;
  orderId: number | null;
  confidence: 'high' | 'low' | null;
  error: string | null;
}

export interface DiscoveryResult {
  scannedMessages: number;
  autoIngested: number;
  suggestionsAdded: number;
  suggestionsUpdated: number;
  skippedAlreadySeen: number;
  filteredBySubject: number;
  failed: number;
  messages: DiscoveryResultMessage[];
  query: string;
  sinceDate: string | null;
}

export type DiscoveryPhaseEvent =
  | { phase: 'listing'; fetched: number; hasMore: boolean }
  | { phase: 'processing-start'; total: number }
  | { phase: 'processed'; index: number; total: number };

export interface DiscoveryCallbacks {
  onPhase?: (e: DiscoveryPhaseEvent) => void;
  onMessage?: (m: DiscoveryResultMessage) => void;
}

export async function discoverReceiptSources(
  opts: {
    userId: number;
    householdId: number;
    maxMessages?: number;
    sinceDateOverride?: Date | null;
  },
  callbacks: DiscoveryCallbacks = {},
  deps: Partial<DiscoveryDeps> = {},
): Promise<DiscoveryResult> {
  const listMessageIds = deps.listMessageIds ?? realListMessageIds;
  const fetchMessage = deps.fetchMessage ?? realFetchMessage;
  const extractFromText = deps.extractFromText ?? extractReceiptFromText;

  const integ = await UserEmailIntegration.findOne({
    where: { userId: opts.userId, provider: 'google' },
  });
  if (!integ) {
    const err = new Error('Gmail is not connected for this user') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const accessToken = await ensureFreshAccessToken(integ);

  const sinceDate =
    opts.sinceDateOverride !== undefined
      ? opts.sinceDateOverride
      : new Date(Date.now() - 30 * 86_400_000);
  const excludeSenders = await getDiscoveryExclusions(opts.householdId);
  const query = buildDiscoveryQuery({ sinceDate, excludeSenders });

  const summaries = await listMessageIds({
    accessToken,
    query,
    maxResults: opts.maxMessages ?? 300,
    onPage: ({ fetched, hasMore }) => callbacks.onPhase?.({ phase: 'listing', fetched, hasMore }),
  });
  callbacks.onPhase?.({ phase: 'processing-start', total: summaries.length });

  const seen = new Set<string>();
  if (summaries.length > 0) {
    const seenRows = await ProcessedEmailMessage.findAll({
      where: { householdId: opts.householdId, provider: 'google', messageId: summaries.map((s) => s.id) },
      attributes: ['messageId'],
    });
    for (const r of seenRows) seen.add(r.messageId);
  }

  const results: DiscoveryResultMessage[] = [];
  let autoIngested = 0;
  let suggestionsAdded = 0;
  let suggestionsUpdated = 0;
  let skippedAlreadySeen = 0;
  let filteredBySubject = 0;
  let failed = 0;

  async function recordProcessed(p: {
    messageId: string;
    status: string;
    parser?: string | null;
    externalOrderId?: number | null;
    errorMessage?: string | null;
    subject: string | null;
    fromAddr: string | null;
  }): Promise<void> {
    try {
      await ProcessedEmailMessage.upsert({
        householdId: opts.householdId,
        provider: 'google',
        messageId: p.messageId,
        status: p.status,
        parser: p.parser ?? null,
        externalOrderId: p.externalOrderId ?? null,
        errorMessage: p.errorMessage ?? null,
        subject: p.subject?.slice(0, 512) ?? null,
        fromAddr: p.fromAddr?.slice(0, 256) ?? null,
        scannedAt: new Date(),
      } as never);
    } catch (err) {
      logger.warn(
        { messageId: p.messageId, error: err instanceof Error ? err.message : String(err) },
        'discovery_processed_log_failed',
      );
    }
  }

  async function persistHighConfidenceOrder(args: {
    extracted: ExtractedReceiptOrder;
    parser: string;
    gmailMessageId: string;
  }): Promise<number> {
    const { extracted, parser, gmailMessageId } = args;
    const dedupeKey = [
      extracted.vendor,
      extracted.orderId || '',
      extracted.orderDate || '',
      extracted.total != null ? String(extracted.total) : '',
      String(extracted.items.length),
      gmailMessageId,
    ].join(':');
    let orderId = 0;
    await sequelize.transaction(async (t) => {
      const [order, createdOrder] = await ExternalOrder.findOrCreate({
        where: { householdId: opts.householdId, dedupeKey },
        defaults: {
          householdId: opts.householdId,
          createdByUserId: opts.userId,
          vendor: extracted.vendor,
          vendorOrderId: extracted.orderId,
          dedupeKey,
          orderDate: extracted.orderDate,
          shipmentDate: null,
          subtotal: null,
          tax: null,
          shipping: null,
          total: extracted.total != null ? String(extracted.total) : null,
          currency: receiptCurrencyOrDefault(extracted.currency),
          paymentLast4: extracted.paymentLast4,
          source: `gmail-discovery:${parser}`,
          rawPayload: { extracted, gmailMessageId, parser } as unknown,
        } as never,
        transaction: t,
      });
      orderId = order.id;
      if (createdOrder && extracted.items.length > 0) {
        await ExternalOrderItem.bulkCreate(
          extracted.items.map((it) => ({
            externalOrderId: order.id,
            title: it.title,
            quantity: it.quantity,
            unitPrice: it.unitPrice != null ? String(it.unitPrice) : null,
            totalPrice: it.totalPrice != null ? String(it.totalPrice) : null,
            inferredCategory: it.inferredCategory,
            businessUsePercent: it.businessUsePercent != null ? String(it.businessUsePercent) : null,
            confidence: null,
            itemNumber: it.vendorItemId ?? null,
            rawPayload: it as unknown,
          })) as never[],
          { transaction: t },
        );
      }
    });
    return orderId;
  }

  async function processOne(summary: { id: string }): Promise<DiscoveryResultMessage> {
    const r: DiscoveryResultMessage = {
      messageId: summary.id, from: null, subject: null, status: 'unknown',
      parser: null, vendor: 'other', total: null, orderId: null, confidence: null, error: null,
    };
    if (seen.has(summary.id)) {
      r.status = 'skipped_already_seen';
      skippedAlreadySeen++;
      return r;
    }
    try {
      const full = await fetchMessage({ accessToken, messageId: summary.id });
      r.from = getHeader(full.payload, 'From');
      r.subject = getHeader(full.payload, 'Subject');

      if (classifySubject(r.subject).decision === 'block') {
        r.status = 'filtered_subject';
        filteredBySubject++;
        await recordProcessed({ messageId: summary.id, status: 'filtered_subject', subject: r.subject, fromAddr: r.from });
        return r;
      }

      const body = extractMessageBody(full.payload);
      if (!body.trim()) {
        r.status = 'extraction_failed';
        r.error = 'empty body';
        failed++;
        await recordProcessed({ messageId: summary.id, status: 'extraction_failed', errorMessage: 'empty body', subject: r.subject, fromAddr: r.from });
        return r;
      }

      let extracted: ExtractedReceiptOrder | null = null;
      let parser = 'ai';
      const det = tryDeterministicParse({ fromAddress: r.from, subject: r.subject, body });
      if (det.ok) {
        extracted = det.order;
        parser = det.parser;
      } else {
        extracted = await extractFromText(body);
        parser = 'ai';
      }
      r.parser = parser;
      r.vendor = extracted.vendor;
      r.total = extracted.total;

      const hasCleanExtract = extracted.total != null && extracted.items.length > 0;
      if (!hasCleanExtract && parser === 'ai') {
        // Nothing usable and no deterministic signal — surface the sender so the
        // user can decide, but write no order.
        r.status = 'no_items';
        failed++;
        await recordProcessed({ messageId: summary.id, status: 'no_items', parser, subject: r.subject, fromAddr: r.from });
        return r;
      }

      const amountMatched =
        parser === 'ai'
          ? await hasMatchingTransaction({
              householdId: opts.householdId,
              vendor: extracted.vendor,
              total: extracted.total,
              currency: receiptCurrencyOrDefault(extracted.currency),
              orderDate: extracted.orderDate,
              paymentLast4: extracted.paymentLast4,
            })
          : false;

      const confidence = classifyDiscoveryConfidence({
        parser,
        isPurchases: isPurchasesLabel(full.labelIds),
        hasCleanExtract,
        amountMatched,
      });
      r.confidence = confidence;

      if (confidence === 'high') {
        const orderId = await persistHighConfidenceOrder({ extracted, parser, gmailMessageId: summary.id });
        r.orderId = orderId;
        r.status = 'auto_learned';
        autoIngested++;
        // Auto-learn the sender so future fast scans cover it.
        await upsertSenderSuggestion({ householdId: opts.householdId, fromAddr: r.from, subject: r.subject });
        await promoteLearnedSender(opts.householdId, r.from);
        try {
          await matchReceiptOrderToTransactions({ externalOrderId: orderId, householdId: opts.householdId });
        } catch (err) {
          logger.warn({ err, orderId }, 'discovery_match_failed');
        }
        await categorizeAndApplyReceiptItems({ householdId: opts.householdId, orderId });
        await recordProcessed({ messageId: summary.id, status: 'auto_learned', parser, externalOrderId: orderId, subject: r.subject, fromAddr: r.from });
      } else {
        const before = await suggestionExists(opts.householdId, r.from);
        await upsertSenderSuggestion({ householdId: opts.householdId, fromAddr: r.from, subject: r.subject });
        if (before) suggestionsUpdated++;
        else suggestionsAdded++;
        r.status = 'suggested_sender';
        await recordProcessed({ messageId: summary.id, status: 'suggested_sender', parser, subject: r.subject, fromAddr: r.from });
      }
    } catch (err) {
      r.status = 'extraction_failed';
      r.error = err instanceof Error ? err.message : String(err);
      failed++;
      await recordProcessed({ messageId: summary.id, status: 'extraction_failed', parser: r.parser, errorMessage: r.error, subject: r.subject, fromAddr: r.from });
    }
    return r;
  }

  for (let i = 0; i < summaries.length; i++) {
    const result = await processOne(summaries[i]);
    results.push(result);
    callbacks.onMessage?.(result);
    callbacks.onPhase?.({ phase: 'processed', index: i + 1, total: summaries.length });
  }

  return {
    scannedMessages: summaries.length,
    autoIngested,
    suggestionsAdded,
    suggestionsUpdated,
    skippedAlreadySeen,
    filteredBySubject,
    failed,
    messages: results,
    query,
    sinceDate: sinceDate ? sinceDate.toISOString() : null,
  };
}
```

Add two small private helpers at the bottom of the same file (they keep `processOne` readable and reuse the suggestion model directly). `ReceiptSenderAllowlist` and `parseEmailAddress` are already imported at the top — do NOT re-import:

```typescript
async function suggestionExists(householdId: number, fromAddr: string | null): Promise<boolean> {
  const addr = parseEmailAddress(fromAddr);
  if (!addr) return false;
  const row = await ReceiptSenderAllowlist.findOne({
    where: { householdId, emailAddress: addr, status: 'suggested' },
    attributes: ['id'],
  });
  return row != null;
}

/** Flip the just-learned sender row to enabled so the fast scan picks it up. */
async function promoteLearnedSender(householdId: number, fromAddr: string | null): Promise<void> {
  const addr = parseEmailAddress(fromAddr);
  if (!addr) return;
  const row = await ReceiptSenderAllowlist.findOne({ where: { householdId, emailAddress: addr } });
  if (row && row.status !== 'dismissed') {
    row.set({ status: 'enabled', enabled: true, source: 'discovery' });
    await row.save();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/integrations/discoverReceiptSources.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 6: Typecheck**

Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/integrations/discoverReceiptSources.ts backend/src/integrations/discoverReceiptSources.test.ts backend/src/integrations/scanReceipts.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): discovery orchestrator with confidence-tiered ingest"
```

---

### Task 7: Routes — discover + suggestions

**Files:**
- Modify: `backend/src/routes/emailIntegrations.ts`
- Test: `backend/src/routes/emailDiscoveryRoutes.test.ts`

**Interfaces:**
- Consumes: `discoverReceiptSources` (Task 6); `listSenderSuggestions`, `promoteSuggestion`, `dismissSuggestion` (Task 5).
- Produces HTTP routes (mounted under the existing `/api/email` registry entry — no `routeRegistry.ts` change needed):
  - `POST /api/email/discover/google` — same stream/non-stream contract as `/scan/google`.
  - `GET /api/email/suggestions` → `SuggestionDTO[]`.
  - `POST /api/email/suggestions/:id/approve` → `{ ok: true }` (404 if not a suggestion).
  - `POST /api/email/suggestions/:id/dismiss` → `{ ok: true }` (404 if not a suggestion).

- [ ] **Step 1: Write the failing test**

Create `backend/src/routes/emailDiscoveryRoutes.test.ts`. Drive the handlers through `listSenderSuggestions`/`promoteSuggestion` to confirm the wiring contract (the heavy discovery path is covered in Task 6; here we test the suggestion endpoints' service calls):

```typescript
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ReceiptSenderAllowlist } from '../models';
import {
  listSenderSuggestions,
  promoteSuggestion,
  dismissSuggestion,
} from '../integrations/receiptSenderSuggestions';

before(async () => {
  await sequelize.sync({ force: true });
});
beforeEach(async () => {
  await ReceiptSenderAllowlist.destroy({ where: {} });
});

test('suggestion service backs the approve endpoint contract', async () => {
  const row = await ReceiptSenderAllowlist.create({
    householdId: 7, emailAddress: 's@s.com', status: 'suggested', source: 'discovery', enabled: false, candidateCount: 2,
  });
  const before = await listSenderSuggestions(7);
  assert.equal(before.length, 1);
  assert.equal(await promoteSuggestion({ householdId: 7, id: row.id }), true);
  assert.equal((await listSenderSuggestions(7)).length, 0);
});

test('cross-household promote/dismiss is rejected', async () => {
  const row = await ReceiptSenderAllowlist.create({
    householdId: 7, emailAddress: 's@s.com', status: 'suggested', source: 'discovery', enabled: false,
  });
  assert.equal(await promoteSuggestion({ householdId: 99, id: row.id }), false);
  assert.equal(await dismissSuggestion({ householdId: 99, id: row.id }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/emailDiscoveryRoutes.test.ts`
Expected: FAIL — until Task 5's service exists this import resolves, but run it now to confirm green only after wiring; if Task 5 is already merged it will PASS at this step (acceptable — the route wiring in Step 3 is what this task adds). If it passes immediately, proceed to Step 3 and re-run after wiring to confirm no regression.

- [ ] **Step 3: Wire the routes**

In `backend/src/routes/emailIntegrations.ts`, extend the imports:

```typescript
import { discoverReceiptSources } from '../integrations/discoverReceiptSources';
import {
  listSenderSuggestions,
  promoteSuggestion,
  dismissSuggestion,
} from '../integrations/receiptSenderSuggestions';
```

Add the discover route after the existing `/scan/google` handler (it mirrors the scan handler's stream/non-stream branches):

```typescript
router.post('/discover/google', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const maxMessages =
      typeof body.maxMessages === 'number' && body.maxMessages > 0
        ? Math.min(2000, Math.floor(body.maxMessages))
        : 300;
    const sinceDateOverride =
      typeof body.sinceDays === 'number' && body.sinceDays > 0
        ? new Date(Date.now() - Math.min(3650, body.sinceDays) * 86_400_000)
        : undefined;

    const accept = String(req.headers['accept'] ?? '').toLowerCase();
    const wantsStream =
      accept.includes('application/x-ndjson') ||
      accept.includes('application/ndjson') ||
      req.query.stream === '1';

    if (!wantsStream) {
      const result = await discoverReceiptSources({
        userId: user.id, householdId: household.id, maxMessages, sinceDateOverride,
      });
      logger.info({ userId: user.id, ...result, messages: undefined, messageCount: result.messages.length }, 'gmail_discovery_completed');
      res.json(result);
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
    emit({ kind: 'started', maxMessages, sinceDays: body.sinceDays ?? null });
    try {
      const result = await discoverReceiptSources(
        { userId: user.id, householdId: household.id, maxMessages, sinceDateOverride },
        { onPhase: (e) => emit({ kind: 'phase', ...e }), onMessage: (m) => emit({ kind: 'message', ...m }) },
      );
      logger.info({ userId: user.id, ...result, messages: undefined, messageCount: result.messages.length }, 'gmail_discovery_completed');
      emit({ kind: 'summary', ...result, messages: undefined, messageCount: result.messages.length });
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ userId: user.id, message }, 'gmail_discovery_failed');
      emit({ kind: 'error', message });
      res.end();
    }
  } catch (e) {
    next(e);
  }
});

router.get('/suggestions', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    res.json(await listSenderSuggestions(household.id));
  } catch (e) {
    next(e);
  }
});

router.post('/suggestions/:id/approve', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    const ok = await promoteSuggestion({ householdId: household.id, id });
    if (!ok) { res.status(404).json({ error: 'Suggestion not found' }); return; }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/suggestions/:id/dismiss', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    const ok = await dismissSuggestion({ householdId: household.id, id });
    if (!ok) { res.status(404).json({ error: 'Suggestion not found' }); return; }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/routes/emailDiscoveryRoutes.test.ts`
Expected: PASS.
Run: `yarn workspace cashflow-backend run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add backend/src/routes/emailIntegrations.ts backend/src/routes/emailDiscoveryRoutes.test.ts
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): discover + suggestions routes"
```

---

### Task 8: Frontend — Discover button + suggestions list

**Files:**
- Modify: `frontend/src/pages/settings/sections/GmailSection.tsx`
- Test: `frontend/src/pages/settings/sections/GmailSection.suggestions.test.tsx`

**Interfaces:**
- Consumes: `GET /api/email/suggestions`, `POST /api/email/suggestions/:id/approve`, `POST /api/email/suggestions/:id/dismiss`, `POST /api/email/discover/google?stream=1` (Task 7); `getJson`, `postJson` from `@/lib/api`.
- Produces: a "Discover new receipt sources" button reusing the existing `runGmailScan` streaming renderer against the discover endpoint, plus a suggestions list with Approve/Dismiss.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/settings/sections/GmailSection.suggestions.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SenderSuggestions } from './GmailSection'

vi.mock('@/lib/api', () => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
  patchJson: vi.fn(),
  deleteReq: vi.fn(),
}))
import { getJson, postJson } from '@/lib/api'

describe('SenderSuggestions', () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset()
    vi.mocked(postJson).mockReset()
  })

  it('renders suggestions and approves one', async () => {
    vi.mocked(getJson).mockResolvedValueOnce([
      { id: 5, emailAddress: 'shop@x.com', label: null, sampleSubject: 'Your receipt', candidateCount: 3, lastSeenAt: null },
    ])
    vi.mocked(postJson).mockResolvedValue({ ok: true })
    render(<SenderSuggestions />)
    await waitFor(() => expect(screen.getByText('shop@x.com')).toBeInTheDocument())
    expect(screen.getByText(/3 emails/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(postJson).toHaveBeenCalledWith('/api/email/suggestions/5/approve'))
  })

  it('shows nothing when there are no suggestions', async () => {
    vi.mocked(getJson).mockResolvedValueOnce([])
    const { container } = render(<SenderSuggestions />)
    await waitFor(() => expect(getJson).toHaveBeenCalled())
    expect(container.textContent).not.toMatch(/approve/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test GmailSection.suggestions`
Expected: FAIL — `SenderSuggestions` is not exported.

- [ ] **Step 3: Implement `SenderSuggestions` and wire it in**

In `frontend/src/pages/settings/sections/GmailSection.tsx`, add the type and an exported component (place above `GmailSection`):

```tsx
type SenderSuggestion = {
  id: number
  emailAddress: string
  label: string | null
  sampleSubject: string | null
  candidateCount: number
  lastSeenAt: string | null
}

export function SenderSuggestions() {
  const [items, setItems] = useState<SenderSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems(await getJson<SenderSuggestion[]>('/api/email/suggestions'))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load suggestions')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(id: number, action: 'approve' | 'dismiss') {
    setError(null)
    try {
      await postJson(`/api/email/suggestions/${id}/${action}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${action}`)
    }
  }

  if (items.length === 0) {
    return error ? <span className="error" role="alert">{error}</span> : null
  }

  return (
    <div style={{ marginTop: '0.5rem', display: 'grid', gap: '0.4rem' }}>
      <strong style={{ fontSize: '0.85rem' }}>Suggested receipt senders</strong>
      <p className="muted" style={{ fontSize: '0.8rem', margin: 0 }}>
        Discovery found these senders. Approve to scan them on every run, or dismiss to ignore.
      </p>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: '0.3rem' }}>
        {items.map((s) => (
          <li key={s.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <code>{s.emailAddress}</code>{' '}
              <span className="muted">· {s.candidateCount} emails{s.sampleSubject ? ` · "${s.sampleSubject}"` : ''}</span>
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => void act(s.id, 'approve')}>Approve</Button>
            <Button type="button" size="sm" variant="destructive" onClick={() => void act(s.id, 'dismiss')}>Dismiss</Button>
          </li>
        ))}
      </ul>
      {error && <span className="error" role="alert" style={{ fontSize: '0.85rem' }}>{error}</span>}
    </div>
  )
}
```

Add a discovery trigger that reuses the streaming renderer. Generalize `runGmailScan` to take an endpoint by adding a sibling caller — add this function inside `GmailSection` next to `runGmailScan`:

```tsx
  async function runDiscovery() {
    if (gmailScanning) return
    await runGmailScanAt('/api/email/discover/google?stream=1', 300, 30)
  }
```

Rename the body of `runGmailScan` to a parameterized `runGmailScanAt(path, maxMessages, sinceDays?)` (replace the hardcoded `/api/email/scan/google?stream=1` on the `fetch` line with `path`), and make `runGmailScan` delegate:

```tsx
  async function runGmailScan(maxMessages: number, sinceDays?: number) {
    await runGmailScanAt('/api/email/scan/google?stream=1', maxMessages, sinceDays)
  }
```

Then, in the connected-state button row (after the "1-year backfill" button), add:

```tsx
            <Button
              type="button"
              variant="secondary"
              disabled={gmailScanning}
              onClick={() => void runDiscovery()}
              title="Find receipts from senders not yet on your allowlist"
            >
              <Sparkles aria-hidden="true" />
              Discover new receipt sources
            </Button>
```

And render the suggestions list inside the connected block, just before the closing `</div>` of the `gmailStatus?.connected` section (after the allowlist `</details>`):

```tsx
          <SenderSuggestions />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test GmailSection.suggestions`
Expected: PASS (both tests).

- [ ] **Step 5: Frontend lint + typecheck**

Run: `yarn workspace frontend run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git add frontend/src/pages/settings/sections/GmailSection.tsx frontend/src/pages/settings/sections/GmailSection.suggestions.test.tsx
PATH=/Users/connoradams/Developer/cashflow/node_modules/.bin:$PATH git commit -m "feat(email): Discover button + sender suggestions UI"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run the whole backend test suite**

Run: `yarn workspace cashflow-backend run test`
Expected: PASS, including the five new test files.

- [ ] **Step 2: Run CI locally**

Run: `yarn ci`
Expected: typecheck, all tests, and both production builds pass.

- [ ] **Step 3: Commit any fixes, then the plan is complete**

If `yarn ci` surfaced anything, fix it with a focused commit. Otherwise the feature is done — push the branch, open a PR, enable auto-merge with a merge commit.

---

## Notes for the implementer

- **Why a deps seam in Task 6:** the existing scan path calls Gmail/AI functions directly and is only covered by pure-function + integration tests. Discovery is new, so it's built test-first with an injectable `deps` param — the orchestrator's confidence branching is fully unit-tested on SQLite with no network.
- **Phases 2 (PDF attachments) and 3 (forwarded receipts) are out of scope** for this plan. `buildDiscoveryQuery` already accepts `includePdfAttachments` (kept off) so Phase 2 is a small follow-up: surface the attachment download + reuse `backend/src/import/pdf/extractLines.ts`, then pass `includePdfAttachments: true`.
- **The fast `scanInbox` is deliberately untouched** beyond exporting `ensureFreshAccessToken`. Folding the two order-persist blocks is a future cleanup, flagged with `fallow-ignore-file code-duplication` in the orchestrator.
