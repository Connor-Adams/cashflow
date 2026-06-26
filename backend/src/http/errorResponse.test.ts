import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getErrorCode,
  getErrorStatus,
  getClientErrorMessage,
} from './errorResponse';

describe('getErrorCode', () => {
  it('returns the error code when present', () => {
    assert.equal(getErrorCode({ code: 'LIMIT_FILE_SIZE' }), 'LIMIT_FILE_SIZE');
  });

  it('returns an empty string when no code is present', () => {
    assert.equal(getErrorCode(new Error('boom')), '');
    assert.equal(getErrorCode(null), '');
    assert.equal(getErrorCode('not an object'), '');
  });
});

describe('getErrorStatus', () => {
  it('maps LIMIT_FILE_SIZE to 400', () => {
    assert.equal(getErrorStatus({}, 'LIMIT_FILE_SIZE'), 400);
  });

  it('uses an explicit status', () => {
    assert.equal(getErrorStatus({ status: 404 }, ''), 404);
  });

  it('uses statusCode when status is absent', () => {
    assert.equal(getErrorStatus({ statusCode: 422 }, ''), 422);
  });

  it('defaults to 500 with no status metadata', () => {
    assert.equal(getErrorStatus(new Error('boom'), ''), 500);
  });

  it('clamps out-of-range statuses to 500', () => {
    assert.equal(getErrorStatus({ status: 200 }, ''), 500);
    assert.equal(getErrorStatus({ status: 999 }, ''), 500);
  });
});

describe('getClientErrorMessage', () => {
  it('returns a generic message for 5xx, never the raw error text', () => {
    const sqlError = new Error(
      'SequelizeUniqueConstraintError: duplicate key value violates unique constraint "transactions_pkey"',
    );
    assert.equal(getClientErrorMessage(sqlError, 500), 'Internal Server Error');
    assert.equal(getClientErrorMessage(sqlError, 503), 'Internal Server Error');
  });

  it('passes through the message for explicit 4xx errors', () => {
    assert.equal(
      getClientErrorMessage(new Error('Account not found'), 404),
      'Account not found',
    );
    assert.equal(
      getClientErrorMessage(new Error('Invalid currency code'), 400),
      'Invalid currency code',
    );
  });

  it('falls back to a generic message for a 4xx error with no message', () => {
    assert.equal(getClientErrorMessage(new Error(''), 400), 'Bad Request');
    assert.equal(getClientErrorMessage({}, 400), 'Bad Request');
  });

  it('never leaks ENOENT filesystem paths even on 4xx', () => {
    const fsError = new Error(
      "ENOENT: no such file or directory, open '/srv/cashflow/data/secret.sqlite'",
    );
    const msg = getClientErrorMessage(fsError, 400);
    assert.ok(!msg.includes('ENOENT'));
    assert.ok(!msg.includes('/srv/cashflow'));
  });
});
