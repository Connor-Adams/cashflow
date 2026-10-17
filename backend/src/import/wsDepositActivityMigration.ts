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
import { rowFingerprint, stableFingerprint } from './fingerprint';
import { normalizeMerchant } from './normalizeMerchant';
import type { NormalizedCashTransaction, StatementPreview } from './statementTypes';
import type { TxnType } from './enrichment/types';

/**
 * Account types where EVERY security-less row is a cash-ledger event, so no activity
 * allowlist applies. Exported for the same reason as
 * `BROKERAGE_CASH_LEG_ACCOUNT_IDS`: the completeness gate must scope its
 * convertible-orphan blocker to exactly what this converter covers, and two copies of
 * the rule would be one to forget. Scoping the gate to the brokerage ids alone missed
 * every deposit-account orphan — which is the population the converter was built for.
 */
export const DEPOSIT_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['checking', 'savings']);

/**
 * Brokerage accounts this converter may run against.
 *
 * `Account` has no institution, provider or parser column, and every brokerage
 * account of every provider is `accountType: 'investment'` — so there is no way to
 * widen the type guard to admit one Wealthsimple account without admitting every
 * Questrade account at the same time, and `questrade.ts` already emits its own cash
 * mirrors, which this converter would then read as shadows.
 *
 * Hence an explicit id list. Exported because the completeness gate (part 3) must
 * scope its orphaned-cash-leg blocker to exactly the accounts this converter
 * covers; two copies of the list would be one to forget.
 */
export const BROKERAGE_CASH_LEG_ACCOUNT_IDS: readonly number[] = [13];

/**
 * The only activity types that are cash crossings, and so the only ones converted
 * on a brokerage account.
 *
 * Deliberately excludes a bare `transfer` — `rbcInvestment` and `questrade` both
 * emit it, and `wealthsimpleActivityCodes` maps `CONT` to it — and `interest`,
 * which is income rather than a crossing. On a DEPOSIT account no allowlist
 * applies: every row there is a cash-ledger event, which is the assumption the
 * existing 190-shadow cleanup was measured against.
 */
export const BROKERAGE_CASH_LEG_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'transfer_in', 'transfer_out', 'cash_movement',
]);

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

