import { D, type Decimal } from '../util/decimal';
import { addNonEligibleDividend, estimateTaxImpact } from './estimateTaxImpact';
import {
  BROKERAGE_CASH_LEG_ACCOUNT_IDS,
  BROKERAGE_CASH_LEG_ACTIVITY_TYPES,
} from '../../import/wsDepositActivityMigration';
import type { ActivityRow, CompletenessContext, CompletenessItem } from './types';

const OPT_IN_ACCOUNTS = new Set<number>(BROKERAGE_CASH_LEG_ACCOUNT_IDS);

function sumAbs(amounts: readonly string[]): string {
  return amounts.reduce((acc, a) => acc.plus(D(a).abs()), D('0')).toFixed(2);
}

/** Sums the CAD-converted amounts. 2026 holds 30 USD transfers; `amount` is not CAD. */
function sumAbsCad(rows: readonly { cadAmount: Decimal }[]): string {
  return rows.reduce((acc, r) => acc.plus(r.cadAmount.abs()), D('0')).toFixed(2);
}

// ---------------------------------------------------------------------------
// Blockers — boundable missing money, clearable by scheduled work, silent on a
// healthy ledger.
// ---------------------------------------------------------------------------

/**
 * Corp→personal transfers in the period that no route classifies.
 *
 * The structural half of the predicate is the classification queue's
 * (`routes/tax.ts:55-79`): a personal leg, `txnType: 'transfer'`, linked, whose
 * counterpart belongs to a corp entity. The classified half is NOT the queue's —
 * see `CompletenessTxn.isTaxClassified`.
 *
 * Priced, unlike the other two blockers, because the money demonstrably reached
 * Connor — that is what a linked personal leg means. This is the $42,000 backlog that
 * was worth ~$4,227 of tax.
 *
 * But the estimate assumes non-eligible dividend treatment, and the assumption is
 * stated in the detail rather than left implicit. An unclassified draw could be a
 * loan advance or an expense reimbursement, neither of which is income, so the figure
 * is an upper bound. That disclosure is the same discipline that leaves the other two
 * blockers unpriced: a number is allowed only with its basis attached.
 */
export function detectUnclassifiedCorpDraws(ctx: CompletenessContext): CompletenessItem[] {
  const rows = ctx.personalTxns.filter(
    (t) => t.txnType === 'transfer'
      && t.linkedTransactionId !== null
      && t.counterpartIsCorp
      && !t.isTaxClassified,
  );
  if (rows.length === 0) return [];

  const amount = sumAbsCad(rows);
  return [{
    kind: 'unclassified_corp_draws',
    severity: 'blocker',
    title: `${rows.length} corp→personal transfer${rows.length === 1 ? '' : 's'} not classified`,
    detail:
      `$${amount} moved from the corporation to you in ${ctx.year} and is not on the return. `
      + 'Classify each as a dividend, salary, loan or reimbursement. The tax figure '
      + 'assumes all of it is a non-eligible dividend, which is what every classified '
      + 'draw resolves to — a loan advance or an expense reimbursement is not income at '
      + 'all, so the figure is an upper bound until these are classified.',
    amount,
    taxEstimate: estimateTaxImpact(ctx.facts, ctx.rates, addNonEligibleDividend(amount)),
    fix: { surface: 'classify', label: 'Classify these draws' },
    references: rows.map((t) => t.id),
  }];
}

/**
 * Outbound corp transfers whose matching leg was never imported.
 *
 * Reads `partitionCorpPerimeter`'s own verdict — the two obvious re-derivations are
 * both wrong, and that function documents why.
 *
 * **States its amount and no tax estimate, deliberately.** Such a transfer may be a
 * draw, an internal move between corp accounts, or a third-party payment. Pricing it
 * on the personal T1 would assume it reached Connor, and a fabricated figure is worse
 * than none — the reasoning that demoted two other items to gaps during design.
 *
 * The one place `buildCompletenessReport` reads CORP-entity rows while running for
 * the personal entity. That reach is the point: a draw that never arrived is
 * invisible from the personal side alone.
 */
export function detectUnimportedOutboundTransfers(ctx: CompletenessContext): CompletenessItem[] {
  const rows = ctx.unimportedOutboundTransfers;
  if (rows.length === 0) return [];

  const amount = sumAbs(rows.map((t) => t.amount));
  return [{
    kind: 'unimported_outbound_corp_transfer',
    severity: 'blocker',
    title: `${rows.length} corp transfer${rows.length === 1 ? '' : 's'} with no imported counterpart`,
    detail:
      `$${amount} left the corporation in ${ctx.year} with nothing recording where it went. `
      + 'No tax figure is shown: it may be a draw, a move between corp accounts, or a '
      + 'payment to someone else, and guessing which would put an invented number on '
      + 'your return. Import the other side, or classify these rows.',
    amount,
    taxEstimate: null,
    fix: { surface: 'import', label: 'Import the matching statements' },
    references: rows.map((t) => t.id),
  }];
}

