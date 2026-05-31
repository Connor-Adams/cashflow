/**
 * Dividend matching service (#305).
 *
 * Heuristics for matching SecurityDividend events to Transactions:
 *   - Candidate account: any account in the household that held the security
 *     at or before the ex-dividend date (via HoldingSnapshot).
 *   - Date window: paymentDate ±5 days for auto-match, ±30 days for UI candidates.
 *   - Amount window: ±2% of (perShare × holdingQty) for auto-match.
 *   - Description heuristic: merchantRaw or merchantClean contains the security
 *     symbol, or one of common dividend keywords.
 *   - Credit-only: transaction amount > 0.
 *   - Auto-match fires only when there is exactly ONE candidate in the tight window.
 */
import { Op } from 'sequelize';
import { HoldingSnapshot, Security, SecurityDividend, Transaction } from '../models';
import { logger } from '../observability/logger';

const DIVIDEND_KEYWORDS = ['dividend', 'div', 'dist', 'distribution', 'income', 'drip'];

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function matchesDescriptionHeuristic(tx: Transaction, symbol: string): boolean {
  const sym = symbol.toLowerCase();
  const raw = (tx.merchantRaw ?? '').toLowerCase();
  const clean = (tx.merchantClean ?? '').toLowerCase();
  if (raw.includes(sym) || clean.includes(sym)) return true;
  for (const kw of DIVIDEND_KEYWORDS) {
    if (raw.includes(kw) || clean.includes(kw)) return true;
  }
  return false;
}

/**
 * Returns the account IDs within `householdId` that held `securityId` at
 * or before `asOfDate`, along with the quantity held.
 */
