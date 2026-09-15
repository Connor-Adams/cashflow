// backend/src/tax/builders/corpPerimeter.ts
//
// Decides which of a corporation's transactions represent money that actually
// crossed the corporate perimeter — i.e. real revenue and real expenses — as
// opposed to the same dollar moving between the corp's own accounts.
//
// WHY THIS EXISTS
//
// buildCorpFacts used to define active business income as "every transaction
// with finalBusiness = true, summed signed". `finalBusiness` is a spend
// categorisation flag, not a revenue marker, so against real data that summed
// an arbitrary subset of internal transfer legs: revenue that happened to be
// typed `income` was excluded, internal transfers that happened to be flagged
// business were included, and a single receipt was counted once per flagged
// hop.
//
// THE SHAPE OF THE PROBLEM
//
// One customer payment can occupy five rows as it moves inward:
//
//   Wise USD in   "Received money from WANDERCOM"      <- external, unlinked
//   Wise USD out                                       -> linked
//   Wise CAD in   "Converted 5,207.60 USD to 7,125.92" -> linked (FX pair, matched
//                                                         on sourceReference by
//                                                         detectRelationshipsStage)
//   Wise CAD out  "Sent money to CDG Labs Inc."        -> linked to the arrival
//   RBC in        "Misc Payment CDG LABS INC"          <- link TARGET, no back-pointer
//
// Only the first row is revenue. Note the trap: `linkedTransactionId` is
// ONE-DIRECTIONAL, so the final arrival leg is unlinked too. Testing
// `linkedTransactionId == null` alone therefore re-counts the arrival.
//
// THE RULE
//
// A row crossed the perimeter iff it is NEITHER a link source NOR a link
// target. The link-target set must be built from the entity's FULL transaction
// history, not just the fiscal window, because a chain can straddle year end —
// the caller owns that query and passes the set in.
import type { Decimal } from '../util/decimal';
import { D } from '../util/decimal';

/** The transaction fields the perimeter rule needs. */
export interface PerimeterTxn {
  id: number;
  /** Signed, in the account's own currency. Positive = into the corp. */
  amount: string;
  currency: string;
  date: string;
  txnType: string | null;
  /**
   * The owning account's type. Investment accounts keep their income in the
   * InvestmentActivity ledger, which carries the security (and therefore the
   * dividend eligibility); their cash transactions restate the same
   * distribution, so passive rows there are dropped to avoid double-counting.
   */
  accountType: string | null;
  linkedTransactionId: number | null;
  taxTreatmentOverride: string | null;
  merchant: string | null;
}

export interface PerimeterPartition {
  /** External receipts — the active business income candidates. */
  revenue: PerimeterTxn[];
  /** External outgoings that are genuine operating costs. */
  expenses: PerimeterTxn[];
  /**
   * Passive interest earned on non-investment accounts — a corp chequing
   * account paying monthly interest, say. There is no InvestmentActivity row
   * for such an account, so the transaction is the only record of the income;
   * before this bucket existed it was counted nowhere at all.
   */
  interestIncome: PerimeterTxn[];
  /** Passive dividends on non-investment accounts. Same reasoning. */
  dividendIncome: PerimeterTxn[];
  /**
   * Receipts counted as revenue whose external-ness could not be corroborated —
   * see `looksLikeOrphanedArrival`. They ARE included in `revenue`; the warning
   * exists so the number's shakiest inputs are visible on the return.
   */
  warnings: string[];
}

export interface PerimeterOptions {
  /** The entity's legal name, used to spot money "received from itself". */
  legalName: string;
  /**
   * Ids of every transaction that some OTHER transaction of this entity points
   * at via `linkedTransactionId`. Built from the entity's full history.
   */
  linkTargetIds: ReadonlySet<number>;
}

/**
 * Treatments whose rows are consumed elsewhere in buildCorpFacts (dividends
 * paid, remuneration) or are explicitly not income (shareholder loan movements,
 * `not_income`). Counting them here would double-count or invent income.
 */
const NON_OPERATING_TREATMENTS = new Set([
  'eligible_dividend',
  'non_eligible_dividend',
  'salary',
  'employment_income',
  'loan_advance',
  'loan_repayment',
  'not_income',
]);

