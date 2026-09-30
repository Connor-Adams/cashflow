import { Op } from 'sequelize';
import { Category, Receipt, Transaction } from '../models';
import { D } from '../tax/util/decimal';
import type { TaxTreatmentMaps } from '../tax/builders/resolveTaxTreatment';
import {
  classifyDuplicateGroup,
  type DuplicateCandidateRow,
  type DuplicateGroup,
} from './classifyDuplicateGroup';

export interface DetectDuplicatesOptions {
  householdId: number;
  /** Inclusive, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive, `YYYY-MM-DD`. */
  endDate: string;
  /** Narrow to one entity — part 3's per-T1 call. A corp duplicate is not a T1 gap. */
  entityId?: number;
  /** Narrow to specific accounts. */
  accountIds?: number[];
}

export interface DuplicateReport {
  period: { startDate: string; endDate: string };
  /** Every group, ordered by date then account, so the worklist is stable. */
  groups: DuplicateGroup[];
  certain: DuplicateGroup[];
  review: DuplicateGroup[];
  /** Signed sum of every group's surplus rows — what the ledger overstates. */
  totalDuplicatedAmount: string;
}

/**
 * Find transactions sharing `(account_id, date, amount)` within a period and
 * classify each group as certain or for review. **Reads only** — nothing is
 * marked, merged or deleted.
 *
 * Why a module and not just a script: part 3 calls it per T1 request as a gap
 * type, and part 4 runs it once over the whole household. A script-only build
 * would block part 3.
 *
 * Why period-bounded: part 3's latency budget. There is also no reason to read
 * 2023 to say what 2026 overstates.
 *
 * Grouping happens in JS rather than SQL `GROUP BY`. The query runs on both SQLite
 * and Postgres, and DECIMAL comes back as a dialect-dependent string — '-2000' and
 * '-2000.00' are one amount and a string GROUP BY would split them.
 */
export async function detectDuplicateTransactions(
  opts: DetectDuplicatesOptions,
): Promise<DuplicateReport> {
  const { householdId, startDate, endDate, entityId, accountIds } = opts;
  if (!householdId) {
    throw new Error(
      'detectDuplicateTransactions: a householdId scope is required. An unbounded '
      + 'whole-ledger scan is what the period bound exists to avoid.',
    );
  }

  const rows = await Transaction.findAll({
    where: {
      householdId,
      date: { [Op.between]: [startDate, endDate] },
      ...(entityId != null ? { entityId } : {}),
      ...(accountIds ? { accountId: { [Op.in]: accountIds } } : {}),
    },
    attributes: [
      'id', 'accountId', 'date', 'amount', 'linkedTransactionId', 'businessOverride',
      'taxTreatmentOverride', 'finalCategoryId', 'finalCategory', 'finalSplitType',
    ],
    order: [['date', 'ASC'], ['accountId', 'ASC'], ['id', 'ASC']],
  });

  // Key on the NORMALISED amount so dialect formatting cannot split a group.
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.accountId}|${String(r.date)}|${D(String(r.amount)).toFixed(2)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }

  const candidates = [...byKey.entries()].filter(([, group]) => group.length > 1);
  if (candidates.length === 0) {
    return {
      period: { startDate, endDate },
      groups: [], certain: [], review: [], totalDuplicatedAmount: '0.00',
    };
  }

  // Receipts only for rows actually in a group — a small set even on a wide period.
  const candidateIds = candidates.flatMap(([, group]) => group.map((r) => r.id as number));
  const receipts = await Receipt.findAll({
    where: { transactionId: { [Op.in]: candidateIds } },
    attributes: ['transactionId'],
  });
  const receiptCounts = new Map<number, number>();
  for (const rec of receipts) {
    receiptCounts.set(rec.transactionId, (receiptCounts.get(rec.transactionId) ?? 0) + 1);
  }

  const maps = await loadTaxTreatmentMaps(householdId);
  const defaultSplitType = transactionDefaultSplitType();

  const groups = candidates.map(([, group]) => {
    const first = group[0];
    return classifyDuplicateGroup(
      {
        accountId: first.accountId as number,
        date: String(first.date),
        amount: D(String(first.amount)).toFixed(2),
        rows: group.map((r): DuplicateCandidateRow => ({
          id: r.id as number,
          linkedTransactionId: r.linkedTransactionId ?? null,
          businessOverride: r.businessOverride ?? null,
          taxTreatmentOverride: r.taxTreatmentOverride ?? null,
          finalCategoryId: r.finalCategoryId ?? null,
          finalCategory: r.finalCategory ?? null,
          finalSplitType: r.finalSplitType,
          receiptCount: receiptCounts.get(r.id as number) ?? 0,
        })),
      },
      { maps, defaultSplitType },
    );
  });

  groups.sort((a, b) => (
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.accountId - b.accountId
  ));

  const total = groups.reduce((acc, g) => acc.plus(D(g.duplicatedAmount)), D('0'));
  return {
    period: { startDate, endDate },
    groups,
    certain: groups.filter((g) => g.verdict === 'certain'),
    review: groups.filter((g) => g.verdict === 'review'),
    totalDuplicatedAmount: total.toFixed(2),
  };
}

/**
 * The same two maps `buildPersonalFacts` builds, so the detector's "is this row
 * classified?" question resolves through the identical four routes.
 */
async function loadTaxTreatmentMaps(householdId: number): Promise<TaxTreatmentMaps> {
  const categories = await Category.findAll({ where: { householdId } });
  return {
    catById: new Map(
      categories.map((c) => [c.id, { id: c.id, parentId: c.parentId, taxTreatment: c.taxTreatment }]),
    ),
    catTreatment: new Map(categories.map((c) => [c.name, c.taxTreatment])),
  };
}

/**
 * Read off the model rather than written as `'me'`, so the certainty rule and the
 * column default cannot drift apart.
 */
function transactionDefaultSplitType(): string {
  const attr = Transaction.getAttributes().finalSplitType;
  const fallback = attr?.defaultValue;
  if (typeof fallback !== 'string') {
    throw new Error(
      'detectDuplicateTransactions: Transaction.finalSplitType has no string column '
      + 'default. The certainty rule reads it to decide whether a row was split by hand.',
    );
  }
  return fallback;
}
