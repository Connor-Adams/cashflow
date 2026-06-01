/**
 * Integration tests for Tasks 4 + 5 of PR B:
 *   Task 4:
 *     - findOrCreateContactByName deduplication by normalized_name
 *     - resolveCounterpartyContact: person-kind creates/dedupes; payroll-kind returns null
 *   Task 5:
 *     - commitStatementImport auto-creates + links a Contact for person-kind counterparties
 *     - deduplication: two rows for the same name link to the SAME contact
 *     - payroll rows set counterpartyRaw but NOT counterpartyContactId
 *     - re-importing the same statement is idempotent (no duplicate contact)
 *
 * Task 5 tests drive commitStatementImport directly with a StatementPreview
 * fixture. The CSV importCsvFile path (runImport.ts) has its own commit loop
 * that is out of scope for this task; commitStatementImport covers the web
 * upload preview→commit flow and all PDF/WS-bundle imports.
 *
 * All `before()` setup is consolidated into a single hook to avoid the Node
 * test-runner concurrency footgun: multiple top-level before() hooks run
 * concurrently, not sequentially, so the second hook must not import any
 * app/DB modules that would race with setupPgTestDb in the first hook.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let agentA: ReturnType<typeof request.agent>;
let householdAId: number;
let testDb: PgTestDb;

// Task 5 fixtures — seeded in the single before() hook below.
let importHouseholdId: number;
let importUserId: number;
let importAccountId: number;
let commitStatementImport: typeof import('../../src/import/commitStatementImport.js').commitStatementImport;

before(async () => {
  testDb = await setupPgTestDb('cpimport_autolink');
  app = (await import('../../src/app.js')).default;

  // Bootstrap superadmin — first registered user.
  const bootstrap = request.agent(app);
  const reg = await bootstrap.post('/api/auth/register').send({
    email: 'boot-autolink@example.com',
    displayName: 'Boot',
    password: 'password123',
  });
  assert.equal(reg.status, 201);

  const seedA = await seedHousehold('autolinkA', 'Self A');
  householdAId = seedA.householdId;
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${seedA.token}; Path=/`);

  // ── Task 5 fixtures ──────────────────────────────────────────────────────
  // Import these after the app is initialized (PG connection live).
  const models = await import('../../src/models');
  commitStatementImport = (await import('../../src/import/commitStatementImport.js')).commitStatementImport;

  const household = await models.Household.create({ name: 'Import Autolink Household' } as never);
  importHouseholdId = household.id;

  const user = await models.User.create({
    email: `import-autolink-${Date.now()}@example.com`,
    displayName: 'Import Autolink User',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  importUserId = user.id;

  const account = await models.Account.create({
    name: 'Import Autolink Checking',
    householdId: importHouseholdId,
    ownerUserId: importUserId,
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'checking',
    visibility: 'private',
  } as never);
  importAccountId = account.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

// ─── Task 5 helpers ────────────────────────────────────────────────────────

/** Build a minimal StatementPreview for a single CSV row. */
function makePreview(
  opts: {
    fileName: string;
    contentHash?: string;
    rows: Array<{ date: string; merchantRaw: string; amount: number }>;
  },
): import('../../src/import/statementTypes.js').StatementPreview {
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
    accountId: importAccountId,
    householdId: importHouseholdId,
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

// ─── Task 4 tests ──────────────────────────────────────────────────────────

test('resolveCounterpartyContact creates one contact and dedupes casing variants', async () => {
  const models = await import('../../src/models');
  const { resolveCounterpartyContact } = await import('../../src/contacts/findOrCreateContact.js');
  const id1 = await resolveCounterpartyContact(householdAId, { name: 'JANE DOE', kind: 'person' });
  const id2 = await resolveCounterpartyContact(householdAId, { name: 'Jane Doe', kind: 'person' });
  assert.equal(id1, id2, 'casing variants resolve to the same contact');
  const count = await models.Contact.count({ where: { householdId: householdAId, normalizedName: 'jane doe' } });
  assert.equal(count, 1);
});

test('resolveCounterpartyContact returns null for payroll kind', async () => {
  const { resolveCounterpartyContact } = await import('../../src/contacts/findOrCreateContact.js');
  assert.equal(await resolveCounterpartyContact(householdAId, { name: 'ACME CORP', kind: 'payroll' }), null);
});

// ─── Task 5 tests: commitStatementImport auto-creates + links person Contacts

test('import: INTERAC E-TRANSFER TO JOHN DOE creates one Contact and links the transaction', async () => {
  const models = await import('../../src/models');

  const preview = makePreview({
    fileName: 'autolink-john-doe-1.csv',
    rows: [{ date: '2026-05-01', merchantRaw: 'INTERAC E-TRANSFER TO JOHN DOE REF 11', amount: -50 }],
  });

  const result = await commitStatementImport(preview, importUserId, importHouseholdId);
  assert.equal(result.insertedTransactions, 1, `expected 1 inserted transaction, got: ${JSON.stringify(result)}`);

  // Exactly one Contact for 'john doe' in this household
  const contacts = await models.Contact.findAll({
    where: { householdId: importHouseholdId, normalizedName: 'john doe' },
  });
  assert.equal(contacts.length, 1, 'expected exactly one Contact for john doe');
  const contactId = contacts[0].id;

  // The created transaction's counterpartyContactId points at that contact
  const txns = await models.Transaction.findAll({
    where: { accountId: importAccountId, counterpartyContactId: contactId },
  });
  assert.equal(txns.length, 1, 'expected one transaction linked to the john doe contact');
  assert.equal(txns[0].counterpartyRaw, 'JOHN DOE');
});

test('import: second INTERAC E-TRANSFER TO JOHN DOE row links to the SAME contact (no duplicate)', async () => {
  const models = await import('../../src/models');

  const preview = makePreview({
    fileName: 'autolink-john-doe-2.csv',
    rows: [{ date: '2026-05-15', merchantRaw: 'INTERAC E-TRANSFER TO JOHN DOE REF 77', amount: -30 }],
  });

  const result = await commitStatementImport(preview, importUserId, importHouseholdId);
  assert.equal(result.insertedTransactions, 1, `expected 1 inserted transaction, got: ${JSON.stringify(result)}`);

  // Still exactly one Contact for 'john doe' — no duplicate created
  const contactCount = await models.Contact.count({
    where: { householdId: importHouseholdId, normalizedName: 'john doe' },
  });
  assert.equal(contactCount, 1, 'should still have exactly one john doe contact');

  // Both transactions are linked to the same contact
  const contacts = await models.Contact.findAll({
    where: { householdId: importHouseholdId, normalizedName: 'john doe' },
  });
  const contactId = contacts[0].id;
  const txns = await models.Transaction.findAll({
    where: { accountId: importAccountId, counterpartyContactId: contactId },
    order: [['date', 'ASC']],
  });
  assert.equal(txns.length, 2, 'expected both john doe transactions linked to the same contact');
});

test('import: PAYROLL DEPOSIT ACME CORP sets counterpartyRaw but leaves counterpartyContactId null', async () => {
  const models = await import('../../src/models');

  const preview = makePreview({
    fileName: 'autolink-payroll.csv',
    rows: [{ date: '2026-05-20', merchantRaw: 'PAYROLL DEPOSIT ACME CORP', amount: 3500 }],
  });

  const result = await commitStatementImport(preview, importUserId, importHouseholdId);
  assert.equal(result.insertedTransactions, 1, `expected 1 inserted transaction, got: ${JSON.stringify(result)}`);

  const txns = await models.Transaction.findAll({
    where: { accountId: importAccountId, merchantRaw: 'PAYROLL DEPOSIT ACME CORP' },
  });
  assert.equal(txns.length, 1);
  assert.equal(txns[0].counterpartyRaw, 'ACME CORP');
  assert.equal(txns[0].counterpartyContactId, null, 'payroll counterparty must not create a Contact');
});

test('import: re-importing the same statement is idempotent (no duplicate contact)', async () => {
  const models = await import('../../src/models');

  // Re-use the same contentHash as the first john doe test; the ImportHistory
  // short-circuit in commitStatementImport will skip all rows.
  const firstHash = 'idempotent-test-hash-john-doe-1';
  const preview1 = makePreview({
    fileName: 'autolink-idempotent.csv',
    contentHash: firstHash,
    rows: [{ date: '2026-06-01', merchantRaw: 'INTERAC E-TRANSFER TO JOHN DOE REF 99', amount: -25 }],
  });

  const result1 = await commitStatementImport(preview1, importUserId, importHouseholdId);
  assert.equal(result1.insertedTransactions, 1, `first import should insert 1 row`);

  // Same contentHash → import is short-circuited
  const preview2 = makePreview({
    fileName: 'autolink-idempotent.csv',
    contentHash: firstHash,  // same hash triggers the early return
    rows: [{ date: '2026-06-01', merchantRaw: 'INTERAC E-TRANSFER TO JOHN DOE REF 99', amount: -25 }],
  });

  const result2 = await commitStatementImport(preview2, importUserId, importHouseholdId);
  assert.equal(result2.inserted, 0, 're-import should insert nothing');
  assert.ok(
    result2.warnings.some((w) => w.includes('already imported')),
    `expected "already imported" warning, got: ${JSON.stringify(result2.warnings)}`,
  );

  // Still exactly one contact for john doe in this household
  const contactCount = await models.Contact.count({
    where: { householdId: importHouseholdId, normalizedName: 'john doe' },
  });
  // Note: we may have contacts from prior john doe tests too (same household),
  // but should still have exactly 1 (they all dedup to the same normalized name).
  assert.equal(contactCount, 1, 'no duplicate Contact created on re-import');
});
