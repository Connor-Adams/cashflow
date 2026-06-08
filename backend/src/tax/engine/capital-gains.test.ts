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

// --- Tiered inclusion (2024+): 50% up to $250K, 66.67% above ---

test('tiered: gains below $250K threshold → flat 50%', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(100000)], r, D('0'));
  assert.equal(result.taxable.toFixed(2), '50000.00');
});

test('tiered: gains at exactly $250K threshold → flat 50%', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(250000)], r, D('0'));
  assert.equal(result.taxable.toFixed(2), '125000.00');
});

test('tiered: gains $400K → first $250K at 50% + $150K at 66.67%', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(400000)], r, D('0'));
  // $250K × 0.5 = $125,000 + $150K × 0.666667 = $100,000.05
  assert.equal(result.taxable.toFixed(2), '225000.05');
});

test('tiered: gains $500K with $50K carryforward loss', () => {
  const r = ratesFor(2024);
  const result = taxableCapitalGains([ev(500000)], r, D('50000'));
  // $250K × 0.5 = $125,000 + $250K × 0.666667 = $166,666.75
  // total includable = $291,666.75, minus $50K loss = $241,666.75
  assert.equal(result.taxable.toFixed(2), '241666.75');
  assert.equal(result.carryforwardRemaining.toFixed(2), '0.00');
});

test('tiered: loss year still rolls forward correctly', () => {
  const r = ratesFor(2024);
  const lossEvent: CapGainEvent = {
    source: 'test', securityId: 1,
    proceeds: D('500'), acb: D('1000'), outlays: D('0'), date: '2024-06-01',
  };
  const result = taxableCapitalGains([lossEvent], r, D('200'));
  assert.equal(result.taxable.toFixed(2), '0.00');
  // $500 loss × 50% = $250 added to existing $200 carryforward
  assert.equal(result.carryforwardRemaining.toFixed(2), '450.00');
});

// --- Superficial loss rule (ITA 40(2)(g)) ---

test('superficial loss denied when same security repurchased within 30 days', () => {
  const r = ratesFor(2025);
  const events: CapGainEvent[] = [
    {
      source: 'XYZ sell',
      securityId: 100,
      proceeds: D('8000'),
      acb: D('10000'),
      outlays: D('0'),
      date: '2025-03-15',
      superficialLossDenied: D('2000'),
    },
  ];
  const result = taxableCapitalGains(events, r, D('0'));
  // Loss of $2000 fully denied → gross gain = 0, taxable = 0
  assert.equal(result.gross.toFixed(2), '0.00');
  assert.equal(result.taxable.toFixed(2), '0.00');
});

test('partial superficial loss denial', () => {
  const r = ratesFor(2025);
  const events: CapGainEvent[] = [
    {
      source: 'XYZ sell',
      securityId: 100,
      proceeds: D('8000'),
      acb: D('10000'),
      outlays: D('0'),
      date: '2025-03-15',
      superficialLossDenied: D('1500'),
    },
  ];
  const result = taxableCapitalGains(events, r, D('0'));
  // Loss = 2000, denied = 1500, allowable loss = 500
  // gross = -500, taxable = 0 (net loss)
  assert.equal(result.gross.toFixed(2), '-500.00');
  assert.equal(result.taxable.toFixed(2), '0.00');
});

test('no superficial loss flag means full loss allowed', () => {
  const r = ratesFor(2025);
  const events: CapGainEvent[] = [
    {
      source: 'XYZ sell',
      securityId: 100,
      proceeds: D('8000'),
      acb: D('10000'),
      outlays: D('0'),
      date: '2025-03-15',
    },
  ];
  const result = taxableCapitalGains(events, r, D('0'));
  assert.equal(result.gross.toFixed(2), '-2000.00');
});
