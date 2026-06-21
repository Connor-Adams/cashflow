import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMerchantMemoryStage } from './merchantMemoryStage';
import type { MerchantMemoryMatch } from '../../ai/merchantMemory';

function mem(overrides: Partial<MerchantMemoryMatch> & { supportCount: number }): MerchantMemoryMatch {
  return {
    merchantClean: 'TEST',
    category: 'Dining',
    business: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    exampleTransactionIds: [1],
    matchedByAmount: false,
    ...overrides,
  };
}

test('high confidence when amount-bucketed match has supportCount >= 2', () => {
  const signals = runMerchantMemoryStage({
    memory: mem({
      merchantClean: 'APPLE',
      category: 'iCloud',
      supportCount: 3,
      matchedByAmount: true,
      exampleTransactionIds: [11, 12, 13],
    }),
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].source, 'memory');
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].fields.autoCategory, 'iCloud');
  assert.equal(signals[0].rationale?.includes('at similar amount'), true);
});

test('medium confidence when amount-bucketed match has only 1 prior', () => {
  const signals = runMerchantMemoryStage({
    memory: mem({
      merchantClean: 'APPLE',
      category: 'iCloud',
      supportCount: 1,
      matchedByAmount: true,
    }),
  });
  assert.equal(signals[0].confidence, 'medium');
});

test('medium confidence when any-amount modal has 2-3 priors (umbrella merchant safety)', () => {
  const signals = runMerchantMemoryStage({
    memory: mem({
      merchantClean: 'APPLE',
      category: 'Apps',
      supportCount: 3,
      matchedByAmount: false,
    }),
  });
  // Without amount-bucket evidence we keep this conservative so an
  // umbrella merchant doesn't claim high confidence from the modal alone.
  assert.equal(signals[0].confidence, 'medium');
});

test('high confidence when any-amount modal has >= 4 priors (clear single-category merchant)', () => {
  const signals = runMerchantMemoryStage({
    memory: mem({
      merchantClean: 'NETFLIX',
      category: 'Subscriptions',
      supportCount: 5,
      matchedByAmount: false,
    }),
  });
  assert.equal(signals[0].confidence, 'high');
  assert.equal(signals[0].rationale?.includes('across all amounts'), true);
});

test('no signal when memory is null', () => {
  const signals = runMerchantMemoryStage({ memory: null });
  assert.equal(signals.length, 0);
});
