import fs from 'fs/promises';
import path from 'path';
import { Op, fn, col, where as sqlWhere } from 'sequelize';
import type { Account as AccountModel } from '../models/Account';
import {
  sequelize,
  Account,
  Entity,
  HoldingSnapshot,
  Transaction,
  ImportHistory,
  TransactionSignal,
} from '../models';
import {
  hashContent,
  rowFingerprint,
  stableFingerprint,
  stableIdentityFingerprint,
} from './fingerprint';
import { findExistingForDedup } from './dedupExisting';
import { loadAllRules } from './applyRules';
import { recomputeTransactionAmounts } from './calculateShares';
import { resolveProfileIdForImport } from './inferProfile';
import { parseCsvRecords } from './csvParse';
import { inferCsvDateOrdering, mapCsvRow } from './mapRow';
import { parseStatementFilename } from './parseStatementFilename';
import {
  parseWealthsimpleFilename,
  parseWsCreditCardPdfWsid,
  type WsProductHint,
} from './parseWealthsimpleFilename';
import { parseStatementFile } from './parseStatementFile';
import {
  commitStatementImport,
  findOrCreateSecurity,
} from './commitStatementImport';
import { parseWsHoldingsCsv } from './wealthsimpleHoldingsParse';
import { wsRecordsHaveSecurityActivity } from './wealthsimpleInvestParse';
import { assertUnderRoot } from './pathUtils';
import { findMerchantMemory } from '../ai/merchantMemory';
import { upsertSuggestedOrderLink } from '../amazon/matcher';
import * as env from '../config/env';
import { enrichTransaction } from './enrich';
import { applyRuleSideEffects, findRuleActionsSignal } from '../rules/applyRuleSideEffects';
import {
  computeImportConfidence,
  serializeFlags,
} from './computeImportConfidence';
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
// Stage 8 ai-batch over cold rows lives in a shared module so the import path
// and the enrichment backfill path use one implementation. aiSuggestionToSignal
// and dedupeColdRowsByMerchantKey are re-exported below because existing unit
// tests import them from this module.
import {
  maybeRunAiBatchOverColdRows,
  type ColdRow,
} from './enrichment/aiBatchOverColdRows';
import { maybeRunEmbeddingMatchOverColdRows } from './enrichment/embeddingMatchOverColdRows';
export { aiSuggestionToSignal, dedupeColdRowsByMerchantKey } from './enrichment/aiBatchOverColdRows';
import { logger } from '../observability/logger';
import { findOrCreateAccount } from './accountLookup';
import { extractAccountNumber } from './csvProfiles';
import { applyCreditCardStatementSummary } from '../cards/applyStatementSummary';

/** Max row-level parse diagnostics returned on a single import response */
export const PARSE_ERRORS_MAX = 50;

export function appendParseError(
  bucket: { rowIndex: number; message: string }[],
  rowIndex: number,
  message: string
): void {
  if (bucket.length >= PARSE_ERRORS_MAX) return;
  bucket.push({ rowIndex, message });
}

export function isSequelizeUniqueLike(e: unknown): boolean {
  return (
    e !== null &&
    typeof e === 'object' &&
    'name' in e &&
    ((e as { name: string }).name === 'SequelizeUniqueConstraintError' ||
      (e as { name: string }).name === 'SequelizeBulkRecordError')
  );
}

export async function resolveAccount(cardToken: string, householdId?: number | null) {
  const token = cardToken.trim();
  if (!token) return null;
  const lower = token.toLowerCase();
  return Account.findOne({
    where: {
      ...(householdId != null ? { householdId } : {}),
      [Op.or]: [
        sequelize.where(sequelize.fn('lower', sequelize.col('short_code')), lower),
        sequelize.where(sequelize.fn('lower', sequelize.col('name')), lower),
      ],
    },
  });
}

/** Try to resolve account via auto-match on CSV Account Number. Returns [account, 'matched' | 'created'] or null. */
async function tryAutoMatchAccount(
  records: Record<string, string>[],
  headers: string[],
  profileId: string,
  householdId: number | null
): Promise<{ account: AccountModel; matchedBy: string } | null> {
  try {
    const { profiles } = await import('./csvProfiles');
    const profile = profiles[profileId] || profiles.generic_simple;
    const csvAccountNumber = extractAccountNumber(records, headers, profile);

    if (!csvAccountNumber) {
      return null; // No account number in CSV
    }

    const result = await findOrCreateAccount(csvAccountNumber, profileId, householdId);
    return { account: result.account, matchedBy: result.matchedBy };
  } catch (err) {
    logger.debug(`Auto-match account failed: ${err}`);
    return null;
  }
}

export type ImportCsvFileOpts = {
  buffer: Buffer;
  fileName: string;
  profileId?: string | null;
  accountId?: number | string | null;
  batchLabel?: string | null;
  householdId?: number | null;
  userId?: number | null;
};

/**
 * Import one CSV from memory. Either pass `accountId` (web upload) or rely on
 * `CardName_YYYY_MM.csv` filename (folder scan).
 */
