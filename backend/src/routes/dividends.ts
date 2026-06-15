/**
 * Dividend payout reconciliation endpoints (issue #305).
 *
 * Surfaces which expected dividends (from `security_dividends`) actually
 * arrived as cash `transactions`, lets the user manually match an unmatched
 * payout, and unmatch a wrong one.
 *
 *   - GET  /api/dividends?status=upcoming|matched|unmatched&windowMonths=12
 *   - GET  /api/dividends/:id/candidates   – candidate txns for the modal
 *   - POST /api/dividends/:id/match        – body { transactionId }
 *   - POST /api/dividends/:id/unmatch
 *
 * Reconciliation rows are account-scoped (one per dividend × holding account),
 * so scoping to the caller's visible investment accounts is the natural
 * household guard — a reconciliation for an account the caller can't see is
 * invisible / 404, and matching to a transaction on an account they don't own
 * is 403.
 */
import { Router, type Request } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  HoldingSnapshot,
  SecurityDividend,
  Transaction,
  DividendReconciliation,
} from '../models';
import { visibleAccountWhere, visibleTransactionWhere } from '../auth/scope';
import {
  findCandidatesForReconciliation,
  varianceFlag,
  type DividendExpectation,
} from '../portfolio/dividendMatcher';
import { logger } from '../observability/logger';

const router = Router();

function asNumberId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Visible investment account ids for the caller. */
async function visibleInvestmentAccountIds(req: Request): Promise<number[]> {
  const accounts = await Account.findAll({
    where: { ...visibleAccountWhere(req), accountType: 'investment' },
    attributes: ['id'],
    raw: true,
  });
  return accounts.map((a) => a.id);
}

/** Security ids currently held in any of the given accounts (latest snapshot per pair > 0). */
async function heldSecurityIds(accountIds: number[]): Promise<number[]> {
  if (accountIds.length === 0) return [];
  const snapshots = await HoldingSnapshot.findAll({
    where: { accountId: { [Op.in]: accountIds } },
    order: [['statementDate', 'DESC']],
    attributes: ['accountId', 'securityId', 'quantity', 'statementDate'],
    raw: true,
  });
  const latestByPair = new Map<string, { securityId: number; quantity: string }>();
  for (const s of snapshots) {
    const key = `${s.accountId}:${s.securityId}`;
    if (!latestByPair.has(key)) latestByPair.set(key, s);
  }
  const ids = new Set<number>();
  for (const v of latestByPair.values()) {
    if (Number(v.quantity) > 0) ids.add(v.securityId);
  }
  return [...ids];
}

interface SerializedReconciliation {
  reconciliationId: number;
  securityDividendId: number;
  accountId: number;
  accountName: string | null;
  symbol: string | null;
  securityName: string | null;
  exDividendDate: string;
  paymentDate: string | null;
  perShareAmount: string;
  shares: string | null;
  expectedAmount: number | null;
  actualAmount: number | null;
  currency: string | null;
  matchedTransactionId: number | null;
  matchedAt: string | null;
  matchSource: string;
  variancePct: number | null;
  varianceFlag: boolean;
}

function variancePct(expected: number | null, actual: number | null): number | null {
  if (expected == null || actual == null || Math.abs(expected) <= 0) return null;
  return ((actual - expected) / Math.abs(expected)) * 100;
}

/**
 * GET /api/dividends?status=&windowMonths=
 *
 * - upcoming: dividends with a future paymentDate on a held security (no
 *   reconciliation row needed — nothing to match yet).
 * - matched: reconciliation rows with a matched transaction in the window,
 *   carrying expected-vs-actual + a variance flag.
 * - unmatched: reconciliation rows with paymentDate in the past `windowMonths`
 *   and no matched transaction.
 */
