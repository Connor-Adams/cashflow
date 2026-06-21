/**
 * Real-bank idempotency lock for the SimpleFIN daily sync (issue #815).
 *
 * Post-merge hardening of #791. During manual verification, re-running the sync
 * appeared to re-insert the same transactions (`skippedDuplicate: 0`). That run
 * hit the SimpleFIN **DEMO** server, which returns **shifting** transaction ids
 * and dates on every call — both dedup keys (`sourceReference: tx.id` and the
 * identity fingerprint hashed over the changing `date`) move between syncs, so a
 * re-insert is the *expected* demo artifact, NOT a real bug. The demo's
 * non-determinism cannot be fixed from our side and is out of scope here; it is
 * only documented (this comment + the `documents demo non-determinism` test
 * below) so the contract is unambiguous.
 *
 * The consequence was that **real-bank idempotency was UNVERIFIED**: the daily
 * cron (`jobs/definitions/simplefinSync.ts`) leans entirely on per-row dedup
 * (`sync.ts:217-219` builds a fresh `importBatch` / `contentHash` every run so
 * the statement-level short-circuit never no-ops a sync). These tests pin a
 * **stable** mock — the way a real bank behaves, returning the same `tx.id` and
 * `date` across syncs — and drive `syncSimplefin({ integrationId })` directly so
 * a re-run inserts zero duplicates.
 *
 * Postgres-backed; stubs `globalThis.fetch` at the `/accounts?start-date=`
 * transaction-fetch boundary (`client.ts:262`) so no network and no live
 * SimpleFIN credentials are needed. Seeds the integration + account link via
 * models (the connect handshake is exercised in simplefin.connect.test.ts).
 */
