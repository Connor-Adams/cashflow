/**
 * What linking two legs of an internal movement may rewrite (sqlite-backed).
 *
 * When an import links a new row to its sibling on another account, it writes
 * the reverse pointer back onto that sibling — and used to stamp
 * `txnType: 'transfer'` on it unconditionally. That is right for a sibling the
 * classifier had to guess at (a bare outflow defaults to `purchase`, and
 * leaving it there inflates spend), and wrong for one the narrative already
 * identified.
 *
 * Concretely: paying a credit card produces a chequing leg and a card leg. The
 * card leg reads "PAYMENT RECEIVED - THANK YOU" and is a `payment`. Linking it
 * was silently demoting it to `transfer` — in prod, four Amex rows, two of them
 * flipped by the deposit-activity cleanup importing their counterparts.
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

const DATE = '2026-07-15';
const AMOUNT = 1094.51;

async function seedPair(siblingTxnType: string, siblingMerchant: string): Promise<{
  householdId: number;
  chequingId: number;
  siblingId: number;
}> {
  const hh = await models.Household.create({ name: 'Link HH' } as never);
  const card = await models.Account.create({
    name: 'Amex Cobalt', owner: 'me', householdId: hh.id, defaultCurrency: 'CAD',
    accountType: 'credit_card', visibility: 'private',
  } as never);
  const chequing = await models.Account.create({
    name: 'WS Chequing', owner: 'me', householdId: hh.id, defaultCurrency: 'CAD',
    accountType: 'checking', visibility: 'private',
  } as never);
  // The card leg already exists: a payment received, positive on the card.
  const sibling = await models.Transaction.create({
    accountId: card.id,
    householdId: hh.id,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'seed',
    date: DATE,
    merchantRaw: siblingMerchant,
    merchantClean: siblingMerchant,
    amount: String(AMOUNT),
    currency: 'CAD',
    status: 'posted',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: `sib-${siblingTxnType}`,
    sourceIdentityFingerprint: `sibid-${siblingTxnType}`,
    txnType: siblingTxnType,
    reviewFlag: false,
    isRecurring: false,
  } as never);
  return {
    householdId: hh.id as number,
    chequingId: chequing.id as number,
    siblingId: sibling.id as number,
  };
}

/** The chequing leg arriving by import: same amount, opposite sign, same day. */
function chequingLeg(): NormalizedCashTransaction {
  return {
    date: DATE,
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
    merchantClean: 'Pre-authorized Debit to AMEX BILL PYMT',
    amount: -AMOUNT,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: 'chq-leg',
  };
}

function preview(accountId: number, householdId: number): StatementPreview {
  return {
    previewToken: 'tok',
    fileName: 'ws-chequing.pdf',
    contentHash: `hash-${accountId}-${Math.random()}`,
    accountId,
    householdId,
    importBatch: `batch-${Math.random()}`,
    usedParser: 'pdf',
    transactions: [chequingLeg()],
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

test('linking does not demote a sibling the narrative already identified', async () => {
  const { householdId, chequingId, siblingId } = await seedPair(
    'payment',
    'PAYMENT RECEIVED - THANK YOU',
  );

  await commitStatementImport(preview(chequingId, householdId), null, householdId);

  const sibling = await models.Transaction.findByPk(siblingId);
  assert.equal(sibling!.txnType, 'payment', 'card leg must stay a payment');
  // The link itself is the point of the write-back and must still happen —
  // otherwise both legs sit in the Transfers unmatched queue forever.
  assert.notEqual(sibling!.linkedTransactionId, null, 'sibling must still be linked');
});

test('linking still re-types a sibling that was only a sign-based guess', async () => {
  // A bare outflow with no narrative cue defaults to `purchase`. Linking it is
  // real evidence that it was internal movement, so this promotion must stay —
  // without it these rows inflate dashboard spend.
  const { householdId, chequingId, siblingId } = await seedPair('purchase', 'SOME OPAQUE STRING');

  await commitStatementImport(preview(chequingId, householdId), null, householdId);

  const sibling = await models.Transaction.findByPk(siblingId);
  assert.equal(sibling!.txnType, 'transfer');
  assert.notEqual(sibling!.linkedTransactionId, null);
});