export async function importCsvFile(opts: ImportCsvFileOpts) {
  const name = path.basename(opts.fileName || 'upload.csv').replace(/[\\/]/g, '');
  const buf = opts.buffer;
  const contentHash = hashContent(buf);

  const prior = await ImportHistory.findOne({
    where: {
      contentHash,
      status: 'success',
      ...(opts.householdId != null ? { householdId: opts.householdId } : {}),
    },
  });
  const priorRows = prior?.rowCount;
  // TODO(import-all-dups-rerun): re-importing a file whose first run dedup'd
  // every row (priorRows === 0) falls through to a full re-parse and writes a
  // SECOND ImportHistory row for the same contentHash. The dup detection on
  // individual rows still works, so no transactions are double-inserted —
  // but the audit log accumulates noise. Fix: short-circuit when prior exists
  // regardless of rowCount, or treat (status='success', rowCount=0) as
  // "already imported, nothing to do" and update prior.updatedAt instead.
  if (prior != null && priorRows != null && priorRows > 0) {
    return {
      file: name,
      skipped: true,
      reason: 'already_imported',
      contentHash,
      message:
        'This file was already imported. Change the CSV or clear duplicate import history to try again.',
    };
  }

  // Delegate PDF files to parseStatementFile + commitStatementImport.
  // Note: /api/import/upload calls importCsvFile directly (not parseStatementFile), so PDF
  // delegation lives here rather than in the route handler or a separate entry point.
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') {
    const accountIdNum =
      opts.accountId != null && opts.accountId !== '' ? Number(opts.accountId) : NaN;
    if (Number.isNaN(accountIdNum)) {
      return { file: name, skipped: true, reason: 'invalid_account', error: 'Invalid accountId for PDF' };
    }
    const parsed = await parseStatementFile({
      buffer: opts.buffer,
      fileName: name,
      accountId: accountIdNum,
      batchLabel: opts.batchLabel,
      householdId: opts.householdId,
    });
    if ('error' in parsed) {
      // Write an audit record so import history reflects the failure (mirrors CSV parse-failure path).
      await ImportHistory.create({
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: 'pdf-parse-error',
        status: 'failed',
        rowCount: 0,
        errorMessage: parsed.error,
        startedAt: new Date(),
        finishedAt: new Date(),
        householdId: opts.householdId ?? null,
        createdByUserId: opts.userId ?? null,
      });
      return {
        file: name,
        skipped: true,
        reason: 'pdf_parse_error',
        message: parsed.error,
      };
    }
    // TODO(import-pdf-audit-gap): commitStatementImport is called without a
    // try/catch — if it throws (e.g., DB error, constraint violation, transient
    // failure), the function unwinds and NO ImportHistory record is written.
    // The CSV path writes a 'failed' ImportHistory for parser errors; the PDF
    // path only writes one for parser errors (above) but not commit-time
    // failures. Fix: wrap in try/catch and write a 'failed' ImportHistory with
    // batchLabel='pdf-commit-error' on throw, mirroring the parse-error path.
    const result = await commitStatementImport(parsed, opts.userId ?? null, opts.householdId ?? null);
    return result;
  }

  const rules = await loadAllRules(opts.householdId);
  const amazonOrdersCache = await loadAmazonOrdersCache(opts.householdId ?? null);
  const startedAt = new Date();

  // Parse CSV early so we can use it for auto-match
  const text = buf.toString('utf8');
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) {
    const msg = parsed.error;
    await ImportHistory.create({
      fileName: name,
      filePathSafe: name,
      contentHash,
      batchLabel: 'parse-error',
      status: 'failed',
      rowCount: 0,
      errorMessage: msg,
      startedAt,
      finishedAt: new Date(),
      householdId: opts.householdId ?? null,
      createdByUserId: opts.userId ?? null,
    });
    return {
      file: name,
      skipped: true,
      reason: 'parse_error',
      message: msg || 'Could not parse CSV (wrong delimiter or invalid file?)',
    };
  }
  const { records, headers } = parsed;

  // Infer profile early for auto-match
  const { profileId, inferred: profileInferred } = resolveProfileIdForImport(
    opts.profileId ?? undefined,
    process.env.CSV_PROFILE_ID,
    headers,
    records,
    env.defaultCurrency || 'CAD',
  );

  // Resolve account with three fallback paths: accountId, filename, auto-match
  let account: AccountModel;
  let importBatch: string;

  if (opts.accountId != null && opts.accountId !== '') {
    // Path 1: Explicit accountId
    const id = Number(opts.accountId);
    if (Number.isNaN(id)) {
      await ImportHistory.create({
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: 'invalid-account',
        status: 'failed',
        rowCount: 0,
        errorMessage: 'Invalid accountId',
        startedAt,
        finishedAt: new Date(),
        householdId: opts.householdId ?? null,
        createdByUserId: opts.userId ?? null,
      });
      return { file: name, skipped: true, reason: 'invalid_account' };
    }
    const byId = await Account.findOne({
      where: {
        id,
        ...(opts.householdId != null ? { householdId: opts.householdId } : {}),
      },
    });
    if (!byId) {
      await ImportHistory.create({
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: 'unknown-account',
        status: 'failed',
        rowCount: 0,
        errorMessage: `No account with id ${id}`,
        startedAt,
        finishedAt: new Date(),
        householdId: opts.householdId ?? null,
        createdByUserId: opts.userId ?? null,
      });
      return { file: name, skipped: true, reason: 'unknown_account' };
    }
    account = byId;
    const d = new Date();
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const token = account.shortCode || account.name || 'account';
    importBatch =
      (opts.batchLabel && String(opts.batchLabel).trim()) ||
      `${ym} ${token}`;
  } else {
    // Path 2: Try filename match
    const meta = parseStatementFilename(name);
    let resolved = meta ? await resolveAccount(meta.cardToken, opts.householdId) : null;

    // Path 3: If filename match failed, try auto-match on CSV Account Number
    let autoMatched: { account: AccountModel; matchedBy: string } | null = null;
    if (!resolved) {
      autoMatched = await tryAutoMatchAccount(records, headers, profileId, opts.householdId ?? null);
      resolved = autoMatched?.account ?? null;
    }

    // All paths failed
    if (!resolved) {
      const errorMsg = meta
        ? `No account matches token "${meta.cardToken}" (short_code or name), and CSV has no Account Number for auto-match`
        : 'Filename must match CardName_YYYY_MM.csv (e.g. Amex_2025_01.csv), pass accountId, or CSV must have Account Number column for auto-match';

      await ImportHistory.create({
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: meta?.batchLabel || 'no-account',
        status: 'failed',
        rowCount: 0,
        errorMessage: errorMsg,
        startedAt,
        finishedAt: new Date(),
        householdId: opts.householdId ?? null,
        createdByUserId: opts.userId ?? null,
      });
      return { file: name, skipped: true, reason: 'unknown_account', message: errorMsg };
    }

    // Set importBatch based on which path succeeded
    account = resolved;
    const d = new Date();
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const token = account.shortCode || account.name || 'account';

    if (meta && !autoMatched) {
      // Filename match succeeded
      importBatch = meta.batchLabel;
    } else {
      // Auto-match succeeded (or filename match was used as fallback)
      importBatch =
        (opts.batchLabel && String(opts.batchLabel).trim()) ||
        `${ym} ${token}`;
      if (autoMatched) {
        logger.info(`Auto-matched account via bank account number: ${account.id}`);
      }
    }
  }

  const defaultCurrency =
    account.defaultCurrency || env.defaultCurrency || 'CAD';

  const householdAccountIds = await loadHouseholdAccountIds(account.id, opts.householdId ?? account.householdId ?? null);
  const ownerNames = await loadHouseholdOwnerNames(opts.householdId ?? account.householdId ?? null);

  let inserted = 0;
  let skippedDup = 0;
  let rowErrors = 0;
  const parseErrors: { rowIndex: number; message: string }[] = [];
  // Stage 8 deferral: rows that completed phase 1 still flagged for review accumulate
  // here, then a single AI batch (or per-row fallback) enhances them after commit.
  const coldRows: ColdRow[] = [];

  // One day/month ordering for the whole file: unambiguous rows ('15/03')
  // decide how ambiguous ones ('03/04') parse instead of per-row fallback.
  const dateOrdering = inferCsvDateOrdering(records, headers, profileId);

  await sequelize.transaction(async (t) => {
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const mapped = mapCsvRow(row, headers, profileId, defaultCurrency, dateOrdering);
      if ('error' in mapped) {
        rowErrors += 1;
        appendParseError(parseErrors, i + 1, mapped.error);
        continue;
      }
      const v = mapped.value;
      const fp = rowFingerprint({
        accountId: account.id,
        date: v.date,
        amount: v.amount,
        currency: v.currency,
        merchantRaw: v.merchantRaw,
        sourceReference: v.sourceReference,
      });
      const identityFp = stableIdentityFingerprint({
        accountId: account.id,
        date: v.date,
        amount: v.amount,
        currency: v.currency,
        merchantRaw: v.merchantRaw,
      });

      const dedup = await findExistingForDedup({
        accountId: account.id,
        sourceIdentityFingerprint: identityFp,
        sourceReference: v.sourceReference ?? null,
        t,
        // CSV-imported rows default to status 'posted' (see Transaction model).
        // Threading the posted-row context lets the cross-parser merchant-drift
        // fallback in findExistingForDedup catch a statement re-imported in a
        // different format (CSV then PDF) where the same charge's merchantRaw is
        // reconstructed slightly differently and flips the identity fingerprint.
        incomingStatus: 'posted',
        incomingDate: v.date,
        incomingAmount: v.amount,
        incomingCurrency: v.currency,
        incomingMerchantRaw: v.merchantRaw,
      });
      if (dedup.kind !== 'no-match') {
        skippedDup += 1;
        continue;
      }

      // All three reads thread `t`: on Postgres an un-threaded raw query runs
      // on a separate pooled connection and cannot see rows inserted earlier
      // in this same import (READ COMMITTED), so same-statement refund or
      // transfer pairs would link on SQLite tests but not in prod.
      const memory = await findMerchantMemory(
        opts.householdId ?? account.householdId ?? null,
        v.merchantClean,
        v.amount,
        { transaction: t },
      );

      const recurringHistory = await loadRecurringHistory(
        opts.householdId ?? account.householdId ?? null,
        v.merchantClean,
        v.date,
        t,
      );
      const relationshipCandidates = await loadRelationshipCandidates(
        opts.householdId ?? account.householdId ?? null,
        householdAccountIds,
        v.merchantClean,
        v.date,
        enrichmentRefundWindowDays,
        t,
      );

      const enriched = await enrichTransaction({
        raw: {
          merchantRaw: v.merchantRaw,
          date: v.date,
          amount: v.amount,
          sourceReference: v.sourceReference,
          notes: null,
        },
        accountId: account.id,
        householdId: opts.householdId ?? account.householdId ?? null,
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
        txnType: f.txnType,
        accountVisibility,
        linkedTransactionId: f.linkedTransactionId,
        amount: v.amount,
      });

      const txn = Transaction.build({
        accountId: account.id,
        householdId: opts.householdId ?? account.householdId ?? null,
        createdByUserId: opts.userId ?? account.ownerUserId ?? null,
        visibility: accountVisibility,
        ownershipType:
          f.autoSplitType === 'partner' || f.autoSplitType === 'shared' ? f.autoSplitType : 'me',
        ownershipContactId: null,
        importBatch,
        date: v.date,
        merchantRaw: v.merchantRaw,
        merchantClean: f.merchantClean,
        merchantCanonical: f.merchantCanonical,
        txnType: f.txnType,
        amount: String(v.amount),
        currency: v.currency,
        notes: f.notes,
        sourceReference: v.sourceReference,
        sourceRowFingerprint: fp,
        sourceIdentityFingerprint: identityFp,
        appliedRuleId: f.appliedRuleId,
        autoCategory: f.autoCategory,
        autoBusiness: f.autoBusiness,
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
        isRecurring: f.isRecurring,
        reviewFlag: f.reviewFlag,
        reviewedAt: null,
        importConfidence: confidence.state,
        importConfidenceFlags: serializeFlags(confidence.flags),
      });

      recomputeTransactionAmounts(txn);

      try {
        // SAVEPOINT around the per-row insert + its signal sidecar. On
        // Postgres, a unique-violation here would otherwise poison the
        // outer transaction; the next iteration's txn.save would then
        // throw "current transaction is aborted, commands ignored until
        // end of transaction block" and escape this catch. Nesting via
        // sequelize.transaction({ transaction: t }, …) emits a SAVEPOINT
        // so the unique-violation rolls back only this row.
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

          // Persist the item-link match through the canonical TransactionOrderLink
          // join table (status 'suggested') so imports auto-surface suggested links.
          const orderLink = enriched.signals.find((s) => s.orderLink)?.orderLink;
          if (orderLink) {
            await upsertSuggestedOrderLink({
              transactionId: txn.id,
              externalOrderId: orderLink.externalOrderId,
              confidence: orderLink.confidence,
              matchReason: orderLink.matchReason,
              transaction: sp,
            });
          }

          // Rule actions side-effects (issue #795): set_label / set_alert.
          const ruleActions = findRuleActionsSignal(enriched.signals);
          if (ruleActions) {
            await applyRuleSideEffects({
              ruleActions,
              transactionId: txn.id,
              householdId: opts.householdId ?? account.householdId ?? null,
              transaction: sp,
            });
          }
        });
        inserted += 1;
        if (enriched.fields.reviewFlag) {
          const key = (f.merchantCanonical ?? '').trim() || f.merchantClean.trim();
          if (key.length > 0) {
            coldRows.push({
              txnId: txn.id,
              signals: enriched.signals,
              merchantKey: key,
              merchantRaw: v.merchantRaw,
              merchantClean: f.merchantClean,
              merchantCanonical: f.merchantCanonical,
              amount: v.amount,
              date: v.date,
              currency: v.currency,
              memory,
              accountVisibility,
              txnType: f.txnType,
            });
          }
        }
      } catch (e) {
        if (isSequelizeUniqueLike(e)) {
          skippedDup += 1;
        } else {
          throw e;
        }
      }
    }

    const status =
      rowErrors > 0 && inserted === 0
        ? 'failed'
        : rowErrors > 0
          ? 'partial'
          : 'success';
    const errMsg =
      rowErrors > 0 ? `${rowErrors} row(s) could not be parsed` : null;

    await ImportHistory.create(
      {
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: importBatch,
        status,
        rowCount: inserted,
        errorMessage: errMsg,
        startedAt,
        finishedAt: new Date(),
        householdId: opts.householdId ?? account.householdId ?? null,
        createdByUserId: opts.userId ?? account.ownerUserId ?? null,
        // #231: structured batch metadata so the batch detail view can
        // surface account + profile + per-stage counts without rebuilding
        // them from the wire.
        accountId: account.id,
        profileId,
        insertedCount: inserted,
        skippedDuplicateCount: skippedDup,
        rowErrorsCount: rowErrors,
      },
      { transaction: t }
    );
  });

  // === Phase 2a: stage 5.5 embedding-match over cold rows (#792) ===
  // Local, offline-capable semantic match against the household's reviewed
  // merchants. Runs BEFORE the OpenAI batch; rows it matches are persisted here
  // and removed from the AI-batch candidate set, so OpenAI stays the strict
  // below-threshold fallback. Runs outside the import transaction.
  const enrichHouseholdId = opts.householdId ?? account.householdId ?? null;
  const embeddingMatch = await maybeRunEmbeddingMatchOverColdRows(coldRows, enrichHouseholdId);

  // === Phase 2b: stage 8 ai-batch over the rows embedding-match left cold ===
  // Runs OUTSIDE the import transaction so OpenAI latency doesn't hold DB locks.
  // Each enhancement is an independent update; partial enhancement is acceptable
  // (cold rows still have phase-1 fields and review_flag=true).
  const aiEnhanced = await maybeRunAiBatchOverColdRows(
    embeddingMatch.remainingColdRows,
    enrichHouseholdId,
  );

  const out: Record<string, unknown> = {
    file: name,
    batchLabel: importBatch,
    inserted,
    skippedDuplicates: skippedDup,
    rowErrors,
    parseErrors,
    contentHash,
    usedProfileId: profileId,
    profileInferred: profileInferred,
  };
  if (inserted === 0 && rowErrors > 0) {
    out.warning =
      'No rows imported — check CSV columns (Date, Description, Amount) and the selected profile, or date format.';
  } else if (inserted === 0 && rowErrors === 0 && records.length === 0) {
    out.warning = 'No data rows found — is the file empty or header-only?';
  } else if (inserted === 0 && skippedDup > 0 && rowErrors === 0) {
    out.warning =
      'Every row matched an existing transaction (duplicate) — nothing new to add.';
  }
  if (embeddingMatch.summary.attempted) {
    out.embeddingMatch = {
      coldRows: embeddingMatch.summary.coldRowCount,
      priorMerchants: embeddingMatch.summary.priorMerchants,
      matched: embeddingMatch.summary.matched,
    };
  }
  if (aiEnhanced.attempted) {
    out.aiBatch = {
      coldRows: aiEnhanced.coldRowCount,
      merchantsConsidered: aiEnhanced.merchantsConsidered,
      enhanced: aiEnhanced.enhanced,
      capped: aiEnhanced.capped,
      usedBatch: aiEnhanced.usedBatch,
      fellBackToPerRow: aiEnhanced.fellBackToPerRow,
    };
  }
  return out;
}

