import { Router } from 'express';
import { Op } from 'sequelize';
import { Security, SecurityDividend, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { candidatesForDividend } from '../services/dividendMatcher';

const router = Router();

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function serializeDividend(div: SecurityDividend & { security?: Security }): Record<string, unknown> {
  const base = div.toJSON() as Record<string, unknown>;
  if (div.security) {
    base.security = { id: div.security.id, symbol: div.security.symbol };
  }
  return base;
}

// GET /api/dividends?status=upcoming|matched|unmatched&windowMonths=12
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    const windowMonths = Number(req.query.windowMonths ?? 12);

    const today = todayIso();
    const pastCutoff = monthsAgo(Number.isFinite(windowMonths) ? windowMonths : 12);
    const futureCutoff = daysFromNow(30);

    // Find securities held by this household
    const txnWhere = visibleTransactionWhere(req);
    const heldSecurityIds = await (async () => {
      const { HoldingSnapshot } = await import('../models');
      const snapshots = await HoldingSnapshot.findAll({
        where: { accountId: { [Op.ne]: null } },
        include: [
          {
            model: Security,
            as: 'security',
            required: true,
            where: { householdId: household.id },
          },
        ],
        attributes: ['securityId'],
        group: ['securityId'],
      });
      return snapshots.map((s) => s.securityId).filter((id): id is number => id != null);
    })();

    if (heldSecurityIds.length === 0) {
      res.json([]);
      return;
    }

    let where: Record<string, unknown> = {
      securityId: { [Op.in]: heldSecurityIds },
    };

    if (status === 'upcoming') {
      where = {
        ...where,
        paymentDate: { [Op.between]: [today, futureCutoff] },
      };
    } else if (status === 'matched') {
      where = {
        ...where,
        matchedTransactionId: { [Op.ne]: null },
        [Op.or]: [
          { paymentDate: { [Op.between]: [pastCutoff, today] } },
          { paymentDate: null, exDividendDate: { [Op.between]: [pastCutoff, today] } },
        ],
      };
    } else if (status === 'unmatched') {
      where = {
        ...where,
        matchedTransactionId: null,
        [Op.or]: [
          { paymentDate: { [Op.between]: [pastCutoff, today] } },
          { paymentDate: null, exDividendDate: { [Op.between]: [pastCutoff, today] } },
        ],
      };
    } else {
      // all
      where = {
        ...where,
        [Op.or]: [
          { paymentDate: { [Op.between]: [pastCutoff, futureCutoff] } },
          { paymentDate: null, exDividendDate: { [Op.between]: [pastCutoff, futureCutoff] } },
        ],
      };
    }

    const dividends = await SecurityDividend.findAll({
      where,
      include: [{ model: Security, as: 'security' }],
      order: [['paymentDate', 'DESC']],
      limit: 500,
    });

    res.json(dividends.map((d) => serializeDividend(d as SecurityDividend & { security?: Security })));
  } catch (e) {
    next(e);
  }
});

// GET /api/dividends/:id/candidates — candidate transactions for manual match
router.get('/:id/candidates', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const dividend = await SecurityDividend.findOne({
      where: { id },
      include: [
        {
          model: Security,
          as: 'security',
          required: true,
          where: { householdId: household.id },
        },
      ],
    });
    if (!dividend) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const candidates = await candidatesForDividend(dividend, household.id, 30);
    res.json(candidates.slice(0, 20));
  } catch (e) {
    next(e);
  }
});

// POST /api/dividends/:id/match { transactionId }
router.post('/:id/match', async (req, res, next) => {
  try {
    const { household, user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const dividend = await SecurityDividend.findOne({
      where: { id },
      include: [
        {
          model: Security,
          as: 'security',
          required: true,
          where: { householdId: household.id },
        },
      ],
    });
    if (!dividend) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const transactionId = Number((req.body as { transactionId?: unknown }).transactionId);
    if (!Number.isFinite(transactionId)) {
      res.status(400).json({ error: 'transactionId is required' });
      return;
    }

    const txnWhere = visibleTransactionWhere(req);
    const txn = await Transaction.findOne({
      where: { id: transactionId, ...(txnWhere as object) },
    });
    if (!txn) {
      res.status(403).json({ error: 'transaction not in scope' });
      return;
    }

    await dividend.update({ matchedTransactionId: transactionId, matchedAt: new Date() });
    res.json(dividend.toJSON());
  } catch (e) {
    next(e);
  }
});

// POST /api/dividends/:id/unmatch
router.post('/:id/unmatch', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const dividend = await SecurityDividend.findOne({
      where: { id },
      include: [
        {
          model: Security,
          as: 'security',
          required: true,
          where: { householdId: household.id },
        },
      ],
    });
    if (!dividend) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    await dividend.update({ matchedTransactionId: null, matchedAt: null });
    res.json(dividend.toJSON());
  } catch (e) {
    next(e);
  }
});

export default router;
