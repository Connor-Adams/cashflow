import { Op } from 'sequelize'
import { ExternalOrder, ExternalOrderItem } from '../models'
import { loadCategoryHints } from '../ai/suggestTransaction'
import { openaiJsonWithMeta, type OpenAiJsonResult } from '../ai/openaiJson'
import { logger } from '../observability/logger'
import { RECEIPT_CATEGORIES } from './receiptCategories'
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from './enrichment/recomputeTransactionReviewFromItems'

export const RECEIPT_ITEM_CATEGORIZATION_PROMPT_VERSION = 'receipt-item-categorization-v1'

export type ReceiptItemCategorySuggestion = {
  itemId: number
  category: string
  confidence: number
  rationale: string
}

export type ReceiptItemCategorizationResult = {
  suggestions: ReceiptItemCategorySuggestion[]
  inputSnapshot: unknown
  meta: OpenAiJsonResult
  promptVersion: string
}

/** Injectable OpenAI caller so tests stub the network (same pattern as the Amazon categorizer). */
export type ReceiptOpenAiCaller = (
  messages: Parameters<typeof openaiJsonWithMeta>[0],
  options: Parameters<typeof openaiJsonWithMeta>[1],
) => Promise<OpenAiJsonResult>

const defaultReceiptOpenAiCaller: ReceiptOpenAiCaller = (messages, options) =>
  openaiJsonWithMeta(messages, options)

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clampConfidence(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 60
  return Math.max(0, Math.min(100, Math.round(n)))
}

function normalizeCategoryLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 128)
}

function parseCategory(value: unknown, preferredCategories: string[]): string {
  if (typeof value === 'string') {
    const normalized = normalizeCategoryLabel(value)
    const preferredMatch = preferredCategories.find((c) => c.toLowerCase() === normalized.toLowerCase())
    if (preferredMatch) return preferredMatch
    const fallbackMatch = RECEIPT_CATEGORIES.find((c) => c.toLowerCase() === normalized.toLowerCase())
    if (fallbackMatch) return fallbackMatch
    if (normalized) return normalized
  }
  return 'Other'
}

export function parseReceiptItemCategorySuggestions(
  json: Record<string, unknown>,
  items: Array<{ id: number }>,
  preferredCategories: string[] = [],
): ReceiptItemCategorySuggestion[] {
  const validIds = new Set(items.map((i) => i.id))
  const rows = Array.isArray(json.items) ? json.items : []
  const seen = new Set<number>()
  const out: ReceiptItemCategorySuggestion[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const obj = row as Record<string, unknown>
    const itemId = Number(obj.itemId)
    if (!validIds.has(itemId) || seen.has(itemId)) continue
    seen.add(itemId)
    const rationale =
      typeof obj.rationale === 'string' && obj.rationale.trim()
        ? obj.rationale.trim().slice(0, 240)
        : 'AI category suggestion based on receipt line item.'
    out.push({
      itemId,
      category: parseCategory(obj.category, preferredCategories),
      confidence: clampConfidence(obj.confidence),
      rationale,
    })
  }
  return out
}

type ReceiptItemContext = {
  itemId: number
  title: string
  quantity: number
  totalPrice: number | null
}

