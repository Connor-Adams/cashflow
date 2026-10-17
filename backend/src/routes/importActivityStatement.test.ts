/**
 * HTTP-boundary tests for POST /api/import/upload-activity-statement.
 *
 * Only the checks that need no real PDF live here — the route itself is thin
 * (extract text, hand the lines to the importer, respond), and the splitting
 * and committing are covered against real line shapes in
 * ../import/importWsActivityStatement.test.ts. Faking a PDF well enough for
 * the extractor is not worth a brittle module stub.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });

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
  // Mirror the app's terminal handler: honour a status the thrower set (multer's
  // fileFilter marks a rejected type 400) and fall back to 500.
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
  const created = await models.Household.create({ name: 'Activity HH' });
  household = { id: created.id };
  await models.Account.create({
    name: 'WS TFSA', householdId: created.id, accountType: 'investment',
    owner: 'me', visibility: 'private', defaultCurrency: 'CAD', shortCode: 'HQ6LMLTK8CAD',
  } as never);
});

after(async () => {
  await models.sequelize.close();
});

const post = () =>
  request(app)
    .post('/api/import/upload-activity-statement')
    .attach('file', Buffer.from('%PDF-1.4 stub', 'utf8'), 'ACTIVITY_STATEMENT.pdf');

test('a CSV is rejected by the uploader', async () => {
  const res = await request(app)
    .post('/api/import/upload-activity-statement')
    .attach('file', Buffer.from('a,b', 'utf8'), 'holdings.csv');
  assert.equal(res.status, 400);
});

test('posting no file is a 400', async () => {
  const res = await request(app).post('/api/import/upload-activity-statement');
  assert.equal(res.status, 400);
});

test('an unreadable PDF fails loudly rather than reporting a clean import', async () => {
  const res = await post();
  assert.notEqual(res.status, 200);
});
