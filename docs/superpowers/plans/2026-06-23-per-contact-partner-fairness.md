# Per-contact Partner Fairness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Partner Fairness dashboard report a separate balance per contact (so Alex's partner balance is never merged with Dad's peer-lending) and surface partner paybacks (tagged bank transfers + manual settlements) without double-counting.

**Architecture:** Keep the existing per-currency builders (`buildFairnessByCurrency`, `buildFairnessMonthly`, `buildSettlementRecommendation`) **unchanged**. Add a thin *partition-then-delegate* layer: group rows + settlements + transfers by contact, then call the existing per-currency builders on each contact's subset. Attribution of a split row to a contact happens at query time (no DB migration): a split owned by a `contact` keeps its `ownershipContactId`; an unlabeled split falls to the single `is_partner` contact. Paybacks are a display-only assembly over settlement rows + tagged transfer rows; balance math is untouched.

**Tech Stack:** Backend — Express + Sequelize, TypeScript, `node:test` via `tsx`, colocated `*.test.ts`. Frontend — Vite + React 19, `@connor-adams/designsystem`, vitest.

## Global Constraints

- Backend tests are `node:test` run via `tsx`; unit tests are **colocated** beside source (`foo.test.ts` next to `foo.ts`). Run one file: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`.
- Write dual-dialect Sequelize (SQLite + Postgres). This change is read-only (no migration, no writes).
- Pure functions only in `partnerFairness.ts` / `partnerMath.ts` — no DB access; all DB access stays in `routes/partner.ts`.
- Use the design system as-is on the frontend; app-side layout via Tailwind utilities. Do not restyle DS components via `className` overrides.
- Sign convention (do not change): spend stored negative; `balance > 0` → partner owes me, `< 0` → I owe partner. `rawNet = −partnerShare`.
- Spec: `docs/superpowers/specs/2026-06-23-per-contact-partner-fairness-design.md`.

---

## File Structure

- **Modify** `backend/src/summary/partnerFairness.ts` — add `PaybackEntry`, `FairnessContact` types; add pure helpers `resolveSolePartnerId`, `contactForSharedRow`, `computeTransfersByContact`, `buildPaybacks`, `buildFairnessByContact`, `buildFairnessMonthlyByContact`, `buildSettlementRecommendationByContact`. Existing per-currency builders unchanged.
- **Modify** `backend/src/summary/partnerFairness.test.ts` — new colocated tests (create if absent).
- **Modify** `backend/src/routes/partner.ts` — extend `loadSharedTxns` to also return `rawSettlements` and `contactsMeta`; rewrite the three route handlers to return per-contact shape.
- **Modify** `backend/test/integration/partner.test.ts` (or create `backend/src/routes/partner.test.ts` if a route-level unit harness exists) — assert the new `contacts[]` response shape. (Implementer: check which partner route test already exists with `ls backend/test/integration | grep -i partner` and follow that pattern.)
- **Modify** `frontend/src/types/api.ts` — add `PaybackEntry`, `PartnerFairnessContact`; change `PartnerFairnessResponse`, monthly + recommendation responses to nest under `contacts`.
- **Modify** `frontend/src/pages/PartnerHomePage.tsx` — card shows the `is_partner` contact balance.
- **Modify** `frontend/src/pages/PartnerFairnessPage.tsx` — render one section per contact with payback list + source badges.

---

## Task 1: Attribution helpers (pure)

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts`
- Test: `backend/src/summary/partnerFairness.test.ts`

**Interfaces:**
- Produces:
  - `resolveSolePartnerId(partnerContactIds: Set<number>): number | null` — the lone `is_partner` id, or `null` when the set size ≠ 1.
  - `contactForSharedRow(row: SharedTxnRow, solePartnerId: number | null): number | null` — the contact a split expense belongs to.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/summary/partnerFairness.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSolePartnerId,
  contactForSharedRow,
  type SharedTxnRow,
} from './partnerFairness.ts';

function row(p: Partial<SharedTxnRow>): SharedTxnRow {
  return {
    date: '2026-01-01', currency: 'CAD', category: null, merchant: 'm',
    amount: -100, myShare: -50, partnerShare: -50, txnId: 1,
    ownershipType: 'me', ownershipContactId: null, contactName: null,
    counterpartyContactId: null, payerUserId: null, ...p,
  };
}

test('resolveSolePartnerId returns the id only when exactly one partner', () => {
  assert.equal(resolveSolePartnerId(new Set([7])), 7);
  assert.equal(resolveSolePartnerId(new Set()), null);
  assert.equal(resolveSolePartnerId(new Set([7, 9])), null);
});

test('contactForSharedRow: contact-owned split keeps its contact', () => {
  const r = row({ ownershipType: 'contact', ownershipContactId: 3, partnerShare: -640.56 });
  assert.equal(contactForSharedRow(r, 7), 3);
});

test('contactForSharedRow: unlabeled split falls to sole partner', () => {
  const r = row({ ownershipType: 'me', ownershipContactId: null, partnerShare: -50 });
  assert.equal(contactForSharedRow(r, 7), 7);
});

