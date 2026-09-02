import { Op } from 'sequelize';
import type { Transaction as SequelizeTransaction } from 'sequelize';
import {
  Account,
  HoldingSnapshot,
  ImportHistory,
  InvestmentActivity,
  Security,
  Transaction,
  TransactionSignal,
  sequelize,
} from '../models';
import { loadAllRules } from './applyRules';
import { recomputeTransactionAmounts } from './calculateShares';
import { findExistingForDedup } from './dedupExisting';
import { normalizeSourceRef } from './normalizeSourceRef';
import { findExistingInvestmentByFuzzyMatch } from './fuzzyDedupInvestmentActivity';
import { stableIdentityFingerprint } from './fingerprint';
import { findMerchantMemory } from '../ai/merchantMemory';
import { enrichTransaction } from './enrich';
import { applyRuleSideEffects, findRuleActionsSignal } from '../rules/applyRuleSideEffects';
import { convertIncomeActivityToAccountCurrency } from './convertActivityCurrency';
import { ensureFxRate } from '../fx/bankOfCanada';
import {
  computeImportConfidence,
  serializeFlags,
} from './computeImportConfidence';
import { extractCounterparty } from './extractCounterparty';
import { resolveCounterpartyContact } from '../contacts/findOrCreateContact';
import type { AccountType } from '@cashflow/shared';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
} from '../config/env';
import {
  loadAmazonOrdersCache,
  loadHouseholdAccountIds,
  loadHouseholdOwnerNames,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from './enrichment/loaders';
import type {
  NormalizedHoldingSnapshot,
  NormalizedInvestmentActivity,
  NormalizedSecurity,
  StatementPreview,
} from './statementTypes';
import type { Signal, TxnType } from './enrichment/types';

/**
 * The txnType the narrative detector actually recognized, or null when it was
 * only guessing. `runDetectTypeStage` emits 'high' confidence exactly when one
 * of its patterns matched the merchant text, and drops to 'medium' (negative
 * amount, no cue → purchase) or 'low' (positive, no cue → unknown) otherwise.
 * That confidence is what lets a source's weak `txnTypeHint` yield to real
 * evidence without yielding to a coin flip.
 */
function narrativeTxnType(signals: Signal[]): TxnType | null {
  const detected = signals.find((s) => s.source === 'type-detect' && s.fields.txnType);
  return detected && detected.confidence === 'high'
    ? (detected.fields.txnType as TxnType)
    : null;
}

/**
 * Types the classifier falls back to when the narrative told it nothing: a
 * negative amount defaults to `purchase`, a positive one to `unknown`. Only
 * these may be overwritten when a link reveals the row was internal movement.
 */
const GUESSED_TXN_TYPES = ['purchase', 'unknown'];

function isUniqueLike(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === 'object' &&
    'name' in e &&
    ((e as { name: string }).name === 'SequelizeUniqueConstraintError' ||
      (e as { name: string }).name === 'SequelizeBulkRecordError')
  );
}

export async function findOrCreateSecurity(
  security: NormalizedSecurity,
  householdId: number | null,
  transaction: SequelizeTransaction
): Promise<Security> {
  const symbol = security.symbol.trim().toUpperCase();
  const currency = security.currency.trim().toUpperCase().slice(0, 3);
  const [row] = await Security.findOrCreate({
    where: {
      householdId,
      symbol,
      currency,
    },
    defaults: {
      householdId,
      symbol,
      currency,
      name: security.name,
      assetType: security.assetType,
    },
    transaction,
  });
  if (
    (security.name && row.name !== security.name) ||
    (security.assetType && row.assetType !== security.assetType)
  ) {
    row.name = row.name || security.name;
    row.assetType = row.assetType || security.assetType;
    await row.save({ transaction });
  }
  return row;
}

