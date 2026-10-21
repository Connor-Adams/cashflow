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
   * Outbound transfers whose matching leg was never imported — reported, and
   * deliberately in NO other bucket: deducting them would understate income.
   *
   * Exposed structurally because part 3's completeness gate needs exactly this
   * population as a blocker, and the two obvious ways to re-derive it are both
   * wrong. "Unlinked" fails because the pointer is one-directional, so every
   * arrival leg qualifies. "Neither a link source nor a link target" — which reads
   * like the right condition — means *is real revenue or a real expense* in this
   * file: the healthy outcome, so it would flag every third-party corp outgoing.
   * Reading this function's own verdict is the only way to agree with it.
   */
  unimportedOutboundTransfers: PerimeterTxn[];
  /**
   * Inbound rows typed as the corp's own money moving (`transfer`, `payment`,
   * `investment`) whose other leg is not imported or not linked. Not revenue —
   * the mirror of `unimportedOutboundTransfers` — and each one warns, because a
   * genuine receipt mistyped `transfer` would silently understate income.
   */
  unimportedInboundTransfers: PerimeterTxn[];
  /**
   * Receipts counted as revenue whose external-ness could not be corroborated —
   * see `looksLikeOrphanedArrival`. They ARE included in `revenue`; the warning
   * exists so the number's shakiest inputs are visible on the return.
   */
  warnings: string[];
}

/**
 * A cash movement recorded in the brokerage ledger rather than as a
 * transaction: `transfer_in` / `transfer_out` on an investment account. Signed
 * from the brokerage's point of view, so a deposit is positive.
 */
export interface InternalCashMove {
  date: string;
  /** Signed, in the investment account's own currency. */
  amount: string;
  currency: string;
}