export async function runImport(options: {
  profileId?: string;
  householdId?: number | null;
  userId?: number | null;
} = {}) {
  const profileId =
    options.profileId ||
    (process.env.CSV_PROFILE_ID &&
    process.env.CSV_PROFILE_ID.trim() !== 'auto'
      ? process.env.CSV_PROFILE_ID
      : undefined) ||
    'auto';
  const uploadDir = env.csvUploadDir;
  await fs.mkdir(uploadDir, { recursive: true });

  const files = (await fs.readdir(uploadDir)).filter((f) =>
    f.toLowerCase().endsWith('.csv')
  );

  const results = [];

  for (const name of files) {
    const fullPath = path.join(uploadDir, name);
    assertUnderRoot(uploadDir, fullPath);

    const buf = await fs.readFile(fullPath);
    const r = await importCsvFile({
      buffer: buf,
      fileName: name,
      profileId,
      householdId: options.householdId,
      userId: options.userId,
    });
    results.push(r);
  }

  return { results, uploadDir };
}

// ─── Wealthsimple bundle import ─────────────────────────────────────────────

/** Per-file result emitted by `importWsBundleFile`. */
export type BundleFileResult = {
  file: string;
  wsid: string | null;
  accountId: number | null;
  accountName: string | null;
  accountCreated: boolean;
  inserted: number;
  insertedTransactions: number;
  insertedInvestmentActivities: number;
  skippedDuplicates: number;
  rowErrors: number;
  parseErrors: { rowIndex: number; message: string }[];
  warnings: string[];
  error?: string;
};