import { after, before, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const ACCESS_URL = 'https://u53r:p4ss@beta-bridge.simplefin.org/simplefin';

let models: typeof import('../../src/models/index.js');
let syncSimplefin: typeof import('../../src/simplefin/sync.js').syncSimplefin;
let testDb: PgTestDb;
let householdId: number;
let userId: number;
let accountId: number;
let integrationId: number;
let originalFetch: typeof globalThis.fetch;

const POSTED = 1742040000; // 2025-03-15T12:00:00Z
const POSTED_DATE = '2025-03-15';
const POSTED_2 = 1742212800; // 2025-03-17T12:00:00Z

before(async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  testDb = await setupPgTestDb('simplefin-idempotency');
  models = await import('../../src/models/index.js');
  const enc = await import('../../src/util/symmetricEncryption.js');
  enc.__resetKeyCacheForTests();
  ({ syncSimplefin } = await import('../../src/simplefin/sync.js'));

  const { hashPassword } = await import('../../src/auth/password.js');
  const household = await models.Household.create({ name: 'Idem HH' } as never);
  householdId = household.id;
  const password = await hashPassword('password123');
  const user = await models.User.create({
    email: 'sfidem@example.com',
    displayName: 'Idem User',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);
  userId = user.id;
  await models.HouseholdMember.create({
    householdId,
    userId,
    role: 'owner',
  } as never);
  const account = await models.Account.create({
    name: 'Checking',
    owner: 'me',
    ownerUserId: userId,
    householdId,
    accountType: 'chequing',
    defaultCurrency: 'CAD',
  } as never);
  accountId = account.id;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  // A connected integration whose access URL the sync will decrypt + fetch from.
  const enc = await import('../../src/util/symmetricEncryption.js');
  const integ = await models.UserSimplefinIntegration.create({
    userId,
    accessUrlEncrypted: enc.encryptSecret(ACCESS_URL),
    status: 'connected',
    lastSyncedAt: null,
  } as never);
  integrationId = integ.id;
  // #813: the sync resolves the target Account ONLY via an explicit link.
  await models.SimplefinAccountLink.create({
    integrationId,
    simplefinAccountId: 'ACT-1',
    accountId,
  } as never);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await models.Transaction.destroy({ where: {} });
  await models.ImportHistory.destroy({ where: {} });
  await models.SimplefinAccountLink.destroy({ where: {} });
  await models.UserSimplefinIntegration.destroy({ where: {} });
});

/**
 * Stub the `/accounts?start-date=` fetch (the only network call the sync makes)
 * to return the given SimpleFIN account payload. Captures every `start-date`
 * the engine requests so the overlapping-window test can assert the second sync
 * really did move its window forward.
 */
function stubTxnFetch(accounts: unknown[], capturedStartDates?: number[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/accounts')) {
      if (capturedStartDates) {
        const sd = new URL(url).searchParams.get('start-date');
        if (sd != null) capturedStartDates.push(Number(sd));
      }
      return new Response(JSON.stringify({ accounts }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

const sampleAccount = (txns: unknown[]) => ({
  id: 'ACT-1',
  name: 'Checking',
  currency: 'CAD',
  transactions: txns,
});

const tx = (id: string, amount: string, posted = POSTED, payee = 'Store') => ({
  id,
  posted,
  amount,
  description: payee.toUpperCase(),
  payee,
});

/**
 * AC1, AC2: drive the engine TWICE against a mock returning the SAME stable
 * transactions (stable `tx.id` + `date`) both times. The second run must insert
 * 0 and report every stable row as `skippedDuplicate`, and the persisted row
 * count must be unchanged from after the first run.
 */
test('stable re-run inserts 0 and dedups every row on the second sync', async () => {
  stubTxnFetch([
    sampleAccount([
      tx('STX-1', '-10.00', POSTED, 'Store A'),
      tx('STX-2', '-20.00', POSTED, 'Store B'),
      tx('STX-3', '-30.00', POSTED_2, 'Store C'),
    ]),
  ]);

  const first = await syncSimplefin({ integrationId });
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0].inserted, 3, 'first run inserts all stable rows');
  assert.equal(first.runs[0].skippedDuplicate, 0);
  const afterFirst = await models.Transaction.count({ where: { accountId } });
  assert.equal(afterFirst, 3);

  const second = await syncSimplefin({ integrationId });
  assert.equal(second.runs.length, 1);
  // AC2: zero inserted, every stable row reported as a duplicate.
  assert.equal(second.runs[0].inserted, 0, 're-run inserts nothing');
  assert.equal(
    second.runs[0].skippedDuplicate,
    3,
    'skippedDuplicate equals the number of stable rows',
  );
  // AC2: persisted count unchanged from after the first run.
  assert.equal(
    await models.Transaction.count({ where: { accountId } }),
    afterFirst,
    'no rows added on the idempotent re-run',
  );
});

/**
 * AC3: the sync fetches from `lastSyncedAt`, so after the first run the second
 * run's fetch window starts later but still OVERLAPS the prior window and
 * re-returns the same stable boundary transactions. Assert the overlap produces
 * zero duplicates. We capture the requested `start-date`s to prove the second
 * sync genuinely moved its window forward (a real overlapping re-fetch), not a
 * trivial identical request.
 */
test('an overlapping re-fetch window inserts zero duplicates', async () => {
  const startDates: number[] = [];
  const boundary = [tx('STX-1', '-12.34', POSTED, 'Boundary Co')];
  stubTxnFetch([sampleAccount(boundary)], startDates);

  // First sync: lastSyncedAt is null → backfill window; inserts the boundary tx.
  const firstNow = new Date(POSTED_2 * 1000);
  const first = await syncSimplefin({ integrationId, now: firstNow });
  assert.equal(first.runs[0].inserted, 1);
  assert.equal(await models.Transaction.count({ where: { accountId } }), 1);

  // Second sync runs LATER; its start-date is the just-saved lastSyncedAt
  // (= firstNow), which is AFTER the boundary tx's posted date — a window that
  // overlaps the boundary row. The bank re-returns that same stable row.
  const secondNow = new Date((POSTED_2 + 86400) * 1000);
  const second = await syncSimplefin({ integrationId, now: secondNow });
  assert.equal(second.runs[0].inserted, 0, 'overlapping boundary tx not re-inserted');
  assert.equal(second.runs[0].skippedDuplicate, 1);
  assert.equal(
    await models.Transaction.count({ where: { accountId } }),
    1,
    'overlap produced no duplicate',
  );

  // The two syncs requested DIFFERENT start-dates — the second moved forward to
  // lastSyncedAt, confirming this is a real overlapping re-fetch.
  assert.equal(startDates.length, 2);
  assert.ok(
    startDates[1] > startDates[0],
    'second sync moved its fetch window forward to lastSyncedAt',
  );
});

/**
 * AC4: a transaction that was `pending` on the first sync and `posted` on the
 * second must be PROMOTED in place (one row, `status: 'posted'`), not
 * duplicated. The SimpleFIN commit path always inserts `status: 'posted'`
 * (SimplefinTransaction carries no pending flag), so the pending hold is seeded
 * directly — modelling a pending row that arrived via another source (e.g. an
 * Amex CSV hold) — and the SimpleFIN sync then delivers the settled charge.
 */
test('a pending hold is promoted in place when the posted charge arrives', async () => {
  const { stableIdentityFingerprint, rowFingerprint } = await import(
    '../../src/import/fingerprint.js'
  );
  const merchantRaw = 'Store A';
  await models.Transaction.create({
    accountId,
    householdId,
    importBatch: 'pending-hold',
    date: POSTED_DATE,
    merchantRaw,
    merchantClean: 'store a',
    amount: '-10.00',
    currency: 'CAD',
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId,
      date: POSTED_DATE,
      amount: -10,
      currency: 'CAD',
      merchantRaw,
      sourceReference: null,
    }),
    sourceIdentityFingerprint: stableIdentityFingerprint({
      accountId,
      date: POSTED_DATE,
      amount: -10,
      currency: 'CAD',
      merchantRaw,
    }),
    status: 'pending',
  } as never);

  stubTxnFetch([sampleAccount([tx('STX-1', '-10.00', POSTED, 'Store A')])]);
  const res = await syncSimplefin({ integrationId });
  assert.equal(res.runs[0].inserted, 0, 'promotion does not insert a new row');
  assert.equal(res.runs[0].skippedDuplicate, 1);

  const rows = await models.Transaction.findAll({ where: { accountId } });
  assert.equal(rows.length, 1, 'promoted in place, not duplicated');
  assert.equal(rows[0].status, 'posted', 'pending hold promoted to posted');
  assert.equal(rows[0].sourceReference, 'STX-1', 'SimpleFIN id backfilled on promotion');
});

/**
 * AC6 (documented, NOT a fix): pins the demo-server failure mode. The live
 * SimpleFIN DEMO server returns shifting `tx.id`/`date` per call. When BOTH the
 * `sourceReference` (= tx.id) and the `date` change between syncs, every dedup
 * key changes and the re-insert is the EXPECTED outcome — which is exactly why
 * the original manual re-run against the demo showed `skippedDuplicate: 0`.
 * This is a demo artifact, not a real-bank bug (the stable-id tests above prove
 * a real bank dedups). Demo non-determinism is out of scope to fix.
 */
test('documents demo non-determinism: shifting tx.id AND date re-inserts', async () => {
  stubTxnFetch([sampleAccount([tx('DEMO-1', '-10.00', POSTED, 'Store A')])]);
  const first = await syncSimplefin({ integrationId });
  assert.equal(first.runs[0].inserted, 1);

  // Second "demo" fetch: same charge, but the demo shifted BOTH the id and the
  // date (one day later) — the keys no longer match the first row.
  stubTxnFetch([sampleAccount([tx('DEMO-2', '-10.00', POSTED + 86400, 'Store A')])]);
  const second = await syncSimplefin({ integrationId });
  assert.equal(
    second.runs[0].inserted,
    1,
    'demo shifting id+date re-inserts — expected demo artifact, not a real-bank bug',
  );
  assert.equal(await models.Transaction.count({ where: { accountId } }), 2);
});
