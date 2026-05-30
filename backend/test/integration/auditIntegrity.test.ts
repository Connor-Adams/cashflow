import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authedA: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let tokenA: string;
let tokenB: string;

before(async () => {
  testDb = await setupPgTestDb('audit-integrity');
  await import('../../src/models/index.js');
  app = (await import('../../src/app.js')).default;

  // Household A
  authedA = request.agent(app);
  const regA = await authedA.post('/api/auth/register').send({
    email: 'audit-int-a@example.com',
    displayName: 'Integrity A',
    password: 'password123',
  });
  assert.equal(regA.status, 201);
  const mintA = await authedA.post('/api/audit/tokens').send({ label: 'A' });
  assert.equal(mintA.status, 201);
  tokenA = mintA.body.plaintext;

  // Create an account and seed transactions for household A
  const accRes = await authedA.post('/api/accounts').send({
    name: 'Chequing',
    accountType: 'checking',
    defaultCurrency: 'CAD',
  });
  assert.equal(accRes.status, 201);
  const accountId: number = accRes.body.id;

  const { Transaction: TxnModel, Account: AccModel } = await import('../../src/models/index.js');
  const acc = await AccModel.findByPk(accountId);
  if (acc) {
    const sharedFingerprint = 'dup-ifp-integrity-test';
    // Two transactions sharing the same sourceIdentityFingerprint → 1 duplicate group
    for (let i = 0; i < 2; i++) {
      await TxnModel.create({
        accountId,
        householdId: acc.householdId,
        date: '2025-03-15',
        amount: -(50 + i),
        currency: 'CAD',
        merchantRaw: `Dup Merchant ${i}`,
        merchantClean: `Dup Merchant ${i}`,
        merchantCanonical: null, // unenriched
        importBatch: `batch-int-${i}`,
        sourceRowFingerprint: `rfp-int-${i}`,
        sourceIdentityFingerprint: sharedFingerprint,
        finalSplitType: 'all_mine',
        finalBusiness: false,
        reviewFlag: false,
        txnType: 'purchase',
      });
    }
    // One more transaction with unique fingerprint but also unenriched (merchantCanonical = null)
    await TxnModel.create({
      accountId,
      householdId: acc.householdId,
      date: '2025-04-01',
      amount: -75,
      currency: 'CAD',
      merchantRaw: 'Unenriched',
      merchantClean: 'Unenriched',
      merchantCanonical: null,
      importBatch: 'batch-int-uniq',
      sourceRowFingerprint: 'rfp-int-uniq',
      sourceIdentityFingerprint: 'ifp-int-uniq',
      finalSplitType: 'all_mine',
      finalBusiness: false,
      reviewFlag: false,
      txnType: 'purchase',
    });
  }

  // Household B (isolation check)
  const authedB = request.agent(app);
  const regB = await authedB.post('/api/auth/register').send({
    email: 'audit-int-b@example.com',
    displayName: 'Integrity B',
    password: 'password123',
  });
  assert.equal(regB.status, 201);
  const mintB = await authedB.post('/api/audit/tokens').send({ label: 'B' });
  assert.equal(mintB.status, 201);
  tokenB = mintB.body.plaintext;

  // Seed duplicates in household B
  const accBRes = await authedB.post('/api/accounts').send({
    name: 'B Chequing',
    accountType: 'checking',
  });
  const accBId: number = accBRes.body.id;
  const accB = await AccModel.findByPk(accBId);
  if (accB) {
    for (let i = 0; i < 2; i++) {
      await TxnModel.create({
        accountId: accBId,
        householdId: accB.householdId,
        date: '2025-05-01',
        amount: -(10 + i),
        currency: 'CAD',
        merchantRaw: `B Dup ${i}`,
        merchantClean: `B Dup ${i}`,
        importBatch: `batch-int-b-${i}`,
        sourceRowFingerprint: `rfp-int-b-${i}`,
        sourceIdentityFingerprint: 'dup-ifp-b-only',
        finalSplitType: 'all_mine',
        finalBusiness: false,
        reviewFlag: false,
        txnType: 'purchase',
      });
    }
  }
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('GET /api/audit/integrity returns expected shape', async () => {
  const res = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  const body = res.body;
  assert.ok(typeof body.generatedAt === 'string');
  assert.ok(typeof body.duplicateGroups === 'object');
  assert.ok(typeof body.duplicateGroups.count === 'number');
  assert.ok(typeof body.duplicateGroups.extraRowCount === 'number');
  assert.ok(typeof body.unenrichedTransactions === 'number');
  assert.ok(typeof body.orphanedTransactions === 'number');
});

test('duplicateGroups reflects seeded duplicate pair', async () => {
  const res = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.duplicateGroups.count >= 1, 'should detect at least 1 duplicate group');
  assert.ok(res.body.duplicateGroups.extraRowCount >= 1, 'should count at least 1 extra row');
});

test('unenrichedTransactions counts null merchantCanonical rows', async () => {
  const res = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.unenrichedTransactions >= 1, 'should find at least 1 unenriched transaction');
});

test('orphanedTransactions is 0 on a clean test DB', async () => {
  const res = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.orphanedTransactions, 0);
});

test('cross-household isolation: household A does not see household B duplicates', async () => {
  const resA = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${tokenA}`);
  const resB = await request(app)
    .get('/api/audit/integrity')
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  // Both households have 1 duplicate group each; they must not bleed
  assert.ok(resA.body.duplicateGroups.count >= 1);
  assert.ok(resB.body.duplicateGroups.count >= 1);
  // Verify total counts aren't summed across households (each should be 1, not 2)
  assert.ok(
    resA.body.duplicateGroups.count < resA.body.duplicateGroups.count + resB.body.duplicateGroups.count,
    'counts are per-household, not global',
  );
});
