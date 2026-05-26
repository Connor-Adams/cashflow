import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from '../../../src/tax/util/decimal';
import {
  intercorpRouter,
  type IntercorpDistributionInputs,
} from '../../../src/tax/scenarios/intercorpRouter';

test('no distributions → empty byReceiverEntityId, no warnings', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  assert.deepEqual(out.byReceiverEntityId, {});
  assert.equal(out.warnings.length, 0);
});

test('single A→B eligible dividend → B has 1 eligibleDividend item with correct source tag and amount', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 20,
        eligible: D('50000'),
        nonEligible: D('0'),
        capital: D('0'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  assert.equal(out.warnings.length, 0);
  const received = out.byReceiverEntityId[20];
  assert.ok(received, 'expected receiver 20 to have received-divs entry');
  assert.equal(received.eligibleDividends.length, 1);
  assert.equal(received.nonEligibleDividends.length, 0);
  assert.equal(received.capitalDividends.length, 0);
  assert.equal(received.eligibleDividends[0].source, 'intercorpRouter:from-corp-10:eligible');
  assert.equal(received.eligibleDividends[0].amount.toFixed(2), '50000.00');
  assert.equal(received.eligibleDividends[0].cadAmount.toFixed(2), '50000.00');
});

test('receiver not in plan → warning, no addition', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 99,
        eligible: D('30000'),
        nonEligible: D('0'),
        capital: D('0'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].severity, 'warning');
  assert.equal(out.warnings[0].payerCorpScenarioId, 100);
  assert.equal(out.warnings[0].receiverCorpEntityId, 99);
  assert.match(out.warnings[0].message, /receiver corp entity 99/);
  assert.equal(out.byReceiverEntityId[99], undefined);
  assert.deepEqual(out.byReceiverEntityId, {});
});

test('self-loop (corp paying to itself) → error severity warning, no addition', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 10,
        eligible: D('25000'),
        nonEligible: D('0'),
        capital: D('0'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].severity, 'error');
  assert.equal(out.warnings[0].payerCorpScenarioId, 100);
  assert.equal(out.warnings[0].receiverCorpEntityId, 10);
  assert.match(out.warnings[0].message, /cannot pay intercorp dividend to itself/);
  assert.equal(out.byReceiverEntityId[10], undefined);
  assert.deepEqual(out.byReceiverEntityId, {});
});

test('multi-type (eligible + nonEligible + capital from one payer) → all 3 arrays populated on receiver', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 20,
        eligible: D('40000'),
        nonEligible: D('15000'),
        capital: D('7500'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  assert.equal(out.warnings.length, 0);
  const received = out.byReceiverEntityId[20];
  assert.ok(received, 'expected receiver 20 to have received-divs entry');

  assert.equal(received.eligibleDividends.length, 1);
  assert.equal(received.eligibleDividends[0].source, 'intercorpRouter:from-corp-10:eligible');
  assert.equal(received.eligibleDividends[0].amount.toFixed(2), '40000.00');

  assert.equal(received.nonEligibleDividends.length, 1);
  assert.equal(received.nonEligibleDividends[0].source, 'intercorpRouter:from-corp-10:nonEligible');
  assert.equal(received.nonEligibleDividends[0].amount.toFixed(2), '15000.00');

  assert.equal(received.capitalDividends.length, 1);
  assert.equal(received.capitalDividends[0].source, 'intercorpRouter:from-corp-10:capital');
  assert.equal(received.capitalDividends[0].amount.toFixed(2), '7500.00');
});
