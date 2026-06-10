/**
 * Dividend payout reconciliation matcher (issue #305).
 *
 * Two layers:
 *   1. PURE heuristic (`scoreDividendCandidate`, `rankDividendCandidates`,
 *      `pickAutoMatch`, `varianceFlag`) — no DB, fully unit-testable. Decides
 *      whether a cash `Transaction` credit plausibly received an expected
 *      `SecurityDividend` payout, and ranks candidates by amount-then-date
 *      closeness.
 *   2. DB-backed orchestration (`autoMatchDividends`, `notifyUnmatchedDividends`,
 *      `findCandidatesForReconciliation`) — derives holding accounts from
 *      `HoldingSnapshot`, upserts one `dividend_reconciliations` row per
 *      (dividend, holding-account), auto-matches when exactly one candidate is
 *      found, and fires the deduped `dividend.unmatched` notification.
 *
 * Matching rules (per the issue):
 *   - candidate must be a CREDIT (positive amount — outflows are negative).
 *   - on the account holding the security.
 *   - within `paymentDate ± dateToleranceDays` (default 5).
 *   - amount within `±amountTolerancePct` of expected (default 2%).
 *   - description containing the symbol or a common dividend descriptor is a
 *     bonus (raises rank) but is NOT required — brokerages narrate dividends
 *     inconsistently.
 *   - auto-match ONLY when exactly one viable candidate exists.
 */
import { Op } from 'sequelize';
import {
  HoldingSnapshot,
  HouseholdMember,
  SecurityDividend,
  Transaction,
  DividendReconciliation,
} from '../models';
import { enqueueNotification } from '../notifications';
import { logger } from '../observability/logger';

export const DEFAULT_DATE_TOLERANCE_DAYS = 5;
export const DEFAULT_AMOUNT_TOLERANCE_PCT = 2;
/** Matched dividends deviating more than this from expected are flagged "Check". */
export const VARIANCE_FLAG_PCT = 5;
/** How far back the auto-matcher looks for payable dividends. */
export const DEFAULT_LOOKBACK_DAYS = 90;
/** Days after paymentDate before an unmatched dividend triggers a notification. */
export const DEFAULT_UNMATCHED_GRACE_DAYS = 7;
/** Candidate-window for the manual-match modal (wider than the auto window). */
export const CANDIDATE_WINDOW_DAYS = 30;

/** Substrings (upper-cased) that mark a transaction narrative as a dividend. */
export const DIVIDEND_DESCRIPTORS = [
  'DIVIDEND',
  'DIV ',
  ' DIV',
  'CASH DIV',
  'DIST',
  'DISTRIBUTION',
] as const;

export interface MatchTolerances {
  dateToleranceDays: number;
  amountTolerancePct: number;
}

export interface DividendExpectation {
  /** ISO date (YYYY-MM-DD). */
  paymentDate: string;
  /** per-share amount × shares held (in the dividend currency). */
  expectedAmount: number;
  currency: string;
  /** Security ticker, used for the description heuristic. */
  symbol: string | null;
}

export interface CandidateTxn {
  id: number;
  accountId: number;
  amount: number;
  date: string;
  merchant: string | null;
  currency: string;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(
    Math.round(
      (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) /
        86400000,
    ),
  );
}

function descriptorBonus(merchant: string | null, symbol: string | null): number {
  if (!merchant) return 0;
  const upper = merchant.toUpperCase();
  let bonus = 0;
  if (symbol && upper.includes(symbol.toUpperCase())) bonus += 20;
  if (DIVIDEND_DESCRIPTORS.some((d) => upper.includes(d))) bonus += 15;
  return bonus;
}

/**
 * Pure score for a single candidate. Higher = better. Returns `null` for
 * candidates that fail a hard gate (debit, out-of-window, out-of-tolerance) so
 * the caller can drop them entirely.
 *
 * Score is dominated by amount closeness, then date closeness, then the
 * description bonus — this ordering is what `rankDividendCandidates` relies on
 * to satisfy "ranked by amount-then-date closeness" (AC #7).
 */
