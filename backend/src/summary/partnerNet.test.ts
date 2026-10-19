import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettlements,
  attributeSplitContact,
  resolveSolePartnerId,
  summarizeSettlements,
  rawNetForRow,
  type RawPartnerRow,
  type SettlementSummary,
} from './partnerMath';

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
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 30, partnerPaid: 0, count: 1 }];
  const [adj] = applySettlements(rows, settlements).byCurrency;
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 30);
  assert.equal(adj.net, 130);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: contact row + partner paid me → net falls', () => {
  // Partner owes me 100. They paid me 40 → they now owe me 60.
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 40, count: 1 }];
  const [adj] = applySettlements(rows, settlements).byCurrency;
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, -40);
  assert.equal(adj.net, 60);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: settled to exactly zero is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 100, count: 1 }];
  const [adj] = applySettlements(rows, settlements).byCurrency;
  assert.equal(adj.net, 0);
  assert.equal(adj.direction, 'even');
});

test('applySettlements: me-owned row gets no settlement (no contactId)', () => {
  const rows = [makeRow({ sumMy: -10_991.53, sumPartner: -7_273.64 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 999, partnerPaid: 0, count: 1 }];
  const [adj] = applySettlements(rows, settlements).byCurrency;
  assert.equal(adj.rawNet, 7_273.64);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.settlementCount, 0);
  assert.equal(adj.net, 7_273.64);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: orphan settlement creates no row but is surfaced as unmatched', () => {
  const result = applySettlements([], [{ contactId: 1, currency: 'CAD', iPaid: 25, partnerPaid: 0, count: 1 }]);
  assert.equal(result.byCurrency.length, 0);
  assert.deepEqual(result.unmatchedSettlements, [
    { contactId: 1, contactName: null, currency: 'CAD', iPaid: 25, partnerPaid: 0, settledAmount: 25, settlementCount: 1 },
  ]);
});

test('applySettlements: settlement in a different currency does not adjust the row', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'USD', iPaid: 50, partnerPaid: 0, count: 1 }];
  const [adj] = applySettlements(rows, settlements).byCurrency;
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.net, 100);
  assert.equal(adj.settlementCount, 0);
});

test('applySettlements: both settlement directions on same key collapse via signed sum', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 0 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 80, partnerPaid: 30, count: 2 }];
  const [adj] = applySettlements(rows, settlements).byCurrency;
  assert.equal(adj.rawNet, 0);
  assert.equal(adj.settledAmount, 50);
  assert.equal(adj.net, 50);
  assert.equal(adj.direction, 'partner_owes_me');
  assert.equal(adj.settlementCount, 2);
});

test('applySettlements: sub-cent diff is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -0.001 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 0.005, count: 1 }];
  const [adj] = applySettlements(rows, settlements).byCurrency;
  assert.equal(adj.direction, 'even');
});

// Regression: the 2026-05-22 screenshot scenario, re-derived under the corrected
// sign. A me-owned row with partner=-$7,273.64 is purchase-dominated: the
// partner's share of spend I paid → partner owes me $7,273.64.
test('regression: me-owned purchase-dominated row → partner owes me', () => {
  const rows = [makeRow({ sumMy: -10_991.53, sumPartner: -7_273.64 })];
  const [adj] = applySettlements(rows, []).byCurrency;
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
  const adjusted = applySettlements(rows, []).byCurrency;
  const rollup = adjusted.reduce((sum, r) => sum + r.net, 0);
  // 250 (their share of my-tagged purchase) + 500 (their half of shared purchase)
  //   − 100 (refund/inflow partly theirs → I owe them) = 650.
  assert.equal(rollup, 650);
});

// ---------------- settlement counting ----------------

test('summarizeSettlements: counts settlements, not directions', () => {
  const summaries = summarizeSettlements([
    { contactId: 1, currency: 'CAD', direction: 'i_paid_partner', amount: '10' },
    { contactId: 1, currency: 'CAD', direction: 'i_paid_partner', amount: 15 },
    { contactId: 1, currency: 'CAD', direction: 'partner_paid_me', amount: '5.50' },
    { contactId: 1, currency: 'CAD', direction: 'partner_paid_me', amount: 4.5 },
    { contactId: 1, currency: 'USD', direction: 'partner_paid_me', amount: 7 },
  ]);
  assert.deepEqual(summaries, [
    { contactId: 1, currency: 'CAD', iPaid: 25, partnerPaid: 10, count: 4 },
    { contactId: 1, currency: 'USD', iPaid: 0, partnerPaid: 7, count: 1 },
  ]);
});

test('applySettlements: settlementCount reports every settlement on the key', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, sumPartner: -100 })];
  const [adj] = applySettlements(rows, [
    { contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 60, count: 3 },
  ]).byCurrency;
  assert.equal(adj.settlementCount, 3);
});

// ---------------- sole-partner attribution ----------------

test('resolveSolePartnerId: id only when exactly one partner', () => {
  assert.equal(resolveSolePartnerId([7]), 7);
  assert.equal(resolveSolePartnerId([]), null);
  assert.equal(resolveSolePartnerId([7, 9]), null);
});

