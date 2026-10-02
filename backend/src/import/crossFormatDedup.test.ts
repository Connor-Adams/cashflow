/**
 * Cross-FORMAT dedup on one Wealthsimple brokerage account (sqlite-backed).
 *
 * Prod: "WS Corporate Investing" (account 13) was imported from two exports of
 * the same statements — the monthly CSV (`date,transaction,description,...`,
 * rows like "Contribution (executed at 2025-11-06)", plus a `transfer`
 * investment activity per CONT row) and the brokerage PDF (rows like
 * "Deposit"/"Money transfer into the account (executed at ...)", with a
 * `transfer_in` / `cash_movement` activity per cash crossing). Every 2025
 * deposit then existed twice, and the unlinked copy was counted as corporate
 * revenue.
 *
 * The two formats disagree on three things about one cash event:
 *   1. the narrative ("Contribution" vs "Deposit") — the narrative-rename tier
 *      already covers that on an exact date;
 *   2. the DATE: the monthly CSV dates a row by its posting day and stamps the
 *      execution day in the text ("2025-07-15 ... (executed at 2025-07-16)"),
 *      while the PDF dates the same row by that execution day;
 *   3. the activity code: WS calls one deposit CONT, DEP or TRFIN depending on
 *      the export and the statement cycle → `transfer`, `cash_movement`,
 *      `transfer_in`.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  NormalizedCashTransaction,
  NormalizedInvestmentActivity,
  StatementPreview,
} from './statementTypes';

let models: typeof import('../models/index.js');
let findExistingForDedup: typeof import('./dedupExisting.js').findExistingForDedup;
let commitStatementImport: typeof import('./commitStatementImport.js').commitStatementImport;
let stableIdentityFingerprint: typeof import('./fingerprint.js').stableIdentityFingerprint;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  findExistingForDedup = (await import('./dedupExisting.js')).findExistingForDedup;
  commitStatementImport = (await import('./commitStatementImport.js')).commitStatementImport;
  stableIdentityFingerprint = (await import('./fingerprint.js')).stableIdentityFingerprint;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Cross Format HH' } as never);
  const acc = await models.Account.create({
    name: `WS Corporate Investing ${Math.random()}`,
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'investment',
    visibility: 'private',
    shortCode: 'HQ8H0GZ07CAD',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

async function seedPosted(opts: {
  accountId: number;
  householdId: number;
  date: string;
  amount: number;
  merchantRaw: string;
}): Promise<number> {
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: '2026-05 HQ8H0GZ07CAD',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency: 'CAD',
    status: 'posted',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `existing-${Math.random()}`,
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: opts.accountId,
      date: opts.date,
      amount: opts.amount,
      currency: 'CAD',
      merchantRaw: opts.merchantRaw,
    }),
    txnType: 'unknown',
    reviewFlag: false,
    isRecurring: false,
  } as never);
  return row.id as number;
}

function dedupArgs(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
  t: import('sequelize').Transaction;
}) {
  return {
    accountId: opts.accountId,
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId: opts.accountId,
      date: opts.date,
      amount: opts.amount,
      currency: 'CAD',
      merchantRaw: opts.merchantRaw,
    }),
    sourceReference: null,
    t: opts.t,
    incomingStatus: 'posted' as const,
    incomingDate: opts.date,
    incomingAmount: opts.amount,
    incomingCurrency: 'CAD',
    incomingMerchantRaw: opts.merchantRaw,
  };
}

// ---------------------------------------------------------------------------
// Transaction tier: the executed-at stamp is the event's date
// ---------------------------------------------------------------------------

test('a CSV row posted the day before its executed-at stamp matches the PDF row dated on that stamp', async () => {
  const { householdId, accountId } = await seedAccount();
  // Prod id 917: posted 2025-07-15, executed 2025-07-16.
  const existingId = await seedPosted({
    accountId, householdId, date: '2025-07-15', amount: 2000,
    merchantRaw: 'Money transfer into the account (executed at 2025-07-16)',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      dedupArgs({
        accountId, date: '2025-07-16', amount: 2000,
        merchantRaw: 'Money transfer into the account (executed at 2025-07-16)', t,
      }),
    );
    assert.deepEqual(outcome, { kind: 'duplicate', existingId });
  });
});

test('the stamp anchors the event date in the other direction too (unstamped incoming)', async () => {
  const { householdId, accountId } = await seedAccount();
  const existingId = await seedPosted({
    accountId, householdId, date: '2025-11-05', amount: 5000,
    merchantRaw: 'Contribution (executed at 2025-11-06)',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      dedupArgs({ accountId, date: '2025-11-06', amount: 5000, merchantRaw: 'Deposit', t }),
    );
    assert.deepEqual(outcome, { kind: 'duplicate', existingId });
  });
});

test('two different executed-at stamps are two events, even one day apart', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedPosted({
    accountId, householdId, date: '2026-03-13', amount: -1000,
    merchantRaw: 'Withdrawal (executed at 2026-03-13)',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      dedupArgs({
        accountId, date: '2026-03-14', amount: -1000,
        merchantRaw: 'Withdrawal (executed at 2026-03-14)', t,
      }),
    );
    assert.equal(outcome.kind, 'no-match', 'consecutive-day withdrawals must both import');
  });
});

test('a stamp-anchored match that is not unique declines rather than guesses', async () => {
  const { householdId, accountId } = await seedAccount();
  // One row dated on the event day, one posted the day before but stamped on it.
  await seedPosted({
    accountId, householdId, date: '2025-07-16', amount: 2000, merchantRaw: 'Deposit',
  });
  await seedPosted({
    accountId, householdId, date: '2025-07-15', amount: 2000,
    merchantRaw: 'Contribution (executed at 2025-07-16)',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      dedupArgs({
        accountId, date: '2025-07-16', amount: 2000,
        merchantRaw: 'Money transfer into the account (executed at 2025-07-16)', t,
      }),
    );
    assert.equal(outcome.kind, 'no-match');
  });
});

test('the stamp never matches two SPECIFIC merchants', async () => {
  const { householdId, accountId } = await seedAccount();
  await seedPosted({
    accountId, householdId, date: '2025-07-15', amount: -2000,
    merchantRaw: 'VFV - Vanguard S&P 500 Index ETF: Bought 6.5 shares (executed at 2025-07-16)',
  });

  await models.sequelize.transaction(async (t) => {
    const outcome = await findExistingForDedup(
      dedupArgs({
        accountId, date: '2025-07-16', amount: -2000,
        merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Bought 50 shares (executed at 2025-07-16)',
        t,
      }),
    );
    assert.deepEqual(outcome, { kind: 'no-match' });
  });
});

// ---------------------------------------------------------------------------
// Commit path: the account-13 shape, both import orders, both tables
// ---------------------------------------------------------------------------

function cash(date: string, amount: number, merchantRaw: string): NormalizedCashTransaction {
  return {
    date,
    merchantRaw,
    merchantClean: merchantRaw,
    amount,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `row-${merchantRaw}-${date}-${amount}`,
  };
}

function cashActivity(
  activityType: NormalizedInvestmentActivity['activityType'],
  tradeDate: string,
  amount: number,
  description: string,
): NormalizedInvestmentActivity {
  return {
    activityType,
    tradeDate,
    settlementDate: null,
    description,
    security: null,
    quantity: null,
    price: null,
    amount,
    fees: null,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `act-${activityType}-${tradeDate}-${amount}-${description}`,
  };
}

function preview(
  accountId: number,
  householdId: number,
  importBatch: string,
  transactions: NormalizedCashTransaction[],
  investmentActivities: NormalizedInvestmentActivity[],
  parser: 'csv' | 'pdf',
): StatementPreview {
  return {
    previewToken: 'tok',
    fileName: `${importBatch}.${parser}`,
    contentHash: `hash-${Math.random()}`,
    accountId,
    householdId,
    importBatch,
    usedParser: parser,
    transactions,
    investmentActivities,
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
    // Both Wealthsimple exports describe events the other one also carries.
    crossSourceDedup: 'fuzzy-window-5d',
  };
}

/** The monthly CSV's view of the 2025-11-06 deposit (prod ids 519 / activity 54). */
function monthlyCsv(accountId: number, householdId: number): StatementPreview {
  return preview(
    accountId, householdId, '2026-05 HQ8H0GZ07CAD',
    [cash('2025-11-06', 5000, 'Contribution (executed at 2025-11-06)')],
    [cashActivity('transfer', '2025-11-06', 5000, 'Contribution (executed at 2025-11-06)')],
    'csv',
  );
}

