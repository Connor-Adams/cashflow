/**
 * Shared liability loader (#654).
 *
 * Assembles a household's liability accounts joined with their liability
 * profiles + derived owed balances, and maps them to the payoff engine's debt
 * inputs. Extracted from `routes/debt.ts` so the safe-to-spend surplus hub can
 * reuse the exact same debt data behind `GET /api/debt` server-side without a
 * second HTTP round-trip.
 */
import { Op } from 'sequelize';
import { Account, LiabilityAccount } from '../models';
import { balanceAtDate } from '../networth/balanceAtDate';
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
  interestRate: number;
  minimumPayment: number;
  statementBalance: number | null;
  dueDay: number | null;
};

/**
 * The owed balance for a liability account. We prefer the explicit
 * `statementBalance` override when set; otherwise we derive it from the
 * transaction-stream balance via balanceAtDate. Liability balances are
 * negative (money owed), so we surface the magnitude as a positive "owed"
 * figure for the planner.
 */
export async function owedBalance(
  account: InstanceType<typeof Account>,
  profile: InstanceType<typeof LiabilityAccount> | null,
  asOf: string,
): Promise<number> {
  if (profile && profile.statementBalance != null) {
    return Math.abs(Number(profile.statementBalance));
  }
  const balances = await balanceAtDate(account, asOf);
  const ccy = account.defaultCurrency ?? 'CAD';
  const match = balances.find((b) => b.currency === ccy) ?? balances[0];
  const raw = match ? match.amount : 0;
  return raw < 0 ? Math.abs(raw) : 0;
}

/**
 * Assemble the household's liability accounts joined with their liability
 * profiles and derived owed balances. Scoped by householdId.
 */
export async function loadLiabilities(
  householdId: number,
  asOf: string,
): Promise<LiabilityRow[]> {
  const accounts = await Account.findAll({
    where: {
      householdId,
      accountType: { [Op.in]: Array.from(LIABILITY_TYPES) },
    },
    order: [['id', 'ASC']],
  });
  if (accounts.length === 0) return [];

  const profiles = await LiabilityAccount.findAll({
    where: { accountId: { [Op.in]: accounts.map((a) => a.id) } },
  });
  const profileByAccount = new Map<number, InstanceType<typeof LiabilityAccount>>();
  for (const p of profiles) profileByAccount.set(p.accountId, p);

  const rows: LiabilityRow[] = [];
  for (const account of accounts) {
    const profile = profileByAccount.get(account.id) ?? null;
    const balance = await owedBalance(account, profile, asOf);
    rows.push({
      accountId: account.id,
      name: account.name,
      accountType: account.accountType,
      currency: account.defaultCurrency ?? 'CAD',
      balance,
      interestRate: profile ? Number(profile.interestRate) : 0,
      minimumPayment: profile ? Number(profile.minimumPayment) : 0,
      statementBalance:
        profile && profile.statementBalance != null
          ? Number(profile.statementBalance)
          : null,
      dueDay: profile ? profile.dueDay : null,
    });
  }
  return rows;
}

/** Map assembled liabilities into the payoff engine's debt inputs (owed > 0). */
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
