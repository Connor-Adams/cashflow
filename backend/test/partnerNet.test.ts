import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettlements,
  rawNetForRow,
  type RawPartnerRow,
  type SettlementSummary,
} from '../src/summary/partnerMath';

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
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 30, partnerPaid: 0 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 30);
  assert.equal(adj.net, 130);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: contact row + partner paid me → net falls', () => {
  // Partner owes me 100. They paid me 40 → they now owe me 60.
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 40 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, -40);
  assert.equal(adj.net, 60);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: settled to exactly zero is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 100 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.net, 0);
  assert.equal(adj.direction, 'even');
});

test('applySettlements: me-owned row gets no settlement (no contactId)', () => {
  const rows = [makeRow({ sumMy: -10_991.53, sumPartner: -7_273.64 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 999, partnerPaid: 0 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 7_273.64);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.settlementCount, 0);
  assert.equal(adj.net, 7_273.64);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: orphan settlement with no matching row does NOT create a new row', () => {
  const adjusted = applySettlements([], [{ contactId: 1, currency: 'CAD', iPaid: 25, partnerPaid: 0 }]);
  assert.equal(adjusted.length, 0);
});

test('applySettlements: settlement in a different currency does not adjust the row', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -100 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'USD', iPaid: 50, partnerPaid: 0 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.net, 100);
  assert.equal(adj.settlementCount, 0);
});

test('applySettlements: both settlement directions on same key collapse via signed sum', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 0 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 80, partnerPaid: 30 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 0);
  assert.equal(adj.settledAmount, 50);
  assert.equal(adj.net, 50);
  assert.equal(adj.direction, 'partner_owes_me');
  assert.equal(adj.settlementCount, 2);
});

test('applySettlements: sub-cent diff is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: -0.001 })];
  const settlements: SettlementSummary[] = [{ contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 0.005 }];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.direction, 'even');
});

// Regression: the 2026-05-22 screenshot scenario, re-derived under the corrected
// sign. A me-owned row with partner=-$7,273.64 is purchase-dominated: the
// partner's share of spend I paid → partner owes me $7,273.64.
test('regression: me-owned purchase-dominated row → partner owes me', () => {
  const rows = [makeRow({ sumMy: -10_991.53, sumPartner: -7_273.64 })];
  const [adj] = applySettlements(rows, []);
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
  const adjusted = applySettlements(rows, []);
  const rollup = adjusted.reduce((sum, r) => sum + r.net, 0);
  // 250 (their share of my-tagged purchase) + 500 (their half of shared purchase)
  //   − 100 (refund/inflow partly theirs → I owe them) = 650.
  assert.equal(rollup, 650);
});
