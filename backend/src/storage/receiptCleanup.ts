import { Op, type Transaction as DbTransaction } from 'sequelize';
import { Receipt } from '../models';
import { deleteReceiptObject } from './receiptStorage';
import { logger } from '../observability/logger';

/**
 * Delete the on-disk / object-store blobs for every Receipt attached to the
 * given transaction ids, BEFORE the transaction rows (and their cascading
 * receipt rows) are destroyed.
 *
 * Why this exists (issue #851): the `Transaction → Receipt` FK is
 * `ON DELETE CASCADE` at the SQL level, so deleting an account / transaction
 * removes the receipt *rows* — but the cascade fires in the database and never
 * runs Sequelize lifecycle hooks, so `deleteReceiptObject` (the only thing that
 * removes the actual file) is never called. The blobs — financial PII, including
 * uploaded ID documents — would otherwise stay readable on disk / in the object
 * store forever after the owning rows are gone.
 *
 * Callers must run this *before* destroying the transactions so the receipt rows
 * still exist to be enumerated. Pass the active Sequelize transaction so the
 * read participates in the same unit of work as the delete.
 *
 * Per-blob deletion failures are swallowed (and logged): a single missing or
 * un-deletable object must not block the row deletion the user requested. The
 * worst case on failure is a leftover blob — the same orphan we are fixing — not
 * a broken delete.
 *
 * @returns the number of receipt rows whose blobs we attempted to delete.
 */
export async function deleteReceiptFilesForTransactions(
  transactionIds: number[],
  options: { transaction?: DbTransaction } = {},
): Promise<number> {
  if (transactionIds.length === 0) return 0;

  const receipts = await Receipt.findAll({
    where: { transactionId: { [Op.in]: transactionIds } },
    attributes: ['id', 'storedFilename'],
    transaction: options.transaction,
  });

  for (const receipt of receipts) {
    try {
      await deleteReceiptObject(receipt.storedFilename);
    } catch (err) {
      logger.warn(
        { err, receiptId: receipt.id, storedFilename: receipt.storedFilename },
        'failed to delete receipt blob during cascade cleanup',
      );
    }
  }

  return receipts.length;
}