type WsAccountTemplate = {
  name: string;
  accountType: 'checking' | 'credit_card' | 'investment';
};

/**
 * Maps a Wealthsimple product hint (derived from the filename) to the account
 * name + accountType we auto-create on first sighting of that WSID.
 *
 * We deliberately restrict accountType to the existing enum
 * (`checking | credit_card | investment`) — no new types added.
 */
const WS_ACCOUNT_TEMPLATES: Record<WsProductHint, WsAccountTemplate> = {
  chequing: { name: 'Wealthsimple Chequing', accountType: 'checking' },
  save_for_business: {
    name: 'Wealthsimple Save for Business',
    accountType: 'checking',
  },
  corporate_chequing: {
    name: 'Wealthsimple Corporate Chequing',
    accountType: 'checking',
  },
  tfsa: { name: 'Wealthsimple TFSA', accountType: 'investment' },
  fhsa: { name: 'Wealthsimple FHSA', accountType: 'investment' },
  margin: { name: 'Wealthsimple Investing', accountType: 'investment' },
  corporate_investing: {
    name: 'Wealthsimple Corporate Investing',
    accountType: 'investment',
  },
  crypto: { name: 'Wealthsimple Crypto', accountType: 'investment' },
  credit_card: { name: 'Wealthsimple Credit Card', accountType: 'credit_card' },
};

function emptyBundleResult(file: string, error: string): BundleFileResult {
  return {
    file,
    wsid: null,
    accountId: null,
    accountName: null,
    accountCreated: false,
    inserted: 0,
    insertedTransactions: 0,
    insertedInvestmentActivities: 0,
    skippedDuplicates: 0,
    rowErrors: 0,
    parseErrors: [],
    warnings: [],
    error,
  };
}

