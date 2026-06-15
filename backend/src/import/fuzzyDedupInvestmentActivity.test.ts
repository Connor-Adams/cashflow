import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickFuzzyMatch,
  dedupEquivalentActivityTypes,
  type DedupCandidate,
} from './fuzzyDedupInvestmentActivity';

function candidate(p: Partial<DedupCandidate>): DedupCandidate {
  return {
    id: 1,
    quantity: null,
    amount: null,
    settlementDate: null,
    security: null,
    ...p,
  };
}

test('zero candidates: no-match', () => {
  const out = pickFuzzyMatch([], {
    symbol: 'AAPL',
    quantity: 1,
    amount: -100,
  });
  assert.equal(out.kind, 'no-match');
});

test('single exact match: single-match, backfill when settlement NULL', () => {
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 7,
        quantity: '0.00320000',
        amount: '-0.2500',
        settlementDate: null,
        security: { symbol: 'DOO' },
      }),
    ],
    { symbol: 'DOO', quantity: 0.0032, amount: -0.25 },
  );
  assert.equal(out.kind, 'single-match');
  if (out.kind !== 'single-match') return;
  assert.equal(out.existing.id, 7);
  assert.equal(out.backfillSettlement, true);
});

test('single match with settlement already populated: no backfill flag', () => {
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 9,
        quantity: '2.00000000',
        amount: '-285.3000',
        settlementDate: '2026-04-17',
        security: { symbol: 'TD' },
      }),
    ],
    { symbol: 'TD', quantity: 2, amount: -285.3 },
  );
  assert.equal(out.kind, 'single-match');
  if (out.kind !== 'single-match') return;
  assert.equal(out.backfillSettlement, false);
});

test('symbol mismatch: filtered out', () => {
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: '1.00000000',
        amount: '-100.0000',
        security: { symbol: 'XEQT' },
      }),
    ],
    { symbol: 'VFV', quantity: 1, amount: -100 },
  );
  assert.equal(out.kind, 'no-match');
});

test('quantity mismatch at 8th decimal: filtered out', () => {
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: '0.00050000',
        amount: '-1.0000',
        security: { symbol: 'DOT' },
      }),
    ],
    { symbol: 'DOT', quantity: 0.0005009, amount: -1 },
  );
  assert.equal(out.kind, 'no-match');
});

test('quantity match across precision (10dp CSV vs 8dp DB)', () => {
  // CSV has 10 decimals; DB truncates to 8. Both should normalize to 8 and match.
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: '0.00050093',
        amount: '0.0007',
        security: { symbol: 'DOT' },
      }),
    ],
    { symbol: 'DOT', quantity: 0.0005009278, amount: 0.0007 },
  );
  assert.equal(out.kind, 'single-match');
});

test('amount mismatch by 1 cent: filtered out (price-sensitive collision avoidance)', () => {
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: '1.00000000',
        amount: '-100.0000',
        security: { symbol: 'XEQT' },
      }),
    ],
    { symbol: 'XEQT', quantity: 1, amount: -100.01 },
  );
  assert.equal(out.kind, 'no-match');
});

test('multi-match: 2 candidates with identical qty + amount + symbol', () => {
  // Real-world hazard: two DCA buys at exactly the same price + share count
  // within the date window. Must NOT auto-decide.
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: '0.50000000',
        amount: '-20.0000',
        security: { symbol: 'XEQT' },
      }),
      candidate({
        id: 2,
        quantity: '0.50000000',
        amount: '-20.0000',
        security: { symbol: 'XEQT' },
      }),
    ],
    { symbol: 'XEQT', quantity: 0.5, amount: -20 },
  );
  assert.equal(out.kind, 'multi-match');
  if (out.kind !== 'multi-match') return;
  assert.equal(out.candidates.length, 2);
});

