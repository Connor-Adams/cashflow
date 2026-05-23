import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettlements,
  rawNetForRow,
  type RawPartnerRow,
  type SettlementSummary,
} from '../src/routes/summary';

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

// Single-payer model: I (the uploader) always pay. Per-row net is just sumPartner —
// what partner owes me from their share. sumMy is my own portion (not debt).

test('rawNetForRow: net = sumPartner (partner owes me their share)', () => {
  assert.equal(rawNetForRow(makeRow({ sumMy: 10_991.53, sumPartner: 250 })), 250);
});

test('rawNetForRow: negative sumPartner means net refunds on partner-split items → I owe partner', () => {
  // Refunds on partner-split items came back to my card → I owe partner that money.
  // Critically: my own sumMy (10,991.53) is NOT added to the debt.
  assert.equal(rawNetForRow(makeRow({ sumMy: 10_991.53, sumPartner: -7_273.64 })), -7_273.64);
});

test('rawNetForRow: ownershipType is irrelevant under single-payer', () => {
  // Whether the auto-classifier tagged the row 'me' / 'partner' / 'shared' / 'contact',
  // the uploader paid → net is always sumPartner.
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'me', sumPartner: 100 })), 100);
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'partner', sumPartner: 100 })), 100);
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'shared', sumPartner: 100 })), 100);
  assert.equal(rawNetForRow(makeRow({ ownershipType: 'contact', ownershipContactId: 1, sumPartner: 100 })), 100);
});

test('rawNetForRow: zero / null sumPartner → 0', () => {
  assert.equal(rawNetForRow(makeRow({ sumPartner: 0 })), 0);
  assert.equal(rawNetForRow(makeRow({ sumPartner: null })), 0);
});

// applySettlements: only contact-tagged rows can match a settlement (settlements carry a contactId).
// Settlement signs: iPaid raises net (I paid partner → they're more in credit with me).
//                   partnerPaid lowers net (partner paid me → less in credit).

test('applySettlements: contact row + I paid partner → net rises', () => {
  // Partner's share = 100 → partner owes me 100. I paid them 30 → they owe me 130 (or equivalently
  // I have +30 credit waiting to come back).
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 100 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 30, partnerPaid: 0 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 30);
  assert.equal(adj.net, 130);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: contact row + partner paid me → net falls', () => {
  // Partner owes me 100. They paid me 40 → they now owe me 60.
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 100 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 40 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, -40);
  assert.equal(adj.net, 60);
  assert.equal(adj.direction, 'partner_owes_me');
});

test('applySettlements: settled to exactly zero is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 100 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 100 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.net, 0);
  assert.equal(adj.direction, 'even');
});

test('applySettlements: me-owned row gets no settlement (no contactId)', () => {
  // Settlements only attach to contact rows; the typical 'me' row passes through unchanged.
  const rows = [makeRow({ sumMy: 10_991.53, sumPartner: -7_273.64 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 999, partnerPaid: 0 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, -7_273.64);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.settlementCount, 0);
  assert.equal(adj.net, -7_273.64);
  assert.equal(adj.direction, 'i_owe_partner');
});

test('applySettlements: orphan settlement with no matching row does NOT create a new row', () => {
  const adjusted = applySettlements([], [
    { contactId: 1, currency: 'CAD', iPaid: 25, partnerPaid: 0 },
  ]);
  assert.equal(adjusted.length, 0);
});

test('applySettlements: settlement in a different currency does not adjust the row', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 100 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'USD', iPaid: 50, partnerPaid: 0 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.net, 100);
  assert.equal(adj.settlementCount, 0);
});

test('applySettlements: both settlement directions on same key collapse via signed sum', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 0 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 80, partnerPaid: 30 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 0);
  assert.equal(adj.settledAmount, 50);
  assert.equal(adj.net, 50);
  assert.equal(adj.direction, 'partner_owes_me');
  assert.equal(adj.settlementCount, 2);
});

test('applySettlements: sub-cent diff is "even"', () => {
  const rows = [makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumPartner: 0.001 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 0.005 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.direction, 'even');
});

// Regression: the screenshot scenario the user reported on 2026-05-22.
// One ownership='me' row with my=$10,991.53 (own spending) and partner=−$7,273.64 (refunds on
// partner-split items that came back to my card). Pre-fix: net = −$18,265.17. Post-fix: net =
// −$7,273.64 (I owe partner $7,273.64, the refund money that conceptually belongs to them).
test('regression: me-owned with refunds on partner-split does NOT count own spending as debt', () => {
  const rows = [makeRow({ sumMy: 10_991.53, sumPartner: -7_273.64 })];
  const [adj] = applySettlements(rows, []);
  assert.equal(adj.rawNet, -7_273.64);
  assert.equal(adj.net, -7_273.64);
  assert.equal(adj.direction, 'i_owe_partner');
});

// Household rollup: sum of `net` across rows should equal the actual debt to partner.
test('applySettlements: rollup across multiple rows sums sumPartner totals', () => {
  const rows = [
    makeRow({ ownershipType: 'me', sumMy: 1_000, sumPartner: 250 }),
    makeRow({ ownershipType: 'shared', sumMy: 500, sumPartner: 500 }),
    makeRow({ ownershipType: 'contact', ownershipContactId: 1, contactName: 'Sam', sumMy: 0, sumPartner: -100 }),
  ];
  const adjusted = applySettlements(rows, []);
  const rollup = adjusted.reduce((sum, r) => sum + r.net, 0);
  // 250 (partner owes me their share of my-tagged) + 500 (partner's half of shared) − 100 (refund on contact-tagged)
  assert.equal(rollup, 650);
});