async function createInvestmentActivity(
  row: NormalizedInvestmentActivity,
  account: Account,
  preview: StatementPreview,
  t: SequelizeTransaction
): Promise<InvestmentActivity | 'duplicate'> {
  const security = row.security
    ? await findOrCreateSecurity(row.security, account.householdId, t)
    : null;
  // Re-express a foreign-currency income inflow (e.g. a WS crypto staking
  // reward the activities-export reports in USD) in the account's currency.
  // Trades keep their native currency — see convertActivityCurrency.ts.
  const conv = await convertIncomeActivityToAccountCurrency(
    {
      activityType: row.activityType,
      currency: row.currency,
      amount: row.amount ?? null,
      price: row.price ?? null,
      fees: row.fees ?? null,
      tradeDate: row.tradeDate,
    },
    account.defaultCurrency || 'CAD',
    (from, to, date) => ensureFxRate(from, to, date),
  );
  // SAVEPOINT around the INSERT: on Postgres, any query error inside an
  // open transaction aborts the whole transaction and every subsequent
  // query returns "current transaction is aborted". By nesting through
  // sequelize.transaction({ transaction: t }, …) Sequelize emits a
  // SAVEPOINT; if the inner block throws (e.g. unique violation we want
  // to treat as a duplicate), only the savepoint rolls back and the
  // outer transaction stays alive.
  try {
    return await sequelize.transaction({ transaction: t }, async (sp) =>
      InvestmentActivity.create(
        {
          accountId: account.id,
          householdId: account.householdId,
          securityId: security?.id ?? null,
          activityType: row.activityType,
          tradeDate: row.tradeDate,
          settlementDate: row.settlementDate,
          description: row.description,
          quantity: row.quantity == null ? null : String(row.quantity),
          price: conv.price == null ? null : String(conv.price),
          amount: conv.amount == null ? null : String(conv.amount),
          fees: conv.fees == null ? null : String(conv.fees),
          currency: conv.currency ?? row.currency,
          sourceReference: normalizeSourceRef(row.sourceReference),
          sourceRowFingerprint: row.sourceRowFingerprint,
          importBatch: preview.importBatch,
        },
        { transaction: sp }
      )
    );
  } catch (e) {
    if (isUniqueLike(e)) return 'duplicate';
    throw e;
  }
}

async function createHolding(
  row: NormalizedHoldingSnapshot,
  account: Account,
  preview: StatementPreview,
  t: SequelizeTransaction
): Promise<'inserted' | 'duplicate'> {
  const security = await findOrCreateSecurity(row.security, account.householdId, t);
  // SAVEPOINT around the INSERT — same Postgres-safety rationale as
  // createInvestmentActivity. Without this, a unique violation here
  // would poison the surrounding bundle transaction.
  try {
    await sequelize.transaction({ transaction: t }, async (sp) => {
      await HoldingSnapshot.create(
        {
          accountId: account.id,
          householdId: account.householdId,
          securityId: security.id,
          statementDate: row.statementDate,
          quantity: String(row.quantity),
          price: row.price == null ? null : String(row.price),
          marketValue: row.marketValue == null ? null : String(row.marketValue),
          costBasis: row.costBasis == null ? null : String(row.costBasis),
          unrealizedGainLoss:
            row.unrealizedGainLoss == null ? null : String(row.unrealizedGainLoss),
          currency: row.currency,
          sourceReference: normalizeSourceRef(row.sourceReference),
          sourceRowFingerprint: row.sourceRowFingerprint,
          importBatch: preview.importBatch,
        },
        { transaction: sp }
      );
    });
    return 'inserted';
  } catch (e) {
    if (isUniqueLike(e)) return 'duplicate';
    throw e;
  }
}

