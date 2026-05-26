/**
 * Per-household concurrency + coalescing for runBackfill.
 *
 * Two callers must coexist for a given household:
 *
 *   1. The manual `POST /api/transactions/enrichment/backfill` route and the
 *      CLI script — these are large, user-initiated sweeps. They acquire the
 *      lock synchronously and return 409 if another run is already in flight.
 *
 *   2. Internal triggers — rule CRUD, amazon match, merchant-memory write,
 *      post-capture, nightly cron — these are small, scoped re-enriches that
 *      should never reject. Multiple internal triggers landing back-to-back
 *      must coalesce into a single broader run, otherwise rapid rule edits
 *      silently drop work.
 *
 * The coordinator merges queued internal triggers per household by widening
 * the date window and unioning the merchant patterns (or dropping the
 * pattern filter when ≥ 2 distinct patterns queue — running wider is always
 * correct, just more work).
 */
import { runBackfill, type BackfillFlags, type BackfillResult } from './runEnrichmentBackfill';
import { logger } from '../observability/logger';

type BackfillRunner = (flags: BackfillFlags) => Promise<BackfillResult>;
let runnerOverride: BackfillRunner | null = null;
/** Test-only seam. Pass `null` to restore the real runBackfill. */
export function _setBackfillRunnerForTest(fn: BackfillRunner | null): void {
  runnerOverride = fn;
}
function getRunner(): BackfillRunner {
  return runnerOverride ?? runBackfill;
}

const running = new Set<number>();

interface PendingSlot {
  dateFrom: string | null;
  dateTo: string | null;
  merchantPatterns: Set<string>;
  sources: Set<string>;
}
const pending = new Map<number, PendingSlot>();

/**
 * Back-compat surface used by the manual UI route + CLI to gate themselves.
 * Reads as `backfillRunning.has(householdId)`. Writes (.add / .delete) come
 * from the manual sync path.
 */
export const backfillRunning = running;

/**
 * True when a backfill is currently executing OR queued for this household.
 * Use from the manual route so a user click doesn't race a pending internal
 * trigger and end up running two backfills concurrently on the same data.
 */
export function isBackfillInFlight(householdId: number): boolean {
  return running.has(householdId) || pending.has(householdId);
}

export interface InternalBackfillRequest {
  householdId: number;
  /** Optional lower bound on Transaction.date (YYYY-MM-DD). `null` = unbounded. */
  dateFrom?: string | null;
  /** Optional upper bound on Transaction.date (YYYY-MM-DD). `null` = unbounded. */
  dateTo?: string | null;
  /**
   * Optional case-insensitive substring filter on merchant. `null` = no
   * filter (sweeps all merchants in window). When multiple triggers queue
   * with distinct patterns, the coalesced run drops the filter.
   */
  merchantPattern?: string | null;
  /** Short tag for logging — "rule-create", "amazon-match", etc. */
  source: string;
}

/**
 * Enqueue a scoped backfill for a household. Always non-blocking. Coalesces
 * with any in-flight or already-queued run for the same household.
 */
export function scheduleInternalBackfill(req: InternalBackfillRequest): void {
  const hh = req.householdId;
  const existing = pending.get(hh);
  const pattern = req.merchantPattern == null ? '' : req.merchantPattern.trim();

  if (existing) {
    existing.dateFrom = mergeLowerBound(existing.dateFrom, req.dateFrom ?? null);
    existing.dateTo = mergeUpperBound(existing.dateTo, req.dateTo ?? null);
    existing.sources.add(req.source);
    if (pattern === '') {
      // Empty pattern means "no filter" → collapse the union to no filter.
      existing.merchantPatterns.clear();
      existing.merchantPatterns.add('');
    } else if (!existing.merchantPatterns.has('')) {
      existing.merchantPatterns.add(pattern);
    }
    return;
  }

  pending.set(hh, {
    dateFrom: req.dateFrom ?? null,
    dateTo: req.dateTo ?? null,
    merchantPatterns: new Set([pattern]),
    sources: new Set([req.source]),
  });
  setImmediate(() => {
    void drain(hh);
  });
}

async function drain(householdId: number): Promise<void> {
  while (true) {
    const slot = pending.get(householdId);
    if (!slot) return;
    if (running.has(householdId)) {
      // A manual run is in flight; that path doesn't re-drain pending on
      // finish, so schedule one more tick and bail. This keeps the queued
      // internal run from racing the manual sweep.
      setImmediate(() => {
        void drain(householdId);
      });
      return;
    }
    pending.delete(householdId);
    running.add(householdId);

    let merchantPattern: string | null = null;
    if (slot.merchantPatterns.size === 1) {
      const only = Array.from(slot.merchantPatterns)[0];
      merchantPattern = only === '' ? null : only;
    } // > 1 distinct patterns: drop the filter (wider run, still correct).

    const flags: BackfillFlags = {
      dryRun: false,
      noReviewFlag: false,
      reviewOnly: false,
      verbose: false,
      accountId: null,
      householdId,
      limit: null,
      batchSize: 100,
      dateFrom: slot.dateFrom,
      dateTo: slot.dateTo,
      merchantPattern,
    };

    const startedAt = Date.now();
    const sources = Array.from(slot.sources).join(',');
    try {
      const result = await getRunner()(flags);
      logger.info('enrichment_backfill_internal_completed', {
        householdId,
        sources,
        dateFrom: slot.dateFrom,
        dateTo: slot.dateTo,
        merchantPattern,
        durationMs: Date.now() - startedAt,
        ...result,
      });
    } catch (err) {
      logger.error(
        'enrichment_backfill_internal_failed',
        { householdId, sources },
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      running.delete(householdId);
    }
  }
}

function mergeLowerBound(a: string | null, b: string | null): string | null {
  if (a == null || b == null) return null;
  return a < b ? a : b;
}

function mergeUpperBound(a: string | null, b: string | null): string | null {
  if (a == null || b == null) return null;
  return a > b ? a : b;
}

/**
 * Test-only helper. Resolves after every queued backfill for the given
 * household has finished draining (or immediately if nothing is queued).
 * Returns the number of runs that completed while waiting.
 */
export async function waitForBackfillDrain(householdId: number): Promise<void> {
  while (running.has(householdId) || pending.has(householdId)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
