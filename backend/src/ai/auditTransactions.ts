import type { Transaction as TxnModel } from '../models/Transaction';
import { openaiJsonWithMeta, type OpenAiJsonResult } from './openaiJson';
import {
  buildTransactionSuggestionContext,
  type TransactionSuggestionContext,
} from './suggestTransaction';

export const TRANSACTION_AUDIT_PROMPT_VERSION = 'transaction-audit-v1';

export type TransactionAuditIssueType =
  | 'category_mismatch'
  | 'business_flag_mismatch'
  | 'both'
  | 'uncertain';

export type TransactionAuditIssue = {
  id: number;
  issueType: TransactionAuditIssueType;
  currentCategory: string | null;
  suggestedCategory: string | null;
  currentBusiness: boolean | null;
  suggestedBusiness: boolean | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  rationale: string | null;
};

function nullableString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function nullableBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function parseIssue(raw: unknown): TransactionAuditIssue | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = Number(row.id);
  if (!Number.isInteger(id) || id < 1) return null;
  const issueType =
    row.issueType === 'category_mismatch' ||
    row.issueType === 'business_flag_mismatch' ||
    row.issueType === 'both' ||
    row.issueType === 'uncertain'
      ? row.issueType
      : 'uncertain';
  const confidence =
    row.confidence === 'high' || row.confidence === 'medium' || row.confidence === 'low'
      ? row.confidence
      : 'medium';
  const evidence = Array.isArray(row.evidence)
    ? row.evidence
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim().slice(0, 120))
        .slice(0, 8)
    : [];
  return {
    id,
    issueType,
    currentCategory: nullableString(row.currentCategory),
    suggestedCategory: nullableString(row.suggestedCategory),
    currentBusiness: nullableBoolean(row.currentBusiness),
    suggestedBusiness: nullableBoolean(row.suggestedBusiness),
    confidence,
    evidence,
    rationale: nullableString(row.rationale),
  };
}

export function parseTransactionAuditIssues(j: Record<string, unknown>): TransactionAuditIssue[] {
  const rawIssues = Array.isArray(j.issues) ? j.issues : [];
  return rawIssues.map(parseIssue).filter((row): row is TransactionAuditIssue => row != null);
}

function compactContext(context: TransactionSuggestionContext): Record<string, unknown> {
  return {
    transaction: {
      id: context.transaction.id,
      date: context.transaction.date,
      merchantClean: context.transaction.merchantClean,
      merchantRaw: context.transaction.merchantRaw,
      amount: context.transaction.amount,
      currency: context.transaction.currency,
      currentCategory: context.transaction.finalCategory,
      currentBusiness: context.transaction.finalBusiness,
      autoCategory: context.transaction.autoCategory,
    },
    matchingRule: context.matchingRule,
    merchantMemory: context.merchantMemory,
    similarTransactions: context.similarTransactions.slice(0, 6),
    receiptExtracts: context.receiptExtracts,
  };
}

export async function auditTransactionsForMislabels(
  txns: TxnModel[],
  categoryHints: string[],
): Promise<{
  issues: TransactionAuditIssue[];
  inputSnapshot: Record<string, unknown>;
  meta: OpenAiJsonResult;
  promptVersion: string;
}> {
  const contexts = await Promise.all(
    txns.map((txn) => buildTransactionSuggestionContext(txn, categoryHints)),
  );
  const inputSnapshot = {
    categoryHints,
    transactions: contexts.map(compactContext),
  };
  const categories = categoryHints.length
    ? categoryHints.join(', ')
    : '(none yet; use concise labels)';
  const user = [
    `Audit these household finance transactions for likely mislabeled categories or wrong business flags.`,
    `Only flag rows where the current final category or final business flag appears inconsistent with the merchant, deterministic rule, merchant memory, similar reviewed transactions, or receipts.`,
    `Do not flag low-information rows just because another category is possible.`,
    ``,
    `Known category labels: ${categories}`,
    `Audit input JSON: ${JSON.stringify(inputSnapshot)}`,
    ``,
    `Return ONLY JSON with key "issues", an array of objects with keys: id, issueType ("category_mismatch"|"business_flag_mismatch"|"both"|"uncertain"), currentCategory (string|null), suggestedCategory (string|null), currentBusiness (boolean|null), suggestedBusiness (boolean|null), confidence ("high"|"medium"|"low"), evidence (string array), rationale (one short sentence).`,
    `Use issueType "both" when both category and business flag look wrong. Use "uncertain" only when it should be reviewed but there is not enough evidence to suggest exact replacement fields.`,
  ].join('\n');
  const meta = await openaiJsonWithMeta(
    [
      {
        role: 'system',
        content:
          'You output compact JSON only. Be conservative: false positives waste review time.',
      },
      { role: 'user', content: user },
    ],
    { temperature: 0.1, maxTokens: 1800 },
  );
  return {
    issues: parseTransactionAuditIssues(meta.json),
    inputSnapshot,
    meta,
    promptVersion: TRANSACTION_AUDIT_PROMPT_VERSION,
  };
}
