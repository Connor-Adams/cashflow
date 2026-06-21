import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { quarterlyInstalments } from './instalments';

test('instalments split tax owing into 4 equal payments', () => {
  const result = quarterlyInstalments(D('12000'));
  assert.equal(result.length, 4);
  assert.equal(result[0].amount.toFixed(2), '3000.00');
  assert.equal(result[3].dueOn.slice(5), '12-15');
});

test('instalments $0 owing returns 4 zero payments', () => {
  const result = quarterlyInstalments(D('0'));
  assert.equal(result.reduce((s, p) => s + p.amount.toNumber(), 0), 0);
});
