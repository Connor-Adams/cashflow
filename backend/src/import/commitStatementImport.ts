import { Op } from 'sequelize';
import type { Transaction as SequelizeTransaction } from 'sequelize';
import {
  Account,
  AccountRatePeriod,
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
import { assertStatementReconciles } from './reconciliationGate';
import { resolveCounterpartyContact } from '../contacts/findOrCreateContact';
import { markInterestAllocationPending } from '../contacts/interestAllocationCoordinator';
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

/**
 * Upsert the statement's interest-rate windows onto the account.
 *
 * Keyed on (accountId, fromDate) — the same pair carried by the model's
 * UNIQUE index. Two statements legitimately describe the same window: the
 * month a rate changed appears on both that statement and the next one, and
 * the later printing is the authoritative one (it knows the interest that
 * was ultimately applied). So a known window is UPDATED in place rather than
 * inserted again. The unique index is the backstop, not the mechanism — we
 * do not lean on catching a constraint violation, because on Postgres that
 * would poison the surrounding transaction.
 *
 * `householdId` and `accountId` come from the Account the commit path already
 * resolved under the caller's household scope, never from the preview payload.
 *
 * `sourceStatementId` is left null: nothing on the import path creates an
 * AccountStatement. Those are registered by hand through
 * `POST /api/accounts/:id/statements` (backend/src/routes/statements.ts is
 * the only `AccountStatement.create` in the codebase), so there is no
 * statement row to point at here. The column is nullable precisely for this.
 *
 * Sequelize's own `upsert` is deliberately NOT used: on v6 it derives the
 * ON CONFLICT target from `model.uniqueKeys`, which is populated from
 * attribute-level `unique:` flags — not from `options.indexes`, where this
 * model's composite index is declared. It would conflict on the primary key
 * instead and raise the very unique violation we are avoiding.
 */
async function persistRatePeriods(
  periods: NonNullable<StatementPreview['ratePeriods']>,
  account: Account,
  householdId: number,
  t: SequelizeTransaction,
): Promise<number> {
  let written = 0;
  for (const p of periods) {
    const existing = await AccountRatePeriod.findOne({
      where: { accountId: account.id, fromDate: p.fromDate },
      transaction: t,
    });
    if (existing) {
      // Only the rate facts move; the row keeps its household, account, and
      // whatever statement it was first attributed to.
      existing.toDate = p.toDate;
      existing.primeRate = p.primeRate;
      existing.premium = p.premium;
      existing.effectiveRate = p.effectiveRate;
      existing.applicableInterest = p.applicableInterest;
      await existing.save({
        transaction: t,
        fields: ['toDate', 'primeRate', 'premium', 'effectiveRate', 'applicableInterest'],
      });
      written += 1;
    } else {
      await AccountRatePeriod.create(
        {
          householdId,
          accountId: account.id,
          fromDate: p.fromDate,
          toDate: p.toDate,
          primeRate: p.primeRate,
          premium: p.premium,
          effectiveRate: p.effectiveRate,
          applicableInterest: p.applicableInterest,
          sourceStatementId: null,
        },
        { transaction: t },
      );
      written += 1;
    }
  }
  return written;
}

/**
 * Persist the statement's rate windows, contained so a failure can never cost
 * the import.
 *
 * Called from BOTH commit paths, and that is the whole point. The
 * already-imported short-circuit above returns before the commit body runs, so
 * rate capture living only in the commit body meant a statement that had once
 * contributed transactions could never be re-imported to pick up a
 * newly-supported field. Fourteen Royal Credit Line statements were re-imported
 * to backfill the rate table; the five whose first import had inserted rows
 * silently captured nothing, leaving a five-month hole (2025-12-04 → 2026-05-04,
 * $198.74 of interest) that no further re-import could fill.
 *
 * Running this on an already-imported file is safe and correct:
 * `persistRatePeriods` reads-then-upserts against UNIQUE(account_id, from_date),
 * so it is idempotent by construction. The dedupe it bypasses is a
 * *transaction-level* dedupe, and the transaction contract of the early return
 * is unchanged — nothing is inserted into the ledger on that path.
 *
 * `parent` is the ledger transaction on the commit path, where the writes must
 * run in a SAVEPOINT (same Postgres-safety rationale as createHolding — an
 * error inside an open transaction otherwise aborts it and every later query
 * returns "current transaction is aborted"). On the already-imported path there
 * is no surrounding transaction, so pass null and the writes get their own.
 *
 * Failures are appended to `preview.warnings`, which both return paths spread
 * into the commit result.
 *
 * Returns the number of windows written or updated. New billed interest is the
 * primary input to the line-of-credit interest allocation, so a non-zero count
 * is what tells the caller to queue a reallocation — a count of zero must not,
 * or every statement import would recompute a household for nothing. The
 * caller marks AFTER its transaction commits: windows rolled back with the
 * ledger are windows the allocator must not be told about.
 */
async function captureRatePeriods(
  preview: StatementPreview,
  account: Account,
  parent: SequelizeTransaction | null,
): Promise<number> {
  const periods = preview.ratePeriods;
  if (!periods || periods.length === 0) return 0;
  if (account.householdId == null) {
    // account_rate_periods.household_id is NOT NULL, and a rate window with no
    // household could not be scoped or erased. Skip loudly.
    preview.warnings.push(
      `Statement rate history not saved: account ${account.id} has no household.`,
    );
    return 0;
  }
  const householdId = account.householdId;
  try {
    return await sequelize.transaction(
      parent ? { transaction: parent } : {},
      async (sp) => persistRatePeriods(periods, account, householdId, sp),
    );
  } catch (e) {
    preview.warnings.push(
      `Statement rate history not saved (${periods.length} window(s)): ${
        e instanceof Error ? e.message : String(e)
      }. The rest of the import was unaffected.`,
    );
    return 0;
  }
}

export type CommitStatementImportOptions = {
  /**
   * Import the statement even though its reconciliation gate failed — i.e.
   * the parser could not make the statement's own arithmetic agree and every
   * row it produced is suspect.
   *
   * OFF by default and deliberately awkward: it must be passed explicitly at
   * every call site, and every use is stamped on the resulting ImportHistory
   * row (`acceptedUnreconciled`) together with the gate's verdict. Only the
   * interactive commit route surfaces it, and only when the caller re-submits
   * after seeing the refusal.
   */
  acceptUnreconciled?: boolean;
};

export async function commitStatementImport(
  preview: StatementPreview,
  userId: number | null,
  householdId: number | null,
  options: CommitStatementImportOptions = {}
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
  /**
   * True when this run imported over a failed reconciliation gate. False on
   * every ordinary import — including one where `acceptUnreconciled` was
   * passed but the statement reconciled fine and the override was never used.
   */
  acceptedUnreconciled: boolean;
  warnings: string[];
  usedParser: StatementPreview['usedParser'];
  usedProfileId?: string;
  profileInferred?: boolean;
}> {
  // Reconciliation gate FIRST — before the account lookup, before the
  // already-imported short-circuit, before any write. A statement whose
  // arithmetic does not add up must leave no trace at all: no transactions,
  // no ImportHistory row. See reconciliationGate.ts for why.
  const overriddenBlockingErrors = assertStatementReconciles(
    { fileName: preview.fileName, parseErrors: preview.parseErrors },
    options.acceptUnreconciled === true,
  );
  const acceptedUnreconciled = overriddenBlockingErrors.length > 0;

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
    // Transactions are what this short-circuit exists to suppress, and it
    // still suppresses every one of them. Rate windows are not transactions:
    // they are idempotent reference data keyed by UNIQUE(account_id,
    // from_date), and re-importing a file is the ONLY way to pick up a field
    // the parser did not understand the first time round. Capturing them here
    // is what makes a re-import able to backfill at all.
    // No surrounding transaction on this path, so the windows are already
    // durable by the time this returns and the trigger can fire immediately.
    const reimportedWindows = await captureRatePeriods(preview, account, null);
    if (reimportedWindows > 0 && account.householdId != null) {
      markInterestAllocationPending({
        householdId: account.householdId,
        source: 'statement-import',
      });
    }
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
      acceptedUnreconciled,
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
  let ratePeriodsWritten = 0;

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

    // Rate-history capture (RBC Royal Credit Line). Transactions are the
    // reason to import a statement; the rate table is a bonus that feeds the
    // interest allocator, so this never fails the import — see
    // captureRatePeriods. Threaded with `t` so the windows land in the same
    // transaction as the ledger they were read off.
    ratePeriodsWritten = await captureRatePeriods(preview, account, t);

    const inserted =
      insertedTransactions + insertedInvestmentActivities + insertedHoldings;
    const baseStatus =
      preview.rowErrors > 0 && inserted === 0
        ? 'failed'
        : preview.rowErrors > 0
          ? 'partial'
          : 'success';
    // A batch imported over a failed reconciliation gate is never "success":
    // the numbers in it are known-suspect, so it reads as `partial` even when
    // every individual row parsed cleanly. `partial` (not `failed`) because the
    // rows really were written and the already-imported short-circuit above
    // must still recognise this content hash on a re-commit.
    const historyStatus =
      acceptedUnreconciled && baseStatus === 'success' ? 'partial' : baseStatus;
    const errorParts: string[] = [];
    if (preview.rowErrors > 0) {
      errorParts.push(`${preview.rowErrors} row(s) could not be parsed`);
    }
    if (acceptedUnreconciled) {
      errorParts.push(
        `imported with acceptUnreconciled override despite ` +
          `${overriddenBlockingErrors.length} reconciliation failure(s): ` +
          overriddenBlockingErrors.map((e) => e.message).join('; '),
      );
    }
    await ImportHistory.create(
      {
        fileName: preview.fileName,
        filePathSafe: preview.fileName,
        contentHash: preview.contentHash,
        batchLabel: preview.importBatch,
        status: historyStatus,
        rowCount: inserted,
        errorMessage: errorParts.length > 0 ? errorParts.join(' | ') : null,
        acceptedUnreconciled,
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

  // AFTER the commit, deliberately. Windows written inside a transaction that
  // then rolled back are windows the allocator must never be told about, and
  // a reallocation firing against a half-open transaction would read the
  // ledger mid-write. Queued, never run inline: an import must not pay for a
  // household recomputation, and it must not fail if one is impossible —
  // markInterestAllocationPending cannot throw.
  if (ratePeriodsWritten > 0 && account.householdId != null) {
    markInterestAllocationPending({
      householdId: account.householdId,
      source: 'statement-import',
    });
  }

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
    acceptedUnreconciled,
    warnings: preview.warnings,
    usedParser: preview.usedParser,
    usedProfileId: preview.usedProfileId,
    profileInferred: preview.profileInferred,
  };
}
