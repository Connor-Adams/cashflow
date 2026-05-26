/**
 * Weekly-digest aggregation (issue #267).
 *
 * Pure functions that turn a slice of transactions into the structured
 * digest payload consumed by the email template + in-app notification.
 *
 * Split into two layers:
 *   1. `aggregateDigest(rows, prevRows, opts)` — pure transform from input
 *      rows to digest summary. Tested in isolation; takes already-fetched
 *      DB rows so the IO boundary is owned by the caller (the job).
 *   2. `buildDigestForUser(user, asOf)` — IO wrapper that reads the user's
 *      household transactions for the last 7 days + the prior 7 days, plus
 *      budgets, and calls `aggregateDigest`. This is what the job invokes.
 *
 * Transaction sign convention (see Cashflow `aggregateDashboard`):
 *  - NEGATIVE `amount` = spend / expense (outflow).
 *  - POSITIVE `amount` = income / credit / payment.
 * Rows whose `txnType` is in `NON_SPEND_TXN_TYPES` (transfer, investment,
 * dividend, payment, refund, reward, income) are excluded from "spend"
 * but `income` / `refund` / `reward` rows count toward "income" totals.
 * Investment-account rows are excluded entirely.
 */
import { Op } from 'sequelize';
import { Account, BudgetTarget, HouseholdMember, Transaction } from '../models';
import { num } from '../util/numbers';
import { NON_SPEND_TXN_TYPES } from '../summary/classifyTransactionFlow';

export interface DigestTxnRow {
  id: number;
  date: string;
  amount: unknown;
  currency: string;
  merchantClean: string | null;
  merchantRaw: string | null;
  finalCategory: string | null;
  txnType: string | null;
  accountType: string | null;
  reviewFlag: boolean;
}

export interface DigestBudgetSnapshot {
  budgetId: number;
  name: string;
  amount: number;
  spent: number;
  remaining: number;
  currency: string;
}

export interface DigestCategoryDelta {
  category: string;
  currency: string;
  total: number;
  priorTotal: number;
  delta: number;
}

