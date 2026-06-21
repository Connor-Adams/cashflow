import { Op } from 'sequelize';
import {
  Account,
  Carryforward,
  Entity,
  InvestmentActivity,
  Security,
  ShareholderLoan,
  Transaction,
} from '../../models';
import { D } from '../util/decimal';
import { computeAcb } from '../../portfolio/acb';
import { toCad } from '../../fx/toCad';
import type {
  CapGainEvent,
  CorpCarryforwards,
  CorpDividendPaid,
  CorpFiscalYear,
  CorpTaxYearFacts,
  IncomeItem,
} from '../engine/types';

export async function buildCorpFacts(
  entityId: number,
  fiscalYear: CorpFiscalYear,
): Promise<CorpTaxYearFacts> {
  const entity = await Entity.findByPk(entityId);
  if (!entity) throw new Error(`Entity ${entityId} not found`);
  if (entity.kind !== 'corp') throw new Error(`Entity ${entityId} is not corp`);

  const { startDate, endDate } = fiscalYear;

  const accounts = await Account.findAll({ where: { entityId } });
  const accountIds = accounts.map((a) => a.id);

  const txns = await Transaction.findAll({
    where: { entityId, date: { [Op.between]: [startDate, endDate] } },
  });

  // Active business income — transactions with finalBusiness=true
  const activeBusinessIncome: IncomeItem[] = [];
  for (const t of txns) {
    if (t.finalBusiness) {
      const { cad } = await toCad(
        D(t.amount as unknown as string),
        t.currency ?? 'CAD',
        t.date as unknown as string,
      );
      activeBusinessIncome.push({
        source: `Txn #${t.id} ${t.finalCategory ?? ''}`,
        amount: D(t.amount as unknown as string),
        cadAmount: cad,
      });
    }
  }

  const activity = accountIds.length
    ? await InvestmentActivity.findAll({
        where: {
          accountId: accountIds,
          tradeDate: { [Op.between]: [startDate, endDate] },
        },
        include: [{ model: Security, as: 'security' }],
      })
    : [];

  const interest: IncomeItem[] = [];
  const eligibleDividends: IncomeItem[] = [];
  const nonEligibleDividends: IncomeItem[] = [];

  for (const a of activity) {
    const { cad } = await toCad(
      D(a.amount ?? 0),
      (a as unknown as { currency?: string }).currency ?? 'CAD',
      a.tradeDate as unknown as string,
    );
    const sec = (a as unknown as { security?: { symbol?: string; dividendEligibility?: string } })
      .security;
    const item: IncomeItem = {
      source: `${sec?.symbol ?? '?'} ${a.activityType} ${a.tradeDate}`,
      amount: D(a.amount ?? 0),
      cadAmount: cad,
    };
    if (a.activityType === 'interest') {
      interest.push(item);
    } else if (a.activityType === 'dividend') {
      const kind = sec?.dividendEligibility ?? 'eligible';
      if (kind === 'non_eligible') {
        nonEligibleDividends.push(item);
      } else {
        eligibleDividends.push(item);
      }
    }
  }

  // Capital gains via ACB (same pattern as personal). ACB is a weighted-average
  // running balance (ITA s.47), so computeAcb needs the FULL per-security
  // history up to fiscal year end — NOT just this fiscal year's rows. A
  // fiscal-windowed feed makes prior-year buys invisible, collapsing ACB to ~0
  // and overstating realized gains as near-$0-cost dispositions. Walk all
  // activity through endDate, then keep only the dispositions that settled
  // DURING the fiscal year (income items above stay fiscal-windowed: income is
  // reported in the year received).
  const acbActivity = accountIds.length
    ? await InvestmentActivity.findAll({
        where: {
          accountId: accountIds,
          tradeDate: { [Op.lte]: endDate },
        },
      })
    : [];

  const capitalGainEvents: CapGainEvent[] = [];
  const securityIds = Array.from(
    new Set(
      acbActivity
        .map((a) => a.securityId)
        .filter((x): x is number => x != null),
    ),
  );
  for (const sid of securityIds) {
    const acts = acbActivity.filter((a) => a.securityId === sid);
    // CRA requires per-leg FX conversion: each buy/sell/fee leg converts at its
    // own trade-date rate, so the ACB walk — and the CapGainEvent the T2 engine
    // feeds into AAII / CDA / RDTOH math — is genuinely in CAD.
    const acbInput = [];
    for (const a of acts) {
      const currency = (a as unknown as { currency?: string }).currency ?? 'CAD';
      const tradeDate = a.tradeDate as unknown as string;
      let amount = a.amount != null ? Number(a.amount) : null;
      let fees = a.fees != null ? Number(a.fees) : null;
      if (currency !== 'CAD') {
        if (amount != null) amount = (await toCad(D(amount), currency, tradeDate)).cad.toNumber();
        if (fees != null) fees = (await toCad(D(fees), currency, tradeDate)).cad.toNumber();
      }
      acbInput.push({
        id: a.id as number,
        activityType: a.activityType as string,
        tradeDate,
        quantity: a.quantity != null ? Number(a.quantity) : null,
        amount,
        currency: 'CAD',
        fees,
        splitRatio: a.splitRatio != null ? Number(a.splitRatio) : null,
        costBasisAllocationPct:
          a.costBasisAllocationPct != null ? Number(a.costBasisAllocationPct) : null,
        cashComponent: a.cashComponent != null ? Number(a.cashComponent) : null,
        recipientSecurityId: a.recipientSecurityId ?? null,
      });
    }
    const acb = computeAcb(acbInput);
    for (const realized of acb.realizedEvents) {
      // Prior-fiscal-year dispositions are already reported on their own year's
      // return; here they only serve to advance the ACB state.
      if (realized.tradeDate < startDate || realized.tradeDate > endDate) continue;
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

  // Carryforwards as of start of fiscal year — use the calendar year before startDate
  const priorYear = Number(startDate.slice(0, 4)) - 1;
  const cf = await Carryforward.findAll({ where: { entityId, asOfYear: priorYear } });
  const carryforwards: CorpCarryforwards = {
    grip: D(cf.find((c) => c.kind === 'grip')?.amount ?? 0),
    cda: D(cf.find((c) => c.kind === 'cda')?.amount ?? 0),
    erdtoh: D(cf.find((c) => c.kind === 'erdtoh')?.amount ?? 0),
    nerdtoh: D(cf.find((c) => c.kind === 'nerdtoh')?.amount ?? 0),
    nonCapLoss: D(cf.find((c) => c.kind === 'non_cap_loss')?.amount ?? 0),
    netCapitalLoss: D(cf.find((c) => c.kind === 'cap_loss')?.amount ?? 0),
  };

  // ShareholderLoan entries in fiscal year
  const loanRows = await ShareholderLoan.findAll({
    where: {
      entityId,
      date: { [Op.between]: [startDate, endDate] },
    },
    order: [['date', 'ASC']],
  });

  const dividendsPaid: CorpDividendPaid[] = [];
  let salaryPaid = D(0);

  for (const loan of loanRows) {
    if (loan.kind === 'dividend_credit') {
      dividendsPaid.push({
        source: loan.description ?? `Dividend credit ${loan.date}`,
        date: loan.date as unknown as string,
        amount: D(loan.amount),
        kind: 'non_eligible', // Phase 3 PR 2: default; UI can specify eligible in future
      });
    } else if (loan.kind === 'salary_credit') {
      salaryPaid = salaryPaid.plus(D(loan.amount));
    }
  }

  // Classified corp→personal distributions (income-queue actuals). The corp
  // leg is an outflow (negative); distributions/remuneration are positive.
  for (const t of txns) {
    const tt = t.taxTreatmentOverride;
    // 'employment_income' is the synonym of 'salary' in TAX_TREATMENTS; prod tags
    // corp-paid remuneration with it. buildPersonalFacts treats them as one, so
    // the corp side must too or the salary (and its deduction) silently vanishes.
    if (
      tt !== 'eligible_dividend'
      && tt !== 'non_eligible_dividend'
      && tt !== 'salary'
      && tt !== 'employment_income'
    )
      continue;
    const { cad } = await toCad(
      D(t.amount as unknown as string),
      t.currency ?? 'CAD',
      t.date as unknown as string,
    );
    const amt = cad.abs();
    if (tt === 'eligible_dividend') {
      dividendsPaid.push({
        source: `Txn #${t.id} eligible dividend`,
        date: t.date as unknown as string,
        amount: amt,
        kind: 'eligible',
      });
    } else if (tt === 'non_eligible_dividend') {
      dividendsPaid.push({
        source: `Txn #${t.id} non_eligible dividend`,
        date: t.date as unknown as string,
        amount: amt,
        kind: 'non_eligible',
      });
    } else {
      // salary / employment_income
      salaryPaid = salaryPaid.plus(amt);
    }
  }

  return {
    fiscalYear,
    jurisdiction: 'CA-ON',
    activeBusinessIncome,
    investmentIncome: {
      interest,
      eligibleDividends,
      nonEligibleDividends,
      rentNet: [],
    },
    capitalGainEvents,
    dividendsPaid,
    salaryPaid,
    carryforwards,
  };
}
