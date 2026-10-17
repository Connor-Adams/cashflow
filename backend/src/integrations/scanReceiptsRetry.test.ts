// Transient receipt-scan failures (OpenAI / DB / Gmail error, daily AI cap)
// used to be recorded in ProcessedEmailMessage as 'extraction_failed' /
// 'ai_capped', and the `seen` set skipped every recorded message regardless of
// status — so a receipt that hit a blip was never retried. These tests pin the
// retry contract for both the fast scan and discovery.
process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QueryTypes } from 'sequelize';
import {
  sequelize, ExternalOrder, ProcessedEmailMessage, UserEmailIntegration, ReceiptSenderAllowlist,
  Household, User,
} from '../models';
import { EMAIL_RETRY_WINDOW_DAYS, scanInbox } from './scanReceipts';
import { discoverReceiptSources } from './discoverReceiptSources';
import { encryptSecret } from '../util/symmetricEncryption';
import type { GmailMessageFull, GmailMessageSummary } from './gmail';

const HH = 1;
const SHOP = 'orders@shop.test';

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ id: HH, name: 'Retry Household' } as never);
  await User.create({
    id: 1, email: 'retry@example.com', displayName: 'Retry User', globalRole: 'user',
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
  await ReceiptSenderAllowlist.create({
    householdId: HH, emailAddress: SHOP, enabled: true, status: 'enabled', source: 'user',
  } as never);
});

afterEach(() => {
  delete process.env.EMAIL_AI_EXTRACTIONS_PER_DAY;
});

const cleanExtract = {
  vendor: 'other', orderId: 'R-1', orderDate: '2026-10-10', total: 12.5, currency: 'CAD',
  paymentLast4: null, items: [{ title: 'Widget', quantity: 1, unitPrice: 12.5, totalPrice: 12.5 }], trip: null,
};

function message(id: string, from = `Shop <${SHOP}>`): GmailMessageFull {
  return {
    id, threadId: id, internalDate: '1760000000000', labelIds: [],
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: `Your receipt ${id}` },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(`Order ${id} total $12.50`).toString('base64url') },
    },
  } as GmailMessageFull;
}

type Fetch = (o: { messageId: string }) => Promise<GmailMessageFull>;

function deps(opts: {
  listed: string[];
  extract: () => Promise<typeof cleanExtract>;
  fetchMessage?: Fetch;
  fetched?: string[];
}) {
  const summaries: GmailMessageSummary[] = opts.listed.map((id) => ({ id, threadId: id }));
  return {
    listMessageIds: async () => summaries,
    fetchMessage: async ({ messageId }: { messageId: string }) => {
      opts.fetched?.push(messageId);
      return opts.fetchMessage ? opts.fetchMessage({ messageId }) : message(messageId);
    },
    extractFromText: opts.extract,
    extractPdfReceiptText: async () => '',
  };
}

const failingExtract = async (): Promise<typeof cleanExtract> => {
  throw new Error('OpenAI 503: upstream overloaded');
};
const okExtract = async () => cleanExtract;

async function rowFor(messageId: string) {
  return ProcessedEmailMessage.findOne({ where: { householdId: HH, messageId } });
}

/** Backdate a row's first-seen time (createdAt is the retry-window anchor). */
async function backdate(messageId: string, days: number): Promise<void> {
  const at = new Date(Date.now() - days * 86_400_000);
  await sequelize.query(
    'UPDATE processed_email_messages SET created_at = :at WHERE message_id = :messageId',
    { replacements: { at, messageId }, type: QueryTypes.UPDATE },
  );
}

test('scan: a message that failed transiently is retried when it is listed again', async () => {
  const first = await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['m1'], extract: failingExtract }));
  assert.equal(first.messages[0].status, 'extraction_failed');
  assert.equal((await rowFor('m1'))?.status, 'extraction_failed');

  const second = await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['m1'], extract: okExtract }));
  assert.equal(second.messages[0].status, 'extracted', JSON.stringify(second.messages));
  assert.equal(second.skippedAlreadySeen, 0);
  assert.equal((await rowFor('m1'))?.status, 'extracted');
});

test('scan: a failed message is re-fetched even after lastScanAt moved past it (not in the listing)', async () => {
  await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['m2'], extract: failingExtract }));
  const integ = await UserEmailIntegration.findOne({ where: { userId: 1 } });
  assert.ok(integ?.lastScanAt, 'the failed run still advances lastScanAt');

  // The next run's Gmail query (after:<lastScanAt>) no longer returns m2.
  const fetched: string[] = [];
  const second = await scanInbox(
    { userId: 1, householdId: HH },
    {},
    deps({ listed: [], extract: okExtract, fetched }),
  );
  assert.deepEqual(fetched, ['m2'], 'the failed id must be fetched explicitly');
  assert.equal(second.createdOrders, 1);
  assert.equal((await rowFor('m2'))?.status, 'extracted');
});

test('scan: an ai_capped message is retried on a later run once budget is available', async () => {
  // A cap of 1: m3a spends it, m3 is capped.
  process.env.EMAIL_AI_EXTRACTIONS_PER_DAY = '1';
  const first = await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['m3a', 'm3'], extract: okExtract }));
  assert.deepEqual(first.messages.map((m) => m.status), ['extracted', 'ai_capped']);

  process.env.EMAIL_AI_EXTRACTIONS_PER_DAY = '10';
  const second = await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: [], extract: okExtract }));
  assert.equal(second.createdOrders, 1, JSON.stringify(second.messages));
  assert.equal((await rowFor('m3'))?.status, 'extracted');
});