export interface WeeklyDigestData {
  /** ISO date (inclusive). Monday of the reporting week. */
  weekStart: string;
  /** ISO date (inclusive). Sunday of the reporting week. */
  weekEnd: string;
  currency: string;
  totalSpend: number;
  priorTotalSpend: number;
  totalIncome: number;
  priorTotalIncome: number;
  topCategories: DigestCategoryDelta[];
  biggestTransaction: {
    id: number;
    date: string;
    amount: number;
    currency: string;
    merchant: string;
    category: string | null;
  } | null;
  pendingCount: number;
  budgets: DigestBudgetSnapshot[];
  /** True when both the current week and full account history have zero rows. */
  hasAnyHistory: boolean;
  /** True when the current week has zero rows. Drives "Nothing new" copy. */
  isEmptyWeek: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the inclusive Monday-Sunday week containing `asOf`. Returns
 * ISO `YYYY-MM-DD` strings so the values plug straight into a DATEONLY
 * `WHERE date BETWEEN` clause.
 */
export function computeReportingWeek(asOf: Date): {
  weekStart: string;
  weekEnd: string;
  priorStart: string;
  priorEnd: string;
} {
  // UTC anchored. The cron runs on a UTC schedule and v1 deliberately
  // sidesteps per-user timezone (out of scope per issue body).
  const ref = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  // getUTCDay: 0=Sun..6=Sat. We want the most recent finished Sunday.
  // Mon 09:00 UTC tick → last Sunday is `ref - 1`.
  const dow = ref.getUTCDay();
  // Days since the most recent Sunday (inclusive of today if today is Sunday).
  // For a Monday tick: dow=1, daysSinceSunday=1 → weekEnd is yesterday.
  const daysSinceSunday = dow === 0 ? 0 : dow;
  const weekEndDate = new Date(ref.getTime() - daysSinceSunday * DAY_MS);
  const weekStartDate = new Date(weekEndDate.getTime() - 6 * DAY_MS);
  const priorEndDate = new Date(weekStartDate.getTime() - DAY_MS);
  const priorStartDate = new Date(priorEndDate.getTime() - 6 * DAY_MS);

  const toISO = (d: Date): string => d.toISOString().slice(0, 10);
  return {
    weekStart: toISO(weekStartDate),
    weekEnd: toISO(weekEndDate),
    priorStart: toISO(priorStartDate),
    priorEnd: toISO(priorEndDate),
  };
}

/**
 * True when a row should NOT count toward "spend" totals. Mirrors
 * `isNonSpend` from the summary classifier with one tweak: we keep the
 * accountType check distinct because the digest aggregator receives the
 * accountType already joined onto each row.
 */
function isSpendRow(row: DigestTxnRow): boolean {
  if (row.accountType === 'investment') return false;
  if (row.txnType && NON_SPEND_TXN_TYPES.has(row.txnType)) return false;
  const a = num(row.amount) ?? 0;
  return a < 0;
}

/**
 * True when a row should count toward "income" totals.
 * Positive amounts on rows tagged as `income` / `refund` / `reward`, plus
 * rows that fall back to positive-amount-with-no-special-type (these are
 * typically deposits the user hasn't categorized yet).
 */
function isIncomeRow(row: DigestTxnRow): boolean {
  if (row.accountType === 'investment') return false;
  const a = num(row.amount) ?? 0;
  if (a <= 0) return false;
  const t = row.txnType ?? '';
  if (t === 'transfer' || t === 'investment' || t === 'dividend') return false;
  // Payments are positive but represent a credit-card statement payment,
  // not income — exclude.
  if (t === 'payment') return false;
  return true;
}

export interface AggregateDigestOpts {
  weekStart: string;
  weekEnd: string;
  hasAnyHistory: boolean;
  pendingCount: number;
  budgets?: DigestBudgetSnapshot[];
  /**
   * Currency used to label the digest. v1: derived from the most-spent
   * currency in the current week; ties broken by lexical order. Falls back
   * to 'CAD' so the empty-week branch still has a label for the in-app row.
   */
  fallbackCurrency?: string;
}

export function aggregateDigest(
  current: DigestTxnRow[],
  prior: DigestTxnRow[],
  opts: AggregateDigestOpts,
): WeeklyDigestData {
  const currentSpend = current.filter(isSpendRow);
  const currentIncome = current.filter(isIncomeRow);
  const priorSpend = prior.filter(isSpendRow);
  const priorIncome = prior.filter(isIncomeRow);

  // Pick currency: most spend by absolute value in current week. Ties go
  // lexical. Fall back to opts.fallbackCurrency when no spend rows exist.
  const currencyVolumes = new Map<string, number>();
  for (const r of currentSpend) {
    const v = Math.abs(num(r.amount) ?? 0);
    currencyVolumes.set(r.currency, (currencyVolumes.get(r.currency) ?? 0) + v);
  }
  let currency = opts.fallbackCurrency ?? 'CAD';
  if (currencyVolumes.size > 0) {
    currency = Array.from(currencyVolumes.entries()).sort((a, b) =>
      b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1],
    )[0][0];
  }

  const sumAbs = (rows: DigestTxnRow[], filterCurrency: string): number =>
    rows
      .filter((r) => r.currency === filterCurrency)
      .reduce((acc, r) => acc + Math.abs(num(r.amount) ?? 0), 0);

  const totalSpend = sumAbs(currentSpend, currency);
  const priorTotalSpend = sumAbs(priorSpend, currency);
  const totalIncome = sumAbs(currentIncome, currency);
  const priorTotalIncome = sumAbs(priorIncome, currency);

