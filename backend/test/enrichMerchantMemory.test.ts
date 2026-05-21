import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMerchantMemoryStage } from '../src/import/enrichment/merchantMemoryStage';

test('high confidence when supportCount >= 2', () => {
  const signals = runMerchantMemoryStage({
    memory: {
      merchantClean: 'NETFLIX',
      category: 'Subscriptions',
      business: false,
      splitType: 'shared',
      pctMe: '0.5',
      pctPartner: '0.5',
      supportCount: 4,
      exampleTransactionIds: [11, 12, 13, 14],
    },
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'memory');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.autoCategory, 'Subscriptions');
  assert.equal(signals[0].rationale?.includes('4'), true);
});

test('medium confidence when supportCount = 1', () => {
  const signals = runMerchantMemoryStage({
    memory: {
      merchantClean: 'JOE COFFEE',
      category: 'Dining',
      business: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      supportCount: 1,
      exampleTransactionIds: [99],
    },
  });
  assert.equal(signals[0].confidence, 'medium');
});

test('no signal when memory is null', () => {
  const signals = runMerchantMemoryStage({ memory: null });
  assert.equal(signals.length, 0);
});
