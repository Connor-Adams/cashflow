import { Router } from 'express';
import type { Request } from 'express';
import { Op } from 'sequelize';
import {
  Contact,
  PartnerSettlement,
  Transaction,
} from '../models';
import { num } from '../util/numbers';
import {
  buildFairnessByCurrency,
  buildFairnessMonthly,
  buildSettlementRecommendation,
  type SettlementTotals,
  type SharedTxnRow,
} from '../summary/partnerFairness';
import {
  householdWhere,
  visibleTransactionWhere,
} from '../auth/scope';

const router = Router();

/**
 * Build the WHERE clause for the shared-transaction scan. Mirrors
 * `summary.ts:dateWhere` so the partner-fairness view stays in lock-step
 * with the existing partner totals — same scope, same date/currency
 * filters.
 *
 * Critically, we don't filter rows to `partner_share_amount != 0` at the
 * SQL level. We compute the share at the application layer so a single
 * SELECT brings back the rows the largest-shared and category-breakdown
 * panels need; SQLite would otherwise re-scan three times.
 */
function dateWhere(req: Request): Record<string, unknown> {
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

function settlementWhere(req: Request): Record<string, unknown> {
  const w: Record<string, unknown> = { ...householdWhere(req) };
  if (req.query.dateFrom || req.query.dateTo) {
    const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
    if (req.query.dateFrom) dateCond[Op.gte] = String(req.query.dateFrom);
    if (req.query.dateTo) dateCond[Op.lte] = String(req.query.dateTo);
    w.settledDate = dateCond;
  }
  if (req.query.currency) {
    w.currency = String(req.query.currency).toUpperCase().slice(0, 3);
  }
  return w;
}

type RawTxnRow = {
  id: number;
  date: string;
  currency: string;
  amount: unknown;
  myShareAmount: unknown;
  partnerShareAmount: unknown;
  finalCategory: string | null;
  merchantClean: string | null;
  merchantRaw: string;
  ownershipType: string;
  ownershipContactId: number | null;
};

type RawSettlementRow = {
  contactId: number;
  currency: string;
  direction: 'i_paid_partner' | 'partner_paid_me';
  amount: unknown;
  settledDate: string;
};

async function loadSharedTxns(req: Request): Promise<{
  sharedRows: SharedTxnRow[];
  settlementTotals: SettlementTotals[];
  monthlySettlements: Array<SettlementTotals & { month: string }>;
}> {
  const [txns, settlements, contacts] = await Promise.all([
    Transaction.findAll({
      where: dateWhere(req),
      attributes: [
        'id',
        'date',
        'currency',
        'amount',
        'myShareAmount',
        'partnerShareAmount',
        'finalCategory',
        'merchantClean',
        'merchantRaw',
        'ownershipType',
        'ownershipContactId',
      ],
      raw: true,
    }),
    PartnerSettlement.findAll({
      where: settlementWhere(req),
      attributes: ['contactId', 'currency', 'direction', 'amount', 'settledDate'],
      raw: true,
    }),
    Contact.findAll({
      where: householdWhere(req),
      attributes: ['id', 'name'],
      raw: true,
    }),
  ]);

  const contactsById = new Map(
    (contacts as Array<{ id: number; name: string }>).map((c) => [c.id, c.name]),
  );

  const sharedRows: SharedTxnRow[] = (txns as unknown as RawTxnRow[]).map((r) => ({
    txnId: r.id,
    date: r.date,
    currency: r.currency,
    category: r.finalCategory,
    merchant: r.merchantClean ?? r.merchantRaw,
    amount: num(r.amount) ?? 0,
    myShare: num(r.myShareAmount) ?? 0,
    partnerShare: num(r.partnerShareAmount) ?? 0,
    ownershipType: r.ownershipType,
    ownershipContactId: r.ownershipContactId,
    contactName:
      r.ownershipContactId != null ? contactsById.get(r.ownershipContactId) ?? null : null,
  }));

  // Roll settlements up two ways: per (contactId, currency) for fairness,
  // and per (contactId, currency, month) for the monthly trend.
  const totalsByKey = new Map<string, SettlementTotals>();
  const monthlyByKey = new Map<string, SettlementTotals & { month: string }>();
  for (const s of settlements as unknown as RawSettlementRow[]) {
    const amount = num(s.amount) ?? 0;
    const totalsKey = `${s.contactId}\0${s.currency}`;
    const existing =
      totalsByKey.get(totalsKey) ??
      ({
        contactId: s.contactId,
        currency: s.currency,
        iPaid: 0,
        partnerPaid: 0,
      } satisfies SettlementTotals);
    if (s.direction === 'i_paid_partner') existing.iPaid += amount;
    else existing.partnerPaid += amount;
    totalsByKey.set(totalsKey, existing);

    const month = s.settledDate.slice(0, 7);
    const monthKey = `${s.contactId}\0${s.currency}\0${month}`;
    const monthly =
      monthlyByKey.get(monthKey) ??
      ({
        contactId: s.contactId,
        currency: s.currency,
        iPaid: 0,
        partnerPaid: 0,
        month,
      });
    if (s.direction === 'i_paid_partner') monthly.iPaid += amount;
    else monthly.partnerPaid += amount;
    monthlyByKey.set(monthKey, monthly);
  }

  return {
    sharedRows,
    settlementTotals: Array.from(totalsByKey.values()),
    monthlySettlements: Array.from(monthlyByKey.values()),
  };
}

function currentMonthBoundaries(now: Date): { start: string; nextStart: string } {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const nextDate = new Date(y, m + 1, 1);
  const nextY = nextDate.getFullYear();
  const nextM = nextDate.getMonth();
  const nextStart = `${nextY}-${String(nextM + 1).padStart(2, '0')}-01`;
  return { start, nextStart };
}

/**
 * GET /api/partner/fairness — per-currency fairness summary:
 *   - sharedSpendTotal, myShareTotal, partnerShareTotal, sharedTransactionCount
 *   - currentMonthSharedSpend (purchases only)
 *   - balance + direction
 *   - paidMore { youCovered, partnerCovered }
 *   - categoryBreakdown (top-8)
 *   - largestShared (top-10)
 *
 * Query: ?currency, ?dateFrom, ?dateTo — same shape as /api/summary/partner.
 */
router.get('/fairness', async (req, res, next) => {
  try {
    const { sharedRows, settlementTotals } = await loadSharedTxns(req);
    const { start, nextStart } = currentMonthBoundaries(new Date());
    const byCurrency = buildFairnessByCurrency(
      sharedRows,
      settlementTotals,
      start,
      nextStart,
    );
    res.json({ byCurrency });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/partner/monthly — historical fairness trend per (currency, YYYY-MM):
 *   - sharedSpend, myShare, partnerShare
 *   - settlementDelta, netDelta, cumulativeBalance
 *
 * cumulativeBalance runs from the earliest month in the dataset (within the
 * requested date range, if any) — caller can omit dateFrom/dateTo for the
 * lifetime view.
 */
router.get('/monthly', async (req, res, next) => {
  try {
    const { sharedRows, monthlySettlements } = await loadSharedTxns(req);
    const points = buildFairnessMonthly(sharedRows, monthlySettlements);
    res.json({ points });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/partner/settlement-recommendation — what should be paid right
 * now to bring the balance to zero, per currency.
 *
 * Mirrors the same scope rules as /fairness; in practice callers will hit
 * this without date filters to get a lifetime recommendation.
 */
router.get('/settlement-recommendation', async (req, res, next) => {
  try {
    const { sharedRows, settlementTotals } = await loadSharedTxns(req);
    const { start, nextStart } = currentMonthBoundaries(new Date());
    const fairness = buildFairnessByCurrency(
      sharedRows,
      settlementTotals,
      start,
      nextStart,
    );
    const recommendations = buildSettlementRecommendation(fairness);
    res.json({ recommendations });
  } catch (e) {
    next(e);
  }
});

export default router;
