/**
 * Rate-history capture on commit (sqlite-backed).
 *
 * An RBC Royal Credit Line statement prints a "Rate History" table: per dated
 * window, the prime rate, the premium on top of it, the resulting effective
 * rate, and the interest RBC actually applied. Task 1 reads that table into
 * `PdfParseResult.ratePeriods`; Task 2 gave it a table. This is the write.
 *
 * Three properties matter here, in this order:
 *
 *   1. Rate capture NEVER fails an import. Transactions are the point of
 *      importing a statement; a rate window is a bonus. A rate-persistence
 *      error must surface as a warning on the commit result, with every
 *      transaction still committed.
 *   2. Re-import is safe. UNIQUE(account_id, from_date) means a re-imported
 *      statement — or the next month's statement, which restates the window
 *      it shares with this one — updates the row in place rather than
 *      inserting a second copy of the same window.
 *   3. The rows are scoped to the household and account the commit path
 *      itself resolved, not to anything that rode in on the payload.
 */
import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfRatePeriod } from './pdf/types';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';

let models: typeof import('../models/index.js');
let commitStatementImport: typeof import('./commitStatementImport.js').commitStatementImport;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  commitStatementImport = (await import('./commitStatementImport.js')).commitStatementImport;
});

beforeEach(async () => {
  mock.restoreAll();
  await models.sequelize.sync({ force: true });
});

after(async () => {
  mock.restoreAll();
  await models.sequelize.close();
});

async function seedAccount(): Promise<{ householdId: number; accountId: number }> {
  const hh = await models.Household.create({ name: 'Rate HH' } as never);
  const acc = await models.Account.create({
    name: 'RBC Royal Credit Line',
    owner: 'me',
    householdId: hh.id,
    defaultCurrency: 'CAD',
    accountType: 'loan',
    visibility: 'private',
  } as never);
  return { householdId: hh.id as number, accountId: acc.id as number };
}

function cashRow(suffix: string): NormalizedCashTransaction {
  return {
    date: '2026-03-15',
    merchantRaw: `INTEREST CHARGE ${suffix}`,
    merchantClean: `INTEREST CHARGE ${suffix}`,
    amount: -125.5,
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: `fp-rate-${suffix}`,
  };
}

function ratePeriod(overrides: Partial<PdfRatePeriod> = {}): PdfRatePeriod {
  return {
    fromDate: '2026-02-09',
    toDate: '2026-03-08',
    primeRate: '4.4500',
    premium: '4.4900',
    effectiveRate: '8.9400',
    applicableInterest: '123.4500',
    ...overrides,
  };
}

function makePreview(
  accountId: number,
  householdId: number,
  opts: {
    rows?: NormalizedCashTransaction[];
    ratePeriods?: PdfRatePeriod[];
  } = {},
): StatementPreview {
  const nonce = `${Date.now()}-${Math.random()}`;
  return {
    previewToken: `tok-${nonce}`,
    fileName: 'rbc-credit-line.pdf',
    // A fresh hash per preview: an identical contentHash short-circuits the
    // commit as "already imported" before any row is written.
    contentHash: `hash-${nonce}`,
    accountId,
    householdId,
    importBatch: `batch-${nonce}`,
    usedParser: 'pdf',
    transactions: opts.rows ?? [cashRow(nonce)],
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
    ...(opts.ratePeriods ? { ratePeriods: opts.ratePeriods } : {}),
  };
}

