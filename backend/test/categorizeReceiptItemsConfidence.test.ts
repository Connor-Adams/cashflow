import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, ExternalOrder, ExternalOrderItem } from '../src/models';
import { categorizeAndApplyReceiptItems, type ReceiptOpenAiCaller } from '../src/import/categorizeReceiptItems';

const HH = 1;
let seq = 0;
before(async () => { await sequelize.sync({ force: true }); });

/**
 * Fake caller that mirrors the real OpenAI response contract.
 * categorizeReceiptItemsWithAi sends batches of items in the user message
 * (as JSON with {items:[{itemId,title,quantity,totalPrice}]}), then calls
 * parseReceiptItemCategorySuggestions which reads meta.json.items where each
 * element has {itemId,category,confidence,rationale}.
 *
 * We parse the item IDs out of the user message and echo them back with a
 * fixed high-confidence category, exactly as a real LLM response would look.
 */
const caller: ReceiptOpenAiCaller = async (messages, _options) => {
  // Extract the itemIds from the data payload embedded in the user message content.
  const userMsg = messages.find((m) => m.role === 'user');
  const text = typeof userMsg?.content === 'string'
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
      const parsed = JSON.parse(dataMatch[1]) as { items?: Array<{ itemId: number }> };
      itemIds = (parsed.items ?? []).map((i) => i.itemId);
    } catch { /* ignore */ }
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

async function order(vendor: string): Promise<number> {
  seq += 1;
  const o = await ExternalOrder.create({
    householdId: HH,
    vendor,
    dedupeKey: `dk-${vendor}-${seq}`,
    total: '10.00',
    currency: 'CAD',
    orderDate: '2026-05-01',
    source: 'test',
  } as never);
  return o.id;
}

test('categorizer fills confidence on a category-but-null-confidence item', async () => {
  const o = await order('uber');
  const item = await ExternalOrderItem.create({
    externalOrderId: o,
    title: 'Uber trip',
    inferredCategory: 'Transport',
    categoryOverride: null,
    confidence: null,
  } as never);
  await categorizeAndApplyReceiptItems({ householdId: HH, orderId: o }, { openaiCaller: caller });
  const after = await ExternalOrderItem.findByPk(item.id);
  assert.notEqual((after as unknown as { confidence: string | null }).confidence, null,
    'confidence should be set after categorization');
});

test('categorizer does NOT re-process an item that already has a confidence', async () => {
  const o = await order('uber');
  const item = await ExternalOrderItem.create({
    externalOrderId: o,
    title: 'Uber trip',
    inferredCategory: 'Transport',
    categoryOverride: null,
    confidence: '88',
  } as never);
  await categorizeAndApplyReceiptItems({ householdId: HH, orderId: o }, { openaiCaller: caller });
  const after = await ExternalOrderItem.findByPk(item.id);
  // SQLite may return DECIMAL as a number; compare as number.
  assert.equal(Number((after as unknown as { confidence: string | number }).confidence), 88,
    'confidence should remain unchanged when already set');
});
