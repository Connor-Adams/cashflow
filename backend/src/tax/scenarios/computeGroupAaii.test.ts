import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import { computeGroupAaii } from './computeGroupAaii';
import { ratesFor } from '../engine/brackets';
import type { CorpTaxYearFacts } from '../engine/types';
import type { Entity } from '../../models';

const r = ratesFor(2024);

function baseFacts(): CorpTaxYearFacts {
  return {
    fiscalYear: { startDate: '2024-01-01', endDate: '2024-12-31' },
    jurisdiction: 'CA-ON',
    activeBusinessIncome: [],
    investmentIncome: {
      interest: [],
      eligibleDividends: [],
      nonEligibleDividends: [],
      rentNet: [],
    },
    capitalGainEvents: [],
    dividendsPaid: [],
    salaryPaid: D('0'),
    carryforwards: {
      grip: D('0'),
      cda: D('0'),
      erdtoh: D('0'),
      nerdtoh: D('0'),
      nonCapLoss: D('0'),
      netCapitalLoss: D('0'),
    },
  };
}

function withInterest(amount: string): CorpTaxYearFacts {
  return {
    ...baseFacts(),
    investmentIncome: {
      ...baseFacts().investmentIncome,
      interest: [{ source: 'GIC', amount: D(amount), cadAmount: D(amount) }],
    },
  };
}

/** Minimal stub matching the shape `computeGroupAaii` reads (`associatedGroupId`). */
function stubEntity(id: number, associatedGroupId: string | null): Entity {
  return { id, associatedGroupId } as unknown as Entity;
}

test('no corp with a groupId → empty map', () => {
  const corpFacts = new Map<number, CorpTaxYearFacts>([
    [1, withInterest('10000')],
    [2, withInterest('20000')],
  ]);
  const entities = new Map<number, Entity>([
    [1, stubEntity(1, null)],
    [2, stubEntity(2, null)],
  ]);
  const out = computeGroupAaii(corpFacts, entities, r);
  assert.equal(out.size, 0);
});

test('two corps sharing the same groupId → AAII summed under that key', () => {
  const corpFacts = new Map<number, CorpTaxYearFacts>([
    [1, withInterest('10000')],
    [2, withInterest('25000')],
  ]);
  const entities = new Map<number, Entity>([
    [1, stubEntity(1, 'opco-holdco-group')],
    [2, stubEntity(2, 'opco-holdco-group')],
  ]);
  const out = computeGroupAaii(corpFacts, entities, r);
  assert.equal(out.size, 1);
  assert.equal(out.get('opco-holdco-group')?.toFixed(2), '35000.00');
});

test('two corps with different groupIds → separate sums in result map', () => {
  const corpFacts = new Map<number, CorpTaxYearFacts>([
    [1, withInterest('12000')],
    [2, withInterest('40000')],
  ]);
  const entities = new Map<number, Entity>([
    [1, stubEntity(1, 'group-a')],
    [2, stubEntity(2, 'group-b')],
  ]);
  const out = computeGroupAaii(corpFacts, entities, r);
  assert.equal(out.size, 2);
  assert.equal(out.get('group-a')?.toFixed(2), '12000.00');
  assert.equal(out.get('group-b')?.toFixed(2), '40000.00');
});

test('corp with null groupId is not added to any group key', () => {
  const corpFacts = new Map<number, CorpTaxYearFacts>([
    [1, withInterest('15000')],
    [2, withInterest('30000')],
  ]);
  const entities = new Map<number, Entity>([
    [1, stubEntity(1, 'group-a')],
    [2, stubEntity(2, null)],
  ]);
  const out = computeGroupAaii(corpFacts, entities, r);
  assert.equal(out.size, 1);
  assert.equal(out.get('group-a')?.toFixed(2), '15000.00');
  assert.equal(out.has(''), false);
  // entity 2's $30k AAII does not surface anywhere in the result.
  for (const v of out.values()) {
    assert.notEqual(v.toFixed(2), '30000.00');
    assert.notEqual(v.toFixed(2), '45000.00');
  }
});
