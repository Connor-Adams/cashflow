import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptSecret,
  decryptSecret,
  __resetKeyCacheForTests,
} from './symmetricEncryption';

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

test('decryptSecret rejects a truncated auth tag (fewer than 16 bytes)', () => {
  const enc = encryptSecret('sensitive');
  const buf = Buffer.from(enc, 'base64');
  const version = buf.subarray(0, 1);
  const iv = buf.subarray(1, 13);
  const shortTag = buf.subarray(13, 21);
  const ciphertext = buf.subarray(29);
  const truncated = Buffer.concat([version, iv, shortTag, ciphertext]).toString('base64');
  assert.throws(() => decryptSecret(truncated));
});

test('decryptSecret rejects a forged auth tag (bit flipped in tag region)', () => {
  const enc = encryptSecret('sensitive');
  const buf = Buffer.from(enc, 'base64');
  buf[13] ^= 0x01;
  assert.throws(() => decryptSecret(buf.toString('base64')));
});

test('decryptSecret rejects ciphertext encrypted under a different key', () => {
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64);
  __resetKeyCacheForTests();
  const enc = encryptSecret('secret');
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = 'b'.repeat(64);
  __resetKeyCacheForTests();
  assert.throws(() => decryptSecret(enc));
  process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
  __resetKeyCacheForTests();
});

test('decryptSecret rejects ciphertext with a corrupted IV', () => {
  const enc = encryptSecret('secret');
  const buf = Buffer.from(enc, 'base64');
  buf[1] ^= 0x01;
  assert.throws(() => decryptSecret(buf.toString('base64')));
});
