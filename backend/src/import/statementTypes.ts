import type { TxnType } from './enrichment/types';
import type { PdfRatePeriod } from './pdf/types';

export type StatementParserId = 'csv' | 'ofx' | 'pdf';

/**
 * One problem a parser hit while reading a statement.
 *
 * `blocking` separates two genuinely different classes of problem:
 *
 *  - **Ordinary (`blocking` omitted/false).** One row could not be read — a bad
 *    date, an undecidable sign, an empty description. The rest of the statement
 *    is still trustworthy, so the import proceeds and the run is labelled
 *    `partial`.
 *  - **Blocking (`blocking: true`).** The statement's OWN arithmetic does not
 *    add up: the parser recomputed the closing balance from the opening balance
 *    plus the rows it produced and got a different number than the one printed
 *    on the page. That is the parser reporting it misread the document — every
 *    row it emitted is suspect, not just one. The commit path refuses these
 *    outright (see `assertStatementReconciles` in reconciliationGate.ts).
 *
 * This is an explicit field on purpose. The reconciliation gate used to be
 * discoverable only by matching the phrase "does not reconcile" in `message`;
 * message strings are prose, not a contract, and a reworded message would
 * silently disarm the gate.
 */
export type StatementParseError = {
  /** 1-based source row, or -1 for a statement-level (not row-level) problem. */
  rowIndex: number;
  message: string;
  /** True when the error invalidates the whole statement, not just one row. */
  blocking?: boolean;
};

export type NormalizedCashTransaction = {
  date: string;
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  currency: string;
  sourceReference: string | null;
  sourceRowFingerprint: string;
  duplicate?: boolean;
  /**
   * Authoritative txnType supplied by the source file when the source has
   * stronger signal than the narrative-detector regex. Used by the
   * Wealthsimple bundle importer to stamp BUY, SELL, DIV, AFT_IN, AFT_OUT,
   * and FEE rows from the WS `transaction` column instead of letting them
   * default to 'purchase' (which would inflate the dashboard totalSpend
   * metric).
   *
   * When set, the commit pipeline uses this value verbatim instead of the
   * enrichment-pipeline output.
   */
  overrideTxnType?: TxnType;
  /**
   * A txnType the source guessed rather than knew. Used where a source code
   * covers several kinds of movement: Wealthsimple's WD / AFT_OUT mean "money
   * left the account" and cover a plain withdrawal and a credit-card bill
   * payment alike.
   *
   * Unlike `overrideTxnType` this LOSES to a high-confidence narrative match,
   * so "Pre-authorized Debit to AMEX BILL PYMT" is typed `payment` by
   * detectTypeStage. It still beats the detector's sign-based fallback, which
   * would otherwise call every one of these outflows a purchase and inflate
   * spend. Set at most one of the two.
   */
  txnTypeHint?: TxnType;
};

export type NormalizedSecurity = {
  symbol: string;
  name: string | null;
  assetType: string | null;
  currency: string;
};

export type NormalizedInvestmentActivity = {
  activityType:
    | 'buy'
    | 'sell'
    | 'dividend'
    | 'interest'
    | 'fee'
    | 'transfer'
    | 'reinvestment'
    | 'split'
    | 'return_of_capital'
    | 'transfer_in'
    | 'transfer_out'
    | 'cash_movement'
    | 'staking_reward'
    | 'other';
  tradeDate: string;
  settlementDate: string | null;
  description: string;
  security: NormalizedSecurity | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fees: number | null;
  /**
   * Stock-split ratio. Only populated when `activityType === 'split'`.
   * 2 means 2-for-1 (qty doubles, ACB/unit halves). 0.1 means 1-for-10
   * reverse split. Always positive.
   */
  splitRatio?: number | null;
  currency: string;
  sourceReference: string | null;
  sourceRowFingerprint: string;
  duplicate?: boolean;
};

export type NormalizedHoldingSnapshot = {
  statementDate: string;
  security: NormalizedSecurity;
  quantity: number;
  price: number | null;
  marketValue: number | null;
  costBasis: number | null;
  unrealizedGainLoss: number | null;
  currency: string;
  sourceReference: string | null;
  sourceRowFingerprint: string;
  duplicate?: boolean;
};

export type StatementPreview = {
  previewToken: string;
  fileName: string;
  contentHash: string;
  accountId: number;
  householdId: number | null;
  importBatch: string;
  usedParser: StatementParserId;
  usedProfileId?: string;
  profileInferred?: boolean;
  headers?: string[];
  transactions: NormalizedCashTransaction[];
  investmentActivities: NormalizedInvestmentActivity[];
  holdings: NormalizedHoldingSnapshot[];
  warnings: string[];
  rowErrors: number;
  parseErrors: StatementParseError[];
  /**
   * Cross-source dedup strategy. When set, the commit pipeline runs the
   * named matcher BEFORE attempting an insert on each investment activity
   * row. Used by the activities-export importer so the same logical event
   * imported via both the unified export and a per-account monthly
   * statement does not produce two InvestmentActivity rows.
   */
  crossSourceDedup?: 'fuzzy-window-5d';
  /**
   * Interest-rate windows printed on the statement's rate-history table, as
   * emitted by the RBC Royal Credit Line parser (`PdfParseResult.ratePeriods`).
   * The commit pipeline upserts these into `account_rate_periods` keyed on
   * (accountId, fromDate). Absent for every source that prints no rate table.
   *
   * Type-only import of `PdfRatePeriod` — pdf/types.ts imports the Normalized*
   * types from here, so a value import would close a runtime cycle.
   */
  ratePeriods?: PdfRatePeriod[];
  /**
   * When true, every Transaction inserted during commit forces
   * autoBusiness=true, regardless of what the enrichment pipeline produced.
   * Used by the Wealthsimple bundle importer to mark corporate-account txns
   * (Save for business, Corporate investing) as business income/expenses.
   */
  overrideBusiness?: boolean;
  duplicateCounts: {
    transactions: number;
    investmentActivities: number;
    holdings: number;
  };
  rows?: Array<
    | {
        rowIndex: number;
        ok: true;
        mapped: {
          date: string;
          merchantClean: string;
          amount: number;
          currency: string;
        };
      }
    | { rowIndex: number; ok: false; error: string }
  >;
};
