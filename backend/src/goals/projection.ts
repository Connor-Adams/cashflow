/**
 * Pure projection math for financial goals (issue #203).
 *
 * Exported so:
 * - GET /api/goals/:id/projection can serialize per-goal projection,
 * - The upcoming safe-to-spend feature (issue #199) can subtract required
 *   monthly contributions from disposable balances without dragging the
 *   route layer in.
 *
 * Everything in here is deterministic: callers pass `today` as YYYY-MM-DD
 * rather than calling `new Date()` so the math is testable. The
 * Decimal class is used for the few divisions to avoid float drift on
 * money values.
 */
import Decimal from 'decimal.js';

import type { FinancialGoalStatus } from '../models/FinancialGoal.js';

/**
 * The minimal goal shape the projector needs. Mirrors the columns we
 * store in `financial_goals`. `targetAmount` / `currentAmount` /
 * `monthlyContribution` are DECIMAL(14,4) and arrive as strings — keep them
 * as strings here so the projector matches the serializer contract.
 */
export interface GoalSnapshot {
  id: number;
  name: string;
  targetAmount: string;
  currentAmount: string;
  currency: string;
  /** YYYY-MM-DD or null. */
  targetDate: string | null;
  /** DECIMAL(14,4) string or null. */
  monthlyContribution: string | null;
  status: FinancialGoalStatus;
  /** YYYY-MM-DD; the date the goal was created (used for expected pace). */
  createdAt: string;
}

/**
 * Status surfaced to the UI / safe-to-spend math. Distinct from the
 * lifecycle `status` stored on the row (active/paused/completed).
 */
export type GoalOnTrackStatus =
  | 'ahead'
  | 'on_track'
  | 'behind'
  | 'overdue'
  | 'no_deadline'
  | 'completed'
  | 'paused';

export interface GoalProjection {
  goalId: number;
  /** Whole months between `today` and `targetDate`, floored. Null when no deadline. */
  monthsRemaining: number | null;
  /** DECIMAL(14,4) string or null. The amount per month needed to reach the target. */
  requiredMonthlyContribution: string | null;
  /** YYYY-MM-DD or null. When the goal would complete at the user's `monthlyContribution` pace. */
  projectedCompletionDate: string | null;
  /**
   * Where the user *should* be today on a linear glide path from createdAt
   * to targetDate. Null when there is no deadline.
   */
  expectedAmountToday: string | null;
  /** 0..100, clamped. Always 100 when targetAmount is zero (degenerate). */
  progressPercent: number;
  onTrackStatus: GoalOnTrackStatus;
}

/** ±5% tolerance band around the expected glide-path value before we call a goal "ahead" / "behind". */
const ON_TRACK_TOLERANCE = new Decimal('0.05');

function toDate(iso: string): Date {
  // Parse YYYY-MM-DD as a UTC date. Avoids local-tz drift when the harness
  // runs in non-UTC environments.
  const [y, m, d] = iso.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Whole calendar months between two YYYY-MM-DD dates, floored. Negative
 * differences clamp to 0 — callers handle the overdue case via
 * `targetDate < today`.
 *
 * Example: 2026-05-26 → 2027-05-26 = 12. 2026-05-26 → 2027-05-25 = 11.
 */
export function monthsBetween(fromIso: string, toIso: string): number {
  const a = toDate(fromIso);
  const b = toDate(toIso);
  if (b.getTime() <= a.getTime()) return 0;
  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return months < 0 ? 0 : months;
}

function addMonths(fromIso: string, months: number): string {
  const a = toDate(fromIso);
  // Build a new date by stepping forward `months`. Use UTC arithmetic.
  const result = new Date(
    Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + months, a.getUTCDate()),
  );
  return formatDate(result);
}

/**
 * Project a single goal as of `today` (YYYY-MM-DD). The returned object is
 * the JSON shape returned by GET /api/goals/:id/projection — no Decimal
 * objects leak out.
 */
