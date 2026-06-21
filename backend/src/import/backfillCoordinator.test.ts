import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setBackfillRunnerForTest,
  isBackfillInFlight,
  scheduleInternalBackfill,
  waitForBackfillDrain,
  backfillRunning,
} from './backfillCoordinator';
import type { BackfillFlags, BackfillResult } from './runEnrichmentBackfill';

let calls: BackfillFlags[] = [];
let resolveNextRun: ((r: BackfillResult) => void) | null = null;

function emptyResult(): BackfillResult {
  return { processed: 0, updated: 0, reviewFlagCleared: 0, signalsWritten: 0, skipped: 0 };
}

beforeEach(() => {
  calls = [];
  resolveNextRun = null;
  _setBackfillRunnerForTest(async (flags) => {
    calls.push(flags);
    if (resolveNextRun) {
      return await new Promise<BackfillResult>((resolve) => {
        resolveNextRun = (r) => resolve(r);
      });
    }
    return emptyResult();
  });
  // Wipe any leftover state.
  for (const id of [1, 2, 3, 42, 99]) backfillRunning.delete(id);
});

afterEach(() => {
  _setBackfillRunnerForTest(null);
});

test('single scheduled trigger runs once with passed flags', async () => {
  scheduleInternalBackfill({
    householdId: 42,
    dateFrom: '2026-01-01',
    dateTo: '2026-02-01',
    merchantPattern: 'COSTCO',
    source: 'test',
  });
  assert.equal(isBackfillInFlight(42), true, 'pending should make inFlight true');
  await waitForBackfillDrain(42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].householdId, 42);
  assert.equal(calls[0].dateFrom, '2026-01-01');
  assert.equal(calls[0].dateTo, '2026-02-01');
  assert.equal(calls[0].merchantPattern, 'COSTCO');
  assert.equal(isBackfillInFlight(42), false);
});

test('two distinct-pattern triggers before drain coalesce into a single run with no pattern filter', async () => {
  scheduleInternalBackfill({
    householdId: 1,
    dateFrom: '2026-01-10',
    dateTo: '2026-01-20',
    merchantPattern: 'COSTCO',
    source: 'a',
  });
  scheduleInternalBackfill({
    householdId: 1,
    dateFrom: '2026-01-05',
    dateTo: '2026-01-15',
    merchantPattern: 'STARBUCKS',
    source: 'b',
  });
  await waitForBackfillDrain(1);
  assert.equal(calls.length, 1, 'should coalesce to one run');
  // Wider window after merge.
  assert.equal(calls[0].dateFrom, '2026-01-05');
  assert.equal(calls[0].dateTo, '2026-01-20');
  // Distinct patterns → null filter.
  assert.equal(calls[0].merchantPattern, null);
});

test('same-pattern triggers merge while preserving the pattern', async () => {
  scheduleInternalBackfill({
    householdId: 2,
    dateFrom: '2026-03-01',
    dateTo: '2026-03-10',
    merchantPattern: 'NETFLIX',
    source: 'a',
  });
  scheduleInternalBackfill({
    householdId: 2,
    dateFrom: '2026-02-25',
    dateTo: '2026-03-05',
    merchantPattern: 'NETFLIX',
    source: 'b',
  });
  await waitForBackfillDrain(2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].merchantPattern, 'NETFLIX');
  assert.equal(calls[0].dateFrom, '2026-02-25');
  assert.equal(calls[0].dateTo, '2026-03-10');
});

test('null dateFrom or dateTo widens the merged window to unbounded', async () => {
  scheduleInternalBackfill({
    householdId: 3,
    dateFrom: '2026-04-01',
    dateTo: '2026-04-30',
    source: 'a',
  });
  scheduleInternalBackfill({
    householdId: 3,
    dateFrom: null,
    dateTo: '2026-05-01',
    source: 'b',
  });
  await waitForBackfillDrain(3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dateFrom, null, 'null lower-bound trigger should widen to null');
  assert.equal(calls[0].dateTo, '2026-05-01');
});

test('triggers that arrive WHILE a run is in flight queue a follow-up run', async () => {
  // Set up a runner that blocks until we release it.
  let releaseFirstRun!: () => void;
  let firstRunStarted!: () => void;
  const firstRunStartedP = new Promise<void>((resolve) => {
    firstRunStarted = resolve;
  });
  let runIndex = 0;
  _setBackfillRunnerForTest(async (flags) => {
    runIndex += 1;
    calls.push(flags);
    if (runIndex === 1) {
      firstRunStarted();
      await new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      });
    }
    return emptyResult();
  });

  scheduleInternalBackfill({
    householdId: 99,
    dateFrom: '2026-01-01',
    dateTo: '2026-01-31',
    source: 'a',
  });
  await firstRunStartedP;

  // While the first run is mid-flight, schedule a second trigger.
  scheduleInternalBackfill({
    householdId: 99,
    dateFrom: '2026-02-01',
    dateTo: '2026-02-28',
    source: 'b',
  });

  releaseFirstRun();
  await waitForBackfillDrain(99);
  assert.equal(calls.length, 2, 'second trigger should drain after first finishes');
  assert.equal(calls[0].dateFrom, '2026-01-01');
  assert.equal(calls[0].dateTo, '2026-01-31');
  assert.equal(calls[1].dateFrom, '2026-02-01');
  assert.equal(calls[1].dateTo, '2026-02-28');
});