test('Interest with null symbol matches candidate with null symbol', () => {
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: '2.04000000',
        amount: '2.0400',
        security: null,
      }),
    ],
    { symbol: null, quantity: 2.04, amount: 2.04 },
  );
  assert.equal(out.kind, 'single-match');
});

test('Dividend with null quantity matches candidate with null quantity', () => {
  // Old parser stores dividend rows with quantity=NULL (no share count in description).
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: null,
        amount: '0.2500',
        security: { symbol: 'DOO' },
      }),
    ],
    { symbol: 'DOO', quantity: null, amount: 0.25 },
  );
  assert.equal(out.kind, 'single-match');
});

test('Incoming has quantity, candidate has null quantity: NO match (would mask different events)', () => {
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: null,
        amount: '0.2500',
        security: { symbol: 'DOO' },
      }),
    ],
    { symbol: 'DOO', quantity: 1, amount: 0.25 },
  );
  assert.equal(out.kind, 'no-match');
});

test('excludeIds: an already-consumed candidate is invisible to later rows', () => {
  const pool = [
    candidate({
      id: 1,
      quantity: '0.50000000',
      amount: '-20.0000',
      security: { symbol: 'XEQT' },
    }),
  ];
  const input = { symbol: 'XEQT', quantity: 0.5, amount: -20 };
  // First row of the commit consumes candidate 1…
  assert.equal(pickFuzzyMatch(pool, input).kind, 'single-match');
  // …so the second identical row must NOT match it again.
  const out = pickFuzzyMatch(pool, { ...input, excludeIds: new Set([1]) });
  assert.equal(out.kind, 'no-match');
});

test('excludeIds: exclusion can demote a multi-match to a single-match', () => {
  const pool = [
    candidate({
      id: 1,
      quantity: '0.50000000',
      amount: '-20.0000',
      security: { symbol: 'XEQT' },
    }),
    candidate({
      id: 2,
      quantity: '0.50000000',
      amount: '-20.0000',
      security: { symbol: 'XEQT' },
    }),
  ];
  const out = pickFuzzyMatch(pool, {
    symbol: 'XEQT',
    quantity: 0.5,
    amount: -20,
    excludeIds: new Set([1]),
  });
  assert.equal(out.kind, 'single-match');
  if (out.kind !== 'single-match') return;
  assert.equal(out.existing.id, 2);
});

test('dedupEquivalentActivityTypes folds CSV transfer ↔ PDF transfer_in/transfer_out', () => {
  // The WS activities-CSV stores SecurityTransfer as undirected 'transfer';
  // the WS PDF stores it directionally. All three must query the same bucket
  // so a re-import matches across sources instead of double-counting.
  const want = ['transfer', 'transfer_in', 'transfer_out'];
  assert.deepEqual([...dedupEquivalentActivityTypes('transfer')].sort(), [...want].sort());
  assert.deepEqual([...dedupEquivalentActivityTypes('transfer_in')].sort(), [...want].sort());
  assert.deepEqual([...dedupEquivalentActivityTypes('transfer_out')].sort(), [...want].sort());
});

test('dedupEquivalentActivityTypes leaves non-transfer types exact (no over-folding)', () => {
  assert.deepEqual(dedupEquivalentActivityTypes('buy'), ['buy']);
  assert.deepEqual(dedupEquivalentActivityTypes('dividend'), ['dividend']);
  assert.deepEqual(dedupEquivalentActivityTypes('cash_movement'), ['cash_movement']);
});

test('Incoming null quantity, candidate has quantity: NO match', () => {
  // CSV's quantity column populated only for trades/staking. Old parser may
  // have stored qty for some flavours but not others. Asymmetric null → reject.
  const out = pickFuzzyMatch(
    [
      candidate({
        id: 1,
        quantity: '1.00000000',
        amount: '0.2500',
        security: { symbol: 'DOO' },
      }),
    ],
    { symbol: 'DOO', quantity: null, amount: 0.25 },
  );
  assert.equal(out.kind, 'no-match');
});
