import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import {
  BudgetTarget,
  BUDGET_TARGET_PERIODS,
  BUDGET_TARGET_SCOPES,
  BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS,
  type BudgetTargetPeriod,
  type BudgetTargetScope,
} from '../models/BudgetTarget';
import { BudgetExclusion, Transaction } from '../models';
import { num } from '../util/numbers';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { splitTxnByItems } from '../import/splitTxnByItems';
import { loadItemAllocationContext, type ItemAllocationContext } from '../summary/loadItemAllocations';
import { loadCategoryTree, type CategoryTree } from '../categories/rollup';

const router = Router();

/**
 * A category's own name plus every descendant category name, used to roll a
 * per-category budget up its subtree. Pure over a CategoryTree so it's testable
 * without a DB.
 */
export function categoryAndDescendantNames(
  tree: CategoryTree,
  categoryId: number,
): string[] {
  const childrenByParent = new Map<number, number[]>();
  for (const [id, parentId] of tree.parentById) {
    if (parentId == null) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(id);
    childrenByParent.set(parentId, list);
  }
  const names: string[] = [];
  const seen = new Set<number>();
  const stack = [categoryId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = tree.nameById.get(id);
    if (name != null) names.push(name);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child);
  }
  return names;
}

type NormalizedBudgetInput = {
  category: string | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
  scope: BudgetTargetScope;
  rolloverEnabled: boolean;
  excludeRefundedPurchases: boolean;
  alertThresholds: number[];
};

type ValidationResult =
  | { ok: true; value: NormalizedBudgetInput }
  | { ok: false; status: number; error: string };

type NormalizedBudgetPatch = Partial<NormalizedBudgetInput>;

type PatchValidationResult =
  | { ok: true; value: NormalizedBudgetPatch }
  | { ok: false; status: number; error: string };

/**
 * Pure validator for POST /api/budgets bodies. Exported for unit tests so we
 * can exercise validation rules without spinning up the database.
 *
 * Treats `null` / `''` category as "overall" — the budget covers total spend
 * across all categories in the matching currency. Amount must be a finite,
 * positive number; currency must be a 3-letter ISO code; period defaults to
 * `monthly` (now extended to also accept weekly/annual); scope defaults to
 * `household`; rolloverEnabled is a boolean and defaults to false.
 */
export function validateBudgetInput(
  raw: Record<string, unknown>
): ValidationResult {
  const categoryNorm = normalizeCategory(raw.category);

  const currencyRaw = String(raw.currency ?? '').trim().toUpperCase();
  if (currencyRaw.length !== 3) {
    return {
      ok: false,
      status: 400,
      error: 'currency must be a 3-letter ISO code',
    };
  }

  const amountNumber = Number(raw.amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'amount must be a positive number',
    };
  }

  let period: BudgetTargetPeriod = 'monthly';
  if (raw.period != null && raw.period !== '') {
    const candidate = String(raw.period);
    if (!(BUDGET_TARGET_PERIODS as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `period must be one of: ${BUDGET_TARGET_PERIODS.join(', ')}`,
      };
    }
    period = candidate as BudgetTargetPeriod;
  }

  let scope: BudgetTargetScope = 'household';
  if (raw.scope != null && raw.scope !== '') {
    const candidate = String(raw.scope);
    if (!(BUDGET_TARGET_SCOPES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `scope must be one of: ${BUDGET_TARGET_SCOPES.join(', ')}`,
      };
    }
    scope = candidate as BudgetTargetScope;
  }

  const rolloverEnabled = parseBooleanFlag(raw.rolloverEnabled);
  const excludeRefundedPurchases = parseBooleanFlag(raw.excludeRefundedPurchases);

  const thresholdsResult = validateAlertThresholds(raw.alertThresholds);
  if (!thresholdsResult.ok) {
    return thresholdsResult;
  }
  const alertThresholds = thresholdsResult.value;

  return {
    ok: true,
    value: {
      category: categoryNorm,
      currency: currencyRaw,
      amount: amountNumber.toFixed(4),
      period,
      scope,
      rolloverEnabled,
      excludeRefundedPurchases,
      alertThresholds,
    },
  };
}

