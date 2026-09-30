/**
 * The one budget spend pipeline. Both `GET /api/budgets/{progress,status}` and
 * the daily `budget_breach_check` cron call `loadBudgetSpend`; before this
 * module existed the cron carried its own ~90-line copy of the route's query
 * sequence, and the two had already drifted (the cron never selected
 * `final_category_id`, so every item allocation it produced had a null
 * categoryId).
 *
 * ## Rollover
 *
 * When `rolloverEnabled` is set, an unspent remainder from the budget's earlier
 * periods raises the effective target and an overspend lowers it, turning the
 * target into an accumulating envelope. The carry is UNCLAMPED — debt
 * propagates with no floor — which is what makes this cheap: an unclamped carry
 * is linear, so the per-period recursion collapses to
 *
 *     carriedIn = (allowance accrued over prior periods) - (spend over them)
 *
 * and no per-period iteration or per-period query is needed. We widen the single
 * transaction query to `[anchorStart, currentPeriodEnd]` and partition the rows
 * prior-vs-current in memory, so the query count per budget is unchanged from
 * before rollover existed. (Had the carry been floored at zero, the `max(0, …)`
 * at each period boundary would have forced a real N-period walk.)
 *
 * Carry is recomputed on every read rather than materialized. There is no
 * budget-period table, and this app ingests backdated statements constantly — a
 * stored carry would be wrong the moment a backdated transaction landed.
 *
 * Known limitation: because there is no history of `amount`, the carry values
 * prior periods at the budget's CURRENT target. Editing the amount retroactively
 * rewrites the accumulated carry.
 */
import { Op, type WhereOptions } from 'sequelize';
import { BudgetExclusion, Transaction } from '../models';
import type {
  BudgetTargetPeriod,
  BudgetTargetScope,
} from '../models/BudgetTarget';
import { loadCategoryTree, type CategoryTree } from '../categories/rollup';
import { loadItemAllocationContext } from '../summary/loadItemAllocations';
import {
  currentPeriodBounds,
  formatLocalDate,
  pacingState,
  periodDayCount,
  periodElapsedPercent,
  previousPeriodBounds,
  type BudgetPacingState,
  type PeriodBounds,
} from './budgetPeriods';
import {
  aggregateSpendByCategory,
  categoryAndDescendantNames,
  computeBudgetProgress,
  netRefundsFromSpend,
  resolveRefundNets,
  scopeWhereClause,
  type ProgressItem,
  type SpendRow,
} from './budgetSpendMath';

/**
 * How many completed periods a rollover budget reaches back over. Bounds the
 * widened transaction window: without it a weekly budget that has existed for
 * two years would scan 104 weeks of rows. Twelve leaves monthly and annual
 * budgets effectively uncapped in practice while keeping weekly sane.
 */
export const DEFAULT_ROLLOVER_LOOKBACK_PERIODS = 12;

/**
 * How much allowance accumulated across the COMPLETED periods before the one
 * containing `now`, and the earliest date the spend query must therefore reach.
 *
 * The period a budget was created in is prorated by the fraction of it the
 * budget actually existed for, so a budget created on the 28th does not credit a
 * whole month's allowance into the next period. Periods reached only because of
 * the cap (i.e. the budget predates the window) are whole — there is nothing to
 * prorate.
 *
 * Pure: no DB, no ambient clock.
 */
export function priorPeriodAllowance(args: {
  period: BudgetTargetPeriod;
  now: Date;
  createdAt: Date;
  amount: number;
  maxPeriods?: number;
}): { anchorStart: string; priorAllowance: number; priorPeriodCount: number } {
  const { period, now, createdAt, amount } = args;
  const maxPeriods = args.maxPeriods ?? DEFAULT_ROLLOVER_LOOKBACK_PERIODS;
  const current = currentPeriodBounds(period, now);
  const creation = currentPeriodBounds(period, createdAt);
  const createdOn = formatLocalDate(createdAt);

  const priors: PeriodBounds[] = [];
  let cursor = current;
  for (let i = 0; i < maxPeriods; i += 1) {
    const prev = previousPeriodBounds(period, cursor);
    // Walked past the period the budget was created in — nothing before that
    // period can have accrued allowance.
    if (prev.periodEnd < creation.periodStart) break;
    priors.push(prev);
    cursor = prev;
  }

  if (priors.length === 0) {
    // First period: no prior, so no carry and no need to widen the query.
    return {
      anchorStart: current.periodStart,
      priorAllowance: 0,
      priorPeriodCount: 0,
    };
  }

  let priorAllowance = 0;
  for (const bounds of priors) {
    if (bounds.periodStart !== creation.periodStart) {
      priorAllowance += amount;
      continue;
    }
    const totalDays = periodDayCount(bounds);
    const endMs = Date.parse(`${bounds.periodEnd}T00:00:00`);
    const fromMs = Date.parse(`${createdOn}T00:00:00`);
    const daysAlive = Math.round((endMs - fromMs) / 86400000) + 1;
    const clamped = Math.min(Math.max(daysAlive, 0), totalDays);
    priorAllowance += totalDays > 0 ? amount * (clamped / totalDays) : 0;
  }

  return {
    anchorStart: priors[priors.length - 1].periodStart,
    priorAllowance,
    priorPeriodCount: priors.length,
  };
}

