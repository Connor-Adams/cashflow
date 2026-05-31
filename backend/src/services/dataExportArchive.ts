/**
 * Creates a ZIP archive of all user data for the data export feature (#302).
 * Uses the `archiver` library.
 */
import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
import {
  Account,
  Transaction,
  Rule,
  BudgetTarget,
  Label,
  PlannedEvent,
  Subscription,
  HoldingSnapshot,
  Security,
  SecurityDividend,
  IncomeEntry,
} from '../models';
import * as env from '../config/env';

const README_CONTENT = `Cashflow Data Export
====================

This archive contains a snapshot of all data stored by Cashflow for your user account.

Files included:
  meta.json           — Export metadata (date, user ID, row counts)
  accounts.json       — Your accounts
  transactions.json   — All transactions
  transactions.csv    — Transactions in CSV format (spreadsheet-friendly)
  rules.json          — Categorisation rules
  budgets.json        — Budget targets
  labels.json         — Custom labels
  planned_events.json — Planned income/expense events
  subscriptions.json  — Detected recurring subscriptions
  securities.json     — Portfolio securities
  holdings.json       — Holdings snapshots
  dividends.json      — Dividend history
  income.json         — Manually logged income entries

To re-import this data into Cashflow, use the Import page.
For more information, see the documentation.
`;

export interface ArchiveResult {
  storagePath: string;
  byteSize: number;
}

function txnToCsv(txns: Transaction[]): string {
  const headers = ['id', 'date', 'merchant', 'amount', 'currency', 'category', 'notes', 'import_batch'];
  const lines = [headers.join(',')];
  for (const t of txns) {
    lines.push([
      t.id, t.date, t.merchantClean, t.amount, t.currency,
      t.finalCategory ?? '', t.notes ?? '', t.importBatch,
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

export async function createUserDataExport(userId: number, exportId: number): Promise<ArchiveResult> {
  await fs.promises.mkdir(env.exportDir, { recursive: true });
  const filePath = path.join(env.exportDir, `export-${exportId}-user-${userId}.zip`);

  // Fetch all data scoped to this user
  const [accounts, transactions, rules, budgets, labels, plannedEvents, subscriptions] =
    await Promise.all([
      Account.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
      Transaction.findAll({ where: { householdId: await getUserHouseholdId(userId) }, order: [['date', 'DESC']] }),
      Rule.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
      BudgetTarget.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
      Label.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
      PlannedEvent.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
      Subscription.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
    ]);

  const [securities, holdings, dividends, incomeEntries] = await Promise.all([
    Security.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
    HoldingSnapshot.findAll({ where: { householdId: await getUserHouseholdId(userId) } }),
    SecurityDividend.findAll({
      include: [{ model: Security, as: 'security', where: { householdId: await getUserHouseholdId(userId) }, required: true }],
    }),
    IncomeEntry.findAll({ where: { userId }, order: [['occurredOn', 'DESC']] }),
  ]);

  const meta = {
    exportedAt: new Date().toISOString(),
    userId,
    version: 1,
    modelCounts: {
      accounts: accounts.length,
      transactions: transactions.length,
      rules: rules.length,
      budgets: budgets.length,
      labels: labels.length,
      plannedEvents: plannedEvents.length,
      subscriptions: subscriptions.length,
      securities: securities.length,
      holdings: holdings.length,
      dividends: dividends.length,
      incomeEntries: incomeEntries.length,
    },
  };

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    archive.append(README_CONTENT, { name: 'README.txt' });
    archive.append(JSON.stringify(meta, null, 2), { name: 'meta.json' });
    archive.append(JSON.stringify(accounts.map((a) => a.toJSON()), null, 2), { name: 'accounts.json' });
    archive.append(JSON.stringify(transactions.map((t) => t.toJSON()), null, 2), { name: 'transactions.json' });
    archive.append(txnToCsv(transactions), { name: 'transactions.csv' });
    archive.append(JSON.stringify(rules.map((r) => r.toJSON()), null, 2), { name: 'rules.json' });
    archive.append(JSON.stringify(budgets.map((b) => b.toJSON()), null, 2), { name: 'budgets.json' });
    archive.append(JSON.stringify(labels.map((l) => l.toJSON()), null, 2), { name: 'labels.json' });
    archive.append(JSON.stringify(plannedEvents.map((e) => e.toJSON()), null, 2), { name: 'planned_events.json' });
    archive.append(JSON.stringify(subscriptions.map((s) => s.toJSON()), null, 2), { name: 'subscriptions.json' });
    archive.append(JSON.stringify(securities.map((s) => s.toJSON()), null, 2), { name: 'securities.json' });
    archive.append(JSON.stringify(holdings.map((h) => h.toJSON()), null, 2), { name: 'holdings.json' });
    archive.append(JSON.stringify(dividends.map((d) => d.toJSON()), null, 2), { name: 'dividends.json' });
    archive.append(JSON.stringify(incomeEntries.map((i) => i.toJSON()), null, 2), { name: 'income.json' });

    void archive.finalize();
  });

  const stat = await fs.promises.stat(filePath);
  return { storagePath: filePath, byteSize: stat.size };
}

// Cache household ID lookups within a single export run
const hhCache = new Map<number, number>();
async function getUserHouseholdId(userId: number): Promise<number> {
  if (hhCache.has(userId)) return hhCache.get(userId)!;
  const { HouseholdMember } = await import('../models');
  const member = await HouseholdMember.findOne({ where: { userId }, attributes: ['householdId'] });
  const hhId = member?.householdId ?? 0;
  hhCache.set(userId, hhId);
  return hhId;
}

export async function deleteExportFile(storageKey: string): Promise<void> {
  try {
    await fs.promises.unlink(storageKey);
  } catch {
    // File may already be gone
  }
}
