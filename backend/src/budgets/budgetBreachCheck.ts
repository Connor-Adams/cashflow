/**
 * Budget breach proactive alert — daily cron (issue #268).
 *
 * Iterates every active budget, computes current spend vs target, and for
 * each percentage threshold the user has configured (`alert_thresholds`)
 * that has been newly crossed this period, calls `enqueueNotification` with
 * `type='budget.breach'` and writes a row to `budget_alert_states` so the
 * next tick is a no-op (AC #5).
 *
 * Why a single cron and not per-transaction listeners? Imports land in
 * bursts (a CSV may add hundreds of rows in one second), and a single budget
 * may cross multiple thresholds during that burst — a listener would fire
 * three notifications for one import. The daily roll-up is one notification
 * per (budget, threshold, period) regardless of import cadence, which is
 * what the issue's UX intent calls for.
 *
 * Notification copy is generated here, not at the route layer, so the cron
 * and any future replay/manual-run code path produce identical content.
 *
 * Error containment: per-household failures (one user's spend query throws)
 * MUST NOT prevent other households from being processed (AC #6). We catch
 * and log per-budget so a bad row in one household doesn't tank the rest.
 */
import { Op } from 'sequelize';
import {
  BudgetAlertState,
  BudgetExclusion,
  BudgetTarget,
  HouseholdMember,
  Transaction,
} from '../models';
import {
  BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS,
  type BudgetTargetPeriod,
} from '../models/BudgetTarget';
import { enqueueNotification } from '../notifications';
import { logger } from '../observability/logger';
import {
  aggregateSpendByCategory,
  computeBudgetProgress,
  currentPeriodBounds,
  netRefundsFromSpend,
  resolveRefundNets,
  scopeWhereClause,
} from '../routes/budgets';
import { loadItemAllocationContext } from '../summary/loadItemAllocations';

/**
 * Compute the period-key string used to dedup notifications. One key per
 * recurrence-period instance — i.e. the same monthly budget gets a fresh
 * key on the first day of every month, so prior-month alert states no
 * longer match and new alerts can fire.
 *
 * Format:
 *   monthly → 'YYYY-MM'   (e.g. '2026-05')
 *   weekly  → 'YYYY-Www'  (e.g. '2026-W21', ISO-week with Mon as first day)
 *   annual  → 'YYYY'      (e.g. '2026')
 *
 * Pure so the cron logic is unit-testable without a clock.
 */
export function periodKey(period: BudgetTargetPeriod, now: Date): string {
  const y = now.getFullYear();
  switch (period) {
    case 'annual':
      return String(y);
    case 'weekly': {
      // ISO week: week containing the year's first Thursday is week 1; weeks
      // start on Monday. Computed via the standard trick (shift to Thursday,
      // diff from Jan 4).
      const date = new Date(Date.UTC(y, now.getMonth(), now.getDate()));
      // getUTCDay: Sun=0..Sat=6. ISO uses Mon=1..Sun=7.
      const dayNum = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - dayNum);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil(
        ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
      );
      return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    }
    case 'monthly':
    default: {
      const m = String(now.getMonth() + 1).padStart(2, '0');
      return `${y}-${m}`;
    }
  }
}

/**
 * Decide which thresholds the user should be alerted at this period given:
 *   - the budget's configured thresholds (e.g. `[80, 100, 120]`)
 *   - the current `percentUsed` value
 *   - the set of thresholds that have ALREADY been alerted for this period
 *
 * Returns the thresholds (ascending) that have been crossed AND haven't yet
 * been alerted. Pure so the integration test can pin a deterministic
 * "which thresholds will fire" expectation.
 *
 * Notes:
 *   - 80, 100, 120 are inclusive comparisons — at exactly 80.0% the 80
 *     threshold fires. This matches the issue's UX language ("when I cross
 *     80%") and avoids the surprise of being at 80% spent but seeing no
 *     alert because of a `>` instead of `>=`.
 *   - Thresholds the user removed from their config are NOT fired even if
 *     newly crossed (e.g. a user who never wants the 80% nudge).
 */
export function selectThresholdsToFire(
  configuredThresholds: readonly number[],
  percentUsed: number,
  alreadyAlertedThresholds: ReadonlySet<number>,
): number[] {
  const sorted = [...configuredThresholds].sort((a, b) => a - b);
  return sorted.filter(
    (t) => percentUsed >= t && !alreadyAlertedThresholds.has(t),
  );
}

/**
 * Best-effort number-of-days remaining in `bounds` from `now`. Inclusive of
 * the end date — at noon on the last day the function returns 1, on the
 * first day of the period it returns the full period length. Negative
 * inputs (now after the bounds) are clamped to 0 so the notification body
 * never says "-3 days left".
 */
export function remainingDaysInPeriod(
  now: Date,
  bounds: { periodStart: string; periodEnd: string },
): number {
  const endMs = Date.parse(`${bounds.periodEnd}T23:59:59.999`);
  const nowMs = now.getTime();
  if (!Number.isFinite(endMs) || nowMs >= endMs) return 0;
  return Math.max(0, Math.ceil((endMs - nowMs) / 86400000));
}

