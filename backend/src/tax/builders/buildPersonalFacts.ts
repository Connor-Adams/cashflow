import { Op } from 'sequelize';
import {
  Account,
  Carryforward,
  Category,
  Entity,
  InvestmentActivity,
  InstalmentPayment,
  Security,
  TaxSlip,
  Transaction,
  TransactionTaxMetadata,
} from '../../models';
import { D, Decimal, sumD } from '../util/decimal';
import type {
  CapGainEvent,
  IncomeItem,
  PersonalCarryforwards,
  RrspContrib,
  SlipFact,
  TaxYearFacts,
} from '../engine/types';
import { computeAcb, type AcbActivity, type AcbRealizedEvent } from '../../portfolio/acb';
import { resolveTaxTreatment } from './resolveTaxTreatment';
import { createCadConverter } from '../completeness/cadConverter';
import { dividendDedupDays } from '../../config/env';
import { resolveDeductiblePercent } from '../util/deductiblePercent';
import { parseSlipAmount } from '../util/parseSlipAmount';
import { hasSingleCorp, isOwnerPaidCorpExpense } from './ownerPaidCorpExpense';
import { resolveEntityPerson } from '../services/personalEntityOwner';

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

/**
 * Collapse the two legs of one internal contribution transfer into one.
 *
 * Both legs live in the same entity — the funding account's outflow and the
 * registered account's inflow — and both collect as an absolute amount, so
 * counting both deducts the contribution twice. When a pair is linked and both
 * sides carry the treatment, keep the outflow: that is the leg that represents
 * money committed, and it is the one that exists whether or not the registered
 * side was ever imported.
 *
 * A leg tagged on its own is always kept, linked or not — the user may only have
 * classified one side, and dropping it would lose a real deduction.
 */
