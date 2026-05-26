// backend/test/tax/scenarios/ownerCompKeys.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import { validateOverrideMap, getOverrideKey } from '../../../src/tax/scenarios/overrideKeys';
import '../../../src/tax/scenarios/corpOverrideKeys';
import type { CorpTaxYearFacts } from '../../../src/tax/engine/types';

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

test('validateOverrideMap accepts ownerComp.<id>.salary on corp scenario', () => {
  validateOverrideMap({ 'ownerComp.7.salary': 60000 }, 'corp');
});

test('validateOverrideMap rejects ownerComp keys on personal scenario', () => {
  assert.throws(
    () => validateOverrideMap({ 'ownerComp.7.salary': 60000 }, 'personal'),
    /corp scenarios/,
  );
});

test('validateOverrideMap rejects malformed ownerComp key', () => {
  assert.throws(
    () => validateOverrideMap({ 'ownerComp.7.unknownField': 100 }, 'corp'),
    /unknown override key|invalid ownerComp/i,
  );
});

test('getOverrideKey returns synthetic def for ownerComp.<id>.salary', () => {
  const entry = getOverrideKey('ownerComp.42.salary');
  assert.ok(entry);
  assert.equal(entry.kind, 'corp');
});

test('apply ownerComp.<id>.salary stores in corp facts ownerComp map', () => {
  const entry = getOverrideKey('ownerComp.42.salary')!;
  entry.validate(60000);
  const result = entry.apply(emptyCorp() as unknown as never, 60000) as unknown as CorpTaxYearFacts & {
    ownerComp?: Record<string, Record<string, ReturnType<typeof D>>>;
  };
  assert.equal(result.ownerComp?.['42']?.salary?.toFixed(2), '60000.00');
});
