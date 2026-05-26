/**
 * Unit tests for the auto-suggestion helpers introduced for issue #211:
 * stable-ID hashing, confidence bucketing, and human-readable reasoning.
 *
 * The end-to-end shape (GET /api/rules/auto-suggestions, accept, dismiss)
 * is covered by `test/integration/rulesAutoSuggestions.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSuggestionReasoning,
  confidenceForSupport,
  proposalIdFor,
} from '../src/ai/ruleProposals';

test('proposalIdFor is deterministic across calls for the same shape', () => {
  const a = proposalIdFor({
    merchantPattern: 'METRO',
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  });
  const b = proposalIdFor({
    merchantPattern: 'METRO',
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  });
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 8, `id should be at least 8 chars, got "${a}"`);
});

test('proposalIdFor differs when any meaningful field differs', () => {
  const base = {
    merchantPattern: 'METRO',
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null as string | null,
    pctPartner: null as string | null,
  };
  const baseId = proposalIdFor(base);
  assert.notEqual(baseId, proposalIdFor({ ...base, merchantPattern: 'COSTCO' }));
  assert.notEqual(baseId, proposalIdFor({ ...base, category: 'Dining' }));
  assert.notEqual(baseId, proposalIdFor({ ...base, isBusiness: true }));
  assert.notEqual(baseId, proposalIdFor({ ...base, splitType: 'shared' }));
  assert.notEqual(
    baseId,
    proposalIdFor({ ...base, pctMe: '0.5', pctPartner: '0.5', splitType: 'shared' }),
  );
});

test('proposalIdFor normalizes merchant pattern (case + whitespace)', () => {
  const a = proposalIdFor({
    merchantPattern: '  metro  grocery  ',
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  });
  const b = proposalIdFor({
    merchantPattern: 'METRO GROCERY',
    category: 'Groceries',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  });
  assert.equal(a, b);
});

test('confidenceForSupport maps support count to high/medium/low', () => {
  assert.equal(confidenceForSupport(2), 'low');
  assert.equal(confidenceForSupport(3), 'medium');
  assert.equal(confidenceForSupport(4), 'medium');
  assert.equal(confidenceForSupport(5), 'high');
  assert.equal(confidenceForSupport(20), 'high');
});

test('buildSuggestionReasoning describes category + business + split clearly', () => {
  assert.equal(
    buildSuggestionReasoning({
      merchantPattern: 'METRO',
      category: 'Groceries',
      isBusiness: false,
      splitType: 'me',
      pctMe: null,
      pctPartner: null,
      supportCount: 5,
    }),
    'You categorized 5 reviewed transactions for "METRO" as "Groceries" with no exceptions.',
  );
});

test('buildSuggestionReasoning mentions business flag when true', () => {
  const out = buildSuggestionReasoning({
    merchantPattern: 'STAPLES',
    category: 'Office',
    isBusiness: true,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    supportCount: 4,
  });
  assert.match(out, /STAPLES/);
  assert.match(out, /Office/);
  assert.match(out, /business/i);
});

test('buildSuggestionReasoning mentions split percentages when shared', () => {
  const out = buildSuggestionReasoning({
    merchantPattern: 'COSTCO',
    category: 'Groceries',
    isBusiness: false,
    splitType: 'shared',
    pctMe: '0.5',
    pctPartner: '0.5',
    supportCount: 6,
  });
  assert.match(out, /shared/);
  assert.match(out, /50/); // either 50% or 0.5 — we render 50/50 split
});

test('buildSuggestionReasoning handles null category gracefully', () => {
  const out = buildSuggestionReasoning({
    merchantPattern: 'WEIRD',
    category: null,
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
    supportCount: 3,
  });
  assert.match(out, /WEIRD/);
  assert.match(out, /uncategorized/i);
});
