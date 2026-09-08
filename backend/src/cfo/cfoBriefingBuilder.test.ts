import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Insight: typeof import('../models').Insight;
let briefingShortSummary: typeof import('./briefingBuilder').briefingShortSummary;
let classifyImportIssue: typeof import('./briefingBuilder').classifyImportIssue;
let CFO_BRIEFING_PROMPT_VERSION: typeof import('./briefingBuilder').CFO_BRIEFING_PROMPT_VERSION;
let resolveDefaultBriefingPeriod: typeof import('./briefingBuilder').resolveDefaultBriefingPeriod;
let loadOpenInsightItems: typeof import('./briefingBuilder').loadOpenInsightItems;

/**
 * Unit tests for the pure helpers inside briefingBuilder, plus
 * `loadOpenInsightItems` (needs a DB — the rest of the full end-to-end
 * builder is exercised by the integration test
 * test/integration/cfoBriefings.test.ts, which seeds real fixtures).
 */

before(async () => {
  const models = await import('../models');
  sequelize = models.sequelize;
  Insight = models.Insight;
  ({
    briefingShortSummary,
    classifyImportIssue,
    CFO_BRIEFING_PROMPT_VERSION,
    resolveDefaultBriefingPeriod,
    loadOpenInsightItems,
  } = await import('./briefingBuilder'));
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Insight.destroy({ where: {}, truncate: true });
});

test('briefingShortSummary returns a friendly empty message when no items', () => {
  assert.equal(
    briefingShortSummary({
      forecastWarnings: 0,
      safeToSpendLow: 0,
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
    newSubscriptions: 0,
    ruleSuggestions: 0,
    reviewBacklog: 5,
    importIssues: 0,
    anomalies: 2,
  });
  assert.match(out, /^9 action items:/);
  assert.match(out, /1 forecast warning(,|$| )/);
  assert.match(out, /1 safe-to-spend alert(,|$| )/);
  assert.match(out, /5 review backlog items/);
  assert.match(out, /2 anomalies/);
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

test('loadOpenInsightItems returns open insights as anomaly action items', async () => {
  const householdId = 1;
  await Insight.create({
    householdId,
    userId: null,
    type: 'merchant_spend_spike',
    severity: 'warning',
    title: 'Spending at Loblaws is up',
    description: 'Up 3x versus the prior three months.',
    entityType: null,
    entityId: null,
    status: 'open',
    fingerprint: 'spike:loblaws:2026-09',
    metadata: { transactionIds: [11, 12] },
    detectedAt: new Date(),
  });
  await Insight.create({
    householdId,
    userId: null,
    type: 'missing_receipt',
    severity: 'info',
    title: 'Dismissed already',
    description: null,
    entityType: null,
    entityId: null,
    status: 'dismissed',
    fingerprint: 'receipt:dismissed',
    metadata: null,
    detectedAt: new Date(),
  });

  const items = await loadOpenInsightItems(householdId);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Spending at Loblaws is up');
  assert.equal(items[0].type, 'anomaly');
  assert.equal(items[0].severity, 'watch');
  assert.deepEqual(items[0].supportingTransactionIds, [11, 12]);
});
