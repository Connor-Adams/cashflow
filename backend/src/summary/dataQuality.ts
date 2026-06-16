/**
 * Data-quality dashboard aggregation (#234).
 *
 * Combines seven independent signals about how complete and trustworthy the
 * household's finance dataset is into a single 0..1 quality score, plus a
 * per-component breakdown so the UI can call out which area needs attention.
 *
 * Component definitions (all scoped to the caller's visible transactions via
 * `visibleTransactionWhere` upstream — this module is pure aggregation):
 *
 *   1. categorization — share of spend rows with a non-null finalCategory.
 *   2. rules          — share of spend rows matched by a Rule (appliedRuleId).
 *   3. receipts       — share of spend rows with at least one Receipt
 *                       (reuses the `aggregateReceiptCompleteness` semantics
 *                       so the dashboard tile + #209's standalone tile agree).
 *   4. duplicates     — count of probable-duplicate transaction groups
 *                       (same date+amount+currency+merchantClean, ≥2 rows).
 *   5. transfers      — count of `txnType='transfer'` rows with no
 *                       linkedTransactionId (a matched pair would have both
 *                       sides linked).
 *   6. subscriptions  — count of Subscription rows in the `unknown` status
 *                       bucket — recurring charges the system can't classify
 *                       as active/cancelled.
 *   7. review         — count of transactions with `reviewFlag=true`.
 *
 * Scoring is deterministic — same input always yields the same output. Each
 * component is normalized to [0,1] (1 = best) and the overall score is the
 * unweighted arithmetic mean of the seven component scores. Issue-count
 * components use a linear penalty bottoming out at the per-component
 * threshold defined in `DATA_QUALITY_THRESHOLDS`. Coverage components clamp
 * to [0,1] directly. An empty dataset returns a vacuous 1.0 — there are no
 * rows to be miscategorized.
 *
 * The thresholds in dataQualityScore.ts are intentionally generous so a real
 * working household never sees a panic score from organic backlog; the tile
 * is supposed to surface neglect, not nag everyone with N>0 noise.
 */
import { Op, type WhereOptions } from 'sequelize';
import { PlannedEvent, Transaction } from '../models';
import { aggregateReceiptCompleteness, type CompletenessResult } from './receiptCompleteness';
import { NON_SPEND_TXN_TYPES } from './classifyTransactionFlow';
import {
  computeDataQualityScore,
  type DataQualityComponents,
  type DataQualityScoreResult,
} from './dataQualityScore';

// Re-export the score-math types and helpers so callers don't have to know
// the split exists. Routes + frontend types both consume these. Some callers
// import the same symbols straight from ./dataQualityScore, so fallow sees the
// facade re-exports as unused; they are intentional public API.
// fallow-ignore-file unused-export
// fallow-ignore-file unused-type
export {
  computeDataQualityScore,
  normalizeIssueCount,
  DATA_QUALITY_THRESHOLDS,
  DATA_QUALITY_ACTION_LINKS,
} from './dataQualityScore';
export type {
  CategorizationComponent,
  RulesComponent,
  ReceiptsComponent,
  DuplicatesComponent,
  TransfersComponent,
  SubscriptionsComponent,
  ReviewComponent,
  DataQualityComponents,
  DataQualityComponentScores,
  DataQualityScoreResult,
  DataQualityActionLink,
} from './dataQualityScore';

/**
 * Build the eligible-spend WHERE used by categorization, rules, and the
 * top-level transaction stats. Mirrors the receiptCompleteness eligibility
 * predicate so the three coverage signals agree on the same denominator
 * (negative amount + txnType not in NON_SPEND_TXN_TYPES).
 */
function spendWhere(scope: WhereOptions): WhereOptions {
  return {
    ...scope,
    amount: { [Op.lt]: 0 },
    txnType: { [Op.notIn]: Array.from(NON_SPEND_TXN_TYPES) },
  } as WhereOptions;
}

type SpendRow = {
  id: number;
  date: string;
  amount: string;
  currency: string;
  merchantClean: string;
  finalCategory: string | null;
  appliedRuleId: number | null;
  reviewFlag: boolean;
  txnType: string;
  linkedTransactionId: number | null;
};

type DupeRow = Pick<SpendRow, 'id' | 'date' | 'amount' | 'currency' | 'merchantClean'>;

/**
 * Aggregate the raw seven components for a single household scope. Two
 * queries: one for spend-row counts (categorization/rules + duplicate
 * detection) and one for the side-channel signals (review/transfers/subs).
 * Receipt coverage delegates to `aggregateReceiptCompleteness` so the math
 * stays in one place and the API can return identical numbers across tiles.
 */
