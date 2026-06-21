/**
 * Pure decision logic for the one-off historical income backfill
 * (`backfill-income-payer-anchored.ts`). No DB imports — unit-testable in
 * isolation against the REAL importer heuristic.
 *
 * Problem: the live importer heuristic (`runDetectTypeStage` →
 * `detectsIncome`) only tags `income` when the narration matches
 * "direct deposit from <X>" or a payroll word. Historical employer deposits
 * landed with bank narrations like "Misc Payment CDG LABS INC" — the SAME
 * income stream, different label — so the heuristic alone re-tags none of
 * them.
 *
 * Approach (payer-anchored): treat the heuristic as the source of truth for
 * WHO is an income payer. Pass 1 derives the set of external payers the
 * heuristic already classifies as income (from their "direct deposit from
 * <X>" rows). Pass 2 re-tags positive-amount `unknown`/`transfer` rows that
 * either the heuristic itself calls income (strict reuse) or whose narration
 * names one of those same payers. Own-name self-deposits never enter the
 * payer set (the heuristic tags them `transfer`), so payer-anchoring inherits
 * the own-name exclusion for free.
 */
import { runDetectTypeStage } from '../src/import/enrichment/detectTypeStage';

/** A historical row being considered for re-tagging. */
export interface CandidateRow {
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  txnType: string;
}

/** Current txn_types we are willing to flip to income. Deliberately narrow. */
const ELIGIBLE_TYPES = new Set(['unknown', 'transfer']);

/** Min token count for a derived payer name — guards against a generic
 * single word (e.g. a first name) matching unrelated rows. */
const MIN_PAYER_TOKENS = 2;

const DIRECT_DEPOSIT_FROM_RE = /\bdirect deposit from\b\s*(.+)$/i;

/** Lowercase + collapse non-alphanumerics to single spaces, for substring
 * matching that is robust to punctuation/whitespace differences between the
 * "direct deposit from" anchor row and the variant narrations. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Extract the normalized payer name from a "direct deposit from <X>"
 * narration. Returns null if the text isn't a direct-deposit-from line or the
 * payer is shorter than the min-token guard. Tries merchantRaw first, then
 * merchantClean.
 */
export function normalizePayer(merchantRaw: string, merchantClean = ''): string | null {
  for (const text of [merchantRaw, merchantClean]) {
    if (!text) continue;
    const m = DIRECT_DEPOSIT_FROM_RE.exec(text);
    if (!m) continue;
    const payer = normalizeText(m[1]);
    if (payer.split(' ').filter(Boolean).length < MIN_PAYER_TOKENS) return null;
    return payer;
  }
  return null;
}

/** Does the LIVE importer heuristic classify this row as income? */
function heuristicSaysIncome(
  merchantRaw: string,
  merchantClean: string,
  amount: number,
  ownerNames: string[],
): boolean {
  const signals = runDetectTypeStage({ merchantRaw, merchantClean, amount, ownerNames });
  return signals[0]?.fields?.txnType === 'income';
}

/**
 * Pass 1 — derive the set of income payers: the normalized payer names from
 * rows the live heuristic already tags income via "direct deposit from <X>".
 * Own-name self-deposits are excluded automatically (the heuristic tags them
 * transfer, so they never reach payer extraction).
 */
export function deriveIncomePayers(
  rows: Array<{ merchantRaw: string; merchantClean: string; amount: number }>,
  ownerNames: string[],
): Set<string> {
  const payers = new Set<string>();
  for (const r of rows) {
    if (!heuristicSaysIncome(r.merchantRaw, r.merchantClean, r.amount, ownerNames)) continue;
    const payer = normalizePayer(r.merchantRaw, r.merchantClean);
    if (payer) payers.add(payer);
  }
  return payers;
}

/**
 * Pass 2 — should this row be re-tagged income? True iff it is a positive,
 * currently-`unknown`/`transfer` row that EITHER the heuristic itself calls
 * income OR whose narration names a derived income payer.
 */
export function decideRetag(
  row: CandidateRow,
  incomePayers: Set<string>,
  ownerNames: string[],
): boolean {
  if (!(row.amount > 0)) return false;
  if (row.txnType === 'income') return false;
  if (!ELIGIBLE_TYPES.has(row.txnType)) return false;

  // Strict-reuse subset: the live heuristic itself recognizes this as income.
  if (heuristicSaysIncome(row.merchantRaw, row.merchantClean, row.amount, ownerNames)) {
    return true;
  }

  // Payer-anchored: the same external employer, under a different narration.
  const haystack = normalizeText(`${row.merchantRaw} ${row.merchantClean}`);
  for (const payer of incomePayers) {
    if (haystack.includes(payer)) return true;
  }
  return false;
}
