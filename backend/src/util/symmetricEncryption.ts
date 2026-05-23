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

function decodeKey(rawHex: string): Buffer {
  const cleaned = rawHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error(
      'EMAIL_INTEGRATION_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate with: openssl rand -hex 32',
    );
  }
  return Buffer.from(cleaned, 'hex');
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
  const cipher = createCipheriv('aes-256-gcm', key, iv);
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
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8');
}

/** Test-only: reset the cached key so changing the env var takes effect. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}
