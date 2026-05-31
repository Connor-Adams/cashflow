import { Account, Transaction } from '../models';
import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../db';

export async function getIntegrity(householdId: number) {
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

  // Duplicate groups — use Sequelize ORM for dialect safety
  const dupGroups = await Transaction.findAll({
    where: {
      accountId: { [Op.in]: accountIds },
      sourceIdentityFingerprint: { [Op.not]: null },
    },
    attributes: [
      'sourceIdentityFingerprint',
      [sequelize.fn('COUNT', sequelize.col('id')), 'cnt'],
    ],
    group: ['sourceIdentityFingerprint'],
    having: sequelize.literal('COUNT(id) > 1'),
    raw: true,
  }) as unknown as Array<{ sourceIdentityFingerprint: string; cnt: string }>;

  const dupGroupCount = dupGroups.length;
  const dupExtraCount = dupGroups.reduce((sum, g) => sum + Math.max(0, Number(g.cnt) - 1), 0);

  // Unenriched (merchantCanonical is null)
  const unenriched = await Transaction.count({
    where: { accountId: { [Op.in]: accountIds }, merchantCanonical: null },
  });

  // Orphans — transactions with no matching account
  const orphanResult = await sequelize.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE a.id IS NULL`,
    { type: QueryTypes.SELECT },
  );
  const orphaned = Number(orphanResult[0]?.count ?? 0);

  return {
    duplicateGroups: {
      count: dupGroupCount,
      extraRowCount: dupExtraCount,
    },
    unenrichedTransactions: unenriched,
    orphanedTransactions: orphaned,
    generatedAt: new Date().toISOString(),
  };
}
