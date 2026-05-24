/**
 * Integration tests for runImport.ts edge cases + Amazon persistence layer:
 * - SAVEPOINT-around-per-row insert (unique violation does not poison outer txn)
 * - persistOrder idempotence (Amazon)
 * - applyAmazonItemCategorySuggestions (Amazon)
 * - categorizeAmazonItemsWithAi injection + missing-API-key propagation
 * - Risk B documentation: re-import that initially all-dup'd creates a 2nd ImportHistory
 * - Risk D documentation: PDF commitStatementImport throw leaves no ImportHistory (skipped)
 * - Risk E: row-level dedup catches re-import when contentHash differs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-orchestrator-edge.sqlite');

let models: typeof import('../../src/models/index.js');
let importCsvFile: typeof import('../../src/import/runImport.js').importCsvFile;
let rowFingerprint: typeof import('../../src/import/fingerprint.js').rowFingerprint;
let normalizeAmazonOrder: typeof import('../../src/amazon/normalizeAmazonOrder.js').normalizeAmazonOrder;
let importAmazonReportCsv: typeof import('../../src/amazon/importAmazonOrders.js').importAmazonReportCsv;
let categorizeAmazonItemsWithAi: typeof import('../../src/amazon/aiCategorizeAmazonItems.js').categorizeAmazonItemsWithAi;
let applyAmazonItemCategorySuggestions: typeof import('../../src/amazon/aiCategorizeAmazonItems.js').applyAmazonItemCategorySuggestions;
let isSequelizeUniqueLike: typeof import('../../src/import/runImport.js').isSequelizeUniqueLike;
let amazonHouseholdId: number;
let amazonUserId: number;

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
  importCsvFile = (await import('../../src/import/runImport.js')).importCsvFile;
  isSequelizeUniqueLike = (await import('../../src/import/runImport.js')).isSequelizeUniqueLike;
  rowFingerprint = (await import('../../src/import/fingerprint.js')).rowFingerprint;
  normalizeAmazonOrder = (await import('../../src/amazon/normalizeAmazonOrder.js')).normalizeAmazonOrder;
  importAmazonReportCsv = (await import('../../src/amazon/importAmazonOrders.js')).importAmazonReportCsv;
  const aiModule = await import('../../src/amazon/aiCategorizeAmazonItems.js');
  categorizeAmazonItemsWithAi = aiModule.categorizeAmazonItemsWithAi;
  applyAmazonItemCategorySuggestions = aiModule.applyAmazonItemCategorySuggestions;

  // Amazon ExternalOrder has FKs on households(id) and users(id); create both
  // for the Amazon-side tests below.
  const household = await models.Household.create({ name: 'Edge Test Household' } as never);
  amazonHouseholdId = household.id;
  const user = await models.User.create({
    email: 'edge@example.com',
    displayName: 'Edge Test User',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  amazonUserId = user.id;
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

async function makeAccount(name: string) {
  return models.Account.create({
    name,
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
}

async function seedTransaction(opts: {
  accountId: number;
  date: string;
  amount: number;
  merchantRaw: string;
  sourceReference: string | null;
}) {
  const fp = rowFingerprint({
    accountId: opts.accountId,
    date: opts.date,
    amount: opts.amount,
    currency: 'CAD',
    merchantRaw: opts.merchantRaw,
    sourceReference: opts.sourceReference,
  });
  return models.Transaction.create({
    accountId: opts.accountId,
    householdId: null,
    createdByUserId: null,
    visibility: 'private',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'edge-test',
    date: opts.date,
    merchantRaw: opts.merchantRaw,
    merchantClean: opts.merchantRaw,
    amount: String(opts.amount),
    currency: 'CAD',
    notes: null,
    sourceReference: opts.sourceReference,
    sourceRowFingerprint: fp,
    txnType: 'purchase',
    reviewFlag: false,
    isRecurring: false,
  } as never);
}

// ─── Risk B: re-import of all-dup file creates a 2nd ImportHistory ─────────

test('Risk B: re-import after all-dups initial run creates a SECOND ImportHistory for same contentHash (documents bug)', async () => {
  // Documents Risk B — see TODO(import-all-dups-rerun) in runImport.ts.
  // The fix is NOT in this PR — this test exists as a regression marker.
  const acc = await makeAccount('Risk B Account');

  // Pre-seed the row that the CSV will produce, so the first import dedups
  // every row at the row-level and ImportHistory.rowCount = 0.
  await seedTransaction({
    accountId: acc.id,
    date: '2026-05-01',
    amount: -10,
    merchantRaw: 'Cafe',
    sourceReference: null,
  });

  const csv = 'Date,Description,Amount\n2026-05-01,Cafe,-10.00\n';
  const buf = Buffer.from(csv, 'utf8');

  const first = await importCsvFile({
    buffer: buf,
    fileName: 'risk-b.csv',
    accountId: acc.id,
    profileId: 'generic_simple',
  });
  // Use `as Record<string, unknown>` because the success branch returns a
  // dynamic Record, while skip branches return a different shape.
  const f = first as Record<string, unknown>;
  assert.equal(f.inserted, 0, JSON.stringify(first));
  assert.equal(f.skippedDuplicates, 1);

  const second = await importCsvFile({
    buffer: buf,
    fileName: 'risk-b.csv',
    accountId: acc.id,
    profileId: 'generic_simple',
  });
  const s = second as Record<string, unknown>;
  // The bug: short-circuit does NOT fire because priorRows === 0. The full
  // re-parse runs again, all rows dedup again, a NEW ImportHistory is created.
  assert.equal(s.inserted, 0);
  assert.equal(s.skippedDuplicates, 1);

  const contentHash = f.contentHash as string;
  const histories = await models.ImportHistory.findAll({
    where: { contentHash, status: 'success' },
  });
  assert.equal(
    histories.length,
    2,
    `Risk B: expected 2 ImportHistory rows for same contentHash, got ${histories.length}. ` +
      'If this fails it means the bug was fixed — update the TODO in runImport.ts and the related test.',
  );
});

// ─── Risk E: row-level dedup catches re-import on different contentHash ───

test('Risk E: re-importing same CSV content under a different filename/buffer triggers row-level dedup (sourceReference=null path)', async () => {
  const acc = await makeAccount('Risk E Account');
  const csv = 'Date,Description,Amount\n2026-06-01,RiskE Cafe,-7.50\n';

  const first = await importCsvFile({
    buffer: Buffer.from(csv, 'utf8'),
    fileName: 'risk-e.csv',
    accountId: acc.id,
    profileId: 'generic_simple',
  });
  const f = first as Record<string, unknown>;
  assert.equal(f.inserted, 1, JSON.stringify(first));
  assert.equal(f.skippedDuplicates, 0);

  // Different trailing-whitespace makes contentHash differ; the row content
  // is unchanged so row-level dedup must catch it.
  const csvVariant = csv + '\n';
  const second = await importCsvFile({
    buffer: Buffer.from(csvVariant, 'utf8'),
    fileName: 'risk-e-v2.csv',
    accountId: acc.id,
    profileId: 'generic_simple',
  });
  const s = second as Record<string, unknown>;
  assert.equal(s.inserted, 0, JSON.stringify(second));
  assert.equal(s.skippedDuplicates, 1);
});

// ─── SAVEPOINT around per-row insert ───────────────────────────────────────

test('SAVEPOINT: per-row unique-violation rolls back only the row; outer transaction continues', async () => {
  // We exercise the SAVEPOINT pattern directly (rather than through the
  // importCsvFile dedup-then-insert flow, which catches dupes pre-insert).
  // Pattern mirrors runImport.ts: outer sequelize.transaction wraps multiple
  // row attempts; each row uses sequelize.transaction({ transaction: t }) which
  // emits a SAVEPOINT.
  const acc = await makeAccount('Savepoint Account');

  const baseFp = rowFingerprint({
    accountId: acc.id,
    date: '2026-07-01',
    amount: -1,
    currency: 'CAD',
    merchantRaw: 'A',
    sourceReference: null,
  });

  let row1Caught = false;
  let row3InsertedId: number | null = null;
  let outerCommitted = false;

  await models.sequelize.transaction(async (t) => {
    // Row 1: insert OK
    await models.Transaction.create(
      {
        accountId: acc.id,
        householdId: null,
        createdByUserId: null,
        visibility: 'private',
        ownershipType: 'me',
        ownershipContactId: null,
        importBatch: 'savepoint-test',
        date: '2026-07-01',
        merchantRaw: 'A',
        merchantClean: 'A',
        amount: '-1',
        currency: 'CAD',
        notes: null,
        sourceReference: null,
        sourceRowFingerprint: baseFp,
        txnType: 'purchase',
        reviewFlag: false,
        isRecurring: false,
      } as never,
      { transaction: t },
    );

    // Row 2: same fingerprint → unique violation → caught by SAVEPOINT
    try {
      await models.sequelize.transaction({ transaction: t }, async (sp) => {
        await models.Transaction.create(
          {
            accountId: acc.id,
            householdId: null,
            createdByUserId: null,
            visibility: 'private',
            ownershipType: 'me',
            ownershipContactId: null,
            importBatch: 'savepoint-test',
            date: '2026-07-01',
            merchantRaw: 'A',
            merchantClean: 'A',
            amount: '-1',
            currency: 'CAD',
            notes: null,
            sourceReference: null,
            sourceRowFingerprint: baseFp, // duplicate fingerprint
            txnType: 'purchase',
            reviewFlag: false,
            isRecurring: false,
          } as never,
          { transaction: sp },
        );
      });
    } catch (e) {
      assert.equal(
        isSequelizeUniqueLike(e),
        true,
        `expected unique-like error; got ${(e as Error).name}: ${(e as Error).message}`,
      );
      row1Caught = true;
    }

    // Row 3: distinct fingerprint → outer transaction must NOT be aborted
    const row3Fp = rowFingerprint({
      accountId: acc.id,
      date: '2026-07-02',
      amount: -2,
      currency: 'CAD',
      merchantRaw: 'B',
      sourceReference: null,
    });
    const row3 = await models.Transaction.create(
      {
        accountId: acc.id,
        householdId: null,
        createdByUserId: null,
        visibility: 'private',
        ownershipType: 'me',
        ownershipContactId: null,
        importBatch: 'savepoint-test',
        date: '2026-07-02',
        merchantRaw: 'B',
        merchantClean: 'B',
        amount: '-2',
        currency: 'CAD',
        notes: null,
        sourceReference: null,
        sourceRowFingerprint: row3Fp,
        txnType: 'purchase',
        reviewFlag: false,
        isRecurring: false,
      } as never,
      { transaction: t },
    );
    row3InsertedId = row3.id;
    outerCommitted = true;
  });

  assert.equal(row1Caught, true, 'SAVEPOINT must catch the unique violation');
  assert.equal(outerCommitted, true, 'outer transaction must complete');
  assert.ok(row3InsertedId, 'row 3 must be inserted');

  const allInAccount = await models.Transaction.findAll({ where: { accountId: acc.id } });
  // Row 1 + Row 3 (Row 2 rolled back via SAVEPOINT)
  assert.equal(allInAccount.length, 2);
});

// ─── Amazon persistOrder idempotence ───────────────────────────────────────

test('Amazon persistOrder: importing same normalized order twice yields 1 ExternalOrder', async () => {
  // Bypass HTTP route and go directly through importAmazonReportCsv to keep
  // the test scoped to the persistence layer.
  const csv = [
    'Order ID,Order Date,Title,Item Total,Order Total',
    '701-9999999-9999999,2026-08-01,USB-C Cable,42.00,42.00',
  ].join('\n');

  const before = await models.ExternalOrder.count({
    where: { dedupeKey: 'amazon:order:701-9999999-9999999' },
  });
  assert.equal(before, 0);

  const first = await importAmazonReportCsv({
    text: csv,
    householdId: amazonHouseholdId,
    userId: amazonUserId,
  });
  assert.equal(first.created, 1);
  assert.equal(first.skipped, 0);

  const second = await importAmazonReportCsv({
    text: csv,
    householdId: amazonHouseholdId,
    userId: 0,
  });
  assert.equal(second.created, 0);
  assert.equal(second.skipped, 1);

  const after = await models.ExternalOrder.count({
    where: { dedupeKey: 'amazon:order:701-9999999-9999999' },
  });
  assert.equal(after, 1);

  // Tiny sanity on normalizeAmazonOrder: keeps the contract surfaced here so
  // changes to dedupeKey computation will break this test loudly.
  const normalized = normalizeAmazonOrder({
    vendorOrderId: '701-9999999-9999999',
    source: 'amazon_report',
    items: [{ title: 'USB-C Cable', totalPrice: 42 }],
  });
  assert.equal(normalized.dedupeKey, 'amazon:order:701-9999999-9999999');
});

// ─── applyAmazonItemCategorySuggestions: writes the right shape ────────────

test('applyAmazonItemCategorySuggestions: updates inferredCategory + stringifies decimals', async () => {
  // Set up an order + item directly.
  const order = await models.ExternalOrder.create({
    householdId: amazonHouseholdId,
    createdByUserId: amazonUserId,
    vendor: 'amazon',
    vendorOrderId: 'apply-suggestion-order',
    dedupeKey: 'amazon:order:apply-suggestion-order',
    orderDate: '2026-08-15',
    shipmentDate: null,
    subtotal: null,
    tax: null,
    shipping: null,
    total: '100.00',
    currency: 'CAD',
    paymentLast4: null,
    source: 'amazon_report',
    rawPayload: null,
  } as never);

  const item = await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Widget',
    quantity: 1,
    unitPrice: '100.00',
    totalPrice: '100.00',
    inferredCategory: 'Uncategorized',
    businessUsePercent: null,
    confidence: null,
    rawPayload: null,
  } as never);

  const updated = await applyAmazonItemCategorySuggestions([
    {
      itemId: item.id,
      category: 'Office Equipment',
      businessUsePercent: 80,
      confidence: 90,
      rationale: 'Computer accessory.',
      usedExistingCategory: false,
    },
  ]);

  assert.equal(updated, 1);
  const fresh = await models.ExternalOrderItem.findByPk(item.id);
  assert.ok(fresh);
  assert.equal(fresh!.inferredCategory, 'Office Equipment');
  // DECIMAL columns are written as strings by the production code; the read
  // value's runtime type depends on dialect (string on Postgres, number on
  // SQLite). Stringify both to make this dialect-agnostic.
  assert.equal(String(fresh!.businessUsePercent), '80');
  assert.equal(String(fresh!.confidence), '90');
});

// ─── categorizeAmazonItemsWithAi: openaiCaller injection ───────────────────

test('categorizeAmazonItemsWithAi: injected openaiCaller returns canned suggestions; no network', async () => {
  // Set up an order + item to act on.
  const order = await models.ExternalOrder.create({
    householdId: amazonHouseholdId,
    createdByUserId: amazonUserId,
    vendor: 'amazon',
    vendorOrderId: 'ai-injection-order',
    dedupeKey: 'amazon:order:ai-injection-order',
    orderDate: '2026-08-20',
    shipmentDate: null,
    subtotal: null,
    tax: null,
    shipping: null,
    total: '25.00',
    currency: 'CAD',
    paymentLast4: null,
    source: 'amazon_report',
    rawPayload: null,
  } as never);

  const item = await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'USB-C Hub',
    quantity: 1,
    unitPrice: '25.00',
    totalPrice: '25.00',
    inferredCategory: 'Uncategorized',
    businessUsePercent: null,
    confidence: null,
    rawPayload: null,
  } as never);

  let callCount = 0;
  const result = await categorizeAmazonItemsWithAi(
    { householdId: amazonHouseholdId, itemIds: [item.id] },
    {
      openaiCaller: async () => {
        callCount += 1;
        return {
          json: {
            items: [
              {
                itemId: item.id,
                category: 'Office Equipment',
                businessUsePercent: 80,
                confidence: 90,
                rationale: 'Computer peripheral',
              },
            ],
          },
          model: 'stub-model',
          temperature: 0.1,
          latencyMs: 5,
          providerRequestId: 'stub-req-id',
          rawTextPreview: '{"items":[...]}',
        };
      },
    },
  );

  assert.equal(callCount, 1);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].itemId, item.id);
  assert.equal(result.suggestions[0].category, 'Office Equipment');
  assert.equal(result.suggestions[0].businessUsePercent, 80);
  assert.equal(result.suggestions[0].confidence, 90);
});

test('categorizeAmazonItemsWithAi: default caller propagates missing-OPENAI_API_KEY error', async () => {
  // Set up an item so the function reaches the openai call.
  const order = await models.ExternalOrder.create({
    householdId: amazonHouseholdId,
    createdByUserId: amazonUserId,
    vendor: 'amazon',
    vendorOrderId: 'ai-noapikey-order',
    dedupeKey: 'amazon:order:ai-noapikey-order',
    orderDate: '2026-08-21',
    shipmentDate: null,
    subtotal: null,
    tax: null,
    shipping: null,
    total: '10.00',
    currency: 'CAD',
    paymentLast4: null,
    source: 'amazon_report',
    rawPayload: null,
  } as never);
  const item = await models.ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Cable',
    quantity: 1,
    unitPrice: '10.00',
    totalPrice: '10.00',
    inferredCategory: null,
    businessUsePercent: null,
    confidence: null,
    rawPayload: null,
  } as never);

  const prior = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => categorizeAmazonItemsWithAi({ householdId: amazonHouseholdId, itemIds: [item.id] }),
      /OpenAI is not configured/i,
    );
  } finally {
    if (prior !== undefined) process.env.OPENAI_API_KEY = prior;
  }
});

// ─── Risk D documentation: PDF commitStatementImport throw, no ImportHistory ──

test(
  'Risk D: PDF commitStatementImport throw produces no ImportHistory record',
  { skip: 'known gap: see TODO(import-pdf-audit-gap) in runImport.ts' },
  async () => {
    // Placeholder regression marker. When the gap is fixed (wrap PDF commit in
    // try/catch + write a failed ImportHistory), unskip and assert:
    //   - importCsvFile rejects (or returns skipped) on commit throw
    //   - exactly one ImportHistory row exists with status='failed' and
    //     batchLabel='pdf-commit-error'
    assert.ok(false, 'unreachable');
  },
);
