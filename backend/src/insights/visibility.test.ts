/**
 * In-memory DB tests for read-time insight visibility scoping.
 *
 * The leak these lock down: `Insight` rows are produced household-wide by
 * detectors that run with no viewer, so before this filter an insight derived
 * from one partner's PRIVATE transaction surfaced to the other partner —
 * title and description carry the merchant and the amount.
 */
import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Request } from 'express';

process.env.DATABASE_PATH = ':memory:';

let sequelize: import('sequelize').Sequelize;
let models: typeof import('../models');
let filterInsightsVisibleTo: typeof import('./visibility').filterInsightsVisibleTo;
let filterInsightsVisibleToUser: typeof import('./visibility').filterInsightsVisibleToUser;
let backingTransactionIds: typeof import('./visibility').backingTransactionIds;

// Real FK targets, filled in by `before`: transactions carry FKs to
// accounts/users, so invented ids trip SQLite's FOREIGN KEY constraint.
let HOUSEHOLD_ID = 0;
let ME = 0;
let PARTNER = 0;
let ACCOUNT_ID = 0;

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

before(async () => {
  models = await import('../models');
  sequelize = models.sequelize;
  ({ filterInsightsVisibleTo, filterInsightsVisibleToUser, backingTransactionIds } =
    await import('./visibility'));
  await sequelize.sync({ force: true });

  const hh = await models.Household.create({ name: 'Visibility' });
  HOUSEHOLD_ID = hh.id;
  ME = await makeUser('me');
  PARTNER = await makeUser('partner');
  const account = await models.Account.create({
    householdId: HOUSEHOLD_ID,
    ownerUserId: null,
    owner: 'me',
    visibility: 'shared',
    name: 'Visibility card',
    accountType: 'credit',
    defaultCurrency: 'CAD',
    shortCode: 'VIS',
  });
  ACCOUNT_ID = account.id;
});

after(async () => {
  await sequelize.close();
});

beforeEach(async () => {
  await models.Transaction.destroy({ where: {}, truncate: true });
});

/**
 * `currentAuth(req)` just returns `req.auth`, so a plain object carrying the
 * fields `visibleTransactionWhere` reads is a sufficient fake — the same
 * pattern already used in `backend/src/auth/scope.test.ts` and
 * `backend/src/cfo/cfoBriefingBuilder.test.ts`.
 */
