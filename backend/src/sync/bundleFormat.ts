/**
 * bundleFormat — passphrase-encrypted backup bundle codec (Cashflow #239).
 *
 * Local-first / offline-friendly: the user supplies a passphrase at backup
 * time, which is stretched with PBKDF2-SHA256 into a 32-byte AES-256-GCM
 * key. Each bundle carries its own random salt + IV, so the same passphrase
 * produces a different ciphertext every time and re-encrypting a bundle on
 * restore is a no-op.
 *
 * Envelope (binary, base64-encoded for transport):
 *   version (1 byte, currently 0x01)
 *   salt    (16 bytes, random per bundle)
 *   iv      (12 bytes, random per bundle)
 *   tag     (16 bytes, AES-GCM auth tag)
 *   ciphertext (variable; gzipped JSON payload)
 *
 * Versioning strategy:
 *   - `version` byte rotates when the binary envelope changes (algorithm
 *     change, KDF change, salt/IV size change).
 *   - The JSON payload also carries a `schemaVersion` field (currently 1)
 *     that rotates when the *table set* / *row shape* changes. Restore
 *     refuses a bundle whose schemaVersion is higher than the running
 *     code; restoring an older schemaVersion is allowed with explicit
 *     opt-in (currently a same-major-version check).
 *
 * The cloud sync work scoped for a later issue plugs into this module:
 *   - Replace `encryptBundle` / `decryptBundle` callsites with the same
 *     primitives — the bundle bytes are already cipher-text and safe to
 *     ship to any blob store.
 *   - Add a per-row HMAC for partial-bundle integrity once the sync
 *     server starts shipping deltas. Document in docs/sync.md.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';

const VERSION_BYTE = 0x01;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

/** Bumped when the payload table set or row shape changes. */
export const BUNDLE_SCHEMA_VERSION = 1;

export interface BundlePayload {
  /** Internal payload version. Restore validates compatibility against
   *  the running code's BUNDLE_SCHEMA_VERSION. */
  schemaVersion: number;
  /** ISO-8601 timestamp the bundle was created. */
  createdAt: string;
  /** Human-readable label for the bundle's origin (host/app version). */
  origin: string;
  /** Household id at the source of truth. Restore re-targets to the
   *  current authenticated household, but we record the source so a
   *  user can spot bundles that came from a different household. */
  sourceHouseholdId: number | null;
  /** Per-table row dump. Keys are table names; values are arrays of
   *  plain JSON rows (no model instances). */
  tables: Record<string, unknown[]>;
}

export interface BundleStats {
  /** Bytes of base64-encoded ciphertext on the wire. */
  bytes: number;
  /** Total row count across all tables. */
  rowCount: number;
  /** Per-table row counts for the table_counts column of sync_backups. */
  tableCounts: Record<string, number>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // PBKDF2 is a deliberate choice: works on Node's standard crypto, no
  // native deps, and well-understood. Argon2id would be stronger but
  // requires a native module which we avoid to keep the Railway deploy
  // surface minimal. 200k iterations is the OWASP 2023 baseline for
  // PBKDF2-SHA256.
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
}

function passphraseSanityCheck(passphrase: string): void {
  if (typeof passphrase !== 'string') {
    throw new Error('Passphrase is required');
  }
  // The lower bound is intentionally generous — local-first / single
  // user, so the user is also the threat model. We refuse blank strings
  // because they're almost always a UI bug, not an intentional choice.
  if (passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }
}

/**
 * Encrypt a payload into a base64-encoded bundle envelope.
 * Generates fresh salt + IV per call so repeat backups of identical
 * data still produce divergent ciphertexts.
 */
export function encryptBundle(passphrase: string, payload: BundlePayload): string {
  passphraseSanityCheck(passphrase);
  const json = JSON.stringify(payload);
  const compressed = gzipSync(Buffer.from(json, 'utf8'));

  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  const enc = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([
    Buffer.from([VERSION_BYTE]),
    salt,
    iv,
    tag,
    enc,
  ]);
  return envelope.toString('base64');
}

/**
 * Decrypt a base64-encoded bundle envelope back into its payload.
 * Throws on tampering (auth tag failure), wrong passphrase (auth tag
 * failure on the wrong derived key), or unknown envelope version.
 */
export function decryptBundle(passphrase: string, bundleBase64: string): BundlePayload {
  if (typeof bundleBase64 !== 'string' || bundleBase64.length === 0) {
    throw new Error('Bundle is empty');
  }
  passphraseSanityCheck(passphrase);
  const envelope = Buffer.from(bundleBase64, 'base64');
  const headerLen = 1 + SALT_LEN + IV_LEN + TAG_LEN;
  if (envelope.length < headerLen) {
    throw new Error('Bundle envelope is too short to be valid');
  }
  const version = envelope[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unsupported bundle envelope version: ${version}`);
  }
  const salt = envelope.subarray(1, 1 + SALT_LEN);
  const iv = envelope.subarray(1 + SALT_LEN, 1 + SALT_LEN + IV_LEN);
  const tag = envelope.subarray(
    1 + SALT_LEN + IV_LEN,
    1 + SALT_LEN + IV_LEN + TAG_LEN,
  );
  const ciphertext = envelope.subarray(headerLen);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  // Wrong passphrase / tampering surfaces here as "Unsupported state or
  // unable to authenticate data". We let that bubble up — callers
  // turn it into a 400.
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const json = gunzipSync(decrypted).toString('utf8');
  const parsed = JSON.parse(json) as BundlePayload;

  if (typeof parsed.schemaVersion !== 'number') {
    throw new Error('Bundle is missing a schemaVersion');
  }
  if (parsed.schemaVersion > BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `Bundle schemaVersion ${parsed.schemaVersion} is newer than supported (${BUNDLE_SCHEMA_VERSION}). Upgrade Cashflow before restoring this bundle.`,
    );
  }
  if (!parsed.tables || typeof parsed.tables !== 'object') {
    throw new Error('Bundle is missing tables');
  }
  return parsed;
}

/** Summary of a bundle's wire size + row counts without re-encrypting. */
export function bundleStats(
  bundleBase64: string,
  payload: BundlePayload,
): BundleStats {
  const bytes = Buffer.byteLength(bundleBase64, 'utf8');
  const tableCounts: Record<string, number> = {};
  let rowCount = 0;
  for (const [name, rows] of Object.entries(payload.tables)) {
    const n = Array.isArray(rows) ? rows.length : 0;
    tableCounts[name] = n;
    rowCount += n;
  }
  return { bytes, rowCount, tableCounts };
}
