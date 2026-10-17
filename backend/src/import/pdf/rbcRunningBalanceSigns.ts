import type { StatementParseError } from './types';

/**
 * Signs RBC deposit-account rows from the running balance.
 *
 * RBC prints amounts unsigned and pdfjs glues each row into one span, so the
 * withdrawal/deposit column cannot be read from x-positions. The balance column
 * is the arbiter instead — but RBC prints it only on the LAST row of a same-day
 * group, so a group's earlier rows arrive with no balance of their own.
 *
 * Each run of balance-less rows is therefore solved together with the row that
 * ends it (the one carrying the balance, or the statement's closing balance for
 * a trailing run): of the 2^k sign combinations, keep those whose sum equals the
 * balance change. When several fit — a fee and its rebate net to zero either
 * way round — the row wording breaks the tie; only a tie the wording cannot
 * break is flagged as ambiguous.
 */

export type UnsignedRow = {
  date: string;
  description: string;
  /** Absolute amount as printed. */
  rawAmount: number;
  /** Running balance printed on this row, or null when RBC left it blank. */
  balance: number | null;
};

export type SignedRow = { date: string; description: string; amount: number };

const TOLERANCE = 0.015;
/** 2^12 combinations — far beyond any real same-day group, small enough to brute-force. */
const MAX_RUN = 12;

/** +1 = reads as a credit, -1 = reads as a debit, 0 = wording says nothing. Rebate wins over fee. */
function wordingDirection(description: string): number {
  if (/\b(rebate|refund|reversal|autodeposit|deposit)\b/i.test(description)) return 1;
  if (/\b(fee|withdrawal|purchase)\b/i.test(description)) return -1;
  return 0;
}

function signsFor(mask: number, length: number): number[] {
  // Most-significant bit is the first row, so mask 0 (all credits) comes first —
  // the same order the old pairwise candidate list used for its best guess.
  return Array.from({ length }, (_, idx) => ((mask >> (length - 1 - idx)) & 1 ? -1 : 1));
}

function solveRun(run: UnsignedRow[], target: number): { signs: number[] | null; ambiguous: number } {
  const matches: number[][] = [];
  for (let mask = 0; mask < 2 ** run.length; mask++) {
    const signs = signsFor(mask, run.length);
    const sum = signs.reduce((acc, s, idx) => acc + s * run[idx].rawAmount, 0);
    if (Math.abs(sum - target) < TOLERANCE) matches.push(signs);
  }
  if (matches.length === 0) return { signs: null, ambiguous: 0 };
  if (matches.length === 1) return { signs: matches[0], ambiguous: 0 };

  const score = (signs: number[]) =>
    signs.reduce((acc, s, idx) => acc + s * wordingDirection(run[idx].description), 0);
  const best = Math.max(...matches.map(score));
  const winners = matches.filter((m) => score(m) === best);
  return { signs: winners[0], ambiguous: winners.length > 1 ? winners.length : 0 };
}

export function signByRunningBalance(
  pending: UnsignedRow[],
  openingBalance: number,
  closingBalance: number | null,
): { rows: SignedRow[]; parseErrors: StatementParseError[] } {
  const rows: SignedRow[] = [];
  const parseErrors: StatementParseError[] = [];
  const emit = (r: UnsignedRow, amount: number) =>
    rows.push({ date: r.date, description: r.description, amount });

  let running = openingBalance;
  let i = 0;
  while (i < pending.length) {
    let end = i;
    while (end < pending.length && pending[end].balance === null) end++;
    const anchored = end < pending.length;
    const run = pending.slice(i, anchored ? end + 1 : end);
    const anchorBalance = anchored ? pending[end].balance : closingBalance;

    if (anchored && run.length === 1) {
      // The common case: the row carries its own balance, so its delta decides.
      const r = run[0];
      const delta = r.balance! - running;
      emit(r, Math.abs(delta - r.rawAmount) < TOLERANCE ? r.rawAmount : -r.rawAmount);
      running = r.balance!;
      i++;
      continue;
    }

    if (anchorBalance === null || run.length > MAX_RUN) {
      // No balance to solve against (or an implausibly long run): default the
      // balance-less rows to credit and let the reconciliation gate judge.
      const message = anchorBalance === null
        ? 'Last transaction has no balance column; defaulting to credit'
        : 'No-balance row with multiple unknowns ahead; defaulting to credit';
      for (let k = i; k < end; k++) {
        emit(pending[k], pending[k].rawAmount);
        parseErrors.push({ rowIndex: k + 1, message: `${message}: ${pending[k].description}` });
        running += pending[k].rawAmount;
      }
      i = end;
      continue;
    }

    const { signs, ambiguous } = solveRun(run, anchorBalance - running);
    if (!signs) {
      // Nothing fits: keep the rows visible, sign the anchor by its own delta.
      for (let k = i; k < end; k++) {
        emit(pending[k], pending[k].rawAmount);
        parseErrors.push({ rowIndex: k + 1, message: `Could not determine sign for no-balance row: ${pending[k].description}` });
        running += pending[k].rawAmount;
      }
      if (anchored) {
        const anchor = pending[end];
        const delta = anchorBalance - running;
        emit(anchor, Math.abs(delta - anchor.rawAmount) < TOLERANCE ? anchor.rawAmount : -anchor.rawAmount);
        running = anchorBalance;
      }
      i = i + run.length;
      continue;
    }

    run.forEach((r, idx) => emit(r, signs[idx] * r.rawAmount));
    if (ambiguous) {
      parseErrors.push({
        rowIndex: i + 1,
        message: `ambiguous sign for no-balance row run: ${ambiguous} combinations match delta ${(anchorBalance - running).toFixed(2)} (${run.map((r) => r.description).join(' / ')}); best-guess used`,
      });
    }
    running = anchorBalance;
    i = i + run.length;
  }

  return { rows, parseErrors };
}
