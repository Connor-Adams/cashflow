import crypto from 'node:crypto';
import path from 'node:path';
import { Account } from '../models';
import { commitStatementImport } from './commitStatementImport';
import { parseWsActivityStatement } from './pdf/wsActivityStatement';
import type { StatementPreview } from './statementTypes';

/**
 * Import Wealthsimple's multi-account Custom Activity Statement.
 *
 * Same split as the holdings report — one `StatementPreview` per account,
 * committed through the existing pipeline — but carrying investment
 * activities rather than position snapshots. This is the only remaining
 * source of buys, sells, dividends and interest, and therefore the only input
 * to ACB, capital gains and investment income.
 *
 * Accounts match on `Account.shortCode` = the WSID printed beside each section
 * heading. An unmatched WSID is reported rather than auto-created, for the
 * same reason as holdings: an account conjured without entity, tax status or
 * currency silently collects rows that then compute wrong.
 */

export interface WsActivityAccountResult {
  wsid: string;
  accountLabel: string;
  accountId: number | null;
  insertedActivities: number;
  skippedDuplicates: number;
  unmatched?: true;
}

export interface WsActivityImportResult {
  file: string;
  accounts: WsActivityAccountResult[];
  parseErrors: { rowIndex: number; message: string }[];
}

export async function importWsActivityStatement(opts: {
  buffer: Buffer;
  fileName: string;
  householdId: number;
  userId: number;
}): Promise<WsActivityImportResult> {
  const file = path.basename(opts.fileName || 'activity-statement.pdf').replace(/[\\/]/g, '');

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { extractPdfLines } = require('./pdf/extractLines');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const lines = await extractPdfLines(opts.buffer);
  const parsed = parseWsActivityStatement(lines);

  const contentHash = crypto.createHash('sha256').update(opts.buffer).digest('hex');
  const importBatch = `${file.replace(/\.pdf$/i, '')} activity`;

  const accounts: WsActivityAccountResult[] = [];
  for (const slice of parsed.slices) {
    const account = await Account.findOne({
      where: { householdId: opts.householdId, shortCode: slice.wsid },
    });
    if (!account) {
      accounts.push({
        wsid: slice.wsid,
        accountLabel: slice.accountLabel,
        accountId: null,
        insertedActivities: 0,
        skippedDuplicates: 0,
        unmatched: true,
      });
      continue;
    }
    // A section can legitimately be empty — "No activities were recorded for
    // this account during the specified period."
    if (slice.activities.length === 0) {
      accounts.push({
        wsid: slice.wsid,
        accountLabel: slice.accountLabel,
        accountId: account.id,
        insertedActivities: 0,
        skippedDuplicates: 0,
      });
      continue;
    }

    const preview: StatementPreview = {
      previewToken: crypto.randomUUID(),
      fileName: file,
      contentHash: `${contentHash}:${slice.wsid}`,
      accountId: account.id,
      householdId: opts.householdId,
      importBatch,
      usedParser: 'pdf',
      transactions: [],
      investmentActivities: slice.activities,
      holdings: [],
      warnings: [],
      rowErrors: 0,
      parseErrors: [],
      duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
    };

    const committed = await commitStatementImport(preview, opts.userId, opts.householdId);
    accounts.push({
      wsid: slice.wsid,
      accountLabel: slice.accountLabel,
      accountId: account.id,
      insertedActivities: committed.insertedInvestmentActivities,
      skippedDuplicates: committed.skippedDuplicates,
    });
  }

  return { file, accounts, parseErrors: parsed.parseErrors };
}
