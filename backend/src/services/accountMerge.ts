import { Account, sequelize } from '../models';

export type MergeError =
  | 'SAME_ID'
  | 'CURRENCY_MISMATCH'
  | 'SOURCE_ALREADY_MERGED'
  | 'TARGET_NOT_MERGEABLE';

export type MergeResult = {
  movedTransactions: number;
  movedInvestmentActivities: number;
  movedHoldingsSnapshots: number;
  movedPlannedEvents: number;
};

export type MergeOutcome =
  | { ok: true; result: MergeResult }
  | { ok: false; error: MergeError };

/**
 * Merge sourceId account into targetId account within the given household.
 *
 * Validates ownership, currency parity, and merge-state before executing a
 * single Sequelize transaction that re-parents all child rows and tombstones
 * the source account.
 */
export async function mergeAccounts(
  sourceId: number,
  targetId: number,
  householdId: number
): Promise<MergeOutcome> {
  // --- Validation -----------------------------------------------------------
  if (sourceId === targetId) {
    return { ok: false, error: 'SAME_ID' };
  }

  const [source, target] = await Promise.all([
    Account.findOne({ where: { id: sourceId, householdId } }),
    Account.findOne({ where: { id: targetId, householdId } }),
  ]);

  if (!source || !target) {
    // Either account doesn't belong to this household.
    // The route layer returns 404 in this case.
    return { ok: false, error: 'SOURCE_ALREADY_MERGED' };
  }

  if (source.mergedIntoId != null) {
    return { ok: false, error: 'SOURCE_ALREADY_MERGED' };
  }

  if (target.mergedIntoId != null) {
    return { ok: false, error: 'TARGET_NOT_MERGEABLE' };
  }

  const sourceCurrency = (source.defaultCurrency ?? 'CAD').toUpperCase();
  const targetCurrency = (target.defaultCurrency ?? 'CAD').toUpperCase();
  if (sourceCurrency !== targetCurrency) {
    return { ok: false, error: 'CURRENCY_MISMATCH' };
  }

  // --- Transactional merge --------------------------------------------------
  let movedTransactions = 0;
  let movedInvestmentActivities = 0;
  let movedHoldingsSnapshots = 0;
  let movedPlannedEvents = 0;

  await sequelize.transaction(async (t) => {
    // Re-parent transactions
    const [txCount] = await sequelize.query(
      `UPDATE transactions SET account_id = :targetId WHERE account_id = :sourceId`,
      { replacements: { targetId, sourceId }, transaction: t }
    );
    movedTransactions = typeof txCount === 'number' ? txCount : 0;

    // Re-parent investment activities
    const [iaCount] = await sequelize.query(
      `UPDATE investment_activities SET account_id = :targetId WHERE account_id = :sourceId`,
      { replacements: { targetId, sourceId }, transaction: t }
    );
    movedInvestmentActivities = typeof iaCount === 'number' ? iaCount : 0;

    // Re-parent holdings snapshots
    const [hsCount] = await sequelize.query(
      `UPDATE holdings_snapshots SET account_id = :targetId WHERE account_id = :sourceId`,
      { replacements: { targetId, sourceId }, transaction: t }
    );
    movedHoldingsSnapshots = typeof hsCount === 'number' ? hsCount : 0;

    // Re-parent planned events
    const [peCount] = await sequelize.query(
      `UPDATE planned_events SET account_id = :targetId WHERE account_id = :sourceId`,
      { replacements: { targetId, sourceId }, transaction: t }
    );
    movedPlannedEvents = typeof peCount === 'number' ? peCount : 0;

    // Tombstone the source account
    await sequelize.query(
      `UPDATE accounts SET merged_into_id = :targetId, merged_at = NOW() WHERE id = :sourceId`,
      { replacements: { targetId, sourceId }, transaction: t }
    );
  });

  return {
    ok: true,
    result: {
      movedTransactions,
      movedInvestmentActivities,
      movedHoldingsSnapshots,
      movedPlannedEvents,
    },
  };
}