/**
 * Compose the notification title shown in the bell panel. Title is the
 * user's first-glance grab — body has the dollar context. Copy varies by
 * threshold band so the user can pattern-match without reading the body.
 */
export function budgetBreachTitle(
  category: string | null,
  threshold: number,
): string {
  const label = category ?? 'Overall';
  if (threshold >= 120) {
    const overBy = threshold - 100;
    return `${label} budget exceeded by ${overBy}%`;
  }
  if (threshold >= 100) {
    return `${label} budget reached`;
  }
  return `You've used ${threshold}% of your ${label} budget`;
}

/**
 * Plain-language body line. Mirrors the issue spec: "$<spent> of $<target>
 * this <period>. <remaining-days> days left." We format with the budget's
 * own currency rather than a locale default so multi-currency households
 * see the right symbol per row.
 */
export function budgetBreachBody(args: {
  spent: number;
  target: number;
  currency: string;
  period: BudgetTargetPeriod;
  remainingDays: number;
}): string {
  const { spent, target, currency, period, remainingDays } = args;
  const periodWord = period === 'weekly' ? 'week' : period === 'annual' ? 'year' : 'month';
  const spentStr = formatCurrency(spent, currency);
  const targetStr = formatCurrency(target, currency);
  const tail =
    remainingDays === 0
      ? `Period ends today.`
      : remainingDays === 1
        ? `1 day left.`
        : `${remainingDays} days left.`;
  return `${spentStr} of ${targetStr} this ${periodWord}. ${tail}`;
}

/**
 * Small money formatter scoped to this cron — keeps copy generation pure
 * (no dependency on a locale or Intl wrapper) and matches the dashboard's
 * "$1,234.56" rendering for ASCII currencies. For non-ASCII currencies we
 * fall back to a "1,234.56 XYZ" form so the body never silently mis-renders.
 */
function formatCurrency(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100;
  const fixed = rounded.toFixed(2);
  const [intPart, frac] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (currency === 'USD' || currency === 'CAD') {
    return `$${withCommas}.${frac}`;
  }
  return `${withCommas}.${frac} ${currency}`;
}

/**
 * Look up which user should receive the notification for this budget. A
 * budget belongs to a household; we pick the household owner as the
 * recipient. This mirrors how invite + ownership default behavior treats
 * the owner as the canonical "alertable" account for household-wide events.
 *
 * Returns `null` if the household has no owner row (e.g. demo data) — the
 * cron skips silently rather than throwing.
 */
async function resolveRecipientUserId(
  householdId: number,
): Promise<number | null> {
  const member = await HouseholdMember.findOne({
    where: { householdId, role: 'owner' },
    attributes: ['userId'],
    order: [['createdAt', 'ASC']],
    raw: true,
  });
  return member?.userId ?? null;
}

/**
 * Per-budget pure-ish work unit: compute the current spend, decide whether
 * any thresholds need to fire, write the alert-state rows + dispatch the
 * notifications. Returns a summary object for the cron tick result.
 *
 * Pulled out of `runBudgetBreachCheck` so the integration test can hit it
 * directly with a single seeded budget.
 */
