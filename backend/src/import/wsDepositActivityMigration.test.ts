/**
 * Wealthsimple deposit-account activity cleanup (sqlite-backed).
 *
 * Two import runs put the same cash events in two tables on the WS deposit
 * accounts: an earlier run wrote `transactions` with the real merchant text
 * ("Pre-authorized Debit to AMEX BILL PYMT"), and a later brokerage-PDF
 * re-import wrote `investment_activities` with the statement's generic text
 * ("Withdrawal"). 190 of 256 rows are such shadows; the other 66 have no
 * transaction at all and are cash events missing from the ledger entirely.
 *
 * The cleanup deletes the shadows and turns the orphans into transactions.
 * Pairing is on (accountId, date, amount, currency), 1:1 by position — the
 * merchant text deliberately plays no part, since the whole point is that the
 * two sources word the same event differently.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models/index.js');
let classifyWsDepositActivities: typeof import('./wsDepositActivityMigration.js').classifyWsDepositActivities;
let migrateWsDepositActivities: typeof import('./wsDepositActivityMigration.js').migrateWsDepositActivities;
let rowFingerprint: typeof import('./fingerprint.js').rowFingerprint;
let stableIdentityFingerprint: typeof import('./fingerprint.js').stableIdentityFingerprint;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  const mod = await import('./wsDepositActivityMigration.js');
  classifyWsDepositActivities = mod.classifyWsDepositActivities;
  migrateWsDepositActivities = mod.migrateWsDepositActivities;
  const fp = await import('./fingerprint.js');
  rowFingerprint = fp.rowFingerprint;
  stableIdentityFingerprint = fp.stableIdentityFingerprint;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

async function makeAccount(accountType = 'checking'): Promise<{ id: number; householdId: number }> {
  const hh = await models.Household.create({ name: 'H' } as never);
  const acc = await models.Account.create({
    name: 'WS Chequing',
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType,
    visibility: 'private',
    shortCode: 'WK3DD9X35CAD',
  } as never);
  return { id: acc.id as number, householdId: hh.id as number };
}

async function seedTransaction(opts: {
  accountId: number;
  householdId: number;
  date: string;
  amount: number;
  merchantRaw: string;
}): Promise<number> {
  const currency = 'CAD';
  const txn = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'seed',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency,
    status: 'posted',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId: opts.accountId,
      date: opts.date,
      amount: opts.amount,
      currency,
      merchantRaw: opts.merchantRaw,
      sourceReference: null,
    }),
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: opts.accountId,
      date: opts.date,
      amount: opts.amount,
      currency,
      merchantRaw: opts.merchantRaw,
    }),
    txnType: 'transfer',
    reviewFlag: false,
    isRecurring: false,
  } as never);
  return txn.id as number;
}

async function seedActivity(opts: {
  accountId: number;
  householdId: number;
  date: string;
  amount: number;
  activityType: string;
  description: string;
  securityId?: number | null;
}): Promise<number> {
  const act = await models.InvestmentActivity.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    securityId: opts.securityId ?? null,
    activityType: opts.activityType,
    tradeDate: opts.date,
    settlementDate: null,
    description: opts.description,
    quantity: null,
    price: null,
    amount: String(opts.amount),
    fees: null,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `act-${opts.date}-${opts.amount}-${opts.description}`,
    importBatch: 'seed-activities',
  } as never);
  return act.id as number;
}

test('classify pairs an activity with the transaction that already records it', async () => {
  const { id: accountId, householdId } = await makeAccount();
  await seedTransaction({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });
  const shadowId = await seedActivity({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2025-03-17)',
  });

  const { shadows, orphans } = await classifyWsDepositActivities([accountId]);

  assert.equal(orphans.length, 0);
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].activityId, shadowId);
  assert.equal(shadows[0].transactionMerchantRaw, 'Pre-authorized Debit to AMEX BILL PYMT');
});

test('classify reports an activity with no matching transaction as an orphan', async () => {
  const { id: accountId, householdId } = await makeAccount();
  const orphanId = await seedActivity({
    accountId, householdId, date: '2026-01-14', amount: -8904.9,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2026-01-14)',
  });

  const { shadows, orphans } = await classifyWsDepositActivities([accountId]);

  assert.equal(shadows.length, 0);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].activityId, orphanId);
  assert.equal(orphans[0].txnType, 'transfer');
});

test('classify pairs two same-day rows one-to-one, never both onto one transaction', async () => {
  // Same date, same amount, twice. One transaction exists, so exactly one
  // activity is a shadow and the other is a genuine orphan.
  const { id: accountId, householdId } = await makeAccount();
  await seedTransaction({
    accountId, householdId, date: '2025-03-13', amount: 207.4,
    merchantRaw: 'Direct deposit from ADAMS GREENE HO',
  });
  await seedActivity({
    accountId, householdId, date: '2025-03-13', amount: 207.4,
    activityType: 'cash_movement', description: 'Deposit (executed at 2025-03-13)',
  });
  await seedActivity({
    accountId, householdId, date: '2025-03-13', amount: 207.4,
    activityType: 'cash_movement', description: 'Deposit (executed at 2025-03-13)',
  });

  const { shadows, orphans } = await classifyWsDepositActivities([accountId]);

  assert.equal(shadows.length, 1);
  assert.equal(orphans.length, 1);
});

test('classify types an interest activity as interest, not transfer', async () => {
  const { id: accountId, householdId } = await makeAccount();
  await seedActivity({
    accountId, householdId, date: '2026-01-01', amount: 4.67,
    activityType: 'interest', description: 'Interest received (executed at 2026-01-01)',
  });

  const { orphans } = await classifyWsDepositActivities([accountId]);

  assert.equal(orphans[0].txnType, 'interest');
});

test('classify leaves a security-bearing activity alone', async () => {
  // Not a cash event. A deposit statement should never carry one, but if it
  // does, deleting it or flattening it to a transaction would lose the
  // security — so it is neither a shadow nor an orphan.
  const { id: accountId, householdId } = await makeAccount();
  const sec = await models.Security.create({
    symbol: 'VFV', name: 'Vanguard S&P 500', currency: 'CAD',
  } as never);
  await seedActivity({
    accountId, householdId, date: '2026-02-02', amount: -150,
    activityType: 'buy', description: 'VFV - Vanguard S&P 500: Bought 1.0 shares',
    securityId: sec.id as number,
  });

  const { shadows, orphans, skipped } = await classifyWsDepositActivities([accountId]);

  assert.equal(shadows.length, 0);
  assert.equal(orphans.length, 0);
  assert.equal(skipped.length, 1);
});

test('migrate deletes the shadow and leaves its transaction untouched', async () => {
  const { id: accountId, householdId } = await makeAccount();
  const txnId = await seedTransaction({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });
  await seedActivity({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2025-03-17)',
  });

  const report = await migrateWsDepositActivities({ accountIds: [accountId], userId: null });

  assert.equal(report.deletedShadows, 1);
  assert.equal(await models.InvestmentActivity.count({ where: { accountId } }), 0);
  const txn = await models.Transaction.findByPk(txnId);
  assert.equal(txn!.merchantRaw, 'Pre-authorized Debit to AMEX BILL PYMT');
  assert.equal(await models.Transaction.count({ where: { accountId } }), 1);
});

test('migrate turns an orphan into a transaction carrying its description and type', async () => {
  const { id: accountId, householdId } = await makeAccount();
  await seedActivity({
    accountId, householdId, date: '2026-01-14', amount: -8904.9,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2026-01-14)',
  });

  const report = await migrateWsDepositActivities({ accountIds: [accountId], userId: null });

  assert.equal(report.insertedTransactions, 1);
  assert.equal(await models.InvestmentActivity.count({ where: { accountId } }), 0);
  const txns = await models.Transaction.findAll({ where: { accountId } });
  assert.equal(txns.length, 1);
  assert.equal(txns[0].date, '2026-01-14');
  assert.equal(Number(txns[0].amount), -8904.9);
  assert.equal(txns[0].merchantRaw, 'Withdrawal (executed at 2026-01-14)');
  assert.equal(txns[0].txnType, 'transfer');
});

test('migrate is idempotent — a second run changes nothing', async () => {
  const { id: accountId, householdId } = await makeAccount();
  await seedTransaction({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });
  await seedActivity({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2025-03-17)',
  });
  await seedActivity({
    accountId, householdId, date: '2026-01-14', amount: -8904.9,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2026-01-14)',
  });

  await migrateWsDepositActivities({ accountIds: [accountId], userId: null });
  const afterFirst = await models.Transaction.count({ where: { accountId } });

  const second = await migrateWsDepositActivities({ accountIds: [accountId], userId: null });

  assert.equal(second.deletedShadows, 0);
  assert.equal(second.insertedTransactions, 0);
  assert.equal(await models.Transaction.count({ where: { accountId } }), afterFirst);
  assert.equal(await models.InvestmentActivity.count({ where: { accountId } }), 0);
});

test('migrate refuses an account that is not a deposit account', async () => {
  const { id: accountId, householdId } = await makeAccount('investment');
  await seedActivity({
    accountId, householdId, date: '2026-01-14', amount: -8904.9,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2026-01-14)',
  });

  await assert.rejects(
    () => migrateWsDepositActivities({ accountIds: [accountId], userId: null }),
    /not a deposit account/i,
  );
  assert.equal(await models.InvestmentActivity.count({ where: { accountId } }), 1);
});

test('dryRun reports what it would do and writes nothing', async () => {
  const { id: accountId, householdId } = await makeAccount();
  await seedTransaction({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
  });
  await seedActivity({
    accountId, householdId, date: '2025-03-17', amount: -3415.38,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2025-03-17)',
  });
  await seedActivity({
    accountId, householdId, date: '2026-01-14', amount: -8904.9,
    activityType: 'cash_movement', description: 'Withdrawal (executed at 2026-01-14)',
  });

  const report = await migrateWsDepositActivities({
    accountIds: [accountId], userId: null, dryRun: true,
  });

  assert.equal(report.deletedShadows, 1);
  assert.equal(report.insertedTransactions, 1);
  assert.equal(await models.InvestmentActivity.count({ where: { accountId } }), 2);
  assert.equal(await models.Transaction.count({ where: { accountId } }), 1);
});

test('migrate types an orphaned card payment as a payment, not a transfer', async () => {
  // The whole reason orphans go through commitStatementImport rather than a
  // raw INSERT: the narrative detector gets to classify them. A hint of
  // 'transfer' from the WS movement code must not bury the card payment.
  const { id: accountId, householdId } = await makeAccount();
  await seedActivity({
    accountId, householdId, date: '2026-07-15', amount: -11922.9,
    activityType: 'cash_movement', description: 'Pre-authorized Debit to AMEX BILL PYMT',
  });

  await migrateWsDepositActivities({ accountIds: [accountId], userId: null });

  const txns = await models.Transaction.findAll({ where: { accountId } });
  assert.equal(txns.length, 1);
  assert.equal(txns[0].txnType, 'payment');
});