test('a statement carrying rate windows writes one row per window, scoped to the account', async () => {
  const { householdId, accountId } = await seedAccount();
  const result = await commitStatementImport(
    makePreview(accountId, householdId, {
      ratePeriods: [
        ratePeriod({ fromDate: '2026-01-09', toDate: '2026-02-08', applicableInterest: '110.0000' }),
        ratePeriod({ fromDate: '2026-02-09', toDate: '2026-03-08', applicableInterest: '123.4500' }),
      ],
    }),
    null,
    householdId,
  );

  assert.equal(result.insertedTransactions, 1, 'the transaction must still land');

  const rows = await models.AccountRatePeriod.findAll({
    where: { accountId },
    order: [['fromDate', 'ASC']],
  });
  assert.equal(rows.length, 2, `expected two rate windows, got ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => r.fromDate),
    ['2026-01-09', '2026-02-09'],
  );
  assert.deepEqual(
    rows.map((r) => r.toDate),
    ['2026-02-08', '2026-03-08'],
  );
  for (const r of rows) {
    assert.equal(r.householdId, householdId, 'rate window must carry the resolved household');
    assert.equal(r.accountId, accountId, 'rate window must carry the committed account');
    // DECIMAL reads back as string on Postgres, number on SQLite — compare
    // numerically so this assertion holds on both dialects.
    assert.equal(Number(r.effectiveRate), 8.94);
    assert.equal(Number(r.primeRate), 4.45);
    assert.equal(Number(r.premium), 4.49);
  }
  assert.equal(Number(rows[0].applicableInterest), 110);
  assert.equal(Number(rows[1].applicableInterest), 123.45);
});

test('a household id on the payload cannot redirect the rate window', async () => {
  // The preview is a client-supplied blob. Only the household the commit path
  // resolved off the Account may own the rows it writes.
  const { householdId, accountId } = await seedAccount();
  const other = await models.Household.create({ name: 'Someone Else' } as never);
  const preview = makePreview(accountId, householdId, { ratePeriods: [ratePeriod()] });
  preview.householdId = other.id as number;

  await commitStatementImport(preview, null, householdId);

  const rows = await models.AccountRatePeriod.findAll({ where: { accountId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].householdId, householdId);
});

test('re-importing the same window updates it in place instead of duplicating', async () => {
  const { householdId, accountId } = await seedAccount();
  await commitStatementImport(
    makePreview(accountId, householdId, {
      ratePeriods: [ratePeriod({ effectiveRate: '8.9400', applicableInterest: '123.4500' })],
    }),
    null,
    householdId,
  );

  // The next statement restates the window it shares with the previous one,
  // this time with the interest RBC finally applied to it.
  await commitStatementImport(
    makePreview(accountId, householdId, {
      ratePeriods: [
        ratePeriod({ toDate: '2026-03-09', effectiveRate: '8.7000', applicableInterest: '150.0000' }),
      ],
    }),
    null,
    householdId,
  );

  const rows = await models.AccountRatePeriod.findAll({ where: { accountId } });
  assert.equal(rows.length, 1, `expected the window to be updated, got ${rows.length} rows`);
  assert.equal(rows[0].toDate, '2026-03-09');
  assert.equal(Number(rows[0].effectiveRate), 8.7);
  assert.equal(Number(rows[0].applicableInterest), 150);
});

test('a statement with no rate windows commits its transactions unaffected', async () => {
  const { householdId, accountId } = await seedAccount();
  const result = await commitStatementImport(
    makePreview(accountId, householdId),
    null,
    householdId,
  );

  assert.equal(result.insertedTransactions, 1);
  assert.equal(await models.AccountRatePeriod.count({ where: { accountId } }), 0);
  assert.deepEqual(result.warnings, [], `expected no warnings, got ${JSON.stringify(result.warnings)}`);
});

/**
 * The whole path, end to end: a real Royal Credit Line statement layout goes
 * through `parseStatementFile` (which is where the parser's `ratePeriods` has
 * to be carried onto the preview) and then through commit. The unit tests
 * above hand-build a preview, so only this one can catch the carry-through
 * being dropped.
 */
test('a parsed Royal Credit Line statement carries its rate table all the way to the table', async () => {
  const { householdId, accountId } = await seedAccount();
  const header = (text: string, page: number, y: number) => ({ page, y, text });
  const body = (text: string, page: number, y: number, x: number) => ({
    page,
    y,
    text,
    items: [{ x, width: text.length * 5, str: text.trim() }],
  });
  const lines = [
    header('ROYAL BANK OF CANADA', 1, 730),
    // One line, not two: `rbcCreditLineParser.sniff` requires the title and
    // the word "Statement" within three characters of each other.
    header(' Your Royal Credit Line® Statement', 1, 719),
    header('From November 4, 2025 to December 3, 2025', 1, 671),
    header(' Your loan account number:   73772650-001', 1, 627),
    header('Principal balance on November 4, 2025   $1,000.00', 1, 424),
    header('Principal balance on December 3, 2025   $1,500.00', 1, 342),
    header(' Details of your account activity', 1, 185),
    body(
      ' Date   Description   Interest/Fees/Insurance ($)   Withdrawals ($)   Payments ($)   Balance owing ($)',
      1,
      167,
      45.1,
    ),
    body(' 10 Nov   WWW TFR   500.00   -1,500.00', 1, 151, 47.3),
    header(' Rate History for your Statement Period', 2, 700),
    header(
      ' Rate from and including   Rate to and including   Prime Rate   Premium/discount   Your Rate   Applicable Interest ($)',
      2,
      690,
    ),
    header('November 4, 2025   December 3, 2025   4.450 %   +4.490 %   8.940 %   172.36', 2, 680),
  ];

  const { parseStatementFile } = await import('./parseStatementFile');
  const preview = await parseStatementFile({
    buffer: Buffer.from('not a real pdf'),
    fileName: 'Credit Line Statement-0001 2025-12-03.pdf',
    accountId,
    householdId,
    preExtractedLines: lines as never,
  });
  assert.ok(!('ok' in preview && preview.ok === false), 'statement should parse');

  const result = await commitStatementImport(preview as StatementPreview, null, householdId);
  assert.equal(result.insertedTransactions, 1);

  const rows = await models.AccountRatePeriod.findAll({ where: { accountId } });
  assert.equal(rows.length, 1, `expected the parsed rate window to be persisted, got ${rows.length}`);
  assert.equal(rows[0].fromDate, '2025-11-04');
  assert.equal(rows[0].toDate, '2025-12-03');
  assert.equal(Number(rows[0].effectiveRate), 8.94);
  assert.equal(Number(rows[0].applicableInterest), 172.36);
  assert.equal(rows[0].householdId, householdId);
  assert.equal(rows[0].sourceStatementId, null);
});

test('a rate-persistence failure warns but still commits the transactions', async () => {
  // The single most important property of this feature: transactions are the
  // reason to import a statement. A broken rate table must cost the rate
  // table, never the ledger.
  const { householdId, accountId } = await seedAccount();
  mock.method(models.AccountRatePeriod, 'findOne', () => {
    throw new Error('rate table exploded');
  });

  const result = await commitStatementImport(
    makePreview(accountId, householdId, { ratePeriods: [ratePeriod()] }),
    null,
    householdId,
  );

  assert.equal(result.insertedTransactions, 1, 'transactions must survive a rate failure');
  assert.equal(
    await models.Transaction.count({ where: { accountId } }),
    1,
    'the transaction must be committed, not rolled back',
  );
  assert.equal(await models.AccountRatePeriod.count({ where: { accountId } }), 0);
  assert.ok(
    result.warnings.some((w) => /rate/i.test(w) && /rate table exploded/.test(w)),
    `expected a rate warning naming the cause, got ${JSON.stringify(result.warnings)}`,
  );
});

test('a database-level rate failure is contained too, not just a thrown helper', async () => {
  // The previous test throws from JS. This one makes the DRIVER reject the
  // write (effective_rate is NOT NULL), which is the failure that actually
  // threatens the import: on Postgres an error inside an open transaction
  // aborts it outright, so the write has to sit inside a SAVEPOINT for the
  // ledger to survive. A plain try/catch alone would pass the test above and
  // still lose every transaction in production.
  const { householdId, accountId } = await seedAccount();
  const broken = ratePeriod();
  (broken as { effectiveRate: string | null }).effectiveRate = null;

  const result = await commitStatementImport(
    makePreview(accountId, householdId, {
      ratePeriods: [ratePeriod({ fromDate: '2026-01-09', toDate: '2026-02-08' }), broken],
    }),
    null,
    householdId,
  );

  assert.equal(result.insertedTransactions, 1, 'transactions must survive a rejected rate write');
  assert.equal(await models.Transaction.count({ where: { accountId } }), 1);
  // All-or-nothing for the rate table: the savepoint rolls back the good
  // window alongside the bad one, so a half-written rate history never
  // reaches the interest allocator.
  assert.equal(await models.AccountRatePeriod.count({ where: { accountId } }), 0);
  assert.ok(
    result.warnings.some((w) => /rate history not saved/i.test(w)),
    `expected a rate warning, got ${JSON.stringify(result.warnings)}`,
  );
});