export async function processBudget(
  budget: InstanceType<typeof BudgetTarget>,
  now: Date = new Date(),
): Promise<{
  budgetId: number;
  thresholdsFired: number[];
  status: 'ok' | 'no_recipient' | 'no_thresholds';
}> {
  const recipientUserId = await resolveRecipientUserId(budget.householdId);
  if (recipientUserId == null) {
    return { budgetId: budget.id, thresholdsFired: [], status: 'no_recipient' };
  }

  // Reuse the same per-budget spend math the /status route uses. Building
  // the where-clause directly off `householdId` (not `req`) keeps the cron
  // independent of express; everything else mirrors the route 1:1.
  const bounds = currentPeriodBounds(budget.period, now);
  const explicitExcluded = await BudgetExclusion.findAll({
    where: { budgetId: budget.id },
    attributes: ['transactionId'],
    raw: true,
  });
  const explicitExcludedIds = explicitExcluded.map((row) => row.transactionId);

  // When excludeRefundedPurchases is set we fetch the refund rows so we can
  // net their amount back out below — keeping the original purchase counted
  // and subtracting only the refunded amount. Dropping the whole original
  // purchase understated spend on partial refunds (mirrors the /status route).
  let refundRows: Array<{ linkedTransactionId: number; amount: unknown }> = [];
  if (budget.excludeRefundedPurchases) {
    const refunds = await Transaction.findAll({
      where: {
        householdId: budget.householdId,
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
          typeof r.linkedTransactionId === 'number',
      )
      .map((r) => ({
        linkedTransactionId: r.linkedTransactionId,
        amount: r.amount,
      }));
  }

  const allExcludedIds = Array.from(new Set<number>(explicitExcludedIds));

  const rows = await Transaction.findAll({
    where: {
      householdId: budget.householdId,
      currency: budget.currency,
      date: {
        [Op.gte]: bounds.periodStart,
        [Op.lte]: bounds.periodEnd,
      },
      ...scopeWhereClause(budget.scope),
      ...(allExcludedIds.length > 0
        ? { id: { [Op.notIn]: allExcludedIds } }
        : {}),
    },
    attributes: [
      'id',
      'currency',
      'finalCategory',
      'finalBusiness',
      'finalSplitType',
      'amount',
      'businessAmount',
    ],
    raw: true,
  });
  const ids = (rows as unknown as Array<{ id: number }>).map((r) => r.id);
  const itemContext = await loadItemAllocationContext(ids);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spendByCategory = aggregateSpendByCategory(rows as any, itemContext);
  // Net the refunded amount out of the original purchase's bucket.
  netRefundsFromSpend(
    spendByCategory,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveRefundNets(rows as any, refundRows),
  );
  const [progress] = computeBudgetProgress(
    [
      {
        id: budget.id,
        category: budget.category,
        currency: budget.currency,
        amount: String(budget.amount),
      },
    ],
    spendByCategory,
    bounds,
  );
  const percentUsed = progress.percentUsed;
  const periodKeyValue = periodKey(budget.period, now);

  // Existing alert-state rows in the (user, budget, period) tuple.
  const existingRows = await BudgetAlertState.findAll({
    where: {
      userId: recipientUserId,
      budgetTargetId: budget.id,
      periodKey: periodKeyValue,
    },
    attributes: ['threshold'],
    raw: true,
  });
  const alreadyAlerted = new Set<number>(existingRows.map((r) => r.threshold));

  const configured = normalizeThresholds(budget.alertThresholds);
  const toFire = selectThresholdsToFire(configured, percentUsed, alreadyAlerted);
  if (toFire.length === 0) {
    return { budgetId: budget.id, thresholdsFired: [], status: 'no_thresholds' };
  }

  const remainingDays = remainingDaysInPeriod(now, bounds);
  for (const threshold of toFire) {
    const title = budgetBreachTitle(budget.category, threshold);
    const body = budgetBreachBody({
      spent: progress.spent,
      target: progress.target,
      currency: budget.currency,
      period: budget.period,
      remainingDays,
    });
    try {
      // Write the dedup row FIRST. If `enqueueNotification` then fails or
      // the user has muted the channel, we still won't re-fire on the next
      // tick — better to under-alert (one missed dispatch) than to spam.
      await BudgetAlertState.create({
        userId: recipientUserId,
        budgetTargetId: budget.id,
        periodKey: periodKeyValue,
        threshold,
      });
      await enqueueNotification(recipientUserId, 'budget.breach', {
        severity: threshold >= 100 ? 'warn' : 'info',
        title,
        body,
        dataJson: {
          budgetId: budget.id,
          category: budget.category,
          currency: budget.currency,
          threshold,
          spent: progress.spent,
          target: progress.target,
          periodKey: periodKeyValue,
          remainingDays,
        },
      });
    } catch (err) {
      // Don't tank the rest of the budget's thresholds for a single failure.
      logger.warn(
        { err, budgetId: budget.id, threshold },
        'budget_breach_alert_failed',
      );
    }
  }

  return { budgetId: budget.id, thresholdsFired: toFire, status: 'ok' };
}

/**
 * Coerce whatever the DB returned into a clean number[] sorted ascending.
 *
 * Important distinction:
 *   - An *array* (including `[]`) is honored as-is. `[]` means "the user
 *     opted out of all per-budget alerts" — the cron should fire nothing.
 *   - `null`, `undefined`, or a string that fails JSON.parse falls back to
 *     the bundled defaults so legacy rows continue to behave the way the
 *     migration intends.
 */
function normalizeThresholds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0);
      }
    } catch {
      // fall through to defaults
    }
  }
  return [...BUDGET_TARGET_DEFAULT_ALERT_THRESHOLDS];
}

/**
 * Top-level cron entry point. Pulls every active budget and runs
 * `processBudget` on each, catching per-budget failures so the rest of
 * the run continues (AC #6).
 *
 * Returns a structured summary that's persisted by the JobRegistry's
 * `last_result_json` (truncated to 2KB) for visibility in the admin
 * jobs panel.
 */
export async function runBudgetBreachCheck(
  now: Date = new Date(),
): Promise<{
  budgetsScanned: number;
  budgetsAlerted: number;
  notificationsSent: number;
  errors: number;
}> {
  const budgets = await BudgetTarget.findAll({
    order: [['id', 'ASC']],
  });
  let budgetsAlerted = 0;
  let notificationsSent = 0;
  let errors = 0;
  for (const budget of budgets) {
    try {
      const result = await processBudget(budget, now);
      if (result.thresholdsFired.length > 0) {
        budgetsAlerted += 1;
        notificationsSent += result.thresholdsFired.length;
      }
    } catch (err) {
      errors += 1;
      logger.warn(
        { err, budgetId: budget.id },
        'budget_breach_check_budget_failed',
      );
    }
  }
  logger.info(
    {
      budgetsScanned: budgets.length,
      budgetsAlerted,
      notificationsSent,
      errors,
    },
    'budget_breach_check_complete',
  );
  return {
    budgetsScanned: budgets.length,
    budgetsAlerted,
    notificationsSent,
    errors,
  };
}
