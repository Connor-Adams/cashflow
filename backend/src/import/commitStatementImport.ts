import { Op } from 'sequelize';
import type { Transaction as SequelizeTransaction } from 'sequelize';
import {
  Account,
  AccountRatePeriod,
  HoldingSnapshot,
  ImportHistory,
  InvestmentActivity,
  Security,
  sequelize,
} from '../models';
import { findSolePartnerContactId } from '../contacts/solePartner';
import { loadAllRules } from './applyRules';
import { findExistingForDedup, nearDuplicateWarnings } from './dedupExisting';
import { normalizeSourceRef } from './normalizeSourceRef';
import { findExistingInvestmentByFuzzyMatch } from './fuzzyDedupInvestmentActivity';
import { stableIdentityFingerprint } from './fingerprint';
import { findMerchantMemory } from '../ai/merchantMemory';
import { enrichTransaction } from './enrich';
import {
  convertIncomeActivityToAccountCurrency,
  type ConvertedActivityCurrency,
} from './convertActivityCurrency';
import { ensureFxRate } from '../fx/bankOfCanada';
import { assertStatementReconciles } from './reconciliationGate';
import { captureStatementBalance } from './captureStatementBalance';
import { markInterestAllocationPending } from '../contacts/interestAllocationCoordinator';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
} from '../config/env';
import {
  maybeRunAiBatchOverColdRows,
  type ColdRow,
} from './enrichment/aiBatchOverColdRows';
import { maybeRunEmbeddingMatchOverColdRows } from './enrichment/embeddingMatchOverColdRows';
import {
  buildImportedTransaction,
  coldRowFor,
  persistImportedTransaction,
} from './importedTransaction';
import { coldRowFallbackWarnings } from './enrichment/coldRowFallbackWarnings';
import type { ChatMessage } from './enrichment/aiBatchStage';
import type { Embedder } from '../ai/merchantEmbeddings';
import { logger } from '../observability/logger';
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

/**
 * Re-express each foreign-currency income inflow (e.g. a WS crypto staking
 * reward the activities-export reports in USD) in the account's currency.
 * Trades keep their native currency — see convertActivityCurrency.ts.
 *
 * Resolved BEFORE the import transaction opens, deliberately. A cache miss in
 * `ensureFxRate` is a Bank of Canada HTTP call followed by an FxRate INSERT on
 * the global connection. Inside the transaction that meant holding the import
 * open across a network round-trip, and — on SQLite — an FxRate write that
 * waited on the import's own write lock until busy_timeout x retries expired
 * and the cache write was dropped. FX rates are global reference data, not part
 * of this statement: caching one is correct whether or not the import commits,
 * so it has no business being atomic with it.
 */
async function resolveActivityCurrencies(
  rows: NormalizedInvestmentActivity[],
  accountCurrency: string,
): Promise<Map<NormalizedInvestmentActivity, ConvertedActivityCurrency>> {
  const out = new Map<NormalizedInvestmentActivity, ConvertedActivityCurrency>();
  for (const row of rows) {
    out.set(
      row,
      await convertIncomeActivityToAccountCurrency(
        {
          activityType: row.activityType,
          currency: row.currency,
          amount: row.amount ?? null,
          price: row.price ?? null,
          fees: row.fees ?? null,
          tradeDate: row.tradeDate,
        },
        accountCurrency,
        (from, to, date) => ensureFxRate(from, to, date),
      ),
    );
  }
  return out;
}