export async function categorizeReceiptItemsWithAi(
  args: { householdId: number; orderId?: number; orderIds?: number[]; itemIds?: number[]; limit?: number },
  opts?: { openaiCaller?: ReceiptOpenAiCaller },
): Promise<ReceiptItemCategorizationResult> {
  const call = opts?.openaiCaller ?? defaultReceiptOpenAiCaller

  const orderWhere: Record<string, unknown> = {
    householdId: args.householdId,
    vendor: { [Op.ne]: 'amazon' },
  }
  if (args.orderId != null) orderWhere.id = args.orderId
  else if (args.orderIds?.length) orderWhere.id = { [Op.in]: args.orderIds }

  // Process any item lacking a confidence (including deterministically-parsed
  // Apple/Google/Uber items that already have a category but no confidence), so
  // they can satisfy the SP1 review-clear bar.
  const itemWhere: Record<string, unknown> = { confidence: null }
  if (args.itemIds?.length) itemWhere.id = { [Op.in]: args.itemIds }

  const itemLimit = args.itemIds?.length
    ? Math.min(500, args.itemIds.length)
    : Math.min(200, Math.max(1, args.limit ?? 50))

  const items = await ExternalOrderItem.findAll({
    where: itemWhere,
    include: [{ model: ExternalOrder, as: 'order', where: orderWhere, required: true }],
    order: [['id', 'ASC']],
    limit: itemLimit,
  })

  const itemContexts: ReceiptItemContext[] = items.map((item) => ({
    itemId: item.id,
    title: item.title,
    quantity: item.quantity,
    totalPrice: asNumber(item.totalPrice),
  }))

  if (itemContexts.length === 0) {
    return {
      suggestions: [],
      inputSnapshot: { items: [] },
      meta: { json: { items: [] }, model: 'none', temperature: 0, latencyMs: 0, providerRequestId: null, rawTextPreview: '' },
      promptVersion: RECEIPT_ITEM_CATEGORIZATION_PROMPT_VERSION,
    }
  }

  const categoryHints = await loadCategoryHints(args.householdId)
  const inputSnapshot = {
    householdCategoryHints: categoryHints.slice(0, 80),
    fallbackCategories: RECEIPT_CATEGORIES,
    items: itemContexts,
  }

  const batches: ReceiptItemContext[][] = []
  for (let i = 0; i < itemContexts.length; i += 20) batches.push(itemContexts.slice(i, i + 20))

  const metas: OpenAiJsonResult[] = []
  const suggestions: ReceiptItemCategorySuggestion[] = []
  for (const batch of batches) {
    const meta = await call(
      [
        {
          role: 'system',
          content:
            'You categorize retail/grocery receipt line items for a household expense tracker. Return strict JSON only.',
        },
        {
          role: 'user',
          content: [
            'Assign every line item to a single spending category.',
            categoryHints.length
              ? `Prefer one of these existing household categories exactly as written whenever reasonably close: ${categoryHints.join(', ')}.`
              : 'There are no existing household categories yet.',
            `Otherwise use one of these fallback categories: ${RECEIPT_CATEGORIES.join(', ')}.`,
            'Only invent a concise new label when neither fits. Use "Other" when the title is too cryptic to guess.',
            'Return one result for every input item.',
            'Return ONLY JSON: {"items":[{"itemId":number,"category":string,"confidence":0-100,"rationale":string}]}',
            `Data: ${JSON.stringify({ householdCategoryHints: categoryHints.slice(0, 80), fallbackCategories: RECEIPT_CATEGORIES, items: batch })}`,
          ].join('\n'),
        },
      ],
      { temperature: 0.1, maxTokens: 4000 },
    )
    metas.push(meta)
    suggestions.push(
      ...parseReceiptItemCategorySuggestions(
        meta.json,
        batch.map((i) => ({ id: i.itemId })),
        categoryHints,
      ),
    )
  }

  const firstMeta = metas[0]
  return {
    suggestions,
    inputSnapshot,
    meta: {
      json: { items: suggestions },
      model: firstMeta.model,
      temperature: firstMeta.temperature,
      latencyMs: metas.reduce((sum, m) => sum + m.latencyMs, 0),
      providerRequestId: metas.map((m) => m.providerRequestId).filter(Boolean).join(',') || null,
      rawTextPreview: firstMeta.rawTextPreview,
    },
    promptVersion: RECEIPT_ITEM_CATEGORIZATION_PROMPT_VERSION,
  }
}

export async function applyReceiptItemCategorySuggestions(
  suggestions: ReceiptItemCategorySuggestion[],
): Promise<number> {
  let updated = 0
  for (const s of suggestions) {
    // NOTE: static update/bulkCreate bypasses the beforeSave category-id hook, so *_category_id stays null momentarily. Migration 20260623000001 backfills any null FKs where the category string is set.
    const [count] = await ExternalOrderItem.update(
      { inferredCategory: s.category, confidence: String(s.confidence) },
      { where: { id: s.itemId } },
    )
    updated += count
  }
  return updated
}

/**
 * Never-throwing seam used by import handlers and the backfill: categorize the
 * selected (null-category, non-Amazon) items and write them. On any failure it
 * logs and returns 0 — categorization must never break an import.
 */
export async function categorizeAndApplyReceiptItems(
  args: { householdId: number | null; orderId?: number; orderIds?: number[]; limit?: number },
  opts?: { openaiCaller?: ReceiptOpenAiCaller },
): Promise<number> {
  if (args.householdId == null) return 0
  try {
    const result = await categorizeReceiptItemsWithAi(
      { householdId: args.householdId, orderId: args.orderId, orderIds: args.orderIds, limit: args.limit },
      opts,
    )
    const updated = await applyReceiptItemCategorySuggestions(result.suggestions)
    // Recompute review flags for any transactions linked to the categorized orders.
    // Start with any explicit order ids from the caller.
    const explicit = args.orderId != null ? [args.orderId] : (args.orderIds ?? [])
    // Derive touched order ids from the suggestions when no explicit ids were given
    // (e.g. the household-wide "categorize all uncategorized items" path).
    const itemIds = result.suggestions.map((s) => s.itemId)
    const touchedRows = itemIds.length > 0
      ? await ExternalOrderItem.findAll({ where: { id: itemIds }, attributes: ['externalOrderId'] })
      : []
    const derived = touchedRows.map((r) => (r as unknown as { externalOrderId: number }).externalOrderId)
    const orderIdList = [...new Set([...explicit, ...derived])]
    const txnIds = (await Promise.all(orderIdList.map(transactionIdsForOrder))).flat()
    await recomputeTransactionsReviewFromItems(txnIds)
    return updated
  } catch (err) {
    logger.warn({ err, orderId: args.orderId, orderIds: args.orderIds }, 'receipt_item_categorization_failed')
    return 0
  }
}
