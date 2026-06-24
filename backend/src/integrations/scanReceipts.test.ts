process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { receiptCurrencyOrDefault, markReauthIfRevoked, scanInbox } from './scanReceipts';
import { GoogleOAuthError } from './gmail';
import { defaultCurrency } from '../config/env';
import type { UserEmailIntegration } from '../models/UserEmailIntegration';
import type { GmailMessageFull } from './gmail';
import {
  sequelize, ExternalOrder, ProcessedEmailMessage, UserEmailIntegration as UEI,
  ReceiptSenderAllowlist, Household, User,
} from '../models';
import { encryptSecret } from '../util/symmetricEncryption';

// ---------------------------------------------------------------------------
// DB-backed tests: ExternalOrder persistence mapping for Amazon email parser
// ---------------------------------------------------------------------------

before(async () => {
  await sequelize.sync({ force: true });
  await Household.create({ id: 99, name: 'Persistence Test Household' } as never);
  await User.create({
    id: 99, email: 'persist-test@example.com', displayName: 'Persist User',
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
    userId: 99, provider: 'google', accountEmail: 'persist@gmail.com',
    accessTokenEncrypted: encryptSecret('tok'), refreshTokenEncrypted: encryptSecret('ref'),
    expiresAt: new Date(Date.now() + 3_600_000), scopes: 'gmail.readonly',
    lastScanAt: null, lastHistoryId: null, status: 'connected', statusReason: null,
  } as never);
});

/** Builds a minimal GmailMessageFull with a plain-text body. */
function makeAmazonEmail(body: string, from = 'auto-confirm@amazon.ca'): GmailMessageFull {
  return {
    id: 'persist-test-msg-1',
    threadId: 't',
    internalDate: '1718000000000',
    payload: {
      headers: [
        { name: 'From', value: `Amazon <${from}>` },
        { name: 'Subject', value: 'Your Amazon.ca order' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(body).toString('base64url') },
    },
  } as unknown as GmailMessageFull;
}

// Use bare $ in the summary lines so that TOTAL_RE/SUBTOTAL_RE/TAX_RE match
// (they only handle an optional bare `$`; CDN$/US$ prefixes don't match them).
// The CDN$ prefix on the item line is sufficient to trigger CAD detection.
const AMAZON_EMAIL_WITH_TAX = [
  'Order #114-1234567-1234567',
  'Placed on June 1, 2026',
  '',
  'Wireless Mouse',
  'Quantity: 1',
  'CDN$ 29.99',
  '',
  'Order Subtotal: $29.99',
  'Shipping & handling: $0.00',
  'Tax: $3.90',
  'Order Total: $33.89',
].join('\n');

test('scanInbox: ExternalOrder.subtotal and .tax are persisted (not null) from Amazon email', async () => {
  const msg = makeAmazonEmail(AMAZON_EMAIL_WITH_TAX);

  await scanInbox(
    { userId: 99, householdId: 99, maxMessages: 10 },
    {},
    {
      listMessageIds: async () => [{ id: 'persist-test-msg-1', threadId: 't' }],
      fetchMessage: async () => msg,
      // extractFromText should not be called because the deterministic Amazon
      // parser handles this email — but we provide a stub to avoid real network calls.
      extractFromText: async () => {
        throw new Error('AI extractor should not be called for a deterministic-parser email');
      },
    },
  );

  const order = await ExternalOrder.findOne({ where: {} });
  assert.ok(order, 'an ExternalOrder row must be created');
  // Use Number() coercion: SQLite returns a JS number, Postgres returns a string.
  // Both are non-null and round-trip via Number() correctly.
  assert.notEqual(order!.subtotal, null, 'subtotal must not be null after persistence fix');
  assert.notEqual(order!.tax, null, 'tax must not be null after persistence fix');
  assert.equal(Number(order!.subtotal), 29.99);
  assert.equal(Number(order!.tax), 3.90);
  assert.equal(order!.currency, 'CAD');
});

function fakeIntegration() {
  return {
    status: 'connected',
    statusReason: null as string | null,
    saved: 0,
    set(values: Record<string, unknown>) {
      Object.assign(this, values);
    },
    async save() {
      this.saved += 1;
    },
  };
}

test('markReauthIfRevoked flags the integration for reconnect on invalid_grant', async () => {
  const integ = fakeIntegration();
  const handled = await markReauthIfRevoked(
    integ as unknown as UserEmailIntegration,
    new GoogleOAuthError('Google refresh failed (400)', 400, 'invalid_grant'),
  );

  assert.equal(handled, true);
  assert.equal(integ.status, 'reconnect_needed');
  assert.ok((integ.statusReason ?? '').length > 0, 'a human-readable reason must be set');
  assert.equal(integ.saved, 1, 'the status change must be persisted');
});

test('markReauthIfRevoked leaves transient/other errors untouched', async () => {
  const integ = fakeIntegration();
  const handled = await markReauthIfRevoked(
    integ as unknown as UserEmailIntegration,
    new Error('network down'),
  );

  assert.equal(handled, false);
  assert.equal(integ.status, 'connected');
  assert.equal(integ.saved, 0);
});

test('receiptCurrencyOrDefault keeps an extracted currency', () => {
  assert.equal(receiptCurrencyOrDefault('USD'), 'USD');
  assert.equal(receiptCurrencyOrDefault('CAD'), 'CAD');
});

test('receiptCurrencyOrDefault falls back to the app default currency, never a hardcoded USD', () => {
  // AI extraction legitimately returns currency null; fabricating 'USD' in a
  // CAD-default app made scoreCurrencyComponent apply its -40 penalty against
  // every CAD transaction, killing otherwise-perfect receipt matches.
  assert.equal(receiptCurrencyOrDefault(null), defaultCurrency);
  assert.equal(receiptCurrencyOrDefault(undefined), defaultCurrency);
});
