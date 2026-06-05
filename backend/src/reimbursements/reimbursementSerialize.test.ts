/**
 * Unit tests for the reimbursement pure helpers (issue #216): validation,
 * effective-status / overdue derivation, serialization, and summary.
 * Pure module — no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMarkReimbursable,
  validateReimbursementPatch,
  computeEffectiveStatus,
  isOverdue,
  serializeReimbursement,
  summarize,
  normalizeAmount,
  daysUntilDue,
  type ReimbursementRow,
} from './serialize';

const TODAY = '2026-03-15';

// ---------- normalizeAmount ----------

test('normalizeAmount accepts positive numbers/strings, rejects junk', () => {
  assert.equal(normalizeAmount(12.5), '12.5000');
  assert.equal(normalizeAmount('1,234.50'), '1234.5000');
  assert.equal(normalizeAmount(0), undefined);
  assert.equal(normalizeAmount(-5), undefined);
  assert.equal(normalizeAmount('abc'), undefined);
  assert.equal(normalizeAmount(''), undefined);
});

// ---------- validateMarkReimbursable ----------

test('mark: defaults amount to abs(txn.amount) and currency to txn.currency', () => {
  const r = validateMarkReimbursable(
    { partyName: 'Alice' },
    { txnAmount: '-42.50', txnCurrency: 'cad' },
  );
  assert.ok(r.ok);
  assert.equal(r.value.amount, '42.5000');
  assert.equal(r.value.currency, 'CAD');
  assert.equal(r.value.partyName, 'Alice');
  assert.equal(r.value.contactId, null);
});

test('mark: explicit amount/currency override defaults', () => {
  const r = validateMarkReimbursable(
    { amount: '10', currency: 'usd', contactId: 7 },
    { txnAmount: '-42.50', txnCurrency: 'CAD' },
  );
  assert.ok(r.ok);
  assert.equal(r.value.amount, '10.0000');
  assert.equal(r.value.currency, 'USD');
  assert.equal(r.value.contactId, 7);
});

test('mark: requires a party (contactId or partyName)', () => {
  const r = validateMarkReimbursable(
    {},
    { txnAmount: '-42.50', txnCurrency: 'CAD' },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /party is required/);
});

test('mark: rejects invalid dueDate', () => {
  const r = validateMarkReimbursable(
    { partyName: 'Bob', dueDate: '2026-02-31' },
    { txnAmount: '-9', txnCurrency: 'CAD' },
  );
  assert.equal(r.ok, false);
});

test('mark: rejects when no amount derivable', () => {
  const r = validateMarkReimbursable(
    { partyName: 'Bob' },
    { txnAmount: '0', txnCurrency: 'CAD' },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /amount/);
});

// ---------- validateReimbursementPatch ----------

test('patch: only present keys returned; status validated', () => {
  const r = validateReimbursementPatch({ status: 'received', notes: 'paid' });
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value).sort(), ['notes', 'status']);
  assert.equal(r.value.status, 'received');
});

test('patch: rejects unknown status', () => {
  const r = validateReimbursementPatch({ status: 'bogus' });
  assert.equal(r.ok, false);
});

test('patch: cannot clear both party fields at once', () => {
  const r = validateReimbursementPatch({ contactId: null, partyName: null });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /party is required/);
});

test('patch: clearing one party field is allowed', () => {
  const r = validateReimbursementPatch({ contactId: null });
  assert.ok(r.ok);
  assert.equal(r.value.contactId, null);
});

// ---------- effective status / overdue ----------

test('overdue derived: expected + past due → overdue', () => {
  assert.equal(isOverdue({ status: 'expected', dueDate: '2026-03-14' }, TODAY), true);
  assert.equal(
    computeEffectiveStatus({ status: 'expected', dueDate: '2026-03-14' }, TODAY),
    'overdue',
  );
});

test('overdue NOT derived for future due date or non-expected status', () => {
  assert.equal(isOverdue({ status: 'expected', dueDate: '2026-03-20' }, TODAY), false);
  assert.equal(isOverdue({ status: 'received', dueDate: '2026-01-01' }, TODAY), false);
  assert.equal(isOverdue({ status: 'waived', dueDate: '2026-01-01' }, TODAY), false);
});

test('due date today is not yet overdue (strictly before)', () => {
  assert.equal(isOverdue({ status: 'expected', dueDate: TODAY }, TODAY), false);
});

test('daysUntilDue is negative when overdue, null when no due date', () => {
  assert.equal(daysUntilDue('2026-03-20', TODAY), 5);
  assert.equal(daysUntilDue('2026-03-10', TODAY), -5);
  assert.equal(daysUntilDue(null, TODAY), null);
});

// ---------- serialize ----------

function row(over: Partial<ReimbursementRow>): ReimbursementRow {
  return {
    id: 1,
    householdId: 1,
    transactionId: 100,
    contactId: null,
    partyName: 'Alice',
    amount: '50.0000',
    currency: 'CAD',
    dueDate: '2026-03-10',
    status: 'expected',
    repaymentTransactionId: null,
    receivedAt: null,
    notes: null,
    ...over,
  };
}

test('serialize derives partyLabel from contact, then partyName', () => {
  const withContact = serializeReimbursement(
    row({ contactId: 5, partyName: null, contact: { id: 5, name: 'Acme Insurance' } }),
    TODAY,
  );
  assert.equal(withContact.partyLabel, 'Acme Insurance');
  assert.equal(withContact.contactId, 5);

  const freeText = serializeReimbursement(row({ partyName: 'Alice' }), TODAY);
  assert.equal(freeText.partyLabel, 'Alice');
});

test('serialize surfaces effectiveStatus + isOverdue + daysUntilDue', () => {
  const v = serializeReimbursement(row({ dueDate: '2026-03-10' }), TODAY);
  assert.equal(v.status, 'expected');
  assert.equal(v.effectiveStatus, 'overdue');
  assert.equal(v.isOverdue, true);
  assert.equal(v.daysUntilDue, -5);
});

test('serialize includes nested transaction view when eager-loaded', () => {
  const v = serializeReimbursement(
    row({
      transaction: {
        id: 100,
        date: '2026-02-01',
        merchantClean: 'Dinner',
        amount: '-50.00',
        currency: 'CAD',
      },
    }),
    TODAY,
  );
  assert.equal(v.transaction?.id, 100);
  assert.equal(v.transaction?.merchant, 'Dinner');
});

// ---------- summarize ----------

test('summarize groups by party + currency and totals outstanding', () => {
  const rows: ReimbursementRow[] = [
    row({ id: 1, contactId: 5, partyName: null, contact: { id: 5, name: 'Acme' }, amount: '100.0000', currency: 'CAD', status: 'expected', dueDate: '2026-04-01' }),
    row({ id: 2, contactId: 5, partyName: null, contact: { id: 5, name: 'Acme' }, amount: '50.0000', currency: 'CAD', status: 'expected', dueDate: '2026-03-01' }), // overdue
    row({ id: 3, contactId: 5, partyName: null, contact: { id: 5, name: 'Acme' }, amount: '25.0000', currency: 'USD', status: 'expected', dueDate: '2026-04-01' }),
    row({ id: 4, partyName: 'Alice', amount: '10.0000', currency: 'CAD', status: 'received', dueDate: null, receivedAt: new Date() }),
  ];
  const s = summarize(rows, TODAY);

  // Acme/CAD groups rows 1+2: outstanding 150, one overdue.
  const acmeCad = s.groups.find((g) => g.contactId === 5 && g.currency === 'CAD');
  assert.ok(acmeCad);
  assert.equal(acmeCad!.outstanding, '150.0000');
  assert.equal(acmeCad!.counts.total, 2);
  assert.equal(acmeCad!.counts.overdue, 1);
  assert.equal(acmeCad!.counts.expected, 1);

  // Alice/CAD: received, not outstanding.
  const aliceCad = s.groups.find((g) => g.partyLabel === 'Alice');
  assert.ok(aliceCad);
  assert.equal(aliceCad!.outstanding, '0.0000');
  assert.equal(aliceCad!.received, '10.0000');

  // Currency rollups.
  assert.equal(s.outstandingByCurrency.CAD, '150.0000');
  assert.equal(s.outstandingByCurrency.USD, '25.0000');
  assert.equal(s.overdueCount, 1);
  assert.equal(s.totalCount, 4);
});

test('summarize sorts groups by outstanding desc', () => {
  const rows: ReimbursementRow[] = [
    row({ id: 1, partyName: 'Small', amount: '5.0000', currency: 'CAD', status: 'expected', dueDate: '2026-04-01' }),
    row({ id: 2, partyName: 'Big', amount: '500.0000', currency: 'CAD', status: 'expected', dueDate: '2026-04-01' }),
  ];
  const s = summarize(rows, TODAY);
  assert.equal(s.groups[0]?.partyLabel, 'Big');
  assert.equal(s.groups[1]?.partyLabel, 'Small');
});