router.get('/', async (req, res, next) => {
  try {
    const status = String(req.query.status ?? 'unmatched');
    if (!['upcoming', 'matched', 'unmatched'].includes(status)) {
      res.status(400).json({ error: 'status must be upcoming, matched, or unmatched' });
      return;
    }
    const windowMonths = Math.min(
      60,
      Math.max(1, parseInt(String(req.query.windowMonths ?? '12'), 10) || 12),
    );
    const accountIds = await visibleInvestmentAccountIds(req);
    const today = todayIso();

    if (status === 'upcoming') {
      const securityIds = await heldSecurityIds(accountIds);
      if (securityIds.length === 0) {
        res.json({ status, windowMonths, data: [] });
        return;
      }
      const horizon = addDaysIso(today, 30);
      // NULL-safe upcoming filter (#555): all imported dividends currently have a
      // NULL payment_date (Yahoo chart events only carry the ex-date), so filtering
      // on payment_date alone makes "upcoming" structurally empty. Fall back to the
      // ex-dividend date when payment_date is absent — a future ex-date is a strong
      // enough signal that the payout is still upcoming.
      const inWindow = { [Op.gt]: today, [Op.lte]: horizon };
      const divs = await SecurityDividend.findAll({
        where: {
          securityId: { [Op.in]: securityIds },
          [Op.or]: [
            { paymentDate: inWindow },
            { paymentDate: null, exDividendDate: inWindow },
          ],
        },
        include: [{ association: 'security', attributes: ['symbol', 'name'] }],
        // Order by the effective date (payment_date when present, else ex-date).
        order: [
          [SecurityDividend.sequelize!.fn('coalesce', SecurityDividend.sequelize!.col('payment_date'), SecurityDividend.sequelize!.col('ex_dividend_date')), 'ASC'],
        ],
      });
      const data = divs.map((d) => {
        const sec = (d as unknown as { security?: { symbol?: string; name?: string } }).security;
        return {
          securityDividendId: d.id,
          symbol: sec?.symbol ?? null,
          securityName: sec?.name ?? null,
          exDividendDate: d.exDividendDate,
          paymentDate: d.paymentDate,
          perShareAmount: d.amount,
          currency: d.currency,
        };
      });
      res.json({ status, windowMonths, data });
      return;
    }

    // matched / unmatched both query reconciliation rows scoped to accounts.
    if (accountIds.length === 0) {
      res.json({ status, windowMonths, data: [] });
      return;
    }
    const windowStart = addMonthsIso(today, -windowMonths);
    const matchedClause =
      status === 'matched'
        ? { matchedTransactionId: { [Op.ne]: null } }
        : { matchedTransactionId: null };

    const recons = await DividendReconciliation.findAll({
      where: { accountId: { [Op.in]: accountIds }, ...matchedClause },
      include: [
        {
          association: 'dividend',
          attributes: ['id', 'exDividendDate', 'paymentDate', 'amount', 'currency', 'securityId'],
          include: [{ association: 'security', attributes: ['symbol', 'name'] }],
          required: true,
        },
        { association: 'account', attributes: ['id', 'name'] },
        { association: 'matchedTransaction', attributes: ['id', 'amount', 'date', 'merchantClean'] },
      ],
    });

    const out: SerializedReconciliation[] = [];
    for (const recon of recons) {
      const dividend = (
        recon as unknown as {
          dividend?: {
            id: number;
            exDividendDate: string;
            paymentDate: string | null;
            amount: string;
            currency: string;
            security?: { symbol?: string; name?: string };
          };
        }
      ).dividend;
      if (!dividend) continue;
      const paymentDate = dividend.paymentDate;
      // Window + past/future filter.
      if (status === 'unmatched') {
        // Past payouts only, within window.
        if (!paymentDate || paymentDate >= today || paymentDate < windowStart) continue;
      } else {
        // matched within window (by matchedAt or paymentDate).
        const ref = recon.matchedAt
          ? recon.matchedAt.toISOString().slice(0, 10)
          : paymentDate;
        if (ref && ref < windowStart) continue;
      }

      const account = (recon as unknown as { account?: { name?: string } }).account;
      const matchedTxn = (
        recon as unknown as { matchedTransaction?: { amount: string } }
      ).matchedTransaction;
      const expectedAmount =
        recon.expectedAmount != null ? Number(recon.expectedAmount) : null;
      const actualAmount = matchedTxn != null ? Number(matchedTxn.amount) : null;
      out.push({
        reconciliationId: recon.id,
        securityDividendId: dividend.id,
        accountId: recon.accountId,
        accountName: account?.name ?? null,
        symbol: dividend.security?.symbol ?? null,
        securityName: dividend.security?.name ?? null,
        exDividendDate: dividend.exDividendDate,
        paymentDate,
        perShareAmount: dividend.amount,
        shares: recon.shares,
        expectedAmount,
        actualAmount,
        currency: recon.currency ?? dividend.currency,
        matchedTransactionId: recon.matchedTransactionId,
        matchedAt: recon.matchedAt ? recon.matchedAt.toISOString() : null,
        matchSource: recon.matchSource,
        variancePct: variancePct(expectedAmount, actualAmount),
        varianceFlag:
          expectedAmount != null && actualAmount != null
            ? varianceFlag(expectedAmount, actualAmount)
            : false,
      });
    }
    // Sort: unmatched by paymentDate desc, matched by matchedAt desc.
    out.sort((a, b) => (b.paymentDate ?? '').localeCompare(a.paymentDate ?? ''));
    res.json({ status, windowMonths, data: out });
  } catch (e) {
    next(e);
  }
});

