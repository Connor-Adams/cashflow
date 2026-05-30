import { QueryTypes } from 'sequelize';
import { sequelize, Account, Transaction } from '../models';

export interface IntegrityResult {
  duplicateGroups: { count: number; extraRowCount: number };
  unenrichedTransactions: number;
  orphanedTransactions: number;
  generatedAt: string;
}

export async function getIntegrity(householdId: number): Promise<IntegrityResult> {
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

  const placeholders = accountIds.map((_, i) => `$${i + 1}`).join(',');

  const [dupRow] = await sequelize.query<{ groups: string; extras: string }>(
    `SELECT COUNT(*)::int AS groups, COALESCE(SUM(extras)::bigint, 0)::int AS extras FROM (
      SELECT source_identity_fingerprint, COUNT(*) - 1 AS extras
      FROM transactions
      WHERE account_id IN (${placeholders})
        AND source_identity_fingerprint IS NOT NULL
      GROUP BY source_identity_fingerprint
      HAVING COUNT(*) > 1
    ) g`,
    { bind: accountIds, type: QueryTypes.SELECT },
  );

  const unenriched = await Transaction.count({
    where: { householdId, merchantCanonical: null },
  });

  const [orphanRow] = await sequelize.query<{ cnt: string }>(
    `SELECT COUNT(*)::int AS cnt FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE a.id IS NULL`,
    { type: QueryTypes.SELECT },
  );

  return {
    duplicateGroups: {
      count: Number(dupRow?.groups ?? 0),
      extraRowCount: Number(dupRow?.extras ?? 0),
    },
    unenrichedTransactions: unenriched,
    orphanedTransactions: Number(orphanRow?.cnt ?? 0),
    generatedAt: new Date().toISOString(),
  };
}
