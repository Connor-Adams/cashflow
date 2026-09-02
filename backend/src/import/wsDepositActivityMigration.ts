/**
 * Wealthsimple deposit-account activity cleanup.
 *
 * WS Cash / Chequing / Save statements share the brokerage layout, and until
 * the routing fix their rows were filed as `investment_activities` instead of
 * `transactions`. Two import runs then left the ledger in two states at once:
 *
 *   SHADOW  an activity whose event a transaction ALREADY records, with better
 *           merchant text ("Withdrawal (executed at 2025-03-17)" beside
 *           "Pre-authorized Debit to AMEX BILL PYMT"). Redundant → delete.
 *   ORPHAN  an activity with no transaction at all. A real cash event missing
 *           from the ledger → convert to a transaction.
 *
 * Pairing is on (accountId, date, amount, currency), 1:1 by position. The
 * merchant text deliberately plays no part: the whole point is that the two
 * sources word the same event differently, so matching on it would find
 * nothing. In prod no such key occurs twice on either side, so every pairing
 * is unambiguous — but the positional pass keeps it correct if one ever does.
 *
 * Orphans are inserted through `commitStatementImport` rather than a raw
 * INSERT, so they get the same enrichment, dedup, fingerprints and
 * ImportHistory provenance as any imported row — and so the narrative detector
 * gets to classify them (an orphaned "Pre-authorized Debit to AMEX BILL PYMT"
 * lands as `payment`, not `transfer`).
 *
 * Idempotent, and self-healing if it dies midway. The insert runs before the
 * delete, so a crash in between leaves converted orphans still present as
 * activities — on the next run they now MATCH the transactions just created,
 * are reclassified as shadows, and get deleted. Re-running is always safe.
 */
import { Op } from 'sequelize';
import { Account, InvestmentActivity, Transaction } from '../models';
import { commitStatementImport } from './commitStatementImport';
import { rowFingerprint } from './fingerprint';
import { normalizeMerchant } from './normalizeMerchant';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';
import type { TxnType } from './enrichment/types';

const DEPOSIT_ACCOUNT_TYPES = new Set(['checking', 'savings']);

/**
 * Activity type → the TxnType the converted transaction should carry. Supplied
 * as a HINT, so a narrative the detector actually recognizes still wins. Money
 * moving between the owner's own accounts is `transfer`, which keeps it out of
 * spend totals; interest on a deposit balance is income and `interest` is not
 * in safeToSpend's excluded set.
 */
const ACTIVITY_TXN_TYPE: Record<string, TxnType> = {
  cash_movement: 'transfer',
  transfer: 'transfer',
  transfer_in: 'transfer',
  transfer_out: 'transfer',
  interest: 'interest',
};

export type ShadowRow = {
  activityId: number;
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  activityType: string;
  description: string;
  transactionId: number;
  transactionMerchantRaw: string;
};

export type OrphanRow = {
  activityId: number;
  accountId: number;
  householdId: number | null;
  date: string;
  amount: number;
  currency: string;
  activityType: string;
  description: string;
  txnType: TxnType | undefined;
};

export type SkippedRow = {
  activityId: number;
  accountId: number;
  reason: string;
};

export type Classification = {
  shadows: ShadowRow[];
  orphans: OrphanRow[];
  skipped: SkippedRow[];
};

function money(raw: unknown): number {
  return Number(Number(raw ?? 0).toFixed(4));
}

function dateOnly(raw: unknown): string {
  return String(raw ?? '').slice(0, 10);
}

function pairKey(accountId: number, date: string, amount: number, currency: string): string {
  return `${accountId}|${date}|${amount.toFixed(4)}|${String(currency || 'CAD').toUpperCase()}`;
}

async function loadDepositAccounts(accountIds: number[]): Promise<Account[]> {
  const accounts = await Account.findAll({ where: { id: { [Op.in]: accountIds } } });
  const found = new Set(accounts.map((a) => a.id));
  const missing = accountIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`No account with id ${missing.join(', ')}`);
  }
  const wrong = accounts.filter((a) => !DEPOSIT_ACCOUNT_TYPES.has(String(a.accountType)));
  if (wrong.length > 0) {
    // Refuse rather than silently skip: this cleanup deletes rows, and running
    // it against a brokerage account would be a request to destroy real
    // investment activity.
    throw new Error(
      `Account ${wrong.map((a) => `${a.id} (${a.name}, ${a.accountType})`).join('; ')} ` +
        'is not a deposit account — this cleanup only applies to checking/savings.',
    );
  }
  return accounts;
}

