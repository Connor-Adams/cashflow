/**
 * Import-confidence classifier (#214).
 *
 * Pure, deterministic function that maps the post-enrichment view of an
 * incoming transaction to a small set of human-meaningful flag tokens and a
 * single roll-up state. The roll-up state lives on `transactions.import_confidence`
 * and the array of flag tokens lives on `transactions.import_confidence_flags`
 * (JSON-encoded text).
 *
 * Design goals:
 *  - Deterministic given the same inputs (no clock, no IO).
 *  - Backward-compatible: NULL on existing rows is treated as "unknown" by
 *    the aggregator, never an automatic failure.
 *  - Easy to extend: add a new token to {@link IMPORT_CONFIDENCE_FLAGS} and
 *    fold it into {@link computeImportConfidence}.
 *
 * State semantics:
 *  - 'clean'        — no review needed and no blocking flag.
 *  - 'needs_review' — reviewFlag is true OR a blocking flag fired.
 *
 * Flag tokens (all optional, all additive):
 *  - 'needs_review'          — the enrichment-pipeline review flag is set
 *  - 'missing_category'      — final/auto category is null
 *  - 'missing_split'         — auto split type is null on a spend row in a
 *                              shared-visibility account (i.e. partner-relevant)
 *  - 'likely_duplicate'      — dedup found an existing row that was backfilled
 *                              (incoming source_reference replaced a NULL one)
 *  - 'possible_refund_pair'  — txnType is 'refund' and a sibling spend was
 *                              linked during the relationships stage
 *  - 'missing_receipt'       — finalBusiness is true and no receipt id known
 *                              at the time the row is committed (always
 *                              optional — set by the caller when it has the
 *                              receipt-link information)
 */

export type ImportConfidenceState = 'clean' | 'needs_review';

export const IMPORT_CONFIDENCE_FLAGS = [
  'needs_review',
  'missing_category',
  'missing_split',
  'likely_duplicate',
  'possible_refund_pair',
  'missing_receipt',
] as const;

export type ImportConfidenceFlag = (typeof IMPORT_CONFIDENCE_FLAGS)[number];

/**
 * Subset of the post-enrichment transaction shape the classifier reads. Kept
 * as a free type so the caller can pass either a Sequelize instance or a
 * plain object without having to construct a full Transaction.
 */
export interface ImportConfidenceInput {
  /** Result of the enrichment review-flag pass (true ≡ inbox-worthy). */
  reviewFlag: boolean;
  /** Final winning category. NULL when no signal claimed one. */
  finalCategory: string | null;
  /** Auto category (pre-override). NULL when no signal claimed one. */
  autoCategory: string | null;
  /** Auto split type. NULL when no signal claimed one. */
  autoSplitType: string | null;
  /** Final split type ('me' | 'partner' | 'shared'). Defaults to 'me'. */
  finalSplitType: string;
  /** Detected transaction type (purchase|refund|transfer|payment|fee|...) */
  txnType: string;
  /** Visibility of the parent account. 'shared' means partner-relevant. */
  accountVisibility: 'private' | 'shared';
  /** Linked sibling id from the relationships stage (refund→original etc.) */
  linkedTransactionId: number | null;
  /** Whether dedup backfilled an existing row's source_reference. When the
   *  caller is annotating the EXISTING row that was backfilled, set this to
   *  true. Otherwise omit. */
  dedupDuplicateBackfilled?: boolean;
  /** Caller-supplied receipt-missing signal (defaults to false / no opinion). */
  missingReceipt?: boolean;
  /** Amount (decimal string or number) — used to decide split relevance for
   *  refund/inflow rows that don't need split classification. */
  amount: string | number | null;
}

export interface ImportConfidenceResult {
  state: ImportConfidenceState;
  flags: ImportConfidenceFlag[];
}

const NON_SPEND_TXN_TYPES_FOR_SPLIT = new Set<string>([
  'transfer',
  'payment',
  'interest',
  'reward',
  'refund',
]);

function asNumber(value: string | number | null): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the deterministic confidence state + flag tokens for a freshly
 * imported transaction. See file-level docstring for token semantics.
 */
export function computeImportConfidence(
  input: ImportConfidenceInput,
): ImportConfidenceResult {
  const flags: ImportConfidenceFlag[] = [];

  if (input.reviewFlag) flags.push('needs_review');

  // Category is the highest-signal field for downstream reporting. If the
  // enrichment pipeline didn't claim one, surface it explicitly.
  const hasCategory =
    (input.finalCategory != null && input.finalCategory !== '') ||
    (input.autoCategory != null && input.autoCategory !== '');
  if (!hasCategory) flags.push('missing_category');

  // Split classification only matters when the account is partner-relevant
  // (shared visibility) AND the row is a real spend (not a transfer/refund).
  // For private accounts, default 'me' is fine and we don't surface a flag.
  const amount = asNumber(input.amount);
  const isSpendRow =
    !NON_SPEND_TXN_TYPES_FOR_SPLIT.has(input.txnType) && amount < 0;
  if (
    input.accountVisibility === 'shared' &&
    isSpendRow &&
    input.autoSplitType == null
  ) {
    flags.push('missing_split');
  }

  if (input.dedupDuplicateBackfilled === true) {
    flags.push('likely_duplicate');
  }

  if (input.txnType === 'refund' && input.linkedTransactionId != null) {
    flags.push('possible_refund_pair');
  }

  if (input.missingReceipt === true) {
    flags.push('missing_receipt');
  }

  // Roll-up: clean only if the enrichment review-flag is off AND no blocking
  // flag (missing_category, missing_split, likely_duplicate) fired. Note:
  // 'possible_refund_pair' and 'missing_receipt' are informational, not
  // blocking — a known refund pair is a *win*, not a problem.
  const blockingFlags: ImportConfidenceFlag[] = [
    'needs_review',
    'missing_category',
    'missing_split',
    'likely_duplicate',
  ];
  const hasBlocking = flags.some((f) => blockingFlags.includes(f));
  const state: ImportConfidenceState = hasBlocking ? 'needs_review' : 'clean';

  return { state, flags };
}

/**
 * Serialize a flag list to the JSON-encoded TEXT column format. Returns null
 * when the array is empty so the column stays NULL (matches "no opinion").
 */
export function serializeFlags(
  flags: ImportConfidenceFlag[],
): string | null {
  if (flags.length === 0) return null;
  return JSON.stringify(flags);
}

/**
 * Inverse of {@link serializeFlags}. Tolerates legacy NULL, malformed JSON,
 * and arrays containing unknown tokens (drops them). Always returns a flat
 * array, never throws.
 */
export function deserializeFlags(raw: string | null): ImportConfidenceFlag[] {
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(IMPORT_CONFIDENCE_FLAGS);
    return parsed.filter(
      (x): x is ImportConfidenceFlag =>
        typeof x === 'string' && allowed.has(x),
    );
  } catch {
    return [];
  }
}
