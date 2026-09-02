/**
 * Source txnType hints vs narrative detection (sqlite-backed).
 *
 * Wealthsimple's movement codes do not distinguish a plain withdrawal from a
 * credit-card bill payment — WD/AFT_OUT cover both. Stamping them as
 * `overrideTxnType: 'transfer'` made the code win over `detectTypeStage`,
 * which already recognizes "AMEX BILL PYMT" as a payment. Prod carries the
 * result: 38 AMEX bill payments typed `transfer` (the WS-code path) against 24
 * typed `payment` (sources that let the narrative fire).
 *
 * So an ambiguous source code is now a HINT, not an override:
 *
 *   overrideTxnType  →  the source genuinely knows (SPEND is a purchase).
 *                       Always wins.
 *   txnTypeHint      →  the source is guessing. Loses to a high-confidence
 *                       narrative match, beats the detector's sign-based
 *                       fallback (which would call every outflow a purchase).
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';

let models: typeof import('../models/index.js');
let commitStatementImport: typeof import('./commitStatementImport.js').commitStatementImport;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  commitStatementImport = (await import('./commitStatementImport.js')).commitStatementImport;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

after(async () => {
  await models.sequelize.close();
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Hint HH' } as never);
  const acc = await models.Account.create({
    name: 'WS Chequing',
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

function cashRow(opts: {
  merchantRaw: string;
  amount: number;
  overrideTxnType?: NormalizedCashTransaction['overrideTxnType'];
  txnTypeHint?: NormalizedCashTransaction['overrideTxnType'];
}): NormalizedCashTransaction {
  return {
    date: '2026-07-15',
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: opts.amount,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `fp-${opts.merchantRaw}-${opts.amount}`,
    ...(opts.overrideTxnType ? { overrideTxnType: opts.overrideTxnType } : {}),
    ...(opts.txnTypeHint ? { txnTypeHint: opts.txnTypeHint } : {}),
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  rows: NormalizedCashTransaction[],
): StatementPreview {
  return {
    previewToken: 'tok',
    fileName: 'ws-chequing.pdf',
    contentHash: `hash-${Date.now()}-${Math.random()}`,
    accountId,
    householdId,
    importBatch: `batch-${Date.now()}-${Math.random()}`,
    usedParser: 'pdf',
    transactions: rows,
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

async function commitOne(row: NormalizedCashTransaction): Promise<string> {
  const { householdId, accountId } = await seedAccount();
  await commitStatementImport(makePreview(accountId, householdId, [row]), null, householdId);
  const txns = await models.Transaction.findAll({ where: { accountId } });
  assert.equal(txns.length, 1, 'expected exactly one transaction');
  return txns[0].txnType as string;
}

test('a credit-card bill payment beats a transfer hint', async () => {
  // The WS code (WD / AFT_OUT) cannot tell this from a plain withdrawal, but
  // the narrative names the card. The narrative is the better evidence.
  const txnType = await commitOne(
    cashRow({
      merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
      amount: -11922.9,
      txnTypeHint: 'transfer',
    }),
  );
  assert.equal(txnType, 'payment');
});

test('a transfer hint still wins when the narrative has no cue', async () => {
  // "Withdrawal" tells the detector nothing, so it falls back to its
  // sign-based guess of 'purchase'. The hint must beat that guess — otherwise
  // every WS account funding movement lands in spend.
  const txnType = await commitOne(
    cashRow({
      merchantRaw: 'Withdrawal (executed at 2026-07-15)',
      amount: -250,
      txnTypeHint: 'transfer',
    }),
  );
  assert.equal(txnType, 'transfer');
});

test('an authoritative override is not displaced by the narrative', async () => {
  // SPEND means the card was used. Even if the merchant name happens to trip a
  // narrative pattern, the source knows better.
  const txnType = await commitOne(
    cashRow({
      merchantRaw: 'AUTOPAY SERVICES INC',
      amount: -42.5,
      overrideTxnType: 'purchase',
    }),
  );
  assert.equal(txnType, 'purchase');
});

test('a bare outflow with no hint and no cue is still a purchase', async () => {
  // Unchanged behaviour for every source that supplies neither signal.
  const txnType = await commitOne(
    cashRow({ merchantRaw: 'Bar Burrito', amount: -14.11 }),
  );
  assert.equal(txnType, 'purchase');
});
