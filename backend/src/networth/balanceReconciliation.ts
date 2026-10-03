import type { WhereOptions } from 'sequelize';
import type { BalanceIntegrity, StatementBalanceMismatch } from '@cashflow/shared';
import { Account, AccountStatement } from '../models';
import { accountKind } from './accountKind';
import { balanceAtDate } from './balanceAtDate';
import { PORTFOLIO_DRIVEN_TYPES } from './aggregate';
import { VARIANCE_TOLERANCE } from '../statements/computeReconciliation';

/**
 * Balance reconciliation — the safeguard that compares what the app computes
 * against what the bank printed.
 *
 *  1. Statement mismatches: for every `account_statements` row, the app's
 *     `balanceAtDate(account, periodEnd)` vs the statement's closing balance.
 *     A drift here is how a wrong opening balance, a missing month or a
 *     double-imported row shows up; without it they stay silent until someone
 *     happens to eyeball a balance.
 *  2. Undated opening balances: a non-zero `opening_balance` with a NULL
 *     `opening_balance_date`. balanceAtDate treats such a balance as standing
 *     before ALL history, so on an account whose full history is imported it
 *     double-counts — the RBC Royal Credit Line showed $36,354 owed against a
 *     real $22,700 this way.
 *
 * Derived, never stored: a view over Account + AccountStatement, so no new
 * table and no status machine. Statements follow the `account_statements`
 * convention (amount owed positive on liabilities), so the computed balance is
 * negated for liability accounts before comparing — the same flip
 * routes/statements.ts applies to its period variance.
 *
 * Investment accounts are skipped for (1): their value comes from holdings,
 * and their transaction stream is not a balance (see PORTFOLIO_DRIVEN_TYPES).
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function statementMismatches(
  accounts: Account[],
  statementScope: WhereOptions,
): Promise<{ checked: number; mismatches: StatementBalanceMismatch[] }> {
  const byId = new Map(
    accounts
      .filter((a) => !PORTFOLIO_DRIVEN_TYPES.has(a.accountType))
      .map((a) => [a.id, a] as const),
  );
  if (byId.size === 0) return { checked: 0, mismatches: [] };
  const statements = await AccountStatement.findAll({
    where: { ...statementScope, accountId: Array.from(byId.keys()) } as WhereOptions,
    order: [
      ['accountId', 'ASC'],
      ['periodEnd', 'DESC'],
    ],
  });

  let checked = 0;
  const mismatches: StatementBalanceMismatch[] = [];
  for (const s of statements) {
    const account = byId.get(s.accountId);
    if (!account) continue;
    const balances = await balanceAtDate(account, s.periodEnd);
    // Closed before the statement ended: there is no live balance to compare.
    if (balances.length === 0) continue;
    checked += 1;
    const signed = balances.find((b) => b.currency === s.currency)?.amount ?? 0;
    const isLiability = accountKind(account.accountType) === 'liability';
    const computed = round2(isLiability ? -signed : signed);
    const statement = round2(Number(s.closingBalance));
    const delta = round2(computed - statement);
    if (Math.abs(delta) <= VARIANCE_TOLERANCE) continue;
    mismatches.push({
      accountId: account.id,
      accountName: account.name,
      accountType: account.accountType,
      statementId: s.id,
      statementDate: s.periodEnd,
      currency: s.currency,
      computedBalance: computed,
      statementBalance: statement,
      delta,
    });
  }
  return { checked, mismatches };
}

export async function checkBalanceIntegrity(input: {
  /** Pass visibleAccountWhere(req). */
  accountScope: WhereOptions;
  /** Pass visibleStatementWhere(req). */
  statementScope: WhereOptions;
}): Promise<BalanceIntegrity> {
  const accounts = await Account.findAll({ where: input.accountScope, order: [['id', 'ASC']] });

  const undatedOpeningBalances = accounts
    .filter((a) => a.openingBalanceDate == null && (Number(a.openingBalance) || 0) !== 0)
    .map((a) => ({
      accountId: a.id,
      accountName: a.name,
      openingBalance: Number(a.openingBalance),
      currency: a.defaultCurrency ?? 'CAD',
    }));

  const { checked, mismatches } = await statementMismatches(accounts, input.statementScope);

  return {
    statementsChecked: checked,
    statementMismatches: mismatches,
    undatedOpeningBalances,
  };
}
