/**
 * Integration test for Fix 2: bidirectional import auto-link.
 *
 * When commitStatementImport inserts a new transaction that the enrichment
 * pipeline matched to an already-persisted sibling (f.linkedTransactionId is
 * set), it must ALSO write the reverse pointer back onto the sibling:
 *   sibling.linked_transaction_id = <new txn id>
 *   sibling.transfer_linked_at    = now()
 *   sibling.txn_type              = 'transfer'   (if not already)
 *
 * Without this fix the link was one-directional: the new txn pointed at the
 * sibling but the sibling's linked_transaction_id remained NULL, so the
 * Transfers-page unmatched queue kept showing both legs even after import.
 *
 * Test setup mirrors counterpartyImportAutolink.test.ts: two accounts in the
 * same household, one pre-seeded sibling txn, then commitStatementImport with
 * a matching transfer row.
 *
 * Requires TEST_DATABASE_URL=postgres://connoradams@localhost:5432/postgres.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let householdId: number;
let userId: number;
let accountRbcId: number;
let accountWsId: number;
let commitStatementImport: typeof import('../../src/import/commitStatementImport.js').commitStatementImport;

before(async () => {
  testDb = await setupPgTestDb('transfer_bidir');

  // Import app to trigger DB init, then grab the models + function we need.
  const models = await import('../../src/models');
  commitStatementImport = (await import('../../src/import/commitStatementImport.js')).commitStatementImport;

  const household = await models.Household.create({ name: 'BiDir Test Household' } as never);
  householdId = household.id;

  const user = await models.User.create({
    email: `bidir-${Date.now()}@example.com`,
    displayName: 'BiDir User',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  userId = user.id;

  const rbcAcct = await models.Account.create({
    name: 'RBC Chequing',
    householdId,
    ownerUserId: userId,
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  accountRbcId = rbcAcct.id;

  const wsAcct = await models.Account.create({
    name: 'Wealthsimple Cash',
    householdId,
    ownerUserId: userId,
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  accountWsId = wsAcct.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a minimal StatementPreview for one or more CSV rows. */
function makePreview(opts: {
  fileName: string;
  contentHash?: string;
  accountId: number;
  rows: Array<{ date: string; merchantRaw: string; amount: number }>;
}): import('../../src/import/statementTypes.js').StatementPreview {
  const hash = opts.contentHash ?? crypto.randomBytes(16).toString('hex');
  const transactions = opts.rows.map((r) => ({
    date: r.date,
    merchantRaw: r.merchantRaw,
    merchantClean: r.merchantRaw,
    amount: r.amount,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
  }));
  return {
    previewToken: crypto.randomBytes(16).toString('hex'),
    fileName: opts.fileName,
    contentHash: hash,
    accountId: opts.accountId,
    householdId,
    importBatch: `test-${hash.slice(0, 8)}`,
    usedParser: 'csv',
    usedProfileId: 'generic_simple',
    profileInferred: false,
    transactions,
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('bidirectional link: both legs point at each other after import', async () => {
  const models = await import('../../src/models');

  // Step 1: Pre-seed the WS inbound leg (+$7000) on the WS account.
  // This simulates the WS statement having been imported first.
  const wsSibling = await models.Transaction.create({
    accountId: accountWsId,
    householdId,
    createdByUserId: userId,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'ws-preseeded',
    date: '2026-05-15',
    merchantRaw: 'Transfer from RBC',
    merchantClean: 'Transfer from RBC',
    merchantCanonical: null,
    txnType: 'transfer',        // already classified as transfer on WS side
    amount: '7000.0000',
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: 'Transfer',
    categoryOverride: null,
    finalCategory: 'Transfer',
    autoBusiness: false,
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
    myShareAmount: '7000',
    partnerShareAmount: '0',
    businessAmount: '0',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,   // ← unlinked; Fix 2 must back-fill this
    transferPurpose: null,
    transferLinkedAt: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    importConfidence: null,
    importConfidenceFlags: null,
    status: 'posted',
  } as never);

  // Step 2: Import the RBC outbound leg (−$7000) via commitStatementImport.
  // The enrichment pipeline should find wsSibling as a transfer sibling
  // (same-day, opposite sign, same absolute amount, different account, same
  // household) and set f.linkedTransactionId = wsSibling.id.
  const preview = makePreview({
    fileName: 'rbc-transfer-bidir.csv',
    accountId: accountRbcId,
    rows: [
      {
        date: '2026-05-15',
        merchantRaw: 'Online transfer sent - 6113 Connor Adams',
        amount: -7000,
      },
    ],
  });

  const result = await commitStatementImport(preview, userId, householdId);
  assert.equal(
    result.insertedTransactions,
    1,
    `expected 1 inserted transaction, got: ${JSON.stringify(result)}`,
  );

  // Step 3: Verify the new RBC txn was linked to the WS sibling.
  const rbcTxns = await models.Transaction.findAll({
    where: { accountId: accountRbcId, merchantRaw: 'Online transfer sent - 6113 Connor Adams' },
  });
  assert.equal(rbcTxns.length, 1, 'expected exactly one RBC txn');
  const rbcTxn = rbcTxns[0];

  assert.equal(rbcTxn.txnType, 'transfer', 'RBC txn must be classified as transfer');
  assert.equal(
    rbcTxn.linkedTransactionId,
    wsSibling.id,
    'RBC txn must point at WS sibling (forward link)',
  );
  assert.ok(rbcTxn.transferLinkedAt, 'RBC txn must have transferLinkedAt set');

  // Step 4 (the bug-fix assertion): the pre-existing WS sibling must now
  // carry the reverse pointer back to the RBC txn.
  await wsSibling.reload();
  assert.equal(
    wsSibling.linkedTransactionId,
    rbcTxn.id,
    'WS sibling must point back at the newly-inserted RBC txn (reverse link — Fix 2)',
  );
  assert.ok(wsSibling.transferLinkedAt, 'WS sibling must have transferLinkedAt set (Fix 2)');
  assert.equal(wsSibling.txnType, 'transfer', 'WS sibling txnType must remain transfer');
});

test('bidirectional link: no reverse update when no sibling is linked', async () => {
  // Smoke-test: a plain purchase with no transfer sibling must insert normally
  // without errors and without touching any other row.
  const preview = makePreview({
    fileName: 'rbc-no-sibling.csv',
    accountId: accountRbcId,
    rows: [{ date: '2026-05-20', merchantRaw: 'TIM HORTONS #999', amount: -4.5 }],
  });

  const result = await commitStatementImport(preview, userId, householdId);
  assert.equal(result.insertedTransactions, 1, `expected 1 inserted, got: ${JSON.stringify(result)}`);
});
