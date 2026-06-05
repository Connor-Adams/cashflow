import { test } from 'node:test';
import assert from 'node:assert/strict';

test('enrichmentItemClearConfidence defaults to 80 when env unset', async () => {
  delete process.env.ENRICHMENT_ITEM_CLEAR_CONFIDENCE;
  const mod = await import('./env.ts');
  assert.equal(mod.enrichmentItemClearConfidence, 80);
});
