import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTransferNet } from './transferLedger';

test('nets sent minus received per currency', () => {
  const out = computeTransferNet([
    { amount: '-200.0000', currency: 'CAD' },
    { amount: '-350.0000', currency: 'CAD' },
    { amount: '70.0000', currency: 'CAD' },
    { amount: '-100.0000', currency: 'USD' },
  ]);
  assert.deepEqual(out, [
    { currency: 'CAD', sent: '550.0000', received: '70.0000', net: '480.0000' },
    { currency: 'USD', sent: '100.0000', received: '0.0000', net: '100.0000' },
  ]);
});
