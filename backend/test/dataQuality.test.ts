/**
 * Pure unit tests for the data-quality score math (#234).
 *
 * The data-quality dashboard score combines seven component signals into a
 * single 0..1 score for the household's finance dataset. Each component is
 * normalized to 0..1 (1 = best, 0 = worst) and the overall score is the
 * equally-weighted average of the components. This file exercises the math
 * in isolation, decoupled from Sequelize/HTTP, so failures point at score
 * logic and not infrastructure.
 *
 * The deterministic-calculation AC bullet drives every assertion below:
 * identical inputs MUST produce identical outputs across processes, and the
 * weighting + normalization MUST be documented in the module under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDataQualityScore,
  normalizeIssueCount,
  DATA_QUALITY_THRESHOLDS,
  type DataQualityComponents,
} from '../src/summary/dataQualityScore';

function components(overrides: Partial<DataQualityComponents> = {}): DataQualityComponents {
  return {
    categorization: {
      totalSpend: 100,
      categorized: 100,
      uncategorized: 0,
      coverage: 1,
    },
    rules: {
      totalSpend: 100,
      ruleCovered: 100,
      uncovered: 0,
      coverage: 1,
    },
    receipts: {
      totalSpend: 100,
      withReceipt: 100,
      missing: 0,
      coverage: 1,
    },
    duplicates: {
      duplicateGroups: 0,
      duplicateTransactions: 0,
    },
    transfers: {
      unmatched: 0,
    },
    subscriptions: {
      stale: 0,
    },
    review: {
      backlog: 0,
    },
    ...overrides,
  };
}

test('normalizeIssueCount: zero issues yields 1.0', () => {
  assert.equal(normalizeIssueCount(0, 10), 1);
});

test('normalizeIssueCount: at-threshold count yields 0.0', () => {
  assert.equal(normalizeIssueCount(10, 10), 0);
});

test('normalizeIssueCount: above-threshold count clamps to 0.0', () => {
  assert.equal(normalizeIssueCount(50, 10), 0);
});

test('normalizeIssueCount: half-threshold count yields 0.5', () => {
  assert.equal(normalizeIssueCount(5, 10), 0.5);
});

test('normalizeIssueCount: zero threshold returns 1 when count is 0, 0 otherwise', () => {
  // Defensive: avoid div-by-zero. A zero threshold says "any non-zero issue
  // is catastrophic" — match that intuition without throwing.
  assert.equal(normalizeIssueCount(0, 0), 1);
  assert.equal(normalizeIssueCount(1, 0), 0);
});

test('computeDataQualityScore: perfect inputs yield score 1.0 with per-component 1.0', () => {
  const result = computeDataQualityScore(components());
  assert.equal(result.score, 1);
  assert.equal(result.componentScores.categorization, 1);
  assert.equal(result.componentScores.rules, 1);
  assert.equal(result.componentScores.receipts, 1);
  assert.equal(result.componentScores.duplicates, 1);
  assert.equal(result.componentScores.transfers, 1);
  assert.equal(result.componentScores.subscriptions, 1);
  assert.equal(result.componentScores.review, 1);
});

test('computeDataQualityScore: empty dataset yields perfect score (vacuously true)', () => {
  // A brand-new account with no transactions has nothing to be wrong about.
  // The "useful empty state" AC bullet covers presentation; the math just
  // returns a normalized 1.0 instead of NaN.
  const result = computeDataQualityScore(
    components({
      categorization: { totalSpend: 0, categorized: 0, uncategorized: 0, coverage: 0 },
      rules: { totalSpend: 0, ruleCovered: 0, uncovered: 0, coverage: 0 },
      receipts: { totalSpend: 0, withReceipt: 0, missing: 0, coverage: 0 },
    }),
  );
  assert.equal(result.score, 1);
  assert.equal(result.componentScores.categorization, 1);
  assert.equal(result.componentScores.rules, 1);
  assert.equal(result.componentScores.receipts, 1);
});

test('computeDataQualityScore: half-categorized lowers score and component', () => {
  const result = computeDataQualityScore(
    components({
      categorization: {
        totalSpend: 100,
        categorized: 50,
        uncategorized: 50,
        coverage: 0.5,
      },
    }),
  );
  assert.equal(result.componentScores.categorization, 0.5);
  // Average of (0.5, 1, 1, 1, 1, 1, 1) = 6.5/7
  assert.equal(Math.round(result.score * 1000) / 1000, Math.round((6.5 / 7) * 1000) / 1000);
});

test('computeDataQualityScore: at-threshold issue counts collapse to 0 contribution', () => {
  const result = computeDataQualityScore(
    components({
      duplicates: {
        duplicateGroups: DATA_QUALITY_THRESHOLDS.duplicates,
        duplicateTransactions: DATA_QUALITY_THRESHOLDS.duplicates * 2,
      },
      transfers: { unmatched: DATA_QUALITY_THRESHOLDS.transfers },
      subscriptions: { stale: DATA_QUALITY_THRESHOLDS.subscriptions },
      review: { backlog: DATA_QUALITY_THRESHOLDS.review },
    }),
  );
  assert.equal(result.componentScores.duplicates, 0);
  assert.equal(result.componentScores.transfers, 0);
  assert.equal(result.componentScores.subscriptions, 0);
  assert.equal(result.componentScores.review, 0);
  // 4 zeros + 3 ones / 7 = 3/7
  assert.equal(Math.round(result.score * 1000) / 1000, Math.round((3 / 7) * 1000) / 1000);
});

test('computeDataQualityScore: all-zero quality yields score 0', () => {
  // Worst case: every spend uncategorized + no rules + no receipts +
  // backlog/duplicates/transfers/subscriptions all at-or-above threshold.
  const bad = components({
    categorization: { totalSpend: 100, categorized: 0, uncategorized: 100, coverage: 0 },
    rules: { totalSpend: 100, ruleCovered: 0, uncovered: 100, coverage: 0 },
    receipts: { totalSpend: 100, withReceipt: 0, missing: 100, coverage: 0 },
    duplicates: { duplicateGroups: 1000, duplicateTransactions: 2000 },
    transfers: { unmatched: 1000 },
    subscriptions: { stale: 1000 },
    review: { backlog: 1000 },
  });
  const result = computeDataQualityScore(bad);
  assert.equal(result.score, 0);
});

test('computeDataQualityScore: result is deterministic across calls (same input → same output)', () => {
  const sample = components({
    categorization: { totalSpend: 137, categorized: 88, uncategorized: 49, coverage: 88 / 137 },
    rules: { totalSpend: 137, ruleCovered: 60, uncovered: 77, coverage: 60 / 137 },
    receipts: { totalSpend: 137, withReceipt: 70, missing: 67, coverage: 70 / 137 },
    duplicates: { duplicateGroups: 3, duplicateTransactions: 6 },
    transfers: { unmatched: 2 },
    subscriptions: { stale: 1 },
    review: { backlog: 18 },
  });
  const a = computeDataQualityScore(sample);
  const b = computeDataQualityScore(sample);
  assert.deepEqual(a, b);
});

test('computeDataQualityScore: components and score are bounded 0..1', () => {
  // Property check across a small grid.
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) {
      const result = computeDataQualityScore(
        components({
          categorization: { totalSpend: 10, categorized: i, uncategorized: 10 - i, coverage: i / 10 },
          duplicates: { duplicateGroups: j, duplicateTransactions: j * 2 },
        }),
      );
      assert.ok(result.score >= 0 && result.score <= 1, `score out of range: ${result.score}`);
      for (const k of Object.keys(result.componentScores) as Array<
        keyof typeof result.componentScores
      >) {
        const c = result.componentScores[k];
        assert.ok(c >= 0 && c <= 1, `component ${k} out of range: ${c}`);
      }
    }
  }
});
