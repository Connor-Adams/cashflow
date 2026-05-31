/**
 * Dividend reconciliation API (#305).
 *
 * GET  /api/dividends?status=upcoming|matched|unmatched&windowMonths=12
 * GET  /api/dividends/:id/candidates
 * POST /api/dividends/:id/match      { transactionId }
 * POST /api/dividends/:id/unmatch
 */
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { HoldingSnapshot, Security, SecurityDividend, Transaction } from '../models';
import { findCandidatesForDividend } from '../services/dividendMatcher';

const router = Router();

function addMonths(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function serializeDividend(div: SecurityDividend & { security?: Security; matchedTx?: Transaction | null }) {
  const perShare = Number(div.amount);
  const matchedAmount = div.matchedTx ? Number(div.matchedTx.amount) : null;
  const variancePct =
    matchedAmount != null && perShare > 0
      ? Math.abs(matchedAmount - perShare) / perShare
      : null;
  return {
    id: div.id,
    securityId: div.securityId,
    securitySymbol: div.security?.symbol ?? null,
    securityName: div.security?.name ?? null,
    exDividendDate: div.exDividendDate,
    paymentDate: div.paymentDate,
    recordDate: div.recordDate,
    amount: perShare,
    currency: div.currency,
    matchedTransactionId: div.matchedTransactionId,
    matchedAt: div.matchedAt ? div.matchedAt.toISOString() : null,
    matchedAmount,
    variancePct,
    hasVarianceFlag: variancePct != null && variancePct > 0.05,
  };
}

// GET /api/dividends
router.get('/', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { householdId } = auth;
    const status = typeof req.query.status === 'string' ? req.query.status : 'unmatched';
    const windowMonths = Number(req.query.windowMonths) || 12;
    const today = new Date().toISOString().slice(0, 10);

    let where: Record<string, unknown> = {};

    if (status === 'upcoming') {
      where = { paymentDate: { [Op.gt]: today } };
    } else if (status === 'matched') {
      const cutoff = addMonths(today, windowMonths);
      where = {
        matchedTransactionId: { [Op.not]: null },
        paymentDate: { [Op.gte]: cutoff, [Op.lte]: today },
      };
    } else {
      // unmatched (default)
      const cutoff = addMonths(today, windowMonths);
      where = {
        matchedTransactionId: null,
        paymentDate: { [Op.gte]: cutoff, [Op.lte]: today },
      };
    }

    // Scope to securities held by this household
    const rows = await SecurityDividend.findAll({
      where,
      include: [
        {
          model: Security,
          as: 'security',
          where: { householdId },
          required: true,
          attributes: ['id', 'symbol', 'name'],
        },
      ],
      order: [['paymentDate', 'DESC'], ['exDividendDate', 'DESC']],
      limit: 500,
    });

    // Fetch matched transactions in one batch
    const matchedIds = rows
      .map((r) => r.matchedTransactionId)
      .filter((id): id is number => id != null);
    const txMap = new Map<number, Transaction>();
    if (matchedIds.length > 0) {
      const txns = await Transaction.findAll({
        where: { id: { [Op.in]: matchedIds } },
        attributes: ['id', 'amount', 'date', 'merchantRaw', 'merchantClean', 'currency'],
      });
      for (const tx of txns) txMap.set(tx.id, tx);
    }

    const data = rows.map((div) => {
      const d = div as SecurityDividend & { security?: Security; matchedTx?: Transaction | null };
      d.matchedTx = div.matchedTransactionId != null ? txMap.get(div.matchedTransactionId) ?? null : null;
      return serializeDividend(d);
    });

    res.json({ dividends: data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dividends/:id/candidates
router.get('/:id/candidates', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { householdId } = auth;
    const dividendId = Number(req.params.id);

    const div = await SecurityDividend.findByPk(dividendId, {
      include: [
        {
          model: Security,
          as: 'security',
          where: { householdId },
          required: true,
          attributes: ['id', 'symbol', 'name'],
        },
      ],
    });
    if (!div) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    // Get holding quantity to compute expected total
    const holdings = await HoldingSnapshot.findAll({
      where: {
        securityId: div.securityId,
        householdId,
        statementDate: { [Op.lte]: div.exDividendDate },
      },
      order: [['accountId', 'ASC'], ['statementDate', 'DESC'], ['id', 'DESC']],
    });
    const qtyMap = new Map<number, number>();
    for (const h of holdings) {
      if (!qtyMap.has(h.accountId)) {
        const q = Number(h.quantity);
        if (Number.isFinite(q) && q > 0) qtyMap.set(h.accountId, q);
      }
    }
    const totalQty = Array.from(qtyMap.values()).reduce((s, q) => s + q, 0);
    const expectedTotal = Number(div.amount) * totalQty;

    const candidates = await findCandidatesForDividend(div, householdId, expectedTotal);
    res.json({
      dividendId,
      expectedAmount: expectedTotal,
      currency: div.currency,
      candidates,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/dividends/:id/match
router.post('/:id/match', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { householdId } = auth;
    const dividendId = Number(req.params.id);
    const { transactionId } = req.body as { transactionId?: unknown };

    if (!transactionId || !Number.isFinite(Number(transactionId))) {
      res.status(400).json({ error: 'MISSING_TRANSACTION_ID' });
      return;
    }
    const txId = Number(transactionId);

    const div = await SecurityDividend.findByPk(dividendId, {
      include: [
        {
          model: Security,
          as: 'security',
          where: { householdId },
          required: true,
        },
      ],
    });
    if (!div) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    const tx = await Transaction.findOne({
      where: { id: txId, householdId },
    });
    if (!tx) {
      res.status(403).json({ error: 'TRANSACTION_NOT_FOUND_OR_NOT_YOURS' });
      return;
    }

    await div.update({ matchedTransactionId: txId, matchedAt: new Date() });
    res.json({ ok: true, matchedTransactionId: txId });
  } catch (err) {
    next(err);
  }
});

// POST /api/dividends/:id/unmatch
router.post('/:id/unmatch', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { householdId } = auth;
    const dividendId = Number(req.params.id);

    const div = await SecurityDividend.findByPk(dividendId, {
      include: [
        {
          model: Security,
          as: 'security',
          where: { householdId },
          required: true,
        },
      ],
    });
    if (!div) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    await div.update({ matchedTransactionId: null, matchedAt: null });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