test(`scan: retries stop once the first failure is older than ${EMAIL_RETRY_WINDOW_DAYS} days`, async () => {
  await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['m4'], extract: failingExtract }));
  await backdate('m4', EMAIL_RETRY_WINDOW_DAYS + 1);

  const fetched: string[] = [];
  const listedAgain = await scanInbox(
    { userId: 1, householdId: HH },
    {},
    deps({ listed: ['m4'], extract: okExtract, fetched }),
  );
  assert.equal(listedAgain.messages[0].status, 'skipped_already_seen');
  assert.deepEqual(fetched, []);
  assert.equal((await rowFor('m4'))?.status, 'extraction_failed');
});

test('scan: terminal outcomes are never retried', async () => {
  await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['m5'], extract: okExtract }));
  assert.equal((await rowFor('m5'))?.status, 'extracted');
  const fetched: string[] = [];
  const again = await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['m5'], extract: okExtract, fetched }));
  assert.equal(again.messages[0].status, 'skipped_already_seen');
  assert.deepEqual(fetched, []);
});

test('scan: an explicit retry of a non-allowlisted sender (a discovery failure) is left alone', async () => {
  // Discovery recorded this failure — its sender is not on the allowlist, so the
  // fast scan must not hijack it and auto-create an order.
  await ProcessedEmailMessage.create({
    householdId: HH, provider: 'google', messageId: 'd1', status: 'extraction_failed',
    parser: null, externalOrderId: null, errorMessage: 'OpenAI 503', subject: 'Invoice',
    fromAddr: 'Random <billing@random.test>', scannedAt: new Date(),
  } as never);
  const result = await scanInbox(
    { userId: 1, householdId: HH },
    {},
    deps({ listed: [], extract: okExtract, fetchMessage: async ({ messageId }) => message(messageId, 'Random <billing@random.test>') }),
  );
  assert.equal(result.createdOrders, 0);
  assert.equal(result.failedExtractions, 0);
  const row = await rowFor('d1');
  assert.equal(row?.status, 'extraction_failed', 'discovery still owns the retry');
});

test('scan: a retry with an unknown sender is fetched, then left alone if not allowlisted', async () => {
  // fromAddr is null when the original Gmail fetch failed — ownership is only
  // knowable after re-fetching.
  await ProcessedEmailMessage.create({
    householdId: HH, provider: 'google', messageId: 'n1', status: 'extraction_failed',
    parser: null, externalOrderId: null, errorMessage: 'Gmail get failed (500)', subject: null,
    fromAddr: null, scannedAt: new Date(),
  } as never);
  const fetched: string[] = [];
  const result = await scanInbox(
    { userId: 1, householdId: HH },
    {},
    deps({ listed: [], extract: okExtract, fetched, fetchMessage: async ({ messageId }) => message(messageId, 'Random <billing@random.test>') }),
  );
  assert.deepEqual(fetched, ['n1']);
  assert.equal(result.createdOrders, 0);
  assert.equal((await rowFor('n1'))?.errorMessage, 'Gmail get failed (500)', 'row untouched');
});

test('scan: discovery-owned failures do not starve the per-run retry slots', async () => {
  for (let i = 0; i < 30; i++) {
    await ProcessedEmailMessage.create({
      householdId: HH, provider: 'google', messageId: `disc-${i}`, status: 'extraction_failed',
      parser: null, externalOrderId: null, errorMessage: 'empty body', subject: 'Invoice',
      fromAddr: `Other <billing${i}@other.test>`, scannedAt: new Date(Date.now() - 86_400_000),
    } as never);
  }
  await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: ['mine'], extract: failingExtract }));
  const fetched: string[] = [];
  const result = await scanInbox({ userId: 1, householdId: HH }, {}, deps({ listed: [], extract: okExtract, fetched }));
  assert.deepEqual(fetched, ['mine']);
  assert.equal(result.createdOrders, 1);
});

test('scan: an explicit retry that 404s (another mailbox in the household) is left alone', async () => {
  await ProcessedEmailMessage.create({
    householdId: HH, provider: 'google', messageId: 'p1', status: 'extraction_failed',
    parser: null, externalOrderId: null, errorMessage: 'OpenAI 503', subject: 'Receipt',
    fromAddr: `Shop <${SHOP}>`, scannedAt: new Date(),
  } as never);
  const result = await scanInbox(
    { userId: 1, householdId: HH },
    {},
    deps({
      listed: [],
      extract: okExtract,
      fetchMessage: async () => {
        throw new Error('Gmail get failed (404): Requested entity was not found.');
      },
    }),
  );
  assert.equal(result.failedExtractions, 0);
  const row = await rowFor('p1');
  assert.equal(row?.status, 'extraction_failed');
  assert.equal(row?.errorMessage, 'OpenAI 503', 'the row is not overwritten by the 404');
});

test('discovery: a message that failed transiently is retried on the next run', async () => {
  const from = 'Billing <billing@newstore.test>';
  const discoveryDeps = (extract: () => Promise<typeof cleanExtract>) => ({
    ...deps({ listed: ['x1'], extract, fetchMessage: async ({ messageId }) => message(messageId, from) }),
  });
  const first = await discoverReceiptSources({ userId: 1, householdId: HH }, {}, discoveryDeps(failingExtract));
  assert.equal(first.messages[0].status, 'extraction_failed');

  const second = await discoverReceiptSources({ userId: 1, householdId: HH }, {}, discoveryDeps(okExtract));
  assert.notEqual(second.messages[0].status, 'skipped_already_seen', JSON.stringify(second.messages));
  assert.notEqual((await rowFor('x1'))?.status, 'extraction_failed');
});
