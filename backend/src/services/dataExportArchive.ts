/**
 * Data export archive service (issue #302).
 *
 * Builds a ZIP containing one JSON file per major model scoped to the user's
 * household, plus transactions.csv and a meta.json manifest, and a README.txt.
 *
 * The ZIP is written to `<exportsDir>/<userId>/<exportId>.zip` and the
 * function returns metadata about the file (storage key, byte size).
 *
 * All queries are scoped by `userId`/`householdId` — user A's export never
 * includes user B's rows (AC #13).
 */
import fs from 'fs/promises';
import path from 'path';
import archiver from 'archiver';
import { createWriteStream, createReadStream } from 'fs';
import { QueryTypes } from 'sequelize';

import { sequelize } from '../db';
import { getExportsDir } from '../config/dataExports';
import { logger } from '../observability/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function queryAll(sql: string, replacements: Record<string, unknown>): Promise<unknown[]> {
  return sequelize.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
  });
}

// ---------------------------------------------------------------------------
// README text
// ---------------------------------------------------------------------------

const README = `Cashflow — Full Data Export
===========================

This archive contains a snapshot of all data Cashflow stores for your account.

Files included
--------------
  meta.json           – Export metadata (date, userId, record counts).
  accounts.json       – All bank/credit/investment accounts.
  transactions.json   – All transactions (JSON with all fields).
  transactions.csv    – Transactions in spreadsheet-friendly CSV format.
  rules.json          – Auto-categorisation rules.
  budgets.json        – Budget targets and exclusions.
  labels.json         – Label tags (categories).
  planned_events.json – Planned income/expense events.
  recurring.json      – Recurring transaction patterns.
  subscriptions.json  – Detected subscription services.
  receipts.json       – Receipt metadata (no binary images in v1).
  notes.json          – Inline notes on transactions.
  preferences.json    – Your app preferences.
  chat_threads.json   – AI assistant conversation threads.
  chat_messages.json  – Messages within those threads.
  holdings.json       – Investment holdings snapshots.
  securities.json     – Security master data.
  dividends.json      – Dividend records.

Notes
-----
- This export represents a point-in-time snapshot.
- Binary receipt images are not included in v1.
- Re-import / restore is not yet supported.
- Export expires 7 days after creation.
`;

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCsv(val: unknown): string {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const header = headers.join(',');
  const lines = rows.map((r) => headers.map((h) => escapeCsv(r[h])).join(','));
  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export interface ArchiveResult {
  /** Relative path under exportsDir, suitable for storing in `storage_key`. */
  storageKey: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Byte size of the ZIP. */
  byteSize: number;
}

export async function buildDataExportArchive(
  userId: number,
  householdId: number,
  exportId: number,
): Promise<ArchiveResult> {
  const exportsDir = getExportsDir();
  const userDir = path.join(exportsDir, String(userId));
  await fs.mkdir(userDir, { recursive: true });

  const filename = `export-${exportId}.zip`;
  const absolutePath = path.join(userDir, filename);
  const storageKey = path.join(String(userId), filename);

  // Collect all data in parallel.
  const [
    accounts,
    transactions,
    rules,
    budgets,
    labels,
    plannedEvents,
    recurring,
    subscriptions,
    receipts,
    chatThreads,
    chatMessages,
    holdings,
    securities,
    dividends,
    preferences,
  ] = await Promise.all([
    queryAll(
      `SELECT * FROM accounts WHERE household_id = :householdId ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM transactions WHERE household_id = :householdId ORDER BY date DESC, id DESC`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM rules WHERE household_id = :householdId ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM budget_targets WHERE household_id = :householdId ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM categories WHERE household_id = :householdId ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM planned_events WHERE household_id = :householdId ORDER BY id`,
      { householdId },
    ),
    // recurring — inferred from transaction signals; store transaction-level
    queryAll(
      `SELECT * FROM transactions WHERE household_id = :householdId AND is_recurring = TRUE ORDER BY date DESC, id DESC`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM subscriptions WHERE household_id = :householdId ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT id, transaction_id, original_name, content_type, byte_size, created_at, updated_at
         FROM receipts
        WHERE transaction_id IN (
          SELECT id FROM transactions WHERE household_id = :householdId
        )
        ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM chat_threads WHERE household_id = :householdId ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM chat_messages WHERE thread_id IN (
         SELECT id FROM chat_threads WHERE household_id = :householdId
       ) ORDER BY id`,
      { householdId },
    ),
    queryAll(
      `SELECT hs.* FROM holding_snapshots hs
        JOIN accounts a ON a.id = hs.account_id
       WHERE a.household_id = :householdId
       ORDER BY hs.id`,
      { householdId },
    ),
    // securities referenced by this household's holdings
    queryAll(
      `SELECT DISTINCT s.* FROM securities s
        JOIN holding_snapshots hs ON hs.security_id = s.id
        JOIN accounts a ON a.id = hs.account_id
       WHERE a.household_id = :householdId
       ORDER BY s.id`,
      { householdId },
    ),
    queryAll(
      `SELECT sd.* FROM security_dividends sd
        JOIN securities s ON s.id = sd.security_id
        JOIN holding_snapshots hs ON hs.security_id = s.id
        JOIN accounts a ON a.id = hs.account_id
       WHERE a.household_id = :householdId
       ORDER BY sd.id`,
      { householdId },
    ),
    queryAll(
      `SELECT * FROM cashflow_settings WHERE user_id = :userId ORDER BY id`,
      { userId },
    ),
  ]);

  // notes = transactions with a non-null notes field
  const notes = (transactions as Record<string, unknown>[]).filter(
    (t) => t.notes != null,
  );

  const exportedAt = new Date().toISOString();

  const meta = {
    exportedAt,
    userId,
    householdId,
    version: 1,
    modelCounts: {
      accounts: accounts.length,
      transactions: transactions.length,
      rules: rules.length,
      budgets: budgets.length,
      labels: labels.length,
      plannedEvents: plannedEvents.length,
      subscriptions: subscriptions.length,
      receipts: receipts.length,
      chatThreads: chatThreads.length,
      chatMessages: chatMessages.length,
      holdings: holdings.length,
      securities: securities.length,
      dividends: dividends.length,
      notes: notes.length,
    },
  };

  // Build ZIP.
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(absolutePath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    const addJson = (name: string, data: unknown): void => {
      const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
      archive.append(buf, { name });
    };

    addJson('meta.json', meta);
    addJson('accounts.json', accounts);
    addJson('transactions.json', transactions);
    addJson('rules.json', rules);
    addJson('budgets.json', budgets);
    addJson('labels.json', labels);
    addJson('planned_events.json', plannedEvents);
    addJson('recurring.json', recurring);
    addJson('subscriptions.json', subscriptions);
    addJson('receipts.json', receipts);
    addJson('notes.json', notes);
    addJson('preferences.json', preferences);
    addJson('chat_threads.json', chatThreads);
    addJson('chat_messages.json', chatMessages);
    addJson('holdings.json', holdings);
    addJson('securities.json', securities);
    addJson('dividends.json', dividends);

    // transactions.csv — only key columns for spreadsheet portability
    const txCsv = rowsToCsv(
      (transactions as Record<string, unknown>[]).map((t) => ({
        id: t.id,
        date: t.date,
        merchant: t.merchant_clean ?? t.merchantClean,
        amount: t.amount,
        currency: t.currency,
        category: t.final_category ?? t.finalCategory,
        notes: t.notes,
        account_id: t.account_id ?? t.accountId,
        import_batch: t.import_batch ?? t.importBatch,
      })),
    );
    archive.append(Buffer.from(txCsv, 'utf8'), { name: 'transactions.csv' });
    archive.append(Buffer.from(README, 'utf8'), { name: 'README.txt' });

    void archive.finalize();
  });

  const stat = await fs.stat(absolutePath);
  const byteSize = stat.size;

  logger.info(
    { userId, householdId, exportId, byteSize, storageKey },
    'data_export_archive_built',
  );

  return { storageKey, absolutePath, byteSize };
}

/**
 * Delete the physical ZIP file for an export, if it exists.
 * Silently ignores ENOENT (already deleted / never created).
 */
export async function deleteExportFile(storageKey: string): Promise<void> {
  const exportsDir = getExportsDir();
  const absolutePath = path.join(exportsDir, storageKey);
  try {
    await fs.unlink(absolutePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Return a readable stream for an export file.
 */
export function openExportStream(storageKey: string): ReturnType<typeof createReadStream> {
  const exportsDir = getExportsDir();
  const absolutePath = path.join(exportsDir, storageKey);
  return createReadStream(absolutePath);
}
