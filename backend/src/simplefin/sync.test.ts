import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolutionFailureReason } from './sync';

// Regression cover for a sync that ran daily for three months and imported
// nothing while reporting success.
//
// The 20260628000001 migration backfilled simplefin_account_links with the
// Cashflow account NAME in the simplefin_account_id column, as a placeholder,
// on the stated assumption that "sync resolves by account_id regardless". It
// does not — resolveAccountId looks the remote ACT-… id up against exactly that
// column, so every account missed. The run then logged
// simplefin_sync_account_unresolved per account, produced an empty runs array,
// and the job computed errors = runs.filter(status === 'error').length = 0.
//
// errors=0 with accountRuns=0 is indistinguishable from "nothing new to import",
// so no alert could fire. Total resolution failure has to be loud.

test('total resolution failure is reported when links exist but none resolve', () => {
  assert.equal(resolutionFailureReason(29, 0), 'links_unresolved');
});

test('an integration with no links yet is not a failure', () => {
  // Freshly connected, nothing linked through the UI: legitimately nothing to do.
  assert.equal(resolutionFailureReason(0, 0), null);
});

test('full resolution is not a failure', () => {
  assert.equal(resolutionFailureReason(29, 29), null);
});

test('partial resolution is not treated as total failure', () => {
  // One stale link among many is a per-account warning, not a reason to fail the
  // run and hold back the sync window for the accounts that did resolve.
  assert.equal(resolutionFailureReason(29, 28), null);
  assert.equal(resolutionFailureReason(29, 1), null);
});
