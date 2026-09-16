/**
 * Mark-dirty queue that makes line-of-credit interest allocation automatic.
 *
 * `runInterestAllocation` used to have exactly one caller — `POST
 * /api/contacts/interest-allocation`, behind a "Reallocate interest" button —
 * so the allocated figures on the People page were only ever as fresh as the
 * last time someone remembered to press it. The ledger's `interestStaleness`
 * signal and the "stale — reallocate" banner were scaffolding around that
 * missing trigger.
 *
 * Two things invalidate an allocation, and both now mark instead of run:
 *
 *   1. **New billed interest** — `captureRatePeriods` wrote or updated rate
 *      windows during a statement commit (`import/commitStatementImport.ts`).
 *   2. **Changed lending** — a loan was tagged or untagged, via
 *      `counterpartyRole` / `counterpartyContactId` on `PATCH
 *      /api/transactions/:id` or `loanDefault` on `PATCH /api/contacts/:id`.
 *
 * ## Why mark-and-drain rather than run inline
 *
 * A full household recomputation loads every rate window and every
 * contact-linked transaction, then deletes and re-inserts the charged rows.
 * Connor retags loans in bursts: a dozen PATCHes must not mean a dozen of
 * those inside request handlers. Marking is an in-memory `Set.add`, so the
 * triggering operation pays nothing.
 *
 * Draining is a **trailing window**, not a true debounce: the first mark arms a
 * timer, later marks join the same window rather than pushing it back. A
 * continuous stream of retags therefore still allocates every
 * `interestAllocationDebounceMs`, where a resetting debounce would starve.
 *
 * ## Why a job rather than a bare timer
 *
 * The timer fires `jobs/definitions/interestAllocation.ts` through the registry
 * when it is registered, which buys the Postgres advisory lock (two app
 * instances cannot delete-then-insert the same rows concurrently), a `JobRun`
 * history, and the jobs API's enable/disable and run-now. The job's cron is a
 * *safety net*, not the mechanism: when a drain returns `skipped_locked`
 * because another instance held the lock, this instance's pending set survives
 * and the next tick collects it. On an idle day the tick finds an empty queue
 * and does nothing — no household sweep, no query.
 *
 * Outside a server (unit tests, CLI scripts) the job is not registered and the
 * timer drains directly, so a trigger is never silently swallowed.
 *
 * ## The enabled flag gates marking, not draining
 *
 * `interestAllocationEnabled` (off under `NODE_ENV=test`, or when
 * `INTEREST_ALLOCATION_ENABLED` is falsy) is checked in
 * `markInterestAllocationPending`. When off, marking is a total no-op: nothing
 * queues, so nothing arms and no later drain has work to do. Draining stays
 * unconditional so the job and tests can still run the allocator on purpose,
 * and `POST /api/contacts/interest-allocation` never touches this queue at all
 * — a disabled feature still reallocates when a human presses the button.
 *
 * ## What this deliberately does not do
 *
 * A failed allocation is **not** re-queued. The ledger's `interestStaleness`
 * signal is the kept safety net for exactly this, and re-queueing would spin a
 * persistent failure forever. The failure is logged and lands in the job run.
 */
import { logger } from '../observability/logger';
import { interestAllocationDebounceMs, interestAllocationEnabled } from '../config/env';
import {
  runInterestAllocation,
  isInterestAllocationRunning,
  type InterestAllocationResult,
} from './runInterestAllocation';

/** Registry name of the job that drains this queue. */
export const INTEREST_ALLOCATION_JOB = 'interest_allocation';

type InterestRunner = (opts: { householdId: number }) => Promise<InterestAllocationResult>;
type InFlightCheck = (householdId: number) => boolean;

/** householdId → the trigger sources that queued it, for the drain log. */
const pending = new Map<number, Set<string>>();
let windowTimer: NodeJS.Timeout | null = null;
let draining = false;

let runnerOverride: InterestRunner | null = null;
let inFlightOverride: InFlightCheck | null = null;
let debounceMsOverride: number | null = null;
let enabledOverride: boolean | null = null;

