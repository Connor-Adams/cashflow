import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { ratesFor } from './brackets';
import { taxableCapitalGains } from './capital-gains';
import type { CapGainEvent } from './types';

const ev = (g: number): CapGainEvent => ({
  source: 'test',
  securityId: 1,
  proceeds: D(g + 1000),
  acb: D('1000'),
  outlays: D('0'),
  date: '2024-06-01',
});

test('no events -> $0 taxable', () => {
  const r = ratesFor(2024);
  assert.equal(taxableCapitalGains([], r, D('0')).taxable.toFixed(2), '0.00');
});

test('single $2000 gain -> $1000 taxable (50% inclusion)', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(2000)], r, D('0'));
  assert.equal(result.taxable.toFixed(2), '1000.00');
});

test('gross gain $0 with carried-fwd net cap loss does not go negative', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([], r, D('500'));
  assert.equal(result.taxable.toFixed(2), '0.00');
  assert.equal(result.carryforwardRemaining.toFixed(2), '500.00');
});

test('gain $2000 with $400 carried loss: taxable = 1000 - 400 = 600', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(2000)], r, D('400'));
  assert.equal(result.taxable.toFixed(2), '600.00');
  assert.equal(result.carryforwardRemaining.toFixed(2), '0.00');
});
