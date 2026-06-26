/**
 * Right-to-erasure: permanently delete a household and every member user, all
 * household-scoped financial data, and the on-disk files those rows point at
 * (issue #850 — GDPR/CCPA right-to-erasure).
 *
 * WHY THIS IS NOT JUST `Household.destroy()`
 * ------------------------------------------
 * Most household-scoped tables carry a DB-level `household_id` FK with
 * `ON DELETE CASCADE`, so deleting the `households` row removes them on
 * Postgres. But several tables were created with a `household_id` column and
 * NO foreign key at all — a raw household delete would silently ORPHAN them
 * (PII left behind, which is exactly what right-to-erasure forbids):
 *
 *   securities, tax_entities, tax_tags, merchant_embeddings, audit_log,
 *   finance_events, account_statements, transaction_revisions
 *
 * (`sync_backups` is also no-FK but was *intentionally* retained for
 * diagnostics — for erasure we must purge it too: it can carry user_id and a
 * snapshot of household data.)
 *
 * Member-user personal data (sessions, email/SimpleFIN integrations, capture/
 * reporting/audit tokens, push subscriptions, notifications, saved searches,
 * cashflow settings, data exports …) cascade off `users.id`, so destroying the
 * member `User` rows removes them.
 *
 * On-disk files (vault docs, receipts, data-export ZIPs) are not DB rows, so
 * their filenames are collected BEFORE the rows are deleted, and the files are
 * swept AFTER the DB transaction commits (a mid-transaction file delete can't
 * be rolled back, so we never delete a file until the rows are truly gone).
 *
 * Everything DB-side runs in ONE transaction: either the whole household is
 * erased or nothing is.
 */
import { Op, type Transaction as DbTransaction } from 'sequelize';
import {
  AccountStatement,
  AuditLog,
  Entity,
  FinanceEvent,
  Household,
  HouseholdMember,
  MerchantEmbedding,
  Receipt,
  Security,
  SyncBackup,
  TaxTag,
  Transaction,
  TransactionRevision,
  User,
  VaultDocument,
  sequelize,
} from '../models';
import { deleteReceiptObject } from '../storage/receiptStorage';
import { deleteVaultObject } from '../storage/vaultStorage';
import { getExportsDir } from '../config/dataExports';
import { logger } from '../observability/logger';
import fs from 'fs/promises';
import path from 'path';

export interface EraseHouseholdResult {
  householdId: number;
  deletedUserIds: number[];
  /** Counts of files we attempted to delete (best-effort, post-commit). */
  filesSwept: { vault: number; receipts: number; exports: number };
}

/**
 * Permanently erase a household and all of its members. Throws if the
 * household does not exist. Caller is responsible for authorization
 * (owner-gating) and for clearing the caller's session cookie afterward.
 */
