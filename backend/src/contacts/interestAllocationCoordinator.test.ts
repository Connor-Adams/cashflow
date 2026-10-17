/**
 * The coalescing queue that turned line-of-credit interest allocation from a
 * button into a consequence.
 *
 * Before this, `runInterestAllocation` had exactly one caller — the "Reallocate
 * interest" button — so the figures on the People page were only ever as fresh
 * as the last time somebody remembered to press it. The triggers that replace
 * it (a statement writing rate windows, a loan being retagged) fire from inside
 * request handlers, which sets the properties this file pins down:
 *
 *   1. Marking is synchronous, non-blocking and CANNOT THROW. An import must
 *      still commit and a PATCH must still return 200 if allocation is broken.
 *   2. A burst of retags collapses into one recomputation, not a dozen.
 *   3. A trigger arriving while the allocator is mid-run for that household
 *      neither throws (the allocator's in-flight guard rejects re-entry) nor
 *      drops the work — it stays queued for the next drain.
 *
 * No HTTP, no job registry: this is the mechanism on its own. The real
 * allocator is swapped out through an explicit test seam, the same way
 * `backfillCoordinator` does it, because an ESM namespace cannot be
 * `mock.method`'d.
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  markInterestAllocationPending,
  isInterestAllocationPending,
  drainPendingInterestAllocations,
  waitForInterestAllocationDrain,
  _resetInterestAllocationCoordinatorForTest,
  _setInterestAllocationCoordinatorForTest,
} from './interestAllocationCoordinator';
import type { InterestAllocationResult } from './runInterestAllocation';
import { sequelize } from '../models';

const HH = 4242;
const OTHER_HH = 4343;

function emptyResult(): InterestAllocationResult {
  return {
    windows: 0,
    allocations: 0,
    totalCharged: '0.0000',
    windowSummaries: [],
    dryRun: false,
    elapsedMs: 0,
  };
}

/**
 * Park the queue between tests: a long window means nothing self-drains behind
 * a test's back, and the stub runner means a stray drain can never reach the
 * database (this file deliberately has none).
 *
 * `enabled: true` is required, not decoration. Unit tests run under
 * `NODE_ENV=test`, where `interestAllocationEnabled` is false and marking is a
 * total no-op — which is the whole point of the gate. Every test below that
 * exercises marking therefore has to opt back in; the two that pin the disabled
 * behaviour opt out again explicitly.
 */
beforeEach(() => {
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    debounceMs: 60_000,
    runner: async () => emptyResult(),
    enabled: true,
  });
});

after(async () => {
  _resetInterestAllocationCoordinatorForTest();
  // The coordinator pulls in ../models transitively; an open sqlite handle
  // keeps the runner process alive after the last assertion.
  await sequelize.close();
});

test('marking a household queues it', () => {
  assert.equal(isInterestAllocationPending(HH), false);
  markInterestAllocationPending({ householdId: HH, source: 'test' });
  assert.equal(isInterestAllocationPending(HH), true);
});

test('a burst of marks drains as a single run', async () => {
  let runs = 0;
  _setInterestAllocationCoordinatorForTest({
    runner: async () => {
      runs += 1;
      return emptyResult();
    },
  });

  for (let i = 0; i < 12; i += 1) {
    markInterestAllocationPending({ householdId: HH, source: `retag-${i}` });
  }
  const result = await drainPendingInterestAllocations();

  assert.equal(runs, 1, `twelve retags must collapse into one recomputation, got ${runs}`);
  assert.equal(result.households, 1);
  assert.equal(isInterestAllocationPending(HH), false);
});

test('two households each get their own run', async () => {
  const seen: number[] = [];
  _setInterestAllocationCoordinatorForTest({
    runner: async (opts) => {
      seen.push(opts.householdId);
      return emptyResult();
    },
  });

  markInterestAllocationPending({ householdId: HH, source: 'a' });
  markInterestAllocationPending({ householdId: OTHER_HH, source: 'b' });
  await drainPendingInterestAllocations();

  assert.deepEqual(
    seen.slice().sort((a, b) => a - b),
    [HH, OTHER_HH],
  );
});

