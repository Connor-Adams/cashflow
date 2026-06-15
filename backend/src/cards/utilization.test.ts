/**
 * Unit tests for credit-card utilization helpers.
 *
 * currentOwed is DB-backed (it reads the account's transaction stream via
 * balanceAtDate), so these run against the per-process SQLite test DB. FX is
 * dependency-injected so foreign-currency conversion is deterministic without
 * a live Bank of Canada fetch.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { FxLookup } from '../networth/unifyToCad';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let currentOwed: typeof import('./utilization').currentOwed;
let utilizationPct: typeof import('./utilization').utilizationPct;
let household: { id: number };

// Stub FX: USD→CAD = 1.4, everything else unknown.
const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.4, ratedDate: asOf };
  return null;
};

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  const mod = await import('./utilization');
  currentOwed = mod.currentOwed;
  utilizationPct = mod.utilizationPct;
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Cards Test HH' });
});

async function seedCard(defaultCurrency = 'CAD') {
  return models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name: 'Visa',
    accountType: 'credit_card',
    defaultCurrency,
    shortCode: 'VIS',
  } as never);
}

async function seedTxn(accountId: number, amount: number, currency: string, date = '2026-01-10') {
  await models.Transaction.create({
    accountId,
    householdId: household.id,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'cards-test',
    date,
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: amount.toFixed(4),
    currency,
    txnType: 'purchase',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
}

test('currentOwed: CAD-only card returns the magnitude of its negative balance', async () => {
  const card = await seedCard('CAD');
  await seedTxn(card.id, -500, 'CAD');
  const owed = await currentOwed(card, '2026-02-01', stubFx);
  assert.equal(owed, 500);
});

test('currentOwed: positive (credit) balance yields 0 owed', async () => {
  const card = await seedCard('CAD');
  await seedTxn(card.id, 250, 'CAD');
  const owed = await currentOwed(card, '2026-02-01', stubFx);
  assert.equal(owed, 0);
});

test('currentOwed: foreign-currency bucket is FX-converted to CAD and summed, not dropped', async () => {
  const card = await seedCard('CAD');
  // -300 CAD charge plus a -100 USD charge on the same CAD card. Pre-fix the
  // USD bucket is silently dropped (owed = 300). Connor's decision: convert
  // the USD leg to CAD (100 × 1.4 = 140) and sum → 440 owed.
  await seedTxn(card.id, -300, 'CAD');
  await seedTxn(card.id, -100, 'USD');
  const owed = await currentOwed(card, '2026-02-01', stubFx);
  assert.equal(owed, 440);
});

test('currentOwed: foreign and default buckets that net positive yield 0 owed', async () => {
  const card = await seedCard('CAD');
  // -100 USD (= -140 CAD) plus +200 CAD nets to +60 CAD → a credit, 0 owed.
  await seedTxn(card.id, -100, 'USD');
  await seedTxn(card.id, 200, 'CAD');
  const owed = await currentOwed(card, '2026-02-01', stubFx);
  assert.equal(owed, 0);
});

test('currentOwed: USD-default card keeps owed in USD (not converted to CAD)', async () => {
  // A natively-USD card with a -200 USD charge must report owed = 200 USD so it
  // stays comparable to its USD credit limit on the per-currency utilization
  // dashboard. Converting it to CAD would mis-scale that ratio.
  const card = await seedCard('USD');
  await seedTxn(card.id, -200, 'USD');
  const owed = await currentOwed(card, '2026-02-01', stubFx);
  assert.equal(owed, 200);
});

test('utilizationPct: owed / limit × 100', () => {
  assert.equal(utilizationPct(440, 1000), 44);
  assert.equal(utilizationPct(0, 1000), 0);
  assert.equal(utilizationPct(500, null), null);
  assert.equal(utilizationPct(500, 0), null);
});
