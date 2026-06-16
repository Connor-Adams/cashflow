/**
 * Vault storage helper (Cashflow issue #241).
 *
 * Persists arbitrary finance documents — receipts that aren't tied to a
 * transaction, statements, tax slips, invoices, warranties, contracts — with
 * AES-256-GCM encryption at rest when the vault key is configured.
 *
 * Layout
 * ------
 * Bytes are written through the same physical channels as receipts:
 *   - Local: the receipts upload dir, under a `vault/` subdirectory, so
 *     ops can mount one volume for "user-uploaded files" but the two
 *     namespaces don't collide.
 *   - S3: same bucket as receipts, with a distinct key prefix (default
 *     `vault`) so a single bucket policy + CORS works for both.
 *
 * Encryption envelope (when enabled)
 * ----------------------------------
 *   version(1) | iv(12) | tag(16) | ciphertext
 * The version byte lets us rotate the algorithm later without breaking
 * documents stored under v1. The auth tag protects against silent
 * tampering — a flipped bit in S3 fails closed on download.
 *
 * Key sourcing
 * ------------
 * Reuses the existing EMAIL_INTEGRATION_ENCRYPTION_KEY (64-char hex). A
 * dedicated VAULT_ENCRYPTION_KEY env var is honoured when set so vault
 * keys can be rotated independently of email-integration keys. When
 * neither is set, vault writes fall back to plaintext-at-rest (records the
 * `encryptionAlgorithm: 'none'` metadata so download knows not to decrypt).
 * Production must set a key; dev/test can opt-in.
 */
import fs from 'fs/promises';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getReceiptsUploadDir } from '../config/receipts';

const VERSION_BYTE = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

// Same literal union also declared in models/VaultDocument.ts; intentional domain-local copy to avoid a storage->model import.
export type VaultEncryptionAlgorithm = 'aes-256-gcm' | 'none';

export interface VaultPutResult {
  storedFilename: string;
  storageKind: 'local' | 's3';
  encryptionAlgorithm: VaultEncryptionAlgorithm;
  encryptionKeyVersion: number;
}

export interface VaultObject {
  buffer: Buffer;
  contentType: string;
  originalName: string;
}

interface VaultS3Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  keyPrefix: string;
}

function getS3Config(): VaultS3Config | null {
  const endpoint = process.env.AWS_ENDPOINT_URL?.trim();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const bucket =
    process.env.AWS_S3_BUCKET_NAME?.trim() ||
    process.env.S3_BUCKET_NAME?.trim();

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: process.env.AWS_DEFAULT_REGION?.trim() || 'auto',
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE !== 'false',
    keyPrefix: (process.env.VAULT_S3_KEY_PREFIX?.trim() || 'vault')
      .replace(/^\/+/, '')
      .replace(/\/+$/, ''),
  };
}

function createClient(config: VaultS3Config): S3Client {
  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  };
  return new S3Client(clientConfig);
}

function createVaultKey(storedFilename: string): string {
  const config = getS3Config();
  if (!config?.keyPrefix) return storedFilename;
  return `${config.keyPrefix}/${storedFilename}`;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (
    body &&
    typeof body === 'object' &&
    'transformToByteArray' in body &&
    typeof body.transformToByteArray === 'function'
  ) {
    return Buffer.from(await body.transformToByteArray());
  }
  if (
    body &&
    typeof body === 'object' &&
    Symbol.asyncIterator in body
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unable to read vault object from storage');
}

let cachedKey: Buffer | null = null;
function loadKey(): Buffer | null {
  if (cachedKey) return cachedKey;
  const raw =
    process.env.VAULT_ENCRYPTION_KEY?.trim() ||
    process.env.EMAIL_INTEGRATION_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'VAULT_ENCRYPTION_KEY (or EMAIL_INTEGRATION_ENCRYPTION_KEY fallback) must be a 64-character hex string (32 bytes)',
    );
  }
  cachedKey = Buffer.from(raw, 'hex');
  return cachedKey;
}

function encryptBuffer(plain: Buffer): Buffer {
  const key = loadKey();
  if (!key) return plain;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_BYTE]), iv, tag, enc]);
}

function decryptBuffer(envelope: Buffer): Buffer {
  const key = loadKey();
  if (!key) {
    throw new Error('Vault encryption key is not configured; cannot decrypt');
  }
  if (envelope.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error('Vault envelope too short to be valid');
  }
  const version = envelope[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unsupported vault envelope version: ${version}`);
  }
  const iv = envelope.subarray(1, 1 + IV_LEN);
  const tag = envelope.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const cipher = envelope.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}

export function isVaultEncryptionConfigured(): boolean {
  return loadKey() !== null;
}

export function getVaultLocalDir(): string {
  return path.join(getReceiptsUploadDir(), 'vault');
}

/**
 * Persist a vault object. Returns metadata the caller should record on the
 * vault_documents row so download knows whether/how to decrypt.
 */
export async function saveVaultObject(
  storedFilename: string,
  object: VaultObject,
): Promise<VaultPutResult> {
  const key = loadKey();
  const algorithm: VaultEncryptionAlgorithm = key ? 'aes-256-gcm' : 'none';
  const payload = key ? encryptBuffer(object.buffer) : object.buffer;

  const config = getS3Config();
  if (!config) {
    const dir = getVaultLocalDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, storedFilename), payload);
    return {
      storedFilename,
      storageKind: 'local',
      encryptionAlgorithm: algorithm,
      encryptionKeyVersion: 1,
    };
  }

  const s3Key = createVaultKey(storedFilename);
  await createClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: s3Key,
      Body: payload,
      // We deliberately do NOT send the original mime type on the encrypted
      // blob — the bytes are ciphertext when encryption is active. Use
      // application/octet-stream so any auto-decompression / sniffing in S3
      // proxies cannot mangle them. The plaintext content type is preserved
      // in the vault_documents row and applied on download.
      ContentType: algorithm === 'aes-256-gcm' ? 'application/octet-stream' : object.contentType,
      Metadata: {
        originalName: object.originalName.slice(0, 500),
        algorithm,
      },
    }),
  );
  return {
    storedFilename: s3Key,
    storageKind: 's3',
    encryptionAlgorithm: algorithm,
    encryptionKeyVersion: 1,
  };
}

export async function readVaultObject(
  storedFilename: string,
  algorithm: VaultEncryptionAlgorithm,
): Promise<Buffer> {
  let raw: Buffer;
  const config = getS3Config();
  if (!config) {
    const dir = getVaultLocalDir();
    raw = await fs.readFile(path.join(dir, storedFilename));
  } else {
    const res = await createClient(config).send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: storedFilename,
      }),
    );
    raw = await streamToBuffer(res.Body);
  }
  if (algorithm === 'aes-256-gcm') return decryptBuffer(raw);
  return raw;
}

export async function deleteVaultObject(storedFilename: string): Promise<void> {
  const config = getS3Config();
  if (!config) {
    const dir = getVaultLocalDir();
    try {
      await fs.unlink(path.join(dir, storedFilename));
    } catch (e) {
      // Tolerate already-missing files; this is called during DELETE and
      // we don't want a stray IO error to mask the row deletion.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return;
  }

  await createClient(config).send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: storedFilename,
    }),
  );
}
