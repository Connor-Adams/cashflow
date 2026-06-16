import { Router } from 'express';
import type { Request } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  Contact,
  PartnerSettlement,
  Reimbursement,
  Transaction,
  sequelize,
} from '../models';
import { num } from '../util/numbers';
import {
  aggregateDashboard,
  type AccountRow,
  type SummaryTxnRow,
} from '../summary/aggregateDashboard';
import {
  loadItemAllocationContext,
  type ItemAllocationContext,
} from '../summary/loadItemAllocations';
import {
  aggregateMonthly,
  type MonthlyTxnRow,
} from '../summary/aggregateMonthly';
import {
  applySettlements,
  type RawPartnerRow,
  type SettlementSummary,
} from '../summary/partnerMath';
import {
  detectRangeKind,
  priorPeriod,
  samePeriodLastYear,
  typicalWindows,
  RangeValidationError,
  type DateRange,
  type PeriodRangeKind,
  type TypicalWindows,
} from '../summary/periodRanges';
import {
  computeOwedBack,
  realCostOf,
  deltaPct,
  topCategoryMovers,
  type OwedBackRow,
  type MoverRow,
} from '../summary/periodInsight';
import { computeEffectiveStatus, todayIso } from '../reimbursements/serialize';
import { householdWhere, visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';
import type {
  PeriodInsightResp,
  PeriodInsightBaseline,
  PeriodInsightCurrency,
} from '@cashflow/shared';

const router = Router();

export function dateWhere(req: Request) {
  const w: Record<string, unknown> = { ...visibleTransactionWhere(req) };
  if (req.query.dateFrom || req.query.dateTo) {
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (req.query.dateFrom) dateCond[Op.gte] = String(req.query.dateFrom);
    if (req.query.dateTo) dateCond[Op.lte] = String(req.query.dateTo);
    w.date = dateCond;
  }
  if (req.query.currency) {
    w.currency = String(req.query.currency).toUpperCase().slice(0, 3);
  }
  return w;
}

/** Dashboard: totals by category and flags, per currency */
router.get('/dashboard', async (req, res, next) => {
  try {
    const where = dateWhere(req);
    const [rows, accounts] = await Promise.all([
      Transaction.findAll({
        where,
        attributes: [
          'id',
          'accountId',
          'date',
          'currency',
          'finalCategory',
          'finalBusiness',
          'finalSplitType',
          'merchantRaw',
          'merchantClean',
          'merchantCanonical',
          'amount',
          'businessAmount',
          'reviewFlag',
          'txnType',
          'linkedTransactionId',
        ],
        raw: true,
      }),
      Account.findAll({
        where: visibleAccountWhere(req),
        attributes: ['id', 'name', 'shortCode', 'accountType'],
        raw: true,
      }),
    ]);

    const accountById = new Map<number, AccountRow>(
      (accounts as unknown as AccountRow[]).map((account) => [account.id, account])
    );

    const itemContext = await loadItemAllocationContext(rows.map((r) => (r as unknown as SummaryTxnRow).id));
    const aggregates = aggregateDashboard(
      rows as unknown as SummaryTxnRow[],
      accountById,
      itemContext,
    );

    res.json({
      byCategory: Array.from(aggregates.byCategory.values()),
      metricsByCurrency: Array.from(aggregates.metricsByCurrency.values()),
      monthlyByCurrency: Array.from(aggregates.monthlyByCurrency.values()).sort((a, b) =>
        a.month === b.month
          ? a.currency.localeCompare(b.currency)
          : a.month.localeCompare(b.month)
      ),
      netSpendBySplit: Array.from(aggregates.netSpendBySplit.values()),
      netSpendByBusiness: Array.from(aggregates.netSpendByBusiness.values()),
      categoryReports: Array.from(aggregates.categoryReports.values()),
      merchantSummaries: Array.from(aggregates.merchantSummaries.values()).sort((a, b) =>
        a.currency === b.currency
          ? b.netSpend === a.netSpend
            ? b.transactionCount - a.transactionCount
            : b.netSpend - a.netSpend
          : a.currency.localeCompare(b.currency)
      ),
      accountSummaries: Array.from(aggregates.accountSummaries.values()).sort((a, b) =>
        a.currency === b.currency
          ? b.netSpend === a.netSpend
            ? b.transactionCount - a.transactionCount
            : b.netSpend - a.netSpend
          : a.currency.localeCompare(b.currency)
      ),
      reviewQueue: aggregates.reviewQueue
        .sort((a, b) =>
          a.date === b.date ? Math.abs(b.amount) - Math.abs(a.amount) : b.date.localeCompare(a.date)
        )
        .slice(0, 12),
    });
  } catch (e) {
    next(e);
  }
});

// ───────────────────────── /period-insight helpers ─────────────────────────

/**
 * Empty item-allocation context. The period-insight aggregations classify
 * net-spend at the transaction grain (not item grain), so no order/item
 * allocation is needed — pass empty maps to `aggregateDashboard`.
 */
const EMPTY_ITEM_CONTEXT: ItemAllocationContext = {
  linksByTxn: new Map(),
  ordersById: new Map(),
  itemsByOrder: new Map(),
};

/** Row shape loaded for a window: the SummaryTxnRow fields `aggregateDashboard`
 *  needs, plus the owed-back / mover fields. `accountType` is stitched on from
 *  the account map after loading so `isNonCategorical` can see it. */
type PeriodRow = SummaryTxnRow &
  OwedBackRow &
  MoverRow & { accountId: number; partnerShareAmount: string | null };

/**
 * Load the in-range, household-scoped, optionally currency-filtered transaction
 * rows for one window. Selects the full attribute set `aggregateDashboard`
 * consumes so the canonical netSpend matches `/dashboard` exactly.
 */
async function loadPeriodRows(
  req: Request,
  range: DateRange,
  currency: string | null,
): Promise<PeriodRow[]> {
  const where: Record<string, unknown> = {
    ...visibleTransactionWhere(req),
    date: { [Op.between]: [range.from, range.to] },
  };
  if (currency) where.currency = currency;
  const rows = await Transaction.findAll({
    where,
    attributes: [
      'id',
      'accountId',
      'date',
      'currency',
      'finalCategory',
      'finalBusiness',
      'finalSplitType',
      'merchantRaw',
      'merchantClean',
      'merchantCanonical',
      'amount',
      'businessAmount',
      'partnerShareAmount',
      'reviewFlag',
      'txnType',
      'linkedTransactionId',
    ],
    raw: true,
  });
  return rows as unknown as PeriodRow[];
}

/** Stitch `accountType` onto each row from the account map so mover
 *  classification (`isNonCategorical`) can exclude investment-account rows. */
function withAccountType(
  rows: PeriodRow[],
  accountById: Map<number, AccountRow>,
): PeriodRow[] {
  for (const r of rows) {
    r.accountType = accountById.get(r.accountId)?.accountType ?? null;
  }
  return rows;
}

/**
 * Sum the reimbursable claim amount per transaction for claims whose source
 * transaction is dated in the range (ANY status — owedBack is a flow counted
 * regardless of repayment). Joined via the `transaction` association.
 */
async function loadReimbursableByTxn(
  req: Request,
  range: DateRange,
  currency: string | null,
): Promise<Map<number, number>> {
  const rows = await Reimbursement.findAll({
    where: { ...householdWhere(req) },
    attributes: ['transactionId', 'amount'],
    include: [
      {
        model: Transaction,
        as: 'transaction',
        attributes: [],
        where: {
          ...visibleTransactionWhere(req),
          date: { [Op.between]: [range.from, range.to] },
          ...(currency ? { currency } : {}),
        },
        required: true,
      },
    ],
    raw: true,
  });
  const map = new Map<number, number>();
  for (const r of rows as unknown as Array<{ transactionId: number; amount: string }>) {
    const amt = Math.abs(num(r.amount) ?? 0);
    map.set(r.transactionId, (map.get(r.transactionId) ?? 0) + amt);
  }
  return map;
}

/**
 * Span-load variant of `loadReimbursableByTxn` for the contiguous typical
 * window-set: ONE query over the full `[from,to]` span, returning per-claim
 * rows that ALSO carry the source transaction's `date` so the caller can bucket
 * each claim into its window in memory. Same household scope + currency filter +
 * visibility join as `loadReimbursableByTxn`. Replaces the per-window query
 * fan-out (was 1 reimbursable query per typical window).
 */
async function loadReimbursableRowsOverSpan(
  req: Request,
  range: DateRange,
  currency: string | null,
): Promise<Array<{ transactionId: number; amount: string; txnDate: string }>> {
  const rows = await Reimbursement.findAll({
    where: { ...householdWhere(req) },
    attributes: [
      'transactionId',
      'amount',
      [sequelize.col('transaction.date'), 'txnDate'],
    ],
    include: [
      {
        model: Transaction,
        as: 'transaction',
        attributes: [],
        where: {
          ...visibleTransactionWhere(req),
          date: { [Op.between]: [range.from, range.to] },
          ...(currency ? { currency } : {}),
        },
        required: true,
      },
    ],
    raw: true,
  });
  return rows as unknown as Array<{
    transactionId: number;
    amount: string;
    txnDate: string;
  }>;
}

/** Bucket span-loaded reimbursable rows into one `Map<txnId, amount>` per
 *  window by inclusive ISO-date string compare (matches `loadReimbursableByTxn`
 *  output exactly, just sliced per window). */
function bucketReimbursablesByWindow(
  rows: Array<{ transactionId: number; amount: string; txnDate: string }>,
  windows: DateRange[],
): Array<Map<number, number>> {
  const buckets = windows.map(() => new Map<number, number>());
  for (const r of rows) {
    const amt = Math.abs(num(r.amount) ?? 0);
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (r.txnDate >= w.from && r.txnDate <= w.to) {
        const m = buckets[i];
        m.set(r.transactionId, (m.get(r.transactionId) ?? 0) + amt);
        break;
      }
    }
  }
  return buckets;
}

