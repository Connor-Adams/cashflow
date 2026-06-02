import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'crypto';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let corpEntityId: number;

before(async () => {
  process.env.NODE_ENV = 'test';
  const { sequelize } = await import('../../src/db.js');
  const models = await import('../../src/models/index.js');
  await sequelize.sync({ force: true });
  const mod = await import('../../src/app.js');
  app = mod.default;
  const { hashPassword, hashToken } = await import('../../src/auth/password.js');
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: `slbal-${Date.now()}@example.com`, displayName: 'SL', globalRole: 'user',
    passwordHash: password.hash, passwordSalt: password.salt, passwordParams: password.params,
  });
  const household = await models.Household.create({ name: 'SL HH' });
  await models.HouseholdMember.create({ householdId: household.id, userId: user.id, role: 'owner' });
  const corp = await models.Entity.create({
    householdId: household.id, kind: 'corp', legalName: 'Corp', jurisdiction: 'CA-ON', fiscalYearEnd: '12-31',
  } as never);
  corpEntityId = corp.id;
  const token = crypto.randomBytes(32).toString('hex');
  await models.Session.create({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 86400000) });
  authed = request.agent(app);
  authed.jar.setCookie(`cashflow_session=${token}; Path=/`);
});

after(async () => { const { sequelize } = await import('../../src/db.js'); await sequelize.close(); });

test('GET /corp/shareholder-loans includes computed balance', async () => {
  const models = await import('../../src/models/index.js');
  await models.ShareholderLoan.create({ entityId: corpEntityId, date: '2025-01-01', kind: 'advance', amount: '10000.0000' } as never);
  await models.ShareholderLoan.create({ entityId: corpEntityId, date: '2025-02-01', kind: 'repayment', amount: '2000.0000' } as never);
  const res = await authed.get('/api/tax/corp/shareholder-loans');
  assert.equal(res.status, 200);
  assert.equal(res.body.balance, '8000.00');
});