/**
 * Import a single file from a Wealthsimple bulk-statement-bundle drop.
 *
 * Pipeline:
 *   1. Parse filename → `{wsid, productHint, isCreditCard, periodEnd}`.
 *   2. `Account.findOrCreate` keyed on `(householdId, shortCode=wsid)` —
 *      race-safe because the unique index on `(household_id, short_code)`
 *      guarantees serialized insertions.
 *   3. Pick a generic CSV profile: `generic_simple` for credit-card-style
 *      Purchase/Payment files, `generic_passthrough` for the standard
 *      pre-signed monthly statements.
 *   4. For corp-typed files (`corporate_investing`, `save_for_business`,
 *      `corporate_chequing`), flip `overrideBusiness=true` so every new
 *      Transaction gets `autoBusiness=true`, regardless of whether this
 *      file created the account or matched an existing one.
 *   5. Parse + commit using the standard preview/commit pipeline.
 */
export async function importWsBundleFile(opts: {
  buffer: Buffer;
  fileName: string;
  householdId: number;
  userId: number;
}): Promise<BundleFileResult> {
  const file = path.basename(opts.fileName || 'upload.csv').replace(/[\\/]/g, '');
  const parsed = parseWealthsimpleFilename(file);
  if (!parsed) {
    return emptyBundleResult(file, 'unrecognized Wealthsimple filename');
  }

  const template = WS_ACCOUNT_TEMPLATES[parsed.productHint];

  const [account, accountCreated] = await Account.findOrCreate({
    where: { householdId: opts.householdId, shortCode: parsed.wsid },
    defaults: {
      householdId: opts.householdId,
      name: template.name,
      accountType: template.accountType,
      owner: 'me',
      visibility: 'private',
      defaultCurrency: 'CAD',
      ownerUserId: opts.userId,
      shortCode: parsed.wsid,
    },
  });

  // WS corp accounts (Corporate Investing / Chequing / Save for Business) have
  // no statement accountHolder to resolve, so link them to the household corp
  // Entity (created by the Wise/RBC importer) when one exists. No-op otherwise.
  await linkWsAccountToCorpEntity(account, parsed.productHint, opts.householdId);

  // Self-heal a mis-typed account. A monthly WS statement carrying
  // security-bearing activity (BUY/SELL/DIV/CRYPTORWD) means this is a
  // brokerage account — even if it was first created as 'checking' because its
  // filename display name didn't match an investment hint (e.g. "TFSA account"
  // fails the exact-match check). accountType is otherwise locked on first
  // findOrCreate, so without this the InvestmentActivity extraction gate in
  // parseStatementFile (which keys on accountType==='investment') silently
  // drops every BUY/SELL/DIV and corrupts portfolio valuation. Upgrade BEFORE
  // parsing so the activities are emitted. Pure-cash codes (CONT/INT/FEE/AFT_*/
  // P2P_*) never trigger this, so a HISA like "Save for Business" — whose
  // statements only ever show CONT + Interest — stays 'checking'.
  const accountTypeWarnings: string[] = [];
  if (!parsed.isCreditCard && account.accountType !== 'investment') {
    const parsedCsv = parseCsvRecords(opts.buffer.toString('utf8'));
    if (parsedCsv.ok && wsRecordsHaveSecurityActivity(parsedCsv.records)) {
      const from = account.accountType;
      await account.update({ accountType: 'investment' });
      accountTypeWarnings.push(
        `Upgraded account #${account.id} accountType ${from} → investment ` +
          `(statement carries BUY/SELL/DIV activity)`,
      );
    }
  }

  const profileId = parsed.isCreditCard ? 'generic_simple' : 'generic_passthrough';

  // Force business flag on every row imported into a corp-typed WS account.
  // Driven by productHint alone (not `accountCreated`) — multi-file bundles
  // and re-imports must still stamp business on subsequent files for the same
  // WSID. The flag applies only to NEW rows committed in this run; existing
  // rows are not retroactively touched by this code path.
  const overrideBusiness =
    parsed.productHint === 'corporate_investing' ||
    parsed.productHint === 'save_for_business' ||
    parsed.productHint === 'corporate_chequing';

  const preview = await parseStatementFile({
    buffer: opts.buffer,
    fileName: file,
    accountId: account.id,
    profileId,
    householdId: opts.householdId,
    overrideBusiness,
  });
  if ('error' in preview) {
    return {
      ...emptyBundleResult(file, preview.error),
      wsid: parsed.wsid,
      accountId: account.id,
      accountName: account.name,
      accountCreated,
    };
  }

  const commit = await commitStatementImport(preview, opts.userId, opts.householdId);

  return {
    file,
    wsid: parsed.wsid,
    accountId: account.id,
    accountName: account.name,
    accountCreated,
    inserted: commit.insertedTransactions + commit.insertedInvestmentActivities,
    insertedTransactions: commit.insertedTransactions,
    insertedInvestmentActivities: commit.insertedInvestmentActivities,
    skippedDuplicates: commit.skippedDuplicates,
    rowErrors: commit.rowErrors,
    parseErrors: commit.parseErrors,
    warnings: [...accountTypeWarnings, ...commit.warnings],
  };
}

// ─── PDF bundle import (RBC, CIBC, Questrade) ───────────────────────────────

/** Per-file result emitted by `importPdfBundleFile`. */
export type PdfBundleFileResult = {
  file: string;
  accountSuffix: string | null;
  productLabel: string | null;
  accountId: number | null;
  accountName: string | null;
  accountCreated: boolean;
  inserted: number;
  insertedTransactions: number;
  insertedInvestmentActivities: number;
  insertedHoldings: number;
  skippedDuplicates: number;
  rowErrors: number;
  parseErrors: { rowIndex: number; message: string }[];
  warnings: string[];
  error?: string;
};

type PdfAccountTemplate = {
  name: string;
  accountType: 'checking' | 'savings' | 'credit_card' | 'investment' | 'loan';
};

/**
 * Maps the productLabel emitted by a PDF parser's `header.productLabel` to
 * the auto-create defaults (account name + accountType). PDF body is
 * authoritative — filename hints (e.g. "Chequing-4660" which is actually an
 * eSavings) are ignored at this step.
 */
