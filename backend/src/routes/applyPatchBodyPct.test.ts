/**
 * Unit tests for the pct override validation in applyPatchBody. The columns
 * are DECIMAL(5,4) fractions (0–1): percent-scale entries like 50 overflow on
 * Postgres but silently store on SQLite, so the API boundary must reject them
 * before the dialects can diverge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { applyPatchBody } from './transactions';
import { Transaction } from '../models';

function fakeReq(): Request {
  return { auth: { user: { id: 1 }, household: { id: 1 }, role: 'owner' } } as unknown as Request;
}

function buildTxn(): InstanceType<typeof Transaction> {
  return Transaction.build({
    accountId: 1,
    importBatch: 'test',
    date: '2026-01-01',
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: '-100.00',
    currency: 'CAD',
    sourceRowFingerprint: 'fp-apb-1',
    sourceIdentityFingerprint: 'sif-apb-1',
  } as never);
}

test('applyPatchBody: accepts fraction pct overrides in [0, 1]', async () => {
  const txn = buildTxn();
  await applyPatchBody(fakeReq(), txn, { pctMeOverride: 0.8, pctPartnerOverride: '0.2' });
  assert.equal(Number(txn.get('pctMeOverride')), 0.8);
  assert.equal(Number(txn.get('pctPartnerOverride')), 0.2);
});

test('applyPatchBody: accepts the 0 and 1 boundaries', async () => {
  const txn = buildTxn();
  await applyPatchBody(fakeReq(), txn, { pctMeOverride: 0, pctPartnerOverride: 1 });
  assert.equal(Number(txn.get('pctMeOverride')), 0);
  assert.equal(Number(txn.get('pctPartnerOverride')), 1);
});

test('applyPatchBody: clears pct overrides on null or empty string', async () => {
  const txn = buildTxn();
  txn.set('pctMeOverride', 0.5 as never);
  txn.set('pctPartnerOverride', 0.5 as never);
  await applyPatchBody(fakeReq(), txn, { pctMeOverride: null, pctPartnerOverride: '' });
  assert.equal(txn.get('pctMeOverride'), null);
  assert.equal(txn.get('pctPartnerOverride'), null);
});

test('applyPatchBody: rejects percent-scale pct overrides with a 400', async () => {
  const txn = buildTxn();
  await assert.rejects(
    () => applyPatchBody(fakeReq(), txn, { pctMeOverride: 50 }),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /pctMeOverride/);
      return true;
    },
  );
});

test('applyPatchBody: rejects negative and non-numeric pct overrides', async () => {
  await assert.rejects(
    () => applyPatchBody(fakeReq(), buildTxn(), { pctPartnerOverride: -0.1 }),
    (e: Error & { status?: number }) => e.status === 400,
  );
  await assert.rejects(
    () => applyPatchBody(fakeReq(), buildTxn(), { pctMeOverride: 'abc' }),
    (e: Error & { status?: number }) => e.status === 400,
  );
});
