import { Op, QueryTypes } from 'sequelize';
import { Account, Transaction } from '../models';
import { sequelize } from '../db';

export type IntegrityResult = {
  duplicateGroups: { count: number; extraRowCount: number };
  unenrichedTransactions: number;
  orphanedTransactions: number;
  generatedAt: string;
};

export async function runIntegrity(householdId: number): Promise<IntegrityResult> {
  const accounts = await Account.findAll({
    where: { householdId },
    attributes: ['id'],
  });

  if (accounts.length === 0) {
    return {
      duplicateGroups: { count: 0, extraRowCount: 0 },
      unenrichedTransactions: 0,
      orphanedTransactions: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const accountIds = accounts.map((a) => a.id);

  const [dupeRows, unenriched, orphanRows] = await Promise.all([
    sequelize.query<{ groups: string; extras: string }>(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(extras), 0) AS extras FROM (
        SELECT source_identity_fingerprint, COUNT(*) - 1 AS extras
        FROM transactions
        WHERE account_id IN (:accountIds)
          AND source_identity_fingerprint IS NOT NULL
        GROUP BY source_identity_fingerprint
        HAVING COUNT(*) > 1
      ) g`,
      { replacements: { accountIds }, type: QueryTypes.SELECT }
    ),
    Transaction.count({
      where: {
        accountId: { [Op.in]: accountIds },
        merchantCanonical: { [Op.is]: null },
      },
    }),
    sequelize.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE a.id IS NULL`,
      { type: QueryTypes.SELECT }
    ),
  ]);

  const dupeRow = dupeRows[0] as { groups: string; extras: string } | undefined;

  return {
    duplicateGroups: {
      count: dupeRow ? Number(dupeRow.groups) : 0,
      extraRowCount: dupeRow ? Number(dupeRow.extras) : 0,
    },
    unenrichedTransactions: unenriched,
    orphanedTransactions: orphanRows[0] ? Number((orphanRows[0] as { cnt: string }).cnt) : 0,
    generatedAt: new Date().toISOString(),
  };
}