/** Bucket span-loaded transaction rows into one row array per window by
 *  inclusive ISO-date string compare. Windows are contiguous + disjoint, so a
 *  row lands in exactly one. */
function bucketRowsByWindow(
  rows: PeriodRow[],
  windows: DateRange[],
): PeriodRow[][] {
  const buckets: PeriodRow[][] = windows.map(() => []);
  for (const r of rows) {
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (r.date >= w.from && r.date <= w.to) {
        buckets[i].push(r);
        break;
      }
    }
  }
  return buckets;
}

/**
 * Per-window aggregation computed ONCE (not once per currency). `aggregateDashboard`
 * and `computeOwedBack` both return per-currency maps in a single pass, so we
 * cache their results per window and read `.get(cur)` per currency in
 * `windowTotals` — avoiding re-aggregating the same rows once per requested
 * currency.
 */
type WindowAgg = {
  netSpendByCur: Map<string, number>;
  owedByCur: ReturnType<typeof computeOwedBack>;
};

function computeWindowAgg(
  rows: PeriodRow[],
  reimb: Map<number, number>,
  accountById: Map<number, AccountRow>,
): WindowAgg {
  const agg = aggregateDashboard(
    rows as unknown as SummaryTxnRow[],
    accountById,
    EMPTY_ITEM_CONTEXT,
  );
  const netSpendByCur = new Map<string, number>();
  for (const [cur, m] of agg.metricsByCurrency) netSpendByCur.set(cur, m.netSpend);
  return { netSpendByCur, owedByCur: computeOwedBack(rows, reimb) };
}

