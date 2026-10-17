/**
 * POST /api/import/upload-bundle — the post-bundle `syncTransactionEntityIds`
 * heal is best-effort (it must not fail the import), but its failure must be
 * VISIBLE: without it, rows on a corp-linked account can keep the personal
 * entity and land corporate income on the T1. The failure is surfaced as a
 * warning on every file result.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { ENTITY_SYNC_FAILED_WARNING } from '../tax/services/syncTransactionEntityIds';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const created = await models.Household.create({ name: 'Bundle Sync HH' });
  household = { id: created.id };

  const importRouter = (await import('./import')).default;
  app = express();
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api/import', importRouter);
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
});

after(async () => {
  mock.restoreAll();
});

const SYNC_SQL_MARKER = 'SET entity_id = (';

test('a failed entity-id heal is reported as a warning on the bundle results', async () => {
  const realQuery = models.sequelize.query.bind(models.sequelize);
  const query = mock.method(models.sequelize, 'query', ((sql: unknown, ...rest: unknown[]) => {
    if (typeof sql === 'string' && sql.includes(SYNC_SQL_MARKER)) {
      return Promise.reject(new Error('deadlock detected'));
    }
    return (realQuery as (...a: unknown[]) => unknown)(sql, ...rest);
  }) as typeof models.sequelize.query);
  try {
    const res = await request(app)
      .post('/api/import/upload-bundle')
      .attach('files', Buffer.from('not,a,ws,bundle\n1,2,3,4\n', 'utf8'), 'mystery.csv');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const results = res.body.results as Array<{ warnings: string[] }>;
    assert.equal(results.length, 1);
    assert.ok(
      results.every((r) => r.warnings.includes(ENTITY_SYNC_FAILED_WARNING)),
      `expected the entity-sync warning on every result: ${JSON.stringify(results)}`,
    );
  } finally {
    query.mock.restore();
  }
});

test('a successful heal adds no entity-sync warning', async () => {
  const res = await request(app)
    .post('/api/import/upload-bundle')
    .attach('files', Buffer.from('not,a,ws,bundle\n1,2,3,4\n', 'utf8'), 'mystery2.csv');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const results = res.body.results as Array<{ warnings: string[] }>;
  assert.ok(results.every((r) => !r.warnings.includes(ENTITY_SYNC_FAILED_WARNING)));
});
