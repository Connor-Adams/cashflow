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

function fakeMessage(
  over: Partial<GmailMessageFull> & { from: string; subject: string; authResults?: string | null },
): GmailMessageFull {
  const headers: Array<{ name: string; value: string }> = [
    { name: 'From', value: over.from },
    { name: 'Subject', value: over.subject },
  ];
  if (over.authResults != null) headers.push({ name: 'Authentication-Results', value: over.authResults });
  return {
    id: over.id ?? 'm1',
    threadId: 't1',
    internalDate: '1718000000000',
    labelIds: over.labelIds ?? [],
    payload: {
      headers,
      mimeType: 'text/plain',
      body: { data: Buffer.from('Thanks for your order at FooShop. Total $42.00').toString('base64url') },
    },
  } as GmailMessageFull;
}

/** A Gmail-inserted Authentication-Results header showing DKIM passed and the
 *  signing domain aligns with the given From domain. */
function dkimPassFor(domain: string): string {
  return `mx.google.com; dkim=pass header.i=@${domain}; spf=pass; dmarc=pass`;
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
  const msg = fakeMessage({ id: 'm1', from: 'FooShop <orders@fooshop.com>', subject: 'Your order confirmation', labelIds: ['CATEGORY_PURCHASES'], authResults: dkimPassFor('fooshop.com') });
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

test('a spoofed sender (DKIM signed by a different domain) does NOT auto-ingest or learn the sender', async () => {
  // The exploit from issue #867: an attacker sends an order-confirmation-shaped
  // email spoofing From: auto-confirm@amazon.com with a clean total that even
  // matches a real transaction — but the mail is DKIM-signed by attacker.test.
  await Transaction.create({
    accountId: TEST_ACCOUNT_ID, householdId: TEST_HOUSEHOLD_ID,
    date: '2026-06-10', amount: '42.00', currency: 'CAD',
    merchantRaw: 'AMAZON', merchantClean: 'Amazon',
    importBatch: 'test', sourceRowFingerprint: 'fp-spoof', sourceIdentityFingerprint: 'fi-spoof',
  } as never);
  const msg = fakeMessage({
    id: 'spoof1',
    from: 'Amazon <auto-confirm@amazon.com>',
    subject: 'Your order confirmation',
    labelIds: ['CATEGORY_PURCHASES'],
    authResults: 'mx.google.com; dkim=pass header.i=@attacker.test; spf=fail; dmarc=fail',
  });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => ({ ...cleanExtract, vendor: 'amazon' })),
  );
  assert.equal(result.autoIngested, 0);
  assert.equal(await ExternalOrder.count(), 0);
  const row = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'auto-confirm@amazon.com' } });
  // Surfaced as a suggestion for the user to decide — never auto-enabled.
  assert.equal(row?.status, 'suggested');
  assert.equal(result.suggestionsAdded, 1);
});

test('deterministic-parser spoof (From: amazon.com, body the amazon parser accepts) does NOT auto-ingest without aligned DKIM', async () => {
  // Issue #867 path A: a deterministic vendor parser dispatches purely on the
  // From address, and classifyDiscoveryConfidence makes any deterministic match
  // 'high' unconditionally. An attacker spoofs From: auto-confirm@amazon.com with
  // a body the amazon parser accepts. Without an aligned DKIM pass it must NOT
  // become an ExternalOrder nor promote the sender.
  const amazonBody = [
    'Order #114-1234567-1234567',
    'Placed on May 21, 2026',
    'Widget',
    'Quantity: 1',
    '$44.97',
    'Order Subtotal: $44.97',
    'Tax: $5.39',
    'Order Total: $50.36',
  ].join('\n');
  const msg = {
    id: 'detspoof', threadId: 't', internalDate: '1718000000000', labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Amazon <auto-confirm@amazon.com>' },
        { name: 'Subject', value: 'Your Amazon.com order' },
        // DKIM passes but is signed by the attacker's domain, not amazon.com.
        { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@attacker.test; dmarc=fail' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(amazonBody).toString('base64url') },
    },
  } as unknown as GmailMessageFull;

  let aiCalled = false;
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    {
      listMessageIds: async () => [{ id: 'detspoof', threadId: 't' }],
      fetchMessage: async () => msg,
      extractFromText: (async () => { aiCalled = true; return cleanExtract; }) as never,
    },
  );
  // The deterministic parser handled it (no AI fallback), and it was 'high'
  // pre-gate — but the gate demoted it.
  assert.equal(aiCalled, false);
  assert.equal(result.autoIngested, 0);
  assert.equal(await ExternalOrder.count(), 0);
  const row = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'auto-confirm@amazon.com' } });
  assert.equal(row?.status, 'suggested');
});

