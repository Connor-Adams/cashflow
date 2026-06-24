import { Op, type Transaction as DbTransaction } from 'sequelize';
import { ExternalOrder, Transaction, TransactionOrderLink } from '../models';
import { decideAutoAccept } from './autoAccept';
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from '../import/enrichment/recomputeTransactionReviewFromItems';

export function isAmazonLikeMerchant(merchant: string): boolean {
  return /\b(amazon(?:\.ca)?|amzn|amzn\s*mktp|amazon marketplace|prime)\b/i.test(merchant);
}

function daysBetween(a: string, b: string): number {
  const one = new Date(`${a}T00:00:00Z`).getTime();
  const two = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((one - two) / 86400000);
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function last4FromText(text: string | null | undefined): string | null {
  return String(text || '').match(/\b(\d{4})\b/)?.[1] ?? null;
}

export type MatchScore = {
  confidence: number;
  matchReason: string;
  /**
   * Secondary score computed from unambiguous-identity signals only
   * (date proximity + payment last4 match). Used by selectMatchCandidates to
   * break a sub-threshold tie without reintroducing fan-out.
   */
  secondaryScore: number;
};

/** A candidate is auto-suggested only at or above this confidence. */
export const MATCH_CONFIDENCE_THRESHOLD = 70;

/**
 * When nothing clears the threshold, a single best candidate may still be
 * surfaced for review — but only if it reaches this floor. Below it (e.g. a
 * merchant-only confidence of 15) the match is noise, not a suggestion.
 */
export const FALLBACK_MIN_CONFIDENCE = 50;

/**
 * Pick which scored orders become suggested links for one transaction.
 *
 * - Every candidate at/above {@link MATCH_CONFIDENCE_THRESHOLD} is returned
 *   (a transaction can legitimately span multiple confident orders).
 * - Otherwise fall back to AT MOST the single best candidate, and only when it
 *   is unambiguous (no tie at the top score) and clears
 *   {@link FALLBACK_MIN_CONFIDENCE}.
 *
 * The tie guard is the fix for the historical fan-out: the previous filter
 * `confidence === best` linked the transaction to EVERY order tied at the best
 * sub-threshold score, so one charge whose amount collided with many stale
 * Amazon orders (each scoring 50) produced a link to all of them.
 */
export function selectMatchCandidates<T extends { confidence: number; secondary?: number }>(scored: T[]): T[] {
  const strong = scored.filter((candidate) => candidate.confidence >= MATCH_CONFIDENCE_THRESHOLD);
  if (strong.length > 0) return strong;

  const sorted = [...scored].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (!best || best.confidence < FALLBACK_MIN_CONFIDENCE) return [];
  const tiedAtBest = sorted.filter((candidate) => candidate.confidence === best.confidence);
  if (tiedAtBest.length > 1) {
    // Attempt a secondary tiebreak on unambiguous-identity signals (date + last4).
    // Only resolve the tie when exactly ONE candidate strictly leads on secondary.
    const withSecondary = tiedAtBest.filter((c) => c.secondary != null);
    if (withSecondary.length > 0) {
      const bestSecondary = Math.max(...tiedAtBest.map((c) => c.secondary ?? 0));
      const leadersOnSecondary = tiedAtBest.filter((c) => (c.secondary ?? 0) === bestSecondary);
      if (leadersOnSecondary.length === 1 && bestSecondary > 0) {
        return [leadersOnSecondary[0]];
      }
    }
    return []; // still ambiguous — abstain rather than guess
  }
  return [best];
}

export function scoreAmazonOrderMatch(txn: Transaction, order: ExternalOrder): MatchScore {
  let score = 0;
  let secondary = 0;
  const reasons: string[] = [];
  const txnAmount = Math.abs(Number(txn.amount));
  const orderTotal = numberOrNull(order.total);
  if (orderTotal != null) {
    const diff = Math.abs(txnAmount - Math.abs(orderTotal));
    if (diff <= 0.5) {
      score += 50;
      reasons.push(`amount within $0.50 (${diff.toFixed(2)})`);
    } else if (diff <= 2) {
      score += 35;
      reasons.push(`amount within $2.00 (${diff.toFixed(2)})`);
    } else {
      score -= 25;
      reasons.push(`total mismatch over $2.00 (${diff.toFixed(2)})`);
    }
  }

  const orderDate = order.shipmentDate || order.orderDate;
  if (orderDate) {
    const gap = daysBetween(txn.date, orderDate);
    if (gap >= 0 && gap <= 5) {
      score += 25;
      secondary += 25;
      reasons.push(`order/shipment date ${gap} day(s) before transaction`);
    } else if (Math.abs(gap) > 10) {
      score -= 15;
      reasons.push(`date gap over 10 days (${Math.abs(gap)} days)`);
    }
  }

  if (isAmazonLikeMerchant(`${txn.merchantRaw} ${txn.merchantClean}`)) {
    score += 15;
    reasons.push('merchant indicates Amazon');
  }

  const txnLast4 = last4FromText(`${txn.notes || ''} ${txn.sourceReference || ''}`);
  if (txnLast4 && order.paymentLast4 && txnLast4 === order.paymentLast4) {
    score += 20;
    secondary += 20;
    reasons.push('payment last4 matches');
  }

  return {
    confidence: Math.max(0, Math.min(100, score)),
    matchReason: reasons.join('; ') || 'candidate Amazon order',
    secondaryScore: secondary,
  };
}

/**
 * Create — or refresh — a link between a transaction and an external order.
 * Idempotent: an existing link for the same (transaction, order) pair is never
 * duplicated, and a link the user has already accepted or rejected is left
 * untouched — only a still-'suggested' row gets its score/reason refreshed.
 * Pass `autoAccept: true` to promote a newly-created (or still-suggested) row
 * to 'accepted' immediately.
 * Pass `transaction` to enlist the write in a surrounding DB transaction.
 * Returns `{ created, accepted }`.
 */
export async function upsertSuggestedOrderLink(args: {
  transactionId: number;
  externalOrderId: number;
  confidence: number;
  matchReason: string;
  autoAccept?: boolean;
  transaction?: DbTransaction;
}): Promise<{ created: boolean; accepted: boolean }> {
  const { transactionId, externalOrderId, confidence, matchReason, autoAccept, transaction } = args;
  const status = autoAccept ? 'accepted' : 'suggested';
  const [link, created] = await TransactionOrderLink.findOrCreate({
    where: { transactionId, externalOrderId },
    defaults: {
      transactionId,
      externalOrderId,
      confidence: String(confidence),
      matchReason,
      status,
    },
    transaction,
  });
  // Capture whether this pre-existing row was still pending (not yet acted on)
  // BEFORE any update so we know if THIS call promoted it.
  const wasSuggested = !created && link.status === 'suggested';
  if (wasSuggested) {
    // Refresh score/reason; promote to accepted if this run qualifies. Never
    // touch an already-accepted or user-rejected row.
    await link.update(
      { confidence: String(confidence), matchReason, ...(autoAccept ? { status: 'accepted' as const } : {}) },
      { transaction },
    );
  }
  // `accepted` means NEWLY accepted by THIS call — not the row's current status.
  // A newly-created row is accepted iff it was created with status 'accepted'.
  // A pre-existing row is newly-accepted iff it was suggested and autoAccept promoted it.
  // An already-accepted or rejected row is never newly accepted here.
  const newlyAccepted = created ? autoAccept === true : wasSuggested && autoAccept === true;
  return { created, accepted: newlyAccepted };
}

export async function runAmazonMatching(args: {
  householdId: number;
}): Promise<{
  suggested: number;
  autoAccepted: number;
  scannedTransactions: number;
  /** Earliest txn date that received a newly-suggested link, or null if none. */
  matchedDateFrom: string | null;
  /** Latest txn date that received a newly-suggested link, or null if none. */
  matchedDateTo: string | null;
}> {
  const txns = await Transaction.findAll({
    where: {
      householdId: args.householdId,
      [Op.or]: [
        { merchantRaw: { [Op.like]: '%AMAZON%' } },
        { merchantRaw: { [Op.like]: '%Amazon%' } },
        { merchantRaw: { [Op.like]: '%AMZN%' } },
        { merchantRaw: { [Op.like]: '%Prime%' } },
        { merchantClean: { [Op.like]: '%AMAZON%' } },
        { merchantClean: { [Op.like]: '%Amazon%' } },
        { merchantClean: { [Op.like]: '%AMZN%' } },
        { merchantClean: { [Op.like]: '%Prime%' } },
      ],
    },
    order: [['date', 'DESC']],
  });
  const orders = await ExternalOrder.findAll({
    where: { householdId: args.householdId, vendor: 'amazon' },
  });
  let suggested = 0;
  let autoAccepted = 0;
  const acceptedOrderIds = new Set<number>();
  let matchedDateFrom: string | null = null;
  let matchedDateTo: string | null = null;

  for (const txn of txns.filter((row) => isAmazonLikeMerchant(`${row.merchantRaw} ${row.merchantClean}`))) {
    const scores = orders.map((order) => {
      const { confidence, matchReason, secondaryScore } = scoreAmazonOrderMatch(txn, order);
      return { order, confidence, matchReason, secondary: secondaryScore };
    });
    const candidates = selectMatchCandidates(scores);
    // Per-transaction auto-accept: only when there is a single candidate and it
    // is unambiguous + ≥ threshold. A transaction spanning multiple confident
    // orders is never auto-accepted (genuinely ambiguous which order it is).
    const sortedConf = candidates.map((c) => c.confidence).sort((a, b) => b - a);
    const auto = candidates.length === 1 && decideAutoAccept(sortedConf);
    for (const candidate of candidates) {
      const { created, accepted } = await upsertSuggestedOrderLink({
        transactionId: txn.id,
        externalOrderId: candidate.order.id,
        confidence: candidate.confidence,
        matchReason: candidate.matchReason,
        autoAccept: auto,
      });
      if (created) {
        suggested += 1;
        if (matchedDateFrom == null || txn.date < matchedDateFrom) matchedDateFrom = txn.date;
        if (matchedDateTo == null || txn.date > matchedDateTo) matchedDateTo = txn.date;
      }
      if (auto && accepted) {
        autoAccepted += 1;
        acceptedOrderIds.add(candidate.order.id);
      }
    }
  }

  // Mirror the manual-accept side effect (routes/amazon.ts /links/:id/accept):
  // accepted item links can clear the transaction's review flag.
  for (const orderId of acceptedOrderIds) {
    await recomputeTransactionsReviewFromItems(await transactionIdsForOrder(orderId));
  }

  return { suggested, autoAccepted, scannedTransactions: txns.length, matchedDateFrom, matchedDateTo };
}
