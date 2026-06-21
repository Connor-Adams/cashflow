/**
 * Pure debt-payoff engine for issue #202.
 *
 * Given a set of debts (balance, APR, minimum payment), a strategy, and an
 * optional extra monthly payment, this simulates month-by-month amortization
 * and reports:
 *   - the payoff `order` (which debt is targeted first),
 *   - a per-month amortization schedule (`months`),
 *   - the payoff month for each debt (`payoffMonthByDebt`),
 *   - total interest paid (`totalInterest`) and total paid (`totalPaid`),
 *   - a `scheduledPayments` list (date + total outflow) suitable for feeding
 *     into the cashflow forecast,
 *   - a `stalled` flag when the minimum payments cannot keep up with interest.
 *
 * Funding model — the classic "debt snowball / avalanche" roll-over:
 *   total monthly budget = sum(original minimum payments) + extraMonthlyPayment
 * This budget is held constant. Each still-open debt is paid at least its
 * minimum; whatever is left over (the extra, plus the minimums freed up by
 * already-paid-off debts) is funnelled into the current target debt picked by
 * the strategy. This is why an avalanche/snowball pays debts off faster and
 * faster as it progresses.
 *
 * All money math is done in integer cents to avoid floating-point drift over
 * potentially hundreds of months, mirroring backend/src/forecast/buildForecast.ts.
 */

export type PayoffStrategy = 'avalanche' | 'snowball' | 'custom';

export const PAYOFF_STRATEGIES: readonly PayoffStrategy[] = [
  'avalanche',
  'snowball',
  'custom',
] as const;

export type PayoffDebtInput = {
  id: number;
  name: string;
  /** Current outstanding balance owed (non-negative). */
  balance: number;
  /** Annual percentage rate as a percent, e.g. 19.99 for 19.99%. */
  apr: number;
  /** Required minimum monthly payment (non-negative). */
  minimumPayment: number;
};

export type PayoffMonthDebtLine = {
  debtId: number;
  /** Total paid toward this debt this month (interest + principal). */
  payment: number;
  /** Interest accrued and paid this month. */
  interest: number;
  /** Principal reduction this month. */
  principal: number;
  /** Balance remaining after this month's payment. */
  endingBalance: number;
};

export type PayoffMonth = {
  /** 1-based month index. */
  month: number;
  perDebt: PayoffMonthDebtLine[];
  /** Sum of all payments across debts this month. */
  totalPaid: number;
  /** Sum of all interest across debts this month. */
  totalInterest: number;
};

export type ScheduledPayment = {
  /** YYYY-MM-DD — only present when a startDate was supplied. */
  date: string;
  /** Total outflow toward debt that month. */
  amount: number;
};

export type PayoffPlan = {
  strategy: PayoffStrategy;
  /** Debt ids in the order they are targeted. */
  order: number[];
  months: PayoffMonth[];
  /** payoffMonthByDebt[id] = 1-based month the debt hit zero, or null if never. */
  payoffMonthByDebt: Record<number, number | null>;
  totalMonths: number;
  totalInterest: number;
  totalPaid: number;
  scheduledPayments: ScheduledPayment[];
  /** True when minimums cannot keep pace with interest (balance never clears). */
  stalled: boolean;
};

export type ComputePayoffInput = {
  debts: PayoffDebtInput[];
  strategy: PayoffStrategy;
  extraMonthlyPayment: number;
  /** Optional custom ordering (debt ids) — only used when strategy='custom'. */
  customOrder?: number[];
  /** Optional ISO date the first payment lands on; drives scheduledPayments. */
  startDate?: string;
};

export type PayoffComparison = {
  avalanche: PayoffPlan;
  snowball: PayoffPlan;
  /** snowball.totalInterest - avalanche.totalInterest (>= 0). */
  interestSaved: number;
};

// Hard cap so a debt whose minimum cannot cover its interest doesn't loop
// forever. 600 months = 50 years, comfortably beyond any realistic payoff.
const MAX_MONTHS = 600;

