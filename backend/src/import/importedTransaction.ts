/**
 * The one place an importer turns an enriched cash row into a `Transaction`.
 *
 * CSV import (`runImport.importCsvFile`) and statement import
 * (`commitStatementImport`) used to each carry their own copy of this, and the
 * copies drifted: the statement path learned to stamp `transferLinkedAt`, write
 * the reverse pointer onto the matched leg, extract the counterparty, normalize
 * the source reference and resolve the type with the narrative-beats-hint ladder,
 * and the CSV path learned none of it. A CSV-imported transfer therefore stayed
 * half-linked and sat in the Transfers unmatched queue. Both importers now call
 * `buildImportedTransaction` + `persistImportedTransaction`, so a row produces the
 * same columns whichever importer wrote it.
 *
 * What stays with the callers: parsing, dedup, the enrichment call itself (its
 * inputs are identical, but the loaders thread the caller's transaction), the
 * savepoint and its unique-violation handling, and the per-import counters.
 */
import { Op } from 'sequelize';
import type { Transaction as DbTransaction } from 'sequelize';
import type { AccountType } from '@cashflow/shared';
import { Transaction } from '../models';
import type { Account } from '../models/Account';
import type { MerchantMemoryMatch } from '../ai/merchantMemory';
import { resolveCounterpartyContact } from '../contacts/findOrCreateContact';
import { ownershipContactIdFor } from '../contacts/solePartner';
import { applyRuleSideEffects, findRuleActionsSignal } from '../rules/applyRuleSideEffects';
import { recomputeTransactionAmounts } from './calculateShares';
import { computeImportConfidence, serializeFlags } from './computeImportConfidence';
import { extractCounterparty } from './extractCounterparty';
import { normalizeSourceRef } from './normalizeSourceRef';
import { narrativeTxnType } from './resolveRelationshipTxnType';
import type { ColdRow } from './enrichment/aiBatchOverColdRows';
import { persistSuggestedOrderLink, persistTransactionSignals } from './enrichment/persistSignals';
import type { EnrichmentResult, Signal, TxnType } from './enrichment/types';

/** One cash row as an importer hands it over, after its own parsing and dedup. */
export interface ImportedCashRow {
  date: string;
  merchantRaw: string;
  amount: number;
  currency: string;
  /** As parsed. Normalized here, the same way the caller normalized it for dedup. */
  sourceReference: string | null | undefined;
  sourceRowFingerprint: string;
  sourceIdentityFingerprint: string;
  /** The source KNOWS the type (e.g. a Wealthsimple TX code). */
  overrideTxnType?: TxnType | null;
  /** The source only guessed the type; a confident narrative beats it. */
  txnTypeHint?: TxnType | null;
}

export interface ImportedTransactionContext {
  account: Account;
  householdId: number | null;
  createdByUserId: number | null;
  importBatch: string;
  /** Statement-level "everything in this file is business". */
  overrideBusiness?: boolean;
  /** Absent means authoritative; only the SimpleFIN feed declares itself provisional. */
  sourceTier?: string;
  /** The household's only partner contact, stamped onto partner/shared splits. */
  solePartnerContactId?: number | null;
}

/**
 * Types the classifier falls back to when the narrative told it nothing: a
 * negative amount defaults to `purchase`, a positive one to `unknown`. Only
 * these may be overwritten when a link reveals the row was internal movement.
 */
export const GUESSED_TXN_TYPES = ['purchase', 'unknown'];

function ruleTxnType(signals: Signal[]): TxnType | null {
  return signals.find((s) => s.source === 'rule' && s.fields.txnType)?.fields.txnType ?? null;
}

/**
 * The type stored on the row.
 *
 *   1. the source's authoritative `overrideTxnType`
 *   2. a user rule's `set_txn_type`
 *   3. a HIGH-confidence narrative detection
 *   4. the source's weak `txnTypeHint`
 *   5. whatever the pipeline merged
 *
 * Tier 3 above tier 4 is why this exists: a Wealthsimple `WD`/`AFT_OUT` hint of
 * 'transfer' used to suppress detectTypeStage's "AMEX BILL PYMT" → payment rule,
 * which is why prod held 38 credit-card bill payments typed `transfer` against 24
 * typed `payment` — the same event, split by which importer wrote it.
 *
 * Tier 2 above tier 3 keeps what `mergeSignals` already decides (a rule outranks
 * type-detect there). Without it the ladder would quietly ignore a rule the user
 * wrote precisely because the narrative read wrong.
 */