export function projectGoal(goal: GoalSnapshot, today: string): GoalProjection {
  const target = new Decimal(goal.targetAmount);
  const current = new Decimal(goal.currentAmount);
  const monthlyContribution =
    goal.monthlyContribution == null ? null : new Decimal(goal.monthlyContribution);

  // --- progressPercent (clamped 0..100, degenerate targetAmount === 0 → 100)
  let progressPercent: number;
  if (target.lte(0)) {
    progressPercent = 100;
  } else {
    const pct = current.div(target).times(100).toNumber();
    progressPercent = Math.max(0, Math.min(100, pct));
  }

  // --- short-circuit lifecycle states
  if (goal.status === 'completed' || (target.gt(0) && current.gte(target))) {
    return {
      goalId: goal.id,
      monthsRemaining: null,
      requiredMonthlyContribution: null,
      projectedCompletionDate: null,
      expectedAmountToday: null,
      progressPercent: 100,
      onTrackStatus: 'completed',
    };
  }
  if (target.lte(0)) {
    // No-op goal: treat as completed.
    return {
      goalId: goal.id,
      monthsRemaining: null,
      requiredMonthlyContribution: null,
      projectedCompletionDate: null,
      expectedAmountToday: null,
      progressPercent: 100,
      onTrackStatus: 'completed',
    };
  }
  if (goal.status === 'paused') {
    return {
      goalId: goal.id,
      monthsRemaining:
        goal.targetDate == null ? null : monthsBetween(today, goal.targetDate),
      requiredMonthlyContribution: null,
      projectedCompletionDate: projectCompletionFromContribution(
        current,
        target,
        monthlyContribution,
        today,
      ),
      expectedAmountToday: null,
      progressPercent,
      onTrackStatus: 'paused',
    };
  }

  // --- no deadline
  if (goal.targetDate == null) {
    return {
      goalId: goal.id,
      monthsRemaining: null,
      requiredMonthlyContribution: null,
      projectedCompletionDate: projectCompletionFromContribution(
        current,
        target,
        monthlyContribution,
        today,
      ),
      expectedAmountToday: null,
      progressPercent,
      onTrackStatus: 'no_deadline',
    };
  }

  const monthsRemaining = monthsBetween(today, goal.targetDate);
  const remaining = target.minus(current);

  // overdue: target_date in past but goal not yet met
  if (toDate(goal.targetDate).getTime() < toDate(today).getTime()) {
    return {
      goalId: goal.id,
      monthsRemaining: 0,
      requiredMonthlyContribution: remaining.toFixed(4),
      projectedCompletionDate: projectCompletionFromContribution(
        current,
        target,
        monthlyContribution,
        today,
      ),
      expectedAmountToday: target.toFixed(4),
      progressPercent,
      onTrackStatus: 'overdue',
    };
  }

  // --- normal case: spread remaining across remaining months
  const requiredMonthly =
    monthsRemaining <= 0
      ? remaining
      : remaining.div(monthsRemaining);

  const expectedAmount = computeExpectedAmount(goal, today, target);
  let onTrackStatus: GoalOnTrackStatus = 'on_track';
  if (expectedAmount != null) {
    const tol = expectedAmount.times(ON_TRACK_TOLERANCE);
    if (current.gt(expectedAmount.plus(tol))) onTrackStatus = 'ahead';
    else if (current.lt(expectedAmount.minus(tol))) onTrackStatus = 'behind';
  }

  return {
    goalId: goal.id,
    monthsRemaining,
    requiredMonthlyContribution: requiredMonthly.toFixed(4),
    projectedCompletionDate: projectCompletionFromContribution(
      current,
      target,
      monthlyContribution,
      today,
    ),
    expectedAmountToday: expectedAmount == null ? null : expectedAmount.toFixed(4),
    progressPercent,
    onTrackStatus,
  };
}

/**
 * Where the user *should* be today on a linear glide path from `createdAt`
 * to `targetDate`. Returns null if the goal has no deadline. Clamps
 * (createdAt > today) to expected = current value (just-created goal).
 */
function computeExpectedAmount(
  goal: GoalSnapshot,
  today: string,
  target: Decimal,
): Decimal | null {
  if (goal.targetDate == null) return null;
  const start = toDate(goal.createdAt).getTime();
  const end = toDate(goal.targetDate).getTime();
  const now = toDate(today).getTime();
  if (end <= start) return target;
  if (now <= start) return new Decimal(goal.currentAmount);
  if (now >= end) return target;
  const elapsed = now - start;
  const total = end - start;
  return target.times(new Decimal(elapsed).div(total));
}

/**
 * If the user set a `monthlyContribution`, compute when they'd hit the
 * target at that pace. Returns null when no contribution is set or when
 * contribution is <=0.
 */
function projectCompletionFromContribution(
  current: Decimal,
  target: Decimal,
  monthlyContribution: Decimal | null,
  today: string,
): string | null {
  if (monthlyContribution == null || monthlyContribution.lte(0)) return null;
  const remaining = target.minus(current);
  if (remaining.lte(0)) return today;
  const months = remaining.div(monthlyContribution).ceil().toNumber();
  if (!Number.isFinite(months) || months < 0) return null;
  return addMonths(today, months);
}

/**
 * Aggregate required monthly contributions across a household's goals.
 * Skips paused, completed, no-deadline, and zero-remaining goals — those
 * don't pull from disposable income. The returned object is keyed by
 * currency ISO code (CAD, USD, …); values are DECIMAL(14,4) strings.
 *
 * Used by safe-to-spend (issue #199). Pure — no DB access; caller provides
 * the snapshot list.
 */
export function requiredMonthlyContributionsByCurrency(
  goals: GoalSnapshot[],
  today: string,
): Record<string, string> {
  const totals = new Map<string, Decimal>();
  for (const goal of goals) {
    if (goal.status !== 'active') continue;
    if (goal.targetDate == null) continue;
    const projection = projectGoal(goal, today);
    if (projection.requiredMonthlyContribution == null) continue;
    const add = new Decimal(projection.requiredMonthlyContribution);
    if (add.lte(0)) continue;
    const prev = totals.get(goal.currency) ?? new Decimal(0);
    totals.set(goal.currency, prev.plus(add));
  }
  const out: Record<string, string> = {};
  for (const [currency, total] of totals) {
    out[currency] = total.toFixed(4);
  }
  return out;
}
