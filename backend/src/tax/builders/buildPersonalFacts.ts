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
import { D, Decimal, sumD } from '../util/decimal';
import { isTaxTreatment } from '@cashflow/shared';
import type {
  CapGainEvent,
  IncomeItem,
  PersonalCarryforwards,
  RrspContrib,
  SlipFact,
  TaxYearFacts,
} from '../engine/types';
import { computeAcb, type AcbActivity, type AcbRealizedEvent } from '../../portfolio/acb';
import { inheritedTaxTreatment } from '../../categories/inheritedTaxTreatment';
import { toCad } from '../../fx/toCad';
import { dividendDedupDays } from '../../config/env';

/**
 * CRA superficial-loss denial for one loss disposition: 30 days BEFORE through
 * 30 days after the disposition (61 days, same-day included), AND identical
 * property must still be held at the end of the window. Denial is proportional
 * per CRA's administrative formula min(S, P, B) / S × loss, where S = units
 * sold, P = units acquired in the window, B = units held at window end.
 * Returns undefined when the event is not a loss or no denial applies.
 */
function computeDeniedPortion(
  realized: AcbRealizedEvent,
  acts: InvestmentActivity[],
  timeline: { asOf: string; quantity: number }[],
): Decimal | undefined {
  const rawGain = D(realized.proceeds).minus(D(realized.costRemoved));
  if (!rawGain.lessThan(0) || realized.qtySold <= 0) return undefined;
  const sellDate = new Date(`${realized.tradeDate}T00:00:00.000Z`);
  const windowStartStr = new Date(sellDate.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const windowEndStr = new Date(sellDate.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const acquiredInWindow = acts
    .filter(a =>
      (a.activityType === 'buy' || a.activityType === 'reinvestment')
      && (a.tradeDate as unknown as string) >= windowStartStr
      && (a.tradeDate as unknown as string) <= windowEndStr)
    .reduce((sum, a) => sum + (a.quantity != null ? Number(a.quantity) : 0), 0);
  // Units held at window end: last ACB timeline state at-or-before the window
  // end (timeline is chronological; the feed extends 30 days past year-end so
  // December windows are fully covered).
  let heldAtWindowEnd = 0;
  for (const st of timeline) {
    if (st.asOf > windowEndStr) break;
    heldAtWindowEnd = st.quantity;
  }
  if (acquiredInWindow > 0 && heldAtWindowEnd > 0) {
    const deniedUnits = Math.min(realized.qtySold, acquiredInWindow, heldAtWindowEnd);
    return rawGain.negated().times(deniedUnits).dividedBy(realized.qtySold);
  }
  return undefined;
}

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

  // Only taxable accounts feed the personal T1. Investment income and capital
  // gains earned INSIDE registered accounts (TFSA is tax-free; RRSP/RRIF/FHSA are
  // taxed on withdrawal, not on in-account earnings) must never land on the
  // taxable return. Allowlist the taxable statuses so any future registered type
  // stays excluded by default. Transaction-based income (employment, self-
  // employment, donations, RRSP/FHSA contributions) is keyed off entityId below
  // and is intentionally unaffected.
  const taxableAccounts = await Account.findAll({
    where: { entityId, taxStatus: { [Op.in]: ['non_registered', 'n_a'] } },
  });
  const accountIds = taxableAccounts.map((a) => a.id);

  const householdCategories = await Category.findAll({ where: { householdId: entity.householdId } });
  const catTreatment = new Map(householdCategories.map((c) => [c.name, c.taxTreatment]));
  // Id-keyed node map so a nested category inherits its parent's tax treatment
  // (a 'none' child under a 'medical_expense' parent resolves to medical_expense).
  const catById = new Map(
    householdCategories.map((c) => [c.id, { id: c.id, parentId: c.parentId, taxTreatment: c.taxTreatment }]),
  );

  const txns = await Transaction.findAll({
    where: {
      entityId,
      date: { [Op.between]: [yearStart, yearEnd] },
    },
  });

  const employmentIncome: IncomeItem[] = [];
  const eligibleDividends: IncomeItem[] = [];
  const nonEligibleDividends: IncomeItem[] = [];
  const selfEmploymentIncome: IncomeItem[] = [];
  const selfEmploymentExpenses: IncomeItem[] = [];
  const donations: IncomeItem[] = [];
  const rrspContribs: RrspContrib[] = [];
  const fhsaContribs: RrspContrib[] = [];
  const medicalExpenses: IncomeItem[] = [];
  let pensionTotal = D('0');
  const rentalIncome: IncomeItem[] = [];
  const rentalExpenses: IncomeItem[] = [];

  for (const t of txns) {
    const { cad } = await toCad(D(t.amount as unknown as string), t.currency ?? 'CAD', t.date as unknown as string);
    const item: IncomeItem = {
      source: `Txn #${t.id} ${t.finalCategory ?? t.taxTreatmentOverride ?? ''}`,
      amount: D(t.amount as unknown as string),
      cadAmount: cad,
    };
    // Resolve via the transaction's category treatment; fall back to the
    // finalCategory string itself when it is a tax-treatment keyword. This keeps
    // the pre-category snake_case categories (e.g. 'employment_income') working
    // when no Category.taxTreatment / per-txn override is set.
    // Per-txn override wins; otherwise the category's treatment, inherited from
    // ancestors when the category itself is 'none' (resolve by id to honour the
    // hierarchy and dodge same-named-category collisions); finally fall back to
    // the legacy name map for rows with no finalCategoryId.
    let treatment =
      t.taxTreatmentOverride ??
      (t.finalCategoryId != null
        ? inheritedTaxTreatment(catById, t.finalCategoryId)
        : catTreatment.get(t.finalCategory ?? '')) ??
      'none';
    if (treatment === 'none' && t.finalCategory && isTaxTreatment(t.finalCategory)) {
      treatment = t.finalCategory;
    }
    // Corp→personal distributions + payroll (income-queue) fold into the same
    // treatment routing. loan_advance/loan_repayment/not_income are explicitly
    // non-income — skipped before the self-employment fallback so a business-
    // flagged loan leg is never miscounted as SE income.
    if (treatment === 'salary' || treatment === 'employment_income') employmentIncome.push(item);
    else if (treatment === 'eligible_dividend') eligibleDividends.push(item);
    else if (treatment === 'non_eligible_dividend') nonEligibleDividends.push(item);
    else if (treatment === 'donations') donations.push(item);
    else if (treatment === 'loan_advance' || treatment === 'loan_repayment' || treatment === 'not_income') {
      // classified as non-income for the personal T1 — intentionally skipped
    }
    else if (treatment === 'rrsp_contribution') {
      rrspContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if (treatment === 'fhsa_contribution') {
      fhsaContribs.push({ source: item.source, amount: cad.abs(), date: t.date as unknown as string });
    }
    else if (treatment === 'medical_expense') {
      medicalExpenses.push({ ...item, cadAmount: cad.abs(), amount: D(t.amount as unknown as string).abs() });
    }
    else if (treatment === 'pension_income') {
      pensionTotal = pensionTotal.plus(cad);
    }
    else if (treatment === 'rental_income') {
      rentalIncome.push(item);
    }
    else if (treatment === 'rental_expense') {
      rentalExpenses.push({ ...item, cadAmount: cad.abs(), amount: D(t.amount as unknown as string).abs() });
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
  // dispositions. We walk all activity through 30 days past year-end (so the
  // superficial-loss check can see January repurchases for late-December
  // dispositions), then keep only the dispositions that actually settled
  // DURING the tax year.
  const acbFeedEnd = `${year + 1}-01-30`;
  const acbActivity = accountIds.length
    ? await InvestmentActivity.findAll({
        where: {
          accountId: accountIds,
          tradeDate: { [Op.lte]: acbFeedEnd },
        },
      })
    : [];

  const capitalGainEvents: CapGainEvent[] = [];
  const securityIds = Array.from(new Set(acbActivity.map((a) => a.securityId).filter((x): x is number => x != null)));
  for (const sid of securityIds) {
    const acts = acbActivity.filter((a) => a.securityId === sid);
    // CRA requires per-leg FX conversion: each buy/sell/fee leg converts at its
    // own trade-date rate, so the ACB walk — and the CapGainEvent the T1 engine
    // treats as CAD — is genuinely in CAD (proceeds at the sale-date rate, cost
    // base accumulated at acquisition-date rates).
    const acbInput = [];
    for (const a of acts) {
      const currency = (a.currency as string | null) ?? 'CAD';
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
      });
    }
    // s.53(1)(f): a denied superficial loss is added back to the ACB of the
    // substituted (repurchased) shares — deferred, not extinguished. Process
    // loss dispositions chronologically: each denial injects a synthetic
    // acb_adjustment row at the sale date and the walk re-runs, so every
    // subsequent disposition prices against the raised cost base (which can
    // itself create or enlarge later losses — hence the loop). Earlier events
    // are never disturbed: an injection sorts after its sale (huge synthetic
    // id) and only shifts state from that date forward.
    const injected: AcbActivity[] = [];
    const denials = new Map<number, Decimal>();
    const processed = new Set<number>();
    let acb = computeAcb(acbInput);
    for (;;) {
      const next = acb.realizedEvents.find(
        ev => !processed.has(ev.activityId) && ev.qtySold > 0
          && D(ev.proceeds).minus(D(ev.costRemoved)).lessThan(0),
      );
      if (!next) break;
      processed.add(next.activityId);
      const denied = computeDeniedPortion(next, acts, acb.timeline);
      if (denied) {
        denials.set(next.activityId, denied);
        injected.push({
          id: 2_000_000_000 + injected.length,
          activityType: 'acb_adjustment',
          tradeDate: next.tradeDate,
          quantity: null,
          amount: denied.toNumber(),
          currency: 'CAD',
          fees: null,
          splitRatio: null,
        });
        acb = computeAcb([...acbInput, ...injected]);
      }
    }
    for (const realized of acb.realizedEvents) {
      // Prior-year dispositions are already reported on their own year's return;
      // here they only serve to advance the ACB state. Keep just this year's.
      if (realized.tradeDate < yearStart || realized.tradeDate > yearEnd) continue;
      const superficialLossDenied = denials.get(realized.activityId);
      capitalGainEvents.push({
        source: `Security ${sid} sell ${realized.tradeDate}`,
        securityId: sid,
        proceeds: D(realized.proceeds),
        acb: D(realized.costRemoved),
        outlays: D(0),
        date: realized.tradeDate,
        ...(superficialLossDenied ? { superficialLossDenied } : {}),
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

  // T4A box 016 (pension) + box 024 (annuity) → pension income
  const t4aSlips = slipRows.filter(s => s.slipType === 'T4A');
  for (const s of t4aSlips) {
    const boxes = (s.boxValues ?? {}) as Record<string, number | string>;
    const box016 = D(boxes['box016'] ?? boxes['box16'] ?? 0);
    const box024 = D(boxes['box024'] ?? boxes['box24'] ?? 0);
    pensionTotal = pensionTotal.plus(box016).plus(box024);
  }

  // Carryforwards as of prior year
  const cf = await Carryforward.findAll({ where: { entityId, asOfYear: year - 1 } });
  const carryforwards: PersonalCarryforwards = {
    netCapitalLoss: D(cf.find((c) => c.kind === 'cap_loss')?.amount ?? 0),
    rrspRoom: D(cf.find((c) => c.kind === 'rrsp_room')?.amount ?? 0),
    nonCapLoss: D(cf.find((c) => c.kind === 'non_cap_loss')?.amount ?? 0),
    instalmentsPaid: D(cf.find((c) => c.kind === 'instalments_paid')?.amount ?? 0),
    fhsaLifetimeContributions: D(cf.find((c) => c.kind === 'fhsa_lifetime_contribs')?.amount ?? 0),
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
    pensionIncome: pensionTotal.greaterThan(0) ? pensionTotal : undefined,
    medicalExpenses,
    rentalIncome,
    rentalExpenses,
  };
}