const PDF_ACCOUNT_TEMPLATES: Record<string, PdfAccountTemplate> = {
  'RBC Digital Choice Business': { name: 'RBC Digital Choice Business', accountType: 'checking' },
  'RBC Day to Day Banking': { name: 'RBC Day to Day Banking', accountType: 'checking' },
  'RBC Day to Day Savings': { name: 'RBC Day to Day Savings', accountType: 'savings' },
  'RBC High Interest eSavings': { name: 'RBC High Interest eSavings', accountType: 'savings' },
  'Find & Save': { name: 'RBC NOMI Find & Save', accountType: 'savings' },
  'Signature RBC Rewards Visa': { name: 'RBC Avion Visa', accountType: 'credit_card' },
  'RBC Avion Visa': { name: 'RBC Avion Visa', accountType: 'credit_card' },
  'RBC Visa': { name: 'RBC Visa', accountType: 'credit_card' },
  'Royal Credit Line': { name: 'RBC Royal Credit Line', accountType: 'loan' },
  'Tax-Free Savings Account': { name: 'RBC TFSA', accountType: 'investment' },
  'Registered Disability Savings Plan': { name: 'RBC RDSP', accountType: 'investment' },
  'Individual Margin': { name: 'Questrade Margin', accountType: 'investment' },
  'Individual FHSA': { name: 'Questrade FHSA', accountType: 'investment' },
  'Individual TFSA': { name: 'Questrade TFSA', accountType: 'investment' },
  'Individual RRSP': { name: 'Questrade RRSP', accountType: 'investment' },
  'Individual Cash': { name: 'Questrade Cash', accountType: 'investment' },
  'Questrade Investment': { name: 'Questrade Investment', accountType: 'investment' },
  'Wise CAD': { name: 'Wise CAD', accountType: 'checking' },
  'Wise USD': { name: 'Wise USD', accountType: 'checking' },
  'Wise GBP': { name: 'Wise GBP', accountType: 'checking' },
  'Wise EUR': { name: 'Wise EUR', accountType: 'checking' },
  'Wealthsimple TFSA': { name: 'Wealthsimple TFSA', accountType: 'investment' },
  'Wealthsimple FHSA': { name: 'Wealthsimple FHSA', accountType: 'investment' },
  'Wealthsimple RRSP': { name: 'Wealthsimple RRSP', accountType: 'investment' },
  'Wealthsimple RESP': { name: 'Wealthsimple RESP', accountType: 'investment' },
  'Wealthsimple Investing': { name: 'Wealthsimple Investing', accountType: 'investment' },
  'Wealthsimple Credit Card': { name: 'Wealthsimple Credit Card', accountType: 'credit_card' },
  'American Express Aeroplan Reserve Card': { name: 'Amex Reserve', accountType: 'credit_card' },
  'American Express Cobalt Card': { name: 'Amex Cobalt', accountType: 'credit_card' },
};

// Corp entity suffix patterns (Inc., Corp., Ltd., LLC, GmbH, Pty, S.A.). When a
// PDF header's accountHolder matches one of these, the bundle importer
// find-or-creates a `kind='corp'` Entity and stamps every committed
// transaction `autoBusiness=true` via `overrideBusiness`.
const CORP_HOLDER_RE = /(?:\bInc\.?|\bCorp\.?|\bCorporation\b|\bLtd\.?|\bLLC\b|\bLLP\b|\bGmbH\b|\bPty\b|\bS\.A\.)/i;

export async function resolveEntityForHolder(
  holder: string | null | undefined,
  householdId: number,
): Promise<InstanceType<typeof Entity> | null> {
  if (!holder) return null;
  const trimmed = holder.trim();
  if (!trimmed) return null;
  // Case-insensitive match within the household so statements that spell the
  // corp differently ("CDG Labs Inc." vs "CDG LABS INC.") reuse one Entity
  // instead of forking a duplicate. A same-named entity in another household
  // must NOT be reused — scope the match by household_id.
  const existing = await Entity.findOne({
    where: {
      householdId,
      [Op.and]: [sqlWhere(fn('lower', col('legal_name')), trimmed.toLowerCase())],
    },
  });
  if (existing) return existing;
  if (!CORP_HOLDER_RE.test(trimmed)) return null;
  return Entity.create({
    householdId,
    kind: 'corp',
    legalName: trimmed,
  });
}

/** Wealthsimple productHints that denote a corporate account. */
const WS_CORP_PRODUCT_HINTS = new Set([
  'corporate_investing',
  'save_for_business',
  'corporate_chequing',
]);

/**
 * Link a Wealthsimple corp account to the household's corp Entity. The WS
 * bundle importer (unlike the PDF importer) has no statement "accountHolder"
 * to resolve, so corp WS accounts historically ended up with no corp entity
 * (NULL or the personal default), silently excluding them from the T2 engine.
 * When a corp Entity already exists in the household (the Wise/RBC importer
 * auto-creates "CDG LABS INC." on first upload), point the WS corp account at
 * it. No-op for non-corp products or when no corp entity exists yet.
 * Case-insensitive matching lives in resolveEntityForHolder; here the corp
 * entity is looked up by kind. Idempotent.
 */
export async function linkWsAccountToCorpEntity(
  account: InstanceType<typeof Account>,
  productHint: string,
  householdId: number,
): Promise<void> {
  if (!WS_CORP_PRODUCT_HINTS.has(productHint)) return;
  const corp = await Entity.findOne({ where: { householdId, kind: 'corp' } });
  if (!corp) return;
  if (account.entityId !== corp.id) {
    await account.update({ entityId: corp.id });
  }
}

function emptyPdfBundleResult(file: string, error: string): PdfBundleFileResult {
  return {
    file,
    accountSuffix: null,
    productLabel: null,
    accountId: null,
    accountName: null,
    accountCreated: false,
    inserted: 0,
    insertedTransactions: 0,
    insertedInvestmentActivities: 0,
    insertedHoldings: 0,
    skippedDuplicates: 0,
    rowErrors: 0,
    parseErrors: [],
    warnings: [],
    error,
  };
}

/**
 * Resolve (find-or-create) the Account for a PDF statement from its parsed
 * header, applying the corp-entity + business-override logic. Shared by the
 * synchronous bundle path and the async pdfImportProcess worker.
 */
