import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  briefingShortSummary,
  classifyImportIssue,
  CFO_BRIEFING_PROMPT_VERSION,
  resolveDefaultBriefingPeriod,
} from './briefingBuilder';

/**
 * Unit tests for the pure helpers inside briefingBuilder. The full
 * end-to-end builder is exercised by the integration test
 * (test/integration/cfoBriefings.test.ts) which seeds real fixtures.
 */

test('briefingShortSummary returns a friendly empty message when no items', () => {
  assert.equal(
    briefingShortSummary({
      forecastWarnings: 0,
      safeToSpendLow: 0,
      missingReceipts: 0,
      newSubscriptions: 0,
      ruleSuggestions: 0,
      reviewBacklog: 0,
      importIssues: 0,
      anomalies: 0,
    }),
    'All clear — no action items for this briefing window.',
  );
});

test('briefingShortSummary counts and labels singular/plural correctly', () => {
  const out = briefingShortSummary({
    forecastWarnings: 1,
    safeToSpendLow: 1,
    missingReceipts: 2,
    newSubscriptions: 0,
    ruleSuggestions: 0,
    reviewBacklog: 5,
    importIssues: 0,
    anomalies: 0,
  });
  assert.match(out, /^9 action items:/);
  assert.match(out, /1 forecast warning(,|$| )/);
  assert.match(out, /1 safe-to-spend alert(,|$| )/);
  assert.match(out, /2 missing receipts/);
  assert.match(out, /5 review backlog items/);
});

test('classifyImportIssue maps known statuses to severity', () => {
  assert.equal(classifyImportIssue('failed').severity, 'action');
  assert.equal(classifyImportIssue('partial').severity, 'watch');
  assert.equal(classifyImportIssue('rolled_back').severity, 'watch');
  // Unknown statuses default to info, never action.
  assert.equal(classifyImportIssue('weird-string').severity, 'info');
});

test('classifyImportIssue title references the status', () => {
  assert.match(classifyImportIssue('failed').title, /Import failed/);
  assert.match(classifyImportIssue('partial').title, /Import partial/i);
});

test('resolveDefaultBriefingPeriod returns 7-day window ending on the asOfDate', () => {
  const out = resolveDefaultBriefingPeriod('2026-05-26');
  assert.equal(out.periodEnd, '2026-05-26');
  assert.equal(out.periodStart, '2026-05-20'); // 26 - 6 days = 20 (inclusive end)
});

test('resolveDefaultBriefingPeriod handles month boundaries', () => {
  const out = resolveDefaultBriefingPeriod('2026-03-01');
  assert.equal(out.periodEnd, '2026-03-01');
  // 6 days before March 1 → Feb 23 (non-leap; date math handled by Date)
  assert.equal(out.periodStart, '2026-02-23');
});

test('CFO_BRIEFING_PROMPT_VERSION is a stable string identifier', () => {
  assert.match(CFO_BRIEFING_PROMPT_VERSION, /^cfo-briefing-v\d+$/);
});