/** Canonical netSpend + owedBack/realCost for one window, for one currency,
 *  read from the window's precomputed aggregation. */
function windowTotals(
  wa: WindowAgg,
  cur: string,
): { realCost: number; owedBack: number } {
  const netSpend = wa.netSpendByCur.get(cur) ?? 0;
  const o = wa.owedByCur.get(cur) ?? {
    owedBack: 0,
    reimbursable: 0,
    partnerShare: 0,
  };
  return { realCost: realCostOf(netSpend, o.owedBack), owedBack: o.owedBack };
}

/**
 * GET /api/summary/period-insight — range-aware decomposition of net-spend into
 * realCost (true consumption) vs owedBack (loaned out this period), with
 * baselines (prior period / same period last year / typical) and category
 * movers. Pure helpers live in summary/periodRanges.ts + summary/periodInsight.ts.
 */
router.get('/period-insight', async (req, res, next) => {
  try {
    const currency =
      typeof req.query.currency === 'string' && req.query.currency
        ? req.query.currency.toUpperCase().slice(0, 3)
        : null;
    const from = String(req.query.dateFrom ?? '');
    const to = String(req.query.dateTo ?? '');
    if (!from || !to) {
      res.status(400).json({ error: 'dateFrom and dateTo are required' });
      return;
    }

    // Range detection + all derived window ranges. The pure helpers in
    // periodRanges.ts THROW a `RangeValidationError` (status 400) on a
    // malformed or inverted range (e.g. dateFrom=2026-13-99). Catch only that
    // validation error here and map it to a clean 400 — every other throw
    // propagates to `next(e)` as a real 500. We compute all ranges up front so
    // the whole validation surface is inside one guarded block.
    let kind: PeriodRangeKind;
    let priorRange: DateRange;
    let splyRange: DateRange | null;
    let tw: TypicalWindows;
    try {
      kind = detectRangeKind(from, to);
      priorRange = priorPeriod(from, to, kind);
      splyRange = samePeriodLastYear(from, to, kind);
      tw = typicalWindows(from, to, kind);
    } catch (e) {
      if (e instanceof RangeValidationError) {
        res.status(400).json({ error: e.message });
        return;
      }
      throw e;
    }

    // Account map (shared across all window aggregations).
    const accounts = await Account.findAll({
      where: visibleAccountWhere(req),
      attributes: ['id', 'name', 'shortCode', 'accountType'],
      raw: true,
    });
    const accountById = new Map<number, AccountRow>(
      (accounts as unknown as AccountRow[]).map((a) => [a.id, a]),
    );

    // Main window rows + reimbursables.
    const [mainRowsRaw, reimbursableByTxn] = await Promise.all([
      loadPeriodRows(req, { from, to }, currency),
      loadReimbursableByTxn(req, { from, to }, currency),
    ]);
    const mainRows = withAccountType(mainRowsRaw, accountById);

    // Canonical netSpend per currency via the existing aggregator.
    const agg = aggregateDashboard(
      mainRows as unknown as SummaryTxnRow[],
      accountById,
      EMPTY_ITEM_CONTEXT,
    );
    const owed = computeOwedBack(mainRows, reimbursableByTxn);

    // Baseline window definitions (single-window baselines).
    const baselineDefs: Array<{
      key: PeriodInsightBaseline['key'];
      label: string;
      range: DateRange;
    }> = [
      { key: 'prior-period', label: 'prior period', range: priorRange },
    ];
    if (splyRange) {
      baselineDefs.push({
        key: 'same-period-last-year',
        label: 'same period last year',
        range: splyRange,
      });
    }

    // Load each single-window baseline's rows + reimbursables once, then
    // precompute its per-currency aggregation once (read per currency below).
    // `prior-period` rows are also retained for the mover fallback.
    const baselineRowsByKey = new Map<string, PeriodRow[]>();
    const baselineAggByKey = new Map<string, WindowAgg>();
    for (const def of baselineDefs) {
      const [rowsRaw, reimb] = await Promise.all([
        loadPeriodRows(req, def.range, currency),
        loadReimbursableByTxn(req, def.range, currency),
      ]);
      const rows = withAccountType(rowsRaw, accountById);
      baselineRowsByKey.set(def.key, rows);
      baselineAggByKey.set(def.key, computeWindowAgg(rows, reimb, accountById));
    }

    // Typical windows — load only when the kind defines them. The baseline gate
    // is on POPULATED periods (windows with real transactions), NOT on window
    // COUNT: `typicalWindows()` always returns 12 month-windows (or 4 quarter-
    // windows), so a household with only 1–2 months of history must NOT get a
    // `typical` chip diluted across empty windows (spec §2: "≥ N complete/
    // populated periods", and the average is over POPULATED periods only).
    //
    // Populated-ness is counted PER CURRENCY: a window is populated for `cur`
    // when it has rows in `cur`. `loadPeriodRows` already applies the currency
    // filter when `currency` is set, so when a single currency is requested
    // `rows.length > 0` is exactly that currency's populated-ness; when currency
    // is null we assemble per-currency below by inspecting each window's rows.
    //
    // FAN-OUT COLLAPSE: the typical windows are CONTIGUOUS (trailing N
    // months/quarters), so instead of one rows + one reimbursable query PER
    // window (~24 queries for 12 month-windows), we issue ONE rows query and
    // ONE reimbursable query over the full span `[oldest.from, newest.to]`,
    // then bucket the loaded rows/claims into each window in memory by inclusive
    // ISO-date string compare. The per-window arrays (`typicalLoaded`,
    // `typicalReimb`) are byte-identical to the old per-window loads, so all
    // downstream populated-window detection + averaging is unchanged.
    let typicalLoaded: PeriodRow[][] = tw.windows.map(() => []);
    let typicalAggs: WindowAgg[] = tw.windows.map(() =>
      computeWindowAgg([], new Map(), accountById),
    );
    if (tw.windows.length > 0) {
      // Windows are emitted most-recent-first, so span = first.to … last.from.
      const spanFrom = tw.windows[tw.windows.length - 1].from;
      const spanTo = tw.windows[0].to;
      const span: DateRange = { from: spanFrom, to: spanTo };
      const [spanRowsRaw, spanReimbRows] = await Promise.all([
        loadPeriodRows(req, span, currency),
        loadReimbursableRowsOverSpan(req, span, currency),
      ]);
      const spanRows = withAccountType(spanRowsRaw, accountById);
      typicalLoaded = bucketRowsByWindow(spanRows, tw.windows);
      const typicalReimb = bucketReimbursablesByWindow(spanReimbRows, tw.windows);
      typicalAggs = typicalLoaded.map((rows, i) =>
        computeWindowAgg(rows, typicalReimb[i], accountById),
      );
    }

    // All-time outstanding reimbursements (expected | overdue) per currency.
    // Partner-balance component is intentionally DEFERRED in v1 (see PR body).
    const allReimb = await Reimbursement.findAll({
      where: { ...householdWhere(req) },
      attributes: ['amount', 'currency', 'status', 'dueDate'],
      raw: true,
    });
    const today = todayIso();
    const outstandingByCur = new Map<string, number>();
    for (const r of allReimb as unknown as Array<{
      amount: string;
      currency: string;
      status: import('../models/Reimbursement').ReimbursementStatus;
      dueDate: string | null;
    }>) {
      const eff = computeEffectiveStatus(r, today);
      if (eff === 'expected' || eff === 'overdue') {
        const amt = Math.abs(num(r.amount) ?? 0);
        outstandingByCur.set(r.currency, (outstandingByCur.get(r.currency) ?? 0) + amt);
      }
    }

    // Assemble per currency.
    const byCurrency: PeriodInsightCurrency[] = [];
    for (const [cur, metrics] of agg.metricsByCurrency) {
      const o = owed.get(cur) ?? { owedBack: 0, reimbursable: 0, partnerShare: 0 };
      const realCost = realCostOf(metrics.netSpend, o.owedBack);

      // Single-window baselines — omit a baseline that has no data (never fake).
      const baselines: PeriodInsightBaseline[] = [];
      for (const def of baselineDefs) {
        const wt = windowTotals(baselineAggByKey.get(def.key)!, cur);
        if (wt.realCost === 0 && wt.owedBack === 0) continue;
        baselines.push({
          key: def.key,
          label: def.label,
          realCost: wt.realCost,
          realCostDeltaPct: deltaPct(realCost, wt.realCost),
          owedBack: wt.owedBack,
          owedBackDeltaPct: deltaPct(o.owedBack, wt.owedBack),
        });
      }

      // Typical baseline — average across the POPULATED trailing windows only.
      // A window counts as populated for `cur` when it has at least one row in
      // `cur` (row presence, NOT realCost !== 0: a populated month can legitimately
      // net near zero). Gate on populatedCount >= minRequired; if fewer, OMIT the
      // typical baseline entirely rather than diluting it across empty windows.
      let populatedCount = 0;
      let sumReal = 0;
      let sumOwed = 0;
      for (let i = 0; i < typicalLoaded.length; i++) {
        const rows = typicalLoaded[i];
        const populated = rows.some((r) => r.currency === cur);
        if (!populated) continue;
        populatedCount += 1;
        const wt = windowTotals(typicalAggs[i], cur);
        sumReal += wt.realCost;
        sumOwed += wt.owedBack;
      }
      const typicalAvailable =
        tw.windows.length > 0 && populatedCount >= tw.minRequired;
      if (typicalAvailable) {
        const avgReal = sumReal / populatedCount;
        const avgOwed = sumOwed / populatedCount;
        baselines.push({
          key: 'typical',
          label: 'typical',
          realCost: avgReal,
          realCostDeltaPct: deltaPct(realCost, avgReal),
          owedBack: avgOwed,
          owedBackDeltaPct: deltaPct(o.owedBack, avgOwed),
        });
      }

      // Movers — vs the typical window-set (concatenated; divide baseline by the
      // number of POPULATED typical windows actually summed for a per-period
      // comparison) when available, else prior-period (N=1).
      const usingTypical = typicalAvailable;
      const moverBaselineRows = usingTypical
        ? typicalLoaded.flat()
        : baselineRowsByKey.get('prior-period')!;
      const moverDivisor = usingTypical ? populatedCount : 1;
      const movers = topCategoryMovers(
        mainRows as unknown as MoverRow[],
        moverBaselineRows as unknown as MoverRow[],
        cur,
        3,
        moverDivisor,
      );

      byCurrency.push({
        currency: cur,
        netSpend: metrics.netSpend,
        realCost,
        owedBack: o.owedBack,
        owedBackBreakdown: { reimbursable: o.reimbursable, partnerShare: o.partnerShare },
        // v1: not cleanly derivable per-period from receivedAt alone; left at 0.
        collectedThisPeriod: 0,
        receivablesOutstanding: outstandingByCur.get(cur) ?? 0,
        rangeKind: kind,
        baselines,
        movers,
      });
    }

    const body: PeriodInsightResp = { byCurrency };
    res.json(body);
  } catch (e) {
    next(e);
  }
});

