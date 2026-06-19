// Set encryption key before any module that reads it at import-time.
process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Transaction,
  ExternalOrder,
  ReceiptSenderAllowlist,
  ProcessedEmailMessage,
  UserEmailIntegration,
  Household,
  Account,
  User,
} from '../models';
import { discoverReceiptSources } from './discoverReceiptSources';
import { encryptSecret } from '../util/symmetricEncryption';
import type { GmailMessageFull, GmailMessageSummary } from './gmail';

// Fixed IDs used across tests (created once in before, never destroyed).
const TEST_USER_ID = 1;
const TEST_HOUSEHOLD_ID = 1;
let TEST_ACCOUNT_ID = 0;

before(async () => {
  await sequelize.sync({ force: true });
  // Minimal parent rows required by FK constraints.
  await Household.create({ id: TEST_HOUSEHOLD_ID, name: 'Test Household' } as never);
  await User.create({
    id: TEST_USER_ID,
    email: 'test@example.com',
    displayName: 'Test User',
    globalRole: 'user',
    passwordHash: 'x',
    passwordSalt: 'x',
    passwordParams: 'x',
  } as never);
  const account = await Account.create({
    householdId: TEST_HOUSEHOLD_ID,
    name: 'Test Chequing',
    accountType: 'chequing',
  } as never);
  TEST_ACCOUNT_ID = account.id;
});

beforeEach(async () => {
  await Promise.all([
    Transaction.destroy({ where: {} }),
    ExternalOrder.destroy({ where: {} }),
    ReceiptSenderAllowlist.destroy({ where: {} }),
    ProcessedEmailMessage.destroy({ where: {} }),
    UserEmailIntegration.destroy({ where: {} }),
  ]);
  await UserEmailIntegration.create({
    userId: 1,
    provider: 'google',
    accountEmail: 'me@gmail.com',
    accessTokenEncrypted: encryptSecret('fake-access-token'),
    refreshTokenEncrypted: encryptSecret('fake-refresh-token'),
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: 'gmail.readonly',
    lastScanAt: null,
    lastHistoryId: null,
    status: 'connected',
    statusReason: null,
  } as never);
});

function fakeMessage(over: Partial<GmailMessageFull> & { from: string; subject: string }): GmailMessageFull {
  return {
    id: over.id ?? 'm1',
    threadId: 't1',
    internalDate: '1718000000000',
    labelIds: over.labelIds ?? [],
    payload: {
      headers: [
        { name: 'From', value: over.from },
        { name: 'Subject', value: over.subject },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from('Thanks for your order at FooShop. Total $42.00').toString('base64url') },
    },
  } as GmailMessageFull;
}

function deps(messages: GmailMessageFull[], extract: () => Promise<unknown>) {
  const summaries: GmailMessageSummary[] = messages.map((m) => ({ id: m.id, threadId: m.threadId }));
  return {
    listMessageIds: async () => summaries,
    fetchMessage: async ({ messageId }: { messageId: string }) =>
      messages.find((m) => m.id === messageId)!,
    extractFromText: extract as never,
  };
}

const cleanExtract = {
  vendor: 'other',
  orderId: 'F-1',
  orderDate: '2026-06-10',
  total: 42.0,
  currency: 'CAD',
  paymentLast4: null,
  items: [{ title: 'Widget', quantity: 1, unitPrice: 42, totalPrice: 42 }],
  trip: null,
};

test('AI extract from a purchases-labelled mail with an amount match auto-ingests and learns the sender', async () => {
  await Transaction.create({
    accountId: TEST_ACCOUNT_ID, householdId: TEST_HOUSEHOLD_ID,
    date: '2026-06-10', amount: '42.00', currency: 'CAD',
    merchantRaw: 'FOOSHOP', merchantClean: 'Fooshop',
    importBatch: 'test', sourceRowFingerprint: 'fp1', sourceIdentityFingerprint: 'fi1',
  } as never);
  const msg = fakeMessage({ id: 'm1', from: 'FooShop <orders@fooshop.com>', subject: 'Your order confirmation', labelIds: ['CATEGORY_PURCHASES'] });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => cleanExtract),
  );
  assert.equal(result.autoIngested, 1);
  assert.equal(await ExternalOrder.count(), 1);
  const learned = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'orders@fooshop.com' } });
  assert.equal(learned?.status, 'enabled');
  assert.equal(learned?.source, 'discovery');
});

test('AI extract with NO amount match becomes a suggestion and writes no order', async () => {
  const msg = fakeMessage({ id: 'm2', from: 'Mystery <hello@mystery.test>', subject: 'Receipt', labelIds: ['CATEGORY_PURCHASES'] });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => cleanExtract),
  );
  assert.equal(result.autoIngested, 0);
  assert.equal(result.suggestionsAdded, 1);
  assert.equal(await ExternalOrder.count(), 0);
  const suggestion = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'hello@mystery.test' } });
  assert.equal(suggestion?.status, 'suggested');
});

test('an already-processed message id is skipped', async () => {
  await ProcessedEmailMessage.create({
    householdId: 1, provider: 'google', messageId: 'm3', status: 'suggested_sender',
    parser: 'ai', externalOrderId: null, errorMessage: null, subject: 'x', fromAddr: 'y', scannedAt: new Date(),
  } as never);
  const msg = fakeMessage({ id: 'm3', from: 'x@y.com', subject: 'Receipt' });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => cleanExtract),
  );
  assert.equal(result.skippedAlreadySeen, 1);
});
