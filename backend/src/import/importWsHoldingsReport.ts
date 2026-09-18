import crypto from 'node:crypto';
import path from 'node:path';
import { Account } from '../models';
import { commitStatementImport } from './commitStatementImport';
import { parseWsHoldingsReport } from './wsHoldingsReport';
import type { StatementPreview } from './statementTypes';

/**
 * Import Wealthsimple's multi-account holdings report.
 *
 * Every other ingest path in this codebase is one file → one account:
 * `resolvePdfAccountFromHeader` returns a single account, `importWsBundleFile`
 * keys on a single filename WSID, and `commitStatementImport` takes a preview
 * carrying one `accountId`. Wealthsimple's holdings report covers every account
 * at once, so it needs a splitter above that layer.
 *
 * The split is the only new idea here: one `StatementPreview` per account,
 * each committed through the existing pipeline. Nothing downstream changes, so
 * holdings land with the same dedup, batch labelling and import-history
 * behaviour as any other import.
 *
 * Accounts are matched on `Account.shortCode` = the WSID in the report. An
 * unmatched WSID is REPORTED, never auto-created: an investment account created
 * blind would carry no entity, no tax status and no currency, and silently
 * collecting snapshots against it would be worse than saying nothing landed.
 */

export interface WsHoldingsAccountResult {
  wsid: string;
  accountLabel: string;
  accountId: number | null;
  insertedHoldings: number;
  skippedDuplicates: number;
  /** Set when no account carries this WSID as its shortCode. */
  unmatched?: true;
}

export interface WsHoldingsImportResult {
  file: string;
  statementDate: string | null;
  accounts: WsHoldingsAccountResult[];
  parseErrors: { rowIndex: number; message: string }[];
}

export async function importWsHoldingsReport(opts: {
  buffer: Buffer;
  fileName: string;
  householdId: number;
  userId: number;
}): Promise<WsHoldingsImportResult> {
  const file = path.basename(opts.fileName || 'holdings-report.csv').replace(/[\\/]/g, '');
  const text = opts.buffer.toString('utf8');
  const report = parseWsHoldingsReport(text);
  if (report.statementDate == null) {
    return { file, statementDate: null, accounts: [], parseErrors: report.parseErrors };
  }

  const contentHash = crypto.createHash('sha256').update(opts.buffer).digest('hex');
  // One label for the whole report, so every account's rows are traceable to
  // the same upload in import history.
  const importBatch = `${report.statementDate} holdings`;

  const accounts: WsHoldingsAccountResult[] = [];
  for (const slice of report.slices) {
    const account = await Account.findOne({
      where: { householdId: opts.householdId, shortCode: slice.wsid },
    });
    if (!account) {
      accounts.push({
        wsid: slice.wsid,
        accountLabel: slice.accountLabel,
        accountId: null,
        insertedHoldings: 0,
        skippedDuplicates: 0,
        unmatched: true,
      });
      continue;
    }

    const preview: StatementPreview = {
      // Scoped per account: the preview token and content hash are how import
      // history distinguishes the slices of one upload.
      previewToken: crypto.randomUUID(),
      fileName: file,
      contentHash: `${contentHash}:${slice.wsid}`,
      accountId: account.id,
      householdId: opts.householdId,
      importBatch,
      usedParser: 'csv',
      transactions: [],
      investmentActivities: [],
      holdings: slice.holdings,
      warnings: [],
      rowErrors: 0,
      parseErrors: [],
      // Dedup is decided downstream by the unique index on
      // (account_id, source_row_fingerprint); nothing is pre-marked here.
      duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
    };

    const committed = await commitStatementImport(preview, opts.userId, opts.householdId);
    accounts.push({
      wsid: slice.wsid,
      accountLabel: slice.accountLabel,
      accountId: account.id,
      insertedHoldings: committed.insertedHoldings,
      skippedDuplicates: committed.skippedDuplicates,
    });
  }

  return { file, statementDate: report.statementDate, accounts, parseErrors: report.parseErrors };
}