/**
 * The subset of a BudgetTarget the spend pipeline needs. Structural rather than
 * a Sequelize instance so the cron, the route and tests can all supply one.
 */
export type BudgetSpendInput = {
  id: number;
  householdId: number;
  category: string | null;
  categoryId: number | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
  scope: BudgetTargetScope;
  rolloverEnabled: boolean;
  excludeRefundedPurchases: boolean;
  createdAt: Date;
};

export type BudgetSpendResult = {
  bounds: PeriodBounds;
  progress: ProgressItem;
  /** Earliest date the query reached. Equals `bounds.periodStart` without rollover. */
  anchorStart: string;
  /** How many completed prior periods fed the carry. 0 without rollover. */
  priorPeriodCount: number;
};

const SPEND_ATTRIBUTES = [
  'id',
  'date',
  'currency',
  'finalCategory',
  'finalCategoryId',
  'finalBusiness',
  'finalSplitType',
  'amount',
  'businessAmount',
] as const;

/**
 * Compute one budget's current-period spend, target and (when enabled) carry.
 *
 * The household scope is derived from `budget.householdId`, NOT from the
 * caller. A budget belongs to exactly one household and its spend is compared
 * against that household's target, so any other scope produces a number with no
 * meaning. This used to be a `householdWhere` parameter, which let the route
 * pass `householdWhere(req)` — `{}` for a superadmin — and sum every
 * household's transactions against one household's budget.
 */
export async function loadBudgetSpend(args: {
  budget: BudgetSpendInput;
  tree: CategoryTree;
  now?: Date;
  maxLookbackPeriods?: number;
}): Promise<BudgetSpendResult> {
  const { budget, tree } = args;
  const householdScope = { householdId: budget.householdId };
  const now = args.now ?? new Date();
  const bounds = currentPeriodBounds(budget.period, now);

  // Without rollover the window is exactly the current period, so every number
  // below is bit-identical to the pre-rollover behavior.
  const lookback = budget.rolloverEnabled
    ? priorPeriodAllowance({
        period: budget.period,
        now,
        createdAt: budget.createdAt,
        amount: Number(budget.amount),
        maxPeriods: args.maxLookbackPeriods,
      })
    : { anchorStart: bounds.periodStart, priorAllowance: 0, priorPeriodCount: 0 };

  const excluded = await BudgetExclusion.findAll({
    where: { budgetId: budget.id },
    attributes: ['transactionId'],
    raw: true,
  });
  const excludedIds = Array.from(
    new Set<number>(excluded.map((row) => row.transactionId)),
  );

  // Issue #215: when the budget opts in to excludeRefundedPurchases, fetch the
  // refund rows in this window so we can net their amount back out below. We
  // keep the ORIGINAL purchase counted and subtract only the refunded amount —
  // dropping the whole original purchase understated spend on partial refunds.
  let refundRows: Array<{ linkedTransactionId: number; amount: unknown }> = [];
  if (budget.excludeRefundedPurchases) {
    const refunds = await Transaction.findAll({
      where: {
        ...householdScope,
        currency: budget.currency,
        txnType: 'refund',
        linkedTransactionId: { [Op.ne]: null },
        date: { [Op.gte]: lookback.anchorStart, [Op.lte]: bounds.periodEnd },
      },
      attributes: ['linkedTransactionId', 'amount'],
      raw: true,
    });
    refundRows = refunds
      .filter(
        (r): r is typeof r & { linkedTransactionId: number } =>
          typeof r.linkedTransactionId === 'number',
      )
      .map((r) => ({
        linkedTransactionId: r.linkedTransactionId,
        amount: r.amount,
      }));
  }

  const rows = (await Transaction.findAll({
    where: {
      ...householdScope,
      currency: budget.currency,
      date: { [Op.gte]: lookback.anchorStart, [Op.lte]: bounds.periodEnd },
      ...scopeWhereClause(budget.scope),
      ...(excludedIds.length > 0 ? { id: { [Op.notIn]: excludedIds } } : {}),
    } as WhereOptions,
    attributes: [...SPEND_ATTRIBUTES],
    raw: true,
  })) as unknown as SpendRow[];

  const categoryNames =
    budget.categoryId != null
      ? categoryAndDescendantNames(tree, budget.categoryId)
      : null;

  // One item-allocation load for the whole window rather than one per period.
  const itemContext = await loadItemAllocationContext(rows.map((r) => r.id));

  const isPrior = (date: string | undefined): boolean =>
    // A row with no date can't be proven to be in a prior period; counting it
    // as current is the conservative choice (it never invents carry).
    date != null && date < bounds.periodStart;

  const currentRows = rows.filter((r) => !isPrior(r.date));
  const currentSpend = aggregateSpendByCategory(currentRows, itemContext);

  // A refund nets out of the period its ORIGINAL PURCHASE landed in, not the
  // period the refund itself is dated — that is where the spend was counted.
  const dateById = new Map<number, string | undefined>(
    rows.map((r) => [r.id, r.date]),
  );
  const partitionRefunds = (wantPrior: boolean) =>
    refundRows.filter(
      (r) => isPrior(dateById.get(r.linkedTransactionId)) === wantPrior,
    );

  netRefundsFromSpend(
    currentSpend,
    resolveRefundNets(currentRows, partitionRefunds(false)),
  );

  let carriedIn = 0;
  if (budget.rolloverEnabled && lookback.priorPeriodCount > 0) {
    const priorRows = rows.filter((r) => isPrior(r.date));
    const priorSpend = aggregateSpendByCategory(priorRows, itemContext);
    netRefundsFromSpend(
      priorSpend,
      resolveRefundNets(priorRows, partitionRefunds(true)),
    );
    // Reuse the progress selector so prior spend is scoped by exactly the same
    // overall / per-category / subtree-rollup rules as the current period.
    const [priorProgress] = computeBudgetProgress(
      [
        {
          id: budget.id,
          category: budget.category,
          currency: budget.currency,
          amount: String(budget.amount),
          categoryNames,
        },
      ],
      priorSpend,
      bounds,
    );
    carriedIn = lookback.priorAllowance - priorProgress.spent;
  }

  const [progress] = computeBudgetProgress(
    [
      {
        id: budget.id,
        category: budget.category,
        currency: budget.currency,
        amount: String(budget.amount),
        categoryNames,
        carriedIn,
      },
    ],
    currentSpend,
    bounds,
  );

  return {
    bounds,
    progress,
    anchorStart: lookback.anchorStart,
    priorPeriodCount: lookback.priorPeriodCount,
  };
}

