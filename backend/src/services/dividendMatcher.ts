/**
 * Heuristic matcher for linking SecurityDividend records to Transaction rows.
 *
 * autoMatchDividend: returns a single transactionId when exactly one candidate
 * passes all heuristic filters, null otherwise.
 *
 * getCandidates: returns all plausible transactions for the household within
 * ±30 days, ranked by closest amount then date, for manual-match UIs.
 */
import { Op } from 'sequelize';
import { HoldingSnapshot, Transaction } from '../models';
import type { SecurityDividend } from '../models/SecurityDividend';
import type { Security } from '../models/Security';

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns account IDs that held the security near the paymentDate.
 * Uses HoldingSnapshot at-or-before paymentDate per account.
 */
async function accountsHoldingSecurity(
  securityId: number,
  asOfDate: string,
): Promise<number[]> {
  const rows = await HoldingSnapshot.findAll({
    where: {
      securityId,
      statementDate: { [Op.lte]: asOfDate },
    },
    order: [
      ['accountId', 'ASC'],
      ['statementDate', 'DESC'],
      ['id', 'DESC'],
    ],
    attributes: ['accountId', 'quantity'],
  });

  const seen = new Map<number, string>();
  for (const row of rows) {
    if (!seen.has(row.accountId)) seen.set(row.accountId, row.quantity);
  }

  // Only accounts with positive quantity
  return [...seen.entries()]
    .filter(([, qty]) => Number(qty) > 0)
    .map(([accountId]) => accountId);
}

/**
 * Returns candidate transactions for a dividend for the given household,
 * within ±30 days of paymentDate, credits only (amount > 0), ranked by
 * closest amount difference then closest date.
 */
export async function getCandidates(
  dividend: SecurityDividend,
  householdId: number,
): Promise<Transaction[]> {
  if (!dividend.paymentDate) return [];

  const lo = addDays(dividend.paymentDate, -30);
  const hi = addDays(dividend.paymentDate, 30);

  const rows = await Transaction.findAll({
    where: {
      householdId,
      date: { [Op.gte]: lo, [Op.lte]: hi },
    },
    order: [['date', 'ASC']],
  });

  // Credits only (amount > 0 means credit in this codebase)
  const credits = rows.filter((tx) => Number(tx.amount) > 0);

  // Rank by closest amount, then date
  const perShareAmt = Number(dividend.amount);
  const payDate = dividend.paymentDate;

  credits.sort((a, b) => {
    const diffA = Math.abs(Number(a.amount) - perShareAmt);
    const diffB = Math.abs(Number(b.amount) - perShareAmt);
    if (Math.abs(diffA - diffB) > 0.001) return diffA - diffB;
    const dateA = Math.abs(new Date(a.date).getTime() - new Date(payDate).getTime());
    const dateB = Math.abs(new Date(b.date).getTime() - new Date(payDate).getTime());
    return dateA - dateB;
  });

  return credits;
}

/**
 * Auto-match a dividend to a transaction using heuristics:
 * - Credit transactions (amount > 0) in accounts holding the security
 * - Date window: paymentDate ± 5 days
 * - Amount window: expected (dividend.amount * holdingShares) ± 2%
 * - Description heuristic: merchantRaw/merchantClean/notes contains security
 *   symbol or 'dividend' (case insensitive)
 *
 * Returns the transactionId if exactly one candidate matches, null if 0 or >1.
 */
export async function autoMatchDividend(
  dividend: SecurityDividend,
  holdingShares: number,
  security?: Security | null,
): Promise<number | null> {
  if (!dividend.paymentDate) return null;
  if (!Number.isFinite(holdingShares) || holdingShares <= 0) return null;

  const perShare = Number(dividend.amount);
  if (!Number.isFinite(perShare) || perShare <= 0) return null;

  const expectedAmount = perShare * holdingShares;
  const amountLo = expectedAmount * 0.98;
  const amountHi = expectedAmount * 1.02;

  const dateLo = addDays(dividend.paymentDate, -5);
  const dateHi = addDays(dividend.paymentDate, 5);

  // Get accounts that held this security near payment date
  const accountIds = await accountsHoldingSecurity(dividend.securityId, dividend.paymentDate);
  if (accountIds.length === 0) return null;

  const rows = await Transaction.findAll({
    where: {
      accountId: accountIds,
      date: { [Op.gte]: dateLo, [Op.lte]: dateHi },
      amount: { [Op.gt]: 0 },
    },
  });

  // Apply amount filter
  const amountFiltered = rows.filter((tx) => {
    const amt = Number(tx.amount);
    return amt >= amountLo && amt <= amountHi;
  });

  // Apply description heuristic
  const symbol = security?.symbol?.toLowerCase() ?? null;
  const descFiltered = amountFiltered.filter((tx) => {
    const searchText = [
      tx.merchantRaw,
      tx.merchantClean,
      tx.notes,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    const hasDividend = searchText.includes('dividend');
    const hasSymbol = symbol ? searchText.includes(symbol) : false;
    return hasDividend || hasSymbol;
  });

  // If no description match, fall back to amount-only candidates (still
  // require exactly one to avoid false positives)
  const candidates = descFiltered.length > 0 ? descFiltered : amountFiltered;

  if (candidates.length === 1) {
    return Number(candidates[0].id);
  }
  return null;
}
