import { Op, QueryTypes } from 'sequelize';
import { sequelize, Account, Transaction } from '../models';

export interface IntegrityResult {
  duplicateGroups: { count: number; extraRowCount: number };
  unenrichedTransactions: number;
  orphanedTransactions: number;
  generatedAt: string;
}

export async function integrity(householdId: number): Promise<IntegrityResult> {
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

  type DupeRow = { groups: string; extras: string };
  const placeholders = accountIds.map((_, i) => `:id${i}`).join(', ');
  const replacements: Record<string, unknown> = {};
  accountIds.forEach((id, i) => { replacements[`id${i}`] = id; });
  const [dupe] = await sequelize.query<DupeRow>(
    `SELECT COUNT(*)::text AS groups, COALESCE(SUM(extras), 0)::text AS extras FROM (
       SELECT source_identity_fingerprint, COUNT(*) - 1 AS extras
       FROM transactions
       WHERE account_id IN (${placeholders})
         AND source_identity_fingerprint IS NOT NULL
       GROUP BY source_identity_fingerprint
       HAVING COUNT(*) > 1
     ) g`,
    {
      type: QueryTypes.SELECT,
      replacements,
    },
  );

  const unenriched = await Transaction.count({
    where: { accountId: { [Op.in]: accountIds }, merchantCanonical: null },
  });

  type OrphanRow = { n: string };
  const [orphan] = await sequelize.query<OrphanRow>(
    `SELECT COUNT(*)::text AS n FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE a.id IS NULL`,
    { type: QueryTypes.SELECT },
  );

  return {
    duplicateGroups: {
      count: Number(dupe?.groups ?? 0),
      extraRowCount: Number(dupe?.extras ?? 0),
    },
    unenrichedTransactions: unenriched,
    orphanedTransactions: Number(orphan?.n ?? 0),
    generatedAt: new Date().toISOString(),
  };
}
