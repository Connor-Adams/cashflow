/**
 * Data export archive builder (issue #302).
 *
 * Queries all user-owned / household-scoped data and writes a single
 * gzip-compressed JSON file to disk. The format is:
 *   { meta, accounts, transactions, rules, budgets, labels, plannedEvents, preferences }
 *
 * No third-party ZIP library is required; we use Node's built-in zlib pipeline.
 * The output file is stored at {STORAGE_DIR}/exports/{exportId}.json.gz where
 * STORAGE_DIR defaults to /tmp/cashflow-exports.
 */
import { createWriteStream, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import {
  Account,
  Transaction,
  Rule,
  BudgetTarget,
  Label,
  PlannedEvent,
  CashflowSettings,
} from '../models';

export interface ArchiveResult {
  storagePath: string;
  byteSize: number;
}

function storageDir(): string {
  return process.env.STORAGE_DIR ?? '/tmp/cashflow-exports';
}

/**
 * Build the gzip-compressed JSON export archive for a user.
 *
 * @param userId       The user whose data to export.
 * @param householdId  The user's current household (null if the user has no
 *                     household — in that case only user-scoped data is included).
 * @param exportId     Row id used to name the output file on disk.
 */
export async function buildExportArchive(
  userId: number,
  householdId: number | null,
  exportId: number,
): Promise<ArchiveResult> {
  const dir = join(storageDir(), 'exports');
  mkdirSync(dir, { recursive: true });

  const storagePath = join(dir, `${exportId}.json.gz`);

  // ----- Collect data -------------------------------------------------------

  const hhFilter = householdId != null ? { householdId } : {};

  const [accounts, transactions, rules, budgets, labels, plannedEvents, preferences] =
    await Promise.all([
      Account.findAll({ where: hhFilter }),
      Transaction.findAll({
        where: hhFilter,
        order: [['date', 'DESC']],
        limit: 50_000, // safety cap; users can re-export for older data
      }),
      Rule.findAll({ where: hhFilter }),
      BudgetTarget.findAll({ where: hhFilter }),
      Label.findAll({ where: hhFilter }),
      PlannedEvent.findAll({ where: { userId } }),
      CashflowSettings.findOne({ where: { userId } }),
    ]);

  const meta = {
    exportedAt: new Date().toISOString(),
    userId,
    householdId,
    version: '1.0',
    modelCounts: {
      accounts: accounts.length,
      transactions: transactions.length,
      rules: rules.length,
      budgets: budgets.length,
      labels: labels.length,
      plannedEvents: plannedEvents.length,
    },
  };

  const payload = JSON.stringify({
    meta,
    accounts: accounts.map((r) => r.toJSON()),
    transactions: transactions.map((r) => r.toJSON()),
    rules: rules.map((r) => r.toJSON()),
    budgets: budgets.map((r) => r.toJSON()),
    labels: labels.map((r) => r.toJSON()),
    plannedEvents: plannedEvents.map((r) => r.toJSON()),
    preferences: preferences ? preferences.toJSON() : null,
  });

  // ----- Write compressed file ----------------------------------------------

  const readable = Readable.from([payload]);
  const gzip = createGzip({ level: 6 });
  const dest = createWriteStream(storagePath);

  await pipeline(readable, gzip, dest);

  const byteSize = statSync(storagePath).size;

  return { storagePath, byteSize };
}

/**
 * Delete the archive file for a given storage key (absolute path).
 * Swallows ENOENT — the file may have already been removed.
 */
export function deleteArchiveFile(storagePath: string): void {
  try {
    unlinkSync(storagePath);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
}
