import test from 'node:test';
import assert from 'node:assert/strict';

import { GoogleOAuthError, parseOauthErrorCode, isReauthRequiredError } from './gmail';

test('parseOauthErrorCode extracts the oauth error code from a Google error body', () => {
  assert.equal(
    parseOauthErrorCode(
      '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
    ),
    'invalid_grant',
  );
  assert.equal(parseOauthErrorCode('totally not json'), null);
  assert.equal(parseOauthErrorCode('{"no_error_field":true}'), null);
});

test('isReauthRequiredError is true only for invalid_grant OAuth failures', () => {
  assert.equal(
    isReauthRequiredError(new GoogleOAuthError('Google refresh failed (400)', 400, 'invalid_grant')),
    true,
  );
  // A 400 that is NOT invalid_grant (e.g. invalid_request) is a bug, not a dead token.
  assert.equal(
    isReauthRequiredError(new GoogleOAuthError('Google refresh failed (400)', 400, 'invalid_request')),
    false,
  );
  assert.equal(isReauthRequiredError(new Error('network down')), false);
});
