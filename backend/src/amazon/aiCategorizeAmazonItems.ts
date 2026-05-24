import { Op } from 'sequelize';
import { ExternalOrder, ExternalOrderItem } from '../models';
import { loadCategoryHints } from '../ai/suggestTransaction';
import { openaiJsonWithMeta, type OpenAiJsonResult } from '../ai/openaiJson';
import { AMAZON_CATEGORIES, categorizeAmazonItem } from './categories';

export const AMAZON_ITEM_CATEGORIZATION_PROMPT_VERSION =
  'amazon-item-categorization-v1';

export type AmazonItemCategorySuggestion = {
  itemId: number;
  category: string;
  businessUsePercent: number | null;
  confidence: number;
  rationale: string;
  usedExistingCategory: boolean;
};

export type AmazonItemCategorizationResult = {
  suggestions: AmazonItemCategorySuggestion[];
  inputSnapshot: unknown;
  meta: OpenAiJsonResult;
  promptVersion: string;
};

/**
 * Injectable OpenAI caller so tests can stub the network without monkey-patching
 * fetch. Matches the pattern used by `runAiBatchStage` (enrichment/aiBatchStage.ts).
 */
export type AmazonOpenAiCaller = (
  messages: Parameters<typeof openaiJsonWithMeta>[0],
  options: Parameters<typeof openaiJsonWithMeta>[1],
) => Promise<OpenAiJsonResult>;

const defaultAmazonOpenAiCaller: AmazonOpenAiCaller = (messages, options) =>
  openaiJsonWithMeta(messages, options);

type AmazonItemContext = {
  itemId: number;
  orderId: number;
  vendorOrderId: string | null;
  orderDate: string | null;
  shipmentDate: string | null;
  orderTotal: number | null;
  currency: string;
  title: string;
  quantity: number;
  unitPrice: number | null;
  totalPrice: number | null;
  currentCategory: string;
  currentBusinessUsePercent: number | null;
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

function normalizeCategoryLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 128);
}

function parseCategory(value: unknown, title: string, preferredCategories: string[]): string {
  if (typeof value === 'string') {
    const normalized = normalizeCategoryLabel(value);
    const preferredMatch = preferredCategories.find(
      (category) => category.toLowerCase() === normalized.toLowerCase(),
    );
    if (preferredMatch) return preferredMatch;
    const fallbackMatch = AMAZON_CATEGORIES.find(
      (category) => category.toLowerCase() === normalized.toLowerCase(),
    );
    if (fallbackMatch) return fallbackMatch;
    if (normalized) return normalized;
  }
  return categorizeAmazonItem(title);
}

function normalizeCategoryKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pickExistingCategoryForItem(args: {
  aiCategory: string;
  title: string;
  preferredCategories: string[];
}): string | null {
  const preferred = args.preferredCategories;
  if (!preferred.length) return null;
  const title = normalizeCategoryKey(args.title);
  const ai = normalizeCategoryKey(args.aiCategory);
  const exact = preferred.find((category) => normalizeCategoryKey(category) === ai);
  if (exact) return exact;

  const titleTerms = new Set(title.split(/\s+/).filter(Boolean));
  const hasWord = (...terms: string[]) => terms.some((term) => titleTerms.has(term));
  const hasPhrase = (...phrases: string[]) => phrases.some((phrase) => title.includes(phrase));
  const categoryHas = (...terms: string[]) =>
    terms
      .map((term) => preferred.find((category) => normalizeCategoryKey(category).includes(term)))
      .find((category): category is string => category != null) ?? null;

  if (
    (hasWord('coffee', 'espresso', 'keurig', 'nespresso', 'barista') && !hasPhrase('coffee shop')) ||
    hasPhrase('coffee maker', 'coffee syrup', 'torani', 'k cup', 'k cups')
  ) {
    return categoryHas('coffee', 'grocer');
  }
  if (
    hasWord('wii') ||
    hasPhrase('oculus quest 2', 'oculus quest 3', 'quest 2 link cable', 'quest 3 link cable', 'game controller', 'nunchuck')
  ) {
    return categoryHas('games');
  }
  if (
    hasWord('desk', 'monitor', 'keyboard', 'webcam', 'mouse') ||
    hasPhrase('wrist rest', 'mouse pad', 'usb hub', 'displayport', 'ethernet cable')
  ) {
    return categoryHas('desk', 'laptop');
  }
  if (
    hasWord('bathroom', 'towel', 'rug', 'faucet', 'deadbolt') ||
    hasPhrase('shop light', 'door lock', 'bath mat', 'medicine cabinet', 'bathroom cabinet')
  ) {
    return categoryHas('house');
  }
  if (hasWord('candy', 'starburst', 'skittles', 'snack', 'crackers')) return categoryHas('grocer', 'coffee');
  if (hasWord('golf')) return categoryHas('golf');
  if (hasWord('snowboard') || hasPhrase('ski boot', 'ski bag')) return categoryHas('snowboarding');

  if (ai === 'meals groceries' || ai === 'household') {
    if ((hasWord('coffee', 'espresso', 'keurig', 'nespresso') && !hasPhrase('coffee shop')) || hasPhrase('torani')) {
      return categoryHas('coffee', 'grocer');
    }
    if (hasWord('candy', 'starburst', 'skittles', 'snack', 'crackers')) return categoryHas('grocer', 'coffee');
  }
  if (ai === 'office equipment' || ai === 'software') {
    if (hasWord('desk', 'monitor', 'keyboard', 'webcam', 'mouse') || hasPhrase('wrist rest', 'mouse pad', 'usb hub')) {
      return categoryHas('desk', 'laptop');
    }
  }
  if (ai === 'household' || ai === 'personal') {
    if (hasWord('bathroom', 'towel', 'rug', 'faucet', 'deadbolt') || hasPhrase('medicine cabinet', 'bathroom cabinet')) {
      return categoryHas('house');
    }
  }
  if (ai === 'medical') return categoryHas('diabetes', 'dentist', 'medical');
  return null;
}

export function parseAmazonItemCategorySuggestions(
  json: Record<string, unknown>,
  items: Array<{ id: number; title: string }>,
  preferredCategories: string[] = [],
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
      const parsedCategory = parseCategory(obj.category, item.title, preferredCategories);
      const existingCategory = pickExistingCategoryForItem({
        aiCategory: parsedCategory,
        title: item.title,
        preferredCategories,
      });
      const category = existingCategory ?? parsedCategory;
      return {
        itemId,
        category,
        businessUsePercent: clampPercent(obj.businessUsePercent),
        confidence: clampConfidence(obj.confidence),
        rationale: existingCategory
          ? `${rationale} Remapped to existing category "${existingCategory}".`.slice(0, 240)
          : rationale,
        usedExistingCategory: existingCategory != null,
      };
    })
    .filter((row): row is AmazonItemCategorySuggestion => row != null);
}

