/**
 * expandItemNames — turn cryptic abbreviated retail receipt item titles
 * ("KS ORG PNT BTR") into readable product names ("Kirkland Signature Organic
 * Peanut Butter") using OpenAI, then persist them as ExternalOrderItem.displayName.
 *
 * Scope is intentionally narrow: only vendors in EXPANSION_VENDORS (Costco
 * today) get expanded — Amazon/Apple/Google titles are already full product
 * names, so expanding them would be wasted tokens and risk hallucinated detail.
 *
 * Structure mirrors `aiCategorizeAmazonItems.ts`: an injectable openaiCaller
 * (so tests stub the network), a PURE `parse*` function, a batched `expand*`
 * loader, an `apply*` writer, and a best-effort `maybeExpand*ForOrder` gate
 * that no-ops when AI is disabled/unconfigured and never throws to the caller.
 *
 * Runs OUTSIDE any DB transaction: each update is independent, so OpenAI
 * latency never holds row locks and partial expansion is fine (un-expanded
 * rows keep displayName=null and the UI falls back to `title`).
 */
import { Op } from 'sequelize';
import { ExternalOrder, ExternalOrderItem } from '../../models';
import { openaiJsonWithMeta, type OpenAiJsonResult } from '../../ai/openaiJson';
import { getOpenAiConfig } from '../../config/openai';
import { enrichmentAiEnabled } from '../../config/env';
import { logger } from '../../observability/logger';

export const ITEM_NAME_EXPANSION_PROMPT_VERSION = 'costco-item-name-expansion-v1';

/**
 * Vendor allowlist for item-name expansion. Extensible: add a vendor string
 * (matching ExternalOrder.vendor) here to opt it in. Amazon/Apple/Google are
 * deliberately excluded — their titles are already human-readable.
 */
export const EXPANSION_VENDORS = ['costco'] as const;

const MAX_DISPLAY_NAME_LEN = 512;
const BATCH_SIZE = 20;

export type ItemNameExpansion = {
  itemId: number;
  /** Null when the model echoed the raw title or returned nothing usable. */
  displayName: string | null;
  confidence: number;
};

export type ItemNameExpansionResult = {
  suggestions: ItemNameExpansion[];
  meta: OpenAiJsonResult | null;
  promptVersion: string;
};

/**
 * Injectable OpenAI caller so tests can stub the network without monkey-patching
 * fetch. Matches the pattern used by `categorizeAmazonItemsWithAi`.
 */
export type ItemNameOpenAiCaller = (
  messages: Parameters<typeof openaiJsonWithMeta>[0],
  options: Parameters<typeof openaiJsonWithMeta>[1],
) => Promise<OpenAiJsonResult>;

const defaultItemNameOpenAiCaller: ItemNameOpenAiCaller = (messages, options) =>
  openaiJsonWithMeta(messages, options);

type ItemNameContext = {
  itemId: number;
  title: string;
  unitPrice: number | null;
};

function asNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeForCompare(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

const SYSTEM_PROMPT =
  'You expand abbreviated retail receipt item descriptions into the full ' +
  'human-readable product name. Costco-style abbreviations: KS=Kirkland ' +
  'Signature, ORG=Organic, etc. If the text is already a readable product ' +
  'name, return it unchanged. Do NOT invent specifics (sizes, flavors) you ' +
  'cannot infer from the text. Return strict JSON only.';

/**
 * Build the chat messages for one batch. Extracted (and exported) so the prompt
 * shape can be unit-tested without the network.
 */
export function buildItemNameExpansionMessages(
  batch: ItemNameContext[],
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'Expand each receipt item title into its full human-readable product name.',
        'Keep brand and descriptors that the abbreviation clearly implies; do not add specifics you cannot infer.',
        'If a title is already readable, return it unchanged.',
        'Return one result for every input item.',
        'Return ONLY JSON: {"items":[{"itemId":number,"displayName":string,"confidence":0-100}]}',
        `Data: ${JSON.stringify({ items: batch })}`,
      ].join('\n'),
    },
  ];
}

/**
 * PURE parser: map the model's JSON onto sanitized expansions.
 *  - trims + length-caps displayName to 512 chars
 *  - clamps confidence into [0,100]
 *  - drops rows whose itemId isn't in the batch
 *  - passthrough: leaves displayName=null when the expansion is empty or equal
 *    to the raw title (case/whitespace-insensitive) so the UI falls back to title
 */
export function parseItemNameExpansions(
  json: Record<string, unknown>,
  items: Array<{ id: number; title: string }>,
): ItemNameExpansion[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows = Array.isArray(json.items) ? json.items : [];
  return rows
    .map((row): ItemNameExpansion | null => {
      if (!row || typeof row !== 'object') return null;
      const obj = row as Record<string, unknown>;
      const itemId = Number(obj.itemId);
      const item = byId.get(itemId);
      if (!item) return null;
      const confidence = clampConfidence(obj.confidence);
      const raw = typeof obj.displayName === 'string' ? obj.displayName.trim() : '';
      const capped = raw.slice(0, MAX_DISPLAY_NAME_LEN);
      // Passthrough / no-op: empty, or identical to the title after normalization.
      const isNoop =
        capped.length === 0 ||
        normalizeForCompare(capped) === normalizeForCompare(item.title);
      return {
        itemId,
        displayName: isNoop ? null : capped,
        confidence,
      };
    })
    .filter((row): row is ItemNameExpansion => row != null);
}