async function createInvestmentActivity(
  row: NormalizedInvestmentActivity,
  conv: ConvertedActivityCurrency,
  account: Account,
  preview: StatementPreview,
  t: SequelizeTransaction
): Promise<InvestmentActivity | 'duplicate'> {
  const security = row.security
    ? await findOrCreateSecurity(row.security, account.householdId, t)
    : null;
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
 * `sourceStatementId` is left null. Statement imports do now write an
 * AccountStatement (captureStatementBalance.ts), but rate windows are not yet
 * linked to it; the column is nullable precisely for this.
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

/**
 * Test seams for the two cold-row fallbacks, mirroring `runBackfill`'s `deps`.
 * Production passes neither: the embedder is the process-wide memoized local
 * model and the AI caller is `openaiJson`.
 */
export type CommitStatementImportDeps = {
  embedder?: Embedder;
  aiCaller?: (msgs: ChatMessage[]) => Promise<Record<string, unknown>>;
};

/**
 * True when `prior` (an earlier successful import of this exact file) already
 * accounted for every row this parse produced, so the commit can short-circuit.
 *
 * A parser fix can make the SAME file yield rows the first import never saw
 * (the WS 2026-09 chequing statement first imported 12 of its 16 rows). When
 * this parse finds more rows than the prior import saw — inserted plus skipped
 * as duplicates — return false so the row-level dedup inserts just the missing
 * ones. Otherwise a parser fix could never reach an already-imported statement.
 */
function isAlreadyFullyImported(
  prior: { rowCount?: number | null; skippedDuplicateCount?: number | null },
  preview: StatementPreview,
): boolean {
  const inserted = prior.rowCount ?? 0;
  if (inserted <= 0) return false;
  const priorRowsSeen = inserted + (prior.skippedDuplicateCount ?? 0);
  const parsedRows =
    preview.transactions.length + preview.investmentActivities.length + preview.holdings.length;
  return parsedRows <= priorRowsSeen;
}

export async function commitStatementImport(
  preview: StatementPreview,
  userId: number | null,
  householdId: number | null,
  options: CommitStatementImportOptions = {},
  deps: CommitStatementImportDeps = {},
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
  if (prior && isAlreadyFullyImported(prior, preview)) {
    // Transactions are what this short-circuit exists to suppress, and it
    // still suppresses every one of them. Rate windows are not transactions:
    // they are idempotent reference data keyed by UNIQUE(account_id,
    // from_date), and re-importing a file is the ONLY way to pick up a field
    // the parser did not understand the first time round. Capturing them here
    // is what makes a re-import able to backfill at all.
    // No surrounding transaction on this path, so the windows are already
    // durable by the time this returns and the trigger can fire immediately.
    const reimportedWindows = await captureRatePeriods(preview, account, null);
    // Statement balances are reference data like the rate windows: idempotent,
    // keyed by period, and only re-importing can backfill them.
    await captureStatementBalance(preview, account, userId, null);
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
  // Partner/shared splits carry the household's sole partner so settlements
  // against that partner net against them (null when 0 or 2+ partners).
  const solePartnerId = await findSolePartnerContactId(account.householdId ?? null);
  const overrideBusiness = preview.overrideBusiness === true;
  let insertedTransactions = 0;
  let insertedInvestmentActivities = 0;
  let insertedHoldings = 0;
  let skippedDuplicates = 0;
  /**
   * Existing transaction ids the narrative-rename dedup tier may no longer
   * claim: rows an earlier incoming row already matched, plus rows this commit
   * inserted. That tier keys on (account, date, amount, currency) with the
   * merchant text excluded, and the key is not unique, so without this set two
   * incoming rows sharing it would both absorb the SAME existing row (or the
   * second would absorb the first, freshly inserted, row) and a real cash event
   * would be silently dropped. Same role as `excludeIds` in the investment
   * fuzzy matcher.
   */
  const consumedExistingIds = new Set<number>();
  /** Date-shifted near-misses dedup declined, one entry per incoming row. */
  const nearDuplicates: number[][] = [];
  let ratePeriodsWritten = 0;
  /**
   * Rows the deterministic stages could not resolve (review_flag still true),
   * accumulated for the cold-row fallbacks that run after the commit. Gate is
   * `reviewFlag === true` and a non-empty merchant key — identical to
   * runImport.ts, so the two import routes cannot drift apart on which rows the
   * fallbacks see.
   */
  const coldRows: ColdRow[] = [];
  // Network + FxRate cache writes happen here, outside the transaction — see
  // resolveActivityCurrencies.
  const activityCurrencies = await resolveActivityCurrencies(
    preview.investmentActivities,
    account.defaultCurrency || 'CAD',
  );

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
        consumedExistingIds,
      });
      if (dedup.kind !== 'no-match') {
        consumedExistingIds.add(dedup.existingId);
        skippedDuplicates += 1;
        continue;
      }
      if (dedup.nearMissCandidateIds) nearDuplicates.push(dedup.nearMissCandidateIds);
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
        // Stage 7 needs the source's own view of the type; without it a mirror
        // whose wording the narrative detector misses never finds its sibling.
        overrideTxnType: row.overrideTxnType ?? null,
        txnTypeHint: row.txnTypeHint ?? null,
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

      // Wealthsimple bundle imports stamp an authoritative `overrideTxnType`
      // from the WS TX code (BUY → 'investment', AFT_OUT → 'transfer', etc).
      // How it ranks against rules, the narrative and `txnTypeHint` is
      // resolveImportedTxnType's job, shared with the CSV importer.
      const cashRow = {
        date: row.date,
        merchantRaw: row.merchantRaw,
        amount: row.amount,
        currency: row.currency,
        sourceReference: row.sourceReference,
        sourceRowFingerprint: row.sourceRowFingerprint,
        sourceIdentityFingerprint: identityFp,
        overrideTxnType: row.overrideTxnType ?? null,
        txnTypeHint: row.txnTypeHint ?? null,
      };
      const built = await buildImportedTransaction(
        cashRow,
        enriched,
        {
          account,
          householdId: account.householdId ?? null,
          createdByUserId: userId ?? account.ownerUserId,
          importBatch: preview.importBatch,
          overrideBusiness,
          sourceTier: preview.sourceTier,
          solePartnerContactId: solePartnerId,
        },
        t,
      );
      // SAVEPOINT around the per-row insert + its signal sidecar. On
      // Postgres, any unique-violation here would otherwise abort the
      // outer transaction and every subsequent SELECT in this loop
      // would fail with "current transaction is aborted, commands
      // ignored until end of transaction block". Nesting through
      // sequelize.transaction({ transaction: t }, …) emits a SAVEPOINT
      // so the unique-violation rolls back only this row and the loop
      // continues.
      try {
        await sequelize.transaction({ transaction: t }, (sp) =>
          persistImportedTransaction(built.txn, enriched, account.householdId ?? null, sp),
        );
        insertedTransactions += 1;
        consumedExistingIds.add(built.txn.id);
        const cold = coldRowFor(built, enriched, cashRow, memory);
        if (cold) coldRows.push(cold);
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
      const conv = activityCurrencies.get(row);
      if (!conv) throw new Error('activity currency not resolved before the import transaction');
      const created = await createInvestmentActivity(row, conv, account, preview, t);
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
    // Warnings for a liability statement whose balance did not parse; also
    // recorded on the ImportHistory row below (errorMessage is its only
    // free-text field — the status stays as computed, so this warns, never fails).
    const statementBalanceWarnings = await captureStatementBalance(preview, account, userId, t);

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
    const errorParts: string[] = [...statementBalanceWarnings];
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

  // === Cold-row fallbacks, AFTER the commit and outside every transaction ===
  // The statement path used to stop at `enrichTransaction`, so rows the
  // deterministic stages could not categorise were simply left review-flagged
  // and never seen by either intelligent fallback — while the folder-CSV path
  // ran both. Same two shared modules, same order: embedding match (free, local,
  // deterministic) first, then the OpenAI batch over only what it could not
  // resolve. Outside the transaction so model/network latency never holds row
  // locks, and after it so the rows these stages UPDATE by id are durable.
  //
  // Nothing in here may fail the import — categorisation is a bonus on top of a
  // ledger that is already committed, exactly the posture captureRatePeriods
  // takes with rate windows. A failure warns and the transactions stand.
  await runColdRowFallbacks(coldRows, account.householdId ?? null, preview, deps);

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
    warnings: [...preview.warnings, ...nearDuplicateWarnings(nearDuplicates)],
    usedParser: preview.usedParser,
    usedProfileId: preview.usedProfileId,
    profileInferred: preview.profileInferred,
  };
}

