/**
 * Reports (`/api/summary/partner` → partnerMath.applySettlements) and Partner
 * Fairness (`/api/partner/fairness` → partnerFairness.buildFairnessByContact)
 * must report the same outstanding partner balance for the same data. Both
 * attribute splits with `partnerMath.attributeSplitContact`; this pins that
 * the totals agree, including when settlements cannot be matched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySettlements,
  resolveSolePartnerId,
  summarizeSettlements,
  type RawPartnerRow,
  type RawSettlementRow,
} from './partnerMath';
import { buildFairnessByContact, type SharedTxnRow } from './partnerFairness';

function txn(p: Partial<SharedTxnRow>): SharedTxnRow {
  return {
    date: '2026-03-01', currency: 'CAD', category: null, merchant: 'm',
    amount: -100, myShare: -50, partnerShare: -50, txnId: 1,
    ownershipType: 'partner', ownershipContactId: null, contactName: null,
    counterpartyContactId: null, payerUserId: null, ...p,
  };
}

/** Mirror the Reports SQL: GROUP BY currency, ownershipType, ownershipContactId. */
function reportsRows(rows: SharedTxnRow[]): RawPartnerRow[] {
  const byKey = new Map<string, RawPartnerRow>();
  for (const r of rows) {
    const key = `${r.currency}\0${r.ownershipType}\0${r.ownershipContactId}`;
    const acc = byKey.get(key) ?? {
      currency: r.currency, ownershipType: r.ownershipType,
      ownershipContactId: r.ownershipContactId, contactName: null, sumMy: 0, sumPartner: 0,
    };
    acc.sumMy = (acc.sumMy ?? 0) + r.myShare;
    acc.sumPartner = (acc.sumPartner ?? 0) + r.partnerShare;
    byKey.set(key, acc);
  }
  return [...byKey.values()];
}

function totals(rows: SharedTxnRow[], settlementRows: RawSettlementRow[], partnerIds: number[]) {
  const summaries = summarizeSettlements(settlementRows);
  const reports = applySettlements(reportsRows(rows), summaries, {
    solePartnerId: resolveSolePartnerId(partnerIds),
  });
  const reportsTotal =
    reports.byCurrency.reduce((s, r) => s + r.net, 0) +
    reports.unmatchedSettlements.reduce((s, u) => s + u.settledAmount, 0);
  const fairness = buildFairnessByContact(
    rows, summaries, [], '2026-03-01', '2026-04-01',
    { partnerContactIds: new Set(partnerIds) },
  );
  const fairnessTotal = fairness.reduce(
    (s, c) => s + c.byCurrency.reduce((t, b) => t + b.balance, 0),
    0,
  );
  return { reports, reportsTotal, fairnessTotal };
}

const rows = [
  txn({ txnId: 1, ownershipType: 'partner', partnerShare: -60, myShare: -40 }),
  txn({ txnId: 2, ownershipType: 'shared', partnerShare: -50, myShare: -50 }),
  txn({ txnId: 3, ownershipType: 'me', partnerShare: 0, myShare: -500, amount: -500 }),
];
const settlementRows: RawSettlementRow[] = [
  { contactId: 7, currency: 'CAD', direction: 'partner_paid_me', amount: '80' },
  { contactId: 7, currency: 'CAD', direction: 'partner_paid_me', amount: '20' },
];

test('one partner: Reports and Fairness agree and the settlement lands', () => {
  const { reports, reportsTotal, fairnessTotal } = totals(rows, settlementRows, [7]);
  assert.equal(reportsTotal, 10);
  assert.equal(fairnessTotal, 10);
  assert.deepEqual(reports.unmatchedSettlements, []);
  const partnerRow = reports.byCurrency.find((r) => r.ownershipContactId === 7);
  assert.equal(partnerRow?.settlementCount, 2);
});

test('two partners: unstamped splits stay unassigned, settlements are surfaced, totals still agree', () => {
  const { reports, reportsTotal, fairnessTotal } = totals(rows, settlementRows, [7, 9]);
  assert.equal(reportsTotal, 10);
  assert.equal(fairnessTotal, 10);
  assert.equal(reports.unmatchedSettlements.length, 1);
  assert.equal(reports.unmatchedSettlements[0].settlementCount, 2);
});
