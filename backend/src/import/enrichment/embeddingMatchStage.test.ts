import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runEmbeddingMatchStage,
  bestEmbeddingMatch,
  similarityToConfidence,
  type PriorEmbedding,
} from './embeddingMatchStage';
import type { HouseholdMerchant } from '../../ai/merchantEmbeddings';

function merchant(over: Partial<HouseholdMerchant> = {}): HouseholdMerchant {
  return {
    merchantClean: 'Blue Bottle Coffee',
    category: 'Coffee',
    business: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    supportCount: 3,
    ...over,
  };
}

function prior(vector: number[], over: Partial<HouseholdMerchant> = {}): PriorEmbedding {
  return { merchant: merchant(over), vector };
}

// Unit vectors so cosine similarity is exactly the dot product — lets the tests
// pin a precise similarity value.
const V_COFFEE = [1, 0, 0];
const V_NEAR_COFFEE = [0.95, Math.sqrt(1 - 0.95 * 0.95), 0]; // cos with V_COFFEE = 0.95
const V_FAR = [0, 1, 0]; // cos with V_COFFEE = 0

test('above-threshold cold row emits an embedding signal with category, rationale, confidence', () => {
  const signals = runEmbeddingMatchStage({
    rowVector: V_NEAR_COFFEE,
    priors: [prior(V_COFFEE, { merchantClean: 'Blue Bottle Coffee', category: 'Coffee' })],
    threshold: 0.85,
  });
  assert.equal(signals.length, 1);
  const s = signals[0];
  assert.equal(s.source, 'embedding');
  assert.equal(s.fields.autoCategory, 'Coffee');
  assert.ok(s.rationale && s.rationale.includes('Blue Bottle Coffee'), 'rationale names matched merchant');
  assert.ok(['high', 'medium'].includes(s.confidence), 'records a confidence value');
});

test('below-threshold cold row emits no signal', () => {
  const signals = runEmbeddingMatchStage({
    rowVector: V_FAR,
    priors: [prior(V_COFFEE)],
    threshold: 0.85,
  });
  assert.equal(signals.length, 0);
});

test('threshold is inclusive: similarity exactly at threshold matches', () => {
  // V_NEAR_COFFEE · V_COFFEE = 0.95 exactly.
  const atThreshold = runEmbeddingMatchStage({
    rowVector: V_NEAR_COFFEE,
    priors: [prior(V_COFFEE)],
    threshold: 0.95,
  });
  assert.equal(atThreshold.length, 1, '>= threshold is a match (boundary inclusive)');

  const justAbove = runEmbeddingMatchStage({
    rowVector: V_NEAR_COFFEE,
    priors: [prior(V_COFFEE)],
    threshold: 0.9500001,
  });
  assert.equal(justAbove.length, 0, 'strictly below threshold is not a match');
});

test('configurable threshold flips the match/no-match boundary', () => {
  // sim = 0.95 here.
  const lenient = bestEmbeddingMatch({ rowVector: V_NEAR_COFFEE, priors: [prior(V_COFFEE)], threshold: 0.85 });
  assert.ok(lenient != null, 'matches at 0.85');
  const strict = bestEmbeddingMatch({ rowVector: V_NEAR_COFFEE, priors: [prior(V_COFFEE)], threshold: 0.99 });
  assert.equal(strict, null, 'no match at 0.99');
});

test('tie-break: highest similarity wins, then higher support count', () => {
  const higherSim = prior(V_COFFEE, { merchantClean: 'Exact', supportCount: 1 }); // sim 1.0
  const lowerSim = prior(V_NEAR_COFFEE, { merchantClean: 'Near', supportCount: 99 }); // sim 0.95
  const best = bestEmbeddingMatch({ rowVector: V_COFFEE, priors: [lowerSim, higherSim], threshold: 0.85 });
  assert.equal(best!.merchantClean, 'Exact', 'higher similarity beats higher support');

  // Exact similarity tie → higher support count wins.
  const a = prior(V_COFFEE, { merchantClean: 'LowSupport', supportCount: 2 });
  const b = prior(V_COFFEE, { merchantClean: 'HighSupport', supportCount: 10 });
  const tie = bestEmbeddingMatch({ rowVector: V_COFFEE, priors: [a, b], threshold: 0.85 });
  assert.equal(tie!.merchantClean, 'HighSupport', 'on a similarity tie, higher support wins');
});

test('similarityToConfidence: >=0.92 high, otherwise medium', () => {
  assert.equal(similarityToConfidence(0.93), 'high');
  assert.equal(similarityToConfidence(0.92), 'high');
  assert.equal(similarityToConfidence(0.88), 'medium');
});

test('carries business and split fields from the matched merchant', () => {
  const signals = runEmbeddingMatchStage({
    rowVector: V_COFFEE,
    priors: [prior(V_COFFEE, { business: true, splitType: 'shared', pctMe: '60', pctPartner: '40' })],
    threshold: 0.85,
  });
  assert.equal(signals[0].fields.autoBusiness, true);
  assert.equal(signals[0].fields.autoSplitType, 'shared');
  assert.equal(signals[0].fields.autoPctMe, '60');
  assert.equal(signals[0].fields.autoPctPartner, '40');
});