function toCents(n: number): number {
  return Math.round(n * 100);
}

function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Order debt ids by strategy.
 *  - avalanche: highest APR first (ties broken by larger balance, then id).
 *  - snowball: smallest balance first (ties broken by higher APR, then id).
 *  - custom: the supplied order, with any omitted ids appended in input order.
 */
export function payoffOrder(
  debts: PayoffDebtInput[],
  strategy: PayoffStrategy,
  customOrder?: number[],
): number[] {
  if (strategy === 'custom') {
    const known = new Set(debts.map((d) => d.id));
    const seen = new Set<number>();
    const out: number[] = [];
    for (const id of customOrder ?? []) {
      if (known.has(id) && !seen.has(id)) {
        out.push(id);
        seen.add(id);
      }
    }
    for (const d of debts) {
      if (!seen.has(d.id)) {
        out.push(d.id);
        seen.add(d.id);
      }
    }
    return out;
  }

  const sorted = [...debts].sort((a, b) => {
    if (strategy === 'avalanche') {
      if (b.apr !== a.apr) return b.apr - a.apr;
      if (b.balance !== a.balance) return b.balance - a.balance;
      return a.id - b.id;
    }
    // snowball
    if (a.balance !== b.balance) return a.balance - b.balance;
    if (b.apr !== a.apr) return b.apr - a.apr;
    return a.id - b.id;
  });
  return sorted.map((d) => d.id);
}

