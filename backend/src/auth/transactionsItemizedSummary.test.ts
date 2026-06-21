// backend/test/transactionsItemizedSummary.test.ts
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import {
  sequelize,
  Account,
  Transaction,
  ExternalOrder,
  ExternalOrderItem,
  TransactionOrderLink,
  User,
  Household,
  HouseholdMember,
  Session,
} from '../models';
import { hashPassword, hashToken } from './password';

let testApp: (typeof import('../app.js'))['default'];
let sessionToken: string;
let householdId: number;
let accountId: number;
let userId: number;

before(async () => {
  await sequelize.sync({ force: true });

  const password = await hashPassword('password123');
  const user = await User.create({
    email: `itemized-summary-${Date.now()}@example.com`,
    displayName: 'Itemized Test',
    globalRole: 'user',
    passwordHash: password.hash,
    passwordSalt: password.salt,
    passwordParams: password.params,
  } as never);

  const household = await Household.create({ name: 'Itemized Test HH' } as never);
  householdId = household.id;
  userId = user.id;

  await HouseholdMember.create({
    householdId: household.id,
    userId: user.id,
    role: 'owner',
  } as never);

  sessionToken = crypto.randomBytes(32).toString('hex');
  await Session.create({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  } as never);

  const account = await Account.create({
    householdId: household.id,
    name: 'Test Card',
    visibility: 'private',
  } as never);
  accountId = account.id;

  const { default: app } = await import('../app.js');
  testApp = app;
});

test('itemized txn reports correct itemCount and stragglerCount; plain txn reports null', async () => {
  const fp1 = `itemized-${Date.now()}-1`;
  const fp2 = `itemized-${Date.now()}-2`;

  // ── Itemized transaction: 3 items, 2 done (high-conf), 1 straggler ──────────
  const itemizedTxn = await Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    importBatch: 'test-itemized',
    date: '2026-06-01',
    amount: '-120.00',
    currency: 'CAD',
    merchantRaw: 'COSTCO WHOLESALE',
    merchantClean: 'Costco',
    sourceRowFingerprint: fp1,
    sourceIdentityFingerprint: fp1,
    txnType: 'purchase',
    reviewFlag: true,
    finalSplitType: 'me',
  } as never);

  const order = await ExternalOrder.create({
    householdId,
    vendor: 'costco',
    dedupeKey: `itemized-summary-test-${Date.now()}-${Math.random()}`,
    total: '120.00',
    currency: 'CAD',
    orderDate: '2026-06-01',
    source: 'test',
  } as never);

  // Item 1: high-conf inferred category (done)
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Organic Milk',
    inferredCategory: 'Groceries',
    categoryOverride: null,
    confidence: '95',
  } as never);

  // Item 2: high-conf inferred category (done)
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Laundry Detergent',
    inferredCategory: 'Household',
    categoryOverride: null,
    confidence: '88',
  } as never);

  // Item 3: no inferred category and no override (straggler)
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Mystery Widget',
    inferredCategory: null,
    categoryOverride: null,
    confidence: null,
  } as never);

  await TransactionOrderLink.create({
    transactionId: itemizedTxn.id,
    externalOrderId: order.id,
    confidence: '90',
    matchReason: 'test',
    status: 'accepted',
  } as never);

  // ── Plain transaction: no order link ────────────────────────────────────────
  const plainTxn = await Transaction.create({
    accountId,
    householdId,
    createdByUserId: userId,
    visibility: 'shared',
    importBatch: 'test-plain',
    date: '2026-06-02',
    amount: '-40.00',
    currency: 'CAD',
    merchantRaw: 'TIM HORTONS',
    merchantClean: 'Tim Hortons',
    sourceRowFingerprint: fp2,
    sourceIdentityFingerprint: fp2,
    txnType: 'purchase',
    reviewFlag: false,
    finalSplitType: 'me',
  } as never);

  // ── GET /api/transactions?ids=… ─────────────────────────────────────────────
  const agent = request.agent(testApp);
  agent.jar.setCookie(`cashflow_session=${sessionToken}; Path=/`);

  const res = await agent
    .get(`/api/transactions?ids=${itemizedTxn.id},${plainTxn.id}`);

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

  const data: Array<{ id: number; itemized: unknown }> = res.body.data;
  assert.ok(Array.isArray(data), 'res.body.data should be an array');

  const itemizedRow = data.find((r) => r.id === itemizedTxn.id);
  const plainRow = data.find((r) => r.id === plainTxn.id);

  assert.ok(itemizedRow, 'itemized transaction row should be present');
  assert.ok(plainRow, 'plain transaction row should be present');

  assert.deepEqual(
    itemizedRow!.itemized,
    { itemCount: 3, stragglerCount: 1 },
    `itemized txn: expected { itemCount: 3, stragglerCount: 1 }, got ${JSON.stringify(itemizedRow!.itemized)}`,
  );

  assert.equal(
    plainRow!.itemized,
    null,
    `plain txn: expected null, got ${JSON.stringify(plainRow!.itemized)}`,
  );
});
