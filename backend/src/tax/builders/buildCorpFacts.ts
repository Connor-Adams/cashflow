import { Op } from 'sequelize';
import {
  Carryforward,
  Entity,
  InvestmentActivity,
  Security,
  ShareholderLoan,
  Transaction,
} from '../../models';
import { D } from '../util/decimal';
import { computeAcb } from '../../portfolio/acb';
import { loadAcbFeed } from './acbFeed';
import { applyCorpStopLoss } from './corpStopLoss';
import { toCad as convertToCad } from '../../fx/toCad';
import { createFxFallbackCollector } from '../../fx/fxFallbackWarnings';
import { partitionCorpPerimeter } from './corpPerimeter';
import { loadCorpPerimeterInputs } from './loadCorpPerimeterInputs';
import { isOwnerPaidCorpExpense } from './ownerPaidCorpExpense';
import { isPersonalServicesBusinessYear } from '../../models/Entity';
import type {
  BusinessIncomeItem,
  CapGainEvent,
  CorpCarryforwards,
  CorpDividendPaid,
  CorpFiscalYear,
  CorpTaxYearFacts,
  IncomeItem,
  SuspendedCapitalLoss,
} from '../engine/types';

/**
 * One warning line per s.40(3.4) suspension, so the T2 tab (which shows the
 * return's warnings, seeded from these facts) says where a loss went.
 */
function describeSuspendedLosses(items: SuspendedCapitalLoss[], endDate: string): string[] {
  return items.map((s) => (s.releasedOn
    ? `Stop-loss (ITA s.40(3.4)(b)): the $${s.amount.toFixed(2)} capital loss on security `
      + `${s.securityId} suspended on ${s.dispositionDate} is recognized this year, on ${s.releasedOn}, `
      + 'when the corporation stopped holding identical property for 30 days.'
    : `Stop-loss (ITA s.40(3.4)(a)): the $${s.amount.toFixed(2)} capital loss on security `
      + `${s.securityId} from ${s.dispositionDate} is suspended and still suspended at ${endDate} — `
      + 'the corporation acquired identical property within 30 days of the sale and held it at the end '
      + 'of that window. It is recognized once no identical property is held for 30 days.'));
}