  // Top 3 categories by current-week spend in the chosen currency.
  const byCategory = new Map<string, number>();
  for (const r of currentSpend) {
    if (r.currency !== currency) continue;
    const cat = r.finalCategory ?? 'Uncategorized';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + Math.abs(num(r.amount) ?? 0));
  }
  const priorByCategory = new Map<string, number>();
  for (const r of priorSpend) {
    if (r.currency !== currency) continue;
    const cat = r.finalCategory ?? 'Uncategorized';
    priorByCategory.set(
      cat,
      (priorByCategory.get(cat) ?? 0) + Math.abs(num(r.amount) ?? 0),
    );
  }
  const topCategories: DigestCategoryDelta[] = Array.from(byCategory.entries())
    .map(([category, total]) => {
      const priorTotal = priorByCategory.get(category) ?? 0;
      return {
        category,
        currency,
        total,
        priorTotal,
        delta: total - priorTotal,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);

  // Biggest transaction (most negative single row in the chosen currency).
  let biggestTransaction: WeeklyDigestData['biggestTransaction'] = null;
  for (const r of currentSpend) {
    if (r.currency !== currency) continue;
    const amt = Math.abs(num(r.amount) ?? 0);
    if (!biggestTransaction || amt > Math.abs(biggestTransaction.amount)) {
      biggestTransaction = {
        id: r.id,
        date: r.date,
        amount: -amt, // preserve sign convention
        currency,
        merchant:
          (r.merchantClean ?? '').trim() ||
          (r.merchantRaw ?? '').trim() ||
          'Unknown',
        category: r.finalCategory ?? null,
      };
    }
  }

  return {
    weekStart: opts.weekStart,
    weekEnd: opts.weekEnd,
    currency,
    totalSpend,
    priorTotalSpend,
    totalIncome,
    priorTotalIncome,
    topCategories,
    biggestTransaction,
    pendingCount: opts.pendingCount,
    budgets: opts.budgets ?? [],
    hasAnyHistory: opts.hasAnyHistory,
    isEmptyWeek: current.length === 0,
  };
}

// ---- IO wrapper --------------------------------------------------------

interface DigestUserContext {
  userId: number;
  householdIds: number[];
}

async function resolveUserHouseholds(userId: number): Promise<number[]> {
  const memberships = await HouseholdMember.findAll({
    where: { userId },
    attributes: ['householdId'],
  });
  return memberships.map((m) => m.householdId);
}

/**
 * Build a digest for `userId` using transactions visible to the user's
 * households as of `asOf`. Returns null when the user has zero history
 * (AC #11 — skip brand-new users with no imports yet).
 */
export async function buildDigestForUser(
  userId: number,
  asOf: Date,
): Promise<WeeklyDigestData | null> {
  const householdIds = await resolveUserHouseholds(userId);
  const ctx: DigestUserContext = { userId, householdIds };
  if (householdIds.length === 0) return null;

  // First, has the user ever imported anything? Cheap count guard.
  const totalRows = await Transaction.count({
    where: { householdId: { [Op.in]: householdIds } },
  });
  if (totalRows === 0) return null;

  const { weekStart, weekEnd, priorStart, priorEnd } = computeReportingWeek(
    asOf,
  );

  const fetchRows = async (
    startISO: string,
    endISO: string,
  ): Promise<DigestTxnRow[]> => {
    const rows = await Transaction.findAll({
      where: {
        householdId: { [Op.in]: householdIds },
        date: { [Op.gte]: startISO, [Op.lte]: endISO },
      },
      attributes: [
        'id',
        'date',
        'amount',
        'currency',
        'merchantClean',
        'merchantRaw',
        'finalCategory',
        'txnType',
        'accountId',
        'reviewFlag',
      ],
      raw: true,
    });
    // Pull account types so isNonSpend can exclude investment-account rows.
    const accountIds = Array.from(
      new Set((rows as unknown as { accountId: number }[]).map((r) => r.accountId)),
    );
    const accounts = accountIds.length
      ? await Account.findAll({
          where: { id: { [Op.in]: accountIds } },
          attributes: ['id', 'accountType'],
          raw: true,
        })
      : [];
    const typeById = new Map<number, string | null>(
      (
        accounts as unknown as { id: number; accountType: string | null }[]
      ).map((a) => [a.id, a.accountType]),
    );
    return (rows as unknown as Array<{
      id: number;
      date: string;
      amount: unknown;
      currency: string;
      merchantClean: string | null;
      merchantRaw: string | null;
      finalCategory: string | null;
      txnType: string | null;
      accountId: number;
      reviewFlag: boolean;
    }>).map((r) => ({
      id: r.id,
      date: r.date,
      amount: r.amount,
      currency: r.currency,
      merchantClean: r.merchantClean,
      merchantRaw: r.merchantRaw,
      finalCategory: r.finalCategory,
      txnType: r.txnType,
      accountType: typeById.get(r.accountId) ?? null,
      reviewFlag: !!r.reviewFlag,
    }));
  };

  const [current, prior] = await Promise.all([
    fetchRows(weekStart, weekEnd),
    fetchRows(priorStart, priorEnd),
  ]);

  // Pending count = transactions with review_flag=true visible to this user.
  const pendingCount = await Transaction.count({
    where: {
      householdId: { [Op.in]: householdIds },
      reviewFlag: true,
    },
  });

  // Budgets: surface monthly budgets only for v1 (the dashboard's primary
  // budget type). For each budget, compute MTD spend up to weekEnd as the
  // "spent" figure — that's a single, easy snapshot suitable for an email.
  const budgets = await loadBudgetSnapshots(ctx, weekEnd);

  return aggregateDigest(current, prior, {
    weekStart,
    weekEnd,
    hasAnyHistory: true,
    pendingCount,
    budgets,
  });
}

async function loadBudgetSnapshots(
  ctx: DigestUserContext,
  weekEndISO: string,
): Promise<DigestBudgetSnapshot[]> {
  if (ctx.householdIds.length === 0) return [];
  const budgets = await BudgetTarget.findAll({
    where: { householdId: { [Op.in]: ctx.householdIds } },
    attributes: ['id', 'category', 'amount', 'currency', 'period'],
    raw: true,
  });
  if (budgets.length === 0) return [];

  // Compute month-start as a YYYY-MM-01 string anchored to weekEnd's UTC
  // calendar. Cheap and dialect-agnostic.
  const [yy, mm] = weekEndISO.split('-');
  const monthStart = `${yy}-${mm}-01`;

  // Aggregate spend by household + currency for the month.
  const monthSpend = await Transaction.findAll({
    where: {
      householdId: { [Op.in]: ctx.householdIds },
      date: { [Op.gte]: monthStart, [Op.lte]: weekEndISO },
    },
    attributes: ['id', 'amount', 'currency', 'txnType', 'accountId'],
    raw: true,
  });
  const accountIds = Array.from(
    new Set(
      (monthSpend as unknown as { accountId: number }[]).map((r) => r.accountId),
    ),
  );
  const accounts = accountIds.length
    ? await Account.findAll({
        where: { id: { [Op.in]: accountIds } },
        attributes: ['id', 'accountType'],
        raw: true,
      })
    : [];
  const typeById = new Map<number, string | null>(
    (
      accounts as unknown as { id: number; accountType: string | null }[]
    ).map((a) => [a.id, a.accountType]),
  );

  // Aggregate net spend per currency.
  const spendByCurrency = new Map<string, number>();
  for (const r of monthSpend as unknown as Array<{
    amount: unknown;
    currency: string;
    txnType: string | null;
    accountId: number;
  }>) {
    if (typeById.get(r.accountId) === 'investment') continue;
    if (r.txnType && NON_SPEND_TXN_TYPES.has(r.txnType)) continue;
    const amt = num(r.amount) ?? 0;
    if (amt >= 0) continue;
    spendByCurrency.set(
      r.currency,
      (spendByCurrency.get(r.currency) ?? 0) + Math.abs(amt),
    );
  }

  // For v1 we just match the budget's currency, no FX. Keeps the email
  // honest about what numbers reflect.
  return (
    budgets as unknown as Array<{
      id: number;
      category: string | null;
      amount: unknown;
      currency: string;
    }>
  ).map((b) => {
    const spent = spendByCurrency.get(b.currency) ?? 0;
    const amount = num(b.amount) ?? 0;
    return {
      budgetId: b.id,
      // `category` is the BudgetTarget's display label (null = "Total
      // household" / overall budget). Mirror the dashboard's labeling.
      name: b.category ?? 'Total',
      amount,
      spent,
      remaining: amount - spent,
      currency: b.currency,
    };
  });
}
