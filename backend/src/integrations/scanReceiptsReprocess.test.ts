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
//
// The pre-existing rows below are built to be internally consistent with what
// scanInbox itself would have written on an original scan (dedupeKey computed
// from the SAME fields the row carries, ProcessedEmailMessage.externalOrderId
// pointing at the order it recorded) — not an ad hoc fixture whose dedupeKey
// disagrees with its own vendorOrderId/total, which production cannot
// produce. The reprocess path (findExistingOrderForMessage in scanReceipts.ts)
// deliberately does NOT use dedupeKey to locate the row being improved, since
// a genuinely improving reparse computes a different dedupeKey than what's
// stored by definition — it locates by Gmail message id instead, via
// ProcessedEmailMessage.externalOrderId (primary) or
// ExternalOrder.rawPayload.gmailMessageId (fallback).
// ---------------------------------------------------------------------------

const ACCESS_OPTS = { userId: 97, householdId: 97, maxMessages: 10 };
// The original parser finds the order id and total but no line item (no title
// line precedes "Quantity: 1" / "$44.97") and no order date.
const BODY_NO_ITEM_NO_DATE =
  'Your Amazon.ca order\nOrder # 701-9999999-8888888\nOrder Total: $44.97\nQuantity: 1\n$44.97\n';
// A fixed/improved parser run against a body that DOES have a title line
// finds one line item — a realistic "the reparse improves extraction" delta.
const BODY_WITH_ITEM =
  'Your Amazon.ca order\nOrder # 701-9999999-8888888\nWidget\nQuantity: 1\n$44.97\nOrder Total: $44.97\n';

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

/** Builds a minimal GmailMessageFull with a plain-text body and a fixed internalDate. */
function gmailMessage(body: string): GmailMessageFull {
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
      body: { data: Buffer.from(body).toString('base64url') },
    },
  } as unknown as GmailMessageFull;
}

function depsFor(body: string) {
  return {
    listMessageIds: async () => [{ id: 'msg-repro', threadId: 't' }],
    fetchMessage: async () => gmailMessage(body),
    extractFromText: async () => {
      throw new Error('deterministic parser should have handled this');
    },
  };
}

const deps = depsFor(BODY_NO_ITEM_NO_DATE);

/**
 * Seed a pre-existing ExternalOrder + ProcessedEmailMessage pair shaped the
 * way scanInbox itself would have written them on an original (non-reprocess)
 * scan of BODY_NO_ITEM_NO_DATE for msg-repro: dedupeKey computed from this
 * row's own fields, and the ProcessedEmailMessage pointing back at it via
 * externalOrderId — exactly what recordProcessed writes on every scan.
 */
async function seedPreExistingOrder(overrides: {
  vendorOrderId: string;
  orderDate: string | null;
  total: string;
  paymentLast4: string | null;
}): Promise<ExternalOrder> {
  const dedupeKey = [
    'amazon',
    overrides.vendorOrderId,
    overrides.orderDate ?? '',
    overrides.total,
    '0', // the original scan found no line items
    'msg-repro',
  ].join(':');
  const order = await ExternalOrder.create({
    householdId: 97, vendor: 'amazon', vendorOrderId: overrides.vendorOrderId,
    dedupeKey,
    orderDate: overrides.orderDate, total: overrides.total, currency: 'CAD',
    paymentLast4: overrides.paymentLast4,
    source: 'gmail-scan:amazon', rawPayload: { gmailMessageId: 'msg-repro' },
  } as never);
  await ProcessedEmailMessage.create({
    householdId: 97, provider: 'google', messageId: 'msg-repro',
    status: 'extracted', parser: 'amazon', externalOrderId: order.id,
    errorMessage: null, subject: null, fromAddr: null, scannedAt: new Date(),
  } as never);
  return order;
}

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
  const order = await seedPreExistingOrder({
    vendorOrderId: '701-9999999-8888888', orderDate: null, total: '44.97', paymentLast4: null,
  });

  await scanInbox({ ...ACCESS_OPTS, forceReprocessMessageIds: ['msg-repro'] }, {}, deps);

  await order.reload();
  assert.equal(order.orderDate, '2025-08-28', 'null order date is backfilled (from the internalDate fallback)');
});

test('forceReprocess never overwrites a non-null field', async () => {
  // This row is already fully corrected (all fields non-null) — a state a
  // normal scan or a manual fix could equally have produced. vendorOrderId,
  // total and orderDate are internally consistent with each other and with
  // the row's own dedupeKey (built the same way seedPreExistingOrder always
  // builds it), unlike the original ad hoc fixture this replaces.
  const order = await seedPreExistingOrder({
    vendorOrderId: '701-7777777-6666666', orderDate: '2020-01-01', total: '99.99', paymentLast4: '4321',
  });

  await scanInbox({ ...ACCESS_OPTS, forceReprocessMessageIds: ['msg-repro'] }, {}, deps);

  await order.reload();
  assert.equal(order.orderDate, '2020-01-01', 'a user-corrected date survives');
  assert.equal(Number(order.total), 99.99, 'a user-corrected total survives');
  assert.equal(order.paymentLast4, '4321', 'a user-corrected payment last4 survives');
});

// FIX 3: a reprocess that genuinely improves the parse (finds a line item the
// original run missed) must UPDATE the existing row, not create a second one.
// Locating by content-derived dedupeKey would miss this row precisely because
// the improved extraction (itemsCount 0 -> 1) computes a different key.
test('a reprocess that finds a new line item updates the existing order, not a duplicate', async () => {
  const order = await seedPreExistingOrder({
    vendorOrderId: '701-9999999-8888888', orderDate: null, total: '44.97', paymentLast4: null,
  });

  const before = await ExternalOrder.count({ where: { householdId: 97 } });
  assert.equal(before, 1);

  await scanInbox(
    { ...ACCESS_OPTS, forceReprocessMessageIds: ['msg-repro'] },
    {},
    depsFor(BODY_WITH_ITEM),
  );

  const after = await ExternalOrder.count({ where: { householdId: 97 } });
  assert.equal(after, 1, 'the reparse must update the existing row, not create a duplicate');

  await order.reload();
  assert.equal(order.orderDate, '2025-08-28', 'the null order date is still backfilled from the internalDate fallback');
});
