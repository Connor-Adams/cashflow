import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { rowFingerprint } from '../../src/import/fingerprint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-backfill.sqlite');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let backfillModule: typeof import('../../src/import/runEnrichmentBackfill.js');

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });
  models = await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;
  backfillModule = await import('../../src/import/runEnrichmentBackfill.js');
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'backfill@example.com',
    displayName: 'Backfill User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
  const account = await authed.post('/api/accounts').send({
    name: 'Backfill Card',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(account.status, 201);
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

function seedFlags(overrides: Partial<Parameters<typeof backfillModule.runBackfill>[0]>): Parameters<typeof backfillModule.runBackfill>[0] {
  return {
    dryRun: false,
    noReviewFlag: false,
    reviewOnly: false,
    verbose: false,
    accountId: null,
    householdId: null,
    limit: null,
    batchSize: 50,
    dateFrom: null,
    dateTo: null,
    ...overrides,
  };
}

async function createTxn(opts: {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  date?: string;
  reviewFlag?: boolean;
  autoSource?: string | null;
}) {
  const acc = await models.Account.findOne();
  assert.ok(acc);
  return models.Transaction.create({
    accountId: acc.id,
    householdId: acc.householdId,
    createdByUserId: acc.ownerUserId,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'backfill-test',
    date: opts.date ?? '2026-04-15',
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantClean,
    amount: String(opts.amount),
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId: acc.id,
      date: opts.date ?? '2026-04-15',
      amount: opts.amount,
      currency: 'CAD',
      merchantClean: opts.merchantClean,
      sourceReference: '',
    }),
    txnType: 'purchase',
    reviewFlag: opts.reviewFlag ?? true,
    autoSource: opts.autoSource ?? null,
    isRecurring: false,
  } as never);
}

test('backfill re-cleans merchant_clean for old-form rows', async () => {
  const txn = await createTxn({
    merchantRaw: 'SQ *JOE COFFEE TORONTO ON #1234',
    merchantClean: 'SQ *JOE COFFEE TORONTO ON #1234',
    amount: -6.5,
  });

  const result = await backfillModule.runBackfill(seedFlags({}));

  assert.ok(result.processed >= 1);
  await txn.reload();
  assert.equal(txn.merchantClean, 'JOE COFFEE');
});

test('backfill applies rule and clears review_flag on previously-unreviewed row', async () => {
  const acc = await models.Account.findOne();
  assert.ok(acc);

  const rule = await models.Rule.create({
    householdId: acc.householdId,
    merchantPattern: 'NETFLIX',
    matchKind: 'substring',
    priority: 5,
    category: 'Subscriptions',
    isBusiness: false,
    splitType: 'shared',
    pctMe: '0.5',
    pctPartner: '0.5',
  } as never);

  const netflix = await createTxn({
    merchantRaw: 'NETFLIX.COM',
    merchantClean: 'NETFLIX.COM',
    amount: -14.99,
    date: '2026-04-20',
    reviewFlag: true,
  });
  const unknown = await createTxn({
    merchantRaw: 'COLD ROW NOBODY KNOWS',
    merchantClean: 'COLD ROW NOBODY KNOWS',
    amount: -3.21,
    date: '2026-04-21',
    reviewFlag: true,
  });

  const result = await backfillModule.runBackfill(seedFlags({}));
  assert.ok(result.processed >= 2);

  await netflix.reload();
  assert.equal(netflix.autoSource, 'rule');
  assert.equal(netflix.autoConfidence, 'high');
  assert.equal(netflix.autoCategory, 'Subscriptions');
  assert.equal(netflix.appliedRuleId, rule.id);
  assert.equal(netflix.reviewFlag, false);
  assert.equal(netflix.merchantCanonical, 'Netflix');

  await unknown.reload();
  assert.equal(unknown.reviewFlag, true);
  assert.equal(unknown.autoSource, null);
  assert.equal(unknown.autoCategory, null);
});

test('backfill writes transaction_signals rows for every processed transaction', async () => {
  const txns = await models.Transaction.findAll();
  for (const t of txns) {
    const signals = await models.TransactionSignal.findAll({ where: { transactionId: t.id } });
    assert.ok(signals.length >= 1, `txn ${t.id} should have signals after backfill`);
    const sources = signals.map((s) => s.source);
    assert.ok(
      sources.includes('normalize-seed') || sources.includes('normalize-learned'),
      `txn ${t.id} should have a normalize stage signal, got ${sources.join(',')}`,
    );
  }
});