const isCashLeg = (a: ActivityRow): boolean => a.securityId === null && a.amount !== null;

/**
 * Cash-leg activities with no transaction that part 1a's migration WOULD convert:
 * an allowlisted type on an account in the opt-in set.
 *
 * Boundable exactly — the activity carries its own amount — and clearable by running
 * that migration, so it is a blocker. Empty once 1a has been run, which is the point.
 *
 * **No tax estimate**, on the same ground as the outbound blocker: a deposit into a
 * personal brokerage may be a corp draw or Connor's own money, and pricing it as a
 * dividend assumes the former. The spec's testing section implies this blocker
 * carries an estimate; that instruction contradicts the spec's own rule about
 * inventing figures, and the rule wins.
 */
export function detectConvertibleCashLegs(ctx: CompletenessContext): CompletenessItem[] {
  const rows = ctx.activities.filter(
    (a) => !a.hasTransaction
      && isCashLeg(a)
      && OPT_IN_ACCOUNTS.has(a.accountId)
      && BROKERAGE_CASH_LEG_ACTIVITY_TYPES.has(a.activityType),
  );
  if (rows.length === 0) return [];

  const amount = sumAbs(rows.map((a) => a.amount as string));
  return [{
    kind: 'convertible_cash_leg_activity',
    severity: 'blocker',
    title: `${rows.length} brokerage cash movement${rows.length === 1 ? '' : 's'} not in the ledger`,
    detail:
      `$${amount} of cash moved through your brokerage in ${ctx.year} and exists only as `
      + 'brokerage activity, not as a transaction. Run the cash-leg migration to convert '
      + 'these. No tax figure is shown because the money\'s character is not known from '
      + 'the activity alone.',
    amount,
    taxEstimate: null,
    fix: { surface: 'import', label: 'Convert brokerage cash legs' },
    references: rows.map((a) => a.id),
  }];
}

// ---------------------------------------------------------------------------
// Gaps — correctness risks of unknown size.
// ---------------------------------------------------------------------------

/** Accounts whose activity is event-driven are never flagged for going quiet. */
const EVENT_DRIVEN_ACCOUNT_TYPES = new Set(['investment', 'savings']);

/**
 * An account that was posting regularly and then went quiet.
 *
 * A **gap**, never a blocker, and this is the third attempt at it: the first two
 * tried to make it a blocker and failed the same way. A blocker must name boundable
 * missing money, and bounding a truncated import needs a run rate — over a window
 * that may simply be quiet. That is a fabricated number.
 *
 * **No figure at all**, for the same reason.
 *
 * Reported ONCE as export lag when every active account stops around the same recent
 * date, per Connor's own data-status doctrine: N per-account gaps for one lagging
 * export is noise that trains the reader to dismiss the panel.
 */
export function detectTruncatedImports(ctx: CompletenessContext): CompletenessItem[] {
  const watched = ctx.accounts.filter(
    (a) => a.closedAt === null
      && a.mergedIntoId === null
      && !EVENT_DRIVEN_ACCOUNT_TYPES.has(a.accountType),
  );
  const lastByAccount = new Map<number, string>();
  for (const t of ctx.personalTxns) {
    const prev = lastByAccount.get(t.accountId);
    if (prev === undefined || t.date > prev) lastByAccount.set(t.accountId, t.date);
  }

  const quiet = watched
    .map((a) => ({ account: a, last: lastByAccount.get(a.id) }))
    .filter((x): x is { account: typeof watched[number]; last: string } => x.last !== undefined)
    .filter((x) => daysBetween(x.last, ctx.now) >= QUIET_DAYS);
  if (quiet.length === 0) return [];

  // Every watched account quiet, and clustered within a fortnight of each other →
  // one export-lag item rather than N.
  const active = watched.filter((a) => lastByAccount.has(a.id));
  const dates = quiet.map((q) => q.last).sort();
  const clustered = quiet.length === active.length
    && active.length > 1
    && daysBetweenDates(dates[0], dates[dates.length - 1]) <= 14;

  if (clustered) {
    return [{
      kind: 'export_lag',
      severity: 'gap',
      title: 'Every account stops at about the same date',
      detail:
        `The most recent transaction on any account is ${dates[dates.length - 1]}. That pattern `
        + 'is usually export lag rather than a missing statement — check whether a download '
        + 'is outstanding.',
      amount: null,
      taxEstimate: null,
      fix: { surface: 'import', label: 'Import recent statements' },
      references: active.map((a) => a.id),
    }];
  }

  return quiet.map(({ account, last }) => ({
    kind: 'truncated_import',
    severity: 'gap' as const,
    title: `${account.name} last posted ${last}`,
    detail:
      `${account.name} has posted nothing since ${last} (${daysBetween(last, ctx.now)} days). `
      + 'Check whether a statement is missing. No figure is shown: bounding this would need '
      + 'a run rate over a window that may simply be quiet.',
    amount: null,
    taxEstimate: null,
    fix: { surface: 'import', label: `Import ${account.name}` },
    references: [account.id],
  }));
}

