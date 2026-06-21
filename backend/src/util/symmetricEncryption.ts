/**
 * symmetricEncryption — AES-256-GCM encryption of small secrets at rest.
 *
 * Used to wrap OAuth access/refresh tokens before storing them in the database.
 * Key comes from EMAIL_INTEGRATION_ENCRYPTION_KEY (32 random bytes, hex-encoded).
 *
 * Ciphertext envelope (base64-encoded): version(1) || iv(12) || tag(16) || cipher
 *   - version: 0x01 — lets us rotate the algorithm later without breaking old rows
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const VERSION_BYTE = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

/** 64 hex chars = 32 bytes. The single source of truth for "valid key shape". */
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

function decodeKey(rawHex: string): Buffer {
  const cleaned = rawHex.trim();
  if (!KEY_HEX_RE.test(cleaned)) {
    throw new Error(
      'EMAIL_INTEGRATION_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(cleaned, 'hex');
}

/**
 * Side-effect-free check that EMAIL_INTEGRATION_ENCRYPTION_KEY is present AND a
 * valid 64-char hex string. Reuses the same regex as decodeKey so "present" and
 * "valid 64-hex" are one check. Does NOT read or mutate the key cache, so it is
 * safe to call before encrypting (e.g. to fail fast before consuming a
 * single-use token) and at startup. Returns false for unset/empty/wrong-length/
 * non-hex; true only for a genuinely usable key.
 */
export function isEncryptionKeyConfigured(): boolean {
  const raw = process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY;
  return typeof raw === 'string' && KEY_HEX_RE.test(raw.trim());
}

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'EMAIL_INTEGRATION_ENCRYPTION_KEY env var is not set. Generate with: openssl rand -hex 32',
    );
  }
  cachedKey = decodeKey(raw);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([VERSION_BYTE]), iv, tag, enc]);
  return envelope.toString('base64');
}

export function decryptSecret(envelopeBase64: string): string {
  const envelope = Buffer.from(envelopeBase64, 'base64');
  if (envelope.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error('Encrypted envelope too short to be valid');
  }
  const version = envelope[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unsupported encryption envelope version: ${version}`);
  }
  const iv = envelope.subarray(1, 1 + IV_LEN);
  const tag = envelope.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const cipher = envelope.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

/** Test-only: reset the cached key so changing the env var takes effect. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}
