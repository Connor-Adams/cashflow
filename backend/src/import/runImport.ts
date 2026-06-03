import fs from 'fs/promises';
import path from 'path';
import { logger } from '../observability/logger';
import { Op } from 'sequelize';
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
import { mapCsvRow } from './mapRow';
import { parseStatementFilename } from './parseStatementFilename';
import {
  parseWealthsimpleFilename,
  type WsProductHint,
} from './parseWealthsimpleFilename';
import { parseStatementFile } from './parseStatementFile';
import {
  commitStatementImport,
  findOrCreateSecurity,
} from './commitStatementImport';
import { parseWsHoldingsCsv } from './wealthsimpleHoldingsParse';
import { assertUnderRoot } from './pathUtils';
import { findMerchantMemory } from '../ai/merchantMemory';
import * as env from '../config/env';
import { enrichTransaction } from './enrich';
import {
  computeImportConfidence,
  serializeFlags,
} from './computeImportConfidence';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
  enrichmentAiEnabled,
  enrichmentAiMaxMerchants,
  enrichmentAiPerRowConcurrency,
} from '../config/env';
import {
  loadAmazonOrdersCache,
  loadHouseholdAccountIds,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from './enrichment/loaders';
import { runAiBatchStage, type AiBatchCandidate, type AiBatchSuggestion } from './enrichment/aiBatchStage';
import { mergeSignals } from './enrichment/computeReviewFlag';
import { openaiJson } from '../ai/openaiJson';
import { getOpenAiConfig } from '../config/openai';
import { loadCategoryHints } from '../ai/suggestTransaction';
import type { MerchantMemoryMatch } from '../ai/merchantMemory';
import type { Signal } from './enrichment/types';
import { findOrCreateAccount } from './accountLookup';
import { extractAccountNumber } from './csvProfiles';

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

  let inserted = 0;
  let skippedDup = 0;
  let rowErrors = 0;
  const parseErrors: { rowIndex: number; message: string }[] = [];
  // Stage 8 deferral: rows that completed phase 1 still flagged for review accumulate
  // here, then a single AI batch (or per-row fallback) enhances them after commit.
  const coldRows: ColdRow[] = [];

  await sequelize.transaction(async (t) => {
    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const mapped = mapCsvRow(row, headers, profileId, defaultCurrency);
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
      });
      if (dedup.kind !== 'no-match') {
        skippedDup += 1;
        continue;
      }

      const memory = await findMerchantMemory(
        opts.householdId ?? account.householdId ?? null,
        v.merchantClean,
        v.amount,
      );

      const recurringHistory = await loadRecurringHistory(
        opts.householdId ?? account.householdId ?? null,
        v.merchantClean,
        v.date,
      );
      const relationshipCandidates = await loadRelationshipCandidates(
        opts.householdId ?? account.householdId ?? null,
        householdAccountIds,
        v.merchantClean,
        v.date,
        enrichmentRefundWindowDays,
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

  // === Phase 2: stage 8 ai-batch over cold rows ===
  // Runs OUTSIDE the import transaction so OpenAI latency doesn't hold DB locks.
  // Each enhancement is an independent update; partial enhancement is acceptable
  // (cold rows still have phase-1 fields and review_flag=true).
  const aiEnhanced = await maybeRunAiBatchOverColdRows(coldRows, opts.householdId ?? account.householdId ?? null);

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

type AiBatchSummary = {
  attempted: boolean;
  coldRowCount: number;
  merchantsConsidered: number;
  enhanced: number;
  capped: boolean;
  usedBatch: boolean;
  fellBackToPerRow: boolean;
};

type ColdRow = {
  txnId: number;
  signals: Signal[];
  merchantKey: string;
  merchantRaw: string;
  merchantClean: string;
  merchantCanonical: string | null;
  amount: number;
  date: string;
  currency: string;
  memory: MerchantMemoryMatch | null;
  /** Captured at insert-time so post-AI confidence reclassification doesn't
   *  need to round-trip through the DB. */
  accountVisibility: 'private' | 'shared';
  txnType: string;
};

export function dedupeColdRowsByMerchantKey(coldRows: ColdRow[]): ColdRow[] {
  const groups = new Map<string, ColdRow>();
  for (const c of coldRows) {
    const existing = groups.get(c.merchantKey);
    if (existing == null || c.date > existing.date) groups.set(c.merchantKey, c);
  }
  return [...groups.values()];
}

function coldRowToCandidate(c: ColdRow): AiBatchCandidate {
  return {
    merchantKey: c.merchantKey,
    sampleMerchantRaw: c.merchantRaw,
    sampleMerchantClean: c.merchantClean,
    sampleMerchantCanonical: c.merchantCanonical,
    sampleAmount: c.amount,
    sampleDate: c.date,
    sampleCurrency: c.currency,
    similarPriors: [],
    memoryMatch: c.memory ? { category: c.memory.category, supportCount: c.memory.supportCount } : null,
  };
}

export function aiSuggestionToSignal(sug: {
  category: string | null;
  business: boolean | null;
  splitType: 'me' | 'partner' | 'shared' | null;
  pctMe: number | null;
  pctPartner: number | null;
  confidence: 'high' | 'medium' | 'low';
  rationale: string | null;
}): Signal {
  return {
    source: 'ai',
    confidence: sug.confidence,
    fields: {
      autoCategory: sug.category,
      autoBusiness: sug.business,
      autoSplitType: sug.splitType,
      autoPctMe: sug.pctMe != null ? String(sug.pctMe) : null,
      autoPctPartner: sug.pctPartner != null ? String(sug.pctPartner) : null,
    },
    ...(sug.rationale ? { rationale: sug.rationale } : {}),
  };
}

async function persistAiEnhancement(c: ColdRow, aiSignal: Signal, householdId: number | null): Promise<boolean> {
  const merged = mergeSignals([...c.signals, aiSignal]);
  // Re-classify import confidence with the merged enrichment fields. An AI
  // suggestion that fills a category and turns reviewFlag off should move
  // the row from 'needs_review' back to 'clean' on the dashboard.
  const confidence = computeImportConfidence({
    reviewFlag: merged.fields.reviewFlag,
    finalCategory: merged.fields.autoCategory,
    autoCategory: merged.fields.autoCategory,
    autoSplitType: merged.fields.autoSplitType,
    finalSplitType:
      merged.fields.autoSplitType === 'partner' ||
      merged.fields.autoSplitType === 'shared'
        ? merged.fields.autoSplitType
        : 'me',
    txnType: c.txnType,
    accountVisibility: c.accountVisibility,
    linkedTransactionId: merged.fields.linkedTransactionId,
    amount: c.amount,
  });
  try {
    await Transaction.update(
      {
        autoCategory: merged.fields.autoCategory,
        autoBusiness: merged.fields.autoBusiness,
        autoSplitType: merged.fields.autoSplitType,
        autoPctMe: merged.fields.autoPctMe,
        autoPctPartner: merged.fields.autoPctPartner,
        autoSource: merged.fields.autoSource,
        autoConfidence: merged.fields.autoConfidence,
        reviewFlag: merged.fields.reviewFlag,
        importConfidence: confidence.state,
        importConfidenceFlags: serializeFlags(confidence.flags),
      },
      { where: { id: c.txnId } },
    );
    await TransactionSignal.create({
      transactionId: c.txnId,
      source: 'ai',
      confidence: aiSignal.confidence,
      fields: aiSignal.fields,
      rationale: aiSignal.rationale ?? null,
    });
    if (householdId != null) {
      const { ensureCategory } = await import('../util/ensureCategory');
      await ensureCategory(householdId, merged.fields.autoCategory);
    }
    return true;
  } catch (err) {
    logger.warn({ err, txnId: c.txnId, module: 'enrichment' }, 'enrichment_ai_batch_post_update_failed');
    return false;
  }
}

function emptyAiSummary(coldRowCount: number): AiBatchSummary {
  return {
    attempted: false,
    coldRowCount,
    merchantsConsidered: 0,
    enhanced: 0,
    capped: false,
    usedBatch: false,
    fellBackToPerRow: false,
  };
}

function aiBatchPossible(coldRows: ColdRow[]): boolean {
  if (!enrichmentAiEnabled) return false;
  if (coldRows.length === 0) return false;
  return getOpenAiConfig() != null;
}

async function tryEnhanceColdRow(c: ColdRow, sug: AiBatchSuggestion | undefined, householdId: number | null): Promise<boolean> {
  if (sug == null || sug.category == null) return false;
  return persistAiEnhancement(c, aiSuggestionToSignal(sug), householdId);
}

async function applyAiSuggestionsToColdRows(
  coldRows: ColdRow[],
  suggestions: Map<string, AiBatchSuggestion>,
  householdId: number | null,
): Promise<number> {
  let enhanced = 0;
  for (const c of coldRows) {
    if (await tryEnhanceColdRow(c, suggestions.get(c.merchantKey), householdId)) enhanced += 1;
  }
  return enhanced;
}

async function maybeRunAiBatchOverColdRows(
  coldRows: ColdRow[],
  householdId: number | null,
): Promise<AiBatchSummary> {
  if (!aiBatchPossible(coldRows)) return emptyAiSummary(coldRows.length);

  const candidates = dedupeColdRowsByMerchantKey(coldRows).map(coldRowToCandidate);
  const categoryHints = await loadCategoryHints(householdId);
  const result = await runAiBatchStage({
    candidates,
    categoryHints,
    maxMerchants: enrichmentAiMaxMerchants,
    perRowConcurrency: enrichmentAiPerRowConcurrency,
    openaiCaller: (msgs) => openaiJson(msgs),
  });
  const enhanced = await applyAiSuggestionsToColdRows(coldRows, result.suggestions, householdId);

  return {
    attempted: true,
    coldRowCount: coldRows.length,
    merchantsConsidered: candidates.length,
    enhanced,
    capped: result.capped,
    usedBatch: result.usedBatch,
    fellBackToPerRow: result.fellBackToPerRow,
  };
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
    warnings: commit.warnings,
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
  const existing = await Entity.findOne({
    where: { householdId, legalName: trimmed },
  });
  if (existing) return existing;
  if (!CORP_HOLDER_RE.test(trimmed)) return null;
  return Entity.create({
    householdId,
    kind: 'corp',
    legalName: trimmed,
  });
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
 */
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
  const template =
    PDF_ACCOUNT_TEMPLATES[header.productLabel] ?? {
      name: header.productLabel,
      accountType: header.accountType,
    };

  const headerCurrency = header.currency ?? 'CAD';
  const entity = await resolveEntityForHolder(header.accountHolder, opts.householdId);
  const overrideBusiness = entity?.kind === 'corp';

  const [account, accountCreated] = await Account.findOrCreate({
    where: { householdId: opts.householdId, shortCode: header.accountSuffix },
    defaults: {
      householdId: opts.householdId,
      name: template.name,
      accountType: template.accountType,
      owner: 'me',
      visibility: 'private',
      defaultCurrency: headerCurrency,
      ownerUserId: opts.userId,
      shortCode: header.accountSuffix,
      entityId: entity?.id ?? null,
    },
  });
  if (entity && account.entityId !== entity.id) {
    await account.update({ entityId: entity.id });
  }

  const preview = await parseStatementFile({
    buffer: opts.buffer,
    fileName: file,
    accountId: account.id,
    householdId: opts.householdId,
    overrideBusiness: overrideBusiness ? true : undefined,
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
