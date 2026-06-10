import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAmazonOrder } from './normalizeAmazonOrder';

function dateOf(value: string): string | null {
  return normalizeAmazonOrder({
    source: 'manual',
    orderDate: value,
    items: [{ title: 'Widget' }],
  }).orderDate ?? null;
}

test('normalizeDate treats a first component > 12 as day-first', () => {
  assert.equal(dateOf('31/12/2024'), '2024-12-31');
  assert.equal(dateOf('13-05-2026'), '2026-05-13');
  assert.equal(dateOf('31/12/24'), '2024-12-31');
});

test('normalizeDate rejects impossible calendar dates instead of emitting them', () => {
  // Previously emitted invalid ISO-shaped strings like '2024-31-02'.
  assert.equal(dateOf('31/02/2024'), null);
  assert.equal(dateOf('13/13/2026'), null);
});

test('normalizeDate keeps ISO and unambiguous inputs unchanged', () => {
  assert.equal(dateOf('2026-01-25'), '2026-01-25');
  assert.equal(dateOf('2026-01-25T16:01:44Z'), '2026-01-25');
});