/**
 * Passive-income row types. Never active business income. On an investment
 * account the InvestmentActivity ledger already reports them; anywhere else
 * (a chequing account paying monthly interest) the transaction is the only
 * record, so it is bucketed as investment income instead of being discarded.
 */
const PASSIVE_TXN_TYPES = new Set(['dividend', 'interest']);

/**
 * Bare deposit words that name no counterparty. A receipt described only as
 * "Deposit" tells us nothing about whether it came from outside.
 */
const ANONYMOUS_MERCHANTS = new Set(['deposit', 'transfer', 'credit', 'payment']);

/** Lowercase, strip punctuation, collapse whitespace. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a perimeter receipt looks like the tail of a transfer chain whose
 * earlier hops were never imported, rather than a genuine external payment.
 *
 * Two signals, both about the counterparty:
 *   1. the merchant names the corporation itself — you do not earn revenue from
 *      your own bank account;
 *   2. the merchant is absent, or is a bare deposit word naming nobody.
 *
 * This only ever drives a warning. It never changes which rows are counted, so
 * a false positive costs a line of noise, not a wrong return.
 */
export function looksLikeOrphanedArrival(txn: PerimeterTxn, legalName: string): boolean {
  const merchant = normalize(txn.merchant ?? '');
  if (merchant === '') return true;
  if (ANONYMOUS_MERCHANTS.has(merchant)) return true;
  const self = normalize(legalName);
  return self !== '' && merchant.includes(self);
}

export function partitionCorpPerimeter(
  txns: readonly PerimeterTxn[],
  { legalName, linkTargetIds }: PerimeterOptions,
): PerimeterPartition {
  const revenue: PerimeterTxn[] = [];
  const expenses: PerimeterTxn[] = [];
  const interestIncome: PerimeterTxn[] = [];
  const dividendIncome: PerimeterTxn[] = [];
  const warnings: string[] = [];

  for (const t of txns) {
    // Internal hop: either it points at another row, or another row points at
    // it. Both directions must be checked — the pointer is one-way.
    if (t.linkedTransactionId !== null) continue;
    if (linkTargetIds.has(t.id)) continue;
    if (t.taxTreatmentOverride !== null && NON_OPERATING_TREATMENTS.has(t.taxTreatmentOverride)) {
      continue;
    }

    const amount: Decimal = D(t.amount);

    // Passive income is settled before the sign split so a reversal nets
    // against the income it reverses rather than posing as an expense.
    if (t.txnType !== null && PASSIVE_TXN_TYPES.has(t.txnType)) {
      if (t.accountType === 'investment') continue;
      if (t.txnType === 'interest') interestIncome.push(t);
      else dividendIncome.push(t);
      continue;
    }

    if (amount.greaterThan(0)) {
      revenue.push(t);
      if (looksLikeOrphanedArrival(t, legalName)) {
        warnings.push(
          `Txn #${t.id} (${t.date}, ${amount.toFixed(2)} ${t.currency}) counted as business income, `
          + 'but it names no external counterparty — it may be the arrival leg of a transfer '
          + 'whose earlier hops are not imported. Verify before filing.',
        );
      }
    } else if (amount.lessThan(0)) {
      // Buying securities moves capital, it does not consume it.
      if (t.txnType === 'investment') continue;
      // An outbound `transfer` is half of a pair by definition; reaching the
      // perimeter means the other half was never imported. That is the corp's
      // own money moving, not a cost — deducting it would understate income.
      // Inbound transfers are NOT symmetric: Wise labels genuine customer
      // payments `transfer`, so those still count as revenue above.
      if (t.txnType === 'transfer') {
        warnings.push(
          `Txn #${t.id} (${t.date}, ${amount.toFixed(2)} ${t.currency}) was NOT deducted as a `
          + 'business expense: it is an outbound transfer whose matching leg is not imported, '
          + 'so it reads as the corp moving its own money rather than spending it.',
        );
        continue;
      }
      expenses.push(t);
    }
  }

  return { revenue, expenses, interestIncome, dividendIncome, warnings };
}