test('deterministic-parser hit WITH aligned DKIM auto-ingests (the legitimate Amazon case)', async () => {
  const amazonBody = [
    'Order #114-9999999-9999999',
    'Placed on May 21, 2026',
    'Gadget',
    'Quantity: 1',
    '$10.00',
    'Order Total: $10.00',
  ].join('\n');
  const msg = {
    id: 'detok', threadId: 't', internalDate: '1718000000000', labelIds: ['CATEGORY_PURCHASES'],
    payload: {
      headers: [
        { name: 'From', value: 'Amazon <auto-confirm@amazon.com>' },
        { name: 'Subject', value: 'Your Amazon.com order' },
        { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@amazon.com; spf=pass; dmarc=pass' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(amazonBody).toString('base64url') },
    },
  } as unknown as GmailMessageFull;

  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    {
      listMessageIds: async () => [{ id: 'detok', threadId: 't' }],
      fetchMessage: async () => msg,
      extractFromText: (async () => cleanExtract) as never,
    },
  );
  assert.equal(result.autoIngested, 1);
  assert.equal(await ExternalOrder.count(), 1);
  const row = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'auto-confirm@amazon.com' } });
  assert.equal(row?.status, 'enabled');
});

test('an unauthenticated sender (no Authentication-Results header) does NOT auto-ingest', async () => {
  await Transaction.create({
    accountId: TEST_ACCOUNT_ID, householdId: TEST_HOUSEHOLD_ID,
    date: '2026-06-10', amount: '42.00', currency: 'CAD',
    merchantRaw: 'FOOSHOP', merchantClean: 'Fooshop',
    importBatch: 'test', sourceRowFingerprint: 'fp-noauth', sourceIdentityFingerprint: 'fi-noauth',
  } as never);
  const msg = fakeMessage({ id: 'noauth1', from: 'FooShop <orders@fooshop.com>', subject: 'Your order confirmation', labelIds: ['CATEGORY_PURCHASES'] });
  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    deps([msg], async () => cleanExtract),
  );
  assert.equal(result.autoIngested, 0);
  assert.equal(await ExternalOrder.count(), 0);
  const row = await ReceiptSenderAllowlist.findOne({ where: { emailAddress: 'orders@fooshop.com' } });
  assert.equal(row?.status, 'suggested');
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

test('a PDF attachment on an empty-body message is extracted and auto-ingested when an amount matches', async () => {
  await Transaction.create({
    accountId: TEST_ACCOUNT_ID, householdId: 1, date: '2026-06-10', amount: '42.00', currency: 'CAD',
    merchantRaw: 'PDFSHOP', merchantClean: 'Pdfshop',
    importBatch: 'test', sourceRowFingerprint: 'fp-pdf1', sourceIdentityFingerprint: 'fi-pdf1',
  } as never);
  // Empty body, one PDF attachment part.
  const msg = {
    id: 'pdf1', threadId: 't', internalDate: '1718000000000', labelIds: ['CATEGORY_PURCHASES'],
    payload: {
      headers: [
        { name: 'From', value: 'Shop <orders@pdfshop.test>' },
        { name: 'Subject', value: 'Your invoice' },
        { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@pdfshop.test; dmarc=pass' },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('   ').toString('base64url') } },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { size: 2000, attachmentId: 'att-pdf1' } },
      ],
    },
  } as unknown as GmailMessageFull;

  const result = await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    {
      listMessageIds: async () => [{ id: 'pdf1', threadId: 't' }],
      fetchMessage: async () => msg,
      // body is empty -> extractFromText would receive '' or pdf text; return no items for empty, clean for pdf text
      extractFromText: async (text: string) => (text.includes('PDF-RECEIPT') ? cleanExtract : { ...cleanExtract, total: null, items: [] }),
      extractPdfReceiptText: async () => 'PDF-RECEIPT total 42.00',
    },
  );
  assert.equal(result.autoIngested, 1);
  assert.equal(await ExternalOrder.count(), 1);
  const order = await ExternalOrder.findOne();
  assert.equal(order?.source, 'gmail-discovery:ai-pdf');
});

test('PDF fetch is NOT attempted when the body already yields items', async () => {
  let pdfCalled = false;
  const msg = fakeMessage({ id: 'nopdf', from: 'A <a@a.test>', subject: 'Your order confirmation', labelIds: ['CATEGORY_PURCHASES'] });
  await Transaction.create({ accountId: TEST_ACCOUNT_ID, householdId: 1, date: '2026-06-10', amount: '42.00', currency: 'CAD', merchantRaw: 'A', merchantClean: 'A', importBatch: 'test', sourceRowFingerprint: 'fp-nopdf', sourceIdentityFingerprint: 'fi-nopdf' } as never);
  await discoverReceiptSources(
    { userId: 1, householdId: 1 },
    {},
    {
      listMessageIds: async () => [{ id: 'nopdf', threadId: 't1' }],
      fetchMessage: async () => msg,
      extractFromText: async () => cleanExtract,
      extractPdfReceiptText: async () => { pdfCalled = true; return 'x'; },
    },
  );
  assert.equal(pdfCalled, false);
});
