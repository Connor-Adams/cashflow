process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize, ExternalOrder, ProcessedEmailMessage, UserEmailIntegration, ReceiptSenderAllowlist,
  Household, User,
} from '../models';
import { scanInbox } from './scanReceipts';
import { encryptSecret } from '../util/symmetricEncryption';
import type { GmailMessageFull } from './gmail';

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ id: 1, name: 'Test Household' } as never);
  await User.create({
    id: 1, email: 'test@example.com', displayName: 'Test User', globalRole: 'user',
    passwordHash: 'x', passwordSalt: 'x', passwordParams: 'x',
  } as never);
});

beforeEach(async () => {
  await Promise.all([
    ExternalOrder.destroy({ where: {} }),
    ProcessedEmailMessage.destroy({ where: {} }),
    UserEmailIntegration.destroy({ where: {} }),
    ReceiptSenderAllowlist.destroy({ where: {} }),
  ]);
  await UserEmailIntegration.create({
    userId: 1, provider: 'google', accountEmail: 'me@gmail.com',
    accessTokenEncrypted: encryptSecret('tok'), refreshTokenEncrypted: encryptSecret('ref'),
    expiresAt: new Date(Date.now() + 3_600_000), scopes: 'gmail.readonly',
    lastScanAt: null, lastHistoryId: null, status: 'connected', statusReason: null,
  } as never);
});

const cleanExtract = {
  vendor: 'other', orderId: 'P-1', orderDate: '2026-06-10', total: 42.0, currency: 'CAD',
  paymentLast4: null, items: [{ title: 'Thing', quantity: 1, unitPrice: 42, totalPrice: 42 }], trip: null,
};

test('scanInbox extracts a receipt from a PDF attachment when the email body is empty', async () => {
  const msg = {
    id: 'pdf-scan-1', threadId: 't', internalDate: '1718000000000',
    payload: {
      headers: [{ name: 'From', value: 'Utility <billing@utility.test>' }, { name: 'Subject', value: 'Your bill' }],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('  ').toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'bill.pdf', body: { size: 1500, attachmentId: 'att-1' } },
      ],
    },
  } as unknown as GmailMessageFull;

  const result = await scanInbox(
    { userId: 1, householdId: 1, maxMessages: 10 },
    {},
    {
      listMessageIds: async () => [{ id: 'pdf-scan-1', threadId: 't' }],
      fetchMessage: async () => msg,
      extractFromText: async (text: string) => (text.includes('BILL-PDF') ? cleanExtract : { ...cleanExtract, total: null, items: [] }),
      extractPdfReceiptText: async () => 'BILL-PDF total 42.00',
    },
  );
  assert.equal(result.createdOrders, 1);
  const order = await ExternalOrder.findOne();
  assert.equal(order?.source, 'gmail-scan:ai-pdf');
});