function fakeReq(userId: number, globalRole = 'user'): Request {
  return {
    auth: {
      user: { id: userId, globalRole },
      household: { id: HOUSEHOLD_ID },
      role: 'owner',
    },
  } as unknown as Request;
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
    importBatch: 'visibility-test',
    date: '2026-05-01',
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
    finalCategory: null,
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

/** Insight-shaped literal: only the three fields the filter reads. */
function insight(
  label: string,
  fields: { entityType?: string | null; entityId?: number | null; metadata?: unknown },
) {
  return {
    label,
    entityType: fields.entityType ?? null,
    entityId: fields.entityId ?? null,
    metadata: fields.metadata ?? null,
  };
}

test('backingTransactionIds unions entityId and metadata.transactionIds', () => {
  assert.deepEqual(
    backingTransactionIds({
      entityType: 'transaction',
      entityId: 5,
      metadata: { transactionIds: [7, 5, 9] },
    }),
    [7, 5, 9],
    'the entityId is deduped against the metadata ids',
  );
  assert.deepEqual(
    backingTransactionIds({ entityType: 'transaction', entityId: 5, metadata: null }),
    [5],
  );
  assert.deepEqual(
    backingTransactionIds({ entityType: 'money_leak', entityId: 5, metadata: null }),
    [],
    'entityId only counts when entityType is transaction',
  );
});

test('an insight backed by a shared transaction is visible to both partners', async () => {
  const shared = await createTxn(ME, 'shared');
  const rows = [insight('shared', { entityType: 'transaction', entityId: shared })];

  const mine = await filterInsightsVisibleTo(fakeReq(ME), rows);
  const theirs = await filterInsightsVisibleTo(fakeReq(PARTNER), rows);

  assert.deepEqual(mine.map((r) => r.label), ['shared']);
  assert.deepEqual(theirs.map((r) => r.label), ['shared']);
});

test('an insight backed by a private transaction is visible only to its creator', async () => {
  const secret = await createTxn(ME, 'private');
  const rows = [insight('secret', { entityType: 'transaction', entityId: secret })];

  const mine = await filterInsightsVisibleTo(fakeReq(ME), rows);
  const theirs = await filterInsightsVisibleTo(fakeReq(PARTNER), rows);

  assert.deepEqual(mine.map((r) => r.label), ['secret']);
  assert.deepEqual(theirs, [], "the other partner must not see the private txn's insight");
});

test('the same rule holds for metadata.transactionIds, not just entityId', async () => {
  const secret = await createTxn(PARTNER, 'private');
  const rows = [insight('meta-secret', { metadata: { transactionIds: [secret] } })];

  assert.deepEqual(
    (await filterInsightsVisibleTo(fakeReq(PARTNER), rows)).map((r) => r.label),
    ['meta-secret'],
  );
  assert.deepEqual(await filterInsightsVisibleTo(fakeReq(ME), rows), []);
});

test('an insight with no backing transactions passes through to both partners', async () => {
  // cash_runway_low / settlement_imbalance shape: a household-level fact.
  const rows = [insight('runway', {})];

  assert.deepEqual(
    (await filterInsightsVisibleTo(fakeReq(ME), rows)).map((r) => r.label),
    ['runway'],
  );
  assert.deepEqual(
    (await filterInsightsVisibleTo(fakeReq(PARTNER), rows)).map((r) => r.label),
    ['runway'],
  );
});

test('a mix of shared and other-partner-private transactions drops the whole insight', async () => {
  const shared = await createTxn(ME, 'shared');
  const partnerSecret = await createTxn(PARTNER, 'private');
  const rows = [
    insight('mixed', {
      entityType: 'transaction',
      entityId: shared,
      metadata: { transactionIds: [shared, partnerSecret] },
    }),
    insight('all-shared', { metadata: { transactionIds: [shared] } }),
  ];

  const mine = await filterInsightsVisibleTo(fakeReq(ME), rows);

  assert.deepEqual(
    mine.map((r) => r.label),
    ['all-shared'],
    'a partially-visible insight leaks the hidden amount through its title, so it goes entirely',
  );
});

test('a backing transaction that no longer exists drops the insight', async () => {
  const rows = [insight('dangling', { entityType: 'transaction', entityId: 99999 })];
  assert.deepEqual(await filterInsightsVisibleTo(fakeReq(ME), rows), []);
});

test('superadmins see every insight', async () => {
  const secret = await createTxn(PARTNER, 'private');
  const rows = [insight('secret', { entityType: 'transaction', entityId: secret })];

  const seen = await filterInsightsVisibleTo(fakeReq(ME, 'superadmin'), rows);

  assert.deepEqual(seen.map((r) => r.label), ['secret']);
});

test('visibility is resolved in a single batched query, not one per insight', async () => {
  const shared = await createTxn(ME, 'shared');
  const rows = Array.from({ length: 12 }, (_, i) =>
    insight(`row-${i}`, { entityType: 'transaction', entityId: shared }),
  );

  let selects = 0;
  const original = sequelize.options.logging;
  sequelize.options.logging = (sql: string) => {
    if (/^Executing \(default\): SELECT/.test(sql)) selects += 1;
  };
  try {
    const out = await filterInsightsVisibleTo(fakeReq(ME), rows);
    assert.equal(out.length, 12);
  } finally {
    sequelize.options.logging = original;
  }

  assert.equal(selects, 1, 'one SELECT for all 12 insights');
});

// ---- request-free variant (background jobs, e.g. the weekly digest) --------

test('filterInsightsVisibleToUser applies the same rule with no request', async () => {
  const shared = await createTxn(PARTNER, 'shared');
  const secret = await createTxn(PARTNER, 'private');
  const rows = [
    insight('shared', { entityType: 'transaction', entityId: shared }),
    insight('secret', { metadata: { transactionIds: [secret] } }),
    insight('runway', {}),
  ];

  assert.deepEqual(
    (await filterInsightsVisibleToUser(ME, rows)).map((r) => r.label),
    ['shared', 'runway'],
  );
  assert.deepEqual(
    (await filterInsightsVisibleToUser(PARTNER, rows)).map((r) => r.label),
    ['shared', 'secret', 'runway'],
  );
});

test('filterInsightsVisibleToUser has no superadmin bypass', async () => {
  // A background job runs on behalf of one ordinary user; there is no role to
  // elevate. Even ME's own globalRole is irrelevant — only the id is consulted.
  const secret = await createTxn(PARTNER, 'private');
  const rows = [insight('secret', { entityType: 'transaction', entityId: secret })];

  assert.deepEqual(await filterInsightsVisibleToUser(ME, rows), []);
});

test('filterInsightsVisibleToUser honours the optional household scope', async () => {
  const shared = await createTxn(PARTNER, 'shared');
  const rows = [insight('shared', { entityType: 'transaction', entityId: shared })];

  assert.deepEqual(
    (await filterInsightsVisibleToUser(ME, rows, { householdIds: [HOUSEHOLD_ID] })).map(
      (r) => r.label,
    ),
    ['shared'],
  );
  assert.deepEqual(
    await filterInsightsVisibleToUser(ME, rows, { householdIds: [HOUSEHOLD_ID + 999] }),
    [],
    'a backing transaction outside the given households is not visible',
  );
});

test('filterInsightsVisibleToUser batches into a single query too', async () => {
  const shared = await createTxn(ME, 'shared');
  const rows = Array.from({ length: 12 }, (_, i) =>
    insight(`row-${i}`, { entityType: 'transaction', entityId: shared }),
  );

  let selects = 0;
  const original = sequelize.options.logging;
  sequelize.options.logging = (sql: string) => {
    if (/^Executing \(default\): SELECT/.test(sql)) selects += 1;
  };
  try {
    const out = await filterInsightsVisibleToUser(ME, rows);
    assert.equal(out.length, 12);
  } finally {
    sequelize.options.logging = original;
  }

  assert.equal(selects, 1, 'one SELECT for all 12 insights');
});
