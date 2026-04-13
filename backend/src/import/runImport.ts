import fs from 'fs/promises';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { Op } from 'sequelize';
import type { Account as AccountModel } from '../models/Account';
import {
  sequelize,
  Account,
  Transaction,
  ImportHistory,
} from '../models';
import { hashContent, rowFingerprint } from './fingerprint';
import { findBestRule, loadAllRules, applyRuleToAuto } from './applyRules';
import { recomputeTransactionAmounts } from './calculateShares';
import { mapCsvRow } from './mapRow';
import { parseStatementFilename } from './parseStatementFilename';
import { assertUnderRoot } from './pathUtils';
import * as env from '../config/env';

function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  if (tabs > commas && tabs > 0) return '\t';
  return ',';
}

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

export async function resolveAccount(cardToken: string) {
  const token = cardToken.trim();
  if (!token) return null;
  const lower = token.toLowerCase();
  return Account.findOne({
    where: {
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
};

/**
 * Import one CSV from memory. Either pass `accountId` (web upload) or rely on
 * `CardName_YYYY_MM.csv` filename (folder scan).
 */
export async function importCsvFile(opts: ImportCsvFileOpts) {
  const profileId =
    opts.profileId || process.env.CSV_PROFILE_ID || 'generic_simple';
  const name = path.basename(opts.fileName || 'upload.csv').replace(/[\\/]/g, '');
  const buf = opts.buffer;
  const contentHash = hashContent(buf);

  const prior = await ImportHistory.findOne({
    where: { contentHash, status: 'success' },
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

  const rules = await loadAllRules();
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
      });
      return { file: name, skipped: true, reason: 'invalid_account' };
    }
    const byId = await Account.findByPk(id);
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
      });
      return { file: name, skipped: true, reason: 'bad_filename' };
    }
    const resolved = await resolveAccount(meta.cardToken);
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
      });
      return { file: name, skipped: true, reason: 'unknown_account' };
    }
    account = resolved;
    importBatch = meta.batchLabel;
  }

  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  let records: Record<string, string>[];
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
    }) as Record<string, string>[];
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : 'CSV parse failed';
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
    });
    return {
      file: name,
      skipped: true,
      reason: 'parse_error',
      message: msg || 'Could not parse CSV (wrong delimiter or invalid file?)',
    };
  }
  const headers = records.length > 0 ? Object.keys(records[0]) : [];

  const defaultCurrency =
    account.defaultCurrency || env.defaultCurrency || 'CAD';

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

      const { rule, ambiguous } = findBestRule(rules, v.merchantClean);
      const autoFields =
        rule && !ambiguous
          ? applyRuleToAuto(rule)
          : {
              autoCategory: null as string | null,
              autoBusiness: null as boolean | null,
              autoSplitType: null as string | null,
              autoPctMe: null as string | null,
              autoPctPartner: null as string | null,
            };

      const reviewFlag =
        ambiguous ||
        !rule ||
        autoFields.autoCategory == null ||
        autoFields.autoSplitType == null;

      const txn = Transaction.build({
        accountId: account.id,
        importBatch,
        date: v.date,
        merchantRaw: v.merchantRaw,
        merchantClean: v.merchantClean,
        amount: String(v.amount),
        currency: v.currency,
        notes: null,
        sourceReference: v.sourceReference,
        sourceRowFingerprint: fp,
        appliedRuleId: rule && !ambiguous ? rule.id : null,
        ...autoFields,
        categoryOverride: null,
        businessOverride: null,
        splitOverride: null,
        pctMeOverride: null,
        pctPartnerOverride: null,
        reviewFlag,
        reviewedAt: null,
      });

      recomputeTransactionAmounts(txn);

      try {
        await txn.save({ transaction: t });
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

export async function runImport(options: { profileId?: string } = {}) {
  const profileId =
    options.profileId || process.env.CSV_PROFILE_ID || 'generic_simple';
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
    });
    results.push(r);
  }

  return { results, uploadDir };
}
