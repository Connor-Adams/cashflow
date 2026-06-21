import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CfoBriefingActionItem } from './CfoBriefing';
import { updateCfoBriefingActionItemStatus } from '../routes/cfoBriefings';

/**
 * Pure unit test for the briefing action-item status update function.
 * Exercises the same code path the route uses for /resolve and /dismiss
 * without spinning up Express + DB.
 */

const items: CfoBriefingActionItem[] = [
  {
    id: 'forecast_warning-1',
    type: 'forecast_warning',
    refType: 'event',
    refId: 1,
    severity: 'watch',
    title: 'Rent overdue',
    summary: 'Planned rent has not posted',
    status: 'open',
  },
  {
    id: 'missing_receipt-42',
    type: 'missing_receipt',
    refType: 'transaction',
    refId: 42,
    severity: 'watch',
    title: 'Missing receipt',
    summary: 'Charge above threshold without receipt',
    status: 'open',
  },
];

test('updateCfoBriefingActionItemStatus flips an item to resolved', () => {
  const out = updateCfoBriefingActionItemStatus(items, 'forecast_warning-1', 'resolved');
  assert.ok(out.ok);
  if (!out.ok) return;
  const updated = out.items.find((i) => i.id === 'forecast_warning-1');
  assert.ok(updated);
  assert.equal(updated!.status, 'resolved');
  // The other item is untouched.
  const other = out.items.find((i) => i.id === 'missing_receipt-42');
  assert.equal(other?.status, 'open');
});

test('updateCfoBriefingActionItemStatus flips an item to dismissed', () => {
  const out = updateCfoBriefingActionItemStatus(items, 'missing_receipt-42', 'dismissed');
  assert.ok(out.ok);
  if (!out.ok) return;
  const updated = out.items.find((i) => i.id === 'missing_receipt-42');
  assert.equal(updated?.status, 'dismissed');
});

test('updateCfoBriefingActionItemStatus returns not-ok for unknown id', () => {
  const out = updateCfoBriefingActionItemStatus(items, 'unknown', 'resolved');
  assert.equal(out.ok, false);
});

test('updateCfoBriefingActionItemStatus rejects invalid status', () => {
  // 'completed' is not a valid item status — it's a run status. Verify the
  // function rejects it (defensive against route param tampering).
  const out = updateCfoBriefingActionItemStatus(
    items,
    'forecast_warning-1',
    // @ts-expect-error: testing runtime guard with an out-of-domain value
    'completed',
  );
  assert.equal(out.ok, false);
});

test('updateCfoBriefingActionItemStatus returns a new array (immutable)', () => {
  const out = updateCfoBriefingActionItemStatus(items, 'forecast_warning-1', 'resolved');
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.notEqual(out.items, items, 'must return a new array reference');
  assert.equal(items[0].status, 'open', 'must not mutate input array');
});
