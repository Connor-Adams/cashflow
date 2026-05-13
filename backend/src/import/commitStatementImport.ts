import { Op } from 'sequelize';
import type { Transaction as SequelizeTransaction } from 'sequelize';
import {
  Account,
  HoldingSnapshot,
  ImportHistory,
  InvestmentActivity,
  Security,
  Transaction,
  sequelize,
} from '../models';
import { applyRuleToAuto, findBestRule, loadAllRules } from './applyRules';
import { recomputeTransactionAmounts } from './calculateShares';
import { findMerchantMemory, merchantMemoryToAutoFields } from '../ai/merchantMemory';
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

async function findOrCreateSecurity(
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
): Promise<'inserted' | 'duplicate'> {
  const security = row.security
    ? await findOrCreateSecurity(row.security, account.householdId, t)
    : null;
  try {
    await InvestmentActivity.create(
      {
        accountId: account.id,
        householdId: account.householdId,
        securityId: security?.id ?? null,
        activityType: row.activityType,
        tradeDate: row.tradeDate,
        settlementDate: row.settlementDate,
        description: row.description,
        quantity: row.quantity == null ? null : String(row.quantity),
        price: row.price == null ? null : String(row.price),
        amount: row.amount == null ? null : String(row.amount),
        fees: row.fees == null ? null : String(row.fees),
        currency: row.currency,
        sourceReference: row.sourceReference,
        sourceRowFingerprint: row.sourceRowFingerprint,
        importBatch: preview.importBatch,
      },
      { transaction: t }
    );
    return 'inserted';
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
  try {
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
        sourceReference: row.sourceReference,
        sourceRowFingerprint: row.sourceRowFingerprint,
        importBatch: preview.importBatch,
      },
      { transaction: t }
    );
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
  let insertedTransactions = 0;
  let insertedInvestmentActivities = 0;
  let insertedHoldings = 0;
  let skippedDuplicates = 0;

  await sequelize.transaction(async (t) => {
    for (const row of preview.transactions) {
      const { rule, ambiguous } = findBestRule(rules, row.merchantClean);
      const memory = !rule || ambiguous
        ? await findMerchantMemory(account.householdId, row.merchantClean)
        : null;
      const autoFields =
        rule && !ambiguous
          ? applyRuleToAuto(rule)
          : memory
            ? merchantMemoryToAutoFields(memory)
            : {
                autoCategory: null as string | null,
                autoBusiness: null as boolean | null,
                autoSplitType: null as string | null,
                autoPctMe: null as string | null,
                autoPctPartner: null as string | null,
              };
      const txn = Transaction.build({
        accountId: account.id,
        householdId: account.householdId,
        createdByUserId: userId ?? account.ownerUserId,
        visibility: account.visibility === 'shared' ? 'shared' : 'private',
        ownershipType:
          autoFields.autoSplitType === 'partner' || autoFields.autoSplitType === 'shared'
            ? autoFields.autoSplitType
            : 'me',
        ownershipContactId: null,
        importBatch: preview.importBatch,
        date: row.date,
        merchantRaw: row.merchantRaw,
        merchantClean: row.merchantClean,
        amount: String(row.amount),
        currency: row.currency,
        notes: memory
          ? `Auto-categorized from ${memory.supportCount} previous ${memory.merchantClean} transaction${memory.supportCount === 1 ? '' : 's'}.`
          : null,
        sourceReference: row.sourceReference,
        sourceRowFingerprint: row.sourceRowFingerprint,
        appliedRuleId: rule && !ambiguous ? rule.id : null,
        ...autoFields,
        categoryOverride: null,
        businessOverride: null,
        splitOverride: null,
        pctMeOverride: null,
        pctPartnerOverride: null,
        reviewFlag: true,
        reviewedAt: null,
      });
      recomputeTransactionAmounts(txn);
      try {
        await txn.save({ transaction: t });
        insertedTransactions += 1;
      } catch (e) {
        if (isUniqueLike(e)) skippedDuplicates += 1;
        else throw e;
      }
    }

    for (const row of preview.investmentActivities) {
      const status = await createInvestmentActivity(row, account, preview, t);
      if (status === 'inserted') insertedInvestmentActivities += 1;
      else skippedDuplicates += 1;
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
