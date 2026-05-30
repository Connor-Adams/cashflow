import { QueryTypes } from 'sequelize';
import { sequelize } from '../db';
import { Account } from '../models/Account';

interface DuplicateGroupRow {
  source_identity_fingerprint: string;
  cnt: string | number;
}

interface OrphanRow {
  id: number;
}

export async function buildIntegrity(householdId: number) {
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

  // Duplicate groups: rows sharing the same source_identity_fingerprint
  const dupRows = await sequelize.query<DuplicateGroupRow>(
    `SELECT source_identity_fingerprint, COUNT(*) AS cnt
     FROM transactions
     WHERE account_id IN (:accountIds)
     GROUP BY source_identity_fingerprint
     HAVING COUNT(*) > 1`,
    { type: QueryTypes.SELECT, replacements: { accountIds } },
  );

  const duplicateGroupCount = dupRows.length;
  const extraRowCount = dupRows.reduce((sum, r) => {
    const cnt = typeof r.cnt === 'string' ? parseInt(r.cnt, 10) : r.cnt;
    return sum + (cnt - 1);
  }, 0);

  // Unenriched: transactions with null merchant_canonical
  const unenrichedRows = await sequelize.query<{ cnt: string | number }>(
    `SELECT COUNT(*) AS cnt
     FROM transactions
     WHERE account_id IN (:accountIds)
       AND merchant_canonical IS NULL`,
    { type: QueryTypes.SELECT, replacements: { accountIds } },
  );
  const unenrichedTransactions =
    unenrichedRows.length > 0
      ? typeof unenrichedRows[0].cnt === 'string'
        ? parseInt(unenrichedRows[0].cnt, 10)
        : unenrichedRows[0].cnt
      : 0;

  // Orphaned transactions: account_id not in accounts table
  const orphanRows = await sequelize.query<OrphanRow>(
    `SELECT t.id
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.account_id IN (:accountIds)
       AND a.id IS NULL`,
    { type: QueryTypes.SELECT, replacements: { accountIds } },
  );
  const orphanedTransactions = orphanRows.length;

  return {
    duplicateGroups: { count: duplicateGroupCount, extraRowCount },
    unenrichedTransactions,
    orphanedTransactions,
    generatedAt: new Date().toISOString(),
  };
}
