import type { Account } from '../../models/Account';
import type { ExternalOrder } from '../../models/ExternalOrder';
import type { ExternalOrderItem } from '../../models/ExternalOrderItem';
import type { RuleRow } from '../applyRules';

export type Confidence = 'high' | 'medium' | 'low';

export type SignalSource =
  | 'normalize-seed'
  | 'normalize-learned'
  | 'type-detect'
  | 'recurring'
  | 'rule'
  | 'memory'
  | 'amazon-items'
  | 'refund-link'
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
}

export interface PendingEnrichedTxn {
  date: string;
  merchantRaw: string;
  merchantClean: string;
  merchantCanonical: string | null;
  amount: number;
  currency: string;
  txnType: TxnType;
  signals: Signal[];
  /** id once saved; null while still in-flight */
  savedId: number | null;
}

export interface EnrichmentContext {
  account: Account;
  householdId: number | null;
  rulesCache: RuleRow[];
  amazonOrdersCache: Array<ExternalOrder & { items?: ExternalOrderItem[] }>;
  /** Rows already processed in this import (saved or deferred). Used for refund/transfer linking. */
  inFlightBatch: PendingEnrichedTxn[];
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