export function scoreDividendCandidate(
  expected: DividendExpectation,
  candidate: CandidateTxn,
  tol: MatchTolerances,
): number | null {
  // Hard gate: dividends are credits (positive inflow).
  if (!(candidate.amount > 0)) return null;

  // Hard gate: same currency. Amount closeness across currencies is unit
  // confusion — a CAD credit numerically equal to a USD expectation is not
  // the payout (the converted deposit would differ by the FX factor).
  if (candidate.currency !== expected.currency) return null;

  // Hard gate: within the date window.
  const days = daysBetween(expected.paymentDate, candidate.date);
  if (days > tol.dateToleranceDays) return null;

  // Hard gate: amount within ±tolerance% of expected.
  const expectedAbs = Math.abs(expected.expectedAmount);
  if (expectedAbs <= 0) return null;
  const deviationPct = (Math.abs(candidate.amount - expectedAbs) / expectedAbs) * 100;
  if (deviationPct > tol.amountTolerancePct) return null;

  // Amount closeness dominates (0..1000), then date closeness (0..100), then
  // the description bonus (0..35).
  const amountScore = 1000 * (1 - deviationPct / Math.max(0.0001, tol.amountTolerancePct));
  const dateScore =
    100 * (1 - days / Math.max(1, tol.dateToleranceDays));
  return amountScore + dateScore + descriptorBonus(candidate.merchant, expected.symbol);
}

export interface ScoredCandidate extends CandidateTxn {
  score: number;
}

/**
 * Score + drop incompatible candidates, returning the survivors sorted best
 * first. Ties broken by smaller id for determinism.
 */
export function rankDividendCandidates(
  expected: DividendExpectation,
  candidates: CandidateTxn[],
  tol: MatchTolerances,
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    const score = scoreDividendCandidate(expected, c, tol);
    if (score != null) scored.push({ ...c, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.id - b.id));
  return scored;
}

/**
 * Auto-match decision: return the candidate ONLY when exactly one viable
 * candidate survives the gates (AC #2 / AC #3). Zero or many → null (left
 * unmatched for the human).
 */
export function pickAutoMatch(
  expected: DividendExpectation,
  candidates: CandidateTxn[],
  tol: MatchTolerances,
): ScoredCandidate | null {
  const viable = rankDividendCandidates(expected, candidates, tol);
  return viable.length === 1 ? viable[0] : null;
}

/**
 * True when |actual − expected| / expected exceeds {@link VARIANCE_FLAG_PCT}.
 * Used to render the "Check" pill on a matched dividend (AC #10). Degenerate
 * (expected 0) never flags.
 */
export function varianceFlag(expectedAmount: number, actualAmount: number): boolean {
  const expectedAbs = Math.abs(expectedAmount);
  if (expectedAbs <= 0) return false;
  const pct = (Math.abs(actualAmount - expectedAbs) / expectedAbs) * 100;
  return pct > VARIANCE_FLAG_PCT;
}

// ---------------------------------------------------------------------------
// DB-backed orchestration
// ---------------------------------------------------------------------------

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * For each account that has any HoldingSnapshot for the security, return the
 * most recent snapshot at-or-before `asOfDate`. Accounts that only have
 * snapshots after the date are omitted. Mirrors the helper in
 * reconcileDividends.ts (kept local so the two reconcilers stay independent).
 */
