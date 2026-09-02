import type { TxnType } from './enrichment/types';

export type StatementParserId = 'csv' | 'ofx' | 'pdf';

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
  parseErrors: { rowIndex: number; message: string }[];
  /**
   * Cross-source dedup strategy. When set, the commit pipeline runs the
   * named matcher BEFORE attempting an insert on each investment activity
   * row. Used by the activities-export importer so the same logical event
   * imported via both the unified export and a per-account monthly
   * statement does not produce two InvestmentActivity rows.
   */
  crossSourceDedup?: 'fuzzy-window-5d';
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
