export type StatementParserId = 'csv' | 'ofx';

export type NormalizedCashTransaction = {
  date: string;
  merchantRaw: string;
  merchantClean: string;
  amount: number;
  currency: string;
  sourceReference: string | null;
  sourceRowFingerprint: string;
  duplicate?: boolean;
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
    | 'cash_movement'
    | 'other';
  tradeDate: string;
  settlementDate: string | null;
  description: string;
  security: NormalizedSecurity | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fees: number | null;
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
