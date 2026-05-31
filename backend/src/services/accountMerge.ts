import { Transaction as Txn } from 'sequelize';
import { Account, Transaction, PlannedEvent, sequelize } from '../models';

export type MergeResult = {
  movedTransactions: number;
  movedPlannedEvents: number;
  source: Account;
  target: Account;
};

export async function mergeAccounts(
  sourceId: number,
  targetId: number,
  householdId: number,
): Promise<MergeResult> {
  if (sourceId === targetId) {
    const err = new Error('Source and target must be different accounts') as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'SAME_ID';
    throw err;
  }

  const [source, target] = await Promise.all([
    Account.findOne({ where: { id: sourceId, householdId } }),
    Account.findOne({ where: { id: targetId, householdId } }),
  ]);

  if (!source || !target) {
    const err = new Error('Account not found or not in scope') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  if (source.mergedIntoId != null) {
    const err = new Error('Source account has already been merged') as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'SOURCE_ALREADY_MERGED';
    throw err;
  }

  if (target.mergedIntoId != null) {
    const err = new Error('Target account has already been merged into another account') as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'TARGET_NOT_MERGEABLE';
    throw err;
  }

  const sourceCurrency = source.defaultCurrency ?? 'CAD';
  const targetCurrency = target.defaultCurrency ?? 'CAD';
  if (sourceCurrency !== targetCurrency) {
    const err = new Error(
      `Accounts must be in the same currency. Source: ${sourceCurrency}; Target: ${targetCurrency}.`,
    ) as Error & { status?: number; code?: string };
    err.status = 400;
    err.code = 'CURRENCY_MISMATCH';
    throw err;
  }

  return sequelize.transaction(async (t: Txn) => {
    const [movedTransactions] = await Transaction.update(
      { accountId: targetId } as Partial<Transaction>,
      { where: { accountId: sourceId }, transaction: t },
    );

    const [movedPlannedEvents] = await PlannedEvent.update(
      { accountId: targetId } as Partial<PlannedEvent>,
      { where: { accountId: sourceId }, transaction: t },
    );

    await source.update({ mergedIntoId: targetId, mergedAt: new Date() }, { transaction: t });

    await target.reload({ transaction: t });

    return { movedTransactions, movedPlannedEvents, source, target };
  });
}
