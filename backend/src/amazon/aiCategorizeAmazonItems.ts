import { Op } from 'sequelize';
import { ExternalOrder, ExternalOrderItem } from '../models';
import { loadCategoryHints } from '../ai/suggestTransaction';
import { openaiJsonWithMeta, type OpenAiJsonResult } from '../ai/openaiJson';
import {
  AMAZON_CATEGORIES,
  categorizeAmazonItem,
  type AmazonCategory,
} from './categories';

export const AMAZON_ITEM_CATEGORIZATION_PROMPT_VERSION =
  'amazon-item-categorization-v1';

export type AmazonItemCategorySuggestion = {
  itemId: number;
  category: AmazonCategory;
  businessUsePercent: number | null;
  confidence: number;
  rationale: string;
};

export type AmazonItemCategorizationResult = {
  suggestions: AmazonItemCategorySuggestion[];
  inputSnapshot: unknown;
  meta: OpenAiJsonResult;
  promptVersion: string;
};

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampPercent(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseCategory(value: unknown, title: string): AmazonCategory {
  if (typeof value === 'string') {
    const match = AMAZON_CATEGORIES.find(
      (category) => category.toLowerCase() === value.trim().toLowerCase(),
    );
    if (match) return match;
  }
  return categorizeAmazonItem(title);
}

export function parseAmazonItemCategorySuggestions(
  json: Record<string, unknown>,
  items: Array<{ id: number; title: string }>,
): AmazonItemCategorySuggestion[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows = Array.isArray(json.items) ? json.items : [];
  return rows
    .map((row): AmazonItemCategorySuggestion | null => {
      if (!row || typeof row !== 'object') return null;
      const obj = row as Record<string, unknown>;
      const itemId = Number(obj.itemId);
      const item = byId.get(itemId);
      if (!item) return null;
      const rationale =
        typeof obj.rationale === 'string' && obj.rationale.trim()
          ? obj.rationale.trim().slice(0, 240)
          : 'AI category suggestion based on Amazon item title.';
      return {
        itemId,
        category: parseCategory(obj.category, item.title),
        businessUsePercent: clampPercent(obj.businessUsePercent),
        confidence: clampConfidence(obj.confidence),
        rationale,
      };
    })
    .filter((row): row is AmazonItemCategorySuggestion => row != null);
}

export async function categorizeAmazonItemsWithAi(args: {
  householdId: number;
  orderId?: number | null;
  itemIds?: number[];
  limit?: number;
}): Promise<AmazonItemCategorizationResult> {
  const orderWhere: Record<string, unknown> = {
    householdId: args.householdId,
    vendor: 'amazon',
  };
  if (args.orderId != null) orderWhere.id = args.orderId;
  const itemWhere: Record<string, unknown> = {};
  if (args.itemIds?.length) itemWhere.id = { [Op.in]: args.itemIds };

  const orders = await ExternalOrder.findAll({
    where: orderWhere,
    include: [{ model: ExternalOrderItem, as: 'items', where: itemWhere, required: true }],
    order: [
      ['orderDate', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: Math.min(100, Math.max(1, args.limit ?? 50)),
  });

  const itemContexts = orders.flatMap((order) => {
    const items = (order.get('items') as ExternalOrderItem[] | undefined) ?? [];
    return items.map((item) => ({
      itemId: item.id,
      orderId: order.id,
      vendorOrderId: order.vendorOrderId,
      orderDate: order.orderDate,
      shipmentDate: order.shipmentDate,
      orderTotal: asNumber(order.total),
      currency: order.currency,
      title: item.title,
      quantity: item.quantity,
      unitPrice: asNumber(item.unitPrice),
      totalPrice: asNumber(item.totalPrice),
      currentCategory: item.inferredCategory || categorizeAmazonItem(item.title),
      currentBusinessUsePercent: asNumber(item.businessUsePercent),
    }));
  });

  if (itemContexts.length === 0) {
    const err = new Error('No Amazon items found to categorize') as Error & {
      status?: number;
    };
    err.status = 404;
    throw err;
  }

  const categoryHints = await loadCategoryHints(args.householdId);
  const inputSnapshot = {
    categories: AMAZON_CATEGORIES,
    householdCategoryHints: categoryHints.slice(0, 80),
    items: itemContexts,
  };
  const meta = await openaiJsonWithMeta(
    [
      {
        role: 'system',
        content:
          'You categorize Amazon purchase items for a household/business expense tracker. Return strict JSON only.',
      },
      {
        role: 'user',
        content: [
          'Use the item title and order context to assign each item to exactly one allowed category.',
          `Allowed categories: ${AMAZON_CATEGORIES.join(', ')}.`,
          'Use businessUsePercent as 0-100 when the item is plausibly business-related; otherwise null.',
          'Prefer Office Equipment for work hardware/peripherals, Software for digital services/apps, Meals & Groceries for food/drink, Household for cleaning/home supplies, Personal for personal care, Medical for health products, Travel for travel gear, and Uncategorized when uncertain.',
          'Return ONLY JSON: {"items":[{"itemId":number,"category":string,"businessUsePercent":number|null,"confidence":0-100,"rationale":string}]}',
          `Data: ${JSON.stringify(inputSnapshot)}`,
        ].join('\n'),
      },
    ],
    { temperature: 0.1, maxTokens: 4000 },
  );

  const suggestions = parseAmazonItemCategorySuggestions(
    meta.json,
    itemContexts.map((item) => ({ id: item.itemId, title: item.title })),
  );

  return {
    suggestions,
    inputSnapshot,
    meta,
    promptVersion: AMAZON_ITEM_CATEGORIZATION_PROMPT_VERSION,
  };
}

export async function applyAmazonItemCategorySuggestions(
  suggestions: AmazonItemCategorySuggestion[],
): Promise<number> {
  let updated = 0;
  for (const suggestion of suggestions) {
    const [count] = await ExternalOrderItem.update(
      {
        inferredCategory: suggestion.category,
        businessUsePercent:
          suggestion.businessUsePercent == null
            ? null
            : String(suggestion.businessUsePercent),
        confidence: String(suggestion.confidence),
      },
      { where: { id: suggestion.itemId } },
    );
    updated += count;
  }
  return updated;
}
