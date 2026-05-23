/**
 * Shared per-household concurrency guard for runBackfill.
 *
 * Both the manual POST /api/transactions/enrichment/backfill route and the
 * post-capture setImmediate scheduler must check this set before running a
 * backfill, so rapid bookmarklet clicks or manual triggers don't queue
 * overlapping invocations against the same household.
 */
export const backfillRunning = new Set<number>();