export async function eraseHousehold(householdId: number): Promise<EraseHouseholdResult> {
  // 1. Collect the file references and member user ids BEFORE deleting rows.
  const household = await Household.findByPk(householdId);
  if (!household) {
    const err = new Error('Household not found') as Error & { status?: number };
    err.status = 404;
    throw err;
  }

  const members = await HouseholdMember.findAll({ where: { householdId } });
  const userIds = members.map((m) => m.userId);

  const vaultDocs = await VaultDocument.findAll({
    where: { householdId },
    attributes: ['storedFilename'],
  });
  const vaultFilenames = vaultDocs
    .map((d) => d.storedFilename)
    .filter((f): f is string => Boolean(f));

  // Receipts have no household_id — they hang off the household's transactions.
  const txnIds = (
    await Transaction.findAll({ where: { householdId }, attributes: ['id'] })
  ).map((t) => t.id);
  const receiptFilenames =
    txnIds.length > 0
      ? (
          await Receipt.findAll({
            where: { transactionId: { [Op.in]: txnIds } },
            attributes: ['storedFilename'],
          })
        )
          .map((r) => r.storedFilename)
          .filter((f): f is string => Boolean(f))
      : [];

  // 2. Delete every DB row in one transaction. Explicitly purge the no-FK
  //    household-scoped tables, then the FK-backed cascade via Household, then
  //    the member users (their personal data cascades off users.id).
  await sequelize.transaction(async (t: DbTransaction) => {
    // No-FK household-scoped tables (would orphan on a naive household delete).
    // NOTE: tax_entities (Entity) is deliberately NOT purged here — it must be
    // deleted AFTER the Household cascade below. accounts.entity_id /
    // transactions.entity_id are NOT NULL FKs to tax_entities with ON DELETE
    // SET NULL (see migrations 20260618000001 / 20260619000001); SET NULL is
    // incompatible with NOT NULL, so deleting a tax_entities row while any
    // account/transaction still references it raises a FK violation ("reassign
    // the accounts first"). The Household cascade removes accounts/transactions,
    // clearing every reference, so Entity.destroy is safe only once that's done.
    await Security.destroy({ where: { householdId }, transaction: t });
    await TaxTag.destroy({ where: { householdId }, transaction: t });
    await MerchantEmbedding.destroy({ where: { householdId }, transaction: t });
    await AuditLog.destroy({ where: { householdId }, transaction: t });
    await FinanceEvent.destroy({ where: { householdId }, transaction: t });
    await AccountStatement.destroy({ where: { householdId }, transaction: t });
    await SyncBackup.destroy({ where: { householdId }, transaction: t });
    if (txnIds.length > 0) {
      await TransactionRevision.destroy({
        where: { transactionId: { [Op.in]: txnIds } },
        transaction: t,
      });
    }

    // FK-backed household-scoped data (accounts, transactions, receipts, rules,
    // budgets, goals, contacts, vault docs, …) cascades from the household row.
    await Household.destroy({ where: { id: householdId }, transaction: t });

    // Now that accounts/transactions are gone, no rows reference tax_entities,
    // so purging the (no-FK to household) tax_entities rows can't violate the
    // entity_id FK. Must run AFTER the Household cascade above.
    await Entity.destroy({ where: { householdId }, transaction: t });

    // Member users + all user-scoped personal data (sessions, integrations,
    // tokens, push, notifications, settings, exports …) cascade off users.id.
    if (userIds.length > 0) {
      await User.destroy({ where: { id: { [Op.in]: userIds } }, transaction: t });
    }
  });

  // 3. Sweep on-disk files AFTER the commit. Best-effort: a missing file must
  //    not fail the erasure (the row — the thing that made it discoverable — is
  //    already gone).
  for (const filename of vaultFilenames) {
    try {
      await deleteVaultObject(filename);
    } catch (err) {
      logger.warn({ err, filename, householdId }, 'erase_household_vault_file_unlink_failed');
    }
  }
  for (const filename of receiptFilenames) {
    try {
      await deleteReceiptObject(filename);
    } catch (err) {
      logger.warn({ err, filename, householdId }, 'erase_household_receipt_file_unlink_failed');
    }
  }

  // Data-export ZIPs live under getExportsDir()/<userId>/; drop each user's dir.
  let exportsSwept = 0;
  if (userIds.length > 0) {
    const exportsDir = getExportsDir();
    for (const userId of userIds) {
      try {
        await fs.rm(path.join(exportsDir, String(userId)), {
          recursive: true,
          force: true,
        });
        exportsSwept += 1;
      } catch (err) {
        logger.warn({ err, userId, householdId }, 'erase_household_export_dir_unlink_failed');
      }
    }
    // The DataExport rows already cascaded with the users (FK on user_id).
  }

  logger.info(
    {
      householdId,
      deletedUserIds: userIds,
      vaultFiles: vaultFilenames.length,
      receiptFiles: receiptFilenames.length,
      exportDirs: exportsSwept,
    },
    'erase_household_complete'
  );

  return {
    householdId,
    deletedUserIds: userIds,
    filesSwept: {
      vault: vaultFilenames.length,
      receipts: receiptFilenames.length,
      exports: exportsSwept,
    },
  };
}
