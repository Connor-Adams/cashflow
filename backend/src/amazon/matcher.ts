import { Op, type Transaction as DbTransaction } from 'sequelize';
import { Account, ExternalOrder, Transaction, TransactionOrderLink } from '../models';
import { decideAutoAccept } from './autoAccept';
import { backfillAutoAcceptAmazonLinks } from './backfillAutoAcceptLinks';
import { resolveAccountLast4 } from './cardOwnership';
import { mergeDuplicateAmazonOrders } from './mergeDuplicateOrders';
import { isAmazonLikeMerchant, isAmazonSubscriptionCharge } from './merchant';
import {
  recomputeTransactionsReviewFromItems,
  transactionIdsForOrder,
} from '../import/enrichment/recomputeTransactionReviewFromItems';

// Re-exported for existing external callers (e.g. routes/amazon.ts) that import
// isAmazonLikeMerchant from this module; the canonical definition lives in
// ./merchant to avoid a circular dependency with backfillAutoAcceptLinks.ts.
// isAmazonSubscriptionCharge has no external callers, so it is not re-exported.
export { isAmazonLikeMerchant };

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
 * Resolve a set of candidates tied at the same confidence using the
 * unambiguous-identity secondary score (exact-cent amount, date proximity,
 * last4). Returns the sole leader, or [] when the tie is unresolvable —
 * abstaining rather than guessing.
 */
function resolveTie<T extends { confidence: number; secondary?: number }>(tied: T[]): T[] {
  if (tied.length <= 1) return tied;
  const bestSecondary = Math.max(...tied.map((c) => c.secondary ?? 0));
  if (bestSecondary > 0) {
    const leaders = tied.filter((c) => (c.secondary ?? 0) === bestSecondary);
    if (leaders.length === 1) return leaders;
  }
  return [];
}

/**
 * Pick which scored orders become suggested links for one transaction.
 *
 * - Every candidate at/above {@link MATCH_CONFIDENCE_THRESHOLD} is returned
 *   (a transaction can legitimately span multiple confident orders) — unless
 *   the top strong score is itself a tie, in which case it is resolved via
 *   {@link resolveTie} rather than fanning out.
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
  if (strong.length > 0) {
    // The strong tier intentionally returns MULTIPLE candidates — one charge can
    // legitimately span several orders. But once the account-derived last4 bonus
    // exists, two exact-cent orders on the same card both reach 85 and tie, and
    // returning both is the historical fan-out. Guard the top tie only: a tie is
    // resolved on secondary, or abstained on. Strictly-lower strong candidates
    // are untouched, preserving genuine multi-order behaviour.
    const sortedStrong = [...strong].sort((a, b) => b.confidence - a.confidence);
    const topScore = sortedStrong[0].confidence;
    const tiedAtTop = sortedStrong.filter((c) => c.confidence === topScore);
    if (tiedAtTop.length > 1) {
      const resolved = resolveTie(tiedAtTop);
      if (resolved.length === 0) return [];
      return [...resolved, ...sortedStrong.filter((c) => c.confidence < topScore)];
    }
    return strong;
  }

  const sorted = [...scored].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (!best || best.confidence < FALLBACK_MIN_CONFIDENCE) return [];
  const tiedAtBest = sorted.filter((candidate) => candidate.confidence === best.confidence);
  if (tiedAtBest.length > 1) return resolveTie(tiedAtBest);
  return [best];
}

/**
 * Whether the top confidence tier (strong if any candidate clears
 * {@link MATCH_CONFIDENCE_THRESHOLD}, else the fallback tier) had more than
 * one candidate tied at the top score — i.e. {@link selectMatchCandidates}
 * had to consult {@link resolveTie} to pick a winner.
 *
 * This matters because a resolved tie collapses to a single candidate (the
 * winner, plus only strictly-lower ones) exactly like a genuine lone match
 * would. A caller deciding whether to auto-accept off `candidates.length`
 * cannot tell the two apart from the selection alone — an ambiguous pair
 * that happened to have a secondary-score tiebreaker looks identical to an
 * order nothing else came close to. Callers MUST consult this (on the
 * pre-selection scored list) before trusting a singleton selection as
 * unambiguous.
 */
export function isTopTied<T extends { confidence: number }>(scored: T[]): boolean {
  const strong = scored.filter((candidate) => candidate.confidence >= MATCH_CONFIDENCE_THRESHOLD);
  const pool = strong.length > 0 ? strong : scored;
  if (pool.length === 0) return false;
  const top = Math.max(...pool.map((c) => c.confidence));
  return pool.filter((c) => c.confidence === top).length > 1;
}

