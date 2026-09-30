import type { Decimal } from '../util/decimal';
import type { RateTable, TaxYearFacts } from '../engine/types';
import type { PerimeterTxn } from '../builders/corpPerimeter';
import type { DuplicateReport } from '../../import/detectDuplicateTransactions';

/** Worst-wins across every item. */
export type CompletenessStatus = 'complete' | 'gaps' | 'blocked';

/**
 * `blocker` — known-missing money whose size is known or boundable. The total is
 * demonstrably wrong.
 *
 * `gap` — a correctness risk of unknown size. The total may be right.
 *
 * A blocker must be **boundable**, **clearable by work this plan schedules**, and
 * **must not fire on a healthy ledger**. If any of the three fails it is a gap, with
 * no exemptions: a blocker nothing can clear is a permanent red light that trains
 * the reader to ignore the panel, and one that fires on ordinary statement lag is
 * worse, because it is wrong rather than merely useless. Applying that test cost two
 * items their blocker status during design — the missing T5 and the uncounted
 * transfer-in — and the set is better for it.
 */
export type CompletenessSeverity = 'blocker' | 'gap';

/** Where the reader goes to clear the item. */
export type FixSurface =
  | 'classify'
  | 'import'
  | 'duplicates'
  | 'slips'
  | 'carryforwards'
  | 'securities'
  | 'rates'
  | 'transactions';

export interface CompletenessItem {
  /** Stable machine id, so the UI can route and tests can name a case. */
  kind: string;
  severity: CompletenessSeverity;
  title: string;
  detail: string;
  /**
   * Money known to be missing or at risk, signed as the ledger holds it.
   *
   * `null` only where no honest figure exists. Every blocker has one by definition —
   * boundable is what makes it a blocker.
   */
  amount: string | null;
  /**
   * Tax this would add to the return if fixed, computed by re-running the return.
   *
   * `null` where the character of the money is unknown. The outbound-corp-transfer
   * blocker is the deliberate case: such a transfer may be a draw, an internal move
   * or a third-party payment, and pricing it on the personal T1 would assume it
   * reached Connor. Inventing the figure is worse than omitting it.
   */
  taxEstimate: string | null;
  fix: { surface: FixSurface; label: string };
  /** Transaction / activity / account ids the reader needs to act. */
  references: number[];
}

export interface CompletenessReport {
  status: CompletenessStatus;
  /** ISO timestamp. The report is derived on read and never persisted. */
  checkedAt: string;
  /**
   * Latest transaction date the report saw, or null for an empty period. Rendered
   * even when `status` is `complete` — absence of warning must be affirmative, or
   * "no problems" and "nobody checked" look identical.
   */
  coverageThrough: string | null;
  blockers: CompletenessItem[];
  gaps: CompletenessItem[];
}

/** An investment activity row as the orphan detectors need it. */
export interface ActivityRow {
  id: number;
  accountId: number;
  activityType: string;
  amount: string | null;
  date: string;
  securityId: number | null;
  /** True when a transaction already records this event. */
  hasTransaction: boolean;
}

/** An account as the truncated-import detector needs it. */
export interface AccountRow {
  id: number;
  name: string;
  accountType: string;
  closedAt: string | null;
  mergedIntoId: number | null;
}

/**
 * Everything the detectors read, loaded once.
 *
 * Passed in rather than queried per detector so each detector is a pure function
 * testable without a database, and so the whole report costs one pass. The route
 * this attaches to already has a cache because it is slow.
 */
export interface CompletenessContext {
  entityId: number;
  year: number;
  /**
   * The SELECTED SCENARIO's resolved facts — not a fresh `buildPersonalFacts`.
   *
   * The gate and the total must share a basis. If the estimates re-ran the builder
   * while the selected scenario is a fork carrying overrides, the displayed total and
   * the estimates would be computed on different numbers.
   */
  facts: TaxYearFacts;
  rates: RateTable;
  /** Personal-entity transactions in the period. */
  personalTxns: CompletenessTxn[];
  /** Outbound corp transfers with no imported counterpart, from `partitionCorpPerimeter`. */
  unimportedOutboundTransfers: PerimeterTxn[];
  accounts: AccountRow[];
  activities: ActivityRow[];
  duplicates: DuplicateReport;
  /** Carryforward `asOfYear` values present for this entity. */
  carryforwardYears: number[];
  /** Slip types present for the year, e.g. `['T4', 'T5']`. */
  slipTypes: string[];
  /** Slips whose amounts reconcile against nothing computed. */
  unreconciledSlips: { slipId: number; slipType: string; amount: string }[];
  /** Securities paying dividends this year whose eligibility was never verified. */
  unverifiedEligibility: { securityId: number; symbol: string; amount: string }[];
  /** Today, injected so the truncated-import detector is testable. */
  now: Date;
}

export interface CompletenessTxn {
  id: number;
  accountId: number;
  date: string;
  amount: string;
  txnType: string | null;
  linkedTransactionId: number | null;
  isLinkTarget: boolean;
  taxTreatmentOverride: string | null;
  /**
   * Resolved through ALL FOUR routes — see `resolveTaxTreatment`.
   *
   * Deliberately not the classification queue's own test. `routes/tax.ts:63` treats
   * `taxTreatmentOverride IS NULL` as pending, so a row classified by an inherited
   * category treatment still appears in the queue — while `buildPersonalFacts` counts
   * its income. Using the queue's predicate here would report money as missing that is
   * already on the return: a false blocker, which is the worst kind, because it makes
   * the panel wrong rather than merely noisy.
   */
  isTaxClassified: boolean;
  /** True when this row's linked counterpart belongs to a corp entity. */
  counterpartIsCorp: boolean;
  cadAmount: Decimal;
}
