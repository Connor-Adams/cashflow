/**
 * Shared liability loader (#654).
 *
 * Assembles a household's liability accounts joined with their liability
 * profiles + derived owed balances, and maps them to the payoff engine's debt
 * inputs. Extracted from `routes/debt.ts` so the safe-to-spend surplus hub can
 * reuse the exact same debt data behind `GET /api/debt` server-side without a
 * second HTTP round-trip.
 */
import { Op, fn, col } from 'sequelize';
import { Account, LiabilityAccount, Transaction } from '../models';
import { currentOwed } from '../cards/utilization';
import { looseHistoricalFxLookup } from '../networth/aggregate';
import type { FxLookup } from '../networth/unifyToCad';
import { makeCadConverter } from '../fx/cadConverter';
import { toUnits, fromUnits } from '../util/numbers';
import type { PayoffDebtInput } from './payoffPlan';

// Liability account types — must match networth/accountKind.ts LIABILITY_TYPES.
export const LIABILITY_TYPES = new Set(['credit_card', 'loan', 'mortgage']);

export type LiabilityRow = {
  accountId: number;
  name: string;
  accountType: string;
  currency: string;
  /** Amount currently owed, as a positive number. */
  balance: number;
  /** Whether `balance` is the stored statement balance or the live balance. */
  balanceSource: BalanceSource;
  interestRate: number;
  minimumPayment: number;
  statementBalance: number | null;
  dueDay: number | null;
  /** `balance` FX-converted to CAD at asOf; null when no rate resolves. */
  balanceCad: number | null;
  /** `minimumPayment` FX-converted to CAD at asOf; null when no rate resolves. */
  minimumPaymentCad: number | null;
};

/**
 * Which figure a liability row's `balance` came from: the stored statement
 * balance, or the live running balance derived from the transaction stream.
 */
export type BalanceSource = 'statement' | 'live';

/**
 * The statement balance wins only while it is at least as fresh as the
 * account's newest imported transaction (on/after it). Once anything has been
 * imported past the statement's as-of date, the statement no longer reflects
 * what is owed and the live balance is used instead. With no transactions at
 * all there is nothing fresher, so the statement stands.
 */
export function chooseBalanceSource(
  hasStatementBalance: boolean,
  statementAsOf: string | null,
  lastTxnDate: string | null,
): BalanceSource {
  if (!hasStatementBalance) return 'live';
  if (lastTxnDate == null || statementAsOf == null) return 'statement';
  return statementAsOf >= lastTxnDate ? 'statement' : 'live';
}

/**
 * The date a stored statement balance is as of: the statement cycle date when
 * one was captured (PDF import, Credit Card planner); otherwise the date the
 * profile was last saved — the Debt page sets the balance without a statement
 * date, and a hand-typed balance is current as of the day it was entered.
 */