test('draining nothing runs nothing', async () => {
  let runs = 0;
  _setInterestAllocationCoordinatorForTest({
    runner: async () => {
      runs += 1;
      return emptyResult();
    },
  });
  const result = await drainPendingInterestAllocations();
  assert.equal(runs, 0, 'an empty queue must be a no-op, not a household sweep');
  assert.equal(result.households, 0);
  assert.equal(result.deferred, 0);
});

test('a trigger during an in-flight run neither throws nor loses the work', async () => {
  // runInterestAllocation throws outright on re-entry for the same household.
  // The coordinator must consult the guard and re-queue rather than let that
  // rejection escape into whatever request handler fired the trigger.
  let runs = 0;
  let running = true;
  _setInterestAllocationCoordinatorForTest({
    runner: async () => {
      runs += 1;
      return emptyResult();
    },
    isRunning: () => running,
  });

  assert.doesNotThrow(() => {
    markInterestAllocationPending({ householdId: HH, source: 'during-run' });
  });
  const deferredResult = await drainPendingInterestAllocations();

  assert.equal(runs, 0, 'the drain must defer to the run already in flight');
  assert.equal(deferredResult.deferred, 1);
  assert.equal(
    isInterestAllocationPending(HH),
    true,
    'deferred work must stay queued — dropping it is the staleness bug all over again',
  );
  assert.equal(
    deferredResult.pendingRemaining,
    1,
    'pendingRemaining is what tells the job to come back promptly',
  );

  // Once the in-flight run finishes, the next drain picks the work back up.
  running = false;
  const secondResult = await drainPendingInterestAllocations();
  assert.equal(runs, 1, 'the deferred household must run on the next drain');
  assert.equal(secondResult.households, 1);
  assert.equal(isInterestAllocationPending(HH), false);
});

test('a failing allocation is contained: the drain reports it and keeps going', async () => {
  const ran: number[] = [];
  _setInterestAllocationCoordinatorForTest({
    runner: async (opts) => {
      ran.push(opts.householdId);
      if (opts.householdId === HH) throw new Error('allocator exploded');
      return emptyResult();
    },
  });

  markInterestAllocationPending({ householdId: HH, source: 'a' });
  markInterestAllocationPending({ householdId: OTHER_HH, source: 'b' });
  const result = await drainPendingInterestAllocations();

  assert.equal(result.failed, 1);
  assert.equal(result.households, 1, 'one household failing must not strand the other');
  assert.equal(ran.length, 2);
  assert.equal(
    isInterestAllocationPending(HH),
    false,
    'a failed run is not re-queued: the ledger staleness signal is the safety net, and '
      + 're-queueing would spin forever on a persistent failure',
  );
});

test('a mark drains on its own, without anyone calling the job', async () => {
  // The debounce is what makes this automatic rather than merely scheduled.
  let runs = 0;
  _setInterestAllocationCoordinatorForTest({
    debounceMs: 0,
    runner: async () => {
      runs += 1;
      return emptyResult();
    },
  });

  markInterestAllocationPending({ householdId: HH, source: 'self-drain' });
  await waitForInterestAllocationDrain();

  assert.equal(runs, 1);
  assert.equal(isInterestAllocationPending(HH), false);
});

test('a self-drain whose allocation throws produces no unhandled rejection', async () => {
  _setInterestAllocationCoordinatorForTest({
    debounceMs: 0,
    runner: async () => {
      throw new Error('allocator exploded');
    },
  });

  markInterestAllocationPending({ householdId: HH, source: 'boom' });
  await waitForInterestAllocationDrain();

  assert.equal(isInterestAllocationPending(HH), false);
});

