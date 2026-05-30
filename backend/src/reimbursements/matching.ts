/**
 * Repayment-matching heuristic for the reimbursement tracker (issue #216).
 *
 * Given a reimbursement claim (an outlay we expect back) and a set of candidate
 * transactions, score how likely each candidate is the incoming repayment.
 *
 * A candidate is only *eligible* when it is:
 *   - opposite sign to the outlay (the claim is a debit/outflow, so the
 *     repayment must be a credit/inflow — a positive amount),
 *   - same currency, and
 *   - dated on or after the outlay transaction's date (you can't be repaid
 *     before you paid).
 *
 * Eligible candidates are scored on two axes, then blended:
 *   score = 0.6 * amountCloseness + 0.4 * dateProximity
 * where each axis is in [0, 1]. Candidates below MIN_SCORE are dropped.
 *
 * Pure module — no DB. routes/reimbursements.ts loads candidate rows and feeds
 * them here.
 */

export const AMOUNT_WEIGHT = 0.6;
export const DATE_WEIGHT = 0.4;
export const MIN_SCORE = 0.1;

/** Within this fraction of the target amount → full amount score. */
export const AMOUNT_TIGHT = 0.01; // 1%
/** Beyond this fraction → zero amount score. */
export const AMOUNT_LOOSE = 0.25; // 25%

/** Within this many days of the reference date → full date score. */
export const DATE_TIGHT_DAYS = 3;
/** Beyond this many days → zero date score. */
export const DATE_LOOSE_DAYS = 60;

export interface ClaimForMatch {
  /** Positive magnitude of the original outlay. */
  amount: string | number;
  currency: string;
  /** YYYY-MM-DD of the original outlay transaction. */
  outlayDate: string;
  /** Optional YYYY-MM-DD due date — when present it's the date axis reference;
   *  otherwise the outlay date is used. */
  dueDate?: string | null;
}

export interface CandidateTransaction {
  id: number;
  /** Signed amount; a repayment is a positive inflow. */
  amount: string | number;
  currency: string;
  /** YYYY-MM-DD. */
  date: string;
  merchantClean?: string | null;
  merchant?: string | null;
}

export interface ScoredCandidate {
  transactionId: number;
  score: number;
  amountCloseness: number;
  dateProximity: number;
  amount: string;
  currency: string;
  date: string;
  merchant: string | null;
}

function toNum(v: string | number): number {
  return typeof v === 'number' ? v : Number(v);
}

function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(Math.round((tb - ta) / 86_400_000));
}

/**
 * Linear closeness in [0,1]: 1 when |delta| <= tight, 0 when |delta| >= loose,
 * linearly interpolated between.
 */
function rampCloseness(delta: number, tight: number, loose: number): number {
  const d = Math.abs(delta);
  if (d <= tight) return 1;
  if (d >= loose) return 0;
  return 1 - (d - tight) / (loose - tight);
}

/**
 * Score a single candidate against a claim. Returns null when the candidate is
 * ineligible (wrong sign, wrong currency, or dated before the outlay).
 */
export function scoreRepaymentCandidate(
  claim: ClaimForMatch,
  cand: CandidateTransaction,
): ScoredCandidate | null {
  const candAmt = toNum(cand.amount);
  // Repayment must be an inflow (positive) — opposite sign to the outlay.
  if (!(candAmt > 0)) return null;
  if (cand.currency !== claim.currency) return null;
  // Must be on or after the outlay date.
  if (cand.date < claim.outlayDate) return null;

  const target = Math.abs(toNum(claim.amount));
  if (!(target > 0)) return null;

  const amountFracDelta = Math.abs(candAmt - target) / target;
  const amountCloseness = rampCloseness(amountFracDelta, AMOUNT_TIGHT, AMOUNT_LOOSE);

  const dateRef = claim.dueDate ?? claim.outlayDate;
  const dDays = daysBetween(cand.date, dateRef);
  const dateProximity = rampCloseness(dDays, DATE_TIGHT_DAYS, DATE_LOOSE_DAYS);

  const score = AMOUNT_WEIGHT * amountCloseness + DATE_WEIGHT * dateProximity;

  return {
    transactionId: cand.id,
    score: Number(score.toFixed(4)),
    amountCloseness: Number(amountCloseness.toFixed(4)),
    dateProximity: Number(dateProximity.toFixed(4)),
    amount: String(cand.amount),
    currency: cand.currency,
    date: cand.date,
    merchant: cand.merchantClean ?? cand.merchant ?? null,
  };
}

/**
 * Rank candidates best-first. Drops ineligible candidates and any whose score
 * is below MIN_SCORE. `limit` caps the result count (default 5).
 */
export function rankRepaymentCandidates(
  claim: ClaimForMatch,
  candidates: CandidateTransaction[],
  limit = 5,
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    const s = scoreRepaymentCandidate(claim, c);
    if (s && s.score >= MIN_SCORE) scored.push(s);
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: closer date first, then smaller id for determinism.
    if (b.dateProximity !== a.dateProximity) {
      return b.dateProximity - a.dateProximity;
    }
    return a.transactionId - b.transactionId;
  });
  return scored.slice(0, Math.max(1, limit));
}