/** The brokerage PDF's view of the same deposit (prod id 3326). */
function brokeragePdf(accountId: number, householdId: number): StatementPreview {
  return preview(
    accountId, householdId, '2026-06 HQ8H0GZ07CAD',
    [cash('2025-11-06', 5000, 'Deposit')],
    [cashActivity('cash_movement', '2025-11-06', 5000, 'Deposit (executed at 2025-11-06)')],
    'pdf',
  );
}

async function counts(accountId: number) {
  return {
    transactions: await models.Transaction.count({ where: { accountId } }),
    activities: await models.InvestmentActivity.count({ where: { accountId } }),
  };
}

test('PDF after monthly CSV: the deposit and its activity are each recorded once', async () => {
  const { householdId, accountId } = await seedAccount();
  await commitStatementImport(monthlyCsv(accountId, householdId), null, householdId);
  const second = await commitStatementImport(brokeragePdf(accountId, householdId), null, householdId);

  assert.equal(second.insertedTransactions, 0);
  assert.equal(second.insertedInvestmentActivities, 0, 'DEP cash_movement is the CONT transfer');
  assert.deepEqual(await counts(accountId), { transactions: 1, activities: 1 });
});

test('monthly CSV after PDF: the deposit and its activity are each recorded once', async () => {
  const { householdId, accountId } = await seedAccount();
  await commitStatementImport(brokeragePdf(accountId, householdId), null, householdId);
  const second = await commitStatementImport(monthlyCsv(accountId, householdId), null, householdId);

  assert.equal(second.insertedTransactions, 0);
  assert.equal(second.insertedInvestmentActivities, 0);
  assert.deepEqual(await counts(accountId), { transactions: 1, activities: 1 });
});