/**
 * Run the two cold-row fallbacks over the rows this commit left uncategorised,
 * and record on `preview.warnings` whichever of them could not run.
 *
 * Contained by construction: each stage already swallows its own failures, and
 * this wrapper catches anything that still escapes (a model load that throws
 * outside the stage's own try, an OpenAI client that rejects on construction).
 * An import that reached this point has committed; a categorisation failure
 * must never turn that into a failed import.
 */
/**
 * Test-injected stage stubs, in the spread shape each stage's options take.
 * `exactOptionalPropertyTypes` makes an explicit `undefined` different from an
 * absent key, so each key is present only when a dep was actually supplied.
 */
function coldRowStageOverrides(deps: CommitStatementImportDeps): {
  embedding: { embedder?: CommitStatementImportDeps['embedder'] };
  ai: { openaiCaller?: CommitStatementImportDeps['aiCaller'] };
} {
  return {
    embedding: { ...(deps.embedder ? { embedder: deps.embedder } : {}) },
    ai: { ...(deps.aiCaller ? { openaiCaller: deps.aiCaller } : {}) },
  };
}

/**
 * A fallback threw past its own guards. The import has already committed, so
 * this becomes a warning on the preview — never a thrown error.
 */
function recordColdRowFallbackFailure(
  coldRowCount: number,
  preview: StatementPreview,
  e: unknown,
): void {
  logger.warn(
    { err: e, module: 'enrichment', coldRowCount },
    'statement_import_cold_row_fallbacks_failed',
  );
  const reason = e instanceof Error ? e.message : String(e);
  preview.warnings.push(
    `Automatic categorisation of ${coldRowCount} uncategorised row(s) failed ` +
      `(${reason}). The rest of the import was unaffected.`,
  );
}

async function runColdRowFallbacks(
  coldRows: ColdRow[],
  householdId: number | null,
  preview: StatementPreview,
  deps: CommitStatementImportDeps,
): Promise<void> {
  if (coldRows.length === 0) return;
  const overrides = coldRowStageOverrides(deps);
  try {
    const embeddingMatch = await maybeRunEmbeddingMatchOverColdRows(
      coldRows,
      householdId,
      overrides.embedding,
    );
    const aiBatch = await maybeRunAiBatchOverColdRows(
      embeddingMatch.remainingColdRows,
      householdId,
      overrides.ai,
    );
    preview.warnings.push(...coldRowFallbackWarnings(embeddingMatch.summary, aiBatch));
  } catch (e) {
    recordColdRowFallbackFailure(coldRows.length, preview, e);
  }
}
