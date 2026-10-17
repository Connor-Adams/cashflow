/**
 * AI finance review runner (issue #210).
 *
 * Builds a list of action items for a date window by combining
 * deterministic signals from existing engines:
 *
 * - Anomalies / category deltas / uncategorized backlog → `loadOpenInsightItems`
 *   (open `Insight` rows from the real detectors, same source the CFO
 *   briefing reads — see `../cfo/briefingBuilder`). Missing receipts arrive
 *   this way too: `detectMissingReceipt` persists them as Insight rows, so
 *   there is deliberately no inline missing-receipt scan here — one existed
 *   and double-surfaced every receipt-less charge alongside its Insight.
 * - Rule suggestions                                    → `findRuleProposals`
 * - Subscription candidates                             → direct query
 * - Forecast warnings (overdue planned events)          → direct query
 *
 * Everything works without OpenAI — that's the AC's "degrade gracefully"
 * requirement. When OpenAI IS configured, callers can layer an optional
 * summary string from `summarizeReviewWithOpenAi` but the action items
 * themselves are always deterministic so review history is reproducible.
 *
 * Kept HTTP-agnostic so it composes with unit tests and any future
 * background job runner.
 */

import { Op } from 'sequelize';
import type { Request } from 'express';
import { Transaction } from '../models';
import { visibleTransactionWhere } from '../auth/scope';
import { loadOpenInsightItems } from '../cfo/briefingBuilder';
import {
  loadOverduePlannedEvents,
  buildOverdueEventItemContent,
  buildRuleSuggestionItemContent,
} from '../cfo/reviewActionItemShared';
import { findRuleProposals } from './ruleProposals';
import { num } from '../util/numbers';
import type {
  AiReviewActionItem,
  AiReviewActionItemRefType,
  AiReviewActionItemType,
} from '../models/AiReviewRun';
import type { CfoBriefingActionItem } from '../models/CfoBriefing';

export const AI_REVIEW_PROMPT_VERSION = 'ai-review-v1';

/** Minimum count of similar charges to consider a merchant a subscription. */
const SUBSCRIPTION_MIN_HITS = 3;

/** Tolerance % on amount when grouping subscription candidates. */
const SUBSCRIPTION_AMOUNT_TOLERANCE = 0.1;

export interface BuildReviewActionItemsParams {
  req: Request;
  householdId: number;
  periodStart: string;
  periodEnd: string;
  currency: string;
}

export interface BuildReviewActionItemsResult {
  actionItems: AiReviewActionItem[];
  summary: string;
}

function idFor(type: AiReviewActionItemType, suffix: string | number): string {
  return `${type}-${suffix}`;
}

const CFO_STATUS_TO_REVIEW_STATUS: Record<
  CfoBriefingActionItem['status'],
  AiReviewActionItem['status']
> = {
  open: 'suggested',
  resolved: 'accepted',
  dismissed: 'dismissed',
};

const REVIEW_REF_TYPES = new Set<string>(['transaction', 'event', 'rule']);

function reviewRefTypeFrom(refType: CfoBriefingActionItem['refType']): AiReviewActionItemRefType {
  return refType != null && REVIEW_REF_TYPES.has(refType) ? (refType as AiReviewActionItemRefType) : null;
}

const REVIEW_ITEM_TYPES = new Set<string>([
  'anomaly',
  'rule_suggestion',
  'missing_receipt',
  'subscription',
  'forecast_warning',
  'other',
]);

function reviewTypeFrom(type: CfoBriefingActionItem['type']): AiReviewActionItemType {
  return REVIEW_ITEM_TYPES.has(type) ? (type as AiReviewActionItemType) : 'other';
}

/**
 * `loadOpenInsightItems` (Task 5) returns `CfoBriefingActionItem`s — the CFO
 * briefing's shape, produced by `insightToActionItem`. That shape overlaps
 * with `AiReviewActionItem` field-for-field but is NOT interchangeable:
 * status vocabularies differ ('open'|'resolved'|'dismissed' vs
 * 'suggested'|'accepted'|'dismissed'), and `type`/`refType` are each closed
 * unions that don't fully align (e.g. `CfoBriefingActionItemRefType` allows
 * 'subscription'/'import', which `AiReviewActionItemRefType` doesn't; CFO
 * `type` allows values like 'safe_to_spend_low' that the review vocabulary
 * doesn't have). Remap explicitly field-by-field rather than casting.
 */
export function insightItemToReviewItem(item: CfoBriefingActionItem): AiReviewActionItem {
  const refType = reviewRefTypeFrom(item.refType);
  return {
    id: item.id,
    type: reviewTypeFrom(item.type),
    refType,
    refId: refType == null ? null : item.refId,
    severity: item.severity,
    title: item.title,
    summary: item.summary,
    status: CFO_STATUS_TO_REVIEW_STATUS[item.status],
    supportingTransactionIds: item.supportingTransactionIds,
    rationale: item.rationale,
  };
}

