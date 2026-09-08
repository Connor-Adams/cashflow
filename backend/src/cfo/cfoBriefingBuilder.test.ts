import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import type { CfoBriefingActionItem } from '../models/CfoBriefing';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let Insight: typeof import('../models').Insight;
let briefingShortSummary: typeof import('./briefingBuilder').briefingShortSummary;
let classifyImportIssue: typeof import('./briefingBuilder').classifyImportIssue;
let CFO_BRIEFING_PROMPT_VERSION: typeof import('./briefingBuilder').CFO_BRIEFING_PROMPT_VERSION;
let resolveDefaultBriefingPeriod: typeof import('./briefingBuilder').resolveDefaultBriefingPeriod;
let loadOpenInsightItems: typeof import('./briefingBuilder').loadOpenInsightItems;
let buildCfoBriefing: typeof import('./briefingBuilder').buildCfoBriefing;
let MAX_OPEN_INSIGHT_ITEMS: typeof import('./briefingBuilder').MAX_OPEN_INSIGHT_ITEMS;

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
    buildCfoBriefing,
    MAX_OPEN_INSIGHT_ITEMS,
  } = await import('./briefingBuilder'));
  await sequelize.sync({ force: true });
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await Insight.destroy({ where: {}, truncate: true });
});

/**
 * `currentAuth(req)` (backend/src/auth/scope.ts) just returns `req.auth`, so
 * a plain object carrying the fields `householdWhere`/`visibleTransactionWhere`
 * read — `user.id`, `user.globalRole`, `household.id`, `role` — is a
 * sufficient fake. Mirrors the pattern already used in
 * `backend/src/auth/scope.test.ts` and `backend/src/audit/auditLog.test.ts`.
 * This file has no other request helper (confirmed by reading the file before
 * adding tests), so it's built fresh here rather than reused from elsewhere.
 */
function fakeReq(userId: number, householdId: number): Request {
  return {
    auth: {
      user: { id: userId, globalRole: 'user' },
      household: { id: householdId },
      role: 'owner',
    },
  } as unknown as Request;
}

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

test('loadOpenInsightItems caps at MAX_OPEN_INSIGHT_ITEMS, severest and newest first', async () => {
  const householdId = 7;
  // 3 critical + 20 warning + 5 info = 28 open rows, well past the cap.
  // detectedAt descends with the index inside each severity band, so the
  // expected order is "critical newest→oldest, then warning newest→oldest",
  // and every info row must fall off the end.
  const rows: Array<Record<string, unknown>> = [];
  const seed = (severity: string, count: number, dayBase: number) => {
    for (let i = 0; i < count; i += 1) {
      rows.push({
        householdId,
        userId: null,
        type: 'missing_receipt',
        severity,
        title: `${severity}-${i}`,
        description: null,
        entityType: null,
        entityId: null,
        status: 'open',
        fingerprint: `${severity}:${i}`,
        metadata: null,
        // i=0 is the newest within the band.
        detectedAt: new Date(Date.UTC(2026, 0, dayBase - i)),
      });
    }
  };
  seed('critical', 3, 28);
  seed('warning', 20, 28);
  seed('info', 5, 28);
  await Insight.bulkCreate(rows as never);

  const items = await loadOpenInsightItems(householdId);

  assert.equal(MAX_OPEN_INSIGHT_ITEMS, 20);
  assert.equal(items.length, MAX_OPEN_INSIGHT_ITEMS);
  assert.deepEqual(
    items.slice(0, 3).map((i) => i.title),
    ['critical-0', 'critical-1', 'critical-2'],
    'criticals come first, newest first',
  );
  assert.deepEqual(
    items.slice(3, 6).map((i) => i.title),
    ['warning-0', 'warning-1', 'warning-2'],
    'warnings follow, newest first',
  );
  assert.ok(
    items.every((i) => !i.title.startsWith('info-')),
    'the least severe rows are the ones dropped by the cap',
  );
});

