import { before, test } from 'node:test';
import assert from 'node:assert/strict';

let parseEnrichmentBackfillEnabled: typeof import('./env.js').parseEnrichmentBackfillEnabled;

before(async () => {
  const envModule = await import('./env.js');
  parseEnrichmentBackfillEnabled = envModule.parseEnrichmentBackfillEnabled;
});

test('parseEnrichmentBackfillEnabled: explicit true/false wins regardless of env', () => {
  assert.equal(parseEnrichmentBackfillEnabled('true', 'production'), true);
  assert.equal(parseEnrichmentBackfillEnabled('false', 'production'), false);
  assert.equal(parseEnrichmentBackfillEnabled('1', 'test'), true);
  assert.equal(parseEnrichmentBackfillEnabled('0', 'test'), false);
});

test('parseEnrichmentBackfillEnabled: defaults to false in test env', () => {
  assert.equal(parseEnrichmentBackfillEnabled(undefined, 'test'), false);
});

test('parseEnrichmentBackfillEnabled: defaults to true elsewhere', () => {
  assert.equal(parseEnrichmentBackfillEnabled(undefined, 'production'), true);
  assert.equal(parseEnrichmentBackfillEnabled(undefined, 'development'), true);
});
