import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAiBatchStage, type AiBatchCandidate } from '../src/import/enrichment/aiBatchStage';

function cand(over: Partial<AiBatchCandidate>): AiBatchCandidate {
  return {
    merchantKey: over.merchantKey ?? 'starbucks',
    sampleMerchantRaw: 'STARBUCKS #1234 GUELPH',
    sampleMerchantClean: 'STARBUCKS #1234',
    sampleMerchantCanonical: null,
    sampleAmount: -6.5,
    sampleDate: '2026-05-01',
    sampleCurrency: 'CAD',
    similarPriors: [],
    memoryMatch: null,
    ...over,
  };
}

test('happy path: batch returns suggestions keyed by merchantKey', async () => {
  const mockCaller = async () => ({
    results: {
      starbucks: { category: 'Dining', business: false, splitType: 'me', confidence: 'high', rationale: 'cafe' },
      uber: { category: 'Transportation', business: false, splitType: 'me', confidence: 'medium', rationale: 'rideshare' },
    },
  });
  const out = await runAiBatchStage({
    candidates: [cand({ merchantKey: 'starbucks' }), cand({ merchantKey: 'uber', sampleMerchantClean: 'UBER TRIP' })],
    categoryHints: ['Dining', 'Transportation', 'Groceries'],
    maxMerchants: 80,
    perRowConcurrency: 4,
    openaiCaller: mockCaller,
  });
  assert.equal(out.suggestions.size, 2);
  assert.equal(out.suggestions.get('starbucks')!.category, 'Dining');
  assert.equal(out.suggestions.get('starbucks')!.confidence, 'high');
  assert.equal(out.suggestions.get('uber')!.confidence, 'medium');
  assert.equal(out.usedBatch, true);
  assert.equal(out.fellBackToPerRow, false);
  assert.equal(out.capped, false);
});

test('cap: caps at maxMerchants and reports cappedCount; excess merchants get no suggestion', async () => {
  const mockCaller = async () => ({ results: { a: { category: 'X', confidence: 'high' } } });
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((k) => cand({ merchantKey: k }));
  const out = await runAiBatchStage({
    candidates,
    categoryHints: [],
    maxMerchants: 2,
    perRowConcurrency: 4,
    openaiCaller: mockCaller,
  });
  assert.equal(out.capped, true);
  assert.equal(out.cappedCount, 3); // 5 - 2 = 3 excess
  // No suggestion for excess merchants
  assert.equal(out.suggestions.has('c'), false);
});

test('batch failure: falls back to per-row when batch call rejects', async () => {
  let batchCalled = 0;
  let perRowCalls = 0;
  const mockCaller = async (messages: unknown[]) => {
    const body = JSON.stringify(messages);
    // Batch prompt mentions multiple merchant_keys; per-row mentions only one
    if (body.includes('merchant_keys') || body.match(/merchant_key/g)?.length! > 1) {
      batchCalled += 1;
      throw new Error('429 rate limit');
    }
    perRowCalls += 1;
    // Per-row returns a single-suggestion JSON
    return { category: 'Dining', business: false, confidence: 'high', rationale: 'cafe' };
  };
  const out = await runAiBatchStage({
    candidates: [cand({ merchantKey: 'a' }), cand({ merchantKey: 'b' }), cand({ merchantKey: 'c' })],
    categoryHints: [],
    maxMerchants: 80,
    perRowConcurrency: 2,
    openaiCaller: mockCaller,
  });
  assert.equal(out.usedBatch, false);
  assert.equal(out.fellBackToPerRow, true);
  assert.ok(batchCalled >= 1, 'batch attempted');
  assert.equal(perRowCalls, 3);
  assert.equal(out.suggestions.size, 3);
  assert.equal(out.suggestions.get('a')!.category, 'Dining');
});

test('per-row fallback respects concurrency cap (no more than N inflight at once)', async () => {
  let inflight = 0;
  let maxInflight = 0;
  const mockCaller = async (messages: unknown[]) => {
    const body = JSON.stringify(messages);
    if (body.match(/merchant_key/g)?.length! > 1) throw new Error('batch fail');
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 20));
    inflight -= 1;
    return { category: 'X', confidence: 'high' };
  };
  const candidates = Array.from({ length: 10 }, (_, i) => cand({ merchantKey: `k${i}` }));
  const out = await runAiBatchStage({
    candidates,
    categoryHints: [],
    maxMerchants: 80,
    perRowConcurrency: 3,
    openaiCaller: mockCaller,
  });
  assert.ok(maxInflight <= 3, `expected ≤3 inflight, observed ${maxInflight}`);
  assert.equal(out.suggestions.size, 10);
});

test('per-row failure on individual merchant: that merchant has no suggestion, others succeed', async () => {
  const mockCaller = async (messages: unknown[]) => {
    const body = JSON.stringify(messages);
    if (body.match(/merchant_key/g)?.length! > 1) throw new Error('batch down');
    if (body.includes('BAD-MERCHANT')) throw new Error('per-row also down');
    return { category: 'X', confidence: 'medium' };
  };
  const out = await runAiBatchStage({
    candidates: [
      cand({ merchantKey: 'good1' }),
      cand({ merchantKey: 'bad', sampleMerchantClean: 'BAD-MERCHANT' }),
      cand({ merchantKey: 'good2' }),
    ],
    categoryHints: [],
    maxMerchants: 80,
    perRowConcurrency: 4,
    openaiCaller: mockCaller,
  });
  assert.equal(out.suggestions.has('good1'), true);
  assert.equal(out.suggestions.has('good2'), true);
  assert.equal(out.suggestions.has('bad'), false);
});

test('empty candidates: no AI call made; empty result', async () => {
  let called = false;
  const mockCaller = async () => {
    called = true;
    return {};
  };
  const out = await runAiBatchStage({
    candidates: [],
    categoryHints: [],
    maxMerchants: 80,
    perRowConcurrency: 4,
    openaiCaller: mockCaller,
  });
  assert.equal(called, false);
  assert.equal(out.suggestions.size, 0);
});

test('malformed response: missing results key → batch fails → fallback per-row', async () => {
  let batchCalled = 0;
  let perRowCalled = 0;
  const mockCaller = async (messages: unknown[]) => {
    const body = JSON.stringify(messages);
    if (body.match(/merchant_key/g)?.length! > 1) {
      batchCalled += 1;
      return { unexpected: 'shape' };
    }
    perRowCalled += 1;
    return { category: 'X', confidence: 'high' };
  };
  const out = await runAiBatchStage({
    candidates: [cand({ merchantKey: 'a' }), cand({ merchantKey: 'b' })],
    categoryHints: [],
    maxMerchants: 80,
    perRowConcurrency: 4,
    openaiCaller: mockCaller,
  });
  assert.equal(batchCalled, 1);
  assert.equal(perRowCalled, 2);
  assert.equal(out.fellBackToPerRow, true);
});
