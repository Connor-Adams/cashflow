/**
 * Rollback must clean up the investment-side rows of a batch (sqlite-backed).
 *
 * Bug: commitStatementImport stamps InvestmentActivity and HoldingSnapshot
 * rows with the same importBatch as the cash transactions, but executeRollback
 * only deleted Transactions (+ their dependents). Rolling back a wrong-account
 * statement import flipped ImportHistory to 'rolled_back' and removed the cash
 * transactions, while the bad activities and holdings kept feeding portfolio
 * valuation and household net worth. A batch containing ONLY investment rows
 * (transactionCount = 0) was blocked with 'not_found' and could never be
 * rolled back at all.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models/index.js');
let rollback: typeof import('./rollbackImportBatch.js');

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  rollback = await import('./rollbackImportBatch.js');
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

async function seedBatch(opts: { withTransaction: boolean }): Promise<{
  householdId: number;
  accountId: number;
  userId: number;
  batchLabel: string;
}> {
  const hh = await models.Household.create({ name: 'Rollback HH' } as never);
  const user = await models.User.create({
    email: `rollback-${Date.now()}-${Math.random()}@test.local`,
    displayName: 'Roll Backer',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: '{}',
  } as never);
  const acc = await models.Account.create({
    name: `WS Invest ${Date.now()}-${Math.random()}`,
    owner: 'me',
    householdId: hh.id,
    ownerUserId: user.id,
    defaultCurrency: 'CAD',
    accountType: 'investment',
    visibility: 'private',
  } as never);
  const batchLabel = `rollback-batch-${Date.now()}-${Math.random()}`;

  const security = await models.Security.create({
    householdId: hh.id,
    symbol: 'XEQT',
    currency: 'CAD',
    name: 'iShares XEQT',
    assetType: null,
  } as never);
  await models.InvestmentActivity.create({
    accountId: acc.id,
    householdId: hh.id,
    securityId: security.id,
    activityType: 'buy',
    tradeDate: '2026-05-10',
    settlementDate: null,
    description: 'Bought 1 XEQT',
    quantity: '1',
    price: '100',
    amount: '-100',
    fees: null,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `act-${Math.random()}`,
    importBatch: batchLabel,
  } as never);
  await models.HoldingSnapshot.create({
    accountId: acc.id,
    householdId: hh.id,
    securityId: security.id,
    statementDate: '2026-05-31',
    quantity: '1',
    price: '100',
    marketValue: '100',
    costBasis: null,
    unrealizedGainLoss: null,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `hold-${Math.random()}`,
    importBatch: batchLabel,
  } as never);

  if (opts.withTransaction) {
    await models.Transaction.create({
      accountId: acc.id,
      householdId: hh.id,
      createdByUserId: user.id,
      visibility: 'private',
      ownershipType: 'me',
      importBatch: batchLabel,
      date: '2026-05-10',
      merchantRaw: 'CONTRIBUTION',
      merchantClean: 'Contribution',
      amount: '-100.00',
      currency: 'CAD',
      sourceReference: null,
      sourceRowFingerprint: `txn-${Math.random()}`,
      sourceIdentityFingerprint: `txn-id-${Math.random()}`,
      status: 'posted',
      txnType: 'transfer',
      reviewFlag: false,
      isRecurring: false,
    } as never);
  }

  await models.ImportHistory.create({
    fileName: 'statement.pdf',
    filePathSafe: 'statement.pdf',
    contentHash: `hash-${Math.random()}`,
    batchLabel,
    status: 'success',
    rowCount: opts.withTransaction ? 3 : 2,
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: new Date(),
    householdId: hh.id,
    createdByUserId: user.id,
    accountId: acc.id,
  } as never);

  return {
    householdId: hh.id as number,
    accountId: acc.id as number,
    userId: user.id as number,
    batchLabel,
  };
}

test('rollback deletes the batch InvestmentActivity and HoldingSnapshot rows alongside the transactions', async () => {
  const { householdId, accountId, userId, batchLabel } = await seedBatch({
    withTransaction: true,
  });
  const scope = { householdId };

  const result = await rollback.executeRollback({
    batchLabel,
    householdScope: scope,
    transactionScope: scope,
    userId,
  });

  assert.equal(result.deletedTransactions, 1);
  assert.equal(result.deletedInvestmentActivities, 1);
  assert.equal(result.deletedHoldingSnapshots, 1);
  assert.equal(
    await models.InvestmentActivity.count({ where: { accountId } }),
    0,
    'investment activities of the batch must not survive rollback',
  );
  assert.equal(
    await models.HoldingSnapshot.count({ where: { accountId } }),
    0,
    'holding snapshots of the batch must not survive rollback',
  );
  const history = await models.ImportHistory.findOne({ where: { batchLabel } });
  assert.equal(history?.status, 'rolled_back');
});

test('an investment-only batch (zero transactions) can be previewed and rolled back', async () => {
  const { householdId, accountId, userId, batchLabel } = await seedBatch({
    withTransaction: false,
  });
  const scope = { householdId };

  const impact = await rollback.previewRollback({
    batchLabel,
    householdScope: scope,
    transactionScope: scope,
  });
  assert.equal(
    impact.canRollback,
    true,
    `investment-only batch must be rollbackable, blockers: ${JSON.stringify(impact.blockers)}`,
  );
  assert.equal(impact.dependentCounts.investmentActivities, 1);
  assert.equal(impact.dependentCounts.holdingSnapshots, 1);

  const result = await rollback.executeRollback({
    batchLabel,
    householdScope: scope,
    transactionScope: scope,
    userId,
  });
  assert.equal(result.deletedTransactions, 0);
  assert.equal(result.deletedInvestmentActivities, 1);
  assert.equal(result.deletedHoldingSnapshots, 1);
  assert.equal(await models.InvestmentActivity.count({ where: { accountId } }), 0);
  assert.equal(await models.HoldingSnapshot.count({ where: { accountId } }), 0);
  const history = await models.ImportHistory.findOne({ where: { batchLabel } });
  assert.equal(history?.status, 'rolled_back');
});

test('rollback only touches the named batch — other batches survive', async () => {
  const first = await seedBatch({ withTransaction: true });
  const second = await seedBatch({ withTransaction: true });

  await rollback.executeRollback({
    batchLabel: first.batchLabel,
    householdScope: { householdId: first.householdId },
    transactionScope: { householdId: first.householdId },
    userId: first.userId,
  });

  assert.equal(
    await models.InvestmentActivity.count({ where: { accountId: second.accountId } }),
    1,
    'another batch\'s investment activities must survive',
  );
  assert.equal(
    await models.HoldingSnapshot.count({ where: { accountId: second.accountId } }),
    1,
    'another batch\'s holding snapshots must survive',
  );
  assert.equal(
    await models.Transaction.count({ where: { accountId: second.accountId } }),
    1,
  );
});

test('a not-found batch is still blocked', async () => {
  const impact = await rollback.previewRollback({
    batchLabel: 'no-such-batch',
    householdScope: {},
    transactionScope: {},
  });
  assert.equal(impact.canRollback, false);
  assert.equal(impact.blockers[0]?.code, 'not_found');
});