export async function aggregateDataQuality(input: {
  /** Scope predicate for the Transactions table — pass visibleTransactionWhere(req). */
  transactionScope: WhereOptions;
  /** Scope predicate for the Subscriptions table — pass householdWhere(req). */
  subscriptionScope: WhereOptions;
}): Promise<
  DataQualityScoreResult & {
    totals: {
      transactionsScanned: number;
      spendTransactions: number;
    };
  }
> {
  const spendRows = (await Transaction.findAll({
    where: spendWhere(input.transactionScope),
    attributes: [
      'id',
      'date',
      'amount',
      'currency',
      'merchantClean',
      'finalCategory',
      'appliedRuleId',
      'reviewFlag',
      'txnType',
      'linkedTransactionId',
    ],
    raw: true,
  })) as unknown as SpendRow[];

  const totalSpend = spendRows.length;
  let categorized = 0;
  let ruleCovered = 0;
  for (const row of spendRows) {
    if (row.finalCategory != null && row.finalCategory !== '') categorized += 1;
    if (row.appliedRuleId != null) ruleCovered += 1;
  }

  // Receipts: reuse the canonical aggregator so the tile + #209's standalone
  // endpoint never disagree. Filter is 'all' (every eligible spend row),
  // currency null (cross-currency rollup).
  const receipts: CompletenessResult = await aggregateReceiptCompleteness({
    householdScope: input.transactionScope,
    filter: 'all',
    currency: null,
  });

  // Duplicates: rows sharing date+amount+currency+merchantClean with at least
  // one sibling. Includes refunds (positive amounts can dupe too). Keeping
  // this in memory avoids a complex SQL GROUP BY + HAVING that wouldn't be
  // portable between SQLite (test) and Postgres (prod).
  const allTxnRows = (await Transaction.findAll({
    where: input.transactionScope,
    attributes: ['id', 'date', 'amount', 'currency', 'merchantClean'],
    raw: true,
  })) as unknown as DupeRow[];
  const transactionsScanned = allTxnRows.length;

  const groupSizes = new Map<string, number>();
  for (const row of allTxnRows) {
    const merchantKey = (row.merchantClean ?? '').trim().toLowerCase();
    // Skip rows with no merchant — without a stable identifier the duplicate
    // signal is too noisy to action (most often these are pending imports).
    if (!merchantKey) continue;
    const amountKey = String(row.amount);
    const key = `${row.date}\0${amountKey}\0${row.currency}\0${merchantKey}`;
    groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
  }
  let duplicateGroups = 0;
  let duplicateTransactions = 0;
  for (const size of groupSizes.values()) {
    if (size >= 2) {
      duplicateGroups += 1;
      duplicateTransactions += size;
    }
  }

  // Transfers: txnType='transfer' rows without linkedTransactionId. The
  // import pipeline links transfer pairs when both sides land in the same
  // import; unmatched rows mean a partial import or a one-sided manual entry.
  const unmatchedTransfers = await Transaction.count({
    where: {
      ...input.transactionScope,
      txnType: 'transfer',
      linkedTransactionId: null,
    },
  });

  // Stale subscriptions: legacy status='unknown' is the bucket the classifier
  // assigns when it can't decide between active/cancelled/trial. On the merged
  // PlannedEvent model (kind='subscription') that maps to statusUncertain=true.
  // We keep ignored and cancelled out of the count so users aren't penalized
  // for already-resolved rows.
  const staleSubscriptions = await PlannedEvent.count({
    where: { ...input.subscriptionScope, kind: 'subscription', statusUncertain: true },
  });

  // Review backlog: every txn flagged for manual review, regardless of
  // whether it's also categorized/ruled — the flag is set by the enrichment
  // pipeline when confidence dips below a threshold (see enrichComputeReviewFlag).
  const reviewBacklog = await Transaction.count({
    where: { ...input.transactionScope, reviewFlag: true },
  });

  const components: DataQualityComponents = {
    categorization: {
      totalSpend,
      categorized,
      uncategorized: totalSpend - categorized,
      coverage: totalSpend > 0 ? categorized / totalSpend : 0,
    },
    rules: {
      totalSpend,
      ruleCovered,
      uncovered: totalSpend - ruleCovered,
      coverage: totalSpend > 0 ? ruleCovered / totalSpend : 0,
    },
    receipts: {
      totalSpend: receipts.totalCount,
      withReceipt: receipts.withReceiptCount,
      missing: receipts.missingCount,
      coverage: receipts.coverageByCount,
    },
    duplicates: { duplicateGroups, duplicateTransactions },
    transfers: { unmatched: unmatchedTransfers },
    subscriptions: { stale: staleSubscriptions },
    review: { backlog: reviewBacklog },
  };

  const scored = computeDataQualityScore(components);

  return {
    ...scored,
    totals: {
      transactionsScanned,
      spendTransactions: totalSpend,
    },
  };
}
