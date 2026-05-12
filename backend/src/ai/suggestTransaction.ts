import type { Transaction as TxnModel } from '../models/Transaction';

import { sequelize } from '../models';
import { QueryTypes } from 'sequelize';
import { num } from '../util/numbers';
import { openaiJson, openaiJsonWithMeta, type OpenAiJsonResult } from './openaiJson';
import { findBestRule, loadAllRules } from '../import/applyRules';
import type { Receipt } from '../models/Receipt';
import { findMerchantMemory, type MerchantMemoryMatch } from './merchantMemory';

export const TRANSACTION_SUGGESTION_PROMPT_VERSION = 'transaction-fields-v2';

export async function loadCategoryHints(householdId?: number | null): Promise<string[]> {
  const replacements = householdId != null ? [householdId] : [];
  const ruleWhere =
    householdId != null
      ? `household_id = ? AND category IS NOT NULL AND TRIM(category) != ''`
      : `category IS NOT NULL AND TRIM(category) != ''`;
  const txnWhere =
    householdId != null
      ? `household_id = ? AND final_category IS NOT NULL AND TRIM(final_category) != ''`
      : `final_category IS NOT NULL AND TRIM(final_category) != ''`;
  const [a, b] = await Promise.all([
    sequelize.query<{ c: string }>(
      `SELECT DISTINCT TRIM(category) AS c FROM rules WHERE ${ruleWhere}`,
      { replacements, type: QueryTypes.SELECT },
    ),
    sequelize.query<{ c: string }>(
      `SELECT DISTINCT TRIM(final_category) AS c FROM transactions WHERE ${txnWhere}`,
      { replacements, type: QueryTypes.SELECT },
    ),
  ]);
  const set = new Set<string>();
  for (const r of a) if (r.c) set.add(r.c);
  for (const r of b) if (r.c) set.add(r.c);
  return Array.from(set).sort((x, y) => x.localeCompare(y));
}

export type AiSuggestion = {
  category: string | null;
  business: boolean | null;
  splitType: 'me' | 'partner' | 'shared' | null;
  pctMe: number | null;
  pctPartner: number | null;
  notes: string | null;
  rationale: string | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  needsReview: boolean;
};

export function parseSuggestion(j: Record<string, unknown>): AiSuggestion {
  const category =
    typeof j.category === 'string' && j.category.trim()
      ? j.category.trim()
      : null;
  let business: boolean | null = null;
  if (typeof j.business === 'boolean') business = j.business;
  else if (j.business === 'true') business = true;
  else if (j.business === 'false') business = false;

  let splitType: AiSuggestion['splitType'] = null;
  if (j.splitType === 'me' || j.splitType === 'partner' || j.splitType === 'shared') {
    splitType = j.splitType;
  }

  const pctMe =
    typeof j.pctMe === 'number' && Number.isFinite(j.pctMe)
      ? j.pctMe
      : typeof j.pctMe === 'string' && j.pctMe.trim()
        ? Number(j.pctMe)
        : null;
  const pctPartner =
    typeof j.pctPartner === 'number' && Number.isFinite(j.pctPartner)
      ? j.pctPartner
      : typeof j.pctPartner === 'string' && j.pctPartner.trim()
        ? Number(j.pctPartner)
        : null;

  const notes =
    typeof j.notes === 'string' && j.notes.trim() ? j.notes.trim() : null;
  const rationale =
    typeof j.rationale === 'string' && j.rationale.trim()
      ? j.rationale.trim()
      : null;
  const confidence =
    j.confidence === 'high' || j.confidence === 'medium' || j.confidence === 'low'
      ? j.confidence
      : 'medium';
  const evidence = Array.isArray(j.evidence)
    ? j.evidence
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim().slice(0, 80))
        .slice(0, 8)
    : [];
  const needsReview =
    typeof j.needsReview === 'boolean' ? j.needsReview : confidence !== 'high';

  return {
    category,
    business,
    splitType,
    pctMe: pctMe != null && Number.isFinite(pctMe) ? pctMe : null,
    pctPartner:
      pctPartner != null && Number.isFinite(pctPartner) ? pctPartner : null,
    notes,
    rationale,
    confidence,
    evidence,
    needsReview,
  };
}

