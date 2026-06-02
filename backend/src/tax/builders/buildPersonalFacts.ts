import { Op } from 'sequelize';
import {
  Account,
  Carryforward,
  Category,
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
import { dividendDedupDays } from '../../config/env';

/** Whole-day difference (a − b) between two 'YYYY-MM-DD' dates at UTC midnight. */
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.round((da - db) / 86_400_000);
}

export async function buildPersonalFacts(entityId: number, year: number): Promise<TaxYearFacts> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`Entity ${entityId} not found`);
  if (entity.kind !== 'personal') throw new Error(`Entity ${entityId} is not personal`);

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const accounts = await Account.findAll({ where: { entityId } });
  const accountIds = accounts.map((a) => a.id);

  const householdCategories = await Category.findAll({ where: { householdId: entity.householdId } });
  const catTreatment = new Map(householdCategories.map((c) => [c.name, c.taxTreatment]));

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
      source: `Txn #${t.id} ${t.finalCategory ?? ''}`,
      amount: D(t.amount as unknown as string),
      cadAmount: cad,
    };
    const treatment = t.taxTreatmentOverride ?? catTreatment.get(t.finalCategory ?? '') ?? 'none';
    if (treatment === 'employment_income') employmentIncome.push(item);
    else if (treatment === 'donations') donations.push(item);
    else if (treatment === 'rrsp_contribution') {
      rrspContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if (treatment === 'fhsa_contribution') {
      fhsaContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if (t.finalBusiness && cad.greaterThan(0)) selfEmploymentIncome.push(item);
    else if (t.finalBusiness && cad.lessThan(0))
      selfEmploymentExpenses.push({ ...item, cadAmount: cad.abs(), amount: D(t.amount as unknown as string).abs() });
  }

  // Investment activity for INCOME (interest, dividends, DRIP, staking) — this
  // is correctly year-scoped: income is reported in the year received. Capital
  // gains use a separate, full-history feed below (ACB needs prior years).
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

  // Route a dividend-type item by Security.dividendEligibility; unknown/missing
  // defaults to eligible.
  const pushDividend = (a: InvestmentActivity, item: IncomeItem) => {
    const eligibility = (a as any).security?.dividendEligibility ?? 'eligible';
    if (eligibility === 'non_eligible') nonEligibleDividends.push(item);
    else eligibleDividends.push(item);
  };

  // Dividend rows (broker AND synthetic AV-reconciled) keyed for the DRIP
  // dedup below. Keyed by account too: the reconciler inserts its synthetic
  // dividend into the SAME account as the holding, so a DRIP and a dividend in
  // different accounts are distinct payouts. `consumed` enforces a greedy 1:1
  // match.
  const dividendKeys: { accountId: number; securityId: number | null; tradeDate: string; consumed: boolean }[] = [];
  // Reinvestment (DRIP) rows are resolved AFTER the loop, once every dividend
  // row for the year is known.
  const reinvestments: { activity: InvestmentActivity; item: IncomeItem }[] = [];

  for (const a of activity) {
    const { cad } = await toCad(D(a.amount ?? 0), (a as any).currency ?? 'CAD', a.tradeDate as unknown as string);
    const item: IncomeItem = {
      source: `${(a as any).security?.symbol ?? '?'} ${a.activityType} ${a.tradeDate}`,
      amount: D(a.amount ?? 0),
      cadAmount: cad,
    };
    if (a.activityType === 'interest' || a.activityType === 'staking_reward') {
      // staking_reward (e.g. Wealthsimple CRYPTORWD) is fully taxable ordinary
      // income. The T1 engine has no dedicated "other income" (L13000) line, so
      // it rides L12100 ("Interest and other investment income") with interest —
      // same ordinary rate, no gross-up, no inclusion factor.
      interestIncome.push(item);
    } else if (a.activityType === 'dividend') {
      dividendKeys.push({ accountId: a.accountId, securityId: a.securityId ?? null, tradeDate: a.tradeDate as unknown as string, consumed: false });
      pushDividend(a, item);
    } else if (a.activityType === 'reinvestment') {
      // A reinvested dividend (DRIP) is taxable exactly like a cash dividend, but
      // the AV reconciler may have inserted a synthetic 'dividend' for the same
      // payout (it dedups only against activityType='dividend'). Defer routing so
      // we don't double-count.
      reinvestments.push({ activity: a, item });
    }
  }

  // Resolve DRIP income: count a reinvestment ONLY when no dividend row (broker
  // or synthetic) already covers the same security within the dedup window —
  // otherwise that dividend row is the same payout. Greedy 1:1 so one dividend
  // can't mask multiple DRIPs.
  for (const { activity: a, item } of reinvestments) {
    const sid = a.securityId ?? null;
    const when = a.tradeDate as unknown as string;
    const match = sid == null
      ? undefined
      : dividendKeys.find(
          (k) => !k.consumed && k.accountId === a.accountId && k.securityId === sid
            && Math.abs(daysBetween(k.tradeDate, when)) <= dividendDedupDays,
        );
    if (match) {
      match.consumed = true;
      continue;
    }
    pushDividend(a, item);
  }

  // Capital gain events from sells, using the ACB helper.
  //
  // ACB is a weighted-average running balance, so computeAcb needs the FULL
  // per-security history up to year-end — NOT just this tax year's rows. A
  // year-windowed feed makes prior-year buys (and return_of_capital) invisible,
  // collapsing ACB to ~0 and grossly overstating realized gains as near-$0-cost
  // dispositions. We walk all activity at-or-before year-end, then keep only the
  // dispositions that actually settled DURING the tax year.
  const acbActivity = accountIds.length
    ? await InvestmentActivity.findAll({
        where: {
          accountId: accountIds,
          tradeDate: { [Op.lte]: yearEnd },
        },
      })
    : [];

  const capitalGainEvents: CapGainEvent[] = [];
  const securityIds = Array.from(new Set(acbActivity.map((a) => a.securityId).filter((x): x is number => x != null)));
  for (const sid of securityIds) {
    const acts = acbActivity.filter((a) => a.securityId === sid);
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
      // Prior-year dispositions are already reported on their own year's return;
      // here they only serve to advance the ACB state. Keep just this year's.
      if (realized.tradeDate < yearStart || realized.tradeDate > yearEnd) continue;
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
