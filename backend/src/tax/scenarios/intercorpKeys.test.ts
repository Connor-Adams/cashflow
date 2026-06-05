// backend/test/tax/scenarios/intercorpKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { validateOverrideMap, getOverrideKey } from './overrideKeys';
import './corpOverrideKeys';
import type { CorpTaxYearFacts } from '../engine/types';

function emptyCorp(): CorpTaxYearFacts {
  return {
    fiscalYear: { startDate: '2025-01-01', endDate: '2025-12-31' },
    jurisdiction: 'CA-ON',
    activeBusinessIncome: [],
    investmentIncome: { interest: [], eligibleDividends: [], nonEligibleDividends: [], rentNet: [] },
    capitalGainEvents: [],
    dividendsPaid: [],
    salaryPaid: D('0'),
    carryforwards: { grip: D('0'), cda: D('0'), erdtoh: D('0'), nerdtoh: D('0'), nonCapLoss: D('0'), netCapitalLoss: D('0') },
  };
}

test('validateOverrideMap accepts intercorp.<id>.eligible on corp scenario', () => {
  validateOverrideMap({ 'intercorp.7.eligible': 80000 }, 'corp');
});

test('validateOverrideMap rejects intercorp keys on personal scenario', () => {
  assert.throws(
    () => validateOverrideMap({ 'intercorp.7.eligible': 80000 }, 'personal'),
    /corp scenarios/,
  );
});

test('validateOverrideMap rejects malformed intercorp key', () => {
  assert.throws(
    () => validateOverrideMap({ 'intercorp.7.unknownField': 100 }, 'corp'),
    /invalid intercorp key shape/i,
  );
});

test('getOverrideKey returns synthetic def for intercorp.<id>.eligible with kind=corp', () => {
  const entry = getOverrideKey('intercorp.42.eligible');
  assert.ok(entry);
  assert.equal(entry.kind, 'corp');
});

test('apply intercorp.<id>.eligible stamps onto corp facts intercorp map', () => {
  const entry = getOverrideKey('intercorp.42.eligible')!;
  entry.validate(80000);
  const result = entry.apply(emptyCorp() as unknown as never, 80000) as unknown as CorpTaxYearFacts & {
    intercorp?: Record<string, Record<string, ReturnType<typeof D>>>;
  };
  assert.equal(result.intercorp?.['42']?.eligible?.toFixed(2), '80000.00');
});

test('validateOverrideMap accepts intercorp.<id>.ownershipPercent on corp scenario', () => {
  validateOverrideMap({ 'intercorp.7.ownershipPercent': 75 }, 'corp');
});

test('apply intercorp.<id>.ownershipPercent stamps onto corp facts intercorp map', () => {
  const entry = getOverrideKey('intercorp.7.ownershipPercent')!;
  entry.validate(75);
  const result = entry.apply(emptyCorp() as unknown as never, 75) as unknown as CorpTaxYearFacts & {
    intercorp?: Record<string, Record<string, ReturnType<typeof D>>>;
  };
  assert.equal(result.intercorp?.['7']?.ownershipPercent?.toFixed(2), '75.00');
});
