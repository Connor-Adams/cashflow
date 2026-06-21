/**
 * Unit tests for connect() ordering: the encryption-key validity check MUST run
 * before the setup-token exchange (issue #814). With no/invalid key configured,
 * connect() rejects with EncryptionUnconfiguredError BEFORE any network call —
 * proving the single-use token is never consumed. We spy on globalThis.fetch
 * (claimAccessUrl's only side effect) to assert it is never invoked, and assert
 * no DB access is needed to reach the throw.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptionUnconfiguredError, connect } from './service';
import { __resetKeyCacheForTests } from '../util/symmetricEncryption';

const VALID_CLAIM_URL = 'https://bridge.simplefin.org/simplefin/claim/tok-xyz';
const SETUP_TOKEN = Buffer.from(VALID_CLAIM_URL, 'utf8').toString('base64');

const originalKey = process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = originalKey;
  __resetKeyCacheForTests();
  globalThis.fetch = originalFetch;
});

test('connect rejects with EncryptionUnconfiguredError when key is unset, never exchanging the token', async () => {
  delete process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY;
  __resetKeyCacheForTests();

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response('should-never-be-reached', { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    connect({ userId: 1, householdId: null, setupToken: SETUP_TOKEN }),
    (err: unknown) => err instanceof EncryptionUnconfiguredError,
  );
  assert.equal(fetchCalls, 0, 'claimAccessUrl (fetch) must NOT be called — token not consumed');
});

test('connect rejects with EncryptionUnconfiguredError when key is the wrong length', async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = 'deadbeef'; // valid hex, wrong length
  __resetKeyCacheForTests();

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response('x', { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    connect({ userId: 1, householdId: null, setupToken: SETUP_TOKEN }),
    (err: unknown) => err instanceof EncryptionUnconfiguredError,
  );
  assert.equal(fetchCalls, 0, 'wrong-length key must not exchange the token');
});

test('connect rejects with EncryptionUnconfiguredError when key is non-hex', async () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = 'z'.repeat(64); // right length, non-hex
  __resetKeyCacheForTests();

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response('x', { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  await assert.rejects(
    connect({ userId: 1, householdId: null, setupToken: SETUP_TOKEN }),
    (err: unknown) => err instanceof EncryptionUnconfiguredError,
  );
  assert.equal(fetchCalls, 0, 'non-hex key must not exchange the token');
});
