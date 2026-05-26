/**
 * Pure score math for the data-quality dashboard (#234).
 *
 * Lives in its own module so the score logic can be unit-tested without
 * importing Sequelize, sqlite3, or any other heavy dependency. The
 * companion `dataQuality.ts` module does the actual DB aggregation and
 * delegates to `computeDataQualityScore` defined here.
 *
 * Component definitions and the rationale for the threshold values are
 * documented in `dataQuality.ts`. This file only owns: the normalization
 * function, the coverage-component score, the threshold catalog, the
 * action-link catalog, and the deterministic mean.
 */

/**
 * Issue-count thresholds. A component with `count >= threshold` scores 0;
 * `count == 0` scores 1; linearly interpolated in between. Tuned so a typical
 * "neglected" account (50 unreviewed rows, 10 unmatched transfers) lands
 * around 0 and a tidy account stays near 1. Exported for tests + UI display.
 */
export const DATA_QUALITY_THRESHOLDS = {
  duplicates: 20,
  transfers: 10,
  subscriptions: 5,
  review: 50,
} as const;

export type CategorizationComponent = {
  totalSpend: number;
  categorized: number;
  uncategorized: number;
  coverage: number;
};

export type RulesComponent = {
  totalSpend: number;
  ruleCovered: number;
  uncovered: number;
  coverage: number;
};

export type ReceiptsComponent = {
  totalSpend: number;
  withReceipt: number;
  missing: number;
  coverage: number;
};

export type DuplicatesComponent = {
  duplicateGroups: number;
  duplicateTransactions: number;
};

export type TransfersComponent = {
  unmatched: number;
};

export type SubscriptionsComponent = {
  stale: number;
};

export type ReviewComponent = {
  backlog: number;
};

export type DataQualityComponents = {
  categorization: CategorizationComponent;
  rules: RulesComponent;
  receipts: ReceiptsComponent;
  duplicates: DuplicatesComponent;
  transfers: TransfersComponent;
  subscriptions: SubscriptionsComponent;
  review: ReviewComponent;
};

export type DataQualityComponentScores = {
  categorization: number;
  rules: number;
  receipts: number;
  duplicates: number;
  transfers: number;
  subscriptions: number;
  review: number;
};

export type DataQualityScoreResult = {
  score: number;
  componentScores: DataQualityComponentScores;
  components: DataQualityComponents;
};

export type DataQualityActionLink = {
  key: keyof DataQualityComponents;
  /** Stable label for the dashboard card. */
  label: string;
  /** Frontend route the card links to so users can act on the gap. */
  href: string;
  /** Short explanation of what the metric measures. */
  description: string;
};

/**
 * Action-link catalog used by the dashboard view. Bundled with the API
 * response so the frontend stays a thin renderer — adding a new metric only
 * requires backend changes + a one-line href registration here.
 */
export const DATA_QUALITY_ACTION_LINKS: readonly DataQualityActionLink[] = [
  {
    key: 'categorization',
    label: 'Categorized',
    href: '/transactions?finalCategory=__none__',
    description:
      'Share of spend transactions assigned to a category. Uncategorized rows make budgets and tax filtering noisy.',
  },
  {
    key: 'rules',
    label: 'Rule coverage',
    href: '/rules',
    description:
      'Share of spend matched by a saved rule. Higher coverage means future imports auto-categorize without manual review.',
  },
  {
    key: 'receipts',
    label: 'Receipts',
    href: '/transactions?missingReceipt=1',
    description:
      'Share of spend rows that have at least one receipt attached. Drives audit-trail completeness.',
  },
  {
    key: 'duplicates',
    label: 'Duplicates',
    href: '/transactions?duplicates=1',
    description:
      'Transactions that look like duplicates (same date, merchant, currency, amount).',
  },
  {
    key: 'transfers',
    label: 'Unmatched transfers',
    href: '/transactions?txnType=transfer&unmatched=1',
    description:
      'Transfers with no paired row. Unmatched transfers double-count cashflow on both sides.',
  },
  {
    key: 'subscriptions',
    label: 'Stale subscriptions',
    href: '/subscriptions?status=unknown',
    description: 'Recurring charges the system can’t classify as active or cancelled.',
  },
  {
    key: 'review',
    label: 'Review backlog',
    href: '/review',
    description:
      'Transactions flagged for manual review. Clearing the backlog improves classifier confidence.',
  },
];

/**
 * Linear normalization of an issue-count to a [0,1] score. Zero issues =
 * perfect (1); at-or-above the threshold = worst (0); linearly interpolated
 * in between. Threshold==0 collapses to "any nonzero is 0" without throwing.
 */
export function normalizeIssueCount(count: number, threshold: number): number {
  if (count <= 0) return 1;
  if (threshold <= 0) return 0;
  const ratio = count / threshold;
  if (ratio >= 1) return 0;
  return 1 - ratio;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Component score for a "coverage" signal (categorization, rules, receipts).
 * An empty dataset returns 1 (no rows to be wrong about) — the dashboard
 * surfaces the empty state separately via component.totalSpend.
 */
function coverageScore(c: { totalSpend: number; coverage: number }): number {
  if (c.totalSpend <= 0) return 1;
  return clamp01(c.coverage);
}

/**
 * Compute the data-quality score from the seven component aggregates.
 * Deterministic — pure function of its argument, no clock/random access.
 */
export function computeDataQualityScore(
  components: DataQualityComponents,
): DataQualityScoreResult {
  const componentScores: DataQualityComponentScores = {
    categorization: coverageScore(components.categorization),
    rules: coverageScore(components.rules),
    receipts: coverageScore(components.receipts),
    duplicates: normalizeIssueCount(
      components.duplicates.duplicateGroups,
      DATA_QUALITY_THRESHOLDS.duplicates,
    ),
    transfers: normalizeIssueCount(
      components.transfers.unmatched,
      DATA_QUALITY_THRESHOLDS.transfers,
    ),
    subscriptions: normalizeIssueCount(
      components.subscriptions.stale,
      DATA_QUALITY_THRESHOLDS.subscriptions,
    ),
    review: normalizeIssueCount(components.review.backlog, DATA_QUALITY_THRESHOLDS.review),
  };

  const values = Object.values(componentScores);
  const score = values.reduce((sum, v) => sum + v, 0) / values.length;

  return {
    score: clamp01(score),
    componentScores,
    components,
  };
}
