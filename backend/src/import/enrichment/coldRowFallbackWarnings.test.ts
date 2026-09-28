/**
 * The cold-row fallbacks used to fail silently: an import where the embedder
 * was absent and the AI batch never ran looked EXACTLY like an import with
 * nothing left to categorise. These are the tests for the warning text that
 * tells those two apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coldRowFallbackWarnings } from './coldRowFallbackWarnings';
import type { EmbeddingMatchSummary } from './embeddingMatchOverColdRows';
import type { AiBatchSummary } from './aiBatchOverColdRows';

function embedding(over: Partial<EmbeddingMatchSummary> = {}): EmbeddingMatchSummary {
  return {
    attempted: false,
    coldRowCount: 3,
    priorMerchants: 0,
    matched: 0,
    ...over,
  };
}

function ai(over: Partial<AiBatchSummary> = {}): AiBatchSummary {
  return {
    attempted: false,
    coldRowCount: 3,
    merchantsConsidered: 0,
    enhanced: 0,
    capped: false,
    usedBatch: false,
    fellBackToPerRow: false,
    ...over,
  };
}

test('an absent embedding model is named, with the row count it could not help', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ skipReason: 'embedder_unavailable' }),
    ai({ attempted: true, skipReason: undefined }),
  );
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /embedding/i);
  assert.match(warnings[0], /3/);
});

test('a missing OpenAI configuration is named too', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ attempted: true, skipReason: undefined }),
    ai({ skipReason: 'no_openai_config' }),
  );
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /AI/);
  assert.match(warnings[0], /not configured|unavailable/i);
});

test('both unavailable → both are reported, embedding first (pipeline order)', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ skipReason: 'embedder_unavailable' }),
    ai({ skipReason: 'no_openai_config' }),
  );
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /embedding/i);
  assert.match(warnings[1], /AI/);
});

test('deliberately disabled is reported as disabled, not as broken', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ skipReason: 'disabled' }),
    ai({ skipReason: 'disabled' }),
  );
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /ENRICHMENT_EMBEDDING_ENABLED/);
  assert.match(warnings[1], /ENRICHMENT_AI_ENABLED/);
});

test('a stage that threw is reported, and says the import was unaffected', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ skipReason: 'stage_error' }),
    ai({ attempted: true }),
  );
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /unaffected/i);
});

test('nothing to categorise → silence (this is NOT an unavailability)', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ coldRowCount: 0, skipReason: 'no_cold_rows' }),
    ai({ coldRowCount: 0, skipReason: 'no_cold_rows' }),
  );
  assert.deepEqual(warnings, []);
});

test('a genuine cold start (no prior merchants) is not an unavailability', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ skipReason: 'no_priors' }),
    ai({ attempted: true }),
  );
  assert.deepEqual(warnings, []);
});

test('embedding matched every cold row → the AI stage having none left is silent', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ attempted: true, matched: 3 }),
    ai({ coldRowCount: 0, skipReason: 'no_cold_rows' }),
  );
  assert.deepEqual(warnings, []);
});

test('both stages ran → no warnings at all', () => {
  const warnings = coldRowFallbackWarnings(
    embedding({ attempted: true, matched: 1 }),
    ai({ attempted: true, enhanced: 2 }),
  );
  assert.deepEqual(warnings, []);
});