export type BudgetStatusItem = ProgressItem & {
  scope: BudgetTargetScope;
  period: BudgetTargetPeriod;
  rolloverEnabled: boolean;
  excludeRefundedPurchases: boolean;
  periodElapsedPercent: number;
  pacingState: BudgetPacingState;
};

/**
 * Turn budget rows into the `/api/budgets/{progress,status}` response shape.
 *
 * Each budget is computed independently because budgets in different
 * scopes/periods cannot share their underlying transaction aggregate, so this is
 * one query per budget — unchanged by rollover, which only widens each query's
 * date range rather than adding queries.
 *
 * Both the spend scope and the category tree come from each budget's own
 * `householdId`, never from the caller — see {@link loadBudgetSpend}. Category
 * ids are per-household, so a tree from the wrong household resolves none of a
 * budget's ids and silently drops its subtree rollup. In practice every caller
 * passes a single household's budgets, so the dedupe below is one tree load.
 */
export async function loadBudgetStatuses(args: {
  budgets: BudgetSpendInput[];
  now?: Date;
}): Promise<BudgetStatusItem[]> {
  const { budgets } = args;
  if (budgets.length === 0) return [];
  const now = args.now ?? new Date();

  // A budget on a parent rolls its subtree's spend up (a budget on "Dining"
  // counts "Dining / Coffee" too), which needs that household's tree.
  const householdIds = Array.from(new Set(budgets.map((b) => b.householdId)));
  const treeByHousehold = new Map(
    await Promise.all(
      householdIds.map(
        async (id) => [id, await loadCategoryTree(id)] as const,
      ),
    ),
  );

  return Promise.all(
    budgets.map(async (budget) => {
      const { bounds, progress } = await loadBudgetSpend({
        budget,
        tree: treeByHousehold.get(budget.householdId)!,
        now,
      });
      const elapsed = periodElapsedPercent(now, bounds);
      return {
        ...progress,
        scope: budget.scope,
        period: budget.period,
        rolloverEnabled: budget.rolloverEnabled,
        excludeRefundedPurchases: budget.excludeRefundedPurchases,
        periodElapsedPercent: elapsed,
        pacingState: pacingState(progress.percentUsed, elapsed),
      };
    }),
  );
}

/**
 * Narrow a BudgetTarget instance (or any row carrying the same columns) to the
 * structural input the pipeline takes. Coerces the booleans because SQLite hands
 * them back as 0/1.
 */
export function toBudgetSpendInput(row: {
  id: number;
  householdId: number;
  category: string | null;
  categoryId?: number | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
  scope: BudgetTargetScope;
  rolloverEnabled?: boolean;
  excludeRefundedPurchases?: boolean;
  createdAt?: Date;
}): BudgetSpendInput {
  return {
    id: row.id,
    householdId: row.householdId,
    category: row.category,
    categoryId: row.categoryId ?? null,
    currency: row.currency,
    amount: String(row.amount),
    period: row.period,
    scope: row.scope,
    rolloverEnabled: Boolean(row.rolloverEnabled),
    excludeRefundedPurchases: Boolean(row.excludeRefundedPurchases),
    createdAt: row.createdAt ?? new Date(),
  };
}
