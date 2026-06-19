/**
 * Account merge / consolidation service (#287).
 *
 * Soft-merge with audit: reassigns a source account's child records to a target
 * account, then flags the source `mergedIntoId` + `mergedAt`. The source row is
 * preserved (read-only, hidden from the default account list) so the merge has
 * an audit trail. The whole thing runs in a single DB transaction — if any
 * reassignment fails, nothing is committed.
 *
 * Spine note: merge is a behaviour on the Account primitive, not a new
 * primitive. `mergedIntoId` is a self-referential soft-merge field on Account.
 *
 * Out of scope (per #287): un-merge / reversal, cross-currency merge with FX,
 * merging entities/households, bulk merge.
 */
import { Op } from 'sequelize';
import type { Transaction as DbTransaction, Model, ModelStatic } from 'sequelize';
import {
  Account,
  Transaction,
  PlannedEvent,
  AccountStatement,
  DividendReconciliation,
  HoldingSnapshot,
  IncomeEntry,
  ImportHistory,
  InvestmentActivity,
  PortfolioDailySnapshot,
  PdfImportItem,
  sequelize,
} from '../models';

export type AccountMergeErrorCode =
  | 'SAME_ID'
  | 'NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  | 'TARGET_NOT_MERGEABLE'
  | 'SOURCE_ALREADY_MERGED';

/** Thrown for any rejected merge. `code` maps 1:1 to the HTTP 400/404 error. */
export class AccountMergeError extends Error {
  code: AccountMergeErrorCode;
  /** Optional extra context (e.g. the two currencies for a mismatch). */
  details?: Record<string, unknown>;
  constructor(code: AccountMergeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AccountMergeError';
    this.code = code;
    this.details = details;
  }
}

export type MergeAccountsInput = {
  sourceId: number;
  targetId: number;
  /** Scoping household — both accounts must belong to it. */
  householdId: number;
};

export type MergeAccountsResult = {
  source: Account;
  target: Account;
  movedTransactions: number;
  movedPlannedEvents: number;
  /** Total child rows reassigned across every account-referencing table. */
  movedTotal: number;
};

/**
 * Child tables that carry `account_id` and whose rows must follow the source
 * account into the target on merge. Each is reassigned by a bulk UPDATE inside
 * the merge transaction. `transactions` and `planned_events` are the two named
 * by the issue AC; the rest are reassigned too so historical / import data is
 * not orphaned under a hidden account.
 *
 * NOT included: `liability_accounts` — a 1:1 sidecar with a UNIQUE(account_id)
 * constraint. Reassigning it would collide with any sidecar already on the
 * target. The source's credit-limit sidecar simply stays with the (now hidden)
 * source; the target keeps its own.
 */
const CHILD_MODELS: ReadonlyArray<{ model: ModelStatic<Model>; label: string }> = [
  { model: Transaction, label: 'transactions' },
  { model: PlannedEvent, label: 'plannedEvents' },
  { model: AccountStatement, label: 'accountStatements' },
  { model: DividendReconciliation, label: 'dividendReconciliations' },
  { model: HoldingSnapshot, label: 'holdingsSnapshots' },
  { model: IncomeEntry, label: 'incomeEntries' },
  { model: ImportHistory, label: 'importHistories' },
  { model: InvestmentActivity, label: 'investmentActivities' },
  { model: PortfolioDailySnapshot, label: 'portfolioDailySnapshots' },
  { model: PdfImportItem, label: 'pdfImportItems' },
];

function normalizeCurrency(value: string | null): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * Perform the merge. Validates ownership + currency + mergeability, then
 * reassigns every child table and flags the source — all atomically.
 */
export async function mergeAccounts(input: MergeAccountsInput): Promise<MergeAccountsResult> {
  const { sourceId, targetId, householdId } = input;

  if (sourceId === targetId) {
    throw new AccountMergeError('SAME_ID', 'Source and target must be different accounts.');
  }

  const [source, target] = await Promise.all([
    Account.findOne({ where: { id: sourceId, householdId } }),
    Account.findOne({ where: { id: targetId, householdId } }),
  ]);

  if (!source || !target) {
    throw new AccountMergeError('NOT_FOUND', 'One or both accounts were not found.');
  }

  // The target cannot itself be a merged source (no chained A→B→C merges).
  if (target.mergedIntoId != null) {
    throw new AccountMergeError(
      'TARGET_NOT_MERGEABLE',
      `${target.name} has already been merged into another account.`,
    );
  }

  // The source cannot already be merged elsewhere.
  if (source.mergedIntoId != null) {
    throw new AccountMergeError(
      'SOURCE_ALREADY_MERGED',
      `${source.name} has already been merged into another account.`,
    );
  }

  const sourceCurrency = normalizeCurrency(source.defaultCurrency);
  const targetCurrency = normalizeCurrency(target.defaultCurrency);
  if (sourceCurrency !== targetCurrency) {
    throw new AccountMergeError(
      'CURRENCY_MISMATCH',
      `Accounts must be in the same currency. Source: ${sourceCurrency || 'unknown'}; Target: ${targetCurrency || 'unknown'}.`,
      { sourceCurrency, targetCurrency },
    );
  }

  let movedTransactions = 0;
  let movedPlannedEvents = 0;
  let movedTotal = 0;

  await sequelize.transaction(async (t: DbTransaction) => {
    for (const { model, label } of CHILD_MODELS) {
      const [affected] = await model.update(
        { accountId: targetId } as never,
        { where: { accountId: sourceId } as never, transaction: t },
      );
      movedTotal += affected;
      if (label === 'transactions') movedTransactions = affected;
      if (label === 'plannedEvents') movedPlannedEvents = affected;
    }

    source.set('mergedIntoId', targetId);
    source.set('mergedAt', new Date());
    await source.save({ transaction: t });
  });

  await Promise.all([source.reload(), target.reload()]);

  return { source, target, movedTransactions, movedPlannedEvents, movedTotal };
}

/** True if any account has been merged into the given account id (delete guard). */
export async function hasMergedSources(accountId: number, householdId: number): Promise<boolean> {
  const count = await Account.count({
    where: { mergedIntoId: accountId, householdId, id: { [Op.ne]: accountId } } as never,
  });
  return count > 0;
}
