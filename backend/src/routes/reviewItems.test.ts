/**
 * DB-backed test proving GET /api/review-items excludes retired AiSuggestion
 * kinds (see RETIRED_AI_SUGGESTION_KINDS in ./reviewItems.ts).
 *
 * `financial_insight` rows are dead data: the engine that produced them
 * (backend/src/ai/insights.ts) was deleted, so their `output` (an array of
 * `{ title, ... }` objects) never reaches the unified inbox — it used to
 * render as a content-less "financial insight" card. This locks the read-path
 * exclusion down at the route level while confirming other AiSuggestion
 * kinds (e.g. transaction_audit) still come through untouched.
 *
 * Mounts the reviewItems router behind a stubbed req.auth (matching the
 * pattern in ./portfolio.test.ts) on the per-process SQLite test DB.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const reviewItemsRouter = (await import('./reviewItems')).default;
  app = express();
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use(reviewItemsRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.AiSuggestion.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Review Items Test HH' });
});

async function seedSuggestion(kind: string, overrides: Record<string, unknown> = {}) {
  return models.AiSuggestion.create({
    householdId: household.id,
    userId: 1,
    transactionId: null,
    receiptId: null,
    kind,
    status: 'suggested',
    output: [{ title: 'Some insight' }],
    ...overrides,
  } as never);
}

test('excludes financial_insight rows from the ai-suggestion source', async () => {
  await seedSuggestion('financial_insight');
  await seedSuggestion('transaction_audit', { output: { headline: 'Audit me' } });

  const res = await request(app).get('/').query({ source: 'ai-suggestion' });
  assert.equal(res.status, 200);
  const data = res.body.data as Array<{ payload: { kind: string } }>;
  const kinds = data.map((d) => d.payload.kind);
  assert.ok(!kinds.includes('financial_insight'), `expected no financial_insight, got ${kinds}`);
  assert.ok(kinds.includes('transaction_audit'), `expected transaction_audit, got ${kinds}`);
  assert.equal(data.length, 1);
});

test('returns an empty ai-suggestion source when only financial_insight rows exist', async () => {
  await seedSuggestion('financial_insight');
  await seedSuggestion('financial_insight');

  const res = await request(app).get('/').query({ source: 'ai-suggestion' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, []);
});
