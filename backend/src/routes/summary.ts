import { Router } from 'express';
import type { Request } from 'express';
import { Op } from 'sequelize';
import { Transaction, sequelize } from '../models';
import { num } from '../util/numbers';

const router = Router();

function dateWhere(req: Request) {
  const w: Record<string, unknown> = {};
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
    const rows = await Transaction.findAll({
      where,
      attributes: [
        'currency',
        'finalCategory',
        'finalBusiness',
        'finalSplitType',
        [sequelize.fn('SUM', sequelize.col('amount')), 'sumAmount'],
      ],
      group: [
        'currency',
        'finalCategory',
        'finalBusiness',
        'finalSplitType',
      ],
      raw: true,
    });
    type DashRow = {
      currency: string;
      finalCategory: string | null;
      finalBusiness: boolean;
      finalSplitType: string;
      sumAmount: unknown;
    };
    res.json({
      byCategory: (rows as unknown as DashRow[]).map((r) => ({
        currency: r.currency,
        category: r.finalCategory,
        sumAmount: num(r.sumAmount),
        finalBusiness: r.finalBusiness,
        finalSplitType: r.finalSplitType,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/partner', async (req, res, next) => {
  try {
    const where = dateWhere(req);
    const rows = await Transaction.findAll({
      where,
      attributes: [
        'currency',
        [sequelize.fn('SUM', sequelize.col('my_share_amount')), 'sumMy'],
        [
          sequelize.fn('SUM', sequelize.col('partner_share_amount')),
          'sumPartner',
        ],
      ],
      group: ['currency'],
      raw: true,
    });
    type PartnerRow = { currency: string; sumMy: unknown; sumPartner: unknown };
    res.json({
      byCurrency: (rows as unknown as PartnerRow[]).map((r) => ({
        currency: r.currency,
        sumMy: num(r.sumMy),
        sumPartner: num(r.sumPartner),
      })),
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
    const monthExpr = sequelize.fn(
      'strftime',
      '%Y-%m',
      sequelize.col('date'),
    );
    const rows = await Transaction.findAll({
      where,
      attributes: [
        [monthExpr, 'month'],
        'currency',
        [sequelize.fn('SUM', sequelize.col('amount')), 'sumAmount'],
      ],
      group: [monthExpr, 'currency'],
      order: [[monthExpr, 'ASC']],
      raw: true,
    });
    type MonthlyRow = {
      month: string;
      currency: string;
      sumAmount: unknown;
    };
    res.json({
      points: (rows as unknown as MonthlyRow[]).map((r) => ({
        month: r.month,
        currency: r.currency,
        sumAmount: num(r.sumAmount),
      })),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
