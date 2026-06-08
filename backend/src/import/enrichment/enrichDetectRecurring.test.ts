import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectRecurringStage, type RecurringHistoryRow } from './detectRecurringStage';

function row(date: string, amount: number, category: string | null): RecurringHistoryRow {
  return { date, amount, finalCategory: category };
}

test('marks recurring when >=3 monthly-cadence same-amount priors exist', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Subscriptions'),
    row('2026-03-10', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.isRecurring, true);
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
});

test('no signal when fewer than minSupport priors', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-03-10', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 0);
});

test('no signal when amounts diverge beyond 5%', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Subscriptions'),
    row('2026-03-10', -19.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 0);
});

test('no signal when cadence is irregular (not monthly ± 5 days)', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Subscriptions'),
    row('2026-02-25', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals.length, 0);
});

test('picks modal category when priors disagree', () => {
  const history: RecurringHistoryRow[] = [
    row('2026-02-10', -14.99, 'Streaming'),
    row('2026-03-10', -14.99, 'Subscriptions'),
    row('2026-04-10', -14.99, 'Subscriptions'),
  ];
  const signals = runDetectRecurringStage({
    merchantClean: 'NETFLIX',
    amount: -14.99,
    date: '2026-05-10',
    history,
    minSupport: 3,
  });
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
});
