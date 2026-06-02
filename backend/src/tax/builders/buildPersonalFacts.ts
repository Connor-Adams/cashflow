import { Op } from 'sequelize';
import {
  Account,
  Carryforward,
  Entity,
  HouseholdMember,
  InvestmentActivity,
  InstalmentPayment,
  Security,
  TaxSlip,
  Transaction,
  User,
} from '../../models';
import { D, sumD } from '../util/decimal';
import type {
  CapGainEvent,
  IncomeItem,
  PersonalCarryforwards,
  RrspContrib,
  SlipFact,
  TaxYearFacts,
} from '../engine/types';
import { computeAcb } from '../../portfolio/acb';
import { toCad } from '../../fx/toCad';

export async function buildPersonalFacts(entityId: number, year: number): Promise<TaxYearFacts> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`Entity ${entityId} not found`);
  if (entity.kind !== 'personal') throw new Error(`Entity ${entityId} is not personal`);

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const accounts = await Account.findAll({ where: { entityId } });
  const accountIds = accounts.map((a) => a.id);

  const txns = await Transaction.findAll({
    where: {
      entityId,
      date: { [Op.between]: [yearStart, yearEnd] },
    },
  });

  const employmentIncome: IncomeItem[] = [];
  const selfEmploymentIncome: IncomeItem[] = [];
  const selfEmploymentExpenses: IncomeItem[] = [];
  const donations: IncomeItem[] = [];
  const rrspContribs: RrspContrib[] = [];
  const fhsaContribs: RrspContrib[] = [];

  for (const t of txns) {
    const { cad } = await toCad(D(t.amount as unknown as string), t.currency ?? 'CAD', t.date as unknown as string);
    const item: IncomeItem = {
      source: `Txn #${t.id} ${(t as any).finalCategory ?? ''}`,
      amount: D(t.amount as unknown as string),
      cadAmount: cad,
    };
    const cat = (t as any).finalCategory ?? '';
    if (cat === 'employment_income') employmentIncome.push(item);
    else if (cat === 'donations') donations.push(item);
    else if (cat === 'rrsp_contribution') {
      rrspContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if (cat === 'fhsa_contribution') {
      fhsaContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if ((t as any).business && cad.greaterThan(0)) selfEmploymentIncome.push(item);
    else if ((t as any).business && cad.lessThan(0))
      selfEmploymentExpenses.push({ ...item, cadAmount: cad.abs(), amount: D(t.amount as unknown as string).abs() });
  }

  // Investment activity → interest, dividends, capital gain events
  const activity = accountIds.length
    ? await InvestmentActivity.findAll({
        where: {
          accountId: accountIds,
          tradeDate: { [Op.between]: [yearStart, yearEnd] },
        },
        include: [{ model: Security, as: 'security' }],
      })
    : [];

  const interestIncome: IncomeItem[] = [];
  const eligibleDividends: IncomeItem[] = [];
  const nonEligibleDividends: IncomeItem[] = [];

  for (const a of activity) {
    const { cad } = await toCad(D(a.amount ?? 0), (a as any).currency ?? 'CAD', a.tradeDate as unknown as string);
    const item: IncomeItem = {
      source: `${(a as any).security?.symbol ?? '?'} ${a.activityType} ${a.tradeDate}`,
      amount: D(a.amount ?? 0),
      cadAmount: cad,
    };
    if (a.activityType === 'interest') interestIncome.push(item);
    else if (a.activityType === 'dividend') {
      // Route based on Security.dividendEligibility; unknown defaults to eligible.
      const eligibility = (a as any).security?.dividendEligibility ?? 'eligible';
      if (eligibility === 'non_eligible') {
        nonEligibleDividends.push(item);
      } else {
        // 'eligible' or 'unknown' → eligible
        eligibleDividends.push(item);
      }
    }
  }

  // Capital gain events from sells, using ACB helper
  const capitalGainEvents: CapGainEvent[] = [];
  const securityIds = Array.from(new Set(activity.map((a) => a.securityId).filter((x): x is number => x != null)));
  for (const sid of securityIds) {
    const acts = activity.filter((a) => a.securityId === sid);
    const acb = computeAcb(acts.map((a) => ({
      id: a.id as number,
      activityType: a.activityType as string,
      tradeDate: a.tradeDate as unknown as string,
      quantity: a.quantity != null ? Number(a.quantity) : null,
      amount: a.amount != null ? Number(a.amount) : null,
      currency: a.currency as string,
      fees: a.fees != null ? Number(a.fees) : null,
    })));
    for (const realized of acb.realizedEvents) {
      capitalGainEvents.push({
        source: `Security ${sid} sell ${realized.tradeDate}`,
        securityId: sid,
        proceeds: D(realized.proceeds),
        acb: D(realized.costRemoved),
        outlays: D(0),
        date: realized.tradeDate,
      });
    }
  }

  // Slips
  const slipRows = await TaxSlip.findAll({ where: { entityId, year } });
  const slips: SlipFact[] = slipRows.map((s) => ({
    slipId: s.id,
    slipType: s.slipType as any,
    issuer: s.issuer,
    boxes: Object.fromEntries(
      Object.entries((s.boxValues ?? {}) as Record<string, number | string>).map(([k, v]) => [k, D(v as any)])
    ),
  }));

  // Carryforwards as of prior year
  const cf = await Carryforward.findAll({ where: { entityId, asOfYear: year - 1 } });
  const carryforwards: PersonalCarryforwards = {
    netCapitalLoss: D(cf.find((c) => c.kind === 'cap_loss')?.amount ?? 0),
    rrspRoom: D(cf.find((c) => c.kind === 'rrsp_room')?.amount ?? 0),
    nonCapLoss: D(cf.find((c) => c.kind === 'non_cap_loss')?.amount ?? 0),
    instalmentsPaid: D(cf.find((c) => c.kind === 'instalments_paid')?.amount ?? 0),
  };

  // Phase 4: override instalmentsPaid from InstalmentPayment ledger rows for this year
  const instalments = await InstalmentPayment.findAll({ where: { entityId, year } });
  if (instalments.length > 0) {
    carryforwards.instalmentsPaid = sumD(instalments.map((p) => D(p.amount as unknown as string)));
  }

  // Phase 2: age at year end — load User via HouseholdMember; fall back to 0 if no DOB
  let ageAtYearEnd = 0;
  const membership = await HouseholdMember.findOne({ where: { householdId: entity.householdId } });
  if (membership) {
    const user = await User.findByPk(membership.userId);
    if (user?.dob) {
      const dobYear = parseInt(user.dob.slice(0, 4), 10);
      const dobMonth = parseInt(user.dob.slice(5, 7), 10); // 1-based
      const dobDay = parseInt(user.dob.slice(8, 10), 10);
      let age = year - dobYear;
      // Subtract 1 if birthday hasn't occurred yet by Dec 31
      if (dobMonth > 12 || (dobMonth === 12 && dobDay > 31)) {
        age -= 1;
      }
      ageAtYearEnd = Math.max(0, age);
    }
  }

  return {
    year,
    jurisdiction: 'CA-ON',
    employmentIncome,
    selfEmploymentIncome,
    selfEmploymentExpenses,
    interestIncome,
    eligibleDividends,
    nonEligibleDividends,
    capitalGainEvents,
    rrspContribs,
    fhsaContribs,
    donations,
    slips,
    carryforwards,
    ageAtYearEnd,
  };
}