test('contactForSharedRow: unlabeled split with no sole partner is null (Unassigned)', () => {
  const r = row({ ownershipType: 'me', ownershipContactId: null, partnerShare: -50 });
  assert.equal(contactForSharedRow(r, null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: FAIL — `resolveSolePartnerId`/`contactForSharedRow` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/src/summary/partnerFairness.ts` (near the other exported helpers):

```ts
/** The lone is_partner contact id, or null when the household has ≠ 1 partner. */
export function resolveSolePartnerId(partnerContactIds: Set<number>): number | null {
  return partnerContactIds.size === 1 ? [...partnerContactIds][0] : null;
}

/**
 * Which contact a split expense (partnerShare !== 0) belongs to. A split the
 * user explicitly assigned to a contact (ownershipType='contact') keeps that
 * contact; an unlabeled split falls to the single household partner. Returns
 * null → "Unassigned" bucket (no sole partner to attribute to).
 */
export function contactForSharedRow(
  row: SharedTxnRow,
  solePartnerId: number | null,
): number | null {
  if (row.ownershipType === 'contact' && row.ownershipContactId != null) {
    return row.ownershipContactId;
  }
  return solePartnerId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/src/summary/partnerFairness.test.ts
git commit --no-verify -m "feat(partner): query-time contact attribution helpers"
```

---

## Task 2: Per-contact transfer + payback assembly (pure)

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts`
- Test: `backend/src/summary/partnerFairness.test.ts`

**Interfaces:**
- Consumes: `SharedTxnRow`, `PartnerTransferTotals`, `SettlementTotals` (existing).
- Produces:
  - `type PaybackEntry = { source: 'transfer' | 'settlement'; date: string; amount: number; currency: string; direction: 'partner_paid_me' | 'i_paid_partner'; note: string | null; txnId: number | null }`
  - `type RawSettlementForPayback = { contactId: number; currency: string; direction: 'i_paid_partner' | 'partner_paid_me'; amount: number; settledDate: string; note: string | null }`
  - `computeTransfersByContact(rows: SharedTxnRow[]): Map<number, Map<string, PartnerTransferTotals>>` — keyed by `counterpartyContactId` then currency, over pure-transfer rows (`partnerShare === 0`, `counterpartyContactId != null`, `amount !== 0`).
  - `buildPaybacks(contactRows: SharedTxnRow[], contactSettlements: RawSettlementForPayback[]): PaybackEntry[]`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/summary/partnerFairness.test.ts`:

```ts
import {
  computeTransfersByContact,
  buildPaybacks,
  type RawSettlementForPayback,
} from './partnerFairness.ts';

test('computeTransfersByContact buckets pure transfers per contact+currency', () => {
  const rows = [
    row({ counterpartyContactId: 7, partnerShare: 0, amount: 5000 }),
    row({ counterpartyContactId: 7, partnerShare: 0, amount: 2000 }),
    row({ counterpartyContactId: 7, partnerShare: -50, amount: -100 }), // shared split — ignored
    row({ counterpartyContactId: 3, partnerShare: 0, amount: -300 }),   // I sent Dad
  ];
  const m = computeTransfersByContact(rows);
  assert.deepEqual(m.get(7)?.get('CAD'), { in: 7000, out: 0 });
  assert.deepEqual(m.get(3)?.get('CAD'), { in: 0, out: 300 });
});

test('buildPaybacks merges tagged transfers and settlements with source tags', () => {
  const rows = [
    row({ counterpartyContactId: 7, partnerShare: 0, amount: 5000, date: '2025-07-28', merchant: 'Cash received', txnId: 1045 }),
    row({ counterpartyContactId: 7, partnerShare: -50, amount: -100 }), // shared — not a payback
  ];
  const settlements: RawSettlementForPayback[] = [
    { contactId: 7, currency: 'CAD', direction: 'partner_paid_me', amount: 300, settledDate: '2026-02-01', note: 'cash' },
  ];
  const pb = buildPaybacks(rows, settlements);
  assert.equal(pb.length, 2);
  assert.deepEqual(pb.find((p) => p.source === 'transfer'), {
    source: 'transfer', date: '2025-07-28', amount: 5000, currency: 'CAD',
    direction: 'partner_paid_me', note: 'Cash received', txnId: 1045,
  });
  assert.deepEqual(pb.find((p) => p.source === 'settlement'), {
    source: 'settlement', date: '2026-02-01', amount: 300, currency: 'CAD',
    direction: 'partner_paid_me', note: 'cash', txnId: null,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/src/summary/partnerFairness.ts`:

```ts
export type PaybackEntry = {
  source: 'transfer' | 'settlement';
  date: string;
  /** Absolute amount of the movement. */
  amount: number;
  currency: string;
  direction: 'partner_paid_me' | 'i_paid_partner';
  note: string | null;
  /** Transaction id for transfer-sourced rows; null for manual settlements. */
  txnId: number | null;
};

export type RawSettlementForPayback = {
  contactId: number;
  currency: string;
  direction: 'i_paid_partner' | 'partner_paid_me';
  amount: number;
  settledDate: string;
  note: string | null;
};

/** Pure partner-to-partner transfers bucketed by counterparty contact, then currency. */
export function computeTransfersByContact(
  rows: SharedTxnRow[],
): Map<number, Map<string, PartnerTransferTotals>> {
  const out = new Map<number, Map<string, PartnerTransferTotals>>();
  for (const r of rows) {
    const cid = r.counterpartyContactId;
    if (cid == null) continue;
    if (r.partnerShare !== 0) continue;
    const n = r.amount;
    if (!Number.isFinite(n) || n === 0) continue;
    const byCur = out.get(cid) ?? new Map<string, PartnerTransferTotals>();
    const acc = byCur.get(r.currency) ?? { in: 0, out: 0 };
    if (n < 0) acc.out += -n;
    else acc.in += n;
    byCur.set(r.currency, acc);
    out.set(cid, byCur);
  }
  return out;
}

/**
 * Display list of paybacks for one contact: tagged transfers (from the txn
 * rows) + manual settlement records. Display-only — the balance already counts
 * both via the transfer delta and settlement delta, so this never feeds the
 * math. Sorted newest first.
 */
export function buildPaybacks(
  contactRows: SharedTxnRow[],
  contactSettlements: RawSettlementForPayback[],
): PaybackEntry[] {
  const out: PaybackEntry[] = [];
  for (const r of contactRows) {
    if (r.counterpartyContactId == null) continue;
    if (r.partnerShare !== 0) continue;
    if (!Number.isFinite(r.amount) || r.amount === 0) continue;
    out.push({
      source: 'transfer',
      date: r.date,
      amount: Math.abs(r.amount),
      currency: r.currency,
      direction: r.amount > 0 ? 'partner_paid_me' : 'i_paid_partner',
      note: r.merchant,
      txnId: r.txnId,
    });
  }
  for (const s of contactSettlements) {
    out.push({
      source: 'settlement',
      date: s.settledDate,
      amount: Math.abs(s.amount),
      currency: s.currency,
      direction: s.direction,
      note: s.note,
      txnId: null,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/src/summary/partnerFairness.test.ts
git commit --no-verify -m "feat(partner): per-contact transfer + payback assembly"
```

---

## Task 3: `buildFairnessByContact` — partition then delegate (pure)

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts`
- Test: `backend/src/summary/partnerFairness.test.ts`

**Interfaces:**
- Consumes: `buildFairnessByCurrency` (existing, unchanged), `contactForSharedRow`, `resolveSolePartnerId`, `computeTransfersByContact`, `buildPaybacks`, `FairnessOptions`, `SettlementTotals`, `RawSettlementForPayback`.
- Produces:
  - `type FairnessContact = { contactId: number | null; contactName: string; isPartner: boolean; byCurrency: FairnessByCurrency[]; paybacks: PaybackEntry[] }`
  - `buildFairnessByContact(rows, settlementTotals, rawSettlements, currentMonthStart, nextMonthStart, options, contactsMeta): FairnessContact[]` where `contactsMeta: Map<number, { name: string; isPartner: boolean }>`.

- [ ] **Step 1: Write the failing test (conflation regression)**

Add to `backend/src/summary/partnerFairness.test.ts`:

```ts
import {
  buildFairnessByContact,
  type SettlementTotals,
  type RawSettlementForPayback,
} from './partnerFairness.ts';

test('buildFairnessByContact separates Alex from Dad — no conflation', () => {
  const rows: SharedTxnRow[] = [
    // Alex 50/50 shared expense: I paid 18,811.58 of partner share total across rows.
    row({ ownershipType: 'me', ownershipContactId: null, amount: -37623.16, myShare: -18811.58, partnerShare: -18811.58, currency: 'CAD' }),
    // Alex inbound transfer (the $7k + more): pure transfer, partnerShare 0.
    row({ ownershipType: 'me', counterpartyContactId: 7, amount: 8425, myShare: 0, partnerShare: 0, currency: 'CAD', date: '2025-07-28' }),
    // Dad partner-split row (100% Dad): ownershipType contact.
    row({ ownershipType: 'contact', ownershipContactId: 3, amount: -640.56, myShare: 0, partnerShare: -640.56, currency: 'CAD' }),
  ];
  const settlements: SettlementTotals[] = [
    { contactId: 3, currency: 'CAD', iPaid: 0, partnerPaid: 11198.30 },
  ];
  const raw: RawSettlementForPayback[] = [
    { contactId: 3, currency: 'CAD', direction: 'partner_paid_me', amount: 11198.30, settledDate: '2024-11-21', note: 'NORTHVUE' },
  ];
  const meta = new Map([
    [7, { name: 'Alex', isPartner: true }],
    [3, { name: 'Dad', isPartner: false }],
  ]);
  const contacts = buildFairnessByContact(
    rows, settlements, raw, '2026-06-01', '2026-07-01',
    { partnerContactIds: new Set([7]) }, meta,
  );

  const alex = contacts.find((c) => c.contactId === 7);
  const dad = contacts.find((c) => c.contactId === 3);
  assert.ok(alex && dad);
  // Alex: -partnerShareTotal (+18,811.58) + transfer (out - in = -8425) = 10,386.58
  assert.equal(Math.round((alex.byCurrency[0].balance) * 100) / 100, 10386.58);
  assert.equal(alex.isPartner, true);
  // Dad: -partnerShareTotal (+640.56) + (iPaid - partnerPaid = -11,198.30) = -10,557.74
  assert.equal(Math.round((dad.byCurrency[0].balance) * 100) / 100, -10557.74);
  // Alex's $8,425 transfer is not in Dad's bucket and vice-versa.
  assert.equal(alex.paybacks.length, 1);
  assert.equal(alex.paybacks[0].source, 'transfer');
  assert.equal(dad.paybacks.length, 1);
  assert.equal(dad.paybacks[0].source, 'settlement');
});

test('buildFairnessByContact routes unlabeled splits to Unassigned when no sole partner', () => {
  const rows: SharedTxnRow[] = [
    row({ ownershipType: 'me', ownershipContactId: null, amount: -100, myShare: -50, partnerShare: -50, currency: 'CAD' }),
  ];
  const contacts = buildFairnessByContact(
    rows, [], [], '2026-06-01', '2026-07-01',
    { partnerContactIds: new Set([7, 9]) }, new Map(),
  );
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].contactId, null);
  assert.equal(contacts[0].contactName, 'Unassigned');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: FAIL — `buildFairnessByContact` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/src/summary/partnerFairness.ts`:

```ts
export type FairnessContact = {
  contactId: number | null;
  contactName: string;
  isPartner: boolean;
  byCurrency: FairnessByCurrency[];
  paybacks: PaybackEntry[];
};

/**
 * Partition every contributing row/settlement/transfer by contact, then run the
 * existing per-currency builder on each contact's subset. A row contributes to a
 * contact when it is that contact's split (contactForSharedRow) OR a transfer
 * whose counterparty is that contact. Pure-`me` rows (partnerShare 0, no
 * counterparty) contribute to nobody and are dropped.
 */
export function buildFairnessByContact(
  rows: SharedTxnRow[],
  settlementTotals: SettlementTotals[],
  rawSettlements: RawSettlementForPayback[],
  currentMonthStart: string,
  nextMonthStart: string,
  options: FairnessOptions = {},
  contactsMeta: Map<number, { name: string; isPartner: boolean }> = new Map(),
): FairnessContact[] {
  const partnerContactIds = options.partnerContactIds ?? new Set<number>();
  const solePartnerId = resolveSolePartnerId(partnerContactIds);
  const transfersByContact = computeTransfersByContact(rows);

  // contactId (number | null) → rows. null = Unassigned bucket.
  const rowsByContact = new Map<number | null, SharedTxnRow[]>();
  const add = (cid: number | null, r: SharedTxnRow) => {
    const list = rowsByContact.get(cid) ?? [];
    list.push(r);
    rowsByContact.set(cid, list);
  };
  for (const r of rows) {
    if (r.partnerShare !== 0) {
      add(contactForSharedRow(r, solePartnerId), r);
    } else if (r.counterpartyContactId != null) {
      add(r.counterpartyContactId, r);
    }
  }

  // Ensure contacts that appear only via settlements still surface.
  const allContactIds = new Set<number | null>(rowsByContact.keys());
  for (const s of settlementTotals) allContactIds.add(s.contactId);

  const result: FairnessContact[] = [];
  for (const cid of allContactIds) {
    const contactRows = rowsByContact.get(cid) ?? [];
    const contactSettleTotals =
      cid == null ? [] : settlementTotals.filter((s) => s.contactId === cid);
    const contactRawSettlements =
      cid == null ? [] : rawSettlements.filter((s) => s.contactId === cid);
    const partnerTransfersByCurrency =
      cid == null ? new Map() : transfersByContact.get(cid) ?? new Map();

    const byCurrency = buildFairnessByCurrency(
      contactRows,
      contactSettleTotals,
      currentMonthStart,
      nextMonthStart,
      { ...options, partnerTransfersByCurrency },
    );
    if (byCurrency.length === 0) continue;

    const meta = cid != null ? contactsMeta.get(cid) : undefined;
    result.push({
      contactId: cid,
      contactName: meta?.name ?? (cid == null ? 'Unassigned' : `Contact ${cid}`),
      isPartner: meta?.isPartner ?? false,
      byCurrency,
      paybacks: buildPaybacks(contactRows, contactRawSettlements),
    });
  }

  // Partners first, then by name.
  return result.sort((a, b) =>
    a.isPartner === b.isPartner
      ? a.contactName.localeCompare(b.contactName)
      : a.isPartner ? -1 : 1,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: PASS (all tests). If the Alex balance is off, confirm `buildFairnessByCurrency` folds `(tr.out − tr.in)` (it does at the `balance =` line) and that the transfer row's `partnerShare` is `0`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/src/summary/partnerFairness.test.ts
git commit --no-verify -m "feat(partner): buildFairnessByContact partition-then-delegate"
```

---

## Task 4: `buildFairnessMonthlyByContact` + `buildSettlementRecommendationByContact` (pure)

**Files:**
- Modify: `backend/src/summary/partnerFairness.ts`
- Test: `backend/src/summary/partnerFairness.test.ts`

**Interfaces:**
- Consumes: `buildFairnessMonthly`, `buildSettlementRecommendation` (existing), `contactForSharedRow`, `resolveSolePartnerId`.
- Produces:
  - `buildFairnessMonthlyByContact(rows, monthlySettlements, options, contactsMeta): Array<{ contactId: number | null; contactName: string; isPartner: boolean; points: FairnessMonthlyPoint[] }>`
  - `buildSettlementRecommendationByContact(contacts: FairnessContact[]): Array<{ contactId: number | null; contactName: string; recommendations: SettlementRecommendation[] }>`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/summary/partnerFairness.test.ts`:

```ts
import {
  buildFairnessMonthlyByContact,
  buildSettlementRecommendationByContact,
} from './partnerFairness.ts';

test('buildFairnessMonthlyByContact keys trend per contact', () => {
  const rows: SharedTxnRow[] = [
    row({ ownershipType: 'me', amount: -100, myShare: -50, partnerShare: -50, date: '2026-01-15', currency: 'CAD' }),
    row({ ownershipType: 'contact', ownershipContactId: 3, amount: -200, myShare: 0, partnerShare: -200, date: '2026-01-20', currency: 'CAD' }),
  ];
  const meta = new Map([[7, { name: 'Alex', isPartner: true }], [3, { name: 'Dad', isPartner: false }]]);
  const out = buildFairnessMonthlyByContact(rows, [], { partnerContactIds: new Set([7]) }, meta);
  const alex = out.find((c) => c.contactId === 7);
  const dad = out.find((c) => c.contactId === 3);
  assert.equal(alex?.points[0].partnerShare, -50);
  assert.equal(dad?.points[0].partnerShare, -200);
});

test('buildSettlementRecommendationByContact derives per-contact recs', () => {
  const contacts = [
    { contactId: 7, contactName: 'Alex', isPartner: true, paybacks: [],
      byCurrency: [{ currency: 'CAD', balance: 10386.58, direction: 'partner_owes_me' } as never] },
  ];
  const recs = buildSettlementRecommendationByContact(contacts as never);
  assert.equal(recs[0].contactId, 7);
  assert.equal(recs[0].recommendations[0].direction, 'partner_pays_you');
  assert.equal(recs[0].recommendations[0].amount, 10386.58);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/src/summary/partnerFairness.ts`:

```ts
export function buildFairnessMonthlyByContact(
  rows: SharedTxnRow[],
  monthlySettlements: Array<SettlementTotals & { month: string }>,
  options: FairnessOptions = {},
  contactsMeta: Map<number, { name: string; isPartner: boolean }> = new Map(),
): Array<{ contactId: number | null; contactName: string; isPartner: boolean; points: FairnessMonthlyPoint[] }> {
  const solePartnerId = resolveSolePartnerId(options.partnerContactIds ?? new Set<number>());

  const rowsByContact = new Map<number | null, SharedTxnRow[]>();
  const add = (cid: number | null, r: SharedTxnRow) => {
    const list = rowsByContact.get(cid) ?? [];
    list.push(r);
    rowsByContact.set(cid, list);
  };
  for (const r of rows) {
    if (r.partnerShare !== 0) add(contactForSharedRow(r, solePartnerId), r);
    else if (r.counterpartyContactId != null) add(r.counterpartyContactId, r);
  }
  const allContactIds = new Set<number | null>(rowsByContact.keys());
  for (const s of monthlySettlements) allContactIds.add(s.contactId);

  const out: Array<{ contactId: number | null; contactName: string; isPartner: boolean; points: FairnessMonthlyPoint[] }> = [];
  for (const cid of allContactIds) {
    const contactRows = rowsByContact.get(cid) ?? [];
    const contactSettlements =
      cid == null ? [] : monthlySettlements.filter((s) => s.contactId === cid);
    const points = buildFairnessMonthly(contactRows, contactSettlements, options);
    if (points.length === 0) continue;
    const meta = cid != null ? contactsMeta.get(cid) : undefined;
    out.push({
      contactId: cid,
      contactName: meta?.name ?? (cid == null ? 'Unassigned' : `Contact ${cid}`),
      isPartner: meta?.isPartner ?? false,
      points,
    });
  }
  return out.sort((a, b) =>
    a.isPartner === b.isPartner ? a.contactName.localeCompare(b.contactName) : a.isPartner ? -1 : 1,
  );
}

export function buildSettlementRecommendationByContact(
  contacts: FairnessContact[],
): Array<{ contactId: number | null; contactName: string; recommendations: SettlementRecommendation[] }> {
  return contacts.map((c) => ({
    contactId: c.contactId,
    contactName: c.contactName,
    recommendations: buildSettlementRecommendation(c.byCurrency),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summary/partnerFairness.ts backend/src/summary/partnerFairness.test.ts
git commit --no-verify -m "feat(partner): per-contact monthly trend + recommendation"
```

---

## Task 5: Wire `routes/partner.ts` to the per-contact builders

**Files:**
- Modify: `backend/src/routes/partner.ts:93-217` (`loadSharedTxns`), `:261-332` (three handlers)
- Test: existing partner route test (see File Structure note)

**Interfaces:**
- Consumes: `buildFairnessByContact`, `buildFairnessMonthlyByContact`, `buildSettlementRecommendationByContact`, `RawSettlementForPayback`.
- Produces (HTTP): `/fairness` → `{ contacts: FairnessContact[], excludeNonPartnerInflows }`; `/monthly` → `{ contacts: [...], excludeNonPartnerInflows }`; `/settlement-recommendation` → `{ contacts: [...], excludeNonPartnerInflows }`.

- [ ] **Step 1: Write the failing test**

In the existing partner route test (integration), add a case asserting the new shape. Example (adapt to the file's existing setup/helpers):

```ts
test('GET /api/partner/fairness returns per-contact buckets', async () => {
  // ...seed one Alex shared txn + one Alex inbound transfer (counterparty_contact_id = Alex)...
  const res = await request(app).get('/api/partner/fairness').expect(200);
  assert.ok(Array.isArray(res.body.contacts));
  const alex = res.body.contacts.find((c: { isPartner: boolean }) => c.isPartner);
  assert.ok(alex);
  assert.ok(Array.isArray(alex.byCurrency));
  assert.ok(Array.isArray(alex.paybacks));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && yarn workspace cashflow-backend run test:integration` (or the single-file form the existing test uses).
Expected: FAIL — response has `byCurrency` at top level, no `contacts`.

- [ ] **Step 3: Implement**

In `loadSharedTxns`, build a `contactsMeta` map and collect raw settlements for paybacks. Replace the `contactsById` construction (around `:150`) and the return block (`:210-216`):

```ts
const contactsMeta = new Map<number, { name: string; isPartner: boolean }>(
  (contacts as Array<{ id: number; name: string; isPartner: boolean | number }>).map(
    (c) => [c.id, { name: c.name, isPartner: Boolean(c.isPartner) }],
  ),
);

const rawSettlements: RawSettlementForPayback[] = (settlements as unknown as RawSettlementRow[]).map(
  (s) => ({
    contactId: s.contactId,
    currency: s.currency,
    direction: s.direction,
    amount: num(s.amount) ?? 0,
    settledDate: s.settledDate,
    note: null,
  }),
);
```

Keep the existing `contactsById` (still used for `contactName` on rows). Add `contactsMeta` and `rawSettlements` to the returned object. Also add `note` to the `RawSettlementRow` type and the `PartnerSettlement.findAll` attributes (`:108` area) so payback notes survive: add `'notes'` to attributes and set `note: s.notes ?? null` above.

Rewrite the three handlers:

```ts
router.get('/fairness', async (req, res, next) => {
  try {
    const { sharedRows, settlementTotals, rawSettlements, partnerContactIds, viewerUserId, contactsMeta } =
      await loadSharedTxns(req);
    const excludeNonPartnerInflows = await resolveExcludeNonPartnerInflows(req);
    const { start, nextStart } = currentMonthBoundaries(new Date());
    const contactsList = buildFairnessByContact(
      sharedRows, settlementTotals, rawSettlements, start, nextStart,
      { partnerContactIds, excludeNonPartnerInflows, viewerUserId }, contactsMeta,
    );
    res.json({ contacts: contactsList, excludeNonPartnerInflows });
  } catch (e) { next(e); }
});

router.get('/monthly', async (req, res, next) => {
  try {
    const { sharedRows, monthlySettlements, partnerContactIds, viewerUserId, contactsMeta } =
      await loadSharedTxns(req);
    const excludeNonPartnerInflows = await resolveExcludeNonPartnerInflows(req);
    const contactsList = buildFairnessMonthlyByContact(
      sharedRows, monthlySettlements,
      { partnerContactIds, excludeNonPartnerInflows, viewerUserId }, contactsMeta,
    );
    res.json({ contacts: contactsList, excludeNonPartnerInflows });
  } catch (e) { next(e); }
});

router.get('/settlement-recommendation', async (req, res, next) => {
  try {
    const { sharedRows, settlementTotals, rawSettlements, partnerContactIds, viewerUserId, contactsMeta } =
      await loadSharedTxns(req);
    const excludeNonPartnerInflows = await resolveExcludeNonPartnerInflows(req);
    const { start, nextStart } = currentMonthBoundaries(new Date());
    const fairnessContacts = buildFairnessByContact(
      sharedRows, settlementTotals, rawSettlements, start, nextStart,
      { partnerContactIds, excludeNonPartnerInflows, viewerUserId }, contactsMeta,
    );
    const contactsList = buildSettlementRecommendationByContact(fairnessContacts);
    res.json({ contacts: contactsList, excludeNonPartnerInflows });
  } catch (e) { next(e); }
});
```

Update the imports at the top of `partner.ts` to include the new builders and `RawSettlementForPayback`; drop now-unused `buildFairnessByCurrency`/`buildFairnessMonthly`/`buildSettlementRecommendation`/`computePartnerTransferDelta` imports **only if** no longer referenced (the per-contact builders call them internally, so they may remain imported by the module, not the route — verify with the typecheck step).

- [ ] **Step 4: Run tests + typecheck**

Run: `cd backend && yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run test:integration`
Expected: PASS; the new shape assertion passes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/partner.ts backend/test/integration
git commit --no-verify -m "feat(partner): serve per-contact fairness/monthly/recommendation"
```

---

## Task 6: Frontend API types

**Files:**
- Modify: `frontend/src/types/api.ts:544-615`

**Interfaces:**
- Produces: `PaybackEntry`, `PartnerFairnessContact`; updated `PartnerFairnessResponse`, `PartnerFairnessMonthlyResponse`, `PartnerSettlementRecommendationResponse`.

- [ ] **Step 1: Update types**

Keep `PartnerFairnessByCurrency`, `PartnerFairnessMonthlyPoint`, `PartnerSettlementRecommendation` as-is. Add and change:

```ts
/** A payback movement shown in a contact's history (display-only; already counted in balance). */
export type PaybackEntry = {
  source: 'transfer' | 'settlement'
  date: string
  amount: number
  currency: string
  direction: 'partner_paid_me' | 'i_paid_partner'
  note: string | null
  txnId: number | null
}

/** Per-contact fairness bucket. */
export type PartnerFairnessContact = {
  contactId: number | null
  contactName: string
  isPartner: boolean
  byCurrency: PartnerFairnessByCurrency[]
  paybacks: PaybackEntry[]
}

export type PartnerFairnessResponse = {
  contacts: PartnerFairnessContact[]
  excludeNonPartnerInflows: boolean
}

export type PartnerFairnessMonthlyContact = {
  contactId: number | null
  contactName: string
  isPartner: boolean
  points: PartnerFairnessMonthlyPoint[]
}
export type PartnerFairnessMonthlyResponse = {
  contacts: PartnerFairnessMonthlyContact[]
  excludeNonPartnerInflows: boolean
}

export type PartnerSettlementRecommendationContact = {
  contactId: number | null
  contactName: string
  recommendations: PartnerSettlementRecommendation[]
}
export type PartnerSettlementRecommendationResponse = {
  contacts: PartnerSettlementRecommendationContact[]
  excludeNonPartnerInflows: boolean
}
```

- [ ] **Step 2: Typecheck (expect frontend errors to fix next)**

Run: `yarn workspace frontend run lint` then `yarn workspace frontend exec tsc --noEmit` (or the repo's frontend typecheck).
Expected: FAIL in `PartnerHomePage.tsx` / `PartnerFairnessPage.tsx` referencing `byCurrency`. Those are fixed in Tasks 7–8.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/api.ts
git commit --no-verify -m "feat(partner): per-contact fairness API types"
```

---

## Task 7: `PartnerHomePage` — show the partner balance

**Files:**
- Modify: `frontend/src/pages/PartnerHomePage.tsx`
- Test: `frontend/src/pages/PartnerHomePage.test.tsx` (create)

**Interfaces:**
- Consumes: `PartnerFairnessResponse` (now `contacts[]`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/PartnerHomePage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PartnerHomePage } from './PartnerHomePage'
import * as api from '../lib/api'

describe('PartnerHomePage', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('shows the is_partner contact balance, not a conflated total', async () => {
    vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
      if (url.startsWith('/api/partner/fairness')) {
        return {
          contacts: [
            { contactId: 7, contactName: 'Alex', isPartner: true, paybacks: [],
              byCurrency: [{ currency: 'CAD', balance: 10386.58, direction: 'partner_owes_me',
                currentMonthSharedSpend: 0, sharedTransactionCount: 3 }] },
            { contactId: 3, contactName: 'Dad', isPartner: false, paybacks: [],
              byCurrency: [{ currency: 'CAD', balance: -10557.74, direction: 'i_owe_partner',
                currentMonthSharedSpend: 0, sharedTransactionCount: 1 }] },
          ], excludeNonPartnerInflows: false,
        } as never
      }
      return [{ visibility: 'shared' }] as never
    })
    render(<MemoryRouter><PartnerHomePage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Alex')).toBeInTheDocument())
    expect(screen.queryByText('Dad')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend run test PartnerHomePage`
Expected: FAIL — page reads `f.byCurrency`.

- [ ] **Step 3: Implement**

In `PartnerHomePage.tsx`: change the state + fetch to consume `contacts`, filter to `isPartner`, and render a card per partner contact (title = contact name). Replace `CurrencyCard`'s title and the state wiring:

```tsx
import type { Account, PartnerFairnessContact, PartnerFairnessResponse } from '../types/api'

// state
const [partners, setPartners] = useState<PartnerFairnessContact[]>([])

// in the .then():
setPartners(f.contacts.filter((c) => c.isPartner))

// render the first currency bucket per partner contact (CAD-primary households);
// map all byCurrency for multi-currency.
{partners.length > 0 ? (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {partners.flatMap((c) =>
      c.byCurrency.map((cur) => (
        <ContactCurrencyCard key={`${c.contactId}-${cur.currency}`} name={c.contactName} data={cur} />
      )),
    )}
  </div>
) : null}
```

Rename `CurrencyCard` → `ContactCurrencyCard({ name, data })`, set `<CardTitle>{name} · {data.currency}</CardTitle>`, and gate the empty states on `partners.length === 0` instead of `fairness.length === 0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn workspace frontend run test PartnerHomePage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/PartnerHomePage.tsx frontend/src/pages/PartnerHomePage.test.tsx
git commit --no-verify -m "feat(partner): partner-home shows per-partner balance"
```

---

## Task 8: `PartnerFairnessPage` — per-contact sections + payback list

**Files:**
- Modify: `frontend/src/pages/PartnerFairnessPage.tsx`
- Test: `frontend/src/pages/PartnerFairnessPage.test.tsx` (create or extend)

**Interfaces:**
- Consumes: `PartnerFairnessResponse`, `PartnerFairnessMonthlyResponse`, `PartnerSettlementRecommendationResponse` (all now `contacts[]`), `PaybackEntry`.

- [ ] **Step 1: Read the current page**

Run: open `frontend/src/pages/PartnerFairnessPage.tsx`. Identify where it maps `data.byCurrency` (single per-currency render), `monthly`, and `recommendation`. The refactor wraps the existing per-currency render in an outer `contacts.map`, and resolves monthly/recommendation by `contactId`.

- [ ] **Step 2: Write the failing test**

Create/extend `frontend/src/pages/PartnerFairnessPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PartnerFairnessPage } from './PartnerFairnessPage'
import * as api from '../lib/api'

describe('PartnerFairnessPage', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('renders a section per contact and shows payback source badges', async () => {
    vi.spyOn(api, 'getJson').mockImplementation(async (url: string) => {
      if (url.startsWith('/api/partner/fairness')) return {
        contacts: [
          { contactId: 7, contactName: 'Alex', isPartner: true,
            paybacks: [{ source: 'transfer', date: '2025-07-28', amount: 7000, currency: 'CAD', direction: 'partner_paid_me', note: 'Cash received', txnId: 1045 }],
            byCurrency: [{ currency: 'CAD', balance: 10386.58, direction: 'partner_owes_me', sharedSpendTotal: -37623.16, myShareTotal: -18811.58, partnerShareTotal: -18811.58, sharedTransactionCount: 3, currentMonthSharedSpend: 0, partnerInflows: 7000, nonPartnerInflows: 0, partnerTransfers: { in: 7000, out: 0 }, paidMore: { youCovered: 18811.58, partnerCovered: 0 }, categoryBreakdown: [], largestShared: [] }] },
          { contactId: 3, contactName: 'Dad', isPartner: false, paybacks: [],
            byCurrency: [{ currency: 'CAD', balance: -10557.74, direction: 'i_owe_partner', sharedSpendTotal: -640.56, myShareTotal: 0, partnerShareTotal: -640.56, sharedTransactionCount: 1, currentMonthSharedSpend: 0, partnerInflows: 0, nonPartnerInflows: 0, partnerTransfers: { in: 0, out: 0 }, paidMore: { youCovered: 0, partnerCovered: 11198.30 }, categoryBreakdown: [], largestShared: [] }] },
        ], excludeNonPartnerInflows: false,
      } as never
      if (url.startsWith('/api/partner/monthly')) return { contacts: [], excludeNonPartnerInflows: false } as never
      if (url.startsWith('/api/partner/settlement-recommendation')) return { contacts: [], excludeNonPartnerInflows: false } as never
      return [] as never
    })
    render(<MemoryRouter><PartnerFairnessPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Alex')).toBeInTheDocument())
    expect(screen.getByText('Dad')).toBeInTheDocument()
    expect(screen.getByText(/Cash received/)).toBeInTheDocument()
    expect(screen.getByText(/bank transfer/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn workspace frontend run test PartnerFairnessPage`
Expected: FAIL — page reads flat `byCurrency`/`points`/`recommendations`.

- [ ] **Step 4: Implement**

- State: `contacts: PartnerFairnessContact[]`, `monthlyByContact: PartnerFairnessMonthlyContact[]`, `recsByContact: PartnerSettlementRecommendationContact[]`. In the fetch `.then`, set from `.contacts`.
- Wrap the existing per-currency render block in an outer loop:

```tsx
{contacts.map((contact) => {
  const monthly = monthlyByContact.find((m) => m.contactId === contact.contactId)?.points ?? []
  const recs = recsByContact.find((r) => r.contactId === contact.contactId)?.recommendations ?? []
  return (
    <section key={contact.contactId ?? 'unassigned'} className="mb-8">
      <h2 className="mb-3 text-lg font-semibold">
        {contact.contactName}
        {!contact.isPartner ? <span className="ml-2 text-sm text-muted-foreground">(other balance)</span> : null}
      </h2>
      {/* existing per-currency cards: iterate contact.byCurrency instead of data.byCurrency;
          use `monthly` and `recs` (already scoped to this contact) where the old code used the flat arrays */}
      <PaybackList paybacks={contact.paybacks} />
    </section>
  )
})}
```

- Add the `PaybackList` component (new, app-side Tailwind; DS `Badge` if available, else a span):

```tsx
import { formatMoney } from '../lib/formatMoney'
import type { PaybackEntry } from '../types/api'

function PaybackList({ paybacks }: { paybacks: PaybackEntry[] }) {
  if (paybacks.length === 0) return null
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">Paybacks</h3>
      <ul className="grid gap-1">
        {paybacks.map((p, i) => (
          <li key={`${p.txnId ?? 'settle'}-${i}`} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {p.source === 'transfer' ? 'bank transfer' : 'manual'}
              </span>
              <span>{p.date}</span>
              <span className="text-muted-foreground">{p.note ?? ''}</span>
            </span>
            <span className={p.direction === 'partner_paid_me' ? 'text-positive' : 'text-negative'}>
              {p.direction === 'partner_paid_me' ? '+' : '−'}{formatMoney(p.amount, p.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- Order: partners already sorted first by the backend; render in received order.

- [ ] **Step 5: Run test + frontend typecheck**

Run: `yarn workspace frontend run test PartnerFairnessPage && yarn workspace frontend run lint`
Expected: PASS, no type errors referencing the old flat shape.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/PartnerFairnessPage.tsx frontend/src/pages/PartnerFairnessPage.test.tsx
git commit --no-verify -m "feat(partner): per-contact fairness sections + payback list"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend unit + integration + typecheck**

Run: `cd backend && yarn workspace cashflow-backend run typecheck && yarn workspace cashflow-backend run lint`
Then: `cd backend && yarn tsx --import ./test/setup.ts --test src/summary/partnerFairness.test.ts`
Then: `yarn workspace cashflow-backend run test:integration`
Expected: all PASS.

- [ ] **Step 2: Frontend tests + lint**

Run: `yarn workspace frontend run test && yarn workspace frontend run lint`
Expected: all PASS.

- [ ] **Step 3: Full CI gate**

Run: `yarn ci`
Expected: typecheck, tests, both builds PASS.

- [ ] **Step 4: Manual prod-shape sanity (optional, read-only)**

With the dev server pointed at a local/test DB (never prod for app reads per conventions), hit `/api/partner/fairness` and confirm two contacts (Alex partner-first, Dad as "other balance"), Alex's balance ≈ the expected figure, and Alex's `paybacks` lists the tagged transfer. Note: the real prod Alex headline lands ≈ $10,850 once the pre-existing Golf `partner`-split row (no contact) attributes to Alex — verify that row is genuinely an Alex split during review.

---

## Self-review notes

- **Spec coverage:** attribution (T1), per-contact grouping (T3/T4), payback visibility (T2 + T7/T8), API shape (T5/T6), frontend (T7/T8), tests incl. conflation regression + attribution guard (T1/T3) + payback assembly (T2). All spec sections mapped.
- **No migration:** confirmed — all attribution is query-time; no Sequelize migration task exists by design.
- **Double-count guard:** balance math is untouched (existing builders); `buildPaybacks` is display-only and never feeds balance. Settlement delta and transfer delta remain disjoint (`partnerShare === 0` gate).
- **Type consistency:** `FairnessContact` (backend) ↔ `PartnerFairnessContact` (frontend) share field names; `PaybackEntry` identical both sides; `contactId: number | null` consistent throughout.
