import type { PdfLine, PdfStatementBalances, PdfStatementHeader } from './types';
import { MONTHS_SHORT, toIso } from './dateHelpers';

/**
 * The bill printed on page 1 of an Amex Canada statement (Aeroplan Reserve and
 * Cobalt share the layout). Two places carry it:
 *
 *   ACCOUNT SUMMARY block   "Previous Balance  $X Credit Limit  $Y"
 *                           "Equals New Balance  $X"
 *                           "Minimum Amount Due on Oct 15, 2026  $X  If each month…"
 *   payment coupon          "…New Balance  $X" / "…Minimum Due  $X" /
 *                           "…Payment Due Date  Oct 15, 2026"
 *
 * The summary block is read first; the coupon is the fallback (it carries no
 * previous balance). Amounts are the amount owed, positive; a credit balance
 * (leading minus, as Amex prints credits, or a trailing "CR") comes out
 * negative. Every field is null when absent — a missing summary must never
 * break the transaction path.
 */
export type AmexStatementSummary = {
  newBalance: number | null;
  previousBalance: number | null;
  minimumPayment: number | null;
  paymentDueDate: string | null;
};

// Groups: sign ("-$", "$-" or "$"), digits, optional trailing CR.
const MONEY = String.raw`(-?\$-?)([\d,]+\.\d{2})(\s*CR\b)?`;
const DATE = String.raw`([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})`;

// "New Balance" matches both "Equals New Balance $X" and the coupon's
// "…New Balance $X"; fine print mentioning "the New Balance" has no amount.
const NEW_BALANCE_RES = [new RegExp(String.raw`\bNew Balance\s+${MONEY}`)];
// First money token only: the Credit Limit column shares this line.
const PREVIOUS_BALANCE_RES = [new RegExp(String.raw`^\s*Previous Balance\s+${MONEY}`)];
const MINIMUM_RES = [
  new RegExp(String.raw`Minimum Amount Due on ${DATE}\s+${MONEY}`),
  new RegExp(String.raw`\bMinimum Due\s+${MONEY}`),
];
// Where each MINIMUM_RES entry's MONEY groups start: the summary-block form
// has the three date groups first.
const MINIMUM_AMOUNT_AT = [4, 1];
const DUE_DATE_RES = [
  new RegExp(String.raw`Minimum Amount Due on ${DATE}`),
  new RegExp(String.raw`\bPayment Due Date\s+${DATE}`),
];

/** Signed amount from the three MONEY groups starting at `at`. */
function moneyAt(m: RegExpExecArray, at: number): number {
  const value = Number(m[at + 1].replace(/,/g, ''));
  const credit = m[at].includes('-') || m[at + 2] !== undefined;
  // `+ 0` folds a credit-signed $0.00 (-0) back to 0.
  return (credit ? -value : value) + 0;
}

function dateAt(m: RegExpExecArray): string | null {
  const month = MONTHS_SHORT[m[1]];
  return month === undefined ? null : toIso(Number(m[3]), month, Number(m[2]));
}

/**
 * Read the first match of `res` — tried in priority order, each across every
 * line — with `read`; null when nothing matches.
 */
function pick<T>(
  texts: string[],
  res: RegExp[],
  read: (m: RegExpExecArray, which: number) => T,
): T | null {
  for (let which = 0; which < res.length; which++) {
    for (const t of texts) {
      const m = res[which].exec(t);
      if (m) return read(m, which);
    }
  }
  return null;
}

export function parseAmexStatementSummary(lines: PdfLine[]): AmexStatementSummary {
  const texts = lines.filter((l) => l.page === 1).map((l) => l.text);
  return {
    newBalance: pick(texts, NEW_BALANCE_RES, (m) => moneyAt(m, 1)),
    previousBalance: pick(texts, PREVIOUS_BALANCE_RES, (m) => moneyAt(m, 1)),
    minimumPayment: pick(texts, MINIMUM_RES, (m, which) => moneyAt(m, MINIMUM_AMOUNT_AT[which])),
    paymentDueDate: pick(texts, DUE_DATE_RES, dateAt),
  };
}

/**
 * The parse-result fields the bill feeds: the header's statement balance,
 * minimum and due date (→ applyCreditCardStatementSummary), and the
 * opening/closing pair (→ account_statements, amount owed positive). With no
 * closing balance there is no `statementBalances`, and the commit warns that
 * the balance was not read.
 */
export function amexBillFields(lines: PdfLine[]): {
  header: Pick<PdfStatementHeader, 'statementBalance' | 'minimumPayment' | 'paymentDueDate'>;
  result: { statementBalances?: PdfStatementBalances };
} {
  const bill = parseAmexStatementSummary(lines);
  return {
    header: {
      statementBalance: bill.newBalance,
      minimumPayment: bill.minimumPayment,
      paymentDueDate: bill.paymentDueDate,
    },
    result:
      bill.newBalance == null
        ? {}
        : { statementBalances: { opening: bill.previousBalance, closing: bill.newBalance } },
  };
}
