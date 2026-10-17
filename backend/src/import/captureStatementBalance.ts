import type { Transaction as SequelizeTransaction } from 'sequelize';
import { AccountStatement, sequelize } from '../models';
import type { Account } from '../models';
import { accountKind } from '../networth/accountKind';
import type { StatementPreview, StatementSummary } from './statementTypes';

/**
 * Statement balances → `account_statements`.
 *
 * Every PDF parser that can read a statement's closing balance hands it to the
 * commit pipeline as `preview.statementSummary`; this persists it as the
 * statement row for that period, so the balance reconciliation check
 * (networth/balanceReconciliation.ts) can compare the app's computed balance
 * at period end with the bank's own figure. Nothing compared the two before,
 * which is how an undated opening balance on the Royal Credit Line overstated
 * the amount owed by ~$13.6k without anyone noticing.
 *
 * Balances keep the `account_statements` convention (the convention the
 * manual-entry route and computeReconciliation already use): signed as printed
 * for asset accounts, the amount owed (positive) for liability accounts.
 */

const DERIVED_OPENING_NOTE =
  'Imported from statement. Opening balance derived from the closing balance and the ' +
  'imported activity (the statement does not print one).';
const IMPORTED_NOTE = 'Imported from statement.';

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * The statement's opening balance. When the statement prints none, derive it
 * from the closing balance and the period's parsed activity: for an asset,
 * closing = opening + Σamounts; for a liability (owed positive, charges
 * negative), closing = opening − Σamounts.
 */
function openingBalanceFor(
  summary: StatementSummary & { closingBalance: number },
  preview: StatementPreview,
  isLiability: boolean,
): { opening: number; derived: boolean } {
  if (summary.openingBalance != null) return { opening: summary.openingBalance, derived: false };
  const activity = preview.transactions
    .filter((t) => t.date >= summary.periodStart && t.date <= summary.periodEnd)
    .reduce((acc, t) => acc + t.amount, 0);
  const opening = isLiability
    ? summary.closingBalance + activity
    : summary.closingBalance - activity;
  return { opening: round4(opening), derived: true };
}

async function upsertStatementRow(
  preview: StatementPreview,
  summary: StatementSummary & { closingBalance: number },
  account: Account,
  householdId: number,
  userId: number | null,
  t: SequelizeTransaction,
): Promise<void> {
  const isLiability = accountKind(account.accountType) === 'liability';
  const { opening, derived } = openingBalanceFor(summary, preview, isLiability);
  const fields = {
    openingBalance: opening.toFixed(4),
    closingBalance: summary.closingBalance.toFixed(4),
    sourceFilename: preview.fileName.slice(0, 512),
    notes: derived ? DERIVED_OPENING_NOTE : IMPORTED_NOTE,
  };
  const existing = await AccountStatement.findOne({
    where: { accountId: account.id, periodStart: summary.periodStart, periodEnd: summary.periodEnd },
    transaction: t,
  });
  if (existing) {
    // A statement the user already reconciled is theirs: never move its
    // numbers out from under the reconciliation they accepted.
    if (existing.reconciledAt != null) return;
    await existing.update(fields, { transaction: t });
    return;
  }
  await AccountStatement.create(
    {
      householdId,
      accountId: account.id,
      createdByUserId: userId,
      visibility: 'shared',
      periodStart: summary.periodStart,
      periodEnd: summary.periodEnd,
      currency: account.defaultCurrency ?? 'CAD',
      reconciledAt: null,
      varianceExplanation: null,
      ...fields,
    },
    { transaction: t },
  );
}

/**
 * The warning recorded on an import whose statement period parsed but whose
 * closing balance did not, or null when there is nothing to flag.
 *
 * Only liability statements warn: a card or credit-line statement's balance is
 * the bill (safe-to-spend and the payment planner read it), so losing it is a
 * real regression — the Amex Reserve Sept 2026 import cleared the stored
 * statement balance and nothing said why. Asset-statement parsers that read a
 * balance already raise their own parse error when it is missing.
 */
function missingStatementBalanceWarning(
  preview: StatementPreview,
  account: Account,
): string | null {
  const summary = preview.statementSummary;
  if (!summary || summary.closingBalance != null) return null;
  if (accountKind(account.accountType) !== 'liability') return null;
  return (
    `Statement balance not read: the statement for ${summary.periodStart} to ` +
    `${summary.periodEnd} parsed its period but no closing balance, so it cannot be ` +
    `reconciled and the card's statement balance was not updated.`
  );
}

/**
 * Persist the statement's balances, contained so a failure never costs the
 * import (same contract as captureRatePeriods). Called from both commit paths:
 * the already-imported path too, so re-importing a statement that predates
 * balance capture backfills its row. Idempotent — keyed on the
 * (account_id, period_start, period_end) unique index.
 *
 * A liability statement with a period but no closing balance is not written;
 * its warning is pushed onto `preview.warnings` AND returned, so the commit
 * path can also record it on the ImportHistory row.
 */
export async function captureStatementBalance(
  preview: StatementPreview,
  account: Account,
  userId: number | null,
  parent: SequelizeTransaction | null,
): Promise<string[]> {
  const missing = missingStatementBalanceWarning(preview, account);
  if (missing) {
    preview.warnings.push(missing);
    return [missing];
  }
  await persistStatementBalance(preview, account, userId, parent);
  return [];
}

/** The preview's statement summary when it carries a closing balance, else null. */
function withClosingBalance(
  preview: StatementPreview,
): (StatementSummary & { closingBalance: number }) | null {
  const summary = preview.statementSummary;
  if (summary?.closingBalance == null) return null;
  return { ...summary, closingBalance: summary.closingBalance };
}

function notSavedWarning(summary: StatementSummary, e: unknown): string {
  const reason = e instanceof Error ? e.message : String(e);
  return (
    `Statement balance not saved for ${summary.periodStart} to ${summary.periodEnd}: ` +
    `${reason}. The rest of the import was unaffected.`
  );
}

async function persistStatementBalance(
  preview: StatementPreview,
  account: Account,
  userId: number | null,
  parent: SequelizeTransaction | null,
): Promise<void> {
  const summary = withClosingBalance(preview);
  if (!summary) return;
  try {
    // An account with no household cannot own a statement row (household_id is
    // NOT NULL); the insert fails and lands here as a warning like any other.
    await sequelize.transaction({ transaction: parent ?? undefined }, async (sp) =>
      upsertStatementRow(preview, summary, account, account.householdId as number, userId, sp),
    );
  } catch (e) {
    preview.warnings.push(notSavedWarning(summary, e));
  }
}
