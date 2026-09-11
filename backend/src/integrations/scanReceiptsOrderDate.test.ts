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
// Amazon confirmation emails state a *delivery* date ("Arriving Thursday,
// September 4"), not an order date, so the deterministic parser correctly
// returns orderDate: null. Gmail's own internalDate (ms since epoch) is
// already fetched and should be used as a fallback so the order isn't left
// unmatchable to a card transaction.
// ---------------------------------------------------------------------------

const ACCESS_OPTS = { userId: 98, householdId: 98, maxMessages: 10 };

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ id: 98, name: 'Order Date Fallback Household' } as never);
  await User.create({
    id: 98, email: 'order-date-fallback@example.com', displayName: 'Order Date Fallback User',
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
    userId: 98, provider: 'google', accountEmail: 'order-date-fallback@gmail.com',
    accessTokenEncrypted: encryptSecret('tok'), refreshTokenEncrypted: encryptSecret('ref'),
    expiresAt: new Date(Date.now() + 3_600_000), scopes: 'gmail.readonly',
    lastScanAt: null, lastHistoryId: null, status: 'connected', statusReason: null,
  } as never);
});

/** Builds a minimal GmailMessageFull with a plain-text body and the given internalDate. */
function gmailMessage(body: string, internalDate: string): GmailMessageFull {
  return {
    id: 'msg-1',
    threadId: 't',
    internalDate,
    payload: {
      headers: [
        { name: 'From', value: 'Amazon <auto-confirm@amazon.ca>' },
        { name: 'Subject', value: 'Your Amazon.ca order' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(body).toString('base64url') },
    },
  } as unknown as GmailMessageFull;
}

test('falls back to the email internalDate when the parser finds no order date', async () => {
  // 2025-08-28T14:32:11Z
  const msg = gmailMessage(
    'Order #701-1111111-2222222\n' +
      'Arriving Thursday, September 4\n' +
      'Order Total: $44.97\n' +
      'Quantity: 1\n' +
      '$44.97\n',
    '1756391531000',
  );

  await scanInbox(ACCESS_OPTS, {}, {
    listMessageIds: async () => [{ id: 'msg-1', threadId: 't' }],
    fetchMessage: async () => msg,
    extractFromText: async () => {
      throw new Error('deterministic parser should have handled this');
    },
  });

  const order = await ExternalOrder.findOne({ where: { vendorOrderId: '701-1111111-2222222' } });
  assert.ok(order, 'order was created');
  assert.equal(order!.orderDate, '2025-08-28');
});

test('a parsed order date wins over the email internalDate', async () => {
  const msg = gmailMessage(
    'Order #701-3333333-4444444\n' +
      'Placed on July 2, 2025\n' +
      'Order Total: $12.00\n' +
      'Quantity: 1\n' +
      '$12.00\n',
    '1756391531000',
  );

  await scanInbox(ACCESS_OPTS, {}, {
    listMessageIds: async () => [{ id: 'msg-1', threadId: 't' }],
    fetchMessage: async () => msg,
    extractFromText: async () => {
      throw new Error('deterministic parser should have handled this');
    },
  });

  const order = await ExternalOrder.findOne({ where: { vendorOrderId: '701-3333333-4444444' } });
  assert.ok(order, 'order was created');
  assert.equal(order!.orderDate, '2025-07-02');
});