/** Load a reconciliation visible to the caller (account-scoped). 404 if not. */
async function loadVisibleReconciliation(
  req: Request,
  id: number,
): Promise<InstanceType<typeof DividendReconciliation> | null> {
  const accountIds = await visibleInvestmentAccountIds(req);
  if (accountIds.length === 0) return null;
  return DividendReconciliation.findOne({
    where: { id, accountId: { [Op.in]: accountIds } },
    include: [
      {
        association: 'dividend',
        attributes: ['id', 'paymentDate', 'amount', 'currency', 'securityId'],
        include: [{ association: 'security', attributes: ['symbol'] }],
      },
    ],
  });
}

function expectationFromReconciliation(
  recon: InstanceType<typeof DividendReconciliation>,
): DividendExpectation | null {
  const dividend = (
    recon as unknown as {
      dividend?: { paymentDate: string | null; currency: string; security?: { symbol?: string } };
    }
  ).dividend;
  if (!dividend?.paymentDate) return null;
  return {
    paymentDate: dividend.paymentDate,
    expectedAmount: recon.expectedAmount != null ? Number(recon.expectedAmount) : 0,
    currency: recon.currency ?? dividend.currency,
    symbol: dividend.security?.symbol ?? null,
  };
}

/**
 * GET /api/dividends/:id/candidates
 *
 * Candidate transactions for the manual-match modal, ranked by amount-then-date
 * closeness, each carrying a `warning` flag (e.g. debit) the UI surfaces.
 */
router.get('/:id/candidates', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const recon = await loadVisibleReconciliation(req, id);
    if (!recon) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const expectation = expectationFromReconciliation(recon);
    if (!expectation) {
      res.json({ candidates: [] });
      return;
    }
    const candidates = await findCandidatesForReconciliation(recon, expectation);
    res.json({ candidates });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/dividends/:id/match  body { transactionId }
 *
 * Match a reconciliation to a transaction. The transaction must be visible to
 * the caller (their household) — a transaction on another user's account is a
 * 403 (AC #5). It must also be on the reconciliation's own holding account
 * (else 400) to keep the data coherent.
 */
router.post('/:id/match', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const transactionId = asNumberId(body.transactionId);
    if (transactionId == null) {
      res.status(400).json({ error: 'transactionId must be a positive integer' });
      return;
    }
    const recon = await loadVisibleReconciliation(req, id);
    if (!recon) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    // Transaction must be visible to the caller — else 403 (cross-household).
    const txn = await Transaction.findOne({
      where: { id: transactionId, ...visibleTransactionWhere(req) },
    });
    if (!txn) {
      res.status(403).json({ error: 'Transaction not accessible' });
      return;
    }
    // Must belong to the reconciliation's holding account.
    if (txn.accountId !== recon.accountId) {
      res.status(400).json({
        error: 'Transaction must be on the account holding this dividend',
      });
      return;
    }
    await recon.update({
      matchedTransactionId: txn.id,
      matchedAt: new Date(),
      matchSource: 'manual',
    });
    logger.info(
      { reconciliationId: recon.id, transactionId: txn.id },
      'dividend_matched_manual',
    );
    res.json({ ok: true, reconciliationId: recon.id, matchedTransactionId: txn.id });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/dividends/:id/unmatch
 *
 * Clear the match on a reconciliation (e.g. a wrong auto-match). Resets the
 * unmatched-notification stamp so the dividend can re-alert if it stays
 * unmatched past the grace window again.
 */
router.post('/:id/unmatch', async (req, res, next) => {
  try {
    const id = asNumberId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const recon = await loadVisibleReconciliation(req, id);
    if (!recon) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await recon.update({
      matchedTransactionId: null,
      matchedAt: null,
      notifiedUnmatchedAt: null,
    });
    res.json({ ok: true, reconciliationId: recon.id });
  } catch (e) {
    next(e);
  }
});

export default router;
