export type Confidence = 'high' | 'medium' | 'low';

export type SignalSource =
  | 'normalize-seed'
  | 'normalize-learned'
  | 'ws-investment'
  | 'type-detect'
  | 'recurring'
  | 'rule'
  | 'memory'
  | 'item-link'
  | 'refund-link'
  | 'refund-link-suggested'
  | 'transfer-link'
  | 'ai';

export type TxnType =
  | 'purchase'
  | 'refund'
  | 'transfer'
  | 'payment'
  | 'fee'
  | 'interest'
  | 'reward'
  | 'investment'
  | 'dividend'
  | 'income'
  | 'unknown';

export type SignalFields = Partial<{
  merchantClean: string;
  merchantCanonical: string | null;
  txnType: TxnType;
  autoCategory: string | null;
  autoBusiness: boolean | null;
  autoSplitType: string | null;
  autoPctMe: string | null;
  autoPctPartner: string | null;
  appliedRuleId: number | null;
  linkedTransactionId: number | null;
  linkedExternalOrderId: number | null;
  isRecurring: boolean;
  notes: string | null;
}>;

export interface Signal {
  source: SignalSource;
  confidence: Confidence;
  fields: SignalFields;
  rationale?: string;
  /**
   * Set only by the item-link stage: the concrete order match to persist as a
   * suggested TransactionOrderLink at import/backfill time. Ignored by
   * mergeSignals (not in AUTO_FIELD_KEYS) and by TransactionSignal storage.
   */
  orderLink?: { externalOrderId: number; confidence: number; matchReason: string };
}


export interface EnrichmentResultFields {
  merchantClean: string;
  merchantCanonical: string | null;
  txnType: TxnType;
  autoCategory: string | null;
  autoBusiness: boolean | null;
  autoSplitType: string | null;
  autoPctMe: string | null;
  autoPctPartner: string | null;
  appliedRuleId: number | null;
  linkedTransactionId: number | null;
  linkedExternalOrderId: number | null;
  isRecurring: boolean;
  notes: string | null;
  autoSource: SignalSource | 'composite' | null;
  autoConfidence: Confidence | null;
  reviewFlag: boolean;
}

export interface EnrichmentResult {
  fields: EnrichmentResultFields;
  signals: Signal[];
}