/** Slots: [anomalies, rule suggestions, subscriptions, forecast warnings].
 *  There is no missing-receipt slot: those now arrive as Insight rows and are
 *  counted under `anomaly`. */
function shortSummary(parts: number[]): string {
  const total = parts.reduce((a, b) => a + b, 0);
  if (total === 0) return 'No action items — nothing flagged for this period.';
  const labels: string[] = [];
  if (parts[0] > 0) labels.push(`${parts[0]} anomaly${parts[0] === 1 ? '' : 'ies'}`);
  if (parts[1] > 0) labels.push(`${parts[1]} rule suggestion${parts[1] === 1 ? '' : 's'}`);
  if (parts[2] > 0) labels.push(`${parts[2]} subscription${parts[2] === 1 ? '' : 's'}`);
  if (parts[3] > 0) labels.push(`${parts[3]} forecast warning${parts[3] === 1 ? '' : 's'}`);
  return `${total} action item${total === 1 ? '' : 's'}: ${labels.join(', ')}.`;
}

export async function buildReviewActionItems(
  params: BuildReviewActionItemsParams,
): Promise<BuildReviewActionItemsResult> {
  const { req, householdId, periodStart, periodEnd, currency } = params;

  // Run independent sub-queries in parallel.
  const [insightItems, ruleProposals, txnsInWindow, plannedEventsOverdue] =
    await Promise.all([
      loadOpenInsightItems(req, householdId),
      findRuleProposals(householdId),
      Transaction.findAll({
        where: {
          ...visibleTransactionWhere(req),
          currency,
          date: { [Op.between]: [periodStart, periodEnd] },
        },
        attributes: ['id', 'date', 'merchantClean', 'amount'],
      }),
      loadOverduePlannedEvents(householdId, periodEnd),
    ]);

  const items: AiReviewActionItem[] = [];

  // Anomalies / categorical insights → action items, sourced from the real
  // Insight detectors (same source the CFO briefing reads) rather than the
  // old prompt-free, now-deleted six-template insight engine.
  for (const insightItem of insightItems) {
    items.push(insightItemToReviewItem(insightItem));
  }

  // Rule suggestions.
  for (const proposal of ruleProposals) {
    const content = buildRuleSuggestionItemContent(
      proposal,
      `Create rule for "${proposal.merchantPattern}"`,
    );
    items.push({ ...content, type: 'rule_suggestion', status: 'suggested' });
  }

  // Subscription detection: merchants with N+ near-identical negative
  // amounts in the window. Cheap heuristic; OpenAI not needed.
  type TxnRow = {
    id: number;
    date: string;
    merchantClean: string | null;
    amount: unknown;
  };
  const merchantBuckets = new Map<string, Array<{ id: number; amount: number }>>();
  for (const raw of txnsInWindow) {
    const txn = raw.toJSON() as TxnRow;
    const amount = num(txn.amount);
    if (amount == null || amount >= 0) continue;
    const merchant = txn.merchantClean?.trim();
    if (!merchant) continue;
    const bucket = merchantBuckets.get(merchant) ?? [];
    bucket.push({ id: txn.id, amount: Math.abs(amount) });
    merchantBuckets.set(merchant, bucket);
  }
  for (const [merchant, bucket] of merchantBuckets.entries()) {
    if (bucket.length < SUBSCRIPTION_MIN_HITS) continue;
    const median = bucket.slice().sort((a, b) => a.amount - b.amount)[
      Math.floor(bucket.length / 2)
    ].amount;
    if (median <= 0) continue;
    const tight = bucket.filter(
      (b) => Math.abs(b.amount - median) / median <= SUBSCRIPTION_AMOUNT_TOLERANCE,
    );
    if (tight.length < SUBSCRIPTION_MIN_HITS) continue;
    items.push({
      id: idFor('subscription', merchant),
      type: 'subscription',
      refType: null,
      refId: null,
      severity: 'info',
      title: `Recurring charge: ${merchant}`,
      summary: `${tight.length} charges near ${median.toFixed(2)} ${currency} from ${merchant} in this period.`,
      status: 'suggested',
      supportingTransactionIds: tight.map((b) => b.id).slice(0, 10),
      rationale: 'Detected by repeated near-identical amounts from the same merchant.',
    });
  }

  // Forecast warnings: planned events that should have posted but haven't.
  for (const raw of plannedEventsOverdue) {
    const content = buildOverdueEventItemContent(raw, currency);
    items.push({ ...content, type: 'forecast_warning', status: 'suggested' });
  }

  const counts = [0, 0, 0, 0];
  for (const item of items) {
    if (item.type === 'anomaly') counts[0] += 1;
    else if (item.type === 'rule_suggestion') counts[1] += 1;
    else if (item.type === 'subscription') counts[2] += 1;
    else if (item.type === 'forecast_warning') counts[3] += 1;
  }

  return {
    actionItems: items,
    summary: shortSummary(counts),
  };
}