test('briefing uses the synthesized summary and ordering when available', async () => {
  const householdId = 555;
  await Insight.create({
    householdId,
    userId: null,
    type: 'merchant_spend_spike',
    severity: 'warning',
    title: 'Insight A',
    description: null,
    entityType: null,
    entityId: null,
    status: 'open',
    fingerprint: 'a',
    metadata: null,
    detectedAt: new Date('2026-09-01T00:00:00Z'),
  });
  await Insight.create({
    householdId,
    userId: null,
    type: 'merchant_spend_spike',
    severity: 'warning',
    title: 'Insight B',
    description: null,
    entityType: null,
    entityId: null,
    status: 'open',
    fingerprint: 'b',
    metadata: null,
    detectedAt: new Date('2026-09-02T00:00:00Z'),
  });

  let capturedItems: CfoBriefingActionItem[] = [];
  const result = await buildCfoBriefing({
    req: fakeReq(1, householdId),
    householdId,
    userId: 1,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-07',
    currency: 'CAD',
    synthesizeImpl: async ({ items }) => {
      capturedItems = items;
      return {
        summary: 'One thing matters this week.',
        ordered: [...items].reverse(),
      };
    },
  });

  assert.ok(capturedItems.length >= 2, 'expected at least the two seeded insights as items');
  assert.equal(result.summary, 'One thing matters this week.');
  assert.deepEqual(result.actionItems, [...capturedItems].reverse());
});

test('briefing falls back to the count summary when synthesis returns null', async () => {
  const householdId = 556;
  // Seeded so the builder has real items to hand the synthesis pass — with an
  // empty list, "did synthesis run?" and "was synthesis wired in at all?" look
  // identical, which is what made the original version of this test vacuous.
  await Insight.bulkCreate([
    {
      householdId, userId: null, type: 'merchant_spend_spike', severity: 'warning',
      title: 'Fallback A', description: null, entityType: null, entityId: null,
      status: 'open', fingerprint: 'fallback-a', metadata: null,
      detectedAt: new Date('2026-09-01T00:00:00Z'),
    },
    {
      householdId, userId: null, type: 'merchant_spend_spike', severity: 'warning',
      title: 'Fallback B', description: null, entityType: null, entityId: null,
      status: 'open', fingerprint: 'fallback-b', metadata: null,
      detectedAt: new Date('2026-09-02T00:00:00Z'),
    },
  ] as never);

  let calls = 0;
  let capturedItems: CfoBriefingActionItem[] = [];
  const result = await buildCfoBriefing({
    req: fakeReq(1, householdId),
    householdId,
    userId: 1,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-07',
    currency: 'CAD',
    synthesizeImpl: async ({ items }) => {
      calls += 1;
      capturedItems = items;
      // A null summary must NOT also discard the model's ordering.
      return { summary: null, ordered: [...items].reverse() };
    },
  });

  // Fails loudly if the synthesis pass is ever unwired from buildCfoBriefing.
  assert.equal(calls, 1, 'synthesizeImpl must be invoked exactly once');
  assert.ok(capturedItems.length >= 2, 'synthesis must receive the built items');
  assert.deepEqual(
    result.actionItems.map((i) => i.id),
    [...capturedItems].reverse().map((i) => i.id),
    'the synthesis ordering must survive a null summary',
  );
  assert.match(result.summary, /action item|All clear/);
  assert.equal(result.model, 'deterministic', 'no LLM summary → deterministic provenance');
});

test('briefing records the model as provenance when synthesis writes the summary', async () => {
  const householdId = 557;
  await Insight.create({
    householdId, userId: null, type: 'merchant_spend_spike', severity: 'warning',
    title: 'Provenance', description: null, entityType: null, entityId: null,
    status: 'open', fingerprint: 'provenance', metadata: null,
    detectedAt: new Date('2026-09-02T00:00:00Z'),
  } as never);

  const result = await buildCfoBriefing({
    req: fakeReq(1, householdId),
    householdId,
    userId: 1,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-07',
    currency: 'CAD',
    synthesizeImpl: async ({ items }) => ({ summary: 'Synthesized.', ordered: items }),
  });

  assert.equal(result.summary, 'Synthesized.');
  assert.notEqual(
    result.model,
    'deterministic',
    'a synthesized briefing must not be stored as deterministic',
  );
});
