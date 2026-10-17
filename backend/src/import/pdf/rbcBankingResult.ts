import { normalizeMerchant } from '../normalizeMerchant';
import type { PdfParseResult, PdfStatementHeader, StatementParseError } from './types';

/**
 * Shared tail of the RBC personal- and business-banking parsers: turn the
 * signed activity rows into transactions, run the reconciliation gate, and
 * hand the statement's opening/closing balance to the import pipeline.
 *
 * Reconciliation gate: opening + Σsigned ≈ closing. Wrong signs/amounts must
 * not be silent. A mismatch is marked `blocking: true`: it is not one bad row,
 * it is the parser reporting that it misread the document, so
 * commitStatementImport refuses the import outright. A missing closing balance
 * only means the gate could not run — that stays a plain (non-blocking) parse
 * error, and there is then no statement balance to persist.
 */
export function rbcBankingResult(args: {
  header: PdfStatementHeader;
  rows: ReadonlyArray<{ date: string; description: string; amount: number }>;
  parseErrors: StatementParseError[];
  openingBalance: number;
  closingBalance: number | null;
  currency: string;
}): PdfParseResult {
  const { header, parseErrors, openingBalance, closingBalance } = args;
  const transactions: PdfParseResult['transactions'] = args.rows.map((row) => ({
    date: row.date,
    merchantRaw: row.description,
    merchantClean: normalizeMerchant(row.description),
    amount: row.amount,
    currency: args.currency,
    sourceReference: null,
  }));

  if (closingBalance === null) {
    parseErrors.push({
      rowIndex: -1,
      message: 'reconciliation: could not extract closing balance from statement; gate skipped',
    });
    return { transactions, header, warnings: [], parseErrors };
  }

  const sumSigned = transactions.reduce((acc, t) => acc + t.amount, 0);
  const recomputed = openingBalance + sumSigned;
  if (Math.abs(recomputed - closingBalance) > 0.015) {
    parseErrors.push({
      rowIndex: -1,
      blocking: true,
      message:
        `statement does not reconcile: opening ${openingBalance} + sum ${sumSigned.toFixed(2)} = ${recomputed.toFixed(2)}, expected closing ${closingBalance}`,
    });
  }
  return {
    transactions,
    header,
    statementBalances: { opening: openingBalance, closing: closingBalance },
    warnings: [],
    parseErrors,
  };
}