function runner(): InterestRunner {
  return runnerOverride ?? ((opts) => runInterestAllocation(opts));
}
function inFlight(): InFlightCheck {
  return inFlightOverride ?? isInterestAllocationRunning;
}
function windowMs(): number {
  return debounceMsOverride ?? interestAllocationDebounceMs;
}

/**
 * Whether the *automatic* side of interest allocation is switched on.
 *
 * `interestAllocationEnabled` is false under `NODE_ENV=test` and whenever
 * `INTEREST_ALLOCATION_ENABLED` is set falsy. Until this gate existed the flag
 * was consulted ONLY by `jobs/definitions/interestAllocation.ts`, as the job's
 * `enabledDefault` — which left the coordinator itself fully live in unit
 * tests. Anything that committed a statement or retagged a loan armed the
 * five-second trailing window, and because no server had registered a flush
 * hook the window's fallback ran the REAL allocator against that worker's
 * per-PID SQLite file, frequently while the suite was already tearing the
 * database down. That is what hung `backend-test-shard (3)` for four hours.
 *
 * This gate covers marking only. `drainPendingInterestAllocations` stays
 * callable directly so the job and tests can still exercise the allocator
 * deliberately, and the manual `POST /api/contacts/interest-allocation`
 * endpoint bypasses the coordinator entirely — a disabled feature still
 * reallocates when a human presses the button.
 */
function enabled(): boolean {
  return enabledOverride ?? interestAllocationEnabled;
}

export interface InterestAllocationDrainResult {
  /** Households whose allocation completed on this pass. */
  households: number;
  /** Households left queued because a run was already in flight for them. */
  deferred: number;
  /** Households whose allocation threw. Not re-queued — see the file header. */
  failed: number;
  /** Charged rows written across every household this pass. */
  allocations: number;
  /** Still queued when the pass ended. Non-zero means come back promptly. */
  pendingRemaining: number;
}

export interface InterestAllocationTrigger {
  householdId: number;
  /** Short tag for logging — "statement-import", "counterparty-retag", … */
  source: string;
}

/**
 * Queue a household for reallocation. Synchronous, non-blocking, and it CANNOT
 * THROW — it is called from inside an import commit and from PATCH handlers,
 * and neither may fail because interest allocation is unhappy.
 */
export function markInterestAllocationPending(trigger: InterestAllocationTrigger): void {
  try {
    // Disabled means INERT, not merely quiet. Gating lower down (at
    // `armWindow`) would still let the pending set grow, and the next
    // deliberate `drainPendingInterestAllocations()` — the cron safety net, a
    // test — would then suddenly run every household that had accumulated.
    if (!enabled()) return;
    const householdId = trigger?.householdId;
    if (!Number.isInteger(householdId) || householdId <= 0) return;
    const source = trigger.source || 'unknown';
    const existing = pending.get(householdId);
    if (existing) {
      existing.add(source);
    } else {
      pending.set(householdId, new Set([source]));
    }
    armWindow();
  } catch (err) {
    // Swallowing is the point: the caller's operation is the one that matters,
    // and the ledger staleness signal will still flag the missed run.
    logger.error({ err, trigger }, 'interest_allocation_mark_failed');
  }
}

/** True when this household is queued for (but has not yet had) a reallocation. */
export function isInterestAllocationPending(householdId: number): boolean {
  return pending.has(householdId);
}

/**
 * Arm the trailing window if it is not already armed.
 *
 * Deliberately NOT a resetting debounce: later marks join the armed window
 * instead of pushing it back, so a steady stream of retags still allocates on
 * schedule. The timer is unref'd — a queued reallocation must never be the
 * reason a process refuses to exit.
 */
function armWindow(): void {
  if (windowTimer) return;
  windowTimer = setTimeout(() => {
    windowTimer = null;
    void flush();
  }, windowMs());
  windowTimer.unref?.();
}

type FlushHook = () => Promise<unknown>;
let flushHook: FlushHook | null = null;

/**
 * Point the armed window at the job runner.
 *
 * Called by `jobs/definitions/interestAllocation.ts`, which only `server.ts`
 * imports. The dependency runs that way round on purpose: a coordinator that
 * reached into `jobs/registry` itself would drag the job runner — and with it
 * the OpenTelemetry exporters and their intervals — into every unit test that
 * so much as tags a loan.
 */