/**
 * Pure validator for `alertThresholds` (issue #268). Accepts:
 *   - undefined → return defaults [80, 100, 120]
 *   - array of integers in 1..500 → return deduped + sorted ascending
 *   - anything else → 400
 *
 * Dedup + sort here so the model + cron both see the same shape regardless
 * of input ordering, and the column doesn't bloat with `[80, 80, 80]`.
 */
export function validateAlertThresholds(
  raw: unknown,
):
  | { ok: true; value: number[] }
  | { ok: false; status: number; error: string } {
  if (raw === undefined) {
    return { ok: true, value: [...BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      status: 400,
      error: 'alertThresholds must be an array of integers',
    };
  }
  if (raw.length === 0) {
    // Allow explicit empty list to disable alerts for this budget. The cron
    // then has nothing to fire — consistent with a user opting out without
    // touching their Notifications-tab channel preference.
    return { ok: true, value: [] };
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      return {
        ok: false,
        status: 400,
        error: 'alertThresholds entries must be integers between 1 and 500',
      };
    }
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  out.sort((a, b) => a - b);
  return { ok: true, value: out };
}

/**
 * Pure validator for PUT /api/budgets/:id bodies. Each field is optional;
 * unknown fields are ignored. Returns a partial input that callers can apply
 * via `row.set(...)`. The same rules as POST apply to any field that IS
 * supplied (positive amount, 3-letter currency, known period, known scope).
 */
export function validateBudgetPatch(
  raw: Record<string, unknown>
): PatchValidationResult {
  const out: NormalizedBudgetPatch = {};

  if (raw.category !== undefined) {
    out.category = normalizeCategory(raw.category);
  }

  if (raw.currency !== undefined) {
    const currency = String(raw.currency ?? '').trim().toUpperCase();
    if (currency.length !== 3) {
      return {
        ok: false,
        status: 400,
        error: 'currency must be a 3-letter ISO code',
      };
    }
    out.currency = currency;
  }

  if (raw.amount !== undefined) {
    const amountNumber = Number(raw.amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return {
        ok: false,
        status: 400,
        error: 'amount must be a positive number',
      };
    }
    out.amount = amountNumber.toFixed(4);
  }

  if (raw.period !== undefined) {
    const candidate = String(raw.period);
    if (!(BUDGET_TARGET_PERIODS as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `period must be one of: ${BUDGET_TARGET_PERIODS.join(', ')}`,
      };
    }
    out.period = candidate as BudgetTargetPeriod;
  }

  if (raw.scope !== undefined) {
    const candidate = String(raw.scope);
    if (!(BUDGET_TARGET_SCOPES as readonly string[]).includes(candidate)) {
      return {
        ok: false,
        status: 400,
        error: `scope must be one of: ${BUDGET_TARGET_SCOPES.join(', ')}`,
      };
    }
    out.scope = candidate as BudgetTargetScope;
  }

  if (raw.rolloverEnabled !== undefined) {
    out.rolloverEnabled = parseBooleanFlag(raw.rolloverEnabled);
  }

  if (raw.excludeRefundedPurchases !== undefined) {
    out.excludeRefundedPurchases = parseBooleanFlag(raw.excludeRefundedPurchases);
  }

  if (raw.alertThresholds !== undefined) {
    const thresholdsResult = validateAlertThresholds(raw.alertThresholds);
    if (!thresholdsResult.ok) return thresholdsResult;
    out.alertThresholds = thresholdsResult.value;
  }

  return { ok: true, value: out };
}

function normalizeCategory(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.slice(0, 128);
}

/**
 * Coerce a truthy-style input into a strict boolean. Accepts the literal
 * `true`, the strings 'true'/'1'/'yes' (case-insensitive), and numeric 1.
 * Everything else (including undefined/null) becomes false. This matches
 * how form submissions and JSON booleans commonly arrive.
 */
function parseBooleanFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (raw === false || raw == null) return false;
  if (typeof raw === 'number') return raw === 1;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

type BudgetResponse = {
  id: number;
  householdId: number;
  category: string | null;
  currency: string;
  amount: string;
  period: BudgetTargetPeriod;
  scope: BudgetTargetScope;
  rolloverEnabled: boolean;
  excludeRefundedPurchases: boolean;
  alertThresholds: number[];
  createdAt: string;
  updatedAt: string;
};

function serializeBudget(row: InstanceType<typeof BudgetTarget>): BudgetResponse {
  return {
    id: row.id,
    householdId: row.householdId,
    category: row.category,
    currency: row.currency,
    amount: String(row.amount),
    period: row.period,
    scope: row.scope,
    rolloverEnabled: Boolean(row.rolloverEnabled),
    excludeRefundedPurchases: Boolean(row.excludeRefundedPurchases),
    alertThresholds: normalizeAlertThresholdsForSerialize(row.alertThresholds),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Defensive coercion for the column value at serialize time. Sqlite returns
 * the JSON array as a JS array, but a legacy row that was inserted before
 * the migration's default backfilled could in theory have a string-typed
 * value; we fall back to the bundled defaults so the response never lies.
 */
function normalizeAlertThresholdsForSerialize(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return [...BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS];
}

router.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }
    const rows = await BudgetTarget.findAll({
      where,
      order: [
        ['currency', 'ASC'],
        ['category', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
    res.json({ data: rows.map(serializeBudget) });
  } catch (e) {
    next(e);
  }
});

/**
 * Returns the inclusive [start, end] ISO date strings for the calendar month
 * containing `now`, in the local timezone. We deliberately use local time so
 * "this month" matches what a user sees on their phone calendar; date storage
 * on Transaction.date is DATEONLY (no TZ), and the dashboard date filter
 * already operates in local terms.
 */
export function currentMonthBounds(
  now: Date = new Date()
): { periodStart: string; periodEnd: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const startDate = new Date(y, m, 1);
  const endDate = new Date(y, m + 1, 0);
  return { periodStart: formatLocalDate(startDate), periodEnd: formatLocalDate(endDate) };
}

function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the [start, end] of the ISO week (Mon → Sun) containing `now`.
 * ISO week was chosen because most finance UIs the user has encountered
 * (Google Calendar default, banking dashboards, payroll) use Mon-Sun;
 * it also matches the date-fns default `weekStartsOn: 1`. If a user wants
 * a Sun-Sat week later we can add a household-level setting and split here.
 */
export function currentWeekBounds(
  now: Date = new Date()
): { periodStart: string; periodEnd: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // JS Date.getDay() returns 0 (Sun) through 6 (Sat).
  // Convert to Mon=0..Sun=6 so we can subtract back to Monday.
  const dayMondayBased = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - dayMondayBased);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    periodStart: formatLocalDate(monday),
    periodEnd: formatLocalDate(sunday),
  };
}

/** Returns the [Jan 1, Dec 31] bounds of the calendar year containing `now`. */
export function currentYearBounds(
  now: Date = new Date()
): { periodStart: string; periodEnd: string } {
  const y = now.getFullYear();
  return {
    periodStart: formatLocalDate(new Date(y, 0, 1)),
    periodEnd: formatLocalDate(new Date(y, 11, 31)),
  };
}

/**
 * Dispatch helper — pick the right bounds for a budget's `period`. Pure so
 * we can unit-test each branch without a DB. Default monthly is preserved
 * for back-compat with callers that pass `undefined`.
 */
export function currentPeriodBounds(
  period: BudgetTargetPeriod = 'monthly',
  now: Date = new Date()
): { periodStart: string; periodEnd: string } {
  switch (period) {
    case 'weekly':
      return currentWeekBounds(now);
    case 'annual':
      return currentYearBounds(now);
    case 'monthly':
    default:
      return currentMonthBounds(now);
  }
}

/**
 * Percentage of the current period that has elapsed at `now`. Returns 0
 * before the period starts and 100 after it ends.
 *
 * Why fractional-day instead of floor((days_so_far / total_days) * 100)?
 * The pacing display feels jumpy at day boundaries — at 11:59 PM you're
 * 1/30 done and at 12:01 AM you're 2/30, a 3.3pp jump from one minute to
 * the next. Using `(now - start) / (end - start)` keeps the bar smooth and
 * makes the math match the spirit of "we're roughly N% through the month".
 */
export function periodElapsedPercent(
  now: Date,
  bounds: { periodStart: string; periodEnd: string }
): number {
  const startMs = Date.parse(`${bounds.periodStart}T00:00:00`);
  // periodEnd is the LAST day of the period (inclusive). Treat the end of
  // that day (23:59:59.999) as the boundary so the full last day counts.
  const endMs = Date.parse(`${bounds.periodEnd}T23:59:59.999`);
  const nowMs = now.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  if (nowMs <= startMs) return 0;
  if (nowMs >= endMs) return 100;
  return ((nowMs - startMs) / (endMs - startMs)) * 100;
}

export type BudgetPacingState = 'on-pace' | 'ahead' | 'behind' | 'over';

/**
 * Classify a budget's current state by comparing how much of the target has
 * been used against how much of the period has elapsed. This is the
 * "Dining is 88% spent but the month is only 62% complete" headline.
 *
 *   over    — already past 100% of target (overspent).
 *   ahead   — spending faster than time elapsed (delta > 5pp).
 *   behind  — spending slower than time elapsed (delta < -5pp).
 *   on-pace — within ±5pp of elapsed.
 *
 * The ±5pp band keeps the badge from flickering when spend and time are
 * essentially matched. 5pp ≈ a day-and-a-half on a monthly budget, which
 * felt like a comfortable "noise floor" in design review.
 */
export function pacingState(
  percentUsed: number,
  periodElapsed: number
): BudgetPacingState {
  if (percentUsed > 100) return 'over';
  const delta = percentUsed - periodElapsed;
  if (delta > 5) return 'ahead';
  if (delta < -5) return 'behind';
  return 'on-pace';
}

type SpendRow = {
  id: number;
  currency: string;
  finalCategory: string | null;
  finalCategoryId?: number | null;
  finalBusiness: boolean;
  finalSplitType: string;
  amount: unknown;
  businessAmount: string;
};

/**
 * Aggregate raw transaction rows into spend per (currency, category).
 *
 * Spend semantics: charges land in the DB as NEGATIVE numbers, so we sum the
 * negation (`-amount`) and only count `amount < 0`. Positive amounts (refunds,
 * credits, payments, transfers) are intentionally ignored here — they offset
 * spend elsewhere but a budget tracks gross outflow against a target. The
 * dashboard's category report already nets credits separately if desired.
 *
 * Pure helper exported so the route's correctness can be tested without a DB.
 */
export function aggregateSpendByCategory(
  rows: SpendRow[],
  itemContext?: ItemAllocationContext,
): Map<string, { currency: string; category: string | null; categoryId: number | null; spent: number }> {
  const out = new Map<
    string,
    { currency: string; category: string | null; categoryId: number | null; spent: number }
  >();
  for (const row of rows) {
    const amount = num(row.amount);
    if (amount == null || amount >= 0) continue;
    const allocations = itemContext
      ? splitTxnByItems({
          txn: {
            id: row.id,
            amount: String(row.amount),
            currency: row.currency,
            finalCategory: row.finalCategory,
            finalCategoryId: row.finalCategoryId ?? null,
            finalBusiness: row.finalBusiness,
            finalSplitType: row.finalSplitType,
            businessAmount: row.businessAmount,
          },
          links: itemContext.linksByTxn.get(row.id) ?? [],
          ordersById: itemContext.ordersById,
          itemsByOrder: itemContext.itemsByOrder,
        })
      : [
          {
            category: row.finalCategory,
            categoryId: row.finalCategoryId ?? null,
            amount,
            businessAmount: 0,
            currency: row.currency,
          },
        ];
    for (const alloc of allocations) {
      if (alloc.amount >= 0) continue;
      const spend = -alloc.amount;
      const key = `${alloc.currency}\0${alloc.category ?? ''}`;
      const existing = out.get(key) ?? {
        currency: alloc.currency,
        category: alloc.category,
        categoryId: alloc.categoryId ?? null,
        spent: 0,
      };
      existing.spent += spend;
      out.set(key, existing);
    }
  }
  return out;
}

/** One refund's net-back: a positive amount keyed by the ORIGINAL purchase's
 *  (currency, category) so it offsets the bucket the purchase landed in. */
export type RefundNet = {
  amount: unknown;
  currency: string;
  category: string | null;
};

/**
 * Net refunds out of an aggregated spend map IN PLACE, subtracting only the
 * refunded amount from the matching (currency, category) bucket — never the
 * whole original purchase. A $100 charge with a $30 partial refund leaves $70
 * of spend; a full $100 refund leaves $0. The old `excludeRefundedPurchases`
 * path dropped the entire original purchase row, which understated spend for
 * partial refunds.
 *
 * Each refund is keyed by the ORIGINAL purchase's category/currency (resolved
 * via `linkedTransactionId`), so the offset hits the same bucket the purchase
 * contributed to. Buckets are clamped at 0 so an over-refund can't push spend
 * negative. Refunds with no matching bucket are ignored.
 *
 * Pure helper exported so the route + cron share one definition and it can be
 * unit-tested without a DB.
 */
export function netRefundsFromSpend(
  spendByCategory: Map<
    string,
    { currency: string; category: string | null; spent: number }
  >,
  refunds: RefundNet[],
): void {
  for (const refund of refunds) {
    const refundAmount = num(refund.amount);
    if (refundAmount == null || refundAmount <= 0) continue;
    const key = `${refund.currency}\0${refund.category ?? ''}`;
    const bucket = spendByCategory.get(key);
    if (!bucket) continue;
    bucket.spent = Math.max(0, bucket.spent - refundAmount);
  }
}

/**
 * Map raw refund rows (each with the original purchase id + refund amount)
 * to `RefundNet`s keyed by the ORIGINAL purchase's (currency, category),
 * resolved from the in-window transaction rows. Refunds whose original
 * purchase isn't in the window (so it was never counted) are dropped — there
 * is nothing to net. Pure + exported so route and cron share it.
 */
export function resolveRefundNets(
  rows: Array<Pick<SpendRow, 'id' | 'currency' | 'finalCategory'>>,
  refundRows: Array<{ linkedTransactionId: number; amount: unknown }>,
): RefundNet[] {
  const byId = new Map<number, { currency: string; category: string | null }>();
  for (const row of rows) {
    byId.set(row.id, { currency: row.currency, category: row.finalCategory });
  }
  const nets: RefundNet[] = [];
  for (const refund of refundRows) {
    const original = byId.get(refund.linkedTransactionId);
    if (!original) continue;
    nets.push({
      amount: refund.amount,
      currency: original.currency,
      category: original.category,
    });
  }
  return nets;
}

type BudgetForProgress = {
  id: number;
  category: string | null;
  currency: string;
  amount: string;
  /**
   * The category's own name plus every descendant category name. When present
   * on a per-category budget, spend rolls up the subtree (a budget on a parent
   * counts its children). Omitted → the budget matches only its own bucket.
   */
  categoryNames?: string[] | null;
};

type ProgressItem = {
  budgetId: number;
  category: string | null;
  currency: string;
  target: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  periodStart: string;
  periodEnd: string;
};

/**
 * Combine budget rows with the spend aggregate. Pure so we can unit-test the
 * "overall" vs per-category split without a DB.
 *
 * Overall semantics: a budget with `category == null` sums spend across every
 * category that shares its currency. Per-category budgets look up just their
 * own (currency, category) key.
 */
export function computeBudgetProgress(
  budgets: BudgetForProgress[],
  spendByCategory: Map<
    string,
    { currency: string; category: string | null; spent: number }
  >,
  bounds: { periodStart: string; periodEnd: string }
): ProgressItem[] {
  const totalsByCurrency = new Map<string, number>();
  for (const value of spendByCategory.values()) {
    totalsByCurrency.set(
      value.currency,
      (totalsByCurrency.get(value.currency) ?? 0) + value.spent
    );
  }
  return budgets.map((budget) => {
    const target = Number(budget.amount);
    let spent: number;
    if (budget.category == null) {
      spent = totalsByCurrency.get(budget.currency) ?? 0;
    } else if (budget.categoryNames && budget.categoryNames.length > 0) {
      // Roll the subtree up: sum this category's bucket plus every descendant's.
      const seen = new Set<string>();
      spent = 0;
      for (const name of budget.categoryNames) {
        if (seen.has(name)) continue;
        seen.add(name);
        spent += spendByCategory.get(`${budget.currency}\0${name}`)?.spent ?? 0;
      }
    } else {
      const key = `${budget.currency}\0${budget.category}`;
      spent = spendByCategory.get(key)?.spent ?? 0;
    }
    const remaining = target - spent;
    const percentUsed = target > 0 ? (spent / target) * 100 : 0;
    return {
      budgetId: budget.id,
      category: budget.category,
      currency: budget.currency,
      target,
      spent,
      remaining,
      percentUsed,
      periodStart: bounds.periodStart,
      periodEnd: bounds.periodEnd,
    };
  });
}

/**
 * Maps a BudgetTargetScope into a Sequelize where-clause that filters
 * Transactions to the subset that counts toward the budget. The mapping
 * is intentionally a single source of truth so chat tools and other
 * consumers can adopt the same vocabulary later.
 *
 *   household → visibility = 'shared' (the joint/shared spend)
 *   personal  → visibility = 'private' AND (final_business=false OR null)
 *   partner   → ownership_type = 'partner'
 *   business  → final_business = true
 *
 * Returns `{}` for unknown scope to fail-open (don't accidentally hide all
 * transactions due to a bad string).
 */
export function scopeWhereClause(scope: BudgetTargetScope): WhereOptions {
  switch (scope) {
    case 'personal':
      return {
        visibility: 'private',
        [Op.or]: [{ finalBusiness: false }, { finalBusiness: null }],
      } as WhereOptions;
    case 'partner':
      return { ownershipType: 'partner' } as WhereOptions;
    case 'business':
      return { finalBusiness: true } as WhereOptions;
    case 'household':
      return { visibility: 'shared' } as WhereOptions;
    default:
      return {} as WhereOptions;
  }
}

router.get('/progress', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const budgets = await BudgetTarget.findAll({
      where,
      order: [
        ['currency', 'ASC'],
        ['category', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });

    const items = await computeStatusForBudgets(req, budgets);
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/budgets/status — issue #201's "status" endpoint. Returns the same
 * shape as /progress (kept identical to avoid splitting the dashboard widget
 * code path) but the canonical name from the issue spec. Adopt this endpoint
 * for new clients; /progress is preserved for back-compat with the existing
 * DashboardPage widget.
 */
router.get('/status', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const budgets = await BudgetTarget.findAll({
      where,
      order: [
        ['currency', 'ASC'],
        ['category', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });

    const items = await computeStatusForBudgets(req, budgets);
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

/**
 * Internal helper that turns a list of budget rows into the status response
 * shape (target/spent/percentUsed + monthElapsed + pacingState). Shared
 * between /progress and /status so the math stays in one place.
 *
 * Each budget is computed independently because budgets in different
 * scopes/periods cannot share their underlying transaction aggregate. The
 * inner per-budget query is bounded by the budget's own period and scope.
 * For the common case (a handful of budgets) the N+1 is negligible.
 */
async function computeStatusForBudgets(
  req: import('express').Request,
  budgets: InstanceType<typeof BudgetTarget>[]
): Promise<
  Array<
    ProgressItem & {
      scope: BudgetTargetScope;
      period: BudgetTargetPeriod;
      rolloverEnabled: boolean;
      excludeRefundedPurchases: boolean;
      periodElapsedPercent: number;
      pacingState: BudgetPacingState;
    }
  >
> {
  const now = new Date();
  if (budgets.length === 0) return [];

  // Load the category tree once so a budget on a parent rolls its subtree's
  // spend up (a budget on "Dining" counts "Dining / Coffee" too).
  const tree = await loadCategoryTree(currentAuth(req).household.id);

  // For each budget compute its own period bounds + scope-filtered spend.
  const results = await Promise.all(
    budgets.map(async (budget) => {
      const bounds = currentPeriodBounds(budget.period, now);

      // Exclusions for this budget — applied as `id NOT IN (...)` below.
      const excluded = await BudgetExclusion.findAll({
        where: { budgetId: budget.id },
        attributes: ['transactionId'],
        raw: true,
      });
      const explicitExcludedIds = excluded.map((row) => row.transactionId);

      // Issue #215: when the budget opts in to excludeRefundedPurchases, fetch
      // the refund rows in this household+currency+date window so we can net
      // their amount back out below. We keep the ORIGINAL purchase counted and
      // subtract only the refunded amount (netRefundsFromSpend) — dropping the
      // whole original purchase understated spend on partial refunds.
      let refundRows: Array<{ linkedTransactionId: number; amount: unknown }> =
        [];
      if (budget.excludeRefundedPurchases) {
        const refunds = await Transaction.findAll({
          where: {
            ...householdWhere(req),
            currency: budget.currency,
            txnType: 'refund',
            linkedTransactionId: { [Op.ne]: null },
            date: {
              [Op.gte]: bounds.periodStart,
              [Op.lte]: bounds.periodEnd,
            },
          },
          attributes: ['linkedTransactionId', 'amount'],
          raw: true,
        });
        refundRows = refunds
          .filter(
            (r): r is typeof r & { linkedTransactionId: number } =>
              typeof r.linkedTransactionId === 'number'
          )
          .map((r) => ({
            linkedTransactionId: r.linkedTransactionId,
            amount: r.amount,
          }));
      }

      const allExcludedIds = Array.from(new Set<number>(explicitExcludedIds));

      const txWhere: WhereOptions = {
        ...householdWhere(req),
        currency: budget.currency,
        date: {
          [Op.gte]: bounds.periodStart,
          [Op.lte]: bounds.periodEnd,
        },
        ...scopeWhereClause(budget.scope),
        ...(allExcludedIds.length > 0
          ? { id: { [Op.notIn]: allExcludedIds } }
          : {}),
      } as WhereOptions;

      const rows = await Transaction.findAll({
        where: txWhere,
        attributes: [
          'id',
          'currency',
          'finalCategory',
          'finalCategoryId', // B2: finalCategoryId selected for future rollup
          'finalBusiness',
          'finalSplitType',
          'amount',
          'businessAmount',
        ],
        raw: true,
      });
      const itemContext = await loadItemAllocationContext(
        rows.map((r) => (r as unknown as SpendRow).id)
      );
      const spendByCategory = aggregateSpendByCategory(
        rows as unknown as SpendRow[],
        itemContext
      );
      // Net the refunded amount back out of the original purchase's bucket.
      netRefundsFromSpend(
        spendByCategory,
        resolveRefundNets(rows as unknown as SpendRow[], refundRows)
      );
      const [progress] = computeBudgetProgress(
        [
          {
            id: budget.id,
            category: budget.category,
            currency: budget.currency,
            amount: String(budget.amount),
            categoryNames:
              budget.categoryId != null
                ? categoryAndDescendantNames(tree, budget.categoryId)
                : null,
          },
        ],
        spendByCategory,
        bounds
      );
      const elapsed = periodElapsedPercent(now, bounds);
      return {
        ...progress,
        scope: budget.scope,
        period: budget.period,
        rolloverEnabled: Boolean(budget.rolloverEnabled),
        excludeRefundedPurchases: Boolean(budget.excludeRefundedPurchases),
        periodElapsedPercent: elapsed,
        pacingState: pacingState(progress.percentUsed, elapsed),
      };
    })
  );
  return results;
}

router.post('/', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateBudgetInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const { household } = currentAuth(req);
    const row = await BudgetTarget.create({
      householdId: household.id,
      category: result.value.category,
      currency: result.value.currency,
      amount: result.value.amount,
      period: result.value.period,
      scope: result.value.scope,
      rolloverEnabled: result.value.rolloverEnabled,
      excludeRefundedPurchases: result.value.excludeRefundedPurchases,
      alertThresholds: result.value.alertThresholds,
    });
    res.status(201).json(serializeBudget(row));
  } catch (e) {
    next(e);
  }
});

/**
 * Shared PUT/PATCH handler for a single budget target (issue #848). PUT and
 * PATCH were byte-identical blind read-modify-write handlers; they are now one
 * implementation mounted on both verbs.
 *
 * The lost-update fix is the *targeted* column update: only the columns the
 * caller actually sent are written (`validateBudgetPatch` strips `undefined`
 * fields, so `patch` maps 1:1 to columns). A concurrent `PUT {scope}` therefore
 * no longer clobbers a concurrent `PATCH {amount}` — disjoint edits both land.
 * `version: true` on the model is the secondary guard: any full-instance save
 * still carries `WHERE version = N` and fails loudly on a stale write.
 */
const updateBudgetTarget: import('express').RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await BudgetTarget.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateBudgetPatch(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const patch = result.value as Parameters<typeof row.update>[0];
    if (Object.keys(patch).length > 0) {
      await row.update(patch);
    }
    res.json(serializeBudget(row));
  } catch (e) {
    next(e);
  }
};

router.put('/:id', updateBudgetTarget);

/**
 * Alias for PUT so consumers that prefer PATCH semantics can use the same
 * partial-patch shape. Identical handling — both verbs share one handler.
 */
router.patch('/:id', updateBudgetTarget);

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await BudgetTarget.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// ---- Exclusions -----------------------------------------------------

/**
 * Verify a budget belongs to the requesting household, returning the row
 * or null for not-found. Centralizes the cross-household 404 protection
 * for all exclusion sub-routes.
 */
async function loadOwnedBudget(
  req: import('express').Request,
  id: number
): Promise<InstanceType<typeof BudgetTarget> | null> {
  return BudgetTarget.findOne({
    where: { id, ...householdWhere(req) },
  });
}

router.get('/:id/exclusions', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const budget = await loadOwnedBudget(req, id);
    if (!budget) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const rows = await BudgetExclusion.findAll({
      where: { budgetId: id },
      order: [['createdAt', 'ASC']],
    });
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        budgetId: row.budgetId,
        transactionId: row.transactionId,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/exclusions', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const budget = await loadOwnedBudget(req, id);
    if (!budget) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const txnId = Number(body.transactionId);
    if (!Number.isInteger(txnId) || txnId < 1) {
      res.status(400).json({ error: 'transactionId must be a positive integer' });
      return;
    }
    // Confirm the transaction is in the same household — otherwise the
    // exclusion would silently apply to someone else's data.
    const txn = await Transaction.findOne({
      where: { id: txnId, ...householdWhere(req) },
      attributes: ['id'],
    });
    if (!txn) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }
    // Idempotent: if it already exists, return the existing row.
    const existing = await BudgetExclusion.findOne({
      where: { budgetId: id, transactionId: txnId },
    });
    if (existing) {
      res.status(200).json({
        id: existing.id,
        budgetId: existing.budgetId,
        transactionId: existing.transactionId,
        createdAt: existing.createdAt.toISOString(),
      });
      return;
    }
    const created = await BudgetExclusion.create({
      budgetId: id,
      transactionId: txnId,
    });
    res.status(201).json({
      id: created.id,
      budgetId: created.budgetId,
      transactionId: created.transactionId,
      createdAt: created.createdAt.toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/exclusions/:transactionId', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const txnId = parseInt(req.params.transactionId, 10);
    if (!Number.isInteger(id) || id < 1 || !Number.isInteger(txnId) || txnId < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const budget = await loadOwnedBudget(req, id);
    if (!budget) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const row = await BudgetExclusion.findOne({
      where: { budgetId: id, transactionId: txnId },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