test('attributeSplitContact: a stamped contact wins; an unstamped split falls to the sole partner', () => {
  assert.equal(attributeSplitContact({ ownershipType: 'contact', ownershipContactId: 3 }, 7), 3);
  assert.equal(attributeSplitContact({ ownershipType: 'partner', ownershipContactId: 7 }, null), 7);
  assert.equal(attributeSplitContact({ ownershipType: 'partner', ownershipContactId: null }, 7), 7);
  assert.equal(attributeSplitContact({ ownershipType: 'shared', ownershipContactId: null }, 7), 7);
  assert.equal(attributeSplitContact({ ownershipType: 'shared', ownershipContactId: null }, null), null);
  // A contact-owned row with no contact is malformed; never guess the partner.
  assert.equal(attributeSplitContact({ ownershipType: 'contact', ownershipContactId: null }, 7), null);
});

test('applySettlements: unstamped partner split matches the sole partner settlement (the Reports bug)', () => {
  // Import stamps ownershipType='partner' with no contact. Partner owes me 100;
  // they paid me 100. Before the fix the settlement was dropped and Reports
  // kept saying "partner owes you $100" forever.
  const rows = [makeRow({ ownershipType: 'partner', sumMy: -100, sumPartner: -100 })];
  const result = applySettlements(
    rows,
    [{ contactId: 7, currency: 'CAD', iPaid: 0, partnerPaid: 100, count: 1 }],
    { solePartnerId: 7, contactNames: new Map([[7, 'Sam']]) },
  );
  assert.equal(result.byCurrency.length, 1);
  const [adj] = result.byCurrency;
  assert.equal(adj.ownershipContactId, 7);
  assert.equal(adj.contactName, 'Sam');
  assert.equal(adj.settledAmount, -100);
  assert.equal(adj.settlementCount, 1);
  assert.equal(adj.net, 0);
  assert.equal(adj.direction, 'even');
  assert.deepEqual(result.unmatchedSettlements, []);
});

test('applySettlements: rows sharing one partner collapse so a settlement is applied exactly once', () => {
  // 'partner' + 'shared' (unstamped) + 'contact' stamped to the partner all
  // belong to contact 7. Applying the settlement per row would triple it.
  const rows = [
    makeRow({ ownershipType: 'partner', sumMy: -40, sumPartner: -60 }),
    makeRow({ ownershipType: 'shared', sumMy: -50, sumPartner: -50 }),
    makeRow({ ownershipType: 'contact', ownershipContactId: 7, contactName: 'Sam', sumMy: 0, sumPartner: -10 }),
    makeRow({ ownershipType: 'me', sumMy: -500, sumPartner: 0 }),
  ];
  const result = applySettlements(
    rows,
    [{ contactId: 7, currency: 'CAD', iPaid: 0, partnerPaid: 90, count: 2 }],
    { solePartnerId: 7 },
  );
  assert.equal(result.byCurrency.length, 2);
  const [partnerRow, meRow] = result.byCurrency;
  assert.equal(partnerRow.ownershipContactId, 7);
  assert.equal(partnerRow.ownershipType, 'mixed');
  assert.equal(partnerRow.contactName, 'Sam');
  assert.equal(partnerRow.sumMy, -90);
  assert.equal(partnerRow.sumPartner, -120);
  assert.equal(partnerRow.rawNet, 120);
  assert.equal(partnerRow.settledAmount, -90);
  assert.equal(partnerRow.net, 30);
  assert.equal(partnerRow.settlementCount, 2);
  // Pure-me row (no partner share) is never attributed or settled.
  assert.equal(meRow.ownershipType, 'me');
  assert.equal(meRow.ownershipContactId, null);
  assert.equal(meRow.settledAmount, 0);
  const total = result.byCurrency.reduce((s, r) => s + r.net, 0);
  assert.equal(total, 30);
});

test('applySettlements: a me-tagged row carrying a partner share is attributed (matches Fairness)', () => {
  const rows = [makeRow({ ownershipType: 'me', sumMy: -50, sumPartner: -50 })];
  const [adj] = applySettlements(
    rows,
    [{ contactId: 7, currency: 'CAD', iPaid: 0, partnerPaid: 50, count: 1 }],
    { solePartnerId: 7 },
  ).byCurrency;
  assert.equal(adj.ownershipContactId, 7);
  assert.equal(adj.ownershipType, 'me');
  assert.equal(adj.net, 0);
});

test('applySettlements: with no sole partner, unstamped splits stay unattributed and settlements are surfaced, not dropped', () => {
  const rows = [makeRow({ ownershipType: 'partner', sumMy: -100, sumPartner: -100 })];
  const result = applySettlements(
    rows,
    [
      { contactId: 7, currency: 'CAD', iPaid: 0, partnerPaid: 60, count: 2 },
      { contactId: 9, currency: 'CAD', iPaid: 20, partnerPaid: 0, count: 1 },
    ],
    { solePartnerId: null, contactNames: new Map([[7, 'Sam'], [9, 'Alex']]) },
  );
  const [adj] = result.byCurrency;
  assert.equal(adj.ownershipContactId, null);
  assert.equal(adj.net, 100);
  assert.equal(adj.settlementCount, 0);
  assert.deepEqual(result.unmatchedSettlements, [
    { contactId: 7, contactName: 'Sam', currency: 'CAD', iPaid: 0, partnerPaid: 60, settledAmount: -60, settlementCount: 2 },
    { contactId: 9, contactName: 'Alex', currency: 'CAD', iPaid: 20, partnerPaid: 0, settledAmount: 20, settlementCount: 1 },
  ]);
});