const QUIET_DAYS = 45;

function daysBetween(isoDate: string, now: Date): number {
  return daysBetweenDates(isoDate, now.toISOString().slice(0, 10));
}

function daysBetweenDates(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

/**
 * Cash-leg activities part 1a does NOT convert: an allowlisted type on an account
 * outside the opt-in set, or a non-allowlisted type (`interest`, `fee`, bare
 * `transfer`) inside it.
 *
 * A gap, because nothing in this plan converts them. The bare-`transfer` case on an
 * opt-in brokerage account is the most tax-relevant residue in the whole set — 1a
 * declines to auto-convert it precisely because it might be a draw — so it must be
 * visible even though it is not a blocker.
 *
 * Carries its amount (the activity states it) and no tax estimate (its character is
 * exactly what is unknown).
 */
export function detectOrphanedCashLegs(ctx: CompletenessContext): CompletenessItem[] {
  const rows = ctx.activities.filter((a) => {
    if (a.hasTransaction || !isCashLeg(a)) return false;
    const optIn = OPT_IN_ACCOUNTS.has(a.accountId);
    const allowlisted = BROKERAGE_CASH_LEG_ACTIVITY_TYPES.has(a.activityType);
    return optIn ? !allowlisted : allowlisted;
  });
  if (rows.length === 0) return [];

  const amount = sumAbs(rows.map((a) => a.amount as string));
  return [{
    kind: 'orphaned_cash_leg_activity',
    severity: 'gap',
    title: `${rows.length} brokerage cash movement${rows.length === 1 ? '' : 's'} nothing will convert`,
    detail:
      `$${amount} of brokerage cash activity in ${ctx.year} has no transaction and is not `
      + 'converted automatically — either the account is not opted in, or the activity type '
      + 'is ambiguous. A bare transfer on a brokerage account may be a draw, which is why '
      + 'it is shown and why it is not priced.',
    amount,
    taxEstimate: null,
    fix: { surface: 'transactions', label: 'Review these activities' },
    references: rows.map((a) => a.id),
  }];
}

/**
 * Dividend income counted for the year with no T5 slip entered.
 *
 * A **gap**, and the demotion is the blocker rule applied to an item an earlier draft
 * exempted. Not boundable: the income is already counted, so entering the slip moves
 * the return by $0 — there is no missing money to size. Not clearable by scheduled
 * work either: CDG must issue the slip.
 *
 * Still the highest-value item on the list for this taxpayer, because it is the only
 * cheap check that reaches the corp-declared-versus-cash-moved question. Loud is not
 * the same as blocking.
 *
 * **No figure**, both because there is no missing money and because the amount that
 * could be shown ($92,000 of already-counted dividends) would read as money at risk.
 */
export function detectMissingT5(ctx: CompletenessContext): CompletenessItem[] {
  const dividends = [...ctx.facts.eligibleDividends, ...ctx.facts.nonEligibleDividends];
  if (dividends.length === 0) return [];
  if (ctx.slipTypes.includes('T5')) return [];

  return [{
    kind: 'missing_t5',
    severity: 'gap',
    title: `Dividend income in ${ctx.year} with no T5 entered`,
    detail:
      'The return counts dividends from cash movements, but no T5 slip is recorded. The '
      + 'slip is what reconciles what the corporation DECLARED against what actually moved. '
      + 'No figure is shown: the income is already counted, so entering the slip changes the '
      + 'total by nothing — the value is the cross-check, not the dollars.',
    amount: null,
    taxEstimate: null,
    fix: { surface: 'slips', label: 'Enter the T5' },
    references: [],
  }];
}

/**
 * A personal transfer-in with no counterpart — txn 12139's pre-fix shape.
 *
 * A **gap**. It fires on a healthy ledger: `linkedTransactionId` is one-directional,
 * so every link TARGET in the household matches a naive "unlinked" test, and
 * `cashflow/safeToSpend.ts:342-345` already treats this population as normal, calling
 * it "a coverage gap (the corp side was not imported)".
 *
 * **No figure.** Money that arrived is not missing money, and pricing it would mean
 * assuming it is an untagged draw.
 */
export function detectUncountedTransferIn(ctx: CompletenessContext): CompletenessItem[] {
  const rows = ctx.personalTxns.filter(
    (t) => t.txnType === 'transfer'
      && D(t.amount).greaterThan(0)
      && t.linkedTransactionId === null
      && !t.isLinkTarget
      && !t.isTaxClassified,
  );
  if (rows.length === 0) return [];

  return [{
    kind: 'uncounted_transfer_in',
    severity: 'gap',
    title: `${rows.length} incoming transfer${rows.length === 1 ? '' : 's'} with no counterpart`,
    detail:
      'Money arrived with nothing recording where it came from. If any of it came from the '
      + 'corporation it belongs on the return. No figure is shown: money that arrived is not '
      + 'missing money, and pricing it would assume it is an untagged draw.',
    amount: null,
    taxEstimate: null,
    fix: { surface: 'classify', label: 'Review these arrivals' },
    references: rows.map((t) => t.id),
  }];
}

/**
 * Securities paying dividends whose eligibility was never verified against a slip.
 *
 * `Security.dividendEligibility` defaults to `eligible`, which is right for a publicly
 * traded Canadian corporation and wrong for an ETF distribution — a mix of eligible
 * dividends, foreign income, other income, return of capital and capital gains that
 * the flag cannot express. Reassigned here from part 2, where the proposed fix was to
 * flip the default; flipping it would misclassify most securities to fix none.
 *
 * Carries the amount at stake. No tax estimate: the correction can move the total in
 * either direction and by an amount that depends on the true composition.
 */
export function detectUnverifiedEligibility(ctx: CompletenessContext): CompletenessItem[] {
  if (ctx.unverifiedEligibility.length === 0) return [];
  const amount = sumAbs(ctx.unverifiedEligibility.map((s) => s.amount));
  return [{
    kind: 'unverified_dividend_eligibility',
    severity: 'gap',
    title: `${ctx.unverifiedEligibility.length} securit${ctx.unverifiedEligibility.length === 1 ? 'y' : 'ies'} with unverified dividend eligibility`,
    detail:
      `$${amount} of distributions are assumed to be eligible Canadian dividends because that `
      + 'is the default, not because anything checked. An ETF distribution is usually a mix of '
      + 'eligible dividends, foreign income, return of capital and capital gains. No tax figure '
      + 'is shown: the correction can move the total either way.',
    amount,
    taxEstimate: null,
    fix: { surface: 'securities', label: 'Set eligibility from the slips' },
    references: ctx.unverifiedEligibility.map((s) => s.securityId),
  }];
}

/** Suspected duplicate pairs from part 1b's detector. */
export function detectDuplicatePairs(ctx: CompletenessContext): CompletenessItem[] {
  const { groups, certain, totalDuplicatedAmount } = ctx.duplicates;
  if (groups.length === 0) return [];
  return [{
    kind: 'duplicate_pairs',
    severity: 'gap',
    title: `${groups.length} suspected duplicate group${groups.length === 1 ? '' : 's'}`,
    detail:
      `${certain.length} of ${groups.length} are structurally certain — two legs sharing one `
      + `counterpart. Together they overstate the ledger by $${totalDuplicatedAmount}, which `
      + 'corrupts balances and any expense total built from them. No tax figure is shown: a '
      + 'duplicate inflates rather than omits, and its effect on the return runs through '
      + 'whichever lines those rows feed.',
    amount: totalDuplicatedAmount,
    taxEstimate: null,
    fix: { surface: 'duplicates', label: 'Review duplicates' },
    references: groups.flatMap((g) => g.rows.map((r) => r.id)),
  }];
}

/**
 * ACB warnings `computeAcb` raised and `buildPersonalFacts` discarded — clamped
 * sells, zero-cost `transfer_in`, mixed currency.
 *
 * **No figure.** The warnings are diagnostic strings about cost-base confidence, not
 * quantities; the spec's instruction that every gap but three carries a figure cannot
 * be satisfied here without inventing one, and the spec's own rule against invented
 * figures takes precedence over its enumeration.
 */
export function detectAcbWarnings(ctx: CompletenessContext): CompletenessItem[] {
  // Read off the facts, where `buildPersonalFacts` now records them. Re-running the
  // ACB walk here would mean duplicating its full-history input assembly.
  const warnings = ctx.facts.acbWarnings ?? [];
  if (warnings.length === 0) return [];
  return [{
    kind: 'acb_warnings',
    severity: 'gap',
    title: `${warnings.length} cost-base warning${warnings.length === 1 ? '' : 's'}`,
    detail:
      'Capital gains were computed over a cost base the calculator was unsure about: '
      + `${warnings.slice(0, 3).join(' ')}`
      + (warnings.length > 3 ? ` (+${warnings.length - 3} more)` : ''),
    amount: null,
    taxEstimate: null,
    fix: { surface: 'transactions', label: 'Check these holdings' },
    references: [],
  }];
}

/**
 * Carryforwards never rolled into the period, so RRSP and FHSA room are stale.
 *
 * **No figure**: the consequence is a wrong deduction limit, whose size depends on
 * contributions not yet made. Same reasoning as the ACB item.
 */
export function detectCarryforwardsNotRolled(ctx: CompletenessContext): CompletenessItem[] {
  if (ctx.carryforwardYears.includes(ctx.year)) return [];
  const latest = ctx.carryforwardYears.length > 0 ? Math.max(...ctx.carryforwardYears) : null;
  return [{
    kind: 'carryforwards_not_rolled',
    severity: 'gap',
    title: `Carryforwards stop at ${latest ?? 'no year'}`,
    detail:
      `RRSP and FHSA room for ${ctx.year} was never rolled forward`
      + (latest !== null ? `; the latest recorded year is ${latest}.` : '.')
      + ' Deduction limits on this return are stale. No figure is shown: the effect depends '
      + 'on contributions not yet made.',
    amount: null,
    taxEstimate: null,
    fix: { surface: 'carryforwards', label: 'Roll carryforwards forward' },
    references: [],
  }];
}

/**
 * The year's rate table is a projection rather than published figures.
 *
 * The live half of part 2's provenance work: the refusal there only applies to a
 * CLOSED period, so for an open year this is the surface that says so.
 *
 * **No figure.** The error is spread across every bracket and credit, and any single
 * number would misrepresent it.
 */
export function detectProjectedRates(ctx: CompletenessContext): CompletenessItem[] {
  if (ctx.rates.provenance !== 'projected') return [];
  return [{
    kind: 'projected_rate_table',
    severity: 'gap',
    title: `${ctx.year} rates are projected, not published`,
    detail:
      `The ${ctx.year} brackets, credits and limits are an indexation estimate that nobody `
      + 'has checked against the published schedules. Every figure on this return inherits '
      + 'that uncertainty. No single figure is shown: the error is spread across every '
      + 'bracket and credit.',
    amount: null,
    taxEstimate: null,
    fix: { surface: 'rates', label: `Verify the ${ctx.year} rate table` },
    references: [],
  }];
}

/** Slips entered for the year that reconcile against nothing computed. */
export function detectUnreconciledSlips(ctx: CompletenessContext): CompletenessItem[] {
  if (ctx.unreconciledSlips.length === 0) return [];
  const amount = sumAbs(ctx.unreconciledSlips.map((s) => s.amount));
  return [{
    kind: 'unreconciled_slips',
    severity: 'gap',
    title: `${ctx.unreconciledSlips.length} slip${ctx.unreconciledSlips.length === 1 ? '' : 's'} matching nothing in the ledger`,
    detail:
      `$${amount} is reported on slips with no corresponding transactions. Either the `
      + 'transactions were never imported, or the slip was entered against the wrong year.',
    amount,
    taxEstimate: null,
    fix: { surface: 'slips', label: 'Reconcile these slips' },
    references: ctx.unreconciledSlips.map((s) => s.slipId),
  }];
}

/** Every detector, blockers first. Order within the report is presentation. */
export const DETECTORS: ReadonlyArray<(ctx: CompletenessContext) => CompletenessItem[]> = [
  detectUnclassifiedCorpDraws,
  detectUnimportedOutboundTransfers,
  detectConvertibleCashLegs,
  detectTruncatedImports,
  detectOrphanedCashLegs,
  detectMissingT5,
  detectUncountedTransferIn,
  detectUnverifiedEligibility,
  detectDuplicatePairs,
  detectAcbWarnings,
  detectCarryforwardsNotRolled,
  detectProjectedRates,
  detectUnreconciledSlips,
];
