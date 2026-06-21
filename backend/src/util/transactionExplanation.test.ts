/**
 * Unit tests for `buildTransactionExplanation` — the pure helper that produces
 * a structured per-field explanation of why a transaction has its current
 * category, split, business flag, notes, and review state.
 *
 * Issue: #230 (feat: explain transaction categorization decisions).
 *
 * The helper reasons over already-loaded inputs (transaction row, applied
 * rule, latest accepted AI suggestion, enrichment signals, optional actor
 * lookup). It MUST NOT touch the database — that is the route's job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransactionExplanation,
  type ExplanationInputs,
} from './transactionExplanation';

function baseTxn(
  over: Partial<ExplanationInputs['transaction']> = {},
): ExplanationInputs['transaction'] {
  return {
    id: 1,
    createdByUserId: 99,
    createdAt: new Date('2026-01-01T10:00:00Z'),
    updatedAt: new Date('2026-01-02T10:00:00Z'),
    appliedRuleId: null,
    autoSource: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    notes: null,
    reviewFlag: false,
    reviewedAt: null,
    ...over,
  };
}

const baseInputs: ExplanationInputs = {
  transaction: baseTxn(),
  appliedRule: null,
  latestAcceptedAiSuggestion: null,
  signals: [],
  actorLookup: null,
};

// --------- category source ------------------------------------------------

test('category: rule source when appliedRuleId set and no manual override', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      appliedRuleId: 42,
      autoSource: 'rule',
      autoCategory: 'Groceries',
      finalCategory: 'Groceries',
    }),
    appliedRule: {
      id: 42,
      merchantPattern: 'COSTCO',
      category: 'Groceries',
      splitType: 'shared',
    },
  });
  assert.equal(out.category.source, 'rule');
  assert.equal(out.category.value, 'Groceries');
  assert.deepEqual(out.category.appliedRule, {
    id: 42,
    merchantPattern: 'COSTCO',
    category: 'Groceries',
  });
  assert.equal(out.category.manualEdit, undefined);
  assert.equal(out.category.aiSuggestion, undefined);
  assert.match(out.category.message, /rule/i);
  assert.match(out.category.message, /COSTCO/);
});

test('category: manual source when categoryOverride is non-null (override always wins, even with rule)', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      appliedRuleId: 42,
      autoSource: 'rule',
      autoCategory: 'Groceries',
      categoryOverride: 'Dining',
      finalCategory: 'Dining',
      updatedAt: new Date('2026-03-15T18:30:00Z'),
      createdByUserId: 7,
    }),
    appliedRule: {
      id: 42,
      merchantPattern: 'COSTCO',
      category: 'Groceries',
      splitType: 'shared',
    },
    actorLookup: (id) => (id === 7 ? { id: 7, displayName: 'Connor' } : null),
  });
  assert.equal(out.category.source, 'manual');
  assert.equal(out.category.value, 'Dining');
  assert.equal(out.category.overrideValue, 'Dining');
  assert.equal(out.category.autoValue, 'Groceries');
  assert.ok(out.category.manualEdit);
  assert.equal(
    out.category.manualEdit!.at.toISOString(),
    '2026-03-15T18:30:00.000Z',
  );
  assert.equal(out.category.manualEdit!.actorDisplayName, 'Connor');
  // Surfaces that a rule was overridden — important context for users.
  assert.ok(out.category.appliedRule);
  assert.match(out.category.message, /manual/i);
});

test('category: ai source when latestAcceptedAiSuggestion has category and no manual override (post-accept)', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      autoSource: 'ai',
      autoCategory: 'Software & Apps',
      finalCategory: 'Software & Apps',
    }),
    latestAcceptedAiSuggestion: {
      id: 901,
      createdAt: new Date('2026-04-01T12:00:00Z'),
      status: 'accepted',
      model: 'gpt-4o-mini',
      output: { category: 'Software & Apps' },
    },
  });
  assert.equal(out.category.source, 'ai');
  assert.ok(out.category.aiSuggestion);
  assert.equal(out.category.aiSuggestion!.id, 901);
  assert.equal(out.category.aiSuggestion!.status, 'accepted');
  assert.equal(out.category.aiSuggestion!.model, 'gpt-4o-mini');
  assert.match(out.category.message, /ai|AI/);
});

test('category: ai source attribution overrides "manual" when the override matches the accepted AI suggestion category', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      categoryOverride: 'Subscriptions',
      finalCategory: 'Subscriptions',
      updatedAt: new Date('2026-04-15T00:00:00Z'),
    }),
    latestAcceptedAiSuggestion: {
      id: 902,
      createdAt: new Date('2026-04-15T00:00:00Z'),
      status: 'accepted',
      model: 'gpt-4o-mini',
      output: { category: 'Subscriptions' },
    },
  });
  assert.equal(out.category.source, 'ai');
  assert.equal(out.category.value, 'Subscriptions');
  assert.ok(out.category.aiSuggestion);
});

test('category: import-default when autoSource is set but not "rule"/"ai" (e.g. memory, recurring, normalize-learned)', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      autoSource: 'memory',
      autoCategory: 'Coffee',
      finalCategory: 'Coffee',
    }),
    signals: [
      {
        source: 'memory',
        confidence: 'high',
        fields: { autoCategory: 'Coffee' },
        rationale: 'Matched 3 prior reviewed transactions at this merchant',
      },
    ],
  });
  assert.equal(out.category.source, 'import-default');
  assert.equal(out.category.value, 'Coffee');
  assert.equal(out.category.autoSourceLabel, 'memory');
  assert.equal(
    out.category.signalRationale,
    'Matched 3 prior reviewed transactions at this merchant',
  );
});

test('category: fallback when finalCategory is null and no source applies (legacy or fresh import)', () => {
  const out = buildTransactionExplanation(baseInputs);
  assert.equal(out.category.source, 'fallback');
  assert.equal(out.category.value, null);
  assert.match(out.category.message, /not yet categorised|legacy|no source/i);
});

// --------- split source ---------------------------------------------------

test('split: rule source when appliedRule has a splitType and override null', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      appliedRuleId: 50,
      autoSplitType: 'shared',
      finalSplitType: 'shared',
    }),
    appliedRule: {
      id: 50,
      merchantPattern: 'NETFLIX',
      category: 'Subscriptions',
      splitType: 'shared',
    },
  });
  assert.equal(out.split.source, 'rule');
  assert.equal(out.split.value, 'shared');
  assert.deepEqual(out.split.appliedRule, {
    id: 50,
    merchantPattern: 'NETFLIX',
    category: 'Subscriptions',
  });
});

test('split: manual when splitOverride non-null', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      autoSplitType: 'me',
      splitOverride: 'shared',
      finalSplitType: 'shared',
      updatedAt: new Date('2026-05-10T15:00:00Z'),
    }),
  });
  assert.equal(out.split.source, 'manual');
  assert.equal(out.split.value, 'shared');
  assert.ok(out.split.manualEdit);
});

test('split: fallback when finalSplitType is the default "me" and no source recorded', () => {
  // finalSplitType has a NOT NULL DB default of 'me', so a legacy row with no
  // explicit source still reports 'me'. We must distinguish from a real choice.
  const out = buildTransactionExplanation(baseInputs);
  assert.equal(out.split.source, 'fallback');
  assert.equal(out.split.value, 'me');
  assert.match(out.split.message, /default|fallback|legacy/i);
});

// --------- business flag --------------------------------------------------

test('business: rule when appliedRule isBusiness true and no override', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      appliedRuleId: 11,
      autoBusiness: true,
      finalBusiness: true,
    }),
    appliedRule: {
      id: 11,
      merchantPattern: 'STAPLES',
      category: 'Office',
      splitType: 'me',
    },
  });
  assert.equal(out.business.source, 'rule');
  assert.equal(out.business.value, true);
});

test('business: manual when businessOverride non-null', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      businessOverride: true,
      finalBusiness: true,
      updatedAt: new Date('2026-05-01T00:00:00Z'),
    }),
  });
  assert.equal(out.business.source, 'manual');
  assert.equal(out.business.value, true);
});

test('business: fallback when finalBusiness=false and nothing set it', () => {
  const out = buildTransactionExplanation(baseInputs);
  assert.equal(out.business.source, 'fallback');
  assert.equal(out.business.value, false);
});

// --------- notes ----------------------------------------------------------

test('notes: manual when notes non-null/non-empty', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      notes: 'For Q2 expense report',
      updatedAt: new Date('2026-06-01T00:00:00Z'),
    }),
  });
  assert.equal(out.notes.source, 'manual');
  assert.equal(out.notes.value, 'For Q2 expense report');
  assert.ok(out.notes.manualEdit);
});

test('notes: none source when notes is null', () => {
  const out = buildTransactionExplanation(baseInputs);
  assert.equal(out.notes.source, 'none');
  assert.equal(out.notes.value, null);
});

// --------- review state --------------------------------------------------

test('review: cleared when reviewFlag=false and reviewedAt set', () => {
  const reviewedAt = new Date('2026-05-20T12:00:00Z');
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({ reviewFlag: false, reviewedAt }),
  });
  assert.equal(out.review.state, 'cleared');
  assert.equal(out.review.lastChangedAt?.toISOString(), reviewedAt.toISOString());
});

test('review: needs-review when reviewFlag=true', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({ reviewFlag: true, reviewedAt: null }),
  });
  assert.equal(out.review.state, 'needs-review');
});

test('review: never-flagged when reviewFlag=false and reviewedAt null (clean import)', () => {
  const out = buildTransactionExplanation(baseInputs);
  assert.equal(out.review.state, 'never-flagged');
});

// --------- serializability ------------------------------------------------

test('output is JSON-serializable (Dates become ISO strings round-trip safe)', () => {
  const out = buildTransactionExplanation({
    ...baseInputs,
    transaction: baseTxn({
      categoryOverride: 'Misc',
      finalCategory: 'Misc',
      updatedAt: new Date('2026-05-15T15:00:00Z'),
    }),
  });
  const j = JSON.parse(JSON.stringify(out));
  assert.equal(j.category.manualEdit.at, '2026-05-15T15:00:00.000Z');
});