function clampPct(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

function normalizeForSimilarity(s: string | null | undefined): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type TransactionSuggestionContext = {
  transaction: {
    id: number;
    date: string;
    merchantClean: string;
    merchantRaw: string;
    amount: number | null;
    currency: string;
    autoCategory: string | null;
    finalCategory: string | null;
    finalBusiness: boolean;
    notes: string | null;
  };
  categoryHints: string[];
  matchingRule: null | {
    id: number;
    merchantPattern: string;
    category: string | null;
    isBusiness: boolean;
    splitType: string;
    pctMe: string | null;
    pctPartner: string | null;
  };
  merchantMemory: MerchantMemoryMatch | null;
  similarTransactions: Array<{
    id: number;
    date: string;
    merchantClean: string;
    amount: number | null;
    currency: string;
    finalCategory: string | null;
    finalBusiness: boolean;
    finalSplitType: string;
    finalPctMe: number | null;
    finalPctPartner: number | null;
  }>;
  receiptExtracts: Array<{
    receiptId: number;
    merchant: string | null;
    total: number | null;
    currency: string | null;
    date: string | null;
    summary: string | null;
  }>;
};

export async function buildTransactionSuggestionContext(
  txn: TxnModel,
  hints: string[],
): Promise<TransactionSuggestionContext> {
  const householdId = txn.householdId;
  const targetMerchant = normalizeForSimilarity(txn.merchantClean || txn.merchantRaw);
  const [rules, priorRows, receipts, merchantMemory] = await Promise.all([
    loadAllRules(householdId),
    sequelize.query<{
      id: number;
      date: string;
      merchantClean: string;
      amount: unknown;
      currency: string;
      finalCategory: string | null;
      finalBusiness: boolean;
      finalSplitType: string;
      finalPctMe: unknown;
      finalPctPartner: unknown;
    }>(
      `SELECT id, date, merchant_clean AS "merchantClean", amount, currency,
              final_category AS "finalCategory", final_business AS "finalBusiness",
              final_split_type AS "finalSplitType", final_pct_me AS "finalPctMe",
              final_pct_partner AS "finalPctPartner"
       FROM transactions
       WHERE id != ?
         AND (? IS NULL OR household_id = ?)
         AND reviewed_at IS NOT NULL
         AND final_category IS NOT NULL
       ORDER BY date DESC
       LIMIT 200`,
      { replacements: [txn.id, householdId, householdId], type: QueryTypes.SELECT },
    ),
    sequelize.query<Pick<Receipt, 'id' | 'extractedNote'>>(
      `SELECT id, extracted_note AS "extractedNote"
       FROM receipts
       WHERE transaction_id = ?
       ORDER BY created_at DESC
       LIMIT 5`,
      { replacements: [txn.id], type: QueryTypes.SELECT },
    ),
    findMerchantMemory(householdId, txn.merchantClean),
  ]);
  const matching = findBestRule(rules, txn.merchantClean);
  const similarTransactions = priorRows
    .map((row) => {
      const merchant = normalizeForSimilarity(row.merchantClean);
      const sameMerchant = merchant && targetMerchant && merchant === targetMerchant;
      const contains =
        merchant && targetMerchant
          ? merchant.includes(targetMerchant) || targetMerchant.includes(merchant)
          : false;
      const score = sameMerchant ? 3 : contains ? 2 : merchant.split(' ')[0] === targetMerchant.split(' ')[0] ? 1 : 0;
      return { row, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.row.date.localeCompare(a.row.date))
    .slice(0, 10)
    .map(({ row }) => ({
      id: row.id,
      date: row.date,
      merchantClean: row.merchantClean,
      amount: num(row.amount),
      currency: row.currency,
      finalCategory: row.finalCategory,
      finalBusiness: Boolean(row.finalBusiness),
      finalSplitType: row.finalSplitType,
      finalPctMe: num(row.finalPctMe),
      finalPctPartner: num(row.finalPctPartner),
    }));
  const receiptExtracts = receipts
    .map((r) => {
      try {
        const j = r.extractedNote ? (JSON.parse(String(r.extractedNote)) as Record<string, unknown>) : {};
        return {
          receiptId: r.id,
          merchant: typeof j.merchant === 'string' ? j.merchant : null,
          total: num(j.total),
          currency: typeof j.currency === 'string' ? j.currency : null,
          date: typeof j.date === 'string' ? j.date : null,
          summary: typeof j.summary === 'string' ? j.summary : null,
        };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null);
  return {
    transaction: {
      id: txn.id,
      date: txn.date,
      merchantClean: txn.merchantClean,
      merchantRaw: txn.merchantRaw,
      amount: num(txn.amount),
      currency: txn.currency,
      autoCategory: txn.autoCategory,
      finalCategory: txn.finalCategory,
      finalBusiness: txn.finalBusiness,
      notes: txn.notes,
    },
    categoryHints: hints,
    matchingRule: matching.rule
      ? {
          id: matching.rule.id,
          merchantPattern: matching.rule.merchantPattern,
          category: matching.rule.category,
          isBusiness: matching.rule.isBusiness,
          splitType: matching.rule.splitType,
          pctMe: matching.rule.pctMe,
          pctPartner: matching.rule.pctPartner,
        }
      : null,
    merchantMemory,
    similarTransactions,
    receiptExtracts,
  };
}

export async function suggestTransactionFields(
  txn: TxnModel,
  hints: string[],
): Promise<AiSuggestion> {
  const categories = hints.length ? hints.join(', ') : '(none yet — invent short labels)';

  const user = [
    `Categorize this card transaction for a household expense tracker.`,
    ``,
    `Date: ${txn.date}`,
    `Merchant (clean): ${txn.merchantClean}`,
    `Merchant (raw): ${txn.merchantRaw}`,
    `Amount: ${num(txn.amount)} ${txn.currency}`,
    `Current auto category: ${txn.autoCategory ?? 'null'}`,
    `Current final category: ${txn.finalCategory ?? 'null'}`,
    `Notes: ${txn.notes ?? ''}`,
    ``,
    `Known category labels already used in this database (prefer reusing when it fits): ${categories}`,
    ``,
    `Return ONLY a JSON object with keys: category (string or null), business (boolean), splitType ("me"|"partner"|"shared"), pctMe (number 0-1 or null), pctPartner (number 0-1 or null), notes (string or null), rationale (one short sentence).`,
    `For typical personal spending, business is usually false. Use split "shared" with pctMe 0.5 only when it is clearly shared household spend.`,
  ].join('\n');

  const j = await openaiJson([
    {
      role: 'system',
      content:
        'You output compact JSON only. Be practical with merchant names; map cafes to Groceries or Dining as appropriate.',
    },
    { role: 'user', content: user },
  ]);

  return parseSuggestion(j);
}

export async function suggestTransactionFieldsTracked(
  txn: TxnModel,
  hints: string[],
): Promise<{
  suggestion: AiSuggestion;
  inputSnapshot: TransactionSuggestionContext;
  meta: OpenAiJsonResult;
  promptVersion: string;
}> {
  const context = await buildTransactionSuggestionContext(txn, hints);
  const categories = hints.length ? hints.join(', ') : '(none yet; invent short labels)';
  const user = [
    `Categorize this card transaction for a household expense tracker.`,
    ``,
    `Transaction JSON: ${JSON.stringify(context.transaction)}`,
    `Known category labels already used in this database: ${categories}`,
    `Matching deterministic rule, if any: ${JSON.stringify(context.matchingRule)}`,
    `Merchant memory, if any: ${JSON.stringify(context.merchantMemory)}`,
    `Similar reviewed transactions: ${JSON.stringify(context.similarTransactions)}`,
    `Receipt extracts: ${JSON.stringify(context.receiptExtracts)}`,
    ``,
    `Return ONLY a JSON object with keys: category (string or null), business (boolean), splitType ("me"|"partner"|"shared"), pctMe (number 0-1 or null), pctPartner (number 0-1 or null), notes (string or null), confidence ("high"|"medium"|"low"), evidence (string array), needsReview (boolean), rationale (one short sentence).`,
    `Use existing categories when they fit. Existing deterministic rules are strongest evidence. Mark confidence low if guessing from merchant name only.`,
  ].join('\n');
  const meta = await openaiJsonWithMeta([
    {
      role: 'system',
      content:
        'You output compact JSON only. Be practical with merchant names and do not invent financial totals.',
    },
    { role: 'user', content: user },
  ]);
  const suggestion = parseSuggestion(meta.json);
  suggestion.pctMe = clampPct(suggestion.pctMe);
  suggestion.pctPartner = clampPct(suggestion.pctPartner);
  return {
    suggestion,
    inputSnapshot: context,
    meta,
    promptVersion: TRANSACTION_SUGGESTION_PROMPT_VERSION,
  };
}