test('backfill --no-review-flag preserves review_flag', async () => {
  const txn = await createTxn({
    merchantRaw: 'SOME UNIQUE MERCHANT XYZ',
    merchantClean: 'SOME UNIQUE MERCHANT XYZ',
    amount: -10,
    date: '2026-04-22',
    reviewFlag: true,
  });

  // Create a rule that would match
  const acc = await models.Account.findOne();
  await models.Rule.create({
    householdId: acc!.householdId,
    merchantPattern: 'SOME UNIQUE MERCHANT XYZ',
    matchKind: 'substring',
    priority: 5,
    category: 'TestCat',
    isBusiness: false,
    splitType: 'me',
    pctMe: null,
    pctPartner: null,
  } as never);

  await backfillModule.runBackfill(seedFlags({ noReviewFlag: true }));

  await txn.reload();
  assert.equal(txn.autoSource, 'rule', 'auto fields should still be populated');
  assert.equal(txn.autoCategory, 'TestCat');
  assert.equal(txn.reviewFlag, true, 'review_flag must be preserved when --no-review-flag set');
});

test('backfill --dry-run writes nothing', async () => {
  const txn = await createTxn({
    merchantRaw: 'DRY RUN TEST',
    merchantClean: 'DRY RUN TEST',
    amount: -1,
    date: '2026-04-23',
    reviewFlag: true,
    autoSource: null,
  });
  const beforeSignals = await models.TransactionSignal.count({ where: { transactionId: txn.id } });
  assert.equal(beforeSignals, 0);

  const result = await backfillModule.runBackfill(seedFlags({ dryRun: true }));
  assert.ok(result.processed >= 1);

  await txn.reload();
  assert.equal(txn.autoSource, null, 'dry-run should not write auto_source');
  const afterSignals = await models.TransactionSignal.count({ where: { transactionId: txn.id } });
  assert.equal(afterSignals, 0, 'dry-run should not insert signals');
});

test('backfill is idempotent', async () => {
  await backfillModule.runBackfill(seedFlags({}));
  const txnsBefore = await models.Transaction.findAll({ order: [['id', 'ASC']] });
  const signalsBefore = await models.TransactionSignal.findAll({ order: [['id', 'ASC']] });

  await backfillModule.runBackfill(seedFlags({}));
  const txnsAfter = await models.Transaction.findAll({ order: [['id', 'ASC']] });

  // Field-by-field equality on enrichment columns
  assert.equal(txnsAfter.length, txnsBefore.length);
  for (let i = 0; i < txnsBefore.length; i++) {
    const a = txnsBefore[i];
    const b = txnsAfter[i];
    assert.equal(b.merchantClean, a.merchantClean);
    assert.equal(b.autoSource, a.autoSource);
    assert.equal(b.autoConfidence, a.autoConfidence);
    assert.equal(b.autoCategory, a.autoCategory);
    assert.equal(b.reviewFlag, a.reviewFlag);
    assert.equal(b.txnType, a.txnType);
  }

  // Signal counts may differ in id but should be the same per-transaction count
  const signalsAfter = await models.TransactionSignal.findAll();
  const countPerTxn = (rows: typeof signalsAfter) => {
    const m = new Map<number, number>();
    for (const r of rows) m.set(r.transactionId, (m.get(r.transactionId) ?? 0) + 1);
    return m;
  };
  const before = countPerTxn(signalsBefore);
  const after = countPerTxn(signalsAfter);
  assert.equal(after.size, before.size);
  for (const [k, v] of before) assert.equal(after.get(k), v);
});

test('backfill respects dateFrom/dateTo filter', async () => {
  const inWindow = await createTxn({
    merchantRaw: 'WINDOW INSIDE',
    merchantClean: 'WINDOW INSIDE',
    amount: -1,
    date: '2026-04-10',
    autoSource: 'rule',
  });
  const outOfWindow = await createTxn({
    merchantRaw: 'WINDOW OUTSIDE',
    merchantClean: 'WINDOW OUTSIDE',
    amount: -1,
    date: '2025-01-01',
    autoSource: 'rule',
  });

  // Sanity: both rows have no signals yet.
  const beforeInSignals = await models.TransactionSignal.count({ where: { transactionId: inWindow.id } });
  const beforeOutSignals = await models.TransactionSignal.count({ where: { transactionId: outOfWindow.id } });
  assert.equal(beforeInSignals, 0);
  assert.equal(beforeOutSignals, 0);

  await backfillModule.runBackfill(seedFlags({ dateFrom: '2026-04-01', dateTo: '2026-04-30' }));

  // The out-of-window row must not have been processed: no signals written.
  const afterOutSignals = await models.TransactionSignal.count({ where: { transactionId: outOfWindow.id } });
  assert.equal(afterOutSignals, 0, 'out-of-window row must not be processed when dateTo excludes it');

  // The in-window row was processed: it picked up at least one signal.
  const afterInSignals = await models.TransactionSignal.count({ where: { transactionId: inWindow.id } });
  assert.ok(afterInSignals > 0, 'in-window row should be processed and have signals');
});