export function resolveImportedTxnType(
  row: Pick<ImportedCashRow, 'overrideTxnType' | 'txnTypeHint'>,
  enriched: EnrichmentResult,
): TxnType {
  return (
    row.overrideTxnType
    ?? ruleTxnType(enriched.signals)
    ?? narrativeTxnType(enriched.signals)
    ?? row.txnTypeHint
    ?? enriched.fields.txnType
  );
}

/**
 * The sibling this row was paired with as the other leg of a transfer (or card
 * payment), or null. `linkedTransactionId` alone is not enough: a refund-link
 * also sets it, pointing a refund at its original purchase, and that original
 * must not be re-typed `transfer` or stamped as a linked transfer leg.
 */
export function transferSiblingId(enriched: EnrichmentResult): number | null {
  const id = enriched.fields.linkedTransactionId;
  if (id == null) return null;
  const fromTransferLink = enriched.signals.some(
    (s) => s.source === 'transfer-link' && s.fields.linkedTransactionId === id,
  );
  return fromTransferLink ? id : null;
}

export interface BuiltImportedTransaction {
  txn: Transaction;
  /** The type actually stored, which the cold-row fallbacks recompute confidence from. */
  txnType: TxnType;
  accountVisibility: 'private' | 'shared';
}

export async function buildImportedTransaction(
  row: ImportedCashRow,
  enriched: EnrichmentResult,
  ctx: ImportedTransactionContext,
  t: DbTransaction,
): Promise<BuiltImportedTransaction> {
  const f = enriched.fields;
  const { account } = ctx;
  const txnType = resolveImportedTxnType(row, enriched);
  const accountVisibility: 'private' | 'shared' =
    account.visibility === 'shared' ? 'shared' : 'private';
  const splitType =
    f.autoSplitType === 'partner' || f.autoSplitType === 'shared' ? f.autoSplitType : 'me';
  const confidence = computeImportConfidence({
    reviewFlag: f.reviewFlag,
    finalCategory: f.autoCategory,
    autoCategory: f.autoCategory,
    autoSplitType: f.autoSplitType,
    finalSplitType: splitType,
    txnType,
    accountVisibility,
    linkedTransactionId: f.linkedTransactionId,
    amount: row.amount,
  });

  const counterparty = extractCounterparty(row.merchantRaw, account.accountType as AccountType);
  const counterpartyContactId = await resolveCounterpartyContact(ctx.householdId, counterparty, {
    transaction: t,
  });

  const txn = Transaction.build({
    accountId: account.id,
    householdId: ctx.householdId,
    createdByUserId: ctx.createdByUserId,
    visibility: accountVisibility,
    ownershipType: splitType,
    ownershipContactId: ownershipContactIdFor(splitType, ctx.solePartnerContactId ?? null),
    counterpartyRaw: counterparty?.name ?? null,
    counterpartyContactId,
    importBatch: ctx.importBatch,
    date: row.date,
    merchantRaw: row.merchantRaw,
    merchantClean: f.merchantClean,
    merchantCanonical: f.merchantCanonical,
    txnType,
    amount: String(row.amount),
    currency: row.currency,
    notes: f.notes,
    sourceReference: normalizeSourceRef(row.sourceReference),
    sourceRowFingerprint: row.sourceRowFingerprint,
    sourceIdentityFingerprint: row.sourceIdentityFingerprint,
    status: 'posted',
    appliedRuleId: f.appliedRuleId,
    autoCategory: f.autoCategory,
    autoBusiness: ctx.overrideBusiness ? true : f.autoBusiness,
    autoSplitType: f.autoSplitType,
    autoPctMe: f.autoPctMe,
    autoPctPartner: f.autoPctPartner,
    categoryOverride: null,
    businessOverride: null,
    splitOverride: null,
    pctMeOverride: null,
    pctPartnerOverride: null,
    autoSource: f.autoSource,
    autoConfidence: f.autoConfidence,
    linkedTransactionId: f.linkedTransactionId,
    // Stamped at the same moment persistImportedTransaction writes the reverse
    // pointer onto the sibling. Without it the new leg shows as unlinked on the
    // Transfers page even though linkedTransactionId is populated.
    transferLinkedAt: transferSiblingId(enriched) != null ? new Date() : null,
    isRecurring: f.isRecurring,
    reviewFlag: f.reviewFlag,
    reviewedAt: null,
    importConfidence: confidence.state,
    importConfidenceFlags: serializeFlags(confidence.flags),
    sourceTier: ctx.sourceTier ?? 'authoritative',
  });
  recomputeTransactionAmounts(txn);
  return { txn, txnType, accountVisibility };
}

