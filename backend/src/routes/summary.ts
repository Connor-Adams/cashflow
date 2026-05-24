import { Router } from 'express';
import type { Request } from 'express';
import { Op } from 'sequelize';
import { Account, Contact, PartnerSettlement, Transaction, sequelize } from '../models';
import { num } from '../util/numbers';
import {
  aggregateDashboard,
  type AccountRow,
  type SummaryTxnRow,
} from '../summary/aggregateDashboard';
import {
  aggregateMonthly,
  type MonthlyTxnRow,
} from '../summary/aggregateMonthly';
import {
  applySettlements,
  type RawPartnerRow,
  type SettlementSummary,
} from '../summary/partnerMath';
import { householdWhere, visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';

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
          'reviewFlag',
          'txnType',
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

    const aggregates = aggregateDashboard(
      rows as unknown as SummaryTxnRow[],
      accountById,
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
          'accountId',
          'date',
          'currency',
          'merchantRaw',
          'merchantClean',
          'finalCategory',
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

    const points = aggregateMonthly(rows as unknown as MonthlyTxnRow[], accountTypeById);
    res.json({
      points: points.sort((a, b) =>
        a.month === b.month
          ? a.currency.localeCompare(b.currency)
          : a.month.localeCompare(b.month)
      ),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
