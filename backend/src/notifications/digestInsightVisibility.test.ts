/**
 * In-memory DB tests for the weekly digest's open-insight rollup.
 *
 * The leak these lock down: detectors write `Insight` rows household-wide with
 * no viewer, and `loadOpenInsightRollup` used to read every open row for the
 * recipient's households with no visibility filter — so an insight derived
 * from the OTHER partner's private transaction had its merchant and amount
 * emailed out. Email leaves the app, which makes this the worst instance of
 * the leak `backend/src/insights/visibility.ts` exists to close.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let models: typeof import('../models');
let buildDigestForUser: typeof import('./digest').buildDigestForUser;

// Real FK targets, filled in by `before`.
let HOUSEHOLD_ID = 0;
let ALICE = 0;
let BOB = 0;
let ACCOUNT_ID = 0;

/** Inside the digest's reporting week for the `AS_OF` tick below. */
const AS_OF = new Date('2026-05-11T09:00:00Z'); // a Monday
const IN_WEEK_DATE = '2026-05-06';

async function makeUser(name: string): Promise<number> {
  const u = await models.User.create({
    email: `${name}-${crypto.randomBytes(4).toString('hex')}@test.local`,
    displayName: name,
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  });
  return u.id;
}

async function createTxn(
  createdByUserId: number,
  visibility: 'shared' | 'private',
): Promise<number> {
  const t = await models.Transaction.create({
    accountId: ACCOUNT_ID,
    householdId: HOUSEHOLD_ID,
    visibility,
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'digest-visibility-test',
    date: IN_WEEK_DATE,
    merchantRaw: 'Somewhere',
    merchantClean: 'Somewhere',
    amount: '-120.0000',
    currency: 'CAD',
    txnType: 'purchase',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: 'Shopping',
    autoBusiness: null,
    businessOverride: null,
    autoSplitType: null,
    splitOverride: null,
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId,
  });
  return t.id;
}

async function createInsight(opts: {
  title: string;
  type?: string;
  severity?: 'info' | 'warning' | 'critical';
  entityId?: number | null;
  transactionIds?: number[];
}): Promise<number> {
  const row = await models.Insight.create({
    householdId: HOUSEHOLD_ID,
    userId: null,
    type: (opts.type ?? 'merchant_spend_spike') as never,
    severity: opts.severity ?? 'warning',
    title: opts.title,
    description: `${opts.title} description`,
    entityType: opts.entityId != null ? 'transaction' : null,
    entityId: opts.entityId ?? null,
    status: 'open',
    fingerprint: crypto.randomBytes(8).toString('hex'),
    metadata: opts.transactionIds ? { transactionIds: opts.transactionIds } : null,
    detectedAt: new Date('2026-05-08T00:00:00Z'),
  });
  return row.id;
}

before(async () => {
  models = await import('../models');
  sequelize = models.sequelize;
  ({ buildDigestForUser } = await import('./digest'));
  await sequelize.sync({ force: true });

  const hh = await models.Household.create({ name: 'Digest visibility' });
  HOUSEHOLD_ID = hh.id;
  ALICE = await makeUser('alice');
  BOB = await makeUser('bob');
  for (const userId of [ALICE, BOB]) {
    await models.HouseholdMember.create({
      householdId: HOUSEHOLD_ID,
      userId,
      role: 'owner',
    });
  }
  const account = await models.Account.create({
    householdId: HOUSEHOLD_ID,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name: 'Digest card',
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: 'DIG',
  });
  ACCOUNT_ID = account.id;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await models.Insight.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
});

test("the digest hides an insight backed by the other partner's private txn", async () => {
  const bobsSecret = await createTxn(BOB, 'private');
  await createInsight({ title: 'Spike at Secret Merchant $420', entityId: bobsSecret });

  const alices = await buildDigestForUser(ALICE, AS_OF);
  const bobs = await buildDigestForUser(BOB, AS_OF);

  assert.ok(alices, 'alice has history, so she gets a digest');
  assert.deepEqual(
    alices.topInsights.map((i) => i.title),
    [],
    "the private transaction's merchant and amount must not reach alice's inbox",
  );
  assert.equal(alices.openInsightCount, 0, 'the count excludes it too');

  assert.ok(bobs);
  assert.deepEqual(bobs.topInsights.map((i) => i.title), ['Spike at Secret Merchant $420']);
  assert.equal(bobs.openInsightCount, 1, 'its own creator still sees it');
});

test('the digest keeps an insight backed by a shared txn', async () => {
  const shared = await createTxn(BOB, 'shared');
  await createInsight({ title: 'Spike at Shared Merchant', entityId: shared });

  const alices = await buildDigestForUser(ALICE, AS_OF);

  assert.ok(alices);
  assert.deepEqual(alices.topInsights.map((i) => i.title), ['Spike at Shared Merchant']);
  assert.equal(alices.openInsightCount, 1);
});

test('the digest keeps an insight with no transaction backing', async () => {
  await createTxn(BOB, 'private'); // history so the digest is built at all
  await createInsight({ title: 'Cash runway below 30 days', type: 'cash_runway_low' });

  const alices = await buildDigestForUser(ALICE, AS_OF);

  assert.ok(alices);
  assert.deepEqual(
    alices.topInsights.map((i) => i.title),
    ['Cash runway below 30 days'],
    'household-level facts are not derived from anyone’s private data',
  );
  assert.equal(alices.openInsightCount, 1);
});

test('metadata.transactionIds is scoped too, and hidden rows never take a top-3 slot', async () => {
  const shared = await createTxn(ALICE, 'shared');
  const bobsSecret = await createTxn(BOB, 'private');

  // Four criticals ahead of the one visible warning: without filtering they
  // would fill all three slots and push the warning out entirely.
  for (let i = 0; i < 4; i += 1) {
    await createInsight({
      title: `Duplicate at Secret Merchant #${i}`,
      type: 'duplicate_transactions',
      severity: 'critical',
      transactionIds: [bobsSecret],
    });
  }
  await createInsight({
    title: 'Duplicate at Shared Merchant',
    type: 'duplicate_transactions',
    severity: 'warning',
    transactionIds: [shared],
  });

  const alices = await buildDigestForUser(ALICE, AS_OF);

  assert.ok(alices);
  assert.deepEqual(
    alices.topInsights.map((i) => i.title),
    ['Duplicate at Shared Merchant'],
    'filtering happens before slice(0, 3), so the visible row still surfaces',
  );
  assert.equal(
    alices.openInsightCount,
    1,
    'the count reflects the filtered set, not the 5 raw rows',
  );
});
