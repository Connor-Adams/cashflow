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
        ownershipPercent: D('100'),
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
        ownershipPercent: D('100'),
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
        ownershipPercent: D('100'),
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
        ownershipPercent: D('100'),
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

test('P11b T6: gripBoost = eligible × 100% on single 100%-owned payer (sole-shareholder holdco)', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 20,
        eligible: D('50000'),
        nonEligible: D('0'),
        capital: D('0'),
        ownershipPercent: D('100'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  const received = out.byReceiverEntityId[20];
  assert.ok(received, 'expected receiver 20 to have received-divs entry');
  // 50000 × 100/100 = 50000
  assert.equal(received.gripBoost.toFixed(2), '50000.00');
});

test('P11b T6: gripBoost = eligible × ownership% on partial-ownership payer', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 20,
        eligible: D('40000'),
        nonEligible: D('0'),
        capital: D('0'),
        ownershipPercent: D('75'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  const received = out.byReceiverEntityId[20];
  assert.ok(received, 'expected receiver 20 to have received-divs entry');
  // 40000 × 75/100 = 30000
  assert.equal(received.gripBoost.toFixed(2), '30000.00');
  // Eligible dividend still recorded at full $40k (taxable to receiver); only
  // GRIP designation is grossed by ownership%.
  assert.equal(received.eligibleDividends[0].cadAmount.toFixed(2), '40000.00');
});

test('P11b T6: gripBoost aggregates across multiple payers on same receiver', () => {
  // Scenario: receiver corp C is owned 100% by A and 50% by B (e.g. A is C's
  // parent; B is a fellow-subsidiary holding C-shares). Both pay eligible divs.
  //   from A: 50000 × 100/100 = 50000
  //   from B: 20000 × 50/100  = 10000
  //   total gripBoost on C   = 60000
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 30,
        eligible: D('50000'),
        nonEligible: D('0'),
        capital: D('0'),
        ownershipPercent: D('100'),
      },
      {
        payerCorpScenarioId: 101,
        payerCorpEntityId: 20,
        receiverCorpEntityId: 30,
        eligible: D('20000'),
        nonEligible: D('0'),
        capital: D('0'),
        ownershipPercent: D('50'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20, 30]),
  };
  const out = intercorpRouter(inputs);
  const received = out.byReceiverEntityId[30];
  assert.ok(received, 'expected receiver 30 to have received-divs entry');
  // Both payers appear with their full eligible amounts on the receiver.
  assert.equal(received.eligibleDividends.length, 2);
  // Sum of (eligible × ownership%/100) = 50000 + 10000 = 60000
  assert.equal(received.gripBoost.toFixed(2), '60000.00');
});

test('P11b T6: zero eligible → gripBoost stays 0 even with non-zero ownership%', () => {
  const inputs: IntercorpDistributionInputs = {
    distributions: [
      {
        payerCorpScenarioId: 100,
        payerCorpEntityId: 10,
        receiverCorpEntityId: 20,
        eligible: D('0'),
        nonEligible: D('30000'),
        capital: D('0'),
        ownershipPercent: D('100'),
      },
    ],
    corpEntityIdsInPlan: new Set<number>([10, 20]),
  };
  const out = intercorpRouter(inputs);
  const received = out.byReceiverEntityId[20];
  assert.ok(received, 'expected receiver 20 to have received-divs entry');
  assert.equal(received.gripBoost.toFixed(2), '0.00');
});
