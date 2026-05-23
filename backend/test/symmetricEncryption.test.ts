import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptSecret,
  decryptSecret,
  __resetKeyCacheForTests,
} from '../src/util/symmetricEncryption';

before(() => {
  // Stable 32-byte key, hex-encoded.
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  __resetKeyCacheForTests();
});

test('encryptSecret + decryptSecret round-trip', () => {
  const plaintext = 'ya29.a0ARrdaM_eXamPLE_tOkEn_with_special_chars_+/=';
  const enc = encryptSecret(plaintext);
  assert.notEqual(enc, plaintext);
  assert.equal(decryptSecret(enc), plaintext);
});

test('encryptSecret produces a different ciphertext each call (random IV)', () => {
  const a = encryptSecret('same input');
  const b = encryptSecret('same input');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'same input');
  assert.equal(decryptSecret(b), 'same input');
});

test('decryptSecret rejects a tampered ciphertext (auth tag verifies)', () => {
  const enc = encryptSecret('hello world');
  const buf = Buffer.from(enc, 'base64');
  // Flip a bit in the ciphertext body.
  buf[buf.length - 1] ^= 0x01;
  const tampered = buf.toString('base64');
  assert.throws(() => decryptSecret(tampered));
});

test('decryptSecret rejects unknown version byte', () => {
  const enc = encryptSecret('payload');
  const buf = Buffer.from(enc, 'base64');
  buf[0] = 0x99;
  const wrongVersion = buf.toString('base64');
  assert.throws(() => decryptSecret(wrongVersion), /version/i);
});

test('throws clearly when key is missing or short', () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '';
  __resetKeyCacheForTests();
  assert.throws(() => encryptSecret('x'), /EMAIL_INTEGRATION_ENCRYPTION_KEY/);

  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = 'too-short';
  __resetKeyCacheForTests();
  assert.throws(() => encryptSecret('x'), /64-character hex/);

  // Restore for downstream tests.
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  __resetKeyCacheForTests();
});