async function latestHoldingPerAccountAtOrBefore(
  securityId: number,
  asOfDate: string,
): Promise<Map<number, HoldingSnapshot>> {
  const rows = await HoldingSnapshot.findAll({
    where: { securityId, statementDate: { [Op.lte]: asOfDate } },
    order: [
      ['accountId', 'ASC'],
      ['statementDate', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const out = new Map<number, HoldingSnapshot>();
  for (const row of rows) {
    if (!out.has(row.accountId)) out.set(row.accountId, row);
  }
  return out;
}

export interface AutoMatchOptions {
  now?: Date;
  lookbackDays?: number;
  dateToleranceDays?: number;
  amountTolerancePct?: number;
}

export interface AutoMatchResult {
  dividendsScanned: number;
  holdingsConsidered: number;
  reconciliationsCreated: number;
  autoMatched: number;
  leftUnmatched: number;
}

/**
 * Daily pass: ensure a reconciliation row exists for every (payable dividend,
 * holding account) and auto-match the unambiguous ones.
 *
 * "Payable" = `paymentDate` set, in `[now - lookbackDays, now]`. We only
 * consider dividends whose payment date has passed (a future payment can't
 * have a transaction yet — those surface in the "upcoming" list, not here).
 */
export async function autoMatchDividends(
  opts: AutoMatchOptions = {},
): Promise<AutoMatchResult> {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const tol: MatchTolerances = {
    dateToleranceDays: opts.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS,
    amountTolerancePct: opts.amountTolerancePct ?? DEFAULT_AMOUNT_TOLERANCE_PCT,
  };
  const todayIso = now.toISOString().slice(0, 10);
  const lowIso = addDays(todayIso, -lookbackDays);

  const result: AutoMatchResult = {
    dividendsScanned: 0,
    holdingsConsidered: 0,
    reconciliationsCreated: 0,
    autoMatched: 0,
    leftUnmatched: 0,
  };

  const dividends = await SecurityDividend.findAll({
    where: {
      paymentDate: { [Op.ne]: null, [Op.gte]: lowIso, [Op.lte]: todayIso },
    },
    include: [{ association: 'security', attributes: ['id', 'symbol'] }],
    order: [['paymentDate', 'ASC']],
  });

  for (const dividend of dividends) {
    result.dividendsScanned += 1;
    const paymentDate = dividend.paymentDate;
    if (!paymentDate) continue;
    const symbol =
      (dividend as unknown as { security?: { symbol?: string } }).security?.symbol ??
      null;

    const holdings = await latestHoldingPerAccountAtOrBefore(
      dividend.securityId,
      paymentDate,
    );

    for (const [accountId, snapshot] of holdings) {
      const shares = Number(snapshot.quantity);
      if (!Number.isFinite(shares) || shares <= 0) continue;
      const perShare = Number(dividend.amount);
      if (!Number.isFinite(perShare) || perShare <= 0) continue;
      result.holdingsConsidered += 1;

      const expectedAmount = shares * perShare;

      // Upsert the reconciliation row (idempotent on the unique pair).
      let recon = await DividendReconciliation.findOne({
        where: { securityDividendId: dividend.id, accountId },
      });
      if (!recon) {
        recon = await DividendReconciliation.create({
          securityDividendId: dividend.id,
          accountId,
          householdId: snapshot.householdId,
          matchSource: 'auto',
          expectedAmount: expectedAmount.toFixed(8),
          shares: shares.toFixed(10),
          currency: dividend.currency,
        });
        result.reconciliationsCreated += 1;
      }

      // Already matched (auto or manual) → leave it alone.
      if (recon.matchedTransactionId != null) continue;

      // Search candidate credits on this account in the window.
      const lo = addDays(paymentDate, -tol.dateToleranceDays);
      const hi = addDays(paymentDate, tol.dateToleranceDays);
      const txns = await Transaction.findAll({
        where: {
          accountId,
          date: { [Op.gte]: lo, [Op.lte]: hi },
          amount: { [Op.gt]: 0 },
        },
        attributes: ['id', 'accountId', 'amount', 'date', 'merchantClean', 'merchantRaw', 'currency'],
        limit: 200,
      });
      const candidates: CandidateTxn[] = txns.map((t) => ({
        id: t.id,
        accountId: t.accountId,
        amount: Number(t.amount),
        date: t.date,
        merchant: t.merchantClean || t.merchantRaw || null,
        currency: t.currency,
      }));

      const expectation: DividendExpectation = {
        paymentDate,
        expectedAmount,
        currency: dividend.currency,
        symbol,
      };
      const picked = pickAutoMatch(expectation, candidates, tol);
      if (picked) {
        await recon.update({
          matchedTransactionId: picked.id,
          matchedAt: now,
          matchSource: 'auto',
        });
        result.autoMatched += 1;
      } else {
        result.leftUnmatched += 1;
      }
    }
  }

  if (result.autoMatched > 0 || result.reconciliationsCreated > 0) {
    logger.info({ ...result }, 'dividend_auto_match_complete');
  }
  return result;
}

export interface NotifyUnmatchedOptions {
  now?: Date;
  graceDays?: number;
}

export interface NotifyUnmatchedResult {
  notificationsSent: number;
  scanned: number;
}

async function resolveRecipientUserId(
  householdId: number | null,
): Promise<number | null> {
  if (householdId == null) return null;
  const member = await HouseholdMember.findOne({
    where: { householdId, role: 'owner' },
    attributes: ['userId'],
    order: [['createdAt', 'ASC']],
    raw: true,
  });
  return member?.userId ?? null;
}

/**
 * Fire a `dividend.unmatched` notification for each reconciliation row still
 * unmatched more than `graceDays` after its dividend's paymentDate, deduping
 * via `notified_unmatched_at` so the alert fires at most once per row (AC #9).
 */
export async function notifyUnmatchedDividends(
  opts: NotifyUnmatchedOptions = {},
): Promise<NotifyUnmatchedResult> {
  const now = opts.now ?? new Date();
  const graceDays = opts.graceDays ?? DEFAULT_UNMATCHED_GRACE_DAYS;
  const cutoffIso = addDays(now.toISOString().slice(0, 10), -graceDays);

  const rows = await DividendReconciliation.findAll({
    where: {
      matchedTransactionId: null,
      notifiedUnmatchedAt: null,
    },
    include: [
      {
        association: 'dividend',
        attributes: ['id', 'paymentDate', 'currency', 'securityId'],
        include: [{ association: 'security', attributes: ['symbol'] }],
      },
    ],
  });

  const result: NotifyUnmatchedResult = { notificationsSent: 0, scanned: rows.length };

  for (const recon of rows) {
    const dividend = (
      recon as unknown as {
        dividend?: {
          paymentDate: string | null;
          currency: string;
          security?: { symbol?: string };
        };
      }
    ).dividend;
    const paymentDate = dividend?.paymentDate ?? null;
    if (!paymentDate) continue;
    // Only past the grace window.
    if (paymentDate > cutoffIso) continue;

    const recipientUserId = await resolveRecipientUserId(recon.householdId);
    if (recipientUserId == null) {
      // No owner to notify — still stamp so we don't re-scan forever.
      await recon.update({ notifiedUnmatchedAt: now });
      continue;
    }

    const symbol = dividend?.security?.symbol ?? 'a holding';
    const expected = recon.expectedAmount != null ? Number(recon.expectedAmount) : null;
    const amountStr =
      expected != null ? ` (~${expected.toFixed(2)} ${recon.currency ?? ''})`.trimEnd() : '';
    try {
      // Stamp FIRST so a downstream failure can't cause re-fire on the next run.
      await recon.update({ notifiedUnmatchedAt: now });
      await enqueueNotification(recipientUserId, 'dividend.unmatched', {
        severity: 'warn',
        title: `Unmatched dividend: ${symbol}`,
        body: `An expected ${symbol} dividend payment${amountStr} hasn't been matched to a transaction. Review it in your portfolio.`,
        dataJson: {
          reconciliationId: recon.id,
          securityDividendId: recon.securityDividendId,
          accountId: recon.accountId,
          paymentDate,
          expectedAmount: expected,
          currency: recon.currency,
        },
      });
      result.notificationsSent += 1;
    } catch (err) {
      logger.warn(
        { err, reconciliationId: recon.id },
        'dividend_unmatched_notify_failed',
      );
    }
  }

  if (result.notificationsSent > 0) {
    logger.info({ ...result }, 'dividend_unmatched_notify_complete');
  }
  return result;
}

/**
 * Candidate transactions for the manual-match modal. Wider window
 * ({@link CANDIDATE_WINDOW_DAYS}) than the auto-matcher and DOES NOT gate on
 * amount/credit — the UI ranks and warns instead, so the user can pick an
 * imperfect row deliberately (AC #7 / AC #8). Each candidate carries a
 * `warning` describing why it looks wrong (debit) when applicable.
 */
export interface CandidateView {
  id: number;
  accountId: number;
  amount: number;
  date: string;
  merchant: string | null;
  currency: string;
  score: number | null;
  warning: 'debit' | 'wrong_account' | null;
}

export async function findCandidatesForReconciliation(
  recon: InstanceType<typeof DividendReconciliation>,
  expectation: DividendExpectation,
  opts: { windowDays?: number; tolerances?: MatchTolerances } = {},
): Promise<CandidateView[]> {
  const windowDays = opts.windowDays ?? CANDIDATE_WINDOW_DAYS;
  const tol = opts.tolerances ?? {
    dateToleranceDays: windowDays,
    amountTolerancePct: 100, // do not gate on amount in the modal
  };
  const lo = addDays(expectation.paymentDate, -windowDays);
  const hi = addDays(expectation.paymentDate, windowDays);
  const txns = await Transaction.findAll({
    where: { accountId: recon.accountId, date: { [Op.gte]: lo, [Op.lte]: hi } },
    attributes: ['id', 'accountId', 'amount', 'date', 'merchantClean', 'merchantRaw', 'currency'],
    order: [['date', 'DESC']],
    limit: 100,
  });
  const views: CandidateView[] = txns.map((t) => {
    const amount = Number(t.amount);
    const cand: CandidateTxn = {
      id: t.id,
      accountId: t.accountId,
      amount,
      date: t.date,
      merchant: t.merchantClean || t.merchantRaw || null,
      currency: t.currency,
    };
    // Score with the real tolerances purely for ranking; null is fine.
    const score = scoreDividendCandidate(expectation, cand, {
      dateToleranceDays: windowDays,
      amountTolerancePct: tol.amountTolerancePct,
    });
    return {
      ...cand,
      score,
      warning: amount <= 0 ? 'debit' : null,
    };
  });
  // Best (non-null score) first, then by date desc.
  views.sort((a, b) => {
    if (a.score != null && b.score != null) return b.score - a.score;
    if (a.score != null) return -1;
    if (b.score != null) return 1;
    return b.date.localeCompare(a.date);
  });
  return views;
}
