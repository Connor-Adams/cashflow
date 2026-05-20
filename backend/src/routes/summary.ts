import { Router } from 'express';
import type { Request } from 'express';
import { Op } from 'sequelize';
import { Account, Contact, PartnerSettlement, Transaction, sequelize } from '../models';
import { num } from '../util/numbers';
import { classifyPositiveFlow } from '../summary/classifyTransactionFlow';
import { householdWhere, visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';

const router = Router();

function dateWhere(req: Request) {
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
          'amount',
          'reviewFlag',
        ],
        raw: true,
      }),
      Account.findAll({
        where: visibleAccountWhere(req),
        attributes: ['id', 'name', 'shortCode'],
        raw: true,
      }),
    ]);

    type SummaryTxnRow = {
      id: number;
      accountId: number;
      date: string;
      currency: string;
      finalCategory: string | null;
      finalBusiness: boolean;
      finalSplitType: string;
      merchantRaw: string | null;
      merchantClean: string | null;
      amount: unknown;
      reviewFlag: boolean;
    };
    type AccountRow = { id: number; name: string; shortCode: string | null };

    const accountById = new Map<number, AccountRow>(
      (accounts as unknown as AccountRow[]).map((account) => [account.id, account])
    );

    const byCategory = new Map<
      string,
      {
        currency: string;
        category: string | null;
        finalBusiness: boolean;
        finalSplitType: string;
        sumAmount: number;
      }
    >();
    const metricsByCurrency = new Map<
      string,
      {
        currency: string;
        totalSpend: number;
        totalCredits: number;
        totalPayments: number;
        netSpend: number;
        transactionCount: number;
      }
    >();
    const monthlyByCurrency = new Map<
      string,
      {
        month: string;
        currency: string;
        totalSpend: number;
        totalCredits: number;
        totalPayments: number;
        netSpend: number;
      }
    >();
    const netSpendBySplit = new Map<
      string,
      {
        currency: string;
        splitType: string;
        totalSpend: number;
        totalCredits: number;
        netSpend: number;
      }
    >();
    const netSpendByBusiness = new Map<
      string,
      {
        currency: string;
        business: boolean;
        totalSpend: number;
        totalCredits: number;
        netSpend: number;
      }
    >();
    const categoryReports = new Map<
      string,
      {
        currency: string;
        category: string | null;
        totalSpend: number;
        totalCredits: number;
        netSpend: number;
      }
    >();
    const merchantSummaries = new Map<
      string,
      {
        currency: string;
        merchant: string;
        totalSpend: number;
        totalCredits: number;
        totalPayments: number;
        netSpend: number;
        transactionCount: number;
        lastDate: string;
        reviewCount: number;
      }
    >();
    const accountSummaries = new Map<
      string,
      {
        currency: string;
        accountId: number;
        accountName: string;
        accountShortCode: string | null;
        totalSpend: number;
        totalCredits: number;
        totalPayments: number;
        netSpend: number;
        transactionCount: number;
        reviewCount: number;
      }
    >();
    const reviewQueue: Array<{
      id: number;
      date: string;
      currency: string;
      merchant: string;
      accountName: string;
      category: string | null;
      amount: number;
    }> = [];

    for (const row of rows as unknown as SummaryTxnRow[]) {
      const amount = num(row.amount);
      if (amount == null) continue;
      const currency = row.currency;
      const month = row.date.slice(0, 7);
      const merchant =
        row.merchantClean?.trim() || row.merchantRaw?.trim() || '(unknown merchant)';
      const account = accountById.get(row.accountId);
      const accountName = account?.name ?? `Account ${row.accountId}`;
      const metrics = metricsByCurrency.get(currency) ?? {
        currency,
        totalSpend: 0,
        totalCredits: 0,
        totalPayments: 0,
        netSpend: 0,
        transactionCount: 0,
      };
      metrics.transactionCount += 1;

      const positiveKind =
        amount > 0
          ? classifyPositiveFlow({
              merchantRaw: row.merchantRaw,
              merchantClean: row.merchantClean,
              category: row.finalCategory,
            })
          : null;
      const merchantKey = `${currency}\0${merchant}`;
      const merchantSummary = merchantSummaries.get(merchantKey) ?? {
        currency,
        merchant,
        totalSpend: 0,
        totalCredits: 0,
        totalPayments: 0,
        netSpend: 0,
        transactionCount: 0,
        lastDate: row.date,
        reviewCount: 0,
      };
      merchantSummary.transactionCount += 1;
      if (row.date > merchantSummary.lastDate) merchantSummary.lastDate = row.date;
      if (row.reviewFlag) merchantSummary.reviewCount += 1;

      const accountKey = `${currency}\0${row.accountId}`;
      const accountSummary = accountSummaries.get(accountKey) ?? {
        currency,
        accountId: row.accountId,
        accountName,
        accountShortCode: account?.shortCode ?? null,
        totalSpend: 0,
        totalCredits: 0,
        totalPayments: 0,
        netSpend: 0,
        transactionCount: 0,
        reviewCount: 0,
      };
      accountSummary.transactionCount += 1;
      if (row.reviewFlag) accountSummary.reviewCount += 1;

      if (amount < 0) {
        metrics.totalSpend += -amount;
        merchantSummary.totalSpend += -amount;
        accountSummary.totalSpend += -amount;
      } else if (amount > 0 && positiveKind === 'payment') {
        metrics.totalPayments += amount;
        merchantSummary.totalPayments += amount;
        accountSummary.totalPayments += amount;
      } else if (amount > 0) {
        metrics.totalCredits += amount;
        merchantSummary.totalCredits += amount;
        accountSummary.totalCredits += amount;
      }
      metrics.netSpend = metrics.totalSpend - metrics.totalCredits;
      merchantSummary.netSpend = merchantSummary.totalSpend - merchantSummary.totalCredits;
      accountSummary.netSpend = accountSummary.totalSpend - accountSummary.totalCredits;
      metricsByCurrency.set(currency, metrics);
      merchantSummaries.set(merchantKey, merchantSummary);
      accountSummaries.set(accountKey, accountSummary);

      if (row.reviewFlag) {
        reviewQueue.push({
          id: row.id,
          date: row.date,
          currency,
          merchant,
          accountName,
          category: row.finalCategory,
          amount,
        });
      }

      if (amount > 0 && positiveKind === 'payment') {
        continue;
      }
      const key = [
        row.currency,
        row.finalCategory ?? '',
        row.finalBusiness ? '1' : '0',
        row.finalSplitType,
      ].join('\0');
      const existing = byCategory.get(key) ?? {
        currency: row.currency,
        category: row.finalCategory,
        finalBusiness: row.finalBusiness,
        finalSplitType: row.finalSplitType,
        sumAmount: 0,
      };
      existing.sumAmount += amount;
      byCategory.set(key, existing);

      const monthlyKey = `${month}\0${currency}`;
      const monthly = monthlyByCurrency.get(monthlyKey) ?? {
        month,
        currency,
        totalSpend: 0,
        totalCredits: 0,
        totalPayments: 0,
        netSpend: 0,
      };
      const splitKey = `${currency}\0${row.finalSplitType}`;
      const split = netSpendBySplit.get(splitKey) ?? {
        currency,
        splitType: row.finalSplitType,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      };
      const businessKey = `${currency}\0${row.finalBusiness ? '1' : '0'}`;
      const business = netSpendByBusiness.get(businessKey) ?? {
        currency,
        business: row.finalBusiness,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      };
      const categoryKey = `${currency}\0${row.finalCategory ?? ''}`;
      const category = categoryReports.get(categoryKey) ?? {
        currency,
        category: row.finalCategory,
        totalSpend: 0,
        totalCredits: 0,
        netSpend: 0,
      };

      if (amount < 0) {
        const spend = -amount;
        monthly.totalSpend += spend;
        split.totalSpend += spend;
        business.totalSpend += spend;
        category.totalSpend += spend;
      } else {
        monthly.totalCredits += amount;
        split.totalCredits += amount;
        business.totalCredits += amount;
        category.totalCredits += amount;
      }
      monthly.netSpend = monthly.totalSpend - monthly.totalCredits;
      split.netSpend = split.totalSpend - split.totalCredits;
      business.netSpend = business.totalSpend - business.totalCredits;
      category.netSpend = category.totalSpend - category.totalCredits;
      monthlyByCurrency.set(monthlyKey, monthly);
      netSpendBySplit.set(splitKey, split);
      netSpendByBusiness.set(businessKey, business);
      categoryReports.set(categoryKey, category);
    }

    res.json({
      byCategory: Array.from(byCategory.values()),
      metricsByCurrency: Array.from(metricsByCurrency.values()),
      monthlyByCurrency: Array.from(monthlyByCurrency.values()).sort((a, b) =>
        a.month === b.month
          ? a.currency.localeCompare(b.currency)
          : a.month.localeCompare(b.month)
      ),
      netSpendBySplit: Array.from(netSpendBySplit.values()),
      netSpendByBusiness: Array.from(netSpendByBusiness.values()),
      categoryReports: Array.from(categoryReports.values()),
      merchantSummaries: Array.from(merchantSummaries.values()).sort((a, b) =>
        a.currency === b.currency
          ? b.netSpend === a.netSpend
            ? b.transactionCount - a.transactionCount
            : b.netSpend - a.netSpend
          : a.currency.localeCompare(b.currency)
      ),
      accountSummaries: Array.from(accountSummaries.values()).sort((a, b) =>
        a.currency === b.currency
          ? b.netSpend === a.netSpend
            ? b.transactionCount - a.transactionCount
            : b.netSpend - a.netSpend
          : a.currency.localeCompare(b.currency)
      ),
      reviewQueue: reviewQueue
        .sort((a, b) =>
          a.date === b.date ? Math.abs(b.amount) - Math.abs(a.amount) : b.date.localeCompare(a.date)
        )
        .slice(0, 12),
    });
  } catch (e) {
    next(e);
  }
});

