import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../util/decimal';
import {
  integrationRouter,
  type CorpDistributionInputs,
} from './integrationRouter';

test('salary routes to employment income, marks CPP enrolment', () => {
  const inputs: CorpDistributionInputs = {
    corpReturns: [
      {
        corpScenarioId: 1,
        gripEnding: D('0'),
        cdaEnding: D('0'),
        retainedEarningsAfter: D('300000'),
      },
    ],
    ownerCompPlans: [
      {
        corpScenarioId: 1,
        shareholderEntityId: 42,
        salary: D('60000'),
        bonus: D('0'),
        eligibleDividend: D('0'),
        nonEligibleDividend: D('0'),
        capitalDividend: D('0'),
      },
    ],
  };
  const out = integrationRouter(inputs);
  assert.equal(out.byShareholder[42].employmentIncome.toFixed(2), '60000.00');
  assert.equal(out.byShareholder[42].cppEnrolled, true);
  assert.equal(out.warnings.length, 0);
});

test('eligible dividend <= GRIP balance is allowed; > GRIP emits warning', () => {
  const ok: CorpDistributionInputs = {
    corpReturns: [
      {
        corpScenarioId: 1,
        gripEnding: D('100000'),
        cdaEnding: D('0'),
        retainedEarningsAfter: D('200000'),
      },
    ],
    ownerCompPlans: [
      {
        corpScenarioId: 1,
        shareholderEntityId: 42,
        salary: D('0'),
        bonus: D('0'),
        eligibleDividend: D('80000'),
        nonEligibleDividend: D('0'),
        capitalDividend: D('0'),
      },
    ],
  };
  assert.equal(integrationRouter(ok).warnings.length, 0);

  const overdraw: CorpDistributionInputs = {
    corpReturns: [
      {
        corpScenarioId: 1,
        gripEnding: D('100000'),
        cdaEnding: D('0'),
        retainedEarningsAfter: D('200000'),
      },
    ],
    ownerCompPlans: [
      {
        corpScenarioId: 1,
        shareholderEntityId: 42,
        salary: D('0'),
        bonus: D('0'),
        eligibleDividend: D('150000'),
        nonEligibleDividend: D('0'),
        capitalDividend: D('0'),
      },
    ],
  };
  const out = integrationRouter(overdraw);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].message, /GRIP/);
});

test('capital dividend <= CDA is tax-free pass-through; > CDA warns', () => {
  const out = integrationRouter({
    corpReturns: [
      {
        corpScenarioId: 1,
        gripEnding: D('0'),
        cdaEnding: D('5000'),
        retainedEarningsAfter: D('100000'),
      },
    ],
    ownerCompPlans: [
      {
        corpScenarioId: 1,
        shareholderEntityId: 42,
        salary: D('0'),
        bonus: D('0'),
        eligibleDividend: D('0'),
        nonEligibleDividend: D('0'),
        capitalDividend: D('10000'),
      },
    ],
  });
  assert.equal(out.byShareholder[42].capitalDividendsReceived.toFixed(2), '10000.00');
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0].message, /CDA/);
});

test('multiple shareholders aggregated separately', () => {
  const out = integrationRouter({
    corpReturns: [
      {
        corpScenarioId: 1,
        gripEnding: D('0'),
        cdaEnding: D('0'),
        retainedEarningsAfter: D('300000'),
      },
    ],
    ownerCompPlans: [
      {
        corpScenarioId: 1,
        shareholderEntityId: 1,
        salary: D('40000'),
        bonus: D('0'),
        eligibleDividend: D('0'),
        nonEligibleDividend: D('0'),
        capitalDividend: D('0'),
      },
      {
        corpScenarioId: 1,
        shareholderEntityId: 2,
        salary: D('60000'),
        bonus: D('5000'),
        eligibleDividend: D('0'),
        nonEligibleDividend: D('0'),
        capitalDividend: D('0'),
      },
    ],
  });
  assert.equal(out.byShareholder[1].employmentIncome.toFixed(2), '40000.00');
  assert.equal(out.byShareholder[2].employmentIncome.toFixed(2), '65000.00');
});

test('non-eligible dividend always allowed (no balance constraint)', () => {
  const out = integrationRouter({
    corpReturns: [
      {
        corpScenarioId: 1,
        gripEnding: D('0'),
        cdaEnding: D('0'),
        retainedEarningsAfter: D('200000'),
      },
    ],
    ownerCompPlans: [
      {
        corpScenarioId: 1,
        shareholderEntityId: 1,
        salary: D('0'),
        bonus: D('0'),
        eligibleDividend: D('0'),
        nonEligibleDividend: D('80000'),
        capitalDividend: D('0'),
      },
    ],
  });
  assert.equal(out.byShareholder[1].nonEligibleDividends.toFixed(2), '80000.00');
  assert.equal(out.warnings.length, 0);
});