export function setInterestAllocationFlushHook(fn: FlushHook | null): void {
  flushHook = fn;
}

/**
 * Drain through the job when a server registered one, directly when not.
 *
 * Going through the registry is what gets the advisory lock and the run
 * history. Without it — a unit test, a CLI script — the queued work would
 * otherwise evaporate, so the fallback drains in-process.
 */
async function flush(): Promise<void> {
  try {
    if (flushHook) {
      await flushHook();
      return;
    }
    await drainPendingInterestAllocations();
  } catch (err) {
    logger.error({ err }, 'interest_allocation_flush_failed');
  }
}

/**
 * Run every queued household's allocation. The job handler's whole body.
 *
 * Iterates a snapshot of the queue, so marks arriving mid-drain queue for the
 * next pass rather than extending this one indefinitely. A household with a run
 * already in flight (the manual force-refresh button, or another drain) is left
 * queued rather than attempted: `runInterestAllocation` throws outright on
 * re-entry, and swallowing that would be losing the work.
 */
export async function drainPendingInterestAllocations(): Promise<InterestAllocationDrainResult> {
  const result: InterestAllocationDrainResult = {
    households: 0,
    deferred: 0,
    failed: 0,
    allocations: 0,
    pendingRemaining: 0,
  };
  if (pending.size === 0) return result;

  draining = true;
  try {
    const running = inFlight();
    const run = runner();
    for (const householdId of [...pending.keys()]) {
      const sources = pending.get(householdId);
      if (!sources) continue;
      if (running(householdId)) {
        result.deferred += 1;
        continue;
      }
      pending.delete(householdId);
      const startedAt = Date.now();
      try {
        const r = await run({ householdId });
        result.households += 1;
        result.allocations += r.allocations;
        logger.info(
          {
            householdId,
            sources: [...sources].join(','),
            windows: r.windows,
            allocations: r.allocations,
            totalCharged: r.totalCharged,
            durationMs: Date.now() - startedAt,
          },
          'interest_allocation_auto_completed',
        );
      } catch (err) {
        result.failed += 1;
        logger.error(
          { err, householdId, sources: [...sources].join(',') },
          'interest_allocation_auto_failed',
        );
      }
    }
  } finally {
    draining = false;
  }

  result.pendingRemaining = pending.size;
  // Deferred work has nothing else to wake it before the next cron tick.
  if (result.pendingRemaining > 0) armWindow();
  return result;
}

/**
 * Test-only. Resolves once nothing is queued, armed, or mid-drain.
 */
export async function waitForInterestAllocationDrain(): Promise<void> {
  while (pending.size > 0 || windowTimer !== null || draining) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export interface InterestAllocationCoordinatorOverrides {
  runner?: InterestRunner | null;
  isRunning?: InFlightCheck | null;
  debounceMs?: number | null;
  /**
   * Force the enabled gate on or off. Unit tests run under `NODE_ENV=test`,
   * where `interestAllocationEnabled` is false, so a test that exercises the
   * marking path must opt in explicitly.
   */
  enabled?: boolean | null;
}

/** Test-only seam. Mirrors `_setBackfillRunnerForTest` in backfillCoordinator. */
export function _setInterestAllocationCoordinatorForTest(
  o: InterestAllocationCoordinatorOverrides,
): void {
  if ('runner' in o) runnerOverride = o.runner ?? null;
  if ('isRunning' in o) inFlightOverride = o.isRunning ?? null;
  if ('debounceMs' in o) debounceMsOverride = o.debounceMs ?? null;
  if ('enabled' in o) enabledOverride = o.enabled ?? null;
}

/** Test-only. Clears the queue, the armed window, and every override. */
export function _resetInterestAllocationCoordinatorForTest(): void {
  pending.clear();
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = null;
  draining = false;
  runnerOverride = null;
  inFlightOverride = null;
  debounceMsOverride = null;
  enabledOverride = null;
  flushHook = null;
}
