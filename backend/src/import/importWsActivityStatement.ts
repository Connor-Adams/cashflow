import crypto from 'node:crypto';
import path from 'node:path';
import { Account } from '../models';
import { commitStatementImport } from './commitStatementImport';
import { parseWsActivityStatement } from './pdf/wsActivityStatement';
import type { PdfLine } from './pdf/types';
import type { StatementPreview } from './statementTypes';
import { normalizeMerchant } from './normalizeMerchant';

/**
 * Activity types that cross the account boundary and therefore need a cash leg.
 * A bare `transfer` is excluded — `CONT` maps to it and a contribution is not
 * unambiguously a crossing; buys, sells and dividends settle inside the account.
 */
const CASH_CROSSING_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'transfer_in', 'transfer_out', 'cash_movement',
]);

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
 *
 * Takes already-extracted PDF lines rather than a buffer: the route owns the
 * IO, this owns the splitting and committing.
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
  lines: PdfLine[];
  fileName: string;
  /** Hash of the uploaded bytes, used to scope each account's preview. */
  contentHash: string;
  householdId: number;
  userId: number;
}): Promise<WsActivityImportResult> {
  const file = path.basename(opts.fileName || 'activity-statement.pdf').replace(/[\\/]/g, '');
  const parsed = parseWsActivityStatement(opts.lines);
  const { contentHash } = opts;
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
      // A cash crossing is two things: an event in the account's own ledger, and
      // money entering or leaving the entity. This path used to emit only the
      // first, which is how a $15,000 owner draw never reached the tax engine —
      // it reads `transactions`. The mirror's type is stamped authoritative
      // because the narrative detector matches "transfer out of the account" and
      // not "transfer into the account", so the symmetric case would never link.
      transactions: slice.activities
        // `security === null` matters as much as the activity type: an in-kind
        // share transfer is `transfer_in` too, and a cash leg for it would be
        // money that never moved. A null amount is a parse anomaly — skip the row
        // rather than minting a $0 transaction for it.
        .flatMap((a) => (
          a.security === null
          && a.amount != null
          && CASH_CROSSING_ACTIVITY_TYPES.has(a.activityType)
            ? [a as typeof a & { amount: number }]
            : []
        ))
        .map((a) => ({
          date: a.tradeDate,
          merchantRaw: a.description,
          merchantClean: normalizeMerchant(a.description),
          amount: a.amount,
          currency: a.currency,
          sourceReference: null,
          overrideTxnType: 'transfer' as const,
          // Derived from the activity's own fingerprint, so the mirror is stable
          // across re-imports and dedups rather than doubling.
          sourceRowFingerprint: `${a.sourceRowFingerprint}:cash`,
        })),
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
