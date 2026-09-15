/**
 * Integration: the reconciliation gate on `POST /api/import/commit`.
 *
 * The unit tests (backend/src/import/commitStatementImportReconciliation.test.ts)
 * prove `commitStatementImport` itself refuses an unreconciled statement. These
 * prove the HTTP surface around it against real Postgres:
 *
 *  - a preview carrying a blocking parse error is refused with 422 and the
 *    preview token STAYS VALID, so the user can look at the discrepancy and
 *    re-submit rather than re-upload;
 *  - the refusal hands back an `acknowledgement` digest, and re-submitting that
 *    same token WITH that digest imports and stamps `accepted_unreconciled` on
 *    the import_histories row;
 *  - a bare `true`, a string-y `"true"`, a garbage digest, and a digest minted
 *    for a different preview are all refused and insert nothing — the override
 *    acknowledges one specific discrepancy, it is not a blanket flag;
 *  - an ordinary, non-blocking parse error commits as it always has.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let testDb: PgTestDb;
let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let models: typeof import('../../src/models/index.js');
let saveStatementPreview: typeof import('../../src/import/statementPreviewStore.js').saveStatementPreview;

before(async () => {
  testDb = await setupPgTestDb('commit_recon');
  models = await import('../../src/models/index.js');
  const mod = await import('../../src/app.js');
  app = mod.default;
  saveStatementPreview = (await import('../../src/import/statementPreviewStore.js'))
    .saveStatementPreview;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'recon-gate@example.com',
    displayName: 'Recon Gate',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

async function makeAccount(name: string): Promise<number> {
  const res = await authed.post('/api/accounts').send({
    name,
    owner: 'me',
    accountType: 'loan',
    defaultCurrency: 'CAD',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as number;
}

let n = 0;
function seedPreview(opts: {
  accountId: number;
  householdId: number;
  parseErrors: Array<{ rowIndex: number; message: string; blocking?: boolean }>;
  rowErrors?: number;
}): string {
  n += 1;
  const saved = saveStatementPreview({
    fileName: `recon-${n}.pdf`,
    contentHash: `recon-hash-${n}-${Date.now()}`,
    accountId: opts.accountId,
    householdId: opts.householdId,
    importBatch: `recon-batch-${n}-${Date.now()}`,
    usedParser: 'pdf',
    transactions: [
      {
        date: '2026-03-15',
        merchantRaw: 'WWW PMT 1234 PRINCIPAL',
        merchantClean: 'Www Pmt Principal',
        amount: -6400,
        currency: 'CAD',
        sourceReference: null,
        sourceRowFingerprint: `recon-fp-${n}-a-${Date.now()}`,
      },
    ],
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: opts.rowErrors ?? 0,
    parseErrors: opts.parseErrors,
  });
  return saved.previewToken;
}

const RECON_MESSAGE =
  'statement does not reconcile: opening 0 - principal changes -6400.00 = 6400.00, expected closing 12817.24';

test('commit is refused with 422 when the statement does not reconcile, and nothing is written', async () => {
  const householdId = (await models.Household.findOne())!.id as number;
  const accountId = await makeAccount('RBC Credit Line (refused)');
  const token = seedPreview({
    accountId,
    householdId,
    parseErrors: [{ rowIndex: -1, message: RECON_MESSAGE, blocking: true }],
  });

  const res = await authed.post('/api/import/commit').send({ previewToken: token });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.code, 'statement_unreconciled');
  assert.equal(res.body.blockingErrors.length, 1);
  assert.match(String(res.body.error), /does not reconcile/);
  // The refusal is what mints the override: you cannot acknowledge a
  // discrepancy you have not been shown.
  const acknowledgement = String(res.body.acknowledgement ?? '');
  assert.match(acknowledgement, /^[0-9a-f]{32}$/);

  assert.equal(await models.Transaction.count({ where: { accountId } }), 0);
  assert.equal(await models.ImportHistory.count({ where: { accountId } }), 0);

  // A digest minted for a DIFFERENT preview must not open this one.
  const otherToken = seedPreview({
    accountId,
    householdId,
    parseErrors: [{ rowIndex: -1, message: RECON_MESSAGE, blocking: true }],
  });
  const otherRefusal = await authed
    .post('/api/import/commit')
    .send({ previewToken: otherToken });
  assert.equal(otherRefusal.status, 422, JSON.stringify(otherRefusal.body));
  const foreignAcknowledgement = String(otherRefusal.body.acknowledgement ?? '');
  assert.notEqual(foreignAcknowledgement, acknowledgement);

  // Nothing but the exact digest for THIS refusal gets through.
  for (const override of [true, 'true', 'yes', 1, foreignAcknowledgement, 'f'.repeat(32)]) {
    const refused = await authed
      .post('/api/import/commit')
      .send({ previewToken: token, acceptUnreconciled: override });
    assert.equal(
      refused.status,
      422,
      `override ${JSON.stringify(override)}: ${JSON.stringify(refused.body)}`,
    );
    assert.equal(refused.body.code, 'statement_unreconciled');
  }
  assert.equal(await models.Transaction.count({ where: { accountId } }), 0);
  assert.equal(await models.ImportHistory.count({ where: { accountId } }), 0);

  // The preview survived every refusal — same token, with its own digest.
  const accepted = await authed
    .post('/api/import/commit')
    .send({ previewToken: token, acceptUnreconciled: acknowledgement });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.insertedTransactions, 1);
  assert.equal(accepted.body.acceptedUnreconciled, true);

  const history = await models.ImportHistory.findOne({ where: { accountId } });
  assert.ok(history, 'ImportHistory row written for the overridden import');
  assert.equal(
    await models.ImportHistory.count({ where: { accountId } }),
    1,
    'only the acknowledged commit wrote history',
  );
  assert.equal(history.acceptedUnreconciled, true);
  assert.equal(history.status, 'partial');
  assert.match(String(history.errorMessage), /acceptUnreconciled/);
});

test('an ordinary parse error still commits, and is not marked as an override', async () => {
  const householdId = (await models.Household.findOne())!.id as number;
  const accountId = await makeAccount('RBC Credit Line (soft error)');
  const token = seedPreview({
    accountId,
    householdId,
    parseErrors: [{ rowIndex: 4, message: 'Dateless amount row with no current date: 1,234.56' }],
    rowErrors: 1,
  });

  const res = await authed.post('/api/import/commit').send({ previewToken: token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.insertedTransactions, 1);
  assert.equal(res.body.acceptedUnreconciled, false);

  const history = await models.ImportHistory.findOne({ where: { accountId } });
  assert.ok(history);
  assert.equal(history.status, 'partial');
  assert.equal(history.acceptedUnreconciled, false);
});
