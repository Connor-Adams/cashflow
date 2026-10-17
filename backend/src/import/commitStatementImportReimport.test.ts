/**
 * Re-importing a file the parser now reads more of (sqlite-backed).
 *
 * `commitStatementImport` short-circuits on a content hash that already
 * imported rows, so a statement can't double-write the ledger. But when a
 * parser fix makes the SAME file yield rows it used to miss, that
 * short-circuit made the fix unreachable: the Wealthsimple 2026-09 chequing
 * statement first imported 12 of its 16 rows (pdfjs split "11" into "1 1" and
 * four lines were skipped), and re-importing it after the fix still reported
 * "already imported" and inserted nothing — the +10,000 and +4,500 transfers
 * stayed missing.
 *
 * Contract: if the new parse finds MORE rows than the prior import saw
 * (inserted + skipped as duplicates), run the normal row-level dedup so only
 * the missing rows land. Otherwise keep the short-circuit.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';
import { rowFingerprint } from './fingerprint';

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
  const hh = await models.Household.create({ name: 'Reimport HH' } as never);
  const acc = await models.Account.create({
    name: 'Wealthsimple Chequing',
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

function row(date: string, merchant: string, amount: number): NormalizedCashTransaction {
  return {
    date,
    merchantRaw: merchant,
    merchantClean: merchant,
    amount,
    currency: 'CAD',
    sourceReference: null,
  };
}

const KNOWN = [
  row('2026-09-01', 'Interest earned', 2.27),
  row('2026-09-06', 'Transfer out to Credit Card', -4738.22),
];
const MISSED = [
  row('2026-09-06', 'Transfer in from CDG Labs Inc.', 10000),
  row('2026-09-09', 'Transfer in from Business Investing', 4500),
];

function preview(
  accountId: number,
  householdId: number,
  contentHash: string,
  transactions: NormalizedCashTransaction[],
): StatementPreview {
  const nonce = `${Date.now()}-${Math.random()}`;
  return {
    previewToken: `tok-${nonce}`,
    fileName: 'Chequing-monthly-statement-WK3DD9X35CAD-2026-09-v_0.pdf',
    contentHash,
    accountId,
    householdId,
    importBatch: `batch-${nonce}`,
    usedParser: 'pdf',
    // Fingerprints as the real preview path computes them.
    transactions: transactions.map((t) => ({
      ...t,
      sourceRowFingerprint: rowFingerprint({ accountId, ...t }),
    })),
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

test('re-importing a file the parser now reads more of inserts only the rows it used to miss', async () => {
  const { householdId, accountId } = await seedAccount();
  const hash = `hash-${Math.random()}`;

  const first = await commitStatementImport(preview(accountId, householdId, hash, KNOWN), null, householdId);
  assert.equal(first.insertedTransactions, 2);

  const again = await commitStatementImport(
    preview(accountId, householdId, hash, [...KNOWN, ...MISSED]),
    null,
    householdId,
  );

  assert.equal(again.insertedTransactions, 2, JSON.stringify(again.warnings));
  assert.equal(again.skippedDuplicates, 2);
  const amounts = (await models.Transaction.findAll({ where: { accountId } }))
    .map((t) => Number(t.amount))
    .sort((a, b) => a - b);
  assert.deepEqual(amounts, [-4738.22, 2.27, 4500, 10000]);
});

test('re-importing the same file with the same rows still short-circuits', async () => {
  const { householdId, accountId } = await seedAccount();
  const hash = `hash-${Math.random()}`;

  await commitStatementImport(preview(accountId, householdId, hash, KNOWN), null, householdId);
  const again = await commitStatementImport(preview(accountId, householdId, hash, KNOWN), null, householdId);

  assert.equal(again.insertedTransactions, 0);
  assert.ok(again.warnings.some((w) => /already imported/i.test(w)));
  assert.equal(await models.Transaction.count({ where: { accountId } }), 2);
});