export async function buildCorpFacts(
  entityId: number,
  fiscalYear: CorpFiscalYear,
): Promise<CorpTaxYearFacts> {
  const { startDate, endDate } = fiscalYear;

  // Shared with the completeness gate, which partitions the same perimeter to
  // read `unimportedOutboundTransfers`. Everything below reads from this — do
  // not re-query here, or the two views of the perimeter will drift.
  const { entity, accountIds, txns, perimeterInput, perimeterOptions, mirrorWarnings } =
    await loadCorpPerimeterInputs(entityId, fiscalYear);

  const perimeter = partitionCorpPerimeter(perimeterInput, perimeterOptions);

  // Every conversion below goes through this, so one made on a substituted rate
  // (stale or post-dated; see fx/fxFallbackWarnings.ts) reaches factWarnings
  // instead of being discarded with the rest of the toCad result.
  const fxFallbacks = createFxFallbackCollector();
  const toCad: typeof convertToCad = async (amount, currency, date) => {
    const result = await convertToCad(amount, currency, date);
    fxFallbacks.record(currency, date, result);
    return result;
  };

  // Revenue and expenses both land in activeBusinessIncome; expenses keep their
  // negative sign so the engine's signed sum nets them off. `side` records which
  // bucket each row came from, for the s.18(1)(p) expense denial.
  const activeBusinessIncome: BusinessIncomeItem[] = [];
  const sided = [
    ...perimeter.revenue.map((t) => ({ t, side: 'revenue' as const })),
    ...perimeter.expenses.map((t) => ({ t, side: 'expense' as const })),
  ];
  for (const { t, side } of sided) {
    const raw = D(t.amount);
    const { cad } = await toCad(raw, t.currency, t.date);
    activeBusinessIncome.push({
      source: `Txn #${t.id} ${t.merchant ?? ''}`.trim(),
      amount: raw,
      cadAmount: cad,
      side,
    });
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

  // Passive income earned on accounts the InvestmentActivity ledger does not
  // cover — a corp chequing account paying monthly interest is the common case.
  // The perimeter split has already dropped the investment-account rows that
  // would double the ledger above. Transaction rows carry no security, so a
  // dividend here takes the same 'eligible' default the activity path uses when
  // eligibility is unknown.
  for (const t of perimeter.interestIncome) {
    const raw = D(t.amount);
    const { cad } = await toCad(raw, t.currency, t.date);
    interest.push({ source: `Txn #${t.id} ${t.merchant ?? ''}`.trim(), amount: raw, cadAmount: cad });
  }
  for (const t of perimeter.dividendIncome) {
    const raw = D(t.amount);
    const { cad } = await toCad(raw, t.currency, t.date);
    eligibleDividends.push({ source: `Txn #${t.id} ${t.merchant ?? ''}`.trim(), amount: raw, cadAmount: cad });
  }

  // Capital gains via ACB, over the same full-history feed (through 30 days
  // past fiscal year end) the personal builder walks — see acbFeed.ts. Income
  // items above stay fiscal-windowed: income is reported in the year received.
  //
  // A corporation's losses are under the s.40(3.3)/(3.4) stop-loss rule rather
  // than the superficial-loss rule (the s.54 definition excludes, at (h), a
  // disposition to which s.40(3.4) applies): a caught loss is suspended, not
  // added to the substituted property's ACB. See corpStopLoss.ts.
  const acbFeed = await loadAcbFeed(
    accountIds,
    endDate,
    async (amount, currency, date) => (await toCad(amount, currency, date)).cad,
  );
  const today = new Date().toISOString().slice(0, 10);
  const capitalGainEvents: CapGainEvent[] = [];
  const suspendedCapitalLosses: SuspendedCapitalLoss[] = [];
  const stopLossWarnings: string[] = [];
  let lossDispositionsTested = 0;
  for (const { securityId: sid, acts, acbInput } of acbFeed) {
    const acb = computeAcb(acbInput);
    const stopLoss = applyCorpStopLoss({ securityId: sid, acts, acb, startDate, endDate, today });
    lossDispositionsTested += stopLoss.lossDispositionsTested;
    suspendedCapitalLosses.push(...stopLoss.report);
    stopLossWarnings.push(...stopLoss.warnings);
    for (const realized of acb.realizedEvents) {
      // Prior-fiscal-year dispositions are already reported on their own year's
      // return; here they only serve to advance the ACB state.
      if (realized.tradeDate < startDate || realized.tradeDate > endDate) continue;
      const stopLossSuspended = stopLoss.suspendedByActivity.get(realized.activityId);
      capitalGainEvents.push({
        source: `Security ${sid} sell ${realized.tradeDate}`,
        securityId: sid,
        proceeds: D(realized.proceeds),
        acb: D(realized.costRemoved),
        outlays: D(0),
        date: realized.tradeDate,
        ...(stopLossSuspended ? { stopLossSuspended } : {}),
      });
    }
    // s.40(3.4)(b): the suspended loss "is deemed to be a loss of the transferor
    // from a disposition of the particular property" at the recognition time —
    // a capital loss of THIS period, carried as its own event.
    for (const rel of stopLoss.released) {
      capitalGainEvents.push({
        source: `Security ${sid} suspended loss from ${rel.dispositionDate} recognized (s.40(3.4)(b))`,
        securityId: sid,
        proceeds: D(0),
        acb: rel.amount,
        outlays: D(0),
        date: rel.releasedOn as string,
        stopLossReleasedFrom: rel.dispositionDate,
      });
    }
  }
  stopLossWarnings.push(...describeSuspendedLosses(suspendedCapitalLosses, endDate));
  if (lossDispositionsTested > 0) {
    stopLossWarnings.push(
      `${lossDispositionsTested} capital loss disposition(s) this year were tested against the `
      + 'stop-loss rule (ITA s.40(3.3)) using this corporation\'s own holdings only. A purchase of '
      + 'identical property within 30 days by an affiliated person (s.251.1: e.g. the controlling '
      + 'shareholder, their spouse, or another corporation they control) also suspends the loss and '
      + 'is not checked. Recognition on emigration, a change in tax-exempt status, a loss '
      + 'restriction event, a s.50 deemed disposition or a winding-up (s.40(3.4)(b)(ii)-(v)) is not '
      + 'modelled either.',
    );
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

  // Business costs the owner fronted on a PERSONAL account. The expense is the
  // corporation's, but the transaction sits on a personal card, so the
  // corp-entity query above never sees it and the cost goes undeducted.
  //
  // The reimbursement transfer that repays the owner is NOT the deduction — the
  // purchase is. `expense_reimbursement` exists to keep that transfer out of
  // both returns (see corpPerimeter's NON_OPERATING_TREATMENTS), so the dollar
  // is counted exactly once, here.
  //
  // Only attempted when the household has ONE corporation: nothing in the data
  // says which corp a personal business expense belongs to, and guessing would
  // let the same dollar be deducted on two returns.
  const ownerPaidWarnings: string[] = [];
  const corpsInHousehold = await Entity.findAll({
    where: { householdId: entity.householdId, kind: 'corp' },
  });
  if (corpsInHousehold.length > 1) {
    ownerPaidWarnings.push(
      `Household has more than one corporation (${corpsInHousehold.length}), so business `
      + 'expenses paid on personal accounts were NOT attributed to this return. Move them '
      + 'onto the corporation that incurred them, or record them on a corporate account.',
    );
  } else {
    const personalEntities = await Entity.findAll({
      where: { householdId: entity.householdId, kind: 'personal' },
    });
    const personalEntityIds = personalEntities.map((e) => e.id);
    const ownerPaid = personalEntityIds.length
      ? await Transaction.findAll({
        where: {
          entityId: personalEntityIds,
          date: { [Op.between]: [startDate, endDate] },
          finalBusiness: true,
        },
      })
      : [];
    let ownerPaidTotal = D(0);
    let ownerPaidCount = 0;
    for (const t of ownerPaid) {
      // Shared with buildPersonalFacts, which skips exactly these rows so the
      // same cost is not also a self-employment expense on the T1.
      if (!isOwnerPaidCorpExpense(t)) continue;
      const raw = D(t.amount as unknown as string);
      const { cad } = await toCad(raw, t.currency ?? 'CAD', t.date as unknown as string);
      activeBusinessIncome.push({
        source: `Txn #${t.id} ${t.merchantClean ?? t.merchantRaw ?? ''} (owner-paid)`.trim(),
        amount: raw,
        cadAmount: cad,
        side: 'expense',
      });
      ownerPaidTotal = ownerPaidTotal.plus(cad.abs());
      ownerPaidCount += 1;
    }
    if (ownerPaidCount > 0) {
      ownerPaidWarnings.push(
        `Deducted ${ownerPaidTotal.toFixed(2)} CAD across ${ownerPaidCount} business-flagged `
        + 'transaction(s) paid on personal accounts. These rest on the finalBusiness flag being '
        + 'correct — review them before filing, and make sure the reimbursement transfers that '
        + "repay them are tagged 'expense_reimbursement' so the same cost is not counted twice.",
      );
    }
  }

  return {
    fiscalYear,
    jurisdiction: 'CA-ON',
    activeBusinessIncome,
    ...(isPersonalServicesBusinessYear(entity, Number(endDate.slice(0, 4)))
      ? { personalServicesBusiness: true }
      : {}),
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
    ...(suspendedCapitalLosses.length > 0 ? { suspendedCapitalLosses } : {}),
    factWarnings: [
      ...perimeter.warnings,
      ...stopLossWarnings,
      ...ownerPaidWarnings,
      ...mirrorWarnings,
      ...fxFallbacks.warnings(),
    ],
  };
}
