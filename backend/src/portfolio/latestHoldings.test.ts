import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestActivePositions } from './latestHoldings';

type Row = { accountId: number; securityId: number; statementDate: string; tag?: string };

// Input rows must be statementDate DESC, id DESC — mirror the DB ordering.
function row(accountId: number, securityId: number, statementDate: string, tag?: string): Row {
  return { accountId, securityId, statementDate, tag };
}

test('latestActivePositions: keeps the newest row per (account, security) pair', () => {
  const out = latestActivePositions([
    row(1, 10, '2026-02-28', 'feb'),
    row(1, 10, '2026-01-31', 'jan'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tag, 'feb');
});

test('latestActivePositions: drops a pair whose latest snapshot predates the account newest statement', () => {
  const out = latestActivePositions([
    row(1, 10, '2026-02-28', 'kept'),
    row(1, 10, '2026-01-31'),
    row(1, 20, '2026-01-31', 'sold'), // absent from the Feb statement
  ]);
  assert.deepEqual(
    out.map((r) => r.tag),
    ['kept'],
  );
});

test('latestActivePositions: newer statement on one account does not drop another account positions', () => {
  const out = latestActivePositions([
    row(2, 10, '2026-02-28', 'a2'),
    row(1, 10, '2026-01-31', 'a1'),
  ]);
  assert.equal(out.length, 2);
});

test('latestActivePositions: same-date duplicates resolve to the first row in input order (id DESC)', () => {
  const out = latestActivePositions([
    row(1, 10, '2026-01-31', 'newer-id'),
    row(1, 10, '2026-01-31', 'older-id'),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tag, 'newer-id');
});

test('latestActivePositions: empty input returns empty output', () => {
  assert.deepEqual(latestActivePositions([]), []);
});
