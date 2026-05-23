import fs from 'fs/promises';
import path from 'path';
import { Op } from 'sequelize';
import type { Account as AccountModel } from '../models/Account';
import {
  sequelize,
  Account,
  Transaction,
  ImportHistory,
  TransactionSignal,
} from '../models';
import { hashContent, rowFingerprint } from './fingerprint';
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
import { commitStatementImport } from './commitStatementImport';
import { assertUnderRoot } from './pathUtils';
import { findMerchantMemory } from '../ai/merchantMemory';
import * as env from '../config/env';
import { enrichTransaction } from './enrich';
import {
  enrichmentRecurringMinSupport,
  enrichmentAmazonLinkThreshold,
  enrichmentRefundWindowDays,
  enrichmentTransferWindowDays,
} from '../config/env';
import {
  loadAmazonOrdersCache,
  loadHouseholdAccountIds,
  loadRecurringHistory,
  loadRelationshipCandidates,
} from './enrichment/loaders';

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

function isSequelizeUniqueLike(e: unknown): boolean {
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

  const rules = await loadAllRules(opts.householdId);
  const amazonOrdersCache = await loadAmazonOrdersCache(opts.householdId ?? null);
  const startedAt = new Date();
  let account: AccountModel;
  let importBatch: string;

  if (opts.accountId != null && opts.accountId !== '') {
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
    const meta = parseStatementFilename(name);
    if (!meta) {
      await ImportHistory.create({
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: 'invalid-filename',
        status: 'failed',
        rowCount: 0,
        errorMessage:
          'Filename must match CardName_YYYY_MM.csv (e.g. Amex_2025_01.csv), or pass accountId when uploading from the web',
        startedAt,
        finishedAt: new Date(),
        householdId: opts.householdId ?? null,
        createdByUserId: opts.userId ?? null,
      });
      return { file: name, skipped: true, reason: 'bad_filename' };
    }
    const resolved = await resolveAccount(meta.cardToken, opts.householdId);
    if (!resolved) {
      await ImportHistory.create({
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: meta.batchLabel,
        status: 'failed',
        rowCount: 0,
        errorMessage: `No account matches token "${meta.cardToken}" (short_code or name)`,
        startedAt,
        finishedAt: new Date(),
        householdId: opts.householdId ?? null,
        createdByUserId: opts.userId ?? null,
      });
      return { file: name, skipped: true, reason: 'unknown_account' };
    }
    account = resolved;
    importBatch = meta.batchLabel;
  }

  const householdAccountIds = await loadHouseholdAccountIds(account.id, opts.householdId ?? account.householdId ?? null);

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

  const defaultCurrency =
    account.defaultCurrency || env.defaultCurrency || 'CAD';

  const { profileId, inferred: profileInferred } = resolveProfileIdForImport(
    opts.profileId ?? undefined,
    process.env.CSV_PROFILE_ID,
    headers,
    records,
    defaultCurrency,
  );

  let inserted = 0;
  let skippedDup = 0;
  let rowErrors = 0;
  const parseErrors: { rowIndex: number; message: string }[] = [];

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
        merchantClean: v.merchantClean,
        sourceReference: v.sourceReference,
      });

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

      const txn = Transaction.build({
        accountId: account.id,
        householdId: opts.householdId ?? account.householdId ?? null,
        createdByUserId: opts.userId ?? account.ownerUserId ?? null,
        visibility: account.visibility === 'shared' ? 'shared' : 'private',
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
      });

      recomputeTransactionAmounts(txn);

      try {
        await txn.save({ transaction: t });
        if (enriched.signals.length > 0) {
          await TransactionSignal.bulkCreate(
            enriched.signals.map((s) => ({
              transactionId: txn.id,
              source: s.source,
              confidence: s.confidence,
              fields: s.fields,
              rationale: s.rationale ?? null,
            })),
            { transaction: t },
          );
        }
        inserted += 1;
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
      },
      { transaction: t }
    );
  });

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
 *   4. For newly-created corporate accounts (`corporate_investing`,
 *      `save_for_business`), flip `overrideBusiness=true` so every
 *      Transaction gets `autoBusiness=true`.
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

  // Force business flag for newly-discovered corporate accounts. Existing
  // accounts retain whatever the user previously chose — don't surprise the
  // user by retroactively flipping flags on prior Wealthsimple data.
  const overrideBusiness =
    accountCreated &&
    (parsed.productHint === 'corporate_investing' ||
      parsed.productHint === 'save_for_business');

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