export async function commitStatementImport(
  preview: StatementPreview,
  userId: number | null,
  householdId: number | null
): Promise<{
  file: string;
  batchLabel: string;
  inserted: number;
  insertedTransactions: number;
  insertedInvestmentActivities: number;
  insertedHoldings: number;
  skippedDuplicates: number;
  rowErrors: number;
  parseErrors: StatementPreview['parseErrors'];
  warnings: string[];
  usedParser: StatementPreview['usedParser'];
  usedProfileId?: string;
  profileInferred?: boolean;
}> {
  const startedAt = new Date();
  const account = await Account.findOne({
    where: {
      id: preview.accountId,
      ...(householdId != null ? { householdId } : {}),
    },
  });
  if (!account) {
    throw Object.assign(new Error('Account no longer exists'), { status: 404 });
  }
  const prior = await ImportHistory.findOne({
    where: {
      contentHash: preview.contentHash,
      status: { [Op.in]: ['success', 'partial'] },
      ...(account.householdId != null ? { householdId: account.householdId } : {}),
    },
  });
  if (prior && (prior.rowCount ?? 0) > 0) {
    return {
      file: preview.fileName,
      batchLabel: preview.importBatch,
      inserted: 0,
      insertedTransactions: 0,
      insertedInvestmentActivities: 0,
      insertedHoldings: 0,
      skippedDuplicates:
        preview.transactions.length +
        preview.investmentActivities.length +
        preview.holdings.length,
      rowErrors: preview.rowErrors,
      parseErrors: preview.parseErrors,
      warnings: [
        ...preview.warnings,
        'This file content was already imported successfully.',
      ],
      usedParser: preview.usedParser,
      usedProfileId: preview.usedProfileId,
      profileInferred: preview.profileInferred,
    };
  }

  const rules = await loadAllRules(account.householdId);
  const amazonOrdersCache = await loadAmazonOrdersCache(account.householdId ?? null);
  const householdAccountIds = await loadHouseholdAccountIds(account.id, account.householdId ?? null);
  const ownerNames = await loadHouseholdOwnerNames(account.householdId ?? null);
  const overrideBusiness = preview.overrideBusiness === true;
  let insertedTransactions = 0;
  let insertedInvestmentActivities = 0;
  let insertedHoldings = 0;
  let skippedDuplicates = 0;

  await sequelize.transaction(async (t) => {
    for (const row of preview.transactions) {
      const identityFp = stableIdentityFingerprint({
        accountId: account.id,
        date: row.date,
        amount: row.amount,
        currency: row.currency,
        merchantRaw: row.merchantRaw,
      });
      const dedup = await findExistingForDedup({
        accountId: account.id,
        sourceIdentityFingerprint: identityFp,
        sourceReference: normalizeSourceRef(row.sourceReference),
        t,
        incomingStatus: 'posted',
        incomingDate: row.date,
        incomingAmount: row.amount,
        incomingCurrency: row.currency,
        incomingMerchantRaw: row.merchantRaw,
      });
      if (dedup.kind !== 'no-match') {
        skippedDuplicates += 1;
        continue;
      }
      // All three reads thread `t` — see the matching comment in runImport.ts:
      // un-threaded raw queries cannot see rows inserted earlier in this same
      // import on Postgres (READ COMMITTED, separate pooled connection).
      const memory = await findMerchantMemory(account.householdId ?? null, row.merchantClean, row.amount, {
        transaction: t,
      });

      const recurringHistory = await loadRecurringHistory(
        account.householdId ?? null,
        row.merchantClean,
        row.date,
        t,
      );
      const relationshipCandidates = await loadRelationshipCandidates(
        account.householdId ?? null,
        householdAccountIds,
        row.merchantClean,
        row.date,
        enrichmentRefundWindowDays,
        t,
      );

      const enriched = await enrichTransaction({
        raw: {
          merchantRaw: row.merchantRaw,
          date: row.date,
          amount: row.amount,
          sourceReference: normalizeSourceRef(row.sourceReference),
          notes: null,
        },
        accountId: account.id,
        householdId: account.householdId ?? null,
        householdAccountIds,
        ownerNames,
        rules,
        amazonOrders: amazonOrdersCache,
        memory,
        recurringHistory,
        relationshipCandidates,
        refundWindowDays: enrichmentRefundWindowDays,
        transferWindowDays: enrichmentTransferWindowDays,
        recurringMinSupport: enrichmentRecurringMinSupport,
        amazonLinkThreshold: enrichmentAmazonLinkThreshold,
      });

      const f = enriched.fields;

      // Wealthsimple bundle imports stamp an authoritative `overrideTxnType`
      // from the WS TX code (BUY → 'investment', AFT_OUT → 'transfer', etc).
      // When present, it wins over the enrichment-pipeline output so the
      // dashboard's spend math correctly excludes these flows. See
      // wealthsimpleTxnType.ts for the mapping and root-cause analysis in
      // backend/scripts/backfill-ws-txn-types.ts.
      // Precedence: a source that KNOWS the type wins outright; a source that
      // only guessed (`txnTypeHint`) loses to a narrative the detector actually
      // recognized, and beats the detector's sign-based fallback. Without the
      // middle tier a WS `WD`/`AFT_OUT` hint of 'transfer' suppressed
      // detectTypeStage's "AMEX BILL PYMT" → payment rule, which is why prod
      // holds 38 credit-card bill payments typed `transfer` against 24 typed
      // `payment` — the same event, split by which importer wrote it.
      const effectiveTxnType =
        row.overrideTxnType ?? narrativeTxnType(enriched.signals) ?? row.txnTypeHint ?? f.txnType;
      const accountVisibility: 'private' | 'shared' =
        account.visibility === 'shared' ? 'shared' : 'private';
      const confidence = computeImportConfidence({
        reviewFlag: f.reviewFlag,
        finalCategory: f.autoCategory,
        autoCategory: f.autoCategory,
        autoSplitType: f.autoSplitType,
        finalSplitType:
          f.autoSplitType === 'partner' || f.autoSplitType === 'shared'
            ? f.autoSplitType
            : 'me',
        txnType: effectiveTxnType,
        accountVisibility,
        linkedTransactionId: f.linkedTransactionId,
        amount: row.amount,
      });

      const _cp = extractCounterparty(
        row.merchantRaw,
        account.accountType as AccountType,
      );
      const counterpartyContactId = await resolveCounterpartyContact(
        account.householdId ?? null,
        _cp,
        { transaction: t },
      );
      const txn = Transaction.build({
        accountId: account.id,
        householdId: account.householdId ?? null,
        createdByUserId: userId ?? account.ownerUserId,
        visibility: accountVisibility,
        ownershipType:
          f.autoSplitType === 'partner' || f.autoSplitType === 'shared' ? f.autoSplitType : 'me',
        ownershipContactId: null,
        counterpartyRaw: _cp?.name ?? null,
        counterpartyContactId,
        importBatch: preview.importBatch,
        date: row.date,
        merchantRaw: row.merchantRaw,
        merchantClean: f.merchantClean,
        merchantCanonical: f.merchantCanonical,
        txnType: effectiveTxnType,
        amount: String(row.amount),
        currency: row.currency,
        notes: f.notes,
        sourceReference: normalizeSourceRef(row.sourceReference),
        sourceRowFingerprint: row.sourceRowFingerprint,
        sourceIdentityFingerprint: identityFp,
        status: 'posted',
        appliedRuleId: f.appliedRuleId,
        autoCategory: f.autoCategory,
        autoBusiness: overrideBusiness ? true : f.autoBusiness,
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
        // transferLinkedAt stamps the forward pointer at the same moment the
        // reverse pointer is written onto the sibling (Fix 2). Without this,
        // the new txn shows as unlinked on the Transfers page even though
        // linkedTransactionId is populated.
        transferLinkedAt: f.linkedTransactionId != null ? new Date() : null,
        isRecurring: f.isRecurring,
        reviewFlag: f.reviewFlag,
        reviewedAt: null,
        importConfidence: confidence.state,
        importConfidenceFlags: serializeFlags(confidence.flags),
      });
      recomputeTransactionAmounts(txn);
      // SAVEPOINT around the per-row insert + its signal sidecar. On
      // Postgres, any unique-violation here would otherwise abort the
      // outer transaction and every subsequent SELECT in this loop
      // would fail with "current transaction is aborted, commands
      // ignored until end of transaction block". Nesting through
      // sequelize.transaction({ transaction: t }, …) emits a SAVEPOINT
      // so the unique-violation rolls back only this row and the loop
      // continues.
      try {
        await sequelize.transaction({ transaction: t }, async (sp) => {
          await txn.save({ transaction: sp });
          if (enriched.signals.length > 0) {
            await TransactionSignal.bulkCreate(
              enriched.signals.map((s) => ({
                transactionId: txn.id,
                source: s.source,
                confidence: s.confidence,
                fields: s.fields,
                rationale: s.rationale ?? null,
              })),
              { transaction: sp },
            );
          }
          // Fix 2: write the reverse pointer back onto the already-persisted
          // sibling. Without this, the link is one-directional — the new txn
          // points at the sibling but the sibling's linked_transaction_id is
          // still NULL, so the Transfers-page unmatched queue keeps showing
          // both legs even after import.
          if (f.linkedTransactionId != null) {
            await Transaction.update(
              {
                linkedTransactionId: txn.id,
                transferLinkedAt: new Date(),
              },
              {
                where: {
                  id: f.linkedTransactionId,
                  // Guard: only back-fill if the sibling is not already
                  // linked to a different txn (prevents clobbering a prior
                  // manual or auto-link on a second re-import).
                  linkedTransactionId: null,
                },
                transaction: sp,
              },
            );
            // Re-typing the sibling is a SEPARATE, narrower write. Linking is
            // real evidence that a row the classifier could only guess at
            // (a bare outflow defaults to `purchase`) was internal movement,
            // and without this those rows inflate dashboard spend. But it is
            // NOT evidence against a type the narrative established: the card
            // leg of a bill payment reads "PAYMENT RECEIVED - THANK YOU" and
            // is a `payment`. Stamping 'transfer' on it demoted four Amex rows
            // in prod, two of them when the deposit-activity cleanup imported
            // their counterparts.
            await Transaction.update(
              { txnType: 'transfer' },
              {
                where: {
                  id: f.linkedTransactionId,
                  txnType: { [Op.in]: GUESSED_TXN_TYPES },
                },
                transaction: sp,
              },
            );
          }

          // Rule actions side-effects (issue #795): set_label / set_alert.
          const ruleActions = findRuleActionsSignal(enriched.signals);
          if (ruleActions) {
            await applyRuleSideEffects({
              ruleActions,
              transactionId: txn.id,
              householdId: account.householdId ?? null,
              transaction: sp,
            });
          }
        });
        insertedTransactions += 1;
      } catch (e) {
        if (isUniqueLike(e)) skippedDuplicates += 1;
        else throw e;
      }
    }

    // Ids no longer eligible as fuzzy-dedup candidates for later rows of
    // this commit: existing rows already matched by an earlier incoming row,
    // plus rows inserted by this commit (visible to the candidate query
    // inside the same SQL transaction). Each candidate may absorb at most
    // ONE incoming row — two legitimate identical activities within the
    // window (recurring buys of pinned-price assets, equal staking rewards)
    // are distinct events, and letting both consume the same candidate
    // silently drops the second one.
    const consumedActivityIds = new Set<number>();
    for (const row of preview.investmentActivities) {
      // When the preview was produced by a multi-source importer
      // (activities-export), run the fuzzy-window matcher BEFORE attempting
      // the insert. The matcher absorbs the T+1..T+3 day drift between
      // "executed at" (monthly statement) and settlement (activities-export)
      // so re-imports do not produce duplicates. A single match backfills
      // settlement_date on the existing row; zero matches insert as new;
      // multi-match logs a warning and skips (review queue surfaced via
      // warnings rather than blocking commit — fewer false multi-matches
      // are expected in practice than no-matches).
      if (preview.crossSourceDedup === 'fuzzy-window-5d') {
        const outcome = await findExistingInvestmentByFuzzyMatch({
          accountId: account.id,
          activityType: row.activityType,
          symbol: row.security?.symbol ?? null,
          quantity: row.quantity,
          amount: row.amount,
          currency: row.currency,
          csvDate: row.settlementDate ?? row.tradeDate,
          excludeIds: consumedActivityIds,
          t,
        });
        if (outcome.kind === 'single-match') {
          if (outcome.backfillSettlement && row.settlementDate) {
            outcome.existing.settlementDate = row.settlementDate;
            await outcome.existing.save({
              transaction: t,
              fields: ['settlementDate'],
            });
          }
          consumedActivityIds.add(outcome.existing.id);
          skippedDuplicates += 1;
          continue;
        }
        if (outcome.kind === 'multi-match') {
          preview.warnings.push(
            `Multi-match on activities-export row (${row.activityType} ${
              row.security?.symbol ?? '-'
            } ${row.tradeDate}); skipped — manual review needed.`,
          );
          skippedDuplicates += 1;
          continue;
        }
        // no-match → fall through to the standard insert path.
      }
      const created = await createInvestmentActivity(row, account, preview, t);
      if (created === 'duplicate') {
        skippedDuplicates += 1;
      } else {
        insertedInvestmentActivities += 1;
        consumedActivityIds.add(created.id);
      }
    }
    for (const row of preview.holdings) {
      const status = await createHolding(row, account, preview, t);
      if (status === 'inserted') insertedHoldings += 1;
      else skippedDuplicates += 1;
    }

    const inserted =
      insertedTransactions + insertedInvestmentActivities + insertedHoldings;
    await ImportHistory.create(
      {
        fileName: preview.fileName,
        filePathSafe: preview.fileName,
        contentHash: preview.contentHash,
        batchLabel: preview.importBatch,
        status:
          preview.rowErrors > 0 && inserted === 0
            ? 'failed'
            : preview.rowErrors > 0
              ? 'partial'
              : 'success',
        rowCount: inserted,
        errorMessage:
          preview.rowErrors > 0
            ? `${preview.rowErrors} row(s) could not be parsed`
            : null,
        startedAt,
        finishedAt: new Date(),
        householdId: account.householdId,
        createdByUserId: userId ?? account.ownerUserId,
        // #231: structured batch metadata. usedProfileId / accountId come
        // from the preview record (CSV preview path) or are null for PDF.
        accountId: account.id,
        profileId: preview.usedProfileId ?? null,
        insertedCount: inserted,
        skippedDuplicateCount: skippedDuplicates,
        rowErrorsCount: preview.rowErrors,
      },
      { transaction: t }
    );
  });

  return {
    file: preview.fileName,
    batchLabel: preview.importBatch,
    inserted:
      insertedTransactions + insertedInvestmentActivities + insertedHoldings,
    insertedTransactions,
    insertedInvestmentActivities,
    insertedHoldings,
    skippedDuplicates,
    rowErrors: preview.rowErrors,
    parseErrors: preview.parseErrors,
    warnings: preview.warnings,
    usedParser: preview.usedParser,
    usedProfileId: preview.usedProfileId,
    profileInferred: preview.profileInferred,
  };
}