export async function categorizeAmazonItemsWithAi(
  args: {
    householdId: number;
    orderId?: number | null;
    itemIds?: number[];
    limit?: number;
  },
  opts?: { openaiCaller?: AmazonOpenAiCaller },
): Promise<AmazonItemCategorizationResult> {
  const call = opts?.openaiCaller ?? defaultAmazonOpenAiCaller;
  const orderWhere: Record<string, unknown> = {
    householdId: args.householdId,
    vendor: 'amazon',
  };
  if (args.orderId != null) orderWhere.id = args.orderId;
  const itemWhere: Record<string, unknown> = {};
  if (args.itemIds?.length) itemWhere.id = { [Op.in]: args.itemIds };

  const itemLimit = args.itemIds?.length
    ? Math.min(500, args.itemIds.length)
    : Math.min(200, Math.max(1, args.limit ?? 50));
  const items = await ExternalOrderItem.findAll({
    where: itemWhere,
    include: [{ model: ExternalOrder, as: 'order', where: orderWhere, required: true }],
    order: [
      [{ model: ExternalOrder, as: 'order' }, 'orderDate', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: itemLimit,
  });

  const itemContexts = items.map((item) => {
    const order = item.get('order') as ExternalOrder | undefined;
    return {
      itemId: item.id,
      orderId: order?.id ?? item.externalOrderId,
      vendorOrderId: order?.vendorOrderId ?? null,
      orderDate: order?.orderDate ?? null,
      shipmentDate: order?.shipmentDate ?? null,
      orderTotal: asNumber(order?.total),
      currency: order?.currency ?? 'CAD',
      title: item.title,
      quantity: item.quantity,
      unitPrice: asNumber(item.unitPrice),
      totalPrice: asNumber(item.totalPrice),
      currentCategory: item.inferredCategory || categorizeAmazonItem(item.title),
      currentBusinessUsePercent: asNumber(item.businessUsePercent),
    };
  });

  if (itemContexts.length === 0) {
    const err = new Error('No Amazon items found to categorize') as Error & {
      status?: number;
    };
    err.status = 404;
    throw err;
  }

  const categoryHints = await loadCategoryHints(args.householdId);
  const fallbackCategories = AMAZON_CATEGORIES.filter(
    (category) =>
      !categoryHints.some((hint) => hint.toLowerCase() === category.toLowerCase()),
  );
  const inputSnapshot = {
    householdCategoryHints: categoryHints.slice(0, 80),
    fallbackCategories,
    items: itemContexts,
  };
  const batches: AmazonItemContext[][] = [];
  for (let i = 0; i < itemContexts.length; i += 20) {
    batches.push(itemContexts.slice(i, i + 20));
  }

  const metas: OpenAiJsonResult[] = [];
  const suggestions: AmazonItemCategorySuggestion[] = [];
  for (const batch of batches) {
    const meta = await call(
    [
      {
        role: 'system',
        content:
          'You categorize Amazon purchase items for a household/business expense tracker. Return strict JSON only.',
      },
      {
        role: 'user',
        content: [
          'Use the item title and order context to assign every item to a category.',
          categoryHints.length
            ? `You MUST use one of these existing household categories exactly as written whenever any category is even reasonably close: ${categoryHints.join(', ')}.`
            : 'There are no existing household categories yet.',
          `Only if none of the household categories are reasonably close, use one of these fallback categories: ${fallbackCategories.join(', ')}.`,
          'Only create a new concise category label when neither household nor fallback categories fit.',
          'Do not use generic fallback labels when a household label is close. For example use Coffee over Meals & Groceries, Games over Uncategorized for game controllers, House over Household for home goods, Desk/Laptop over Office Equipment for computer gear.',
          'Use businessUsePercent as 0-100 when the item is plausibly business-related; otherwise null.',
          'Return one result for every input item.',
          'Return ONLY JSON: {"items":[{"itemId":number,"category":string,"usedExistingCategory":boolean,"businessUsePercent":number|null,"confidence":0-100,"rationale":string}]}',
            `Data: ${JSON.stringify({
              householdCategoryHints: categoryHints.slice(0, 80),
              fallbackCategories,
              items: batch,
            })}`,
        ].join('\n'),
      },
    ],
    { temperature: 0.1, maxTokens: 4000 },
  );
    metas.push(meta);
    suggestions.push(
      ...parseAmazonItemCategorySuggestions(
        meta.json,
        batch.map((item) => ({ id: item.itemId, title: item.title })),
        categoryHints,
      ),
    );
  }
  const firstMeta = metas[0];

  return {
    suggestions,
    inputSnapshot,
    meta: {
      json: { items: suggestions },
      model: firstMeta.model,
      temperature: firstMeta.temperature,
      latencyMs: metas.reduce((sum, row) => sum + row.latencyMs, 0),
      providerRequestId: metas.map((row) => row.providerRequestId).filter(Boolean).join(',') || null,
      rawTextPreview: firstMeta.rawTextPreview,
    },
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