export type PartnerNetDirection = 'partner_owes_me' | 'i_owe_partner' | 'even';

/**
 * Compute the net partner balance and a direction label for a single
 * (currency, ownership) row. Net is defined as `sumPartner - sumMy`:
 * positive means the partner owes me, negative means I owe the partner.
 * The direction tolerates sub-cent rounding noise by rounding to 2 decimals
 * before comparing to zero (|net| < 0.005 → 'even').
 */
export function computePartnerNet(
  sumMy: number | null,
  sumPartner: number | null
): { net: number; direction: PartnerNetDirection } {
  const my = sumMy ?? 0;
  const partner = sumPartner ?? 0;
  const net = partner - my;
  const rounded = Math.round(net * 100) / 100;
  let direction: PartnerNetDirection;
  if (rounded > 0) direction = 'partner_owes_me';
  else if (rounded < 0) direction = 'i_owe_partner';
  else direction = 'even';
  return { net, direction };
}

/**
 * Direction is derived from a value already adjusted for sub-cent noise:
 * |value| < 0.005 → 'even'. Same threshold as `computePartnerNet`.
 */
function directionFromNet(net: number): PartnerNetDirection {
  const rounded = Math.round(net * 100) / 100;
  if (rounded > 0) return 'partner_owes_me';
  if (rounded < 0) return 'i_owe_partner';
  return 'even';
}