/**
 * Write the reverse pointer that makes a transfer link two-way: the sibling
 * points back at `txnId`, stamped `linkedAt`. Without it the link is
 * one-directional: `txnId` points at the sibling but the sibling's
 * linked_transaction_id is still NULL, so the Transfers-page unmatched queue
 * keeps showing both legs.
 *
 * Returns false, and writes nothing, when the sibling is linked to a different
 * row: a prior manual or auto link is never clobbered. Callers that
 * may only hold two-way links (the enrichment backfill) drop their own pointer
 * on false.
 *
 * Instance hooks run (`individualHooks`), so the sibling's change is recorded
 * as a TransactionRevision.
 */
export async function linkTransferSibling(
  txnId: number,
  siblingId: number,
  linkedAt: Date,
  t: DbTransaction,
): Promise<boolean> {
  const [linked] = await Transaction.update(
    { linkedTransactionId: txnId, transferLinkedAt: linkedAt },
    {
      // Unlinked, or already pointing back at us (the other leg was linked first
      // by an older, one-sided write): both complete the pair.
      where: { id: siblingId, linkedTransactionId: { [Op.or]: [null, txnId] } },
      transaction: t,
      individualHooks: true,
    },
  );
  if (linked === 0) return false;
  // Re-typing the sibling is a SEPARATE, narrower write. Linking is real
  // evidence that a row the classifier could only guess at (a bare outflow
  // defaults to `purchase`) was internal movement, and without this those rows
  // inflate dashboard spend. But it is NOT evidence against a type the
  // narrative established: the card leg of a bill payment reads "PAYMENT
  // RECEIVED - THANK YOU" and is a `payment`. Stamping 'transfer' on it demoted
  // four Amex rows in prod.
  await Transaction.update(
    { txnType: 'transfer' },
    {
      where: { id: siblingId, txnType: { [Op.in]: GUESSED_TXN_TYPES } },
      transaction: t,
      individualHooks: true,
    },
  );
  return true;
}

/**
 * Insert the built row and everything that hangs off it. Run inside the caller's
 * per-row SAVEPOINT so a unique-violation rolls back only this row.
 */
export async function persistImportedTransaction(
  txn: Transaction,
  enriched: EnrichmentResult,
  householdId: number | null,
  sp: DbTransaction,
): Promise<void> {
  await txn.save({ transaction: sp });
  await persistTransactionSignals(txn.id, enriched.signals, sp);
  // Surfaces the item-link match as a suggested TransactionOrderLink.
  await persistSuggestedOrderLink(txn.id, enriched.signals, sp);

  const siblingId = transferSiblingId(enriched);
  if (siblingId != null && txn.transferLinkedAt != null) {
    await linkTransferSibling(txn.id, siblingId, txn.transferLinkedAt, sp);
  }

  // Rule actions side-effects (issue #795): set_label / set_alert.
  const ruleActions = findRuleActionsSignal(enriched.signals);
  if (ruleActions) {
    await applyRuleSideEffects({
      ruleActions,
      transactionId: txn.id,
      householdId,
      transaction: sp,
    });
  }
}

/**
 * The cold-row entry for a row the deterministic stages could not resolve
 * (review_flag still true), or null. Same gate for both importers so they cannot
 * drift apart on which rows the post-commit fallbacks see.
 */
export function coldRowFor(
  built: BuiltImportedTransaction,
  enriched: EnrichmentResult,
  row: ImportedCashRow,
  memory: MerchantMemoryMatch | null,
): ColdRow | null {
  const f = enriched.fields;
  if (!f.reviewFlag) return null;
  const merchantKey = (f.merchantCanonical ?? '').trim() || f.merchantClean.trim();
  if (merchantKey.length === 0) return null;
  return {
    txnId: built.txn.id,
    signals: enriched.signals,
    merchantKey,
    merchantRaw: row.merchantRaw,
    merchantClean: f.merchantClean,
    merchantCanonical: f.merchantCanonical,
    amount: row.amount,
    date: row.date,
    currency: row.currency,
    memory,
    accountVisibility: built.accountVisibility,
    txnType: built.txnType,
    // Brand-new row: it cannot carry a user override yet.
    categoryOverride: null,
  };
}
