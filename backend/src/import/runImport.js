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
 * @param {{ profileId?: string }} [options]
 */
async function runImport(options = {}) {
  const profileId = options.profileId || process.env.CSV_PROFILE_ID || 'generic_simple';
  const uploadDir = env.csvUploadDir;
  await fs.mkdir(uploadDir, { recursive: true });

  const rules = await loadAllRules(sequelize);
  const files = (await fs.readdir(uploadDir)).filter((f) =>
    f.toLowerCase().endsWith('.csv')
  );

  const results = [];

  for (const name of files) {
    const fullPath = path.join(uploadDir, name);
    assertUnderRoot(uploadDir, fullPath);

    const buf = await fs.readFile(fullPath);
    const contentHash = hashContent(buf);

    const prior = await ImportHistory.findOne({
      where: { contentHash, status: 'success' },
    });
    if (prior) {
      results.push({
        file: name,
        skipped: true,
        reason: 'already_imported',
        contentHash,
      });
      continue;
    }

    const meta = parseStatementFilename(name);
    const startedAt = new Date();
    if (!meta) {
      await ImportHistory.create({
        fileName: name,
        filePathSafe: name,
        contentHash,
        batchLabel: 'invalid-filename',
        status: 'failed',
        rowCount: 0,
        errorMessage:
          'Filename must match CardName_YYYY_MM.csv (e.g. Amex_2025_01.csv)',
        startedAt,
        finishedAt: new Date(),
      });
      results.push({ file: name, skipped: true, reason: 'bad_filename' });
      continue;
    }

    const account = await resolveAccount(meta.cardToken);
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
      results.push({ file: name, skipped: true, reason: 'unknown_account' });
      continue;
    }

    const text = buf.toString('utf8');
    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    const headers = records.length > 0 ? Object.keys(records[0]) : [];

    const defaultCurrency =
      account.defaultCurrency || env.defaultCurrency || 'USD';

    let inserted = 0;
    let skippedDup = 0;
    let rowErrors = 0;

    await sequelize.transaction(async (t) => {
      const importBatch = meta.batchLabel;

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

        let reviewFlag =
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
        rowErrors > 0 && inserted === 0 ? 'failed' : rowErrors > 0 ? 'partial' : 'success';
      const errMsg =
        rowErrors > 0
          ? `${rowErrors} row(s) could not be parsed`
          : null;

      await ImportHistory.create(
        {
          fileName: name,
          filePathSafe: name,
          contentHash,
          batchLabel: meta.batchLabel,
          status,
          rowCount: inserted,
          errorMessage: errMsg,
          startedAt,
          finishedAt: new Date(),
        },
        { transaction: t }
      );
    });

    results.push({
      file: name,
      batchLabel: meta.batchLabel,
      inserted,
      skippedDuplicates: skippedDup,
      rowErrors,
      contentHash,
    });
  }

  return { results, uploadDir };
}

module.exports = { runImport, resolveAccount };
