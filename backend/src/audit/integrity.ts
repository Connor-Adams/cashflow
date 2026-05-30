import { Op, QueryTypes } from 'sequelize';
import { Account, Transaction, sequelize } from '../models';

export async function integrity(householdId: number) {
  // Get all account IDs for this household
  const accounts = await Account.findAll({
    where: { householdId },
    attributes: ['id'],
  });
  const accountIds = accounts.map((a) => a.id);

  if (accountIds.length === 0) {
    return {
      duplicateGroups: { count: 0, extraRowCount: 0 },
      unenrichedTransactions: 0,
      orphanedTransactions: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  // Duplicate groups
  const dupeResult = await sequelize.query<{ groups: string; extras: string }>(
    `SELECT COUNT(*) AS groups, COALESCE(SUM(extras), 0) AS extras FROM (
      SELECT source_identity_fingerprint, COUNT(*) - 1 AS extras
      FROM transactions
      WHERE account_id IN (${accountIds.join(',')})
        AND source_identity_fingerprint IS NOT NULL
      GROUP BY source_identity_fingerprint
      HAVING COUNT(*) > 1
    ) g`,
    { type: QueryTypes.SELECT },
  );
  const dupeRow = dupeResult[0] ?? { groups: '0', extras: '0' };

  // Unenriched (merchantCanonical is null)
  const unenriched = await Transaction.count({
    where: { accountId: { [Op.in]: accountIds }, merchantCanonical: { [Op.is]: null } },
  });

  // Orphaned transactions (should always be 0 under FK constraints)
  const orphanResult = await sequelize.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE a.id IS NULL`,
    { type: QueryTypes.SELECT },
  );
  const orphaned = parseInt(orphanResult[0]?.count ?? '0', 10);

  return {
    duplicateGroups: {
      count: parseInt(dupeRow.groups, 10),
      extraRowCount: parseInt(dupeRow.extras, 10),
    },
    unenrichedTransactions: unenriched,
    orphanedTransactions: orphaned,
    generatedAt: new Date().toISOString(),
  };
}