export function scoreAmazonOrderMatch(
  txn: Transaction,
  order: ExternalOrder,
  /**
   * The last-4 of the card the transaction was charged to, resolved from the
   * account's short_code. Previously scraped from txn.notes/sourceReference,
   * which matched 0 of 111 production Amazon transactions while 403 of 538
   * orders carry a payment_last4 — the join could never fire.
   */
  txnLast4: string | null,
): MatchScore {
  let score = 0;
  let secondary = 0;
  const reasons: string[] = [];
  const txnAmount = Math.abs(Number(txn.amount));
  const orderTotal = numberOrNull(order.total);
  if (orderTotal != null) {
    const diff = Math.abs(txnAmount - Math.abs(orderTotal));
    // Exact-cent is a distinct tier ABOVE ±$0.50, credited to secondaryScore
    // rather than confidence. Against undated orders (which score 65 and land
    // in selectMatchCandidates' fallback tier) an exact-cent match yields 30
    // real links with a null-test of ~0 false positives, while ±$0.50 yields 45
    // with a null-test of 21-29. Raising the primary score instead would push
    // these into the `strong` tier, which returns EVERY candidate — the
    // historical fan-out. Amounts are DECIMAL-as-string, so compare with an
    // epsilon, never `=== 0`.
    if (diff < 0.005) {
      score += 50;
      secondary += 20;
      reasons.push('amount matches to the cent');
    } else if (diff <= 0.5) {
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

  if (txnLast4 && order.paymentLast4) {
    if (txnLast4 === order.paymentLast4) {
      score += 20;
      secondary += 20;
      reasons.push('payment last4 matches');
    } else {
      // Two different cards is positive evidence against a match, at the same
      // magnitude as an amount mismatch. This is NOT foreign-card exclusion: it
      // is per-pair evidence, applied regardless of ownership, and it never
      // removes an order from the candidate pool.
      score -= 25;
      reasons.push('charged to a different card than the order');
    }
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
  // Fold CSV/email duplicates before scoring so a partial CSV total never
  // competes with the full email total for the same order.
  await mergeDuplicateAmazonOrders({ householdId: args.householdId });

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
  const accounts = await Account.findAll({
    where: { householdId: args.householdId },
    attributes: ['id', 'shortCode'],
  });
  const last4ByAccountId = new Map<number, string | null>(
    accounts.map((a) => [a.id, resolveAccountLast4(a.shortCode)]),
  );
  let suggested = 0;
  let autoAccepted = 0;
  const acceptedOrderIds = new Set<number>();
  let matchedDateFrom: string | null = null;
  let matchedDateTo: string | null = null;
  // Transactions whose sole surviving candidate this run came from a
  // resolved tie (see isTopTied below). Their suggested link is
  // structurally indistinguishable from a genuine lone match — exactly one
  // non-rejected link — so without this, backfillAutoAcceptAmazonLinks would
  // immediately re-promote it later in this same call, undoing the guard.
  const tieAmbiguousTxnIds = new Set<number>();

  for (const txn of txns.filter(
    (row) =>
      isAmazonLikeMerchant(`${row.merchantRaw} ${row.merchantClean}`) &&
      !isAmazonSubscriptionCharge(`${row.merchantRaw} ${row.merchantClean}`),
  )) {
    const scores = orders.map((order) => {
      const { confidence, matchReason, secondaryScore } = scoreAmazonOrderMatch(
        txn,
        order,
        last4ByAccountId.get(txn.accountId) ?? null,
      );
      return { order, confidence, matchReason, secondary: secondaryScore };
    });
    const candidates = selectMatchCandidates(scores);
    // Per-transaction auto-accept: only when there is a single candidate and it
    // is unambiguous + ≥ threshold. A transaction spanning multiple confident
    // orders is never auto-accepted (genuinely ambiguous which order it is).
    const sortedConf = candidates.map((c) => c.confidence).sort((a, b) => b - a);
    // A tie-resolved selection collapses to one candidate exactly like a
    // genuine lone match would, so `candidates.length === 1` alone cannot
    // tell them apart. isTopTied consults the pre-selection scored list
    // (which still has the runner-up) to veto auto-accept for the resolved
    // case — see isTopTied's doc comment. Fixes a tie such as [85, 85]
    // silently auto-accepting once resolveTie picks a sole leader.
    const tied = isTopTied(scores);
    const auto = candidates.length === 1 && !tied && decideAutoAccept(sortedConf);
    if (tied) tieAmbiguousTxnIds.add(txn.id);
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

  // Reconcile links created before auto-accept existed. upsertSuggestedOrderLink
  // only promotes rows it touches during THIS scan, so a suggested row whose
  // transaction no longer produces a candidate would stay pending forever.
  // The backfill runs its own review recompute for the orders it accepts, which
  // is why it goes after the loop rather than feeding into it. Transactions
  // this run deliberately left ambiguous (tieAmbiguousTxnIds) are excluded —
  // otherwise the backfill's own "exactly one non-rejected link" heuristic
  // would immediately re-promote the very link the guard above just refused
  // to auto-accept.
  const backfilled = await backfillAutoAcceptAmazonLinks({
    householdId: args.householdId,
    excludeTransactionIds: tieAmbiguousTxnIds,
  });
  autoAccepted += backfilled.promoted;

  return { suggested, autoAccepted, scannedTransactions: txns.length, matchedDateFrom, matchedDateTo };
}