router.get('/partner', async (req, res, next) => {
  try {
    const where = dateWhere(req);
    // Filter settlements by the same date range and currency. The `from`/`to`
    // (settledDate) constraints mirror the transaction date filter so closing
    // out an old debt outside the window doesn't leak into a narrow report.
    const settlementWhere: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.dateFrom || req.query.dateTo) {
      const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
      if (req.query.dateFrom) dateCond[Op.gte] = String(req.query.dateFrom);
      if (req.query.dateTo) dateCond[Op.lte] = String(req.query.dateTo);
      settlementWhere.settledDate = dateCond;
    }
    if (req.query.currency) {
      settlementWhere.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const [rows, contacts, settlementRows] = await Promise.all([
      Transaction.findAll({
        where,
        attributes: [
          'currency',
          'ownershipType',
          'ownershipContactId',
          [sequelize.fn('SUM', sequelize.col('my_share_amount')), 'sumMy'],
          [
            sequelize.fn('SUM', sequelize.col('partner_share_amount')),
            'sumPartner',
          ],
        ],
        group: ['currency', 'ownershipType', 'ownershipContactId'],
        raw: true,
      }),
      Contact.findAll({ where: householdWhere(req), raw: true }),
      PartnerSettlement.findAll({
        where: settlementWhere,
        attributes: ['contactId', 'currency', 'direction', 'amount'],
        raw: true,
      }),
    ]);
    type PartnerRow = {
      currency: string;
      ownershipType: string;
      ownershipContactId: number | null;
      sumMy: unknown;
      sumPartner: unknown;
    };
    type ContactRow = { id: number; name: string };
    type SettlementRow = {
      contactId: number;
      currency: string;
      direction: 'i_paid_partner' | 'partner_paid_me';
      amount: unknown;
    };
    const contactsById = new Map((contacts as ContactRow[]).map((c) => [c.id, c.name]));

    // Aggregate raw settlement rows into per-(contact, currency) summaries.
    const settlementByKey = new Map<string, SettlementSummary>();
    for (const s of settlementRows as unknown as SettlementRow[]) {
      const amount = num(s.amount) ?? 0;
      const key = `${s.contactId}\0${s.currency}`;
      const existing = settlementByKey.get(key) ?? {
        contactId: s.contactId,
        currency: s.currency,
        iPaid: 0,
        partnerPaid: 0,
      };
      if (s.direction === 'i_paid_partner') existing.iPaid += amount;
      else existing.partnerPaid += amount;
      settlementByKey.set(key, existing);
    }

    const rawRows: RawPartnerRow[] = (rows as unknown as PartnerRow[]).map((r) => ({
      currency: r.currency,
      ownershipType: r.ownershipType,
      ownershipContactId: r.ownershipContactId,
      contactName:
        r.ownershipContactId != null ? contactsById.get(r.ownershipContactId) ?? null : null,
      sumMy: num(r.sumMy),
      sumPartner: num(r.sumPartner),
    }));

    res.json({
      byCurrency: applySettlements(rawRows, Array.from(settlementByKey.values())),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/business', async (req, res, next) => {
  try {
    const where = {
      ...dateWhere(req),
      finalBusiness: true,
    };
    const rows = await Transaction.findAll({
      where,
      attributes: [
        'currency',
        [sequelize.fn('SUM', sequelize.col('business_amount')), 'sumBusiness'],
      ],
      group: ['currency'],
      raw: true,
    });
    type BizRow = { currency: string; sumBusiness: unknown };
    res.json({
      byCurrency: (rows as unknown as BizRow[]).map((r) => ({
        currency: r.currency,
        sumBusiness: num(r.sumBusiness),
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** Total spend (sum of amount) by calendar month and currency */
router.get('/monthly', async (req, res, next) => {
  try {
    const where = dateWhere(req);
    // Join account_type so we can exclude any negative row on an
    // investment account from the spend curve. Same belt-and-suspenders
    // rationale as the /dashboard route — see isNonSpend above.
    const [rows, accounts] = await Promise.all([
      Transaction.findAll({
        where,
        attributes: [
          'id',
          'accountId',
          'date',
          'currency',
          'merchantRaw',
          'merchantClean',
          'finalCategory',
          'finalBusiness',
          'finalSplitType',
          'businessAmount',
          'amount',
          'txnType',
        ],
        raw: true,
      }),
      Account.findAll({
        where: visibleAccountWhere(req),
        attributes: ['id', 'accountType'],
        raw: true,
      }),
    ]);
    const accountTypeById = new Map<number, string | null>(
      (accounts as unknown as Array<{ id: number; accountType: string | null }>).map((a) => [
        a.id,
        a.accountType,
      ]),
    );

    const txnIds = (rows as unknown as Array<{ id: number }>).map((r) => r.id);
    const itemContext = await loadItemAllocationContext(txnIds);
    const { points, categoryPoints } = aggregateMonthly(
      rows as unknown as MonthlyTxnRow[],
      accountTypeById,
      itemContext,
    );
    res.json({
      points: points.sort((a, b) =>
        a.month === b.month
          ? a.currency.localeCompare(b.currency)
          : a.month.localeCompare(b.month)
      ),
      categoryPoints: categoryPoints.sort((a, b) => {
        if (a.month !== b.month) return a.month.localeCompare(b.month);
        if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
        return (a.category ?? '').localeCompare(b.category ?? '');
      }),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