/**
 * Load matching items (vendor-gated + optional order/item filters), batch them
 * 20-per-call, and ask the model to expand each title. Returns sanitized
 * suggestions; does NOT write to the DB (see applyItemNameExpansions).
 */
export async function expandCostcoItemNames(
  args: {
    householdId: number;
    orderId?: number | null;
    itemIds?: number[];
    limit?: number;
  },
  opts?: { openaiCaller?: ItemNameOpenAiCaller },
): Promise<ItemNameExpansionResult> {
  const call = opts?.openaiCaller ?? defaultItemNameOpenAiCaller;

  const orderWhere: Record<string, unknown> = {
    householdId: args.householdId,
    vendor: { [Op.in]: EXPANSION_VENDORS as unknown as string[] },
  };
  if (args.orderId != null) orderWhere.id = args.orderId;

  const itemWhere: Record<string, unknown> = {};
  if (args.itemIds?.length) itemWhere.id = { [Op.in]: args.itemIds };

  const itemLimit = args.itemIds?.length
    ? Math.min(500, args.itemIds.length)
    : Math.min(500, Math.max(1, args.limit ?? 200));

  const items = await ExternalOrderItem.findAll({
    where: itemWhere,
    include: [{ model: ExternalOrder, as: 'order', where: orderWhere, required: true }],
    order: [['id', 'DESC']],
    limit: itemLimit,
  });

  const itemContexts: ItemNameContext[] = items.map((item) => ({
    itemId: item.id,
    title: item.title,
    unitPrice: asNumber(item.unitPrice),
  }));

  if (itemContexts.length === 0) {
    return { suggestions: [], meta: null, promptVersion: ITEM_NAME_EXPANSION_PROMPT_VERSION };
  }

  const batches: ItemNameContext[][] = [];
  for (let i = 0; i < itemContexts.length; i += BATCH_SIZE) {
    batches.push(itemContexts.slice(i, i + BATCH_SIZE));
  }

  const metas: OpenAiJsonResult[] = [];
  const suggestions: ItemNameExpansion[] = [];
  for (const batch of batches) {
    const meta = await call(buildItemNameExpansionMessages(batch), {
      temperature: 0.1,
      maxTokens: 4000,
    });
    metas.push(meta);
    suggestions.push(
      ...parseItemNameExpansions(
        meta.json,
        batch.map((item) => ({ id: item.itemId, title: item.title })),
      ),
    );
  }

  const firstMeta = metas[0] ?? null;
  return {
    suggestions,
    meta: firstMeta
      ? {
          json: { items: suggestions },
          model: firstMeta.model,
          temperature: firstMeta.temperature,
          latencyMs: metas.reduce((sum, row) => sum + row.latencyMs, 0),
          providerRequestId:
            metas.map((row) => row.providerRequestId).filter(Boolean).join(',') || null,
          rawTextPreview: firstMeta.rawTextPreview,
        }
      : null,
    promptVersion: ITEM_NAME_EXPANSION_PROMPT_VERSION,
  };
}

/**
 * Persist expansions. Writes displayName + displayNameConfidence per item.
 * Skips no-op suggestions (displayName=null) so passthrough rows keep their
 * existing (null) displayName and the UI falls back to title.
 * Returns the number of rows updated.
 */
export async function applyItemNameExpansions(
  suggestions: ItemNameExpansion[],
): Promise<number> {
  let updated = 0;
  for (const suggestion of suggestions) {
    if (suggestion.displayName == null) continue;
    const [count] = await ExternalOrderItem.update(
      {
        displayName: suggestion.displayName,
        displayNameConfidence: String(suggestion.confidence),
      },
      { where: { id: suggestion.itemId } },
    );
    updated += count;
  }
  return updated;
}

/**
 * Best-effort ingest hook: expand + apply readable names for one order's
 * Costco items. No-ops cleanly when enrichment AI is disabled or OpenAI is not
 * configured. Wrapped in try/catch — NEVER throws to the caller, so a flaky
 * OpenAI call can't fail (or slow-fail) receipt ingest.
 */
export async function maybeExpandItemNamesForOrder(
  args: { householdId: number; orderId: number },
  opts?: { openaiCaller?: ItemNameOpenAiCaller },
): Promise<number> {
  if (!enrichmentAiEnabled || getOpenAiConfig() == null) return 0;
  try {
    const { suggestions } = await expandCostcoItemNames(
      { householdId: args.householdId, orderId: args.orderId },
      opts,
    );
    return await applyItemNameExpansions(suggestions);
  } catch (err) {
    logger.warn(
      { err, orderId: args.orderId, householdId: args.householdId, module: 'expandItemNames' },
      'expand_item_names_failed',
    );
    return 0;
  }
}
