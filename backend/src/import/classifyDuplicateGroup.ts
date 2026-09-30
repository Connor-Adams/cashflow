import { D } from '../tax/util/decimal';
import { isTaxClassified, type TaxTreatmentMaps } from '../tax/builders/resolveTaxTreatment';

export type DuplicateVerdict = 'certain' | 'review';

/**
 * The fields certainty depends on. Deliberately a plain shape rather than a
 * `Transaction` instance, so the rule is testable without a database and so the
 * query layer has to state what it loaded.
 */
export interface DuplicateCandidateRow {
  id: number;
  linkedTransactionId: number | null;
  businessOverride: boolean | null;
  taxTreatmentOverride: string | null;
  finalCategoryId: number | null;
  finalCategory: string | null;
  finalSplitType: string;
  receiptCount: number;
}

export interface DuplicateGroupInput {
  accountId: number;
  date: string;
  amount: string;
  rows: DuplicateCandidateRow[];
}

export interface ClassifyOptions {
  maps: TaxTreatmentMaps;
  /**
   * `Transaction.finalSplitType`'s column default. Passed in rather than written
   * as `'me'` here so the two cannot drift; the query layer reads it off the model.
   */
  defaultSplitType: string;
}

export interface DuplicateGroup extends DuplicateGroupInput {
  verdict: DuplicateVerdict;
  /** Every reason the group is not certain. Empty when it is. */
  reasons: string[];
  /** Rows beyond the first: `rows.length - 1`. */
  surplusCount: number;
  /** `amount x surplusCount` — what the ledger overstates if these are duplicates. */
  duplicatedAmount: string;
}

/**
 * Classify a group sharing `(account_id, date, amount)` as **certain** or
 * **for review**. Decides only; changes nothing.
 *
 * Certain requires ALL of:
 *
 *   1. every row carries the same NON-NULL `linkedTransactionId` — two legs cannot
 *      share one counterpart, which is structurally invalid rather than merely
 *      suspicious
 *   2. no row shows manual work: no `businessOverride`, no tax classification by
 *      ANY of the four routes, the default split, and no attached receipt
 *
 * Matching `(account, date, amount)` is explicitly not sufficient on its own. Two
 * $6.00 RBC monthly fees on one day are two fees;
 * `fuzzyDedupInvestmentActivity.ts:15-23` reasons about the same class for
 * recurring buys and equal staking rewards.
 */
export function classifyDuplicateGroup(
  group: DuplicateGroupInput,
  { maps, defaultSplitType }: ClassifyOptions,
): DuplicateGroup {
  if (group.rows.length < 2) {
    throw new Error(
      `classifyDuplicateGroup: a duplicate group needs at least two rows, got ${group.rows.length}`,
    );
  }

  const reasons: string[] = [];

  // 1. The structural criterion.
  const firstLink = group.rows[0].linkedTransactionId;
  if (firstLink === null) {
    reasons.push('no linked_transaction_id: matching account/date/amount alone is not evidence');
  } else if (group.rows.some((r) => r.linkedTransactionId !== firstLink)) {
    reasons.push('rows do not share one linked_transaction_id');
  }

  // 2. Manual work on any row. Every failing row is named — Connor works the queue
  // by hand and a list that stops at the first problem costs him a second pass.
  for (const r of group.rows) {
    if (r.businessOverride) reasons.push(`txn ${r.id}: business_override is set`);
    if (isTaxClassified(r, maps)) reasons.push(`txn ${r.id}: classified for tax`);
    if (r.finalSplitType !== defaultSplitType) {
      reasons.push(`txn ${r.id}: final_split_type is '${r.finalSplitType}', not the default`);
    }
    if (r.receiptCount > 0) reasons.push(`txn ${r.id}: ${r.receiptCount} receipt(s) attached`);
  }

  const surplusCount = group.rows.length - 1;
  return {
    ...group,
    verdict: reasons.length === 0 ? 'certain' : 'review',
    reasons,
    surplusCount,
    duplicatedAmount: D(group.amount).times(surplusCount).toFixed(2),
  };
}
