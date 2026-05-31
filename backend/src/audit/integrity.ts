import { Op, QueryTypes } from 'sequelize';
import { sequelize } from '../db';
import { Account, Transaction } from '../models';

export interface IntegrityResult {
  duplicateGroups: { count: number; extraRowCount: number };
  unenrichedTransactions: number;
  orphanedTransactions: number;
  generatedAt: string;
}

export async function integrity(householdId: number): Promise<IntegrityResult> {
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

  type DupeRow = { groups: string; extras: string };
  const [dupeRows, unenriched, orphanRows] = await Promise.all([
    sequelize.query<DupeRow>(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(extras), 0) AS extras FROM (
        SELECT source_identity_fingerprint, COUNT(*) - 1 AS extras
        FROM transactions
        WHERE account_id IN (:accountIds)
          AND source_identity_fingerprint IS NOT NULL
          AND source_identity_fingerprint != ''
        GROUP BY source_identity_fingerprint
        HAVING COUNT(*) > 1
      ) g`,
      { type: QueryTypes.SELECT, replacements: { accountIds } },
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
      { type: QueryTypes.SELECT },
    ),
  ]);

  const dupeCount = Number(dupeRows[0]?.groups ?? 0);
  const extraCount = Number(dupeRows[0]?.extras ?? 0);
  const orphanCount = Number(orphanRows[0]?.cnt ?? 0);

  return {
    duplicateGroups: { count: dupeCount, extraRowCount: extraCount },
    unenrichedTransactions: unenriched,
    orphanedTransactions: orphanCount,
    generatedAt: new Date().toISOString(),
  };
}
