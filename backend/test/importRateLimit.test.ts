import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importUploadLimiter } from '../src/routes/importRateLimit';

test('importUploadLimiter is Express middleware', () => {
  assert.equal(typeof importUploadLimiter, 'function');
});