test('markInterestAllocationPending never throws, whatever it is handed', () => {
  // This runs inside import commit and PATCH handlers. If it can throw, it can
  // fail an import, which is the one thing it must never do.
  assert.doesNotThrow(() => {
    markInterestAllocationPending({ householdId: Number.NaN, source: 'bad' });
  });
  assert.doesNotThrow(() => {
    markInterestAllocationPending({ householdId: 0, source: 'bad' });
  });
  assert.doesNotThrow(() => {
    markInterestAllocationPending(
      undefined as unknown as { householdId: number; source: string },
    );
  });
  assert.equal(isInterestAllocationPending(Number.NaN), false);
  assert.equal(isInterestAllocationPending(0), false);
});

// ---------------------------------------------------------------------------
// The enabled gate. This is the CI hang, pinned.
//
// `interestAllocationEnabled` is false under NODE_ENV=test and whenever
// INTEREST_ALLOCATION_ENABLED is set falsy, but for one release the flag was
// read ONLY by the job definition's `enabledDefault` — a file that only
// server.ts imports. The coordinator itself never consulted it, so in a unit
// worker every statement commit and every loan retag armed a real five-second
// timer whose fallback path ran the REAL allocator against the worker's
// per-PID SQLite database. Locally the file finished first and the unref'd
// timer died with the process; on a slower CI runner it fired, and
// `backend-test-shard (3)` ran for four hours.
//
// These two tests are the reason that cannot come back, and neither depends on
// timing to prove it: the first asserts on the queue itself, which is empty
// because marking refused, not because a timer happened not to fire yet.
// ---------------------------------------------------------------------------

test('marking while disabled queues nothing, arms nothing, and drains nothing', async () => {
  let runs = 0;
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    enabled: false,
    // Zero window: were anything armed at all, it would fire on the next tick
    // and this test would see it. Nothing is armed, so nothing does.
    debounceMs: 0,
    runner: async () => {
      runs += 1;
      return emptyResult();
    },
  });

  markInterestAllocationPending({ householdId: HH, source: 'statement-import' });
  markInterestAllocationPending({ householdId: OTHER_HH, source: 'counterparty-retag' });

  assert.equal(
    isInterestAllocationPending(HH),
    false,
    'a disabled feature must be inert, not merely quiet — nothing may queue',
  );
  assert.equal(isInterestAllocationPending(OTHER_HH), false);

  // Resolves immediately when nothing is queued, armed, or draining. If marking
  // had armed a window this would have to wait for it.
  await waitForInterestAllocationDrain();
  assert.equal(runs, 0, 'the allocator must not run — this is the four-hour hang');

  // And the queue stayed empty, so a later deliberate drain has nothing stored
  // up to suddenly execute.
  const result = await drainPendingInterestAllocations();
  assert.equal(runs, 0);
  assert.equal(result.households, 0);
  assert.equal(result.pendingRemaining, 0);
});

test('the gate defaults to OFF in a unit-test worker, with no override at all', () => {
  // The real CI condition, not a simulation of it: no `enabled` override, so
  // the coordinator falls through to config/env's `interestAllocationEnabled`,
  // which is false because test/setup.ts sets NODE_ENV=test before anything
  // loads. If this ever fails, either the env gate or the --import hook has
  // regressed and the hang is live again.
  _resetInterestAllocationCoordinatorForTest();

  markInterestAllocationPending({ householdId: HH, source: 'statement-import' });

  assert.equal(
    isInterestAllocationPending(HH),
    false,
    'NODE_ENV=test must switch the automatic allocator off without any test seam',
  );
});

test('drainPendingInterestAllocations stays callable while disabled', async () => {
  // The gate covers MARKING only. The job handler's body and any test that
  // wants to exercise the allocator deliberately must still work.
  let runs = 0;
  _resetInterestAllocationCoordinatorForTest();
  _setInterestAllocationCoordinatorForTest({
    enabled: false,
    debounceMs: 60_000,
    runner: async () => {
      runs += 1;
      return emptyResult();
    },
  });

  const result = await drainPendingInterestAllocations();
  assert.equal(result.households, 0, 'an empty queue drains to nothing, disabled or not');
  assert.equal(result.failed, 0);
  assert.equal(runs, 0);
});
