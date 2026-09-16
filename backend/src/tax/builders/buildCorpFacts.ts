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
import { partitionCorpPerimeter } from './corpPerimeter';
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

  // Active business income — money that actually crossed the corporate
  // perimeter, in or out. A single customer payment can occupy several rows as
  // it hops between the corp's own accounts; only the hop that enters from
  // outside is income. `corpPerimeter` owns that rule and documents why
  // `linkedTransactionId` alone cannot detect an internal leg.
  //
  // The link-target set is built from the entity's FULL history, not the fiscal
  // window: a transfer initiated in December and settled in January would
  // otherwise look external on both sides of the year boundary.
  const allEntityTxns = await Transaction.findAll({
    where: { entityId },
    attributes: ['id', 'linkedTransactionId'],
  });
  const linkTargetIds = new Set<number>();
  for (const t of allEntityTxns) {
    if (t.linkedTransactionId != null) linkTargetIds.add(t.linkedTransactionId);
  }

  const accountTypeById = new Map(accounts.map((a) => [a.id, a.accountType ?? null]));

  const perimeter = partitionCorpPerimeter(
    txns.map((t) => ({
      id: t.id,
      amount: String(t.amount),
      currency: t.currency ?? 'CAD',
      date: t.date as unknown as string,
      txnType: (t as unknown as { txnType?: string | null }).txnType ?? null,
      accountType: accountTypeById.get(t.accountId) ?? null,
      linkedTransactionId: t.linkedTransactionId ?? null,
      taxTreatmentOverride: t.taxTreatmentOverride ?? null,
      merchant: t.merchantClean ?? t.merchantRaw ?? null,
    })),
    { legalName: entity.legalName ?? '', linkTargetIds },
  );

  // Revenue and expenses both land in activeBusinessIncome; expenses keep their
  // negative sign so the engine's signed sum nets them off.
  const activeBusinessIncome: IncomeItem[] = [];
  for (const t of [...perimeter.revenue, ...perimeter.expenses]) {
    const raw = D(t.amount);
    const { cad } = await toCad(raw, t.currency, t.date);
    activeBusinessIncome.push({
      source: `Txn #${t.id} ${t.merchant ?? ''}`.trim(),
      amount: raw,
      cadAmount: cad,
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
      const raw = D(t.amount as unknown as string);
      // Inflows are refunds or the reimbursement itself, not costs.
      if (!raw.lessThan(0)) continue;
      const txnType = (t as unknown as { txnType?: string | null }).txnType ?? null;
      // Moving money is not spending it; buying securities is capital.
      if (txnType === 'payment' || txnType === 'transfer' || txnType === 'investment') continue;
      // A row already classified as something else (a donation, an RRSP
      // contribution, a shareholder-loan leg) is not a corporate cost.
      if (t.taxTreatmentOverride != null && t.taxTreatmentOverride !== 'none') continue;
      const { cad } = await toCad(raw, t.currency ?? 'CAD', t.date as unknown as string);
      activeBusinessIncome.push({
        source: `Txn #${t.id} ${t.merchantClean ?? t.merchantRaw ?? ''} (owner-paid)`.trim(),
        amount: raw,
        cadAmount: cad,
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
    factWarnings: [...perimeter.warnings, ...ownerPaidWarnings],
  };
}
