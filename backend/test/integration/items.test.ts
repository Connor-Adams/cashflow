/**
 * Integration tests for `backend/src/routes/items.ts`.
 *
 * Setup mirrors `backend/test/integration/transactions.test.ts`:
 *   - isolated SQLite DB
 *   - bootstrap superadmin
 *   - two non-superadmin households (A and B) via `seedHousehold` helper
 *
 * Items are written via direct model creates for tight fixture control.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import request from 'supertest';
import { seedHousehold } from '../helpers/seedHousehold.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-integration-items.sqlite');

let app: import('express').Express;
let superAgent: ReturnType<typeof request.agent>;
let agentA: ReturnType<typeof request.agent>;

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

  const mod = await import('../../src/app.js');
  app = mod.default;

  superAgent = request.agent(app);
  const register = await superAgent.post('/api/auth/register').send({
    email: 'super-items@example.com',
    displayName: 'Super Items',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  const a = await seedHousehold('ItemsA', 'A Partner');
  agentA = request.agent(app);
  agentA.jar.setCookie(`cashflow_session=${a.token}; Path=/`);
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

test('GET /api/items returns empty list for new household', async () => {
  const res = await agentA.get('/api/items');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], nextCursor: null });
});

test('GET /api/items returns enriched rows from joined tables', async () => {
  const { Account, ExternalOrder, ExternalOrderItem, Receipt, Transaction } = await import(
    '../../src/models/index.js'
  );
  const householdAId = (await agentA.get('/api/auth/me')).body.user.household.id;
  const account = await Account.create({
    householdId: householdAId,
    owner: 'me',
    visibility: 'shared',
    name: 'A Chequing',
    accountType: 'checking',
  } as never);
  const txn = await Transaction.create({
    accountId: account.id,
    householdId: householdAId,
    importBatch: 'b1',
    date: '2026-05-20',
    merchantRaw: 'Amazon',
    merchantClean: 'Amazon',
    amount: '-42.18',
    currency: 'USD',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    visibility: 'shared',
    ownershipType: 'shared',
    finalCategory: null,
    finalBusiness: false,
    finalSplitType: 'none',
    businessAmount: '0',
  } as never);
  const order = await ExternalOrder.create({
    householdId: householdAId,
    vendor: 'amazon',
    dedupeKey: 'amz-1',
    subtotal: '40.00',
    tax: '2.18',
    shipping: '0.00',
    total: '42.18',
    currency: 'USD',
    source: 'image',
  } as never);
  const receipt = await Receipt.create({
    transactionId: txn.id,
    storedFilename: 'r1.jpg',
    originalName: 'r1.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    externalOrderId: order.id,
  } as never);
  const item = await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'USB-C cable',
    quantity: 2,
    unitPrice: '9.50',
    totalPrice: '19.00',
    inferredCategory: 'Office',
    businessUsePercent: '100',
  } as never);

  const res = await agentA.get('/api/items');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  const row = res.body.items[0];
  assert.equal(row.id, item.id);
  assert.equal(row.title, 'USB-C cable');
  assert.equal(row.qty, 2);
  assert.equal(row.unitPrice, 9.5);
  assert.equal(row.totalPrice, 19);
  assert.equal(row.categoryEffective, 'Office');
  assert.equal(row.businessUseEffective, true);
  assert.equal(row.order.id, order.id);
  assert.equal(row.order.vendor, 'amazon');
  assert.equal(row.receipt.id, receipt.id);
  assert.equal(row.receipt.date, '2026-05-20');
  assert.equal(row.receipt.sourceTxnId, txn.id);
});
