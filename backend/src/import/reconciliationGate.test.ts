/**
 * The acknowledgement digest that replaced the bare `acceptUnreconciled: true`
 * override on `POST /api/import/commit`.
 *
 * The property under test is the security one: the value that opens the
 * reconciliation gate is derived from server state, so it cannot be produced by
 * a caller who has not been shown the specific refusal it acknowledges.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acknowledgementAccepted,
  blockingParseErrors,
  unreconciledAcknowledgementDigest,
  unreconciledStatementError,
} from './reconciliationGate';
import type { StatementParseError } from './statementTypes';

const RECON: StatementParseError = {
  rowIndex: -1,
  message: 'statement does not reconcile: computed 6400.00, expected closing 12817.24',
  blocking: true,
};
const OTHER: StatementParseError = {
  rowIndex: -1,
  message: 'statement does not reconcile: computed 1.00, expected closing 2.00',
  blocking: true,
};

test('the digest is deterministic for the same token and the same blocking errors', () => {
  const a = unreconciledAcknowledgementDigest('tok-1', [RECON]);
  const b = unreconciledAcknowledgementDigest('tok-1', [RECON]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('the digest is bound to the preview token', () => {
  assert.notEqual(
    unreconciledAcknowledgementDigest('tok-1', [RECON]),
    unreconciledAcknowledgementDigest('tok-2', [RECON]),
  );
});

test('the digest changes when the blocking errors change', () => {
  assert.notEqual(
    unreconciledAcknowledgementDigest('tok-1', [RECON]),
    unreconciledAcknowledgementDigest('tok-1', [OTHER]),
  );
  assert.notEqual(
    unreconciledAcknowledgementDigest('tok-1', [RECON]),
    unreconciledAcknowledgementDigest('tok-1', [RECON, OTHER]),
  );
});

test('the digest does not depend on the order the blocking errors arrive in', () => {
  assert.equal(
    unreconciledAcknowledgementDigest('tok-1', [RECON, OTHER]),
    unreconciledAcknowledgementDigest('tok-1', [OTHER, RECON]),
  );
});

test('only the exact digest is accepted', () => {
  const digest = unreconciledAcknowledgementDigest('tok-1', [RECON]);
  assert.equal(acknowledgementAccepted(digest, digest), true);
});

test('a blanket flag never opens the gate', () => {
  const digest = unreconciledAcknowledgementDigest('tok-1', [RECON]);
  for (const provided of [true, 'true', 1, {}, [], null, undefined, 'yes']) {
    assert.equal(
      acknowledgementAccepted(digest, provided),
      false,
      `${JSON.stringify(provided) ?? 'undefined'} must not count as an acknowledgement`,
    );
  }
});

test('a digest from a different preview, or a truncated one, is rejected', () => {
  const digest = unreconciledAcknowledgementDigest('tok-1', [RECON]);
  assert.equal(
    acknowledgementAccepted(digest, unreconciledAcknowledgementDigest('tok-2', [RECON])),
    false,
  );
  assert.equal(
    acknowledgementAccepted(digest, unreconciledAcknowledgementDigest('tok-1', [OTHER])),
    false,
  );
  // Length mismatch must not throw (timingSafeEqual requires equal lengths).
  assert.equal(acknowledgementAccepted(digest, digest.slice(0, 8)), false);
  assert.equal(acknowledgementAccepted(digest, `${digest}00`), false);
  assert.equal(acknowledgementAccepted(digest, ''), false);
});

test('blockingParseErrors keeps only the blocking ones', () => {
  const errs: StatementParseError[] = [RECON, { rowIndex: 4, message: 'soft' }];
  assert.deepEqual(blockingParseErrors(errs), [RECON]);
  assert.deepEqual(blockingParseErrors(undefined), []);
});

test('the refusal message points at the acknowledgement, not a boolean', () => {
  const err = unreconciledStatementError('recon.pdf', [RECON]);
  assert.equal(err.status, 422);
  assert.equal(err.code, 'statement_unreconciled');
  assert.match(err.message, /acceptUnreconciled/);
  assert.match(err.message, /acknowledgement digest/);
});
