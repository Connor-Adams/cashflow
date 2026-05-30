// Mount in app.ts: app.use('/api/dividends', dividendsRouter); // after requireAuth
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import {
  SecurityDividend,
  Security,
  Transaction,
} from '../models';
import { getCandidates } from '../services/dividendMatcher';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /api/dividends
// Query params:
//   status: 'upcoming' | 'matched' | 'unmatched'
//   windowMonths: number (default 12)
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { household } = currentAuth(req);
    const status = typeof req.query.status === 'string' ? req.query.status : 'unmatched';
    const windowMonths = Number(req.query.windowMonths) || 12;
    const today = todayStr();

    // Build date window for the query
    const windowStartDate = new Date();
    windowStartDate.setMonth(windowStartDate.getMonth() - windowMonths);
    const windowStart = windowStartDate.toISOString().slice(0, 10);

    // Fetch all securities belonging to this household
    const securities = await Security.findAll({
      where: { householdId: household.id },
      attributes: ['id', 'symbol', 'name'],
    });
    const securityIds = securities.map((s) => s.id);
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    if (securityIds.length === 0) {
      return res.json({ dividends: [] });
    }

    let whereClause: Record<string, unknown> = { securityId: securityIds };

    if (status === 'upcoming') {
      // paymentDate in the next 30 days
      const thirtyDaysOut = addDays(today, 30);
      whereClause = {
        ...whereClause,
        paymentDate: { [Op.gt]: today, [Op.lte]: thirtyDaysOut },
      };
    } else if (status === 'matched') {
      whereClause = {
        ...whereClause,
        matchedTransactionId: { [Op.not]: null },
        paymentDate: { [Op.not]: null, [Op.gte]: windowStart },
      };
    } else {
      // unmatched: paymentDate in the past windowMonths, no match
      whereClause = {
        ...whereClause,
        matchedTransactionId: null,
        paymentDate: { [Op.not]: null, [Op.gte]: windowStart, [Op.lte]: today },
      };
    }

    const dividends = await SecurityDividend.findAll({
      where: whereClause,
      order: [['paymentDate', 'DESC']],
    });

    // For matched dividends, optionally fetch transaction details
    const matchedTxIds = dividends
      .map((d) => d.matchedTransactionId)
      .filter((id): id is number => id != null);

    const txMap = new Map<number, Transaction>();
    if (matchedTxIds.length > 0) {
      const txs = await Transaction.findAll({
        where: { id: matchedTxIds, householdId: household.id },
      });
      for (const tx of txs) {
        if (tx.id != null) txMap.set(Number(tx.id), tx);
      }
    }

    const result = dividends.map((d) => {
      const security = securityMap.get(d.securityId);
      const matchedTx = d.matchedTransactionId != null
        ? txMap.get(Number(d.matchedTransactionId))
        : undefined;

      // Compute variance % if matched
      let variancePct: number | null = null;
      if (matchedTx && d.amount) {
        const expected = Number(d.amount);
        const actual = Number(matchedTx.amount);
        if (expected > 0) {
          variancePct = ((actual - expected) / expected) * 100;
        }
      }

      return {
        id: d.id,
        securityId: d.securityId,
        symbol: security?.symbol ?? null,
        securityName: security?.name ?? null,
        exDividendDate: d.exDividendDate,
        paymentDate: d.paymentDate,
        amount: d.amount,
        currency: d.currency,
        matchedTransactionId: d.matchedTransactionId,
        matchedAt: d.matchedAt,
        matchedTransaction: matchedTx
          ? {
              id: matchedTx.id,
              date: matchedTx.date,
              amount: matchedTx.amount,
              merchantClean: matchedTx.merchantClean,
            }
          : null,
        variancePct,
      };
    });

    return res.json({ dividends: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dividends/:id/candidates
// ---------------------------------------------------------------------------
router.get('/:id/candidates', async (req, res) => {
  try {
    const { household } = currentAuth(req);
    const dividendId = Number(req.params.id);
    if (!Number.isInteger(dividendId) || dividendId < 1) {
      return res.status(400).json({ error: 'Invalid dividend id' });
    }

    // Verify the dividend belongs to a security in this household
    const dividend = await SecurityDividend.findByPk(dividendId);
    if (!dividend) {
      return res.status(404).json({ error: 'Dividend not found' });
    }

    const security = await Security.findOne({
      where: { id: dividend.securityId, householdId: household.id },
    });
    if (!security) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const candidates = await getCandidates(dividend, household.id);

    const result = candidates.map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchantRaw: tx.merchantRaw,
      merchantClean: tx.merchantClean,
      accountId: tx.accountId,
    }));

    return res.json({ candidates: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/dividends/:id/match
// Body: { transactionId: number }
// ---------------------------------------------------------------------------
router.post('/:id/match', async (req, res) => {
  try {
    const { household } = currentAuth(req);
    const dividendId = Number(req.params.id);
    if (!Number.isInteger(dividendId) || dividendId < 1) {
      return res.status(400).json({ error: 'Invalid dividend id' });
    }

    const transactionId = Number(req.body.transactionId);
    if (!Number.isInteger(transactionId) || transactionId < 1) {
      return res.status(400).json({ error: 'transactionId is required and must be a positive integer' });
    }

    // Verify the dividend is accessible (security belongs to household)
    const dividend = await SecurityDividend.findByPk(dividendId);
    if (!dividend) {
      return res.status(404).json({ error: 'Dividend not found' });
    }

    const security = await Security.findOne({
      where: { id: dividend.securityId, householdId: household.id },
    });
    if (!security) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Verify the transaction belongs to the household
    const tx = await Transaction.findOne({
      where: { id: transactionId, householdId: household.id },
    });
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found or does not belong to household' });
    }

    await dividend.update({
      matchedTransactionId: transactionId,
      matchedAt: new Date(),
    });

    return res.json({
      id: dividend.id,
      matchedTransactionId: dividend.matchedTransactionId,
      matchedAt: dividend.matchedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/dividends/:id/unmatch
// ---------------------------------------------------------------------------
router.post('/:id/unmatch', async (req, res) => {
  try {
    const { household } = currentAuth(req);
    const dividendId = Number(req.params.id);
    if (!Number.isInteger(dividendId) || dividendId < 1) {
      return res.status(400).json({ error: 'Invalid dividend id' });
    }

    const dividend = await SecurityDividend.findByPk(dividendId);
    if (!dividend) {
      return res.status(404).json({ error: 'Dividend not found' });
    }

    const security = await Security.findOne({
      where: { id: dividend.securityId, householdId: household.id },
    });
    if (!security) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await dividend.update({
      matchedTransactionId: null,
      matchedAt: null,
    });

    return res.json({ id: dividend.id, matchedTransactionId: null, matchedAt: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
});

export default router;
