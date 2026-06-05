import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  sequelize,
  Account,
  Transaction,
  TransactionSignal,
  ExternalOrder,
  ExternalOrderItem,
} from '../models';
import { matchReceiptOrderToTransactions } from './matchReceiptToTransactions';
import {
  categorizeAndApplyReceiptItems,
  type ReceiptOpenAiCaller,
} from './categorizeReceiptItems';

const HH = 1;
let accountId: number;
let fp = 0;

before(async () => {
  await sequelize.sync({ force: true });
  accountId = (
    await Account.create({
      householdId: HH,
      name: 'Card',
      visibility: 'private',
    } as never)
  ).id;
});

/**
 * Fake caller that mirrors the real OpenAI response contract.
 * Parses item IDs out of the "Data: <json>" suffix in the user message and
 * echoes them back with a high confidence (92) so items pass the SP1 bar (>=80).
 * Reuses the same approach as categorizeReceiptItemsConfidence.test.ts.
 */
const caller: ReceiptOpenAiCaller = async (messages, _options) => {
  const userMsg = messages.find((m) => m.role === 'user');
  const text =
    typeof userMsg?.content === 'string'
      ? userMsg.content
      : Array.isArray(userMsg?.content)
        ? (userMsg.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n')
        : '';

  // The user message ends with "Data: <json>" — extract item IDs from it.
  const dataMatch = text.match(/Data:\s*(\{[\s\S]*\})$/);
  let itemIds: number[] = [];
  if (dataMatch) {
    try {
      const parsed = JSON.parse(dataMatch[1]) as {
        items?: Array<{ itemId: number }>;
      };
      itemIds = (parsed.items ?? []).map((i) => i.itemId);
    } catch {
      /* ignore */
    }
  }

  return {
    json: {
      items: itemIds.map((id) => ({
        itemId: id,
        category: 'Transport',
        confidence: 92,
        rationale: 'Stub: transport expense.',
      })),
    },
    model: 'test',
    temperature: 0.1,
    latencyMs: 0,
    providerRequestId: null,
    rawTextPreview: '',
  };
};

test('uber email order: strong txn match + categorize clears review', async () => {
  fp += 1;
  // Score breakdown: 50 (exact amount) + 25 (same date) + 15 (vendor 'uber') = 90
  // 90 >= 85 threshold → auto-accept; single candidate → no runner-up → clear margin
  const txn = await Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: '2026-05-01',
    amount: '-24.50',
    currency: 'CAD',
    merchantRaw: 'UBER TRIP HELP.UBER.COM',
    merchantClean: 'Uber',
    sourceRowFingerprint: `f${fp}`,
    sourceIdentityFingerprint: `f${fp}`,
    txnType: 'purchase',
    reviewFlag: true,
    finalSplitType: 'me',
  } as never);
  await TransactionSignal.create({
    transactionId: txn.id,
    source: 'item-link',
    confidence: 'medium',
    fields: { autoCategory: 'Mixed' },
  } as never);
  const order = await ExternalOrder.create({
    householdId: HH,
    vendor: 'uber',
    dedupeKey: `dk${fp}`,
    total: '24.50',
    currency: 'CAD',
    orderDate: '2026-05-01',
    source: 'email-paste',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Uber trip',
    inferredCategory: 'Transport',
    categoryOverride: null,
    confidence: null,
  } as never);

  await matchReceiptOrderToTransactions({
    externalOrderId: order.id,
    householdId: HH,
  });
  await categorizeAndApplyReceiptItems(
    { householdId: HH, orderId: order.id },
    { openaiCaller: caller },
  );

  assert.equal(
    (await Transaction.findByPk(txn.id))!.reviewFlag,
    false,
    'strong match + high-confidence categorize should clear reviewFlag',
  );
});

test('weak match stays suggested → txn stays in review', async () => {
  fp += 1;
  // Score breakdown: -25 (amount off by $987) + 0 (date gap >> 10 days → -15,
  // but total is still negative) + 15 (vendor) = well below 70 threshold.
  // No link is created at all; txn must stay in review.
  const txn = await Transaction.create({
    accountId,
    householdId: HH,
    importBatch: 'test',
    date: '2026-01-01',
    amount: '-999.00',
    currency: 'CAD',
    merchantRaw: 'UBER',
    merchantClean: 'Uber',
    sourceRowFingerprint: `f${fp}`,
    sourceIdentityFingerprint: `f${fp}`,
    txnType: 'purchase',
    reviewFlag: true,
    finalSplitType: 'me',
  } as never);
  await TransactionSignal.create({
    transactionId: txn.id,
    source: 'item-link',
    confidence: 'medium',
    fields: { autoCategory: 'Mixed' },
  } as never);
  const order = await ExternalOrder.create({
    householdId: HH,
    vendor: 'uber',
    dedupeKey: `dk${fp}`,
    total: '12.00',
    currency: 'CAD',
    orderDate: '2026-05-15',
    source: 'email-paste',
  } as never);
  await ExternalOrderItem.create({
    externalOrderId: order.id,
    title: 'Uber trip',
    inferredCategory: 'Transport',
    categoryOverride: null,
    confidence: null,
  } as never);

  await matchReceiptOrderToTransactions({
    externalOrderId: order.id,
    householdId: HH,
  });
  await categorizeAndApplyReceiptItems(
    { householdId: HH, orderId: order.id },
    { openaiCaller: caller },
  );

  assert.equal(
    (await Transaction.findByPk(txn.id))!.reviewFlag,
    true,
    'weak/no match should leave reviewFlag unchanged (true)',
  );
});