/** Pre-aggregated settlement totals for a single (contactId, currency) pair. */
export type SettlementSummary = {
  contactId: number;
  currency: string;
  iPaid: number;
  partnerPaid: number;
};

/** Raw partner-split row, prior to settlement adjustment. */
export type RawPartnerRow = {
  currency: string;
  ownershipType: string;
  ownershipContactId: number | null;
  contactName: string | null;
  sumMy: number | null;
  sumPartner: number | null;
};

/** Adjusted partner-split row returned by `/api/summary/partner`. */
export type AdjustedPartnerRow = RawPartnerRow & {
  rawNet: number;
  settledAmount: number;
  settlementCount: number;
  net: number;
  direction: PartnerNetDirection;
};

/**
 * Apply pre-aggregated settlement totals to raw partner rows. Pure function
 * exported so unit tests can exercise the math without spinning up the DB.
 *
 * For each row, finds the settlement summary matching (ownershipContactId,
 * currency) and computes:
 *   settledAmount = iPaid - partnerPaid
 *   net (adjusted) = rawNet + settledAmount
 *
 * Rationale: `i_paid_partner` reduces what I owe → adds to net.
 * `partner_paid_me` reduces what partner owes me → subtracts from net.
 *
 * Edge case: rows without an `ownershipContactId` (legacy split with no
 * contact) cannot match a settlement (settlements require a contactId), so
 * they always get `settledAmount=0`, `settlementCount=0`.
 *
 * Orphan settlements — settlement totals with no matching (contact, currency)
 * row — are intentionally dropped, not surfaced as new rows. We do not want
 * to confuse "I paid partner but had no shared spend" with an ongoing
 * balance.
 */
export function applySettlements(
  rows: RawPartnerRow[],
  settlements: SettlementSummary[]
): AdjustedPartnerRow[] {
  const byKey = new Map<string, SettlementSummary>();
  for (const s of settlements) {
    byKey.set(`${s.contactId}\0${s.currency}`, s);
  }
  return rows.map((r) => {
    const rawNet = (r.sumPartner ?? 0) - (r.sumMy ?? 0);
    let settledAmount = 0;
    let settlementCount = 0;
    if (r.ownershipContactId != null) {
      const match = byKey.get(`${r.ownershipContactId}\0${r.currency}`);
      if (match) {
        settledAmount = match.iPaid - match.partnerPaid;
        // Count any settlement that contributed a non-zero side; we surface
        // the count to the UI so "(after N settlements)" is meaningful.
        settlementCount =
          (match.iPaid > 0 ? 1 : 0) + (match.partnerPaid > 0 ? 1 : 0);
      }
    }
    const net = rawNet + settledAmount;
    return {
      ...r,
      rawNet,
      settledAmount,
      settlementCount,
      net,
      direction: directionFromNet(net),
    };
  });
}

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
    const rows = await Transaction.findAll({
      where,
      attributes: ['date', 'currency', 'merchantRaw', 'merchantClean', 'finalCategory', 'amount'],
      raw: true,
    });

    const points = new Map<string, { month: string; currency: string; sumAmount: number }>();
    for (const row of rows as unknown as {
      date: string;
      currency: string;
      merchantRaw: string | null;
      merchantClean: string | null;
      finalCategory: string | null;
      amount: unknown;
    }[]) {
      const amount = num(row.amount);
      if (amount == null) continue;
      if (
        amount > 0 &&
        classifyPositiveFlow({
          merchantRaw: row.merchantRaw,
          merchantClean: row.merchantClean,
          category: row.finalCategory,
        }) === 'payment'
      ) {
        continue;
      }
      const month = String(row.date).slice(0, 7);
      const key = `${month}\0${row.currency}`;
      const existing = points.get(key) ?? {
        month,
        currency: row.currency,
        sumAmount: 0,
      };
      existing.sumAmount += amount;
      points.set(key, existing);
    }
    res.json({
      points: Array.from(points.values()).sort((a, b) =>
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
