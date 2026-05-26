import { Op } from 'sequelize';
import { Account } from '../models/Account';
import { Household } from '../models/Household';
import { HoldingSnapshot } from '../models/HoldingSnapshot';
import { InvestmentActivity } from '../models/InvestmentActivity';
import { PortfolioForwardProjection } from '../models/PortfolioForwardProjection';
import { SecurityDividend } from '../models/SecurityDividend';
import { Security } from '../models/Security';
import { computeForwardProjection, type PaymentEvent } from './forwardIncome';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function latestHoldingsByHousehold(householdId: number, asOf: Date): Promise<Map<number, { qty: number; currency: string }>> {
  const invAccounts = await Account.findAll({
    where: { householdId, accountType: 'investment' },
    attributes: ['id'],
  });
  if (invAccounts.length === 0) return new Map();
  const acctIds = invAccounts.map((a) => a.id);

  const snapshots = await HoldingSnapshot.findAll({
    where: {
      accountId: { [Op.in]: acctIds },
      statementDate: { [Op.lte]: asOf.toISOString().slice(0, 10) },
    },
    order: [['statementDate', 'DESC']],
  });
  const latestByPair = new Map<string, HoldingSnapshot>();
  for (const s of snapshots) {
    const key = `${s.accountId}:${s.securityId}`;
    if (!latestByPair.has(key)) latestByPair.set(key, s);
  }

  const bySecurity = new Map<number, { qty: number; currency: string }>();
  for (const s of latestByPair.values()) {
    const qty = Number(s.quantity);
    if (qty === 0) continue;
    const existing = bySecurity.get(s.securityId);
    if (existing) {
      existing.qty += qty;
    } else {
      bySecurity.set(s.securityId, { qty, currency: s.currency });
    }
  }
  return bySecurity;
}

export interface RebuildResult {
  rebuilt: number;
  deleted: number;
}

export async function rebuildForwardProjectionsForHousehold(
  householdId: number,
  asOf: Date = new Date(),
): Promise<RebuildResult> {
  const holdings = await latestHoldingsByHousehold(householdId, asOf);
  const securityIds = [...holdings.keys()];

  let divEvents: SecurityDividend[] = [];
  let intEvents: InvestmentActivity[] = [];
  if (securityIds.length > 0) {
    const cutoff = new Date(asOf.getTime() - 395 * ONE_DAY_MS); // 13mo window for safety
    divEvents = await SecurityDividend.findAll({
      where: {
        securityId: { [Op.in]: securityIds },
        exDividendDate: { [Op.gte]: cutoff.toISOString().slice(0, 10) },
      },
    });
    const invAccounts = await Account.findAll({
      where: { householdId, accountType: 'investment' },
      attributes: ['id'],
    });
    intEvents = await InvestmentActivity.findAll({
      where: {
        accountId: { [Op.in]: invAccounts.map((a) => a.id) },
        securityId: { [Op.in]: securityIds },
        activityType: 'interest',
        tradeDate: { [Op.gte]: cutoff.toISOString().slice(0, 10) },
      },
    });
  }

  const securities = await Security.findAll({ where: { id: { [Op.in]: securityIds } } });
  const secById = new Map(securities.map((s) => [s.id, s]));

  let rebuilt = 0;
  for (const [securityId, holding] of holdings.entries()) {
    const sec = secById.get(securityId);
    if (!sec) continue;

    const divPayments: PaymentEvent[] = divEvents
      .filter((d) => d.securityId === securityId)
      .map((d) => ({ date: new Date(d.exDividendDate), perShareAmount: Number(d.amount) }));

    const intPayments: PaymentEvent[] = intEvents
      .filter((a) => a.securityId === securityId && a.amount != null)
      .map((a) => {
        const perShareAmount = Number(a.amount) / holding.qty;
        return Number.isFinite(perShareAmount)
          ? { date: new Date(a.tradeDate), perShareAmount }
          : null;
      })
      .filter((e): e is PaymentEvent => e !== null);

    const proj = computeForwardProjection({
      securityId,
      qtyToday: holding.qty,
      currency: holding.currency,
      dividendEvents: divPayments,
      interestEvents: intPayments,
      asOf,
    });

    const updateValues = {
      qtyBasis: String(proj.qtyBasis),
      annualDividendPerShare: String(proj.annualDividendPerShare),
      annualInterestPerShare: String(proj.annualInterestPerShare),
      projectedAnnualIncomeNative: String(proj.projectedAnnualIncomeNative.toFixed(2)),
      currency: proj.currency,
      cadenceLabel: proj.cadenceLabel,
      medianSpacingDays: proj.medianSpacingDays,
      cvPct: proj.cvPct === null ? null : String(proj.cvPct),
      unreliable: proj.unreliable,
      nextExDivDates: proj.nextExDivDates,
      computedAt: asOf,
      staleAt: null,
    };
    await PortfolioForwardProjection.upsert(
      { householdId, securityId, ...updateValues },
      { conflictFields: ['household_id', 'security_id'] as unknown as ('householdId' | 'securityId')[] },
    );
    rebuilt++;
  }

  const deleteWhere = securityIds.length > 0
    ? { householdId, securityId: { [Op.notIn]: securityIds } }
    : { householdId };
  const deleted = await PortfolioForwardProjection.destroy({ where: deleteWhere });

  return { rebuilt, deleted };
}

export async function rebuildForwardProjectionsForAllHouseholds(
  asOf: Date = new Date(),
): Promise<{ households: number; rebuilt: number; deleted: number }> {
  const households = await Household.findAll({ attributes: ['id'] });
  let rebuilt = 0;
  let deleted = 0;
  for (const hh of households) {
    const r = await rebuildForwardProjectionsForHousehold(hh.id, asOf);
    rebuilt += r.rebuilt;
    deleted += r.deleted;
  }
  return { households: households.length, rebuilt, deleted };
}

export async function markStaleForHousehold(householdId: number, securityId?: number): Promise<void> {
  const where: { householdId: number; securityId?: number } = { householdId };
  if (securityId !== undefined) where.securityId = securityId;
  await PortfolioForwardProjection.update({ staleAt: new Date() }, { where });
}

export async function markStaleForAllHoldersOfSecurity(securityId: number): Promise<void> {
  await PortfolioForwardProjection.update({ staleAt: new Date() }, { where: { securityId } });
}