async function holdingsAtDate(
  securityId: number,
  householdId: number,
  asOfDate: string,
): Promise<Map<number, number>> {
  const rows = await HoldingSnapshot.findAll({
    where: {
      securityId,
      householdId,
      statementDate: { [Op.lte]: asOfDate },
    },
    order: [
      ['accountId', 'ASC'],
      ['statementDate', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const out = new Map<number, number>();
  for (const row of rows) {
    if (!out.has(row.accountId)) {
      const qty = Number(row.quantity);
      if (Number.isFinite(qty) && qty > 0) {
        out.set(row.accountId, qty);
      }
    }
  }
  return out;
}

export type DividendCandidate = {
  id: number;
  date: string;
  accountId: number;
  amount: number;
  currency: string;
  merchantRaw: string;
  merchantClean: string;
  /** Lower = closer match */
  score: number;
};

/**
 * Find candidate transactions for manual matching.
 * Window is ±30 days around paymentDate (or exDividendDate if no paymentDate).
 * Returns candidates ranked by (amount closeness, date closeness).
 */
export async function findCandidatesForDividend(
  dividend: SecurityDividend,
  householdId: number,
  expectedAmount: number,
  windowDays = 30,
): Promise<DividendCandidate[]> {
  const refDate = dividend.paymentDate ?? dividend.exDividendDate;
  const lo = addDays(refDate, -windowDays);
  const hi = addDays(refDate, windowDays);

  const holdings = await holdingsAtDate(dividend.securityId, householdId, dividend.exDividendDate);
  if (holdings.size === 0) return [];

  const accountIds = Array.from(holdings.keys());
  const txns = await Transaction.findAll({
    where: {
      householdId,
      accountId: { [Op.in]: accountIds },
      date: { [Op.between]: [lo, hi] },
      amount: { [Op.gt]: 0 },
    },
    order: [['date', 'ASC']],
    limit: 200,
  });

  const refMs = new Date(`${refDate}T00:00:00.000Z`).getTime();

  return txns.map((tx) => {
    const amt = Number(tx.amount);
    const amtDiff = expectedAmount > 0 ? Math.abs(amt - expectedAmount) / expectedAmount : 1;
    const dateDiff = Math.abs(new Date(`${tx.date}T00:00:00.000Z`).getTime() - refMs) / 86400000;
    const score = amtDiff * 10 + dateDiff;
    return {
      id: tx.id,
      date: tx.date,
      accountId: tx.accountId,
      amount: amt,
      currency: tx.currency,
      merchantRaw: tx.merchantRaw,
      merchantClean: tx.merchantClean,
      score,
    };
  }).sort((a, b) => a.score - b.score);
}

export interface AutoMatchResult {
  matched: number;
  skippedAlreadyMatched: number;
  skippedNoHolding: number;
  skippedMultipleCandidates: number;
  skippedNoCandidates: number;
}

/**
 * Auto-match unmatched SecurityDividends whose paymentDate is in the past 90
 * days. Matches when exactly one candidate transaction is found within ±5 days
 * of paymentDate, credit-only, within ±2% of expected amount.
 */
export async function autoMatchDividends(householdId: number): Promise<AutoMatchResult> {
  const result: AutoMatchResult = {
    matched: 0,
    skippedAlreadyMatched: 0,
    skippedNoHolding: 0,
    skippedMultipleCandidates: 0,
    skippedNoCandidates: 0,
  };

  const cutoff = addDays(new Date().toISOString().slice(0, 10), -90);
  const today = new Date().toISOString().slice(0, 10);

  const dividends = await SecurityDividend.findAll({
    where: {
      matchedTransactionId: null,
      paymentDate: { [Op.gte]: cutoff, [Op.lte]: today },
    },
    include: [{ model: Security, as: 'security' }],
  });

  for (const div of dividends) {
    if (div.matchedTransactionId != null) {
      result.skippedAlreadyMatched += 1;
      continue;
    }
    const holdings = await holdingsAtDate(div.securityId, householdId, div.exDividendDate);
    if (holdings.size === 0) {
      result.skippedNoHolding += 1;
      continue;
    }

    const perShare = Number(div.amount);
    const refDate = div.paymentDate ?? div.exDividendDate;
    const lo = addDays(refDate, -5);
    const hi = addDays(refDate, 5);
    const accountIds = Array.from(holdings.keys());

    const txns = await Transaction.findAll({
      where: {
        householdId,
        accountId: { [Op.in]: accountIds },
        date: { [Op.between]: [lo, hi] },
        amount: { [Op.gt]: 0 },
      },
    });

    if (txns.length === 0) {
      result.skippedNoCandidates += 1;
      continue;
    }

    // Filter to those within ±2% of expected amount for any holding account
    const tight: Transaction[] = [];
    for (const tx of txns) {
      const qty = holdings.get(tx.accountId) ?? 0;
      const expected = perShare * qty;
      if (expected <= 0) continue;
      const amt = Number(tx.amount);
      const variance = Math.abs(amt - expected) / expected;
      if (variance <= 0.02) tight.push(tx);
    }

    if (tight.length === 0) {
      result.skippedNoCandidates += 1;
      continue;
    }
    if (tight.length > 1) {
      // Also apply description heuristic to narrow down
      const sym = (div as SecurityDividend & { security?: { symbol?: string } }).security
        ? ((div as unknown as { security: { symbol: string } }).security.symbol ?? '')
        : '';
      const hinted = sym ? tight.filter((tx) => matchesDescriptionHeuristic(tx, sym)) : tight;
      if (hinted.length !== 1) {
        result.skippedMultipleCandidates += 1;
        continue;
      }
      tight.splice(0, tight.length, hinted[0]);
    }

    const winner = tight[0];
    await div.update({ matchedTransactionId: winner.id, matchedAt: new Date() });
    result.matched += 1;
    logger.info({ dividendId: div.id, transactionId: winner.id }, 'dividend_auto_matched');
  }

  return result;
}

/**
 * Returns unmatched dividends that are past paymentDate by more than
 * `staleDays` days, for notification firing.
 */
export async function findStaleDividends(
  householdId: number,
  staleDays = 7,
): Promise<SecurityDividend[]> {
  const cutoff = addDays(new Date().toISOString().slice(0, 10), -staleDays);
  return SecurityDividend.findAll({
    where: {
      matchedTransactionId: null,
      paymentDate: { [Op.lte]: cutoff },
    },
    include: [
      {
        model: Security,
        as: 'security',
        where: { householdId },
        required: true,
      },
    ],
  });
}