export async function resolvePdfAccountFromHeader(
  header: import('./pdf/types').PdfStatementHeader,
  householdId: number,
  userId: number,
  fileName?: string,
): Promise<{ account: InstanceType<typeof Account>; accountCreated: boolean; overrideBusiness: boolean }> {
  const template =
    PDF_ACCOUNT_TEMPLATES[header.productLabel] ?? { name: header.productLabel, accountType: header.accountType };
  const headerCurrency = header.currency ?? 'CAD';
  const entity = await resolveEntityForHolder(header.accountHolder, householdId);
  const overrideBusiness = entity?.kind === 'corp';

  // Stable match key. WS credit-card statement bodies print only the card last-4
  // (header.accountSuffix), which is neither unique across cards nor the key the
  // WS CSV path uses — so it forked a new account every time the existing one was
  // renamed or carried a different short_code. The WS account id (WSID) lives in
  // the PDF filename (`<WSID>_YYYY-MM_CREDIT_CARD.pdf`); prefer it when present.
  const wsCardWsid = fileName ? parseWsCreditCardPdfWsid(fileName) : null;
  const matchKey = wsCardWsid ?? header.accountSuffix;

  // First try to find account by shortCode (exact match on the stable key).
  let account = await Account.findOne({
    where: { householdId, shortCode: matchKey },
  });
  let accountCreated = false;

  // Fallback: if shortCode not found, try to find by name + accountType
  // (accounts from CSV may have different shortCode but same name/type). Scope
  // the match by corp-vs-personal: a corp statement (corp accountHolder, e.g.
  // "CDG Labs Inc.") and a personal statement of the same currency produce the
  // SAME template.name ("Wise USD") but a DIFFERENT account number, so the
  // shortCode lookup misses and this fallback fires. Keying on name alone here
  // merged a corporate Wise statement into the same-named personal Wise account
  // (and vice-versa). Only reuse an account whose corp-ness matches this
  // statement — a corp account carries an entity with kind='corp'; personal
  // accounts carry the household's personal entity (or NULL legacy).
  if (!account) {
    const candidates = await Account.findAll({
      where: { householdId, name: template.name, accountType: template.accountType },
      include: [{ model: Entity, as: 'entity', required: false }],
    });
    account =
      candidates.find((candidate) => {
        const candidateEntity = candidate.get('entity') as InstanceType<typeof Entity> | null | undefined;
        return (candidateEntity?.kind === 'corp') === overrideBusiness;
      }) ?? null;
    if (account && account.shortCode !== matchKey) {
      // Update shortCode to reflect the stable account key.
      await account.update({ shortCode: matchKey });
    }
  }

  // If still not found, create new account.
  if (!account) {
    account = await Account.create({
      householdId, name: template.name, accountType: template.accountType,
      owner: 'me', visibility: 'private', defaultCurrency: headerCurrency,
      ownerUserId: userId, shortCode: matchKey, entityId: entity?.id ?? null,
    });
    accountCreated = true;
  }

  if (entity && account.entityId !== entity.id) {
    await account.update({ entityId: entity.id });
  }

  // Credit-card statement → calendar auto-fill (#243 follow-up). Runs for both
  // the bundle path and the async pdfImportProcessor worker, since both resolve
  // their account through this function. Self-guards on accountType.
  try {
    await applyCreditCardStatementSummary({ account, header, userId, householdId });
  } catch (err) {
    logger.error({ err, accountId: account.id }, 'cc-statement: auto-fill failed (non-fatal)');
  }

  return { account, accountCreated, overrideBusiness };
}

/**
 * Import a single PDF statement from a bundle upload. Works with any parser
 * registered via `registerBuiltInPdfParsers` (RBC, CIBC, Questrade today).
 *
 * Pipeline:
 *   1. Extract PDF lines once, find the matching parser via sniff.
 *   2. Parse to get `header` (accountSuffix, productLabel, accountType, period).
 *   3. `Account.findOrCreate` keyed on `(householdId, shortCode=accountSuffix)`.
 *      The productLabel determines name + accountType from `PDF_ACCOUNT_TEMPLATES`.
 *   4. Run the standard parseStatementFile → commitStatementImport pipeline so
 *      fingerprinting / dedup / enrichment matches single-file uploads.
 *
 * Generic multi-parser entry point currently superseded by importWsBundleFile;
 * kept as the documented seam for re-wiring the non-Wealthsimple bundle path.
 */
// fallow-ignore-next-line unused-export
export async function importPdfBundleFile(opts: {
  buffer: Buffer;
  fileName: string;
  householdId: number;
  userId: number;
}): Promise<PdfBundleFileResult> {
  const file = path.basename(opts.fileName || 'statement.pdf').replace(/[\\/]/g, '');

  // Lazy-require to dodge the same circular-init concern as registry.ts.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { extractPdfLines } = require('./pdf/extractLines');
  const { findPdfParser, registerBuiltInPdfParsers } = require('./pdf/registry');
  /* eslint-enable @typescript-eslint/no-require-imports */
  registerBuiltInPdfParsers();

  let lines;
  try {
    lines = await extractPdfLines(opts.buffer);
  } catch (err) {
    return emptyPdfBundleResult(file, `Could not read PDF: ${(err as Error).message}`);
  }

  const parser = findPdfParser(lines);
  if (!parser) {
    return emptyPdfBundleResult(file, 'No PDF parser matched this statement layout');
  }
  let parseOut;
  try {
    parseOut = parser.parse(lines, { defaultCurrency: 'CAD' });
  } catch (err) {
    return emptyPdfBundleResult(file, `Parser ${parser.id} threw: ${(err as Error).message}`);
  }
  if (!parseOut.header) {
    return emptyPdfBundleResult(file, `Parser ${parser.id} produced no header for account match`);
  }
  const header = parseOut.header;
  const { account, accountCreated, overrideBusiness } = await resolvePdfAccountFromHeader(
    header, opts.householdId, opts.userId, file,
  );

  const preview = await parseStatementFile({
    buffer: opts.buffer,
    fileName: file,
    accountId: account.id,
    householdId: opts.householdId,
    overrideBusiness: overrideBusiness ? true : undefined,
    preExtractedLines: lines,
  });
  if ('error' in preview) {
    return {
      ...emptyPdfBundleResult(file, preview.error),
      accountSuffix: header.accountSuffix,
      productLabel: header.productLabel,
      accountId: account.id,
      accountName: account.name,
      accountCreated,
    };
  }

  const commit = await commitStatementImport(preview, opts.userId, opts.householdId);

  return {
    file,
    accountSuffix: header.accountSuffix,
    productLabel: header.productLabel,
    accountId: account.id,
    accountName: account.name,
    accountCreated,
    inserted:
      commit.insertedTransactions +
      commit.insertedInvestmentActivities +
      commit.insertedHoldings,
    insertedTransactions: commit.insertedTransactions,
    insertedInvestmentActivities: commit.insertedInvestmentActivities,
    insertedHoldings: commit.insertedHoldings,
    skippedDuplicates: commit.skippedDuplicates,
    rowErrors: commit.rowErrors,
    parseErrors: commit.parseErrors,
    warnings: commit.warnings,
  };
}

// ─── Wealthsimple holdings import ───────────────────────────────────────────

