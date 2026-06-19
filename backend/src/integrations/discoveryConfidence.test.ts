import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPurchasesLabel, classifyDiscoveryConfidence } from './discoveryConfidence';

test('isPurchasesLabel detects the Gmail purchases category', () => {
  assert.equal(isPurchasesLabel(['INBOX', 'CATEGORY_PURCHASES']), true);
  assert.equal(isPurchasesLabel(['INBOX', 'CATEGORY_PROMOTIONS']), false);
  assert.equal(isPurchasesLabel(null), false);
  assert.equal(isPurchasesLabel(undefined), false);
});

test('a deterministic parser hit is always HIGH', () => {
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'amazon', isPurchases: false, hasCleanExtract: true, amountMatched: false }),
    'high',
  );
});

test('AI extract is HIGH only with purchases label + clean extract + amount match', () => {
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: true, hasCleanExtract: true, amountMatched: true }),
    'high',
  );
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: true, hasCleanExtract: true, amountMatched: false }),
    'low',
  );
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: false, hasCleanExtract: true, amountMatched: true }),
    'low',
  );
  assert.equal(
    classifyDiscoveryConfidence({ parser: 'ai', isPurchases: true, hasCleanExtract: false, amountMatched: true }),
    'low',
  );
});