export interface PerimeterOptions {
  /** The entity's legal name, used to spot money "received from itself". */
  legalName: string;
  /**
   * Ids of every transaction that some OTHER transaction of this entity points
   * at via `linkedTransactionId`. Built from the entity's full history.
   */
  linkTargetIds: ReadonlySet<number>;
  /**
   * Cash movements on the entity's investment accounts.
   *
   * `linkedTransactionId` is a foreign key into transactions, so a transfer
   * between a bank account and a brokerage can NEVER be linked — the far side
   * is an InvestmentActivity row. The money is tracked, just in the other
   * ledger, so a transfer that matches one of these is internal and needs no
   * warning. Matching is greedy and 1:1, so one deposit cannot explain two
   * transfers.
   */
  internalCashMoves?: readonly InternalCashMove[];
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
  // Repaying the owner for a cost they fronted returns money already spent.
  // The underlying purchase is what the corp deducts (see the personal-card
  // expense pass in buildCorpFacts); deducting the repayment too would double
  // the same dollar.
  'expense_reimbursement',
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

/**
 * Inbound types that say the money was the corp's own, not a payer's: a
 * transfer between its accounts, a card payment received, or sale proceeds of
 * its own investments. The outbound side of each is already excluded from
 * expenses for the same reason (see the negative branch below).
 *
 * Until 2026-10 an inbound `transfer` WAS counted as revenue, only because Wise
 * labelled every customer payment `transfer`. detect-type's entity rule now
 * types those `income` ("Received money from <client>" onto a corp account), so
 * the exception has no reason left and the rule is symmetric.
 */
const OWN_MONEY_INBOUND_TYPES = new Set(['transfer', 'payment', 'investment']);

/** Days a bank transfer and its brokerage settlement may legitimately differ by. */
const CASH_MOVE_WINDOW_DAYS = 3;

function daysApart(a: string, b: string): number {
  const ms = new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(Math.round(ms / 86400000));
}

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

type Bucket = Exclude<keyof PerimeterPartition, 'warnings'>;

/** Where a perimeter row lands, plus the warning it raises, if any. */
type Verdict = { bucket: Bucket | null; warning?: string };

function money(t: PerimeterTxn, amount: Decimal): string {
  return `Txn #${t.id} (${t.date}, ${amount.toFixed(2)} ${t.currency})`;
}

/** Passive income is settled before the sign split so a reversal nets against it. */
function passiveVerdict(t: PerimeterTxn): Verdict | null {
  if (t.txnType === null || !PASSIVE_TXN_TYPES.has(t.txnType)) return null;
  if (t.accountType === 'investment') return { bucket: null };
  return { bucket: t.txnType === 'interest' ? 'interestIncome' : 'dividendIncome' };
}

function inboundVerdict(t: PerimeterTxn, amount: Decimal, legalName: string): Verdict {
  // A refund returns money the corp spent: it reduces the expense, it is not
  // income. Same rule as the T1's business rows, which net a refund against
  // expenses and leave an owner-paid corp refund to the T2
  // (buildPersonalFacts.ts), and as the tax reserve (taxReserve.ts
  // classifyReserveFlow). Expenses are summed signed, so a positive row in that
  // bucket nets off.
  if (t.txnType === 'refund') return { bucket: 'expenses' };
  if (t.txnType !== null && OWN_MONEY_INBOUND_TYPES.has(t.txnType)) {
    return {
      bucket: 'unimportedInboundTransfers',
      warning:
        `${money(t, amount)} was NOT counted as business income: it is typed ${t.txnType}, `
        + "i.e. the corp's own money arriving, and its other leg is not linked. "
        + 'If it is really a customer payment, retype it income.',
    };
  }
  return {
    bucket: 'revenue',
    warning: looksLikeOrphanedArrival(t, legalName)
      ? `${money(t, amount)} counted as business income, `
        + 'but it names no external counterparty — it may be the arrival leg of a transfer '
        + 'whose earlier hops are not imported. Verify before filing.'
      : undefined,
  };
}

function outboundVerdict(t: PerimeterTxn, amount: Decimal): Verdict {
  // Buying securities moves capital, it does not consume it.
  if (t.txnType === 'investment') return { bucket: null };
  // An outbound `transfer` is half of a pair by definition; reaching the
  // perimeter means the other half was never imported. That is the corp's own
  // money moving, not a cost — deducting it would understate income. Inbound
  // own-money rows are handled symmetrically in inboundVerdict.
  if (t.txnType === 'transfer') {
    return {
      bucket: 'unimportedOutboundTransfers',
      warning:
        `${money(t, amount)} was NOT deducted as a `
        + 'business expense: it is an outbound transfer whose matching leg is not imported, '
        + 'so it reads as the corp moving its own money rather than spending it.',
    };
  }
  return { bucket: 'expenses' };
}

/**
 * Greedy 1:1 — a movement, once used to explain a transfer, cannot explain
 * another. Matched on the OPPOSITE sign: cash leaving the bank arrives at the
 * brokerage as a positive deposit.
 */
function cashMoveClaimer(internalCashMoves: readonly InternalCashMove[]) {
  const unclaimed = internalCashMoves.map((m) => ({ move: m, claimed: false }));
  const matches = (candidate: (typeof unclaimed)[number], t: PerimeterTxn, amount: Decimal) =>
    !candidate.claimed
    && candidate.move.currency === t.currency
    && D(candidate.move.amount).plus(amount).isZero()
    && daysApart(candidate.move.date, t.date) <= CASH_MOVE_WINDOW_DAYS;
  return (t: PerimeterTxn, amount: Decimal): boolean => {
    const entry = unclaimed.find((candidate) => matches(candidate, t, amount));
    if (entry) entry.claimed = true;
    return entry != null;
  };
}

/** Internal hop (either direction of the one-way pointer) or a non-operating treatment. */
function outsidePerimeter(t: PerimeterTxn, linkTargetIds: ReadonlySet<number>): boolean {
  if (t.linkedTransactionId !== null || linkTargetIds.has(t.id)) return true;
  return t.taxTreatmentOverride !== null && NON_OPERATING_TREATMENTS.has(t.taxTreatmentOverride);
}

export function partitionCorpPerimeter(
  txns: readonly PerimeterTxn[],
  { legalName, linkTargetIds, internalCashMoves = [] }: PerimeterOptions,
): PerimeterPartition {
  const claimMatchingCashMove = cashMoveClaimer(internalCashMoves);
  const out: PerimeterPartition = {
    revenue: [],
    expenses: [],
    interestIncome: [],
    dividendIncome: [],
    unimportedOutboundTransfers: [],
    unimportedInboundTransfers: [],
    warnings: [],
  };
  const verdictFor = (t: PerimeterTxn, amount: Decimal): Verdict => {
    const passive = passiveVerdict(t);
    if (passive) return passive;
    // Cash returning from, or going to, the brokerage is the corp's own money;
    // the far side is in the InvestmentActivity ledger, so nothing to flag.
    // Outbound, only a `transfer` may claim a movement.
    const mayClaim = amount.greaterThan(0) || t.txnType === 'transfer';
    if (mayClaim && claimMatchingCashMove(t, amount)) return { bucket: null };
    return amount.greaterThan(0) ? inboundVerdict(t, amount, legalName) : outboundVerdict(t, amount);
  };

  for (const t of txns) {
    if (outsidePerimeter(t, linkTargetIds)) continue;
    const amount: Decimal = D(t.amount);
    if (amount.isZero()) continue;
    const verdict = verdictFor(t, amount);
    if (verdict.bucket != null) out[verdict.bucket].push(t);
    if (verdict.warning) out.warnings.push(verdict.warning);
  }
  return out;
}
