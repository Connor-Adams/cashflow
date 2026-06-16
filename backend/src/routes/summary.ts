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
  computeOwedBack,
  realCostOf,
  type OwedBackRow,
} from '../summary/periodInsight';
import { householdWhere, visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';
import type { PeriodInsightResp, PeriodInsightCurrency } from '@cashflow/shared';

/** One window's inclusive ISO date range. */
type DateRange = { from: string; to: string };

/** Shape gate for an ISO calendar date string `YYYY-MM-DD`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real `YYYY-MM-DD` calendar date: passes the shape gate AND round-trips
 * through `Date.UTC` to its own components (so `2026-13-99` — shape-valid but
 * an impossible month/day — is rejected). Returns false for any non-string.
 */
function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

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

/** Row shape loaded for the period window: the SummaryTxnRow fields
 *  `aggregateDashboard` needs, plus the owed-back fields. `accountType` is
 *  stitched on from the account map after loading. */
type PeriodRow = SummaryTxnRow &
  OwedBackRow & {
    accountId: number;
    partnerShareAmount: string | null;
    accountType?: string | null;
  };

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

/** Stitch `accountType` onto each loaded row from the account map. Kept so the
 *  period rows carry the account's type alongside the owed-back fields. */
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
 * GET /api/summary/period-insight — PERIOD-SCOPED decomposition of net-spend
 * into realCost (true consumption) vs owedBack (loaned out this period), plus a
 * "where the money moved this period" breakdown (spend / credits / income /
 * payments). No cross-period comparison, no all-time outstanding stock, no
 * per-category drill-down — everything is computed over the single requested
 * window. Pure helpers live in summary/periodInsight.ts.
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
    // Date-shape guard: reject anything that is not a real `YYYY-MM-DD`
    // calendar date (rejects both wrong shape and impossible dates like
    // 2026-13-99). Replaces the old range-validation path.
    if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
      res.status(400).json({ error: 'invalid date' });
      return;
    }

    // Account map (shared across the window aggregation).
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

    // Canonical per-currency metrics via the existing aggregator.
    const agg = aggregateDashboard(
      mainRows as unknown as SummaryTxnRow[],
      accountById,
      EMPTY_ITEM_CONTEXT,
    );
    const owed = computeOwedBack(mainRows, reimbursableByTxn);

    // Assemble per currency — everything period-scoped, read off the one window.
    const byCurrency: PeriodInsightCurrency[] = [];
    for (const [cur, metrics] of agg.metricsByCurrency) {
      const o = owed.get(cur) ?? { owedBack: 0, reimbursable: 0, partnerShare: 0 };
      byCurrency.push({
        currency: cur,
        netSpend: metrics.netSpend,
        realCost: realCostOf(metrics.netSpend, o.owedBack),
        owedBack: o.owedBack,
        owedBackBreakdown: { reimbursable: o.reimbursable, partnerShare: o.partnerShare },
        totalSpend: metrics.totalSpend,
        totalCredits: metrics.totalCredits,
        totalIncome: metrics.totalIncome,
        totalPayments: metrics.totalPayments,
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
