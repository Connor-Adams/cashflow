const fs = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');
const { Op } = require('sequelize');
const {
  sequelize,
  Account,
  Transaction,
  ImportHistory,
} = require('../models');
const { hashContent, rowFingerprint } = require('./fingerprint');
const { findBestRule, loadAllRules, applyRuleToAuto } = require('./applyRules');
const { recomputeTransactionAmounts } = require('./calculateShares');
const { mapCsvRow } = require('./mapRow');
const { parseStatementFilename } = require('./parseStatementFilename');
const { assertUnderRoot } = require('./pathUtils');
const env = require('../config/env');

function detectDelimiter(text) {
  const line =
    text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  if (tabs > commas && tabs > 0) return '\t';
  return ',';
}

/**
 * @param {string} cardToken
 */
async function resolveAccount(cardToken) {
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

/**
 * Import one CSV from memory. Either pass `accountId` (web upload) or rely on
 * `CardName_YYYY_MM.csv` filename (folder scan).
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer
 * @param {string} opts.fileName - basename-safe label for history
 * @param {string} [opts.profileId]
 * @param {number|null} [opts.accountId] - when set, filename is not used for account
 * @param {string|null} [opts.batchLabel] - when accountId set, optional batch name
 */
async function importCsvFile(opts) {
  const profileId =
    opts.profileId || process.env.CSV_PROFILE_ID || 'generic_simple';
  const name = path.basename(opts.fileName || 'upload.csv').replace(/[\\/]/g, '');
  const buf = opts.buffer;
  const contentHash = hashContent(buf);

  const prior = await ImportHistory.findOne({
    where: { contentHash, status: 'success' },
  });
  // Allow re-import of the same bytes if a previous run imported 0 rows (wrong profile, etc.)
  if (prior && prior.rowCount > 0) {
    return {
      file: name,
      skipped: true,
      reason: 'already_imported',
      contentHash,
      message:
        'This file was already imported. Change the CSV or clear duplicate import history to try again.',
    };
  }

  const rules = await loadAllRules(sequelize);
  const startedAt = new Date();
  let account;
  let importBatch;

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
    account = await Account.findByPk(id);
    if (!account) {
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
    account = await resolveAccount(meta.cardToken);
    if (!account) {
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
    importBatch = meta.batchLabel;
  }

  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  let records;
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
    });
  } catch (parseErr) {
    await ImportHistory.create({
      fileName: name,
      filePathSafe: name,
      contentHash,
      batchLabel: 'parse-error',
      status: 'failed',
      rowCount: 0,
      errorMessage: parseErr.message || 'CSV parse failed',
      startedAt,
      finishedAt: new Date(),
    });
    return {
      file: name,
      skipped: true,
      reason: 'parse_error',
      message: parseErr.message || 'Could not parse CSV (wrong delimiter or invalid file?)',
    };
  }
  const headers = records.length > 0 ? Object.keys(records[0]) : [];

  const defaultCurrency =
    account.defaultCurrency || env.defaultCurrency || 'CAD';

  let inserted = 0;
  let skippedDup = 0;
  let rowErrors = 0;

  await sequelize.transaction(async (t) => {
    for (const row of records) {
      const mapped = mapCsvRow(row, headers, profileId, defaultCurrency);
      if (mapped.error) {
        rowErrors += 1;
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
      let autoFields = {
        autoCategory: null,
        autoBusiness: null,
        autoSplitType: null,
        autoPctMe: null,
        autoPctPartner: null,
      };
      if (rule && !ambiguous) {
        autoFields = applyRuleToAuto(rule);
      }

      const reviewFlag =
        ambiguous ||
        !rule ||
        autoFields.autoCategory == null ||
        autoFields.autoSplitType == null;

      const txn = Transaction.build(
        {
          accountId: account.id,
          importBatch,
          date: v.date,
          merchantRaw: v.merchantRaw,
          merchantClean: v.merchantClean,
          amount: v.amount,
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
        },
        { transaction: t }
      );

      recomputeTransactionAmounts(txn);

      try {
        await txn.save({ transaction: t });
        inserted += 1;
      } catch (e) {
        if (
          e.name === 'SequelizeUniqueConstraintError' ||
          e.name === 'SequelizeBulkRecordError'
        ) {
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

  const out = {
    file: name,
    batchLabel: importBatch,
    inserted,
    skippedDuplicates: skippedDup,
    rowErrors,
    contentHash,
  };
  if (inserted === 0 && rowErrors > 0) {
    out.warning =
      'No rows imported — check CSV columns (Date, Description, Amount) and the selected profile, or date format.';
  } else if (inserted === 0 && rowErrors === 0 && records.length === 0) {
    out.warning =
      'No data rows found — is the file empty or header-only?';
  } else if (inserted === 0 && skippedDup > 0 && rowErrors === 0) {
    out.warning =
      'Every row matched an existing transaction (duplicate) — nothing new to add.';
  }
  return out;
}

/**
 * @param {{ profileId?: string }} [options]
 */
async function runImport(options = {}) {
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

module.exports = { runImport, importCsvFile, resolveAccount };
