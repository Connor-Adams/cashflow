import { Transaction as SequelizeTransaction } from 'sequelize';
import { Account, IncomeEntry, InvestmentActivity, PlannedEvent, Transaction, sequelize } from '../models';

export interface MergeResult {
  movedTransactions: number;
  movedPlannedEvents: number;
  movedIncomeEntries: number;
  movedInvestmentActivities: number;
  source: Account;
  target: Account;
}

/**
 * Merge sourceId into targetId in a single DB transaction.
 * Reassigns all rows pointing at source to target, then marks source as merged.
 */
export async function mergeAccounts(
  sourceId: number,
  targetId: number,
  householdId: number,
): Promise<MergeResult> {
  if (sourceId === targetId) {
    throw Object.assign(new Error('Source and target must be different accounts.'), { code: 'SAME_ID' });
  }

  const [source, target] = await Promise.all([
    Account.findOne({ where: { id: sourceId, householdId } }),
    Account.findOne({ where: { id: targetId, householdId } }),
  ]);

  if (!source || !target) {
    throw Object.assign(new Error('Account not found.'), { code: 'NOT_FOUND' });
  }
  if (source.mergedIntoId != null) {
    throw Object.assign(new Error('This account has already been merged.'), { code: 'SOURCE_ALREADY_MERGED' });
  }
  if (target.mergedIntoId != null) {
    throw Object.assign(new Error(`${target.name} has already been merged into another account.`), { code: 'TARGET_NOT_MERGEABLE' });
  }

  const srcCurrency = (source.defaultCurrency ?? 'CAD').toUpperCase();
  const tgtCurrency = (target.defaultCurrency ?? 'CAD').toUpperCase();
  if (srcCurrency !== tgtCurrency) {
    throw Object.assign(
      new Error(`Accounts must be in the same currency. Source: ${srcCurrency}; Target: ${tgtCurrency}.`),
      { code: 'CURRENCY_MISMATCH' },
    );
  }

  let movedTransactions = 0;
  let movedPlannedEvents = 0;
  let movedIncomeEntries = 0;
  let movedInvestmentActivities = 0;

  await sequelize.transaction(async (t: SequelizeTransaction) => {
    const [txnResult] = await Transaction.update(
      { accountId: targetId },
      { where: { accountId: sourceId }, transaction: t },
    );
    movedTransactions = txnResult;

    const [peResult] = await PlannedEvent.update(
      { accountId: targetId },
      { where: { accountId: sourceId }, transaction: t },
    );
    movedPlannedEvents = peResult;

    const [ieResult] = await IncomeEntry.update(
      { accountId: targetId },
      { where: { accountId: sourceId }, transaction: t },
    );
    movedIncomeEntries = ieResult;

    const [iaResult] = await InvestmentActivity.update(
      { accountId: targetId },
      { where: { accountId: sourceId }, transaction: t },
    );
    movedInvestmentActivities = iaResult;

    await source.update(
      { mergedIntoId: targetId, mergedAt: new Date() },
      { transaction: t },
    );
  });

  // Reload target so caller has fresh state
  await target.reload();

  return { movedTransactions, movedPlannedEvents, movedIncomeEntries, movedInvestmentActivities, source, target };
}