test('a withdrawal never absorbs a deposit of the same size', async () => {
  const { householdId, accountId } = await seedAccount();
  await commitStatementImport(monthlyCsv(accountId, householdId), null, householdId);
  const out = preview(
    accountId, householdId, '2026-06 HQ8H0GZ07CAD',
    [cash('2025-11-06', -5000, 'Withdrawal')],
    [cashActivity('cash_movement', '2025-11-06', -5000, 'Withdrawal (executed at 2025-11-06)')],
    'pdf',
  );
  const second = await commitStatementImport(out, null, householdId);

  assert.equal(second.insertedTransactions, 1);
  assert.equal(second.insertedInvestmentActivities, 1);
});

test('two real same-day equal deposits in one statement both import', async () => {
  const { householdId, accountId } = await seedAccount();
  const both = preview(
    accountId, householdId, '2026-06 HQ8H0GZ07CAD',
    [cash('2026-01-08', 7000, 'Deposit'), cash('2026-01-08', 7000, 'Contribution')],
    [
      cashActivity('cash_movement', '2026-01-08', 7000, 'Deposit (executed at 2026-01-08)'),
      cashActivity('transfer', '2026-01-08', 7000, 'Contribution (executed at 2026-01-08)'),
    ],
    'pdf',
  );
  const result = await commitStatementImport(both, null, householdId);

  assert.equal(result.insertedTransactions, 2);
  assert.equal(result.insertedInvestmentActivities, 2);
});

// ---------------------------------------------------------------------------
// Parse path: the monthly CSV opts into cross-source activity dedup
// ---------------------------------------------------------------------------

test('a Wealthsimple monthly CSV preview opts into cross-source activity dedup', async () => {
  const { householdId, accountId } = await seedAccount();
  const { parseStatementFile } = await import('./parseStatementFile.js');
  const csv = [
    'date,transaction,description,amount,balance,currency',
    '2025-11-06,CONT,Contribution (executed at 2025-11-06),5000,5000,CAD',
  ].join('\n');

  const parsed = await parseStatementFile({
    buffer: Buffer.from(csv),
    fileName: 'HQ8H0GZ07CAD-2025-11-01-monthly-statement-transactions.csv',
    accountId,
    householdId,
  });

  assert.equal((parsed as StatementPreview).crossSourceDedup, 'fuzzy-window-5d');
});
