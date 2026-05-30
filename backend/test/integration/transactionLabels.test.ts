/**
 * Integration tests for transaction↔label wiring (issue #270):
 *  - POST /api/transactions/:id/labels  (set semantics, AC #5)
 *  - POST /api/transactions/bulk/labels (idempotent apply/remove, AC #6)
 *  - GET  /api/transactions?labels=     (any-of filter, AC #7)
 *  - cascade on transaction delete      (AC #9)
 *
 * Runs in isolation (`yarn test:integration`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;
let accountId: number;

async function importTxns(batchLabel: string, lines: string): Promise<number[]> {
  const csv = `Date,Description,Amount\n${lines}`;
  const imp = await authed
    .post('/api/import/upload')
    .field('accountId', String(accountId))
    .field('profileId', 'generic_simple')
    .field('batchLabel', batchLabel)
    .attach('file', Buffer.from(csv, 'utf8'), { filename: `${batchLabel}.csv`, contentType: 'text/csv' });
  assert.equal(imp.status, 200);
  const list = await authed.get(
    `/api/transactions?pageSize=100&importBatch=${encodeURIComponent(batchLabel)}`,
  );
  assert.equal(list.status, 200);
  return (list.body.data as { id: number }[]).map((t) => t.id);
}

async function createLabel(name: string): Promise<number> {
  const r = await authed.post('/api/labels').send({ name });
  assert.equal(r.status, 201);
  return r.body.id as number;
}

before(async () => {
  testDb = await setupPgTestDb('txn-labels');
  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = request.agent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'txnlabels@example.com',
    displayName: 'Txn Labels',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const acc = await authed.post('/api/accounts').send({
    name: 'Labels Account',
    owner: 'me',
    defaultCurrency: 'CAD',
  });
  assert.equal(acc.status, 201);
  accountId = acc.body.id as number;
});

after(async () => {
  await teardownPgTestDb(testDb);
});

test('POST /api/transactions/:id/labels sets exactly the given set (AC #5)', async () => {
  const [txn] = await importTxns('set-batch', '2025-06-01,Set Cafe,-5.50\n');
  const l1 = await createLabel('set-a');
  const l2 = await createLabel('set-b');
  const l3 = await createLabel('set-c');

  // set {l1,l2,l3}
  let res = await authed.post(`/api/transactions/${txn}/labels`).send({ labelIds: [l1, l2, l3] });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.labels.map((l: { id: number }) => l.id).sort((a: number, b: number) => a - b),
    [l1, l2, l3].sort((a, b) => a - b),
  );

  // now set {l2} — l1 and l3 must be removed
  res = await authed.post(`/api/transactions/${txn}/labels`).send({ labelIds: [l2] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.labels.map((l: { id: number }) => l.id), [l2]);

  // confirm via the list endpoint that the transaction carries only l2
  const list = await authed.get('/api/transactions?pageSize=100&importBatch=set-batch');
  const row = (list.body.data as Array<{ id: number; labels: { id: number }[] }>).find(
    (r) => r.id === txn,
  );
  assert.ok(row);
  assert.deepEqual(row?.labels.map((l) => l.id), [l2]);
});

test('POST /api/transactions/:id/labels with [] clears all labels', async () => {
  const [txn] = await importTxns('clear-batch', '2025-06-02,Clear Shop,-2.00\n');
  const l1 = await createLabel('clear-a');
  await authed.post(`/api/transactions/${txn}/labels`).send({ labelIds: [l1] });
  const res = await authed.post(`/api/transactions/${txn}/labels`).send({ labelIds: [] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.labels, []);
});

test('POST /api/transactions/:id/labels 400s when a labelId is from another household', async () => {
  const [txn] = await importTxns('foreign-batch', '2025-06-03,Foreign,-1.00\n');
  // 999999 is not a real label id for this household
  const res = await authed
    .post(`/api/transactions/${txn}/labels`)
    .send({ labelIds: [999999] });
  assert.equal(res.status, 400);
});

test('POST /api/transactions/bulk/labels apply is idempotent (AC #6)', async () => {
  const txns = await importTxns(
    'bulk-batch',
    '2025-06-04,Bulk One,-1.00\n2025-06-05,Bulk Two,-2.00\n2025-06-06,Bulk Three,-3.00\n',
  );
  assert.ok(txns.length >= 3);
  const label = await createLabel('bulk-label');

  // Pre-apply the label to the first txn so the bulk apply must skip it.
  await authed.post(`/api/transactions/${txns[0]}/labels`).send({ labelIds: [label] });

  const first = await authed
    .post('/api/transactions/bulk/labels')
    .send({ transactionIds: txns, labelId: label, op: 'apply' });
  assert.equal(first.status, 200);
  // Only the txns that did NOT already have it are "affected".
  assert.equal(first.body.affected, txns.length - 1);

  // Re-apply: now everything has it → zero affected, no error, no duplicates.
  const second = await authed
    .post('/api/transactions/bulk/labels')
    .send({ transactionIds: txns, labelId: label, op: 'apply' });
  assert.equal(second.status, 200);
  assert.equal(second.body.affected, 0);

  // Every txn carries the label exactly once.
  const list = await authed.get('/api/transactions?pageSize=100&importBatch=bulk-batch');
  for (const row of list.body.data as Array<{ id: number; labels: { id: number }[] }>) {
    const matching = row.labels.filter((l) => l.id === label);
    assert.equal(matching.length, 1, `txn ${row.id} should have the label exactly once`);
  }
});

test('POST /api/transactions/bulk/labels remove deletes existing pairs only', async () => {
  const txns = await importTxns(
    'bulk-remove-batch',
    '2025-06-07,Rem One,-1.00\n2025-06-08,Rem Two,-2.00\n',
  );
  const label = await createLabel('bulk-remove-label');
  await authed
    .post('/api/transactions/bulk/labels')
    .send({ transactionIds: txns, labelId: label, op: 'apply' });

  const res = await authed
    .post('/api/transactions/bulk/labels')
    .send({ transactionIds: txns, labelId: label, op: 'remove' });
  assert.equal(res.status, 200);
  assert.equal(res.body.affected, txns.length);

  const list = await authed.get('/api/transactions?pageSize=100&importBatch=bulk-remove-batch');
  for (const row of list.body.data as Array<{ labels: { id: number }[] }>) {
    assert.ok(!row.labels.some((l) => l.id === label));
  }
});

test('GET /api/transactions?labels= returns any-of matches (AC #7)', async () => {
  const txns = await importTxns(
    'filter-batch',
    '2025-06-09,Filt One,-1.00\n2025-06-10,Filt Two,-2.00\n2025-06-11,Filt Three,-3.00\n',
  );
  const [t1, t2, t3] = txns;
  const la = await createLabel('filter-a');
  const lb = await createLabel('filter-b');

  await authed.post(`/api/transactions/${t1}/labels`).send({ labelIds: [la] });
  await authed.post(`/api/transactions/${t2}/labels`).send({ labelIds: [lb] });
  // t3 gets neither

  // any-of {la, lb} → t1 and t2, not t3
  const res = await authed.get(
    `/api/transactions?pageSize=100&importBatch=filter-batch&labels=${la},${lb}`,
  );
  assert.equal(res.status, 200);
  const ids = (res.body.data as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [t1, t2].sort((a, b) => a - b));
  assert.ok(!ids.includes(t3));

  // single label → just t1
  const single = await authed.get(
    `/api/transactions?pageSize=100&importBatch=filter-batch&labels=${la}`,
  );
  assert.deepEqual(
    (single.body.data as { id: number }[]).map((r) => r.id),
    [t1],
  );
});

test('GET /api/transactions?labels= composes with ?ids= (any-of AND id constraint)', async () => {
  const txns = await importTxns(
    'compose-batch',
    '2025-06-12,Comp One,-1.00\n2025-06-13,Comp Two,-2.00\n',
  );
  const [t1, t2] = txns;
  const label = await createLabel('compose-label');
  await authed.post(`/api/transactions/${t1}/labels`).send({ labelIds: [label] });
  await authed.post(`/api/transactions/${t2}/labels`).send({ labelIds: [label] });

  // both carry the label, but restrict to id=t1 via ?ids=
  const res = await authed.get(
    `/api/transactions?pageSize=100&labels=${label}&ids=${t1}`,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    (res.body.data as { id: number }[]).map((r) => r.id),
    [t1],
  );
});

test('deleting a transaction cascades to its label links (AC #9)', async () => {
  const models = await import('../../src/models');
  const [txn] = await importTxns('cascade-batch', '2025-06-14,Cascade,-1.00\n');
  const label = await createLabel('cascade-label');
  await authed.post(`/api/transactions/${txn}/labels`).send({ labelIds: [label] });

  let links = await models.TransactionLabel.findAll({ where: { transactionId: txn } });
  assert.equal(links.length, 1);

  await models.Transaction.destroy({ where: { id: txn } });

  links = await models.TransactionLabel.findAll({ where: { transactionId: txn } });
  assert.equal(links.length, 0, 'label links should be removed when the transaction is deleted');

  // the label itself survives (only the join row cascaded)
  const labelRow = await models.Label.findByPk(label);
  assert.ok(labelRow, 'the label should still exist after the transaction is deleted');
});