async function loadDepositAccounts(
  accountIds: number[],
  brokerageAccountIds: readonly number[],
): Promise<Account[]> {
  const accounts = await Account.findAll({ where: { id: { [Op.in]: accountIds } } });
  const found = new Set(accounts.map((a) => a.id));
  const missing = accountIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`No account with id ${missing.join(', ')}`);
  }
  const optIn = new Set(brokerageAccountIds);
  const wrong = accounts.filter(
    (a) => !DEPOSIT_ACCOUNT_TYPES.has(String(a.accountType)) && !optIn.has(a.id as number),
  );
  if (wrong.length > 0) {
    // Refuse rather than silently skip: this cleanup deletes rows, and running
    // it against a brokerage account would be a request to destroy real
    // investment activity.
    throw new Error(
      `Account ${wrong.map((a) => `${a.id} (${a.name}, ${a.accountType})`).join('; ')} ` +
        'is not a deposit account and is not in BROKERAGE_CASH_LEG_ACCOUNT_IDS.',
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

/**
 * Activity ids for which a transaction already records the same event.
 *
 * Exported for part 3's completeness gate, which must know whether a cash-leg
 * activity is already in the ledger but cannot call `classifyWsDepositActivities` —
 * that function scans an account's entire history, and the gate is period-bounded
 * because it runs on every T1 request.
 *
 * Built on this module's own index so the gate's notion of "already recorded" is the
 * same one the migration uses when it decides what to convert. Matching is on
 * (account, date, amount, currency); merchant text is deliberately not compared,
 * because the point here is only whether the event exists, not which row describes
 * it better.
 */
export function activityIdsWithTransaction(
  activities: InvestmentActivity[],
  transactions: Transaction[],
): Set<number> {
  const index = buildTransactionIndex(transactions);
  const matched = new Set<number>();
  for (const a of activities) {
    const f = activityFields(a);
    if (index.has(pairKey(f.accountId, f.date, f.amount, f.currency))) {
      matched.add(f.activityId);
    }
  }
  return matched;
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
  brokerageAccountIds: readonly number[] = BROKERAGE_CASH_LEG_ACCOUNT_IDS,
): Promise<Classification> {
  if (accountIds.length === 0) return { shadows: [], orphans: [], skipped: [] };
  const accounts = await loadDepositAccounts(accountIds, brokerageAccountIds);
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
  const optInForSkip = new Set(brokerageAccountIds);
  const skipped: SkippedRow[] = activities
    .filter((a) => a.securityId != null)
    .map((a) => ({
      activityId: a.id as number,
      accountId: a.accountId as number,
      reason: 'carries a security — not a cash event',
    }))
    // A security-less row the allowlist rejects on an opt-in account belonged to no
    // bucket at all: not a shadow, not an orphan, and `skipped` only ever held
    // security-bearing rows. It vanished from the report entirely, which is the one
    // outcome a tool that decides what to convert must never have.
    .concat(
      activities
        .filter((a) => a.securityId == null
          && optInForSkip.has(a.accountId as number)
          && !BROKERAGE_CASH_LEG_ACTIVITY_TYPES.has(String(a.activityType)))
        .map((a) => ({
          activityId: a.id as number,
          accountId: a.accountId as number,
          reason: `activityType '${String(a.activityType)}' is not a cash crossing — left alone`,
        })),
    );
  // On a deposit account every security-less row is a cash event, so selection is
  // unchanged there. On an opt-in brokerage account it is not: a `sell` whose
  // security failed to resolve is also security-less, and converting it would take
  // out real investment activity. So the allowlist applies there and only there.
  const optIn = new Set(brokerageAccountIds);
  const isDepositRow = (a: InvestmentActivity) => !optIn.has(a.accountId as number);
  const cashRows = activities.filter(
    (a) => a.securityId == null
      && (isDepositRow(a) || BROKERAGE_CASH_LEG_ACTIVITY_TYPES.has(String(a.activityType))),
  );

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
 * Identifies the exact set of rows a cleanup run converts, so re-running with
 * the same set is recognized as an already-applied import while a run covering
 * a different set is not.
 *
 * Must be a HASH, not the id list itself: `import_histories.content_hash` is
 * varchar(64), and account 14 alone converts 56 rows. Joining the ids overflows
 * the column and Postgres rejects the whole commit.
 */
export function cleanupContentHash(accountId: number, activityIds: number[]): string {
  return stableFingerprint({
    kind: 'ws-deposit-cleanup',
    accountId,
    activityIds: [...activityIds].sort((a, b) => a - b),
  });
}

/**
 * One account's orphans as a statement preview.
 */
function cleanupPreview(
  accountId: number,
  householdId: number | null,
  orphans: OrphanRow[],
  brokerageAccountIds: readonly number[],
  runStamp: string,
): StatementPreview {
  return {
    previewToken: `ws-deposit-cleanup-${accountId}`,
    fileName: 'ws-deposit-activity-cleanup',
    contentHash: cleanupContentHash(accountId, orphans.map((o) => o.activityId)),
    accountId,
    householdId,
    // Per run and per account on an opt-in brokerage account, because
    // `rollbackImportBatch` matches this string EXACTLY — a shared constant means
    // rolling back one account's conversion reaches every converted row ever made.
    // Deposit accounts keep the shared label so their existing rollback addressing
    // is unchanged, which is this part's promise about them.
    importBatch: brokerageAccountIds.includes(accountId)
      ? `WS brokerage cash legs acct ${accountId} ${runStamp}`
      : 'WS deposit ledger cleanup',
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
  brokerageAccountIds: readonly number[],
  runStamp: string,
): Promise<{ inserted: number; deduped: number }> {
  let inserted = 0;
  let deduped = 0;
  for (const accountId of accountIds) {
    const mine = orphans.filter((o) => o.accountId === accountId);
    if (mine.length === 0) continue;
    const householdId = mine[0].householdId;
    const result = await commitStatementImport(
      cleanupPreview(accountId, householdId, mine, brokerageAccountIds, runStamp),
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
  brokerageAccountIds?: readonly number[];
}): Promise<MigrationReport> {
  const dryRun = opts.dryRun === true;
  const brokerageAccountIds = opts.brokerageAccountIds ?? BROKERAGE_CASH_LEG_ACCOUNT_IDS;
  const classification = await classifyWsDepositActivities(
    opts.accountIds,
    brokerageAccountIds,
  );
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

  // One stamp for the whole run, so every account converted in this invocation is
  // addressable together and a later run is addressable separately.
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { inserted, deduped } = await insertOrphans(
    opts.accountIds, orphans, opts.userId, brokerageAccountIds, runStamp,
  );

  // Insert-only on opt-in brokerage accounts: nothing there is ever removed.
  //
  // After one run the database holds one activity at a key and one converted
  // transaction carrying the same merchantRaw. That state is byte-identical
  // whether it came from two real events whose second insert collided on
  // stableIdentityFingerprint, or from one event whose run stopped between the
  // insert and the sweep. In the first the survivor is a real cash event and must
  // never be removed; in the second it is redundant and must be. Same state,
  // opposite correct actions — so no predicate over that state can choose, and
  // four earlier attempts at one all lost a row. Removing nothing dissolves it.
  //
  // Deposit accounts keep the sweep: there the pairing assumption was measured,
  // and the 190 shadows this module exists for still need retiring.
  const optIn = new Set(brokerageAccountIds);
  const removable = (accountId: number) => !optIn.has(accountId);
  const toDelete = [
    ...shadows.filter((s) => removable(s.accountId)).map((s) => s.activityId),
    ...orphans.filter((o) => removable(o.accountId)).map((o) => o.activityId),
  ];
  let deletedShadows = 0;
  if (toDelete.length > 0) {
    await InvestmentActivity.destroy({ where: { id: { [Op.in]: toDelete } } });
    deletedShadows = shadows.filter((s) => removable(s.accountId)).length;
  }

  return {
    ...classification,
    deletedShadows,
    insertedTransactions: inserted,
    skippedDuplicates: deduped,
    dryRun: false,
  };
}