function dedupeLinkedContribs<T extends { txnId: number; linkedId: number | null; positive: boolean }>(
  rows: T[],
): Omit<T, 'txnId' | 'linkedId' | 'positive'>[] {
  const present = new Set(rows.map((r) => r.txnId));
  const kept = rows.filter(
    (r) => !(r.positive && r.linkedId != null && r.linkedId !== r.txnId && present.has(r.linkedId)),
  );
  // Never drop every leg. Two mutually-linked positive rows, or a row linked to
  // itself, would otherwise cancel the deduction entirely — silently deleting a
  // real claim is far worse than counting one leg too many.
  const survivors = kept.length > 0 ? kept : rows.slice(0, 1);
  return survivors.map(({ txnId: _t, linkedId: _l, positive: _p, ...rest }) => rest);
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

  // Memoised, and a missing rate degrades to the unconverted amount plus a
  // warning instead of throwing — raw `toCad` 500'd the whole return.
  const factWarnings: string[] = [];
  const convert = createCadConverter({
    onUnavailable: (currency, date) => {
      factWarnings.push(
        `No ${currency}→CAD exchange rate for ${date}; ${currency} amounts on that date `
        + 'were used unconverted. Add the rate and recompute.',
      );
    },
  });
  const toCad = async (amount: Decimal, currency: string, date: string) => ({
    cad: await convert(amount, currency, date),
  });

  // With exactly one corporation, buildCorpFacts deducts owner-paid business
  // costs on the T2. Routing them to self-employment expenses as well deducted
  // the same dollar on both returns.
  const corpOwnsOwnerPaid = await hasSingleCorp(entity.householdId);

  // Deductible percent for business rows (meals at 50%, …). One query, keyed by id.
  const businessTxnIds = txns.filter((t) => t.finalBusiness).map((t) => t.id as number);
  const taxMeta = businessTxnIds.length
    ? await TransactionTaxMetadata.findAll({
        where: { transactionId: { [Op.in]: businessTxnIds } },
        attributes: ['transactionId', 'deductiblePercent'],
      })
    : [];
  const deductibleById = new Map(taxMeta.map((m) => [m.transactionId, m.deductiblePercent]));

  const employmentIncome: IncomeItem[] = [];
  const eligibleDividends: IncomeItem[] = [];
  const nonEligibleDividends: IncomeItem[] = [];
  const selfEmploymentIncome: IncomeItem[] = [];
  const selfEmploymentExpenses: IncomeItem[] = [];
  const donations: IncomeItem[] = [];
  /**
   * Contributions carry their transaction id and link so the two legs of one
   * internal transfer can be collapsed afterwards. A chequing→FHSA contribution
   * has a leg on each account inside the same entity — the brokerage cash mirror
   * made that shape common — and both collect as `cad.abs()`, so tagging both
   * would deduct the money twice.
   */
  type ContribRow = RrspContrib & { txnId: number; linkedId: number | null; positive: boolean };
  const rrspContribRows: ContribRow[] = [];
  const fhsaContribRows: ContribRow[] = [];
  const medicalExpenses: IncomeItem[] = [];
  let pensionTxnTotal = D('0');
  const rentalIncome: IncomeItem[] = [];
  const rentalExpenses: IncomeItem[] = [];
  /**
   * Transactions the treatment loop below routed to a real tax line. The txnType
   * pass further down must skip these or the row is counted twice — and as the
   * wrong character, since that pass files every `dividend` as eligible.
   */
  const classifiedTxnIds = new Set<number>();

  for (const t of txns) {
    const { cad } = await toCad(D(t.amount as unknown as string), t.currency ?? 'CAD', t.date as unknown as string);
    const item: IncomeItem = {
      source: `Txn #${t.id} ${t.finalCategory ?? t.taxTreatmentOverride ?? ''}`,
      amount: D(t.amount as unknown as string),
      cadAmount: cad,
    };
    // Four routes, override first — see `resolveTaxTreatment`. Shared with the
    // duplicate detector, which must ask "is this row classified?" with this exact
    // ladder: three of the four routes leave `taxTreatmentOverride` null, so the
    // obvious shortcut would report a categorised row as untouched.
    const treatment = resolveTaxTreatment(t, { catById, catTreatment });
    if (treatment !== 'none') classifiedTxnIds.add(t.id as number);
    // Corp→personal distributions + payroll (income-queue) fold into the same
    // treatment routing. loan_advance/loan_repayment/not_income are explicitly
    // non-income — skipped before the self-employment fallback so a business-
    // flagged loan leg is never miscounted as SE income.
    if (treatment === 'salary' || treatment === 'employment_income') employmentIncome.push(item);
    else if (treatment === 'eligible_dividend') eligibleDividends.push(item);
    else if (treatment === 'non_eligible_dividend') nonEligibleDividends.push(item);
    // Charges are negative in this app; the credit is on the amount given.
    else if (treatment === 'donations') donations.push({ ...item, cadAmount: cad.abs(), amount: item.amount.abs() });
    else if (
      treatment === 'loan_advance' || treatment === 'loan_repayment'
      || treatment === 'not_income' || treatment === 'expense_reimbursement'
    ) {
      // classified as non-income for the personal T1 — intentionally skipped.
      // `expense_reimbursement` MUST be listed here rather than left to fall
      // through: the final branch routes any business-flagged positive row to
      // self-employment income, and a reimbursement is exactly that shape.
    }
    else if (treatment === 'rrsp_contribution') {
      rrspContribRows.push({
        source: item.source, amount: cad.abs(), date: t.date as unknown as string,
        txnId: t.id as number, linkedId: t.linkedTransactionId ?? null, positive: cad.greaterThan(0),
      });
    }
    else if (treatment === 'fhsa_contribution') {
      fhsaContribRows.push({
        source: item.source, amount: cad.abs(), date: t.date as unknown as string,
        txnId: t.id as number, linkedId: t.linkedTransactionId ?? null, positive: cad.greaterThan(0),
      });
    }
    // Expenses by sign: a charge (negative) adds to the claim, a refund (positive)
    // reduces it. abs() turned every refund into more expense.
    else if (treatment === 'medical_expense') {
      medicalExpenses.push({ ...item, cadAmount: cad.negated(), amount: item.amount.negated() });
    }
    else if (treatment === 'pension_income') {
      pensionTxnTotal = pensionTxnTotal.plus(cad);
    }
    else if (treatment === 'rental_income') {
      rentalIncome.push(item);
    }
    else if (treatment === 'rental_expense') {
      rentalExpenses.push({ ...item, cadAmount: cad.negated(), amount: item.amount.negated() });
    }
    else if (t.finalBusiness) {
      const isRefund = t.txnType === 'refund';
      if (corpOwnsOwnerPaid && (isOwnerPaidCorpExpense(t) || isRefund)) {
        // The corporation's cost (and so its refund) — on the T2, not here.
      } else if (cad.greaterThan(0) && !isRefund) {
        selfEmploymentIncome.push(item);
      } else if (!cad.isZero()) {
        // A charge or a refund of one, netted by sign: the expense is the negated
        // amount, so a refund comes through as a negative expense.
        const share = myShareFraction(t);
        const pct = resolveDeductiblePercent(deductibleById.get(t.id as number), true);
        const factor = share.times(pct);
        selfEmploymentExpenses.push({
          ...item,
          source: pct < 1 ? `${item.source} (${Math.round(pct * 100)}% deductible)` : item.source,
          cadAmount: cad.negated().times(factor),
          amount: item.amount.negated().times(factor),
        });
      }
    }
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

  // Route a dividend-type item by Security.dividendEligibility.
  //
  // `Security.dividendEligibility` is `allowNull: false` with `defaultValue:
  // 'eligible'` (models/Security.ts:165-170), so there is no "unknown" state to
  // default differently — every security carries a concrete value. A plan item
  // once called for defaulting unknown to non-eligible; that item was withdrawn,
  // because the default is right for the common case: dividends from a publicly
  // traded Canadian corporation ARE eligible, and flipping it would misclassify
  // most securities to fix none.
  //
  // The real exposure is an ETF distribution, which is a mix of eligible
  // dividends, foreign income, other income, return of capital and capital gains.
  // That is a composition problem the eligibility flag cannot express, and it
  // belongs in the completeness gate as an unverified-eligibility gap.
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

  // Passive income earned on accounts the InvestmentActivity ledger does not
  // cover — a chequing or savings account paying monthly interest is the common
  // case. There is no activity row for such an account, so the transaction is
  // the only record of the income and it was previously reported nowhere.
  //
  // Two exclusions, mirroring the corp-side rule in corpPerimeter.ts:
  //   - investment accounts: the activity ledger already reports the same
  //     distribution and carries the security (hence the eligibility), so
  //     counting the cash transaction too would double it;
  //   - anything outside `taxableAccounts`: earnings inside a TFSA/RRSP/FHSA/
  //     RDSP never belong on the taxable return. `txns` is keyed on entityId,
  //     not account, so registered rows ARE in scope here and must be dropped.
  //
  // A transaction carries no security, so a dividend sourced this way takes the
  // same 'eligible' default `pushDividend` applies when eligibility is unknown.
  const taxableAccountTypeById = new Map(
    taxableAccounts.map((a) => [a.id, a.accountType ?? null]),
  );
  // Treatments that mean "this credit is not income", matching the routing the
  // main transaction loop above already applies. `not_income` is how card
  // cash-back is tagged: Wealthsimple posts its rewards on the chequing ledger
  // worded "Interest earned", but a purchase rebate is not taxable income.
  const NOT_INCOME_TREATMENTS = new Set([
    'not_income', 'loan_advance', 'loan_repayment', 'expense_reimbursement',
  ]);
  for (const t of txns) {
    const txnType = (t as unknown as { txnType?: string | null }).txnType ?? null;
    if (txnType !== 'interest' && txnType !== 'dividend') continue;
    // A row the treatment loop above already routed must not be counted again
    // here. The guard used to list only the four NOT_INCOME treatments, so every
    // INCOME treatment fell through and was counted twice — and a `dividend`
    // txnType was added as ELIGIBLE, so an owner's non-eligible draw picked up an
    // eligible gross-up and credit on the second pass. Inverting the test means a
    // treatment added later cannot reintroduce the bug.
    if (classifiedTxnIds.has(t.id as number)) continue;
    if (t.taxTreatmentOverride !== null && NOT_INCOME_TREATMENTS.has(t.taxTreatmentOverride)) {
      continue;
    }
    if (!taxableAccountTypeById.has(t.accountId)) continue;
    if (taxableAccountTypeById.get(t.accountId) === 'investment') continue;
    const raw = D(t.amount as unknown as string);
    const { cad } = await toCad(raw, t.currency ?? 'CAD', t.date as unknown as string);
    const item: IncomeItem = {
      source: `Txn #${t.id} ${t.merchantClean ?? t.merchantRaw ?? ''}`.trim(),
      amount: raw,
      cadAmount: cad,
    };
    if (txnType === 'interest') interestIncome.push(item);
    else eligibleDividends.push(item);
  }

  // Capital gain events from sells, using the ACB helper.
  //
  /**
   * Cost-base warnings the ACB walk raises. Accumulated across securities and
   * de-duplicated on the way out; previously computed and thrown away.
   */
  const acbWarnings: string[] = [];

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
        costBasisAllocationPct:
          a.costBasisAllocationPct != null ? Number(a.costBasisAllocationPct) : null,
        cashComponent: a.cashComponent != null ? Number(a.cashComponent) : null,
        recipientSecurityId: a.recipientSecurityId ?? null,
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
    // Kept rather than discarded: these say the cost base a capital gain was priced
    // against is uncertain, which is exactly what a completeness report exists to say.
    acbWarnings.push(...acb.warnings);
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
    // The loop above re-runs computeAcb on each superficial-loss injection, so take
    // the final walk's warnings too; duplicates are collapsed at the end.
    acbWarnings.push(...acb.warnings);
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

  // Slips. Box values are typed in by hand from the paper slip ("1,200.50");
  // an unparseable one is dropped with a warning rather than failing the return.
  const slipRows = await TaxSlip.findAll({ where: { entityId, year } });
  const slips: SlipFact[] = slipRows.map((s) => {
    const boxes: Record<string, Decimal> = {};
    for (const [k, v] of Object.entries((s.boxValues ?? {}) as Record<string, unknown>)) {
      const parsed = parseSlipAmount(v);
      if (parsed) boxes[k] = parsed;
      else factWarnings.push(`Slip ${s.slipType} #${s.id} ${k}: "${String(v)}" is not a number and was ignored.`);
    }
    return { slipId: s.id, slipType: s.slipType as SlipFact['slipType'], issuer: s.issuer, boxes };
  });

  // T4A box 016 (pension) + box 024 (annuity) → pension income. The slip is the
  // authoritative figure: when one carries pension, pension_income transactions
  // are the same money arriving and are not added on top (as for T5 interest).
  let slipPension = D('0');
  for (const s of slips.filter((x) => x.slipType === 'T4A')) {
    const box016 = s.boxes['box016'] ?? s.boxes['box16'] ?? D('0');
    const box024 = s.boxes['box024'] ?? s.boxes['box24'] ?? D('0');
    slipPension = slipPension.plus(box016).plus(box024);
  }
  const pensionTotal = slipPension.greaterThan(0) ? slipPension : pensionTxnTotal;

  // Carryforwards as of prior year
  const cf = await Carryforward.findAll({ where: { entityId, asOfYear: year - 1 } });
  const carryforwards: PersonalCarryforwards = {
    netCapitalLoss: D(cf.find((c) => c.kind === 'cap_loss')?.amount ?? 0),
    rrspRoom: D(cf.find((c) => c.kind === 'rrsp_room')?.amount ?? 0),
    nonCapLoss: D(cf.find((c) => c.kind === 'non_cap_loss')?.amount ?? 0),
    instalmentsPaid: D(cf.find((c) => c.kind === 'instalments_paid')?.amount ?? 0),
    fhsaLifetimeContributions: D(cf.find((c) => c.kind === 'fhsa_lifetime_contribs')?.amount ?? 0),
    // Written by the roll and, until now, never read — so the FHSA deduction was
    // capped at one year's annual limit and a carried-forward year was lost.
    fhsaRoom: D(cf.find((c) => c.kind === 'fhsa_room')?.amount ?? 0),
  };

  // Phase 4: override instalmentsPaid from InstalmentPayment ledger rows for this year
  const instalments = await InstalmentPayment.findAll({ where: { entityId, year } });
  if (instalments.length > 0) {
    carryforwards.instalmentsPaid = sumD(instalments.map((p) => D(p.amount as unknown as string)));
  }

  // Age at Dec 31 of the person this entity is filed for — resolved through
  // account ownership, not whichever household member the database returns
  // first. Every birthday has passed by Dec 31, so it is the year difference.
  let ageAtYearEnd = 0;
  const person = await resolveEntityPerson(entity);
  if (person?.dob) {
    ageAtYearEnd = Math.max(0, year - parseInt(person.dob.slice(0, 4), 10));
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
    rrspContribs: dedupeLinkedContribs(rrspContribRows),
    fhsaContribs: dedupeLinkedContribs(fhsaContribRows),
    donations,
    slips,
    carryforwards,
    ageAtYearEnd,
    pensionIncome: pensionTotal.greaterThan(0) ? pensionTotal : undefined,
    medicalExpenses,
    rentalIncome,
    rentalExpenses,
    acbWarnings: [...new Set(acbWarnings)],
    factWarnings,
  };
}

/**
 * The fraction of a transaction that is the filer's own: `my_share_amount` over
 * `amount`, so a split with a partner deducts only this person's half. A zero
 * share is the column default, so it means "never computed" (count in full)
 * unless the row is explicitly the partner's.
 */
function myShareFraction(t: Transaction): Decimal {
  const amount = D((t.amount as unknown as string) ?? 0);
  const mine = D((t.myShareAmount as unknown as string) ?? 0);
  if (mine.isZero() && t.finalSplitType === 'partner') return D('0');
  if (amount.isZero() || mine.isZero()) return D('1');
  return Decimal.min(D('1'), Decimal.max(D('0'), mine.dividedBy(amount)));
}
