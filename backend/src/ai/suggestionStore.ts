import type { Request } from 'express';
import type { Transaction as SqlTransaction, WhereOptions } from 'sequelize';
import { AiSuggestion, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { isSuperadmin, visibleTransactionWhere } from '../auth/scope';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { serializeTransaction } from '../util/serializeTransaction';
import { scoreTransactionSuggestion, type TransactionFinalSnapshot } from './evaluateSuggestion';
import type { AiSuggestion as TransactionSuggestion } from './suggestTransaction';

export function finalSnapshotFromTransaction(txn: Transaction): TransactionFinalSnapshot {
  return {
    category: txn.finalCategory,
    business: txn.finalBusiness,
    splitType: txn.finalSplitType,
    pctMe: txn.finalPctMe == null ? null : Number(txn.finalPctMe),
    pctPartner: txn.finalPctPartner == null ? null : Number(txn.finalPctPartner),
    notes: txn.notes,
  };
}

export async function createTrackedSuggestion(params: {
  req: Request;
  transactionId?: number | null;
  receiptId?: number | null;
  kind:
    | 'transaction_fields'
    | 'transaction_audit'
    | 'amazon_item_categories'
    | 'receipt_extract'
    | 'financial_insight'
    | 'rule_proposal';
  inputSnapshot: unknown;
  output: unknown;
  model?: string | null;
  promptVersion?: string | null;
  temperature?: number | null;
  latencyMs?: number | null;
  providerRequestId?: string | null;
  errorMessage?: string | null;
  status?: 'suggested' | 'failed' | 'rejected';
  transaction?: SqlTransaction;
}): Promise<AiSuggestion> {
  const { user, household } = currentAuth(params.req);
  return AiSuggestion.create(
    {
      householdId: household.id,
      userId: user.id,
      transactionId: params.transactionId ?? null,
      receiptId: params.receiptId ?? null,
      kind: params.kind,
      status: params.status ?? 'suggested',
      inputSnapshot: params.inputSnapshot,
      output: params.output,
      finalSnapshot: null,
      model: params.model ?? null,
      promptVersion: params.promptVersion ?? null,
      temperature:
        params.temperature == null ? null : String(params.temperature),
      latencyMs: params.latencyMs ?? null,
      providerRequestId: params.providerRequestId ?? null,
      errorMessage: params.errorMessage ?? null,
    },
    { transaction: params.transaction },
  );
}

export function aiSuggestionWhere(req: Request): WhereOptions {
  if (isSuperadmin(req)) return {};
  return { householdId: currentAuth(req).household.id };
}

export async function markTransactionSuggestionOutcome(
  req: Request,
  suggestionId: number,
  txn: Transaction,
): Promise<void> {
  const row = await AiSuggestion.findOne({
    where: {
      id: suggestionId,
      transactionId: txn.id,
      kind: 'transaction_fields',
      ...aiSuggestionWhere(req),
    },
  });
  if (!row) return;
  const output = row.output as TransactionSuggestion | null;
  if (!output) return;
  const finalSnapshot = finalSnapshotFromTransaction(txn);
  const scored = scoreTransactionSuggestion(output, finalSnapshot);
  await row.update({
    status: scored.status,
    finalSnapshot: { ...finalSnapshot, metrics: scored.metrics },
  });
}

export async function applyTransactionSuggestion(
  req: Request,
  suggestionId: number,
): Promise<Record<string, unknown>> {
  const suggestion = await AiSuggestion.findOne({
    where: {
      id: suggestionId,
      kind: 'transaction_fields',
      status: 'suggested',
      ...aiSuggestionWhere(req),
    },
  });
  if (!suggestion || suggestion.transactionId == null) {
    const err = new Error('Suggestion not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const txn = await Transaction.findOne({
    where: { id: suggestion.transactionId, ...visibleTransactionWhere(req) },
  });
  if (!txn) {
    const err = new Error('Transaction not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  const out = suggestion.output as TransactionSuggestion;
  if (out.category != null) txn.set('categoryOverride', out.category);
  if (out.business != null) txn.set('businessOverride', out.business);
  if (out.splitType != null) txn.set('splitOverride', out.splitType);
  if (out.pctMe != null) txn.set('pctMeOverride', String(out.pctMe));
  if (out.pctPartner != null) txn.set('pctPartnerOverride', String(out.pctPartner));
  if (out.notes != null) txn.set('notes', out.notes);
  txn.set('reviewFlag', false);
  txn.set('reviewedAt', new Date());
  recomputeTransactionAmounts(txn);
  await txn.save();
  await markTransactionSuggestionOutcome(req, suggestion.id, txn);
  return serializeTransaction(txn);
}
