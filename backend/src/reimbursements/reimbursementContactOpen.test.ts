/**
 * Unit tests for `summarizeOpenForContact` (issue #374) — given a contact's
 * reimbursement rows, returns { count, byCurrency, items } where only the
 * effectively-open claims (expected or derived-overdue) contribute.
 *
 * The Contact detail view uses this aggregate to render
 * "Open reimbursements: $X across Y items".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeOpenForContact,
  type ReimbursementRow,
} from './serialize';

const TODAY = '2026-03-15';

function row(over: Partial<ReimbursementRow>): ReimbursementRow {
  return {
    id: 1,
    householdId: 1,
    transactionId: 1,
    contactId: 7,
    partyName: null,
    amount: '10.0000',
    currency: 'CAD',
    dueDate: null,
    status: 'expected',
    repaymentTransactionId: null,
    receivedAt: null,
    notes: null,
    createdAt: null,
    updatedAt: null,
    contact: { id: 7, name: 'Test' },
    transaction: null,
    repaymentTransaction: null,
    ...over,
  };
}

test('summarizeOpenForContact: counts only open claims', () => {
  const rows: ReimbursementRow[] = [
    row({ id: 1, status: 'expected', amount: '20.0000', currency: 'CAD' }),
    row({ id: 2, status: 'received', amount: '50.0000', currency: 'CAD' }),
    row({ id: 3, status: 'waived', amount: '5.0000', currency: 'CAD' }),
    row({
      id: 4,
      status: 'expected',
      amount: '30.0000',
      currency: 'CAD',
      dueDate: '2026-01-01', // overdue (today=2026-03-15)
    }),
  ];
  const out = summarizeOpenForContact(rows, TODAY);
  assert.equal(out.count, 2);
  assert.equal(out.byCurrency.CAD, '50.0000');
  // Items are open only — no received/waived in the list.
  assert.equal(out.items.length, 2);
  const ids = out.items.map((i) => i.id).sort();
  assert.deepEqual(ids, [1, 4]);
});

test('summarizeOpenForContact: groups outstanding by currency', () => {
  const rows: ReimbursementRow[] = [
    row({ id: 1, status: 'expected', amount: '10.0000', currency: 'CAD' }),
    row({ id: 2, status: 'expected', amount: '15.5000', currency: 'CAD' }),
    row({ id: 3, status: 'expected', amount: '40.0000', currency: 'USD' }),
  ];
  const out = summarizeOpenForContact(rows, TODAY);
  assert.equal(out.count, 3);
  assert.equal(out.byCurrency.CAD, '25.5000');
  assert.equal(out.byCurrency.USD, '40.0000');
});

test('summarizeOpenForContact: empty input -> zero aggregate', () => {
  const out = summarizeOpenForContact([], TODAY);
  assert.equal(out.count, 0);
  assert.deepEqual(out.byCurrency, {});
  assert.deepEqual(out.items, []);
});

test('summarizeOpenForContact: explicitly pinned overdue status counts as open', () => {
  // status='overdue' (pinned, no due date) is also "open" — money still
  // outstanding.
  const rows: ReimbursementRow[] = [
    row({ id: 1, status: 'overdue', amount: '99.0000' }),
  ];
  const out = summarizeOpenForContact(rows, TODAY);
  assert.equal(out.count, 1);
  assert.equal(out.byCurrency.CAD, '99.0000');
});
