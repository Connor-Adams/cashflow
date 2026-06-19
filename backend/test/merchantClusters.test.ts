/**
 * Unit tests for the merchant-cluster service (issue #793),
 * `backend/src/merchants/clusters.ts::listMerchantClusters`.
 *
 * Runs against the per-process SQLite unit DB (no Postgres). The raw SQL in
 * the service is written to run on both dialects; these tests lock the
 * grouping, per-currency scoping, spend math (negative-amount rows only),
 * dominant-category / dominant-canonical derivation, sort order, and
 * household isolation. The route-level auth / validation paths are covered by
 * the Postgres integration suite (`integration/merchantClusters.test.ts`).
 */
import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../src/models');
let listMerchantClusters: typeof import('../src/merchants/clusters').listMerchantClusters;
let householdId: number;
let otherHouseholdId: number;
let accountId: number;
let seq = 0;

before(async () => {
  models = await import('../src/models');
  ({ listMerchantClusters } = await import('../src/merchants/clusters'));
  await models.sequelize.sync({ force: true });
});

beforeEach(async () => {
  await models.Transaction.destroy({ where: {} });
  await models.Account.destroy({ where: {} });
  await models.Household.destroy({ where: {} });
  const hh = await models.Household.create({ name: 'Clusters HH' });
  householdId = hh.id;
  const other = await models.Household.create({ name: 'Other HH' });
  otherHouseholdId = other.id;
  const acct = await models.Account.create({
    householdId,
    owner: 'me',
    visibility: 'shared',
    name: 'Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
    shortCode: `U-${Date.now()}-${seq++}`,
  });
  accountId = acct.id;
});

type Seed = {
  hh?: number;
  amount: number;
  currency?: string;
  raw?: string;
  clean: string;
  canonical?: string | null;
  category?: string | null;
};

async function tx(seed: Seed): Promise<void> {
  seq += 1;
  await models.Transaction.create({
    accountId,
    householdId: seed.hh ?? householdId,
    createdByUserId: null,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'unit-clusters',
    date: '2026-01-01',
    merchantRaw: seed.raw ?? seed.clean,
    merchantClean: seed.clean,
    merchantCanonical: seed.canonical ?? null,
    amount: seed.amount.toFixed(4),
    currency: seed.currency ?? 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `f-${seq}-${Math.random()}`,
    sourceIdentityFingerprint: `i-${seq}-${Math.random()}`,
    appliedRuleId: null,
    finalCategory: seed.category ?? null,
    autoCategory: null,
    categoryOverride: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: '0',
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'purchase',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
  });
}

test('groups by merchant_clean, sums only negative-amount spend, sorts by spend desc', async () => {
  await tx({ amount: -50, clean: 'BLUE BOTTLE COFFEE', raw: 'SQ *BLUE BOTTLE', category: 'Coffee' });
  await tx({ amount: -20, clean: 'BLUE BOTTLE COFFEE', raw: 'BLUE BOTTLE #12', category: 'Coffee' });
  await tx({ amount: -10, clean: 'BLUE BOTTLE COFFEE', raw: 'BLUE BOTTLE', category: 'Dining' });
  await tx({ amount: 7, clean: 'BLUE BOTTLE COFFEE', raw: 'REFUND', category: 'Coffee' }); // credit, excluded from spend
  await tx({ amount: -5, clean: 'TINY CAFE', raw: 'TINY CAFE', category: 'Coffee' });

  const clusters = await listMerchantClusters(householdId, 'CAD');
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].merchantClean, 'BLUE BOTTLE COFFEE', 'biggest spend first');
  assert.equal(clusters[0].totalSpend, '80.00', 'refund excluded from spend');
  assert.equal(clusters[0].count, 4, 'count includes the refund row');
  assert.equal(clusters[0].dominantCategory, 'Coffee');
  assert.equal(clusters[1].merchantClean, 'TINY CAFE');
  assert.equal(clusters[1].totalSpend, '5.00');

  const spread = clusters[0].categorySpread;
  assert.ok(spread.length >= 2, 'mixed category spread surfaced');
  assert.equal(spread[0].category, 'Coffee', 'dominant category leads the spread');
  assert.equal(spread[0].count, 3);
});

test('scopes to a single currency', async () => {
  await tx({ amount: -100, clean: 'GLOBAL SHOP', currency: 'CAD' });
  await tx({ amount: -200, clean: 'GLOBAL SHOP', currency: 'USD' });

  const cad = await listMerchantClusters(householdId, 'CAD');
  assert.equal(cad.length, 1);
  assert.equal(cad[0].totalSpend, '100.00');
  assert.equal(cad[0].currency, 'CAD');

  const usd = await listMerchantClusters(householdId, 'USD');
  assert.equal(usd.length, 1);
  assert.equal(usd[0].totalSpend, '200.00');
});

test('dominant canonical is the most-frequent non-null merchant_canonical', async () => {
  await tx({ amount: -1, clean: 'STARBUCKS', canonical: 'Starbucks' });
  await tx({ amount: -1, clean: 'STARBUCKS', canonical: 'Starbucks' });
  await tx({ amount: -1, clean: 'STARBUCKS', canonical: 'SBUX Wrong' });
  await tx({ amount: -1, clean: 'STARBUCKS', canonical: null });

  const clusters = await listMerchantClusters(householdId, 'CAD');
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].canonical, 'Starbucks');
});

test('excludes blank merchant_clean and isolates households', async () => {
  await tx({ amount: -10, clean: '   ' }); // blank → excluded
  await tx({ amount: -10, clean: 'MINE' });
  await tx({ amount: -10, clean: 'THEIRS', hh: otherHouseholdId });

  const clusters = await listMerchantClusters(householdId, 'CAD');
  const cleans = clusters.map((c) => c.merchantClean);
  assert.deepEqual(cleans, ['MINE'], 'blank excluded, other household not leaked');
});

test('superadmin (null household) sees all households', async () => {
  await tx({ amount: -10, clean: 'MINE' });
  await tx({ amount: -10, clean: 'THEIRS', hh: otherHouseholdId });

  const clusters = await listMerchantClusters(null, 'CAD');
  const cleans = clusters.map((c) => c.merchantClean).sort();
  assert.deepEqual(cleans, ['MINE', 'THEIRS']);
});

test('returns at most three sample descriptions', async () => {
  await tx({ amount: -1, clean: 'MANY', raw: 'RAW A' });
  await tx({ amount: -1, clean: 'MANY', raw: 'RAW B' });
  await tx({ amount: -1, clean: 'MANY', raw: 'RAW C' });
  await tx({ amount: -1, clean: 'MANY', raw: 'RAW D' });

  const clusters = await listMerchantClusters(householdId, 'CAD');
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0].sampleDescriptions.length <= 3);
  assert.ok(clusters[0].sampleDescriptions.length >= 1);
});
