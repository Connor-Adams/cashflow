/**
 * Account merge service (issue #287).
 *
 * Provides transactional merge operation: source account is marked
 * merged_into_id, all child records reassigned to target, single atomic
 * transaction ensures consistency.
 */

import { Account, Transaction, PlannedEvent, sequelize } from '../models';

export interface MergeError {
  code:
    | 'SAME_ID'
    | 'SOURCE_NOT_FOUND'
    | 'TARGET_NOT_FOUND'
    | 'CURRENCY_MISMATCH'
    | 'TARGET_NOT_MERGEABLE'
    | 'SOURCE_ALREADY_MERGED';
  sourceCurrency?: string;
  targetCurrency?: string;
}

export interface MergeSuccess {
  ok: true;
  source: Account;
  target: Account;
  movedTransactions: number;
}

export interface MergeFailure {
  ok: false;
  error: MergeError;
}

export type MergeResult = MergeSuccess | MergeFailure;

/**
 * Filter clause for GET /api/accounts: exclude merged-source rows.
 * Used in accounts.ts: `where: { ...visibleAccountWhere(req), ...mergedAccountFilter(...) }`
 */
export function mergedAccountFilter(
  includeMerged: boolean
): Record<string, any> {
  if (includeMerged) {
    return {}; // No filter; include all
  }
  return {
    mergedIntoId: null, // Exclude rows where merged_into_id IS NOT NULL
  };
}

/**
 * Merge source account into target account.
 *
 * Validates:
 *   - Source and target are different IDs
 *   - Both belong to the same household
 *   - Currencies match
 *   - Target is not itself merged
 *   - Source is not already merged
 *
 * If valid, reassigns in a single transaction:
 *   - All transactions.account_id from source to target
 *   - All planned_events.account_id from source to target
 *   - (Future: subscriptions, recurring, etc.)
 *   - source.merged_into_id = target.id
 *   - source.merged_at = now
 *
 * Returns success with counts or error with code.
 */
export async function mergeAccounts(
  householdId: number,
  sourceId: number,
  targetId: number
): Promise<MergeResult> {
  // Validation: different IDs
  if (sourceId === targetId) {
    return {
      ok: false,
      error: { code: 'SAME_ID' },
    };
  }

  // Fetch both accounts
  const source = await Account.findOne({
    where: { id: sourceId, householdId },
  });
  if (!source) {
    return {
      ok: false,
      error: { code: 'SOURCE_NOT_FOUND' },
    };
  }

  const target = await Account.findOne({
    where: { id: targetId, householdId },
  });
  if (!target) {
    return {
      ok: false,
      error: { code: 'TARGET_NOT_FOUND' },
    };
  }

  // Validation: currencies match
  if (source.defaultCurrency !== target.defaultCurrency) {
    return {
      ok: false,
      error: {
        code: 'CURRENCY_MISMATCH',
        sourceCurrency: source.defaultCurrency || undefined,
        targetCurrency: target.defaultCurrency || undefined,
      },
    };
  }

  // Validation: target is not merged
  if (target.mergedIntoId !== null && target.mergedIntoId !== undefined) {
    return {
      ok: false,
      error: { code: 'TARGET_NOT_MERGEABLE' },
    };
  }

  // Validation: source is not already merged
  if (source.mergedIntoId !== null && source.mergedIntoId !== undefined) {
    return {
      ok: false,
      error: { code: 'SOURCE_ALREADY_MERGED' },
    };
  }

  // All validations passed; perform transactional merge
  try {
    let movedTransactions = 0;

    await sequelize.transaction(async (transaction) => {
      // Reassign transactions
      const transactionResult = await Transaction.update(
        { accountId: targetId },
        {
          where: { accountId: sourceId },
          transaction,
        }
      );
      movedTransactions = transactionResult[0]; // Update returns [count, rows]

      // Reassign planned events
      await PlannedEvent.update(
        { accountId: targetId },
        {
          where: { accountId: sourceId },
          transaction,
        }
      );

      // Mark source as merged
      source.mergedIntoId = targetId;
      source.mergedAt = new Date();
      await source.save({ transaction });
    });

    // Refresh both accounts from DB to return updated state
    const updatedSource = (await Account.findByPk(sourceId)) as Account;
    const updatedTarget = (await Account.findByPk(targetId)) as Account;

    return {
      ok: true,
      source: updatedSource,
      target: updatedTarget,
      movedTransactions,
    };
  } catch (err) {
    // Transaction rolled back automatically; return generic error
    throw err;
  }
}
