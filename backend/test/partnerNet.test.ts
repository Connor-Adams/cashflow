import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettlements,
  computePartnerNet,
  type RawPartnerRow,
  type SettlementSummary,
} from '../src/routes/summary';

test('computePartnerNet: partner owes me when sumPartner > sumMy', () => {
  const r = computePartnerNet(100, 250);
  assert.equal(r.net, 150);
  assert.equal(r.direction, 'partner_owes_me');
});

test('computePartnerNet: I owe partner when sumPartner < sumMy', () => {
  const r = computePartnerNet(300, 200);
  assert.equal(r.net, -100);
  assert.equal(r.direction, 'i_owe_partner');
});

test('computePartnerNet: even within sub-cent tolerance', () => {
  // Difference of 0.004 — below the 0.005 threshold — counts as even.
  const r = computePartnerNet(100.001, 100.005);
  assert.equal(r.direction, 'even');
});

test('computePartnerNet: exact zero is even', () => {
  const r = computePartnerNet(0, 0);
  assert.equal(r.net, 0);
  assert.equal(r.direction, 'even');
});

test('computePartnerNet: nulls coerce to zero', () => {
  const r = computePartnerNet(null, null);
  assert.equal(r.net, 0);
  assert.equal(r.direction, 'even');
});

test('computePartnerNet: null sumMy treats partner as full debt', () => {
  const r = computePartnerNet(null, 42);
  assert.equal(r.net, 42);
  assert.equal(r.direction, 'partner_owes_me');
});

test('computePartnerNet: just over half a cent flips out of even', () => {
  // 0.006 difference → rounds to 0.01, not even.
  const r = computePartnerNet(0, 0.006);
  assert.equal(r.direction, 'partner_owes_me');
});

function makeRow(over: Partial<RawPartnerRow> = {}): RawPartnerRow {
  return {
    currency: 'CAD',
    ownershipType: 'contact',
    ownershipContactId: 1,
    contactName: 'Sam',
    sumMy: 0,
    sumPartner: 0,
    ...over,
  };
}

test('applySettlements: i_paid_partner pushes net higher (partner owes me more)', () => {
  // Raw: partner=200, my=100 → rawNet=+100 (partner owes me 100).
  // I paid partner 50 → I overpaid → partner now owes me 150.
  const rows = [makeRow({ sumMy: 100, sumPartner: 200 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 50, partnerPaid: 0 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, 50);
  assert.equal(adj.net, 150);
  assert.equal(adj.direction, 'partner_owes_me');
  assert.equal(adj.settlementCount, 1);
});

test('applySettlements: partner_paid_me pushes net lower (I owe partner more)', () => {
  // Raw: partner=100, my=200 → rawNet=-100 (I owe partner 100).
  // Partner paid me 50 → they overpaid me → I now owe partner 150.
  const rows = [makeRow({ sumMy: 200, sumPartner: 100 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 50 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, -100);
  assert.equal(adj.settledAmount, -50);
  assert.equal(adj.net, -150);
  assert.equal(adj.direction, 'i_owe_partner');
  assert.equal(adj.settlementCount, 1);
});

test('applySettlements: partner_paid_me of exactly the raw debt zeroes out to even', () => {
  // Raw: rawNet=+100. Partner paid me 100 → fully settled → even.
  const rows = [makeRow({ sumMy: 0, sumPartner: 100 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 0, partnerPaid: 100 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settledAmount, -100);
  assert.equal(adj.net, 0);
  assert.equal(adj.direction, 'even');
});

test('applySettlements: orphan settlement with no matching row does NOT create a new row', () => {
  // The shared spend has no rows for contact 1 / CAD. A recorded settlement
  // for that contact should not surface as a new balance row — we only
  // adjust existing rows.
  const rows: RawPartnerRow[] = [];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 25, partnerPaid: 0 },
  ];
  const adjusted = applySettlements(rows, settlements);
  assert.equal(adjusted.length, 0);
});

test('applySettlements: settlement in a different currency does not adjust the row', () => {
  // Settlements are currency-scoped. A USD settlement does not touch a CAD
  // row even if it shares the same contact.
  const rows = [makeRow({ currency: 'CAD', sumMy: 100, sumPartner: 200 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'USD', iPaid: 50, partnerPaid: 0 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.net, 100);
  assert.equal(adj.rawNet, 100);
  assert.equal(adj.settlementCount, 0);
});

test('applySettlements: legacy row without ownershipContactId gets no adjustment', () => {
  // Settlements always carry a contactId, so legacy (non-contact) rows have
  // nothing to match against.
  const rows = [
    makeRow({ ownershipType: 'legacy', ownershipContactId: null, contactName: null, sumMy: 50, sumPartner: 100 }),
  ];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 999, partnerPaid: 0 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.settledAmount, 0);
  assert.equal(adj.settlementCount, 0);
  assert.equal(adj.net, 50);
});

test('applySettlements: both directions on same key collapse via signed sum', () => {
  // iPaid=80, partnerPaid=30 → settledAmount = 50 (net I overpaid).
  const rows = [makeRow({ sumMy: 0, sumPartner: 0 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 80, partnerPaid: 30 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.settledAmount, 50);
  assert.equal(adj.net, 50);
  assert.equal(adj.direction, 'partner_owes_me');
  // Both sides contributed → count both.
  assert.equal(adj.settlementCount, 2);
});

test('applySettlements: preserves rawNet alongside adjusted net', () => {
  const rows = [makeRow({ sumMy: 100, sumPartner: 250 })];
  const settlements: SettlementSummary[] = [
    { contactId: 1, currency: 'CAD', iPaid: 25, partnerPaid: 0 },
  ];
  const [adj] = applySettlements(rows, settlements);
  assert.equal(adj.rawNet, 150);
  assert.equal(adj.net, 175);
});
