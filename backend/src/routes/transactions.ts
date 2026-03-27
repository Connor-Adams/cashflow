import { Router } from 'express';
import { Op } from 'sequelize';
import { Transaction, Account } from '../models';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { serializeTransaction } from '../util/serializeTransaction';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.pageSize || '25'), 10))
    );
    const offset = (page - 1) * pageSize;

    const where: Record<string, unknown> = {};
    if (req.query.accountId) {
      where.accountId = parseInt(String(req.query.accountId), 10);
    }
    if (req.query.reviewFlag === 'true') where.reviewFlag = true;
    if (req.query.reviewFlag === 'false') where.reviewFlag = false;
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }
    if (req.query.category) {
      where.finalCategory = String(req.query.category);
    }
    if (req.query.dateFrom || req.query.dateTo) {
      const dateCond: { [Op.gte]?: string; [Op.lte]?: string } = {};
      if (req.query.dateFrom) dateCond[Op.gte] = String(req.query.dateFrom);
      if (req.query.dateTo) dateCond[Op.lte] = String(req.query.dateTo);
      where.date = dateCond;
    }

    const { rows, count } = await Transaction.findAndCountAll({
      where,
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset,
    });

    res.json({
      data: rows.map(serializeTransaction),
      page,
      pageSize,
      total: count,
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const txn = await Transaction.findByPk(id);
    if (!txn) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const b = (req.body || {}) as Record<string, unknown>;
    const allowed = [
      'categoryOverride',
      'businessOverride',
      'splitOverride',
      'pctMeOverride',
      'pctPartnerOverride',
      'notes',
    ] as const;
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(b, k)) {
        txn.set(k, b[k]);
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, 'reviewFlag')) {
      txn.set('reviewFlag', Boolean(b.reviewFlag));
      if (b.reviewFlag === false) {
        txn.set('reviewedAt', new Date());
      }
    }

    recomputeTransactionAmounts(txn);
    await txn.save();
    await txn.reload({
      include: [{ model: Account, as: 'account', attributes: ['id', 'name', 'shortCode'] }],
    });
    res.json(serializeTransaction(txn));
  } catch (e) {
    next(e);
  }
});

export default router;