function statementAsOfDate(profile: InstanceType<typeof LiabilityAccount>): string | null {
  if (profile.statementDate) return String(profile.statementDate).slice(0, 10);
  const saved = profile.updatedAt as Date | string | null | undefined;
  if (saved == null) return null;
  const d = saved instanceof Date ? saved : new Date(saved);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * The owed balance for a liability account, in the account's own currency,
 * and which source it came from (see `chooseBalanceSource`). The stored
 * `statementBalance` is used while it is not older than `lastTxnDate` (the
 * account's newest transaction on/before asOf); otherwise the balance is
 * derived from the transaction stream via `currentOwed`, which FX-folds any
 * foreign-currency legs into the account's default currency instead of
 * dropping them (the old `find(defCcy) ?? balances[0]` only ever read one
 * bucket — the same bug cards/utilization.ts already fixed). Liability
 * balances are negative (money owed), so the magnitude is surfaced as a
 * positive "owed" figure.
 */
export async function owedBalance(
  account: InstanceType<typeof Account>,
  profile: InstanceType<typeof LiabilityAccount> | null,
  asOf: string,
  fxLookup: FxLookup = looseHistoricalFxLookup,
  lastTxnDate: string | null = null,
): Promise<{ balance: number; balanceSource: BalanceSource }> {
  const hasStatement = profile != null && profile.statementBalance != null;
  const source = chooseBalanceSource(
    hasStatement,
    hasStatement ? statementAsOfDate(profile) : null,
    lastTxnDate,
  );
  if (source === 'statement') {
    return { balance: Math.abs(Number(profile!.statementBalance)), balanceSource: 'statement' };
  }
  return { balance: await currentOwed(account, asOf, fxLookup), balanceSource: 'live' };
}

/** Newest transaction date (on/before asOf) per account, YYYY-MM-DD. */
async function lastTxnDates(accountIds: number[], asOf: string): Promise<Map<number, string>> {
  const rows = (await Transaction.findAll({
    where: { accountId: { [Op.in]: accountIds }, date: { [Op.lte]: asOf } },
    attributes: ['accountId', [fn('MAX', col('date')), 'lastDate']],
    group: ['accountId'],
    raw: true,
  })) as unknown as Array<{ accountId: number; lastDate: string | Date | null }>;
  const out = new Map<number, string>();
  for (const r of rows) {
    if (r.lastDate == null) continue;
    const d = r.lastDate instanceof Date ? r.lastDate.toISOString() : String(r.lastDate);
    out.set(Number(r.accountId), d.slice(0, 10));
  }
  return out;
}

/**
 * Assemble the household's open liability accounts joined with their liability
 * profiles and derived owed balances. Scoped by householdId. Accounts closed on
 * or before `asOf` are excluded (a stale statement override on a closed card
 * must not resurrect it into totals or the payoff plan).
 */
export async function loadLiabilities(
  householdId: number,
  asOf: string,
  fxLookup: FxLookup = looseHistoricalFxLookup,
): Promise<LiabilityRow[]> {
  const accounts = await Account.findAll({
    where: {
      householdId,
      accountType: { [Op.in]: Array.from(LIABILITY_TYPES) },
      [Op.or]: [{ closedAt: null }, { closedAt: { [Op.gt]: asOf } }],
    },
    order: [['id', 'ASC']],
  });
  if (accounts.length === 0) return [];

  const profiles = await LiabilityAccount.findAll({
    where: { accountId: { [Op.in]: accounts.map((a) => a.id) } },
  });
  const profileByAccount = new Map<number, InstanceType<typeof LiabilityAccount>>();
  for (const p of profiles) profileByAccount.set(p.accountId, p);
  const lastTxnByAccount = await lastTxnDates(accounts.map((a) => a.id), asOf);

  const toCadAmount = makeCadConverter(asOf, fxLookup);
  const rows: LiabilityRow[] = [];
  for (const account of accounts) {
    const profile = profileByAccount.get(account.id) ?? null;
    const currency = account.defaultCurrency ?? 'CAD';
    const { balance, balanceSource } = await owedBalance(
      account,
      profile,
      asOf,
      fxLookup,
      lastTxnByAccount.get(account.id) ?? null,
    );
    const minimumPayment = profile ? Number(profile.minimumPayment) : 0;
    rows.push({
      accountId: account.id,
      name: account.name,
      accountType: account.accountType,
      currency,
      balance,
      balanceSource,
      interestRate: profile ? Number(profile.interestRate) : 0,
      minimumPayment,
      statementBalance:
        profile && profile.statementBalance != null
          ? Number(profile.statementBalance)
          : null,
      dueDay: profile ? profile.dueDay : null,
      balanceCad: await toCadAmount(balance, currency),
      minimumPaymentCad: await toCadAmount(minimumPayment, currency),
    });
  }
  return rows;
}

export type LiabilitySummary = {
  /** Totals are always CAD — never "the first account's currency". */
  currency: 'CAD';
  totalOwed: number;
  totalMinimumPayment: number;
  /** Currencies with no resolvable FX rate, left out of the CAD totals. */
  unconvertedCurrencies: string[];
};

/**
 * CAD totals across the loaded liabilities. A USD 2,000 card plus a CAD 10,000
 * loan is CA$12,800 at 1.4 — not "CA$12,000". Rows whose currency has no FX
 * rate are excluded from the totals and their currency is flagged instead of
 * being summed as if it were CAD.
 */
export function summarizeLiabilities(liabilities: LiabilityRow[]): LiabilitySummary {
  let owedU = 0;
  let minU = 0;
  const unconverted = new Set<string>();
  for (const l of liabilities) {
    if (l.balanceCad == null || l.minimumPaymentCad == null) {
      if (l.balance > 0 || l.minimumPayment > 0) unconverted.add(l.currency);
      continue;
    }
    owedU += toUnits(l.balanceCad);
    minU += toUnits(l.minimumPaymentCad);
  }
  return {
    currency: 'CAD',
    totalOwed: Math.round(fromUnits(owedU) * 100) / 100,
    totalMinimumPayment: Math.round(fromUnits(minU) * 100) / 100,
    unconvertedCurrencies: Array.from(unconverted).sort(),
  };
}

/**
 * Map assembled liabilities into the payoff engine's debt inputs (owed > 0) in
 * their NATIVE currency. Only safe for a single-currency slice (the surplus hub
 * filters to one currency first); a cross-currency plan must use
 * `toCadDebtInputs`.
 */
export function toDebtInputs(liabilities: LiabilityRow[]): PayoffDebtInput[] {
  return liabilities
    .filter((l) => l.balance > 0)
    .map((l) => ({
      id: l.accountId,
      name: l.name,
      balance: l.balance,
      apr: l.interestRate,
      minimumPayment: l.minimumPayment,
    }));
}

/**
 * Map liabilities into payoff-engine inputs with balances and minimum payments
 * FX-converted to CAD, so avalanche/snowball never order or pay down a USD
 * balance as if it were CAD. Rows with no resolvable rate are left out (they
 * are flagged by `summarizeLiabilities`) rather than mixed in unconverted.
 */
export function toCadDebtInputs(liabilities: LiabilityRow[]): PayoffDebtInput[] {
  const out: PayoffDebtInput[] = [];
  for (const l of liabilities) {
    if (l.balanceCad == null || l.minimumPaymentCad == null || !(l.balanceCad > 0)) continue;
    out.push({
      id: l.accountId,
      name: l.name,
      balance: l.balanceCad,
      apr: l.interestRate,
      minimumPayment: l.minimumPaymentCad,
    });
  }
  return out;
}
