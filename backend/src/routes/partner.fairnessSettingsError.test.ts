/**
 * GET /api/partner/fairness — a DB failure reading the viewer's
 * `cashflow_settings` row must surface as an error. It used to be swallowed by
 * a catch meant only for "no auth context", so fairness silently fell back to
 * the default `excludeNonPartnerInflows` and reported numbers computed under
 * the wrong preference.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { CashflowSettings, sequelize } from '../models';
import { seedHousehold } from '../../test/helpers/seedHousehold';

process.env.NODE_ENV = 'test';

let agent: ReturnType<typeof request.agent>;

before(async () => {
  await sequelize.sync({ force: true });
  const seeded = await seedHousehold('fairness-settings-error', 'Partner');
  const { default: app } = await import('../app.js');
  agent = request.agent(app);
  agent.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
});

after(() => {
  mock.restoreAll();
});

test('fairness returns 200 with the default preference when no settings row exists', async () => {
  const res = await agent.get('/api/partner/fairness');
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('a CashflowSettings lookup failure is a 5xx, not a silent fallback to the default', async () => {
  const findOne = mock.method(CashflowSettings, 'findOne', async () => {
    throw new Error('relation "cashflow_settings" does not exist');
  });
  try {
    const res = await agent.get('/api/partner/fairness');
    assert.ok(res.status >= 500, `expected 5xx, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(findOne.mock.callCount() >= 1);
  } finally {
    findOne.mock.restore();
  }
});
