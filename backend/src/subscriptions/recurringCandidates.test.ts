/**
 * The shared recurring-candidate loader, plus a parity check that the app's
 * /api/recurring and the external /api/v1/recurring infer the same recurring
 * charges from the same rows (they used to run divergent copies of the loader).
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { toRecurringCandidates, type RecurringCandidateRow } from './recurringCandidates';

process.env.DATABASE_PATH = ':memory:';

const row = (over: Partial<RecurringCandidateRow>): RecurringCandidateRow => ({
  date: '2026-01-05',
  currency: 'CAD',
  amount: '-15.99',
  merchantRaw: 'NETFLIX.COM',
  merchantClean: 'Netflix',
  finalCategory: 'Streaming',
  ...over,
});

test('toRecurringCandidates: keeps charges, drops credits, payment-text rows and blank merchants', () => {
  const out = toRecurringCandidates([
    row({}),
    row({ amount: '15.99' }), // refund / credit
    row({ merchantClean: 'Rogers Bill Payment', merchantRaw: 'ROGERS BILL PAYMENT' }),
    row({ merchantClean: '  ', merchantRaw: '  ' }),
    row({ merchantClean: null, merchantRaw: '  Spotify  ' }),
    row({ amount: null }),
  ]);
  assert.deepEqual(
    out.map((c) => [c.merchant, c.amount]),
    [
      ['Netflix', -15.99],
      ['Spotify', -15.99],
    ],
  );
});

// ---- route parity ---------------------------------------------------------

let models: typeof import('../models');
let app: express.Express;
let household: { id: number };

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const recurringRouter = (await import('../routes/recurring')).default;
  const reportingRouter = (await import('../routes/reporting')).default;
  app = express();
  app.use((req, _res, next) => {
    req.auth = {
      user: { id: 1, globalRole: 'member' },
      household,
      role: 'owner',
    } as unknown as NonNullable<typeof req.auth>;
    req.reportingAuth = { household } as unknown as NonNullable<typeof req.reportingAuth>;
    next();
  });
  app.use('/app/recurring', recurringRouter);
  app.use('/v1', reportingRouter);
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.PlannedEvent.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Recurring Parity HH' });
});

function isoDaysAgo(offset: number): string {
  return new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
}

async function seed(accountId: number, merchant: string, amount: number, txnType: string, daysAgo: number) {
  await models.Transaction.create({
    accountId,
    householdId: household.id,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'parity-test',
    date: isoDaysAgo(daysAgo),
    merchantRaw: merchant.toUpperCase(),
    merchantClean: merchant,
    amount: amount.toFixed(4),
    currency: 'CAD',
    txnType,
    finalCategory: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
}

test('same rows → same recurring candidates through /api/recurring and /api/v1/recurring', async () => {
  const acc = await models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name: 'Visa',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
    shortCode: 'VIS',
  } as never);
  for (const d of [95, 65, 35, 5]) {
    // A genuine subscription.
    await seed(acc.id, 'Netflix', -15.99, 'purchase', d);
    // Bill-pay typed 'purchase': the merchant-text classifier drops it; the
    // old /api/v1 SQL txnType filter let it through as a "subscription".
    await seed(acc.id, 'Rogers Bill Payment', -90, 'purchase', d);
    // Typed 'refund' but a real negative charge: the app keeps it; the old
    // /api/v1 txnType NOT IN filter dropped it.
    await seed(acc.id, 'Gym', -40, 'refund', d);
  }

  const appRes = await request(app).get('/app/recurring?windowDays=180');
  assert.equal(appRes.status, 200);
  const v1Res = await request(app).get('/v1/recurring');
  assert.equal(v1Res.status, 200);

  const appMerchants = (appRes.body.items as Array<{ merchant: string }>)
    .map((i) => i.merchant)
    .sort();
  const v1Merchants = (v1Res.body.recurringItems as Array<{ id: string; name: string }>)
    .filter((i) => i.id.startsWith('inf-'))
    .map((i) => i.name)
    .sort();
  assert.deepEqual(appMerchants, ['Gym', 'Netflix']);
  assert.deepEqual(v1Merchants, appMerchants);
});
