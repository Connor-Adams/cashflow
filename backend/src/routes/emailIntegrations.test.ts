/**
 * Unit tests for parseForceReprocessMessageIds, the option-parsing helper
 * behind POST /api/email/scan/google's optional forceReprocessMessageIds
 * body field (FIX 3's caller: without this, scanInbox's
 * forceReprocessMessageIds option — the mechanism that backfills the
 * 141 dateless production Amazon orders — had no way to be reached from an
 * HTTP request at all).
 *
 * scanInbox itself is exercised end-to-end (Gmail deps + DB) in
 * integrations/scanReceiptsReprocess.test.ts; this file only proves the
 * route's parsing/validation of the new field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseForceReprocessMessageIds } from './emailIntegrations';

test('parseForceReprocessMessageIds returns the ids when given a string array', () => {
  const result = parseForceReprocessMessageIds({ forceReprocessMessageIds: ['msg-a', 'msg-b'] });
  assert.deepEqual(result, ['msg-a', 'msg-b']);
});

test('parseForceReprocessMessageIds returns undefined when the field is absent', () => {
  assert.equal(parseForceReprocessMessageIds({}), undefined);
});

test('parseForceReprocessMessageIds returns undefined when the field is not an array', () => {
  assert.equal(parseForceReprocessMessageIds({ forceReprocessMessageIds: 'msg-a' }), undefined);
});

test('parseForceReprocessMessageIds drops non-string and empty-string entries', () => {
  const result = parseForceReprocessMessageIds({
    forceReprocessMessageIds: ['msg-a', 42, null, '', undefined, 'msg-b'],
  });
  assert.deepEqual(result, ['msg-a', 'msg-b']);
});

test('parseForceReprocessMessageIds returns undefined when every entry is dropped', () => {
  assert.equal(parseForceReprocessMessageIds({ forceReprocessMessageIds: [42, null, ''] }), undefined);
});

test('parseForceReprocessMessageIds caps the list at 500', () => {
  const ids = Array.from({ length: 600 }, (_v, i) => `msg-${i}`);
  const result = parseForceReprocessMessageIds({ forceReprocessMessageIds: ids });
  assert.equal(result?.length, 500);
  assert.deepEqual(result?.[0], 'msg-0');
  assert.deepEqual(result?.[499], 'msg-499');
});