type TxnIndexEntry = { id: number; merchantRaw: string };

/**
 * Transactions bucketed by pair key, in id order, so activities claim them
 * deterministically and each transaction is claimed at most once.
 */
function buildTransactionIndex(transactions: Transaction[]): Map<string, TxnIndexEntry[]> {
  const index = new Map<string, TxnIndexEntry[]>();
  for (const t of transactions) {
    const key = pairKey(t.accountId, dateOnly(t.date), money(t.amount), String(t.currency));
    const entry = { id: t.id as number, merchantRaw: String(t.merchantRaw ?? '') };
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}

/** The shape shared by both classifications, read off one activity row. */
function activityFields(a: InvestmentActivity): {
  activityId: number;
  accountId: number;
  date: string;
  amount: number;
  currency: string;
  activityType: string;
  description: string;
} {
  return {
    activityId: a.id as number,
    accountId: a.accountId as number,
    date: dateOnly(a.tradeDate),
    amount: money(a.amount),
    currency: String(a.currency ?? 'CAD'),
    activityType: String(a.activityType),
    description: String(a.description ?? ''),
  };
}

/**
 * Take the next unclaimed transaction for this key, or null when every
 * transaction at that (account, date, amount, currency) has already been
 * claimed by an earlier activity. Claiming is what makes the pairing 1:1.
 */
function claimTransaction(
  index: Map<string, TxnIndexEntry[]>,
  consumed: Map<string, number>,
  key: string,
): TxnIndexEntry | null {
  const bucket = index.get(key);
  if (!bucket) return null;
  const next = consumed.get(key) ?? 0;
  if (next >= bucket.length) return null;
  consumed.set(key, next + 1);
  return bucket[next];
}

function partitionActivities(
  cashRows: InvestmentActivity[],
  index: Map<string, TxnIndexEntry[]>,
  householdByAccount: Map<number, number | null>,
): { shadows: ShadowRow[]; orphans: OrphanRow[] } {
  const shadows: ShadowRow[] = [];
  const orphans: OrphanRow[] = [];
  const consumed = new Map<string, number>();

  for (const a of cashRows) {
    const f = activityFields(a);
    const claimed = claimTransaction(
      index,
      consumed,
      pairKey(f.accountId, f.date, f.amount, f.currency),
    );
    if (claimed) {
      shadows.push({
        ...f,
        transactionId: claimed.id,
        transactionMerchantRaw: claimed.merchantRaw,
      });
    } else {
      orphans.push({
        ...f,
        householdId: householdByAccount.get(f.accountId) ?? null,
        txnType: ACTIVITY_TXN_TYPE[f.activityType],
      });
    }
  }
  return { shadows, orphans };
}

/**
 * Split every activity row on the given deposit accounts into shadows (a
 * transaction already records it), orphans (nothing does), and skipped (rows
 * that carry a security and are therefore not cash events at all).
 */
export async function classifyWsDepositActivities(
  accountIds: number[],
): Promise<Classification> {
  if (accountIds.length === 0) return { shadows: [], orphans: [], skipped: [] };
  const accounts = await loadDepositAccounts(accountIds);
  const householdByAccount = new Map(accounts.map((a) => [a.id, a.householdId ?? null]));

  const activities = await InvestmentActivity.findAll({
    where: { accountId: { [Op.in]: accountIds } },
    order: [['id', 'ASC']],
  });
  const index = buildTransactionIndex(
    await Transaction.findAll({
      where: { accountId: { [Op.in]: accountIds } },
      order: [['id', 'ASC']],
    }),
  );

  // A security-bearing row is not a cash event: neither delete it nor flatten
  // it to a transaction, which would lose the security.
  const skipped: SkippedRow[] = activities
    .filter((a) => a.securityId != null)
    .map((a) => ({
      activityId: a.id as number,
      accountId: a.accountId as number,
      reason: 'carries a security — not a cash event',
    }));
  const cashRows = activities.filter((a) => a.securityId == null);

  return { ...partitionActivities(cashRows, index, householdByAccount), skipped };
}

export type MigrationReport = Classification & {
  deletedShadows: number;
  insertedTransactions: number;
  skippedDuplicates: number;
  dryRun: boolean;
};

function orphanToRow(o: OrphanRow): NormalizedCashTransaction {
  return {
    date: o.date,
    merchantRaw: o.description,
    merchantClean: normalizeMerchant(o.description),
    amount: o.amount,
    currency: o.currency,
    sourceReference: null,
    sourceRowFingerprint: rowFingerprint({
      accountId: o.accountId,
      date: o.date,
      amount: o.amount,
      currency: o.currency,
      merchantRaw: o.description,
      sourceReference: null,
    }),
    // A hint, not an override: the WS activity type says which way the money
    // went, and the description may say something more specific.
    ...(o.txnType ? { txnTypeHint: o.txnType } : {}),
  };
}

/**
 * One account's orphans as a statement preview. `contentHash` is derived from
 * the exact set of rows being converted, so re-running with the same set is
 * recognized as an already-applied import while a run covering a different set
 * is not.
 */
function cleanupPreview(
  accountId: number,
  householdId: number | null,
  orphans: OrphanRow[],
): StatementPreview {
  const ids = orphans.map((o) => o.activityId).sort((a, b) => a - b);
  return {
    previewToken: `ws-deposit-cleanup-${accountId}`,
    fileName: 'ws-deposit-activity-cleanup',
    contentHash: `ws-deposit-cleanup:${accountId}:${ids.join(',')}`,
    accountId,
    householdId,
    importBatch: 'WS deposit ledger cleanup',
    usedParser: 'pdf',
    transactions: orphans.map(orphanToRow),
    investmentActivities: [],
    holdings: [],
    warnings: [],
    rowErrors: 0,
    parseErrors: [],
    duplicateCounts: { transactions: 0, investmentActivities: 0, holdings: 0 },
  };
}

/**
 * Insert one commit per account — `commitStatementImport` is account-scoped.
 * Runs BEFORE the delete, so an interrupted run leaves converted orphans still
 * present as activities and the next run reclassifies them as shadows.
 */
async function insertOrphans(
  accountIds: number[],
  orphans: OrphanRow[],
  userId: number | null,
): Promise<{ inserted: number; deduped: number }> {
  let inserted = 0;
  let deduped = 0;
  for (const accountId of accountIds) {
    const mine = orphans.filter((o) => o.accountId === accountId);
    if (mine.length === 0) continue;
    const householdId = mine[0].householdId;
    const result = await commitStatementImport(
      cleanupPreview(accountId, householdId, mine),
      userId,
      householdId,
    );
    inserted += result.insertedTransactions;
    deduped += result.skippedDuplicates;
  }
  return { inserted, deduped };
}

/**
 * Delete the shadow rows and convert the orphans into transactions.
 *
 * `dryRun` reports exactly what would happen and writes nothing.
 */
export async function migrateWsDepositActivities(opts: {
  accountIds: number[];
  userId: number | null;
  dryRun?: boolean;
}): Promise<MigrationReport> {
  const dryRun = opts.dryRun === true;
  const classification = await classifyWsDepositActivities(opts.accountIds);
  const { shadows, orphans } = classification;

  if (dryRun) {
    return {
      ...classification,
      deletedShadows: shadows.length,
      insertedTransactions: orphans.length,
      skippedDuplicates: 0,
      dryRun: true,
    };
  }

  const { inserted, deduped } = await insertOrphans(opts.accountIds, orphans, opts.userId);

  const toDelete = [...shadows.map((s) => s.activityId), ...orphans.map((o) => o.activityId)];
  let deletedShadows = 0;
  if (toDelete.length > 0) {
    await InvestmentActivity.destroy({ where: { id: { [Op.in]: toDelete } } });
    deletedShadows = shadows.length;
  }

  return {
    ...classification,
    deletedShadows,
    insertedTransactions: inserted,
    skippedDuplicates: deduped,
    dryRun: false,
  };
}