/** Add one calendar month to an ISO date, clamping the day for short months. */
function addMonthIso(iso: string, monthsToAdd: number): string {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  const targetMonthIndex = m - 1 + monthsToAdd;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12; // 0-11
  // Last day of the target month (day 0 of the following month).
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

export function computePayoffPlan(input: ComputePayoffInput): PayoffPlan {
  const { debts, strategy, extraMonthlyPayment, customOrder, startDate } = input;

  const order = payoffOrder(debts, strategy, customOrder);

  const payoffMonthByDebt: Record<number, number | null> = {};
  for (const d of debts) payoffMonthByDebt[d.id] = null;

  if (debts.length === 0) {
    return {
      strategy,
      order,
      months: [],
      payoffMonthByDebt,
      totalMonths: 0,
      totalInterest: 0,
      totalPaid: 0,
      scheduledPayments: [],
      stalled: false,
    };
  }

  // Working state in cents.
  const balanceCents = new Map<number, number>();
  const minCents = new Map<number, number>();
  const monthlyRate = new Map<number, number>();
  const byId = new Map<number, PayoffDebtInput>();
  let baseBudgetCents = toCents(extraMonthlyPayment);
  for (const d of debts) {
    const bal = Math.max(0, toCents(d.balance));
    balanceCents.set(d.id, bal);
    const min = Math.max(0, toCents(d.minimumPayment));
    minCents.set(d.id, min);
    monthlyRate.set(d.id, d.apr / 100 / 12);
    byId.set(d.id, d);
    baseBudgetCents += min;
  }

  const months: PayoffMonth[] = [];
  const scheduledPayments: ScheduledPayment[] = [];
  let totalInterestCents = 0;
  let totalPaidCents = 0;
  let stalled = false;

  const remainingTotal = (): number => {
    let s = 0;
    for (const v of balanceCents.values()) s += v;
    return s;
  };

  let monthIndex = 0;
  while (remainingTotal() > 0) {
    monthIndex += 1;
    if (monthIndex > MAX_MONTHS) {
      stalled = true;
      monthIndex -= 1; // we did not actually record this overflow month
      break;
    }

    const totalBefore = remainingTotal();

    // 1. Accrue interest on every open debt.
    const interestThisMonth = new Map<number, number>();
    for (const d of debts) {
      const bal = balanceCents.get(d.id) ?? 0;
      if (bal <= 0) {
        interestThisMonth.set(d.id, 0);
        continue;
      }
      const interest = Math.round(bal * (monthlyRate.get(d.id) ?? 0));
      interestThisMonth.set(d.id, interest);
      balanceCents.set(d.id, bal + interest);
    }

    // 2. Pay each open debt its minimum (capped at the amount owed).
    let budget = baseBudgetCents;
    const paidThisMonth = new Map<number, number>();
    for (const d of debts) paidThisMonth.set(d.id, 0);

    for (const d of debts) {
      const bal = balanceCents.get(d.id) ?? 0;
      if (bal <= 0) continue;
      const min = minCents.get(d.id) ?? 0;
      const pay = Math.min(min, bal, budget);
      if (pay <= 0) continue;
      balanceCents.set(d.id, bal - pay);
      paidThisMonth.set(d.id, (paidThisMonth.get(d.id) ?? 0) + pay);
      budget -= pay;
    }

    // 3. Funnel the remaining budget into target debts in strategy order.
    for (const id of order) {
      if (budget <= 0) break;
      const bal = balanceCents.get(id) ?? 0;
      if (bal <= 0) continue;
      const pay = Math.min(bal, budget);
      balanceCents.set(id, bal - pay);
      paidThisMonth.set(id, (paidThisMonth.get(id) ?? 0) + pay);
      budget -= pay;
    }

    // 4. Record the month and detect payoffs.
    const perDebt: PayoffMonthDebtLine[] = [];
    let monthPaid = 0;
    let monthInterest = 0;
    for (const d of debts) {
      const interest = interestThisMonth.get(d.id) ?? 0;
      const payment = paidThisMonth.get(d.id) ?? 0;
      const endingBalance = balanceCents.get(d.id) ?? 0;
      const principal = payment - interest;
      monthPaid += payment;
      monthInterest += interest;
      perDebt.push({
        debtId: d.id,
        payment: fromCents(payment),
        interest: fromCents(interest),
        principal: fromCents(principal),
        endingBalance: fromCents(endingBalance),
      });
      if (endingBalance <= 0 && payoffMonthByDebt[d.id] === null) {
        payoffMonthByDebt[d.id] = monthIndex;
      }
    }

    totalInterestCents += monthInterest;
    totalPaidCents += monthPaid;

    months.push({
      month: monthIndex,
      perDebt,
      totalPaid: fromCents(monthPaid),
      totalInterest: fromCents(monthInterest),
    });
    if (startDate) {
      scheduledPayments.push({
        date: addMonthIso(startDate, monthIndex - 1),
        amount: fromCents(monthPaid),
      });
    }

    // 5. Stall guard: if the total owed did not strictly decrease this month,
    // the minimums cannot keep pace with interest. Flag and stop.
    if (remainingTotal() >= totalBefore) {
      stalled = true;
      break;
    }
  }

  // Any debt still carrying a balance after the loop never got paid off.
  for (const d of debts) {
    if ((balanceCents.get(d.id) ?? 0) > 0) {
      payoffMonthByDebt[d.id] = null;
    }
  }

  return {
    strategy,
    order,
    months,
    payoffMonthByDebt,
    totalMonths: months.length,
    totalInterest: fromCents(totalInterestCents),
    totalPaid: fromCents(totalPaidCents),
    scheduledPayments,
    stalled,
  };
}

/**
 * Run both the avalanche and snowball strategies over the same debts/extra and
 * report how much interest the avalanche saves over the snowball. The result's
 * `interestSaved` is always >= 0 because the avalanche (highest-APR-first) is
 * the interest-optimal ordering.
 */
export function comparePayoff(
  debts: PayoffDebtInput[],
  extraMonthlyPayment: number,
  startDate?: string,
): PayoffComparison {
  const avalanche = computePayoffPlan({
    debts,
    strategy: 'avalanche',
    extraMonthlyPayment,
    startDate,
  });
  const snowball = computePayoffPlan({
    debts,
    strategy: 'snowball',
    extraMonthlyPayment,
    startDate,
  });
  const interestSaved = fromCents(
    toCents(snowball.totalInterest) - toCents(avalanche.totalInterest),
  );
  return { avalanche, snowball, interestSaved };
}
