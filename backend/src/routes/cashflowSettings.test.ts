/**
 * Route-level tests for GET / PATCH /api/settings/cashflow — the endpoint the
 * Settings → Cashflow tab saves through. Covers the HTTP contract the UI
 * relies on: defaults before any write, each field round-tripping, and a 400
 * (with nothing persisted) for values the validator rejects.
 *
 * Stubbed req.auth on the per-process SQLite test DB, matching
 * ./counterpartyRolePatch.test.ts.
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let app: express.Express;

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const household = await models.Household.create({ name: 'Cashflow Settings HH' });
  const user = await models.User.create({
    email: 'cashflow-settings@test.local',
    displayName: 'Cashflow Settings User',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);

  const router = (await import('./cashflowSettings')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: user.id, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    next();
  });
  app.use('/api/settings/cashflow', router);
});

test('GET returns the bundled defaults before any write', async () => {
  const res = await request(app).get('/api/settings/cashflow');
  assert.equal(res.status, 200);
  assert.equal(res.body.safeToSpendWindowDays, 14);
  assert.equal(res.body.includeCreditCardBalance, true);
  assert.equal(res.body.includeGoalContributions, true);
  assert.equal(res.body.excludeNonPartnerInflows, true);
  assert.equal(Number(res.body.minimumCashBuffer), 0);
  assert.equal(Number(res.body.largePurchaseThreshold), 500);
  assert.equal(Number(res.body.assumedAnnualReturnRate), 0.05);
});

const SAVES: [string, unknown, (body: Record<string, unknown>) => void][] = [
  ['minimumCashBuffer', 2500, (b) => assert.equal(Number(b.minimumCashBuffer), 2500)],
  ['safeToSpendWindowDays', 30, (b) => assert.equal(b.safeToSpendWindowDays, 30)],
  ['includeCreditCardBalance', false, (b) => assert.equal(b.includeCreditCardBalance, false)],
  ['includeGoalContributions', false, (b) => assert.equal(b.includeGoalContributions, false)],
  ['largePurchaseThreshold', 1200, (b) => assert.equal(Number(b.largePurchaseThreshold), 1200)],
  ['assumedAnnualReturnRate', 0.07, (b) => assert.equal(Number(b.assumedAnnualReturnRate), 0.07)],
  ['excludeNonPartnerInflows', false, (b) => assert.equal(b.excludeNonPartnerInflows, false)],
];

for (const [field, value, check] of SAVES) {
  test(`PATCH saves ${field} and GET reads it back`, async () => {
    const patched = await request(app)
      .patch('/api/settings/cashflow')
      .send({ [field]: value });
    assert.equal(patched.status, 200);
    check(patched.body);
    const read = await request(app).get('/api/settings/cashflow');
    check(read.body);
  });
}

const REJECTS: [string, unknown][] = [
  ['minimumCashBuffer', -1],
  ['minimumCashBuffer', ''],
  ['minimumCashBuffer', 1e12],
  ['safeToSpendWindowDays', 0],
  ['safeToSpendWindowDays', 366],
  ['safeToSpendWindowDays', 7.5],
  ['largePurchaseThreshold', -5],
  ['largePurchaseThreshold', ''],
  ['assumedAnnualReturnRate', 1.5],
  ['assumedAnnualReturnRate', null],
  ['includeCreditCardBalance', 'maybe'],
];

for (const [field, value] of REJECTS) {
  test(`PATCH rejects ${field}=${JSON.stringify(value)} with 400 and persists nothing`, async () => {
    const before = await request(app).get('/api/settings/cashflow');
    const res = await request(app)
      .patch('/api/settings/cashflow')
      .send({ [field]: value });
    assert.equal(res.status, 400);
    assert.match(res.body.error, new RegExp(field));
    const after = await request(app).get('/api/settings/cashflow');
    assert.deepEqual(after.body, before.body);
  });
}
