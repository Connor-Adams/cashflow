/**
 * Drain the line-of-credit interest reallocation queue.
 *
 * This job is a collector, not a poller. The inputs to the allocation only move
 * when a statement lands billed interest or a loan is retagged, and both of
 * those mark the household pending in
 * `contacts/interestAllocationCoordinator`, which arms a short window and fires
 * this job through the registry. A blind daily sweep would recompute for
 * nothing 364 days a year and still leave a day of staleness after each real
 * change.
 *
 * The cron is the safety net: it collects work a drain could not finish — most
 * importantly a pass this instance lost the advisory lock for, whose queue
 * nothing else will wake. On an idle tick the queue is empty and the handler
 * returns without touching the database. Work deferred because a run was in
 * flight re-arms the coordinator's own window, so it does not wait for the
 * cron; `pendingRemaining` in the run summary is how you see either case.
 *
 * Running it through `defineJob` (rather than a bare timer) is what buys the
 * Postgres advisory lock: the allocator persists by delete-then-insert, so two
 * instances recomputing the same household concurrently could interleave a
 * delete with the other's insert and leave the table short.
 */
import { defineJob, runJobByName } from '../registry';
import {
  drainPendingInterestAllocations,
  setInterestAllocationFlushHook,
  INTEREST_ALLOCATION_JOB,
} from '../../contacts/interestAllocationCoordinator';
import * as env from '../../config/env';

defineJob({
  name: INTEREST_ALLOCATION_JOB,
  cronDefault: env.interestAllocationCron,
  enabledDefault: env.interestAllocationEnabled,
  handler: async () => {
    const r = await drainPendingInterestAllocations();
    return { summary: { ...r } };
  },
});

// Importing this file is what upgrades the coordinator's own timer from "drain
// in-process" to "drain through the job runner", with the advisory lock and the
// JobRun history that come with it. Only server.ts imports it, which keeps the
// runner (and the OTel exporters behind it) out of unit tests.
setInterestAllocationFlushHook(() => runJobByName(INTEREST_ALLOCATION_JOB));
