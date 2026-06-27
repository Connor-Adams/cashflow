// Issue #870: an inbox flood must not drive unbounded OpenAI extractions. The
// per-household/day AI cap bounds how many AI calls a single (or repeated) scan
// run can make; deterministic parses stay free and uncapped.
process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize, ExternalOrder, ProcessedEmailMessage, UserEmailIntegration, ReceiptSenderAllowlist,
  Household, User,
} from '../models';
import { scanInbox } from './scanReceipts';
import { encryptSecret } from '../util/symmetricEncryption';
import type { GmailMessageFull, GmailMessageSummary } from './gmail';

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

afterEach(() => {
  delete process.env.EMAIL_AI_EXTRACTIONS_PER_DAY;
});

const cleanExtract = {
  vendor: 'other', orderId: 'X', orderDate: '2026-06-10', total: 9.99, currency: 'CAD',
  paymentLast4: null, items: [{ title: 'Item', quantity: 1, unitPrice: 9.99, totalPrice: 9.99 }], trip: null,
};

/** Build N flood messages from an attacker sender, none deterministically
 *  parseable (so each would otherwise trigger one AI extraction). */
function floodDeps(count: number, onExtract: () => void) {
  const summaries: GmailMessageSummary[] = [];
  const byId = new Map<string, GmailMessageFull>();
  for (let i = 0; i < count; i++) {
    const id = `flood-${i}`;
    summaries.push({ id, threadId: id });
    byId.set(id, {
      id, threadId: id, internalDate: '1718000000000', labelIds: [],
      payload: {
        headers: [
          { name: 'From', value: `Attacker <spam${i}@evil.test>` },
          { name: 'Subject', value: `Your receipt ${i}` },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from(`Order confirmation ${i} total $9.99`).toString('base64url') },
      },
    } as GmailMessageFull);
  }
  return {
    listMessageIds: async () => summaries,
    fetchMessage: async ({ messageId }: { messageId: string }) => byId.get(messageId)!,
    extractFromText: async () => {
      onExtract();
      return cleanExtract;
    },
    extractPdfReceiptText: async () => '',
  };
}

test('inbox flood is bounded: AI extractions never exceed the daily cap', async () => {
  process.env.EMAIL_AI_EXTRACTIONS_PER_DAY = '3';
  let aiCalls = 0;
  const result = await scanInbox(
    { userId: 1, householdId: 1, maxMessages: 100 },
    {},
    floodDeps(20, () => { aiCalls++; }),
  );

  // 20 flood messages, but only 3 AI extractions allowed today.
  assert.equal(aiCalls, 3);
  assert.equal(result.aiExtractions, 3);
  assert.equal(result.aiCappedMessages, 17);
  assert.equal(result.createdOrders, 3);
});

test('cap is per-day and persists across separate scan runs', async () => {
  process.env.EMAIL_AI_EXTRACTIONS_PER_DAY = '3';
  let aiCalls = 0;
  const onExtract = () => { aiCalls++; };

  // First run spends the whole budget.
  await scanInbox({ userId: 1, householdId: 1, maxMessages: 100 }, {}, floodDeps(10, onExtract));
  assert.equal(aiCalls, 3);

  // Second run (re-flood with brand-new message IDs) must make ZERO more AI
  // calls — the day's budget is already gone.
  const second = await scanInbox(
    { userId: 1, householdId: 1, maxMessages: 100 },
    {},
    {
      listMessageIds: async () => Array.from({ length: 10 }, (_, i) => ({ id: `wave2-${i}`, threadId: `wave2-${i}` })),
      fetchMessage: async ({ messageId }: { messageId: string }) => ({
        id: messageId, threadId: messageId, internalDate: '1718000000000', labelIds: [],
        payload: {
          headers: [{ name: 'From', value: 'A <x@evil.test>' }, { name: 'Subject', value: 'receipt' }],
          mimeType: 'text/plain',
          body: { data: Buffer.from('order total $9.99').toString('base64url') },
        },
      } as GmailMessageFull),
      extractFromText: async () => { onExtract(); return cleanExtract; },
      extractPdfReceiptText: async () => '',
    },
  );
  assert.equal(aiCalls, 3, 'no further AI calls after the daily cap is spent');
  assert.equal(second.aiCappedMessages, 10);
  assert.equal(second.aiExtractions, 0);
});

test('deterministic parses are never capped', async () => {
  // Apple receipts parse deterministically — even with a tiny AI cap, all of
  // them process for free.
  process.env.EMAIL_AI_EXTRACTIONS_PER_DAY = '1';
  const summaries: GmailMessageSummary[] = [];
  const byId = new Map<string, GmailMessageFull>();
  for (let i = 0; i < 5; i++) {
    const id = `apple-${i}`;
    summaries.push({ id, threadId: id });
    byId.set(id, {
      id, threadId: id, internalDate: '1718000000000', labelIds: [],
      payload: {
        headers: [
          { name: 'From', value: 'Apple <no_reply@email.apple.com>' },
          { name: 'Subject', value: `Your receipt from Apple` },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from(
          `APPLE RECEIPT\nORDER ID AB${i}\nAPP STORE\nThing ${i}\n$1.99\nTOTAL $1.99`,
        ).toString('base64url') },
      },
    } as GmailMessageFull);
  }
  let aiCalls = 0;
  const result = await scanInbox(
    { userId: 1, householdId: 1, maxMessages: 100 },
    {},
    {
      listMessageIds: async () => summaries,
      fetchMessage: async ({ messageId }: { messageId: string }) => byId.get(messageId)!,
      extractFromText: async () => { aiCalls++; return cleanExtract; },
      extractPdfReceiptText: async () => '',
    },
  );
  // The exact parser outcome depends on the apple parser, but the invariant we
  // assert is: zero AI calls and zero AI-capped skips for deterministic mail.
  assert.equal(aiCalls, 0);
  assert.equal(result.aiCappedMessages, 0);
});
