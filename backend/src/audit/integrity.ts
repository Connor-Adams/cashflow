import { QueryTypes } from 'sequelize';
import { Op } from 'sequelize';
import { sequelize } from '../db';
import { Account, Transaction } from '../models/index';

export type IntegrityResult = {
  duplicateGroups: { count: number; extraRowCount: number };
  unenrichedTransactions: number;
  orphanedTransactions: number;
  generatedAt: string;
};

export async function buildIntegrity(householdId: number): Promise<IntegrityResult> {
  const accounts = await Account.findAll({ where: { householdId }, attributes: ['id'] });
  const accountIds = accounts.map((a) => a.id);

  if (accountIds.length === 0) {
    return {
      duplicateGroups: { count: 0, extraRowCount: 0 },
      unenrichedTransactions: 0,
      orphanedTransactions: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const [dupeRows, unenriched, orphanRows] = await Promise.all([
    sequelize.query<{ groups: string; extras: string }>(
      `SELECT COUNT(*) AS groups, COALESCE(SUM(extras), 0) AS extras FROM (
         SELECT source_identity_fingerprint, COUNT(*) - 1 AS extras
         FROM transactions
         WHERE account_id = ANY($1::integer[])
           AND source_identity_fingerprint IS NOT NULL
         GROUP BY source_identity_fingerprint
         HAVING COUNT(*) > 1
       ) g`,
      { bind: [accountIds], type: QueryTypes.SELECT },
    ),
    Transaction.count({
      where: { accountId: { [Op.in]: accountIds }, merchantCanonical: null },
    }),
    sequelize.query<{ count: string }>(
      `SELECT COUNT(*) FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE a.id IS NULL`,
      { type: QueryTypes.SELECT },
    ),
  ]);

  const dupeRow = dupeRows[0] ?? { groups: '0', extras: '0' };
  const orphanRow = orphanRows[0] as unknown as { count: string };

  return {
    duplicateGroups: {
      count: parseInt(dupeRow.groups, 10) || 0,
      extraRowCount: parseInt(dupeRow.extras, 10) || 0,
    },
    unenrichedTransactions: unenriched,
    orphanedTransactions: parseInt(orphanRow?.count ?? '0', 10) || 0,
    generatedAt: new Date().toISOString(),
  };
}