/** Summary returned by `importWsHoldingsFile`. */
export type HoldingsImportResult = {
  file: string;
  statementDate: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  skippedUnknownAccount: number;
  warnings: string[];
  errors: string[];
  accountsAffected: number;
};

/**
 * Import a single Wealthsimple holdings/positions CSV.
 *
 * Pipeline:
 *   1. Parse the file via `parseWsHoldingsCsv` — extracts the trailing
 *      `"As of YYYY-MM-DD …"` line as `statementDate` and emits a normalized
 *      row per holding.
 *   2. Group rows by `accountShortCode` and resolve each to an existing
 *      `Account` keyed on `(householdId, shortCode)`.  Holdings reports
 *      target existing accounts — we do NOT auto-create accounts here.
 *      Unknown account numbers increment `skippedUnknownAccount`.
 *   3. Per row:
 *      - `findOrCreateSecurity` (reused from the bundle commit path so
 *        securities created by BUY/SELL/DIV rows are reused — no duplicates).
 *      - Compute `sourceRowFingerprint =
 *          stableFingerprint({kind:'ws_holding', accountId, statementDate,
 *                             symbol, currency})`.
 *      - Look up an existing `HoldingSnapshot` by `(accountId, fingerprint)`.
 *        If found: UPDATE its market value / price / cost basis / unrealized
 *        (data is fresher than what's stored).
 *        If not: INSERT a new row.
 *   4. Wrap the whole thing in a transaction so a single failure rolls back
 *      cleanly without leaving partial state behind.
 *
 * `importBatch` is `Wealthsimple Holdings <YYYY-MM-DD>` based on
 * statementDate — keeps batches stable when the same report is re-uploaded.
 */
export async function importWsHoldingsFile(opts: {
  buffer: Buffer;
  fileName: string;
  householdId: number;
  userId: number;
}): Promise<HoldingsImportResult> {
  const file = path.basename(opts.fileName || 'holdings.csv').replace(/[\\/]/g, '');
  const text = opts.buffer.toString('utf8');
  const parsed = parseWsHoldingsCsv(text);
  if ('error' in parsed) {
    return {
      file,
      statementDate: null,
      totalRows: 0,
      inserted: 0,
      updated: 0,
      skippedUnknownAccount: 0,
      warnings: [],
      errors: [parsed.error],
      accountsAffected: 0,
    };
  }
  const { statementDate, rows, warnings: parseWarnings } = parsed;
  const importBatch = `Wealthsimple Holdings ${statementDate}`;
  const startedAt = new Date();
  const contentHash = hashContent(opts.buffer);

  // Cache: shortCode -> Account|null.  Holdings reports tend to repeat the
  // same Account Number across many rows (one per security); we only want
  // to hit the accounts table once per unique shortCode.
  const accountCache = new Map<string, AccountModel | null>();
  async function resolveByShortCode(shortCode: string): Promise<AccountModel | null> {
    const cached = accountCache.get(shortCode);
    if (cached !== undefined) return cached;
    const acct = await Account.findOne({
      where: { householdId: opts.householdId, shortCode },
    });
    accountCache.set(shortCode, acct);
    return acct;
  }

  let inserted = 0;
  let updated = 0;
  let skippedUnknownAccount = 0;
  const warnings = [...parseWarnings];
  const errors: string[] = [];
  const accountsTouched = new Set<number>();

  await sequelize.transaction(async (t) => {
    for (const row of rows) {
      const account = await resolveByShortCode(row.accountShortCode);
      if (!account) {
        skippedUnknownAccount += 1;
        warnings.push(
          `Unknown account: ${row.accountShortCode} (${row.symbol}) — create the account first to import its holdings.`,
        );
        continue;
      }

      const security = await findOrCreateSecurity(
        {
          symbol: row.symbol,
          name: row.name || null,
          assetType: row.assetType || null,
          currency: row.currency,
        },
        account.householdId,
        t,
      );

      const fingerprint = stableFingerprint({
        kind: 'ws_holding',
        accountId: account.id,
        statementDate,
        symbol: row.symbol.toUpperCase(),
        currency: row.currency,
      });

      const existing = await HoldingSnapshot.findOne({
        where: {
          accountId: account.id,
          sourceRowFingerprint: fingerprint,
        },
        transaction: t,
      });

      if (existing) {
        existing.securityId = security.id;
        existing.statementDate = statementDate;
        existing.quantity = String(row.quantity);
        existing.price = row.price == null ? null : String(row.price);
        existing.marketValue =
          row.marketValue == null ? null : String(row.marketValue);
        existing.costBasis = row.costBasis == null ? null : String(row.costBasis);
        existing.unrealizedGainLoss =
          row.unrealizedGainLoss == null ? null : String(row.unrealizedGainLoss);
        existing.currency = row.currency;
        existing.importBatch = importBatch;
        await existing.save({ transaction: t });
        updated += 1;
      } else {
        await HoldingSnapshot.create(
          {
            accountId: account.id,
            householdId: account.householdId,
            securityId: security.id,
            statementDate,
            quantity: String(row.quantity),
            price: row.price == null ? null : String(row.price),
            marketValue:
              row.marketValue == null ? null : String(row.marketValue),
            costBasis: row.costBasis == null ? null : String(row.costBasis),
            unrealizedGainLoss:
              row.unrealizedGainLoss == null
                ? null
                : String(row.unrealizedGainLoss),
            currency: row.currency,
            sourceReference: null,
            sourceRowFingerprint: fingerprint,
            importBatch,
          },
          { transaction: t },
        );
        inserted += 1;
      }
      accountsTouched.add(account.id);
    }

    await ImportHistory.create(
      {
        fileName: file,
        filePathSafe: file,
        contentHash,
        batchLabel: importBatch,
        status: errors.length > 0 ? 'partial' : 'success',
        rowCount: inserted + updated,
        errorMessage: errors.length > 0 ? errors.join('; ') : null,
        startedAt,
        finishedAt: new Date(),
        householdId: opts.householdId,
        createdByUserId: opts.userId,
        // #231: holdings imports target many accounts in a single batch; we
        // capture skippedUnknownAccount as the duplicate-equivalent and
        // leave accountId NULL because no single account owns the batch.
        accountId: null,
        profileId: null,
        insertedCount: inserted + updated,
        skippedDuplicateCount: skippedUnknownAccount,
        rowErrorsCount: errors.length,
      },
      { transaction: t },
    );
  });

  return {
    file,
    statementDate,
    totalRows: rows.length,
    inserted,
    updated,
    skippedUnknownAccount,
    warnings,
    errors,
    accountsAffected: accountsTouched.size,
  };
}
