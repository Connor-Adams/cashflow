const { Router } = require('express');
const { Op } = require('sequelize');
const { Transaction, sequelize } = require('../models');
const { num } = require('../util/numbers');

const router = Router();

function dateWhere(req) {
  const w = {};
  if (req.query.dateFrom || req.query.dateTo) {
    w.date = {};
    if (req.query.dateFrom) w.date[Op.gte] = String(req.query.dateFrom);
    if (req.query.dateTo) w.date[Op.lte] = String(req.query.dateTo);
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
    res.json({
      byCategory: rows.map((r) => ({
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
    res.json({
      byCurrency: rows.map((r) => ({
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
    res.json({
      byCurrency: rows.map((r) => ({
        currency: r.currency,
        sumBusiness: num(r.sumBusiness),
      })),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
