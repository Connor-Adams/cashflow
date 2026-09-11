process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { scanInbox } from './scanReceipts';
import type { GmailMessageFull } from './gmail';
import {
  sequelize, ExternalOrder, ProcessedEmailMessage, UserEmailIntegration as UEI,
  ReceiptSenderAllowlist, Household, User,
} from '../models';
import { encryptSecret } from '../util/symmetricEncryption';

// ---------------------------------------------------------------------------
// 141 Amazon orders already in production were written by older parsers and
// still have order_date = NULL (and other fields left blank). Raw email bodies
// are not retained, but the Gmail message id is — in
// ExternalOrder.rawPayload.gmailMessageId and ProcessedEmailMessage.messageId.
// scanInbox normally skips any message id already in ProcessedEmailMessage;
// forceReprocessMessageIds bypasses that skip so those messages can be
// re-fetched from Gmail and re-parsed against the fixed parsers, backfilling
// only the NULL fields on the existing ExternalOrder row.
// ---------------------------------------------------------------------------

const ACCESS_OPTS = { userId: 97, householdId: 97, maxMessages: 10 };
const BODY =
  'Your Amazon.ca order\nOrder # 701-9999999-8888888\nOrder Total: $44.97\nQuantity: 1\n$44.97\n';

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ id: 97, name: 'Reprocess Household' } as never);
  await User.create({
    id: 97, email: 'reprocess@example.com', displayName: 'Reprocess User',
    globalRole: 'user', passwordHash: 'x', passwordSalt: 'x', passwordParams: 'x',
  } as never);
});

beforeEach(async () => {
  await Promise.all([
    ExternalOrder.destroy({ where: {} }),
    ProcessedEmailMessage.destroy({ where: {} }),
    UEI.destroy({ where: {} }),
    ReceiptSenderAllowlist.destroy({ where: {} }),
  ]);
  await UEI.create({
    userId: 97, provider: 'google', accountEmail: 'reprocess@gmail.com',
    accessTokenEncrypted: encryptSecret('tok'), refreshTokenEncrypted: encryptSecret('ref'),
    expiresAt: new Date(Date.now() + 3_600_000), scopes: 'gmail.readonly',
    lastScanAt: null, lastHistoryId: null, status: 'connected', statusReason: null,
  } as never);
});

/** Builds a minimal GmailMessageFull with a plain-text body and the given internalDate. */
function gmailMessage(): GmailMessageFull {
  return {
    id: 'msg-repro',
    threadId: 't',
    internalDate: '1756391531000', // 2025-08-28T14:32:11Z
    payload: {
      headers: [
        { name: 'From', value: 'Amazon <auto-confirm@amazon.ca>' },
        { name: 'Subject', value: 'Your Amazon.ca order' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(BODY).toString('base64url') },
    },
  } as unknown as GmailMessageFull;
}

const deps = {
  listMessageIds: async () => [{ id: 'msg-repro', threadId: 't' }],
  fetchMessage: async () => gmailMessage(),
  extractFromText: async () => {
    throw new Error('deterministic parser should have handled this');
  },
};

test('a seen message is skipped without forceReprocess', async () => {
  await ProcessedEmailMessage.create({
    householdId: 97, provider: 'google', messageId: 'msg-repro',
    status: 'extracted', parser: 'amazon', externalOrderId: null,
    errorMessage: null, subject: null, fromAddr: null, scannedAt: new Date(),
  } as never);

  const r = await scanInbox(ACCESS_OPTS, {}, deps);
  assert.equal(r.skippedAlreadySeen, 1);
});

test('forceReprocess backfills null fields on an existing order', async () => {
  await ProcessedEmailMessage.create({
    householdId: 97, provider: 'google', messageId: 'msg-repro',
    status: 'extracted', parser: 'amazon', externalOrderId: null,
    errorMessage: null, subject: null, fromAddr: null, scannedAt: new Date(),
  } as never);
  const order = await ExternalOrder.create({
    householdId: 97, vendor: 'amazon', vendorOrderId: '701-9999999-8888888',
    // Must match what scanInbox computes for this body: the amazon parser
    // finds no order date and no line items for this fixture, so those
    // segments are empty/zero (vendor:orderId:orderDate:total:itemCount:msgId).
    dedupeKey: 'amazon:701-9999999-8888888::44.97:0:msg-repro',
    orderDate: null, total: '44.97', currency: 'CAD', paymentLast4: null,
    source: 'gmail-scan:ai', rawPayload: { gmailMessageId: 'msg-repro' },
  } as never);

  await scanInbox({ ...ACCESS_OPTS, forceReprocessMessageIds: ['msg-repro'] }, {}, deps);

  await order.reload();
  assert.equal(order.orderDate, '2025-08-28', 'null order date is backfilled');
});

test('forceReprocess never overwrites a non-null field', async () => {
  await ProcessedEmailMessage.create({
    householdId: 97, provider: 'google', messageId: 'msg-repro',
    status: 'extracted', parser: 'amazon', externalOrderId: null,
    errorMessage: null, subject: null, fromAddr: null, scannedAt: new Date(),
  } as never);
  const order = await ExternalOrder.create({
    householdId: 97, vendor: 'amazon', vendorOrderId: '701-7777777-6666666',
    // Must match what scanInbox computes for this body: the amazon parser
    // finds no order date and no line items for this fixture, so those
    // segments are empty/zero (vendor:orderId:orderDate:total:itemCount:msgId).
    dedupeKey: 'amazon:701-9999999-8888888::44.97:0:msg-repro',
    orderDate: '2020-01-01', total: '99.99', currency: 'CAD', paymentLast4: '4321',
    source: 'gmail-scan:ai', rawPayload: { gmailMessageId: 'msg-repro' },
  } as never);

  await scanInbox({ ...ACCESS_OPTS, forceReprocessMessageIds: ['msg-repro'] }, {}, deps);

  await order.reload();
  assert.equal(order.orderDate, '2020-01-01', 'a user-corrected date survives');
  assert.equal(Number(order.total), 99.99, 'a user-corrected total survives');
  assert.equal(order.paymentLast4, '4321', 'a user-corrected payment last4 survives');
});
