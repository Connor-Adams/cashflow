import fs from 'fs/promises';
import path from 'path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getReceiptsUploadDir } from '../config/receipts';

export type ReceiptObject = {
  buffer: Buffer;
  contentType: string;
  originalName: string;
};

type S3ReceiptStorageConfig = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  keyPrefix: string;
};

function getS3Config(): S3ReceiptStorageConfig | null {
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
    keyPrefix: (process.env.RECEIPTS_S3_KEY_PREFIX?.trim() || 'receipts')
      .replace(/^\/+/, '')
      .replace(/\/+$/, ''),
  };
}

function createClient(config: S3ReceiptStorageConfig): S3Client {
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

function createReceiptKey(storedFilename: string): string {
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
  throw new Error('Unable to read receipt object from storage');
}

export function isS3ReceiptStorageEnabled(): boolean {
  return getS3Config() !== null;
}

export async function saveReceiptObject(
  storedFilename: string,
  object: ReceiptObject,
): Promise<string> {
  const config = getS3Config();
  if (!config) {
    const dir = getReceiptsUploadDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, storedFilename), object.buffer);
    return storedFilename;
  }

  const key = createReceiptKey(storedFilename);
  await createClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: object.buffer,
      ContentType: object.contentType,
      Metadata: {
        originalName: object.originalName.slice(0, 500),
      },
    }),
  );
  return key;
}

export async function readReceiptObject(storedFilename: string): Promise<Buffer> {
  const config = getS3Config();
  if (!config) {
    const dir = getReceiptsUploadDir();
    return fs.readFile(path.join(dir, storedFilename));
  }

  const res = await createClient(config).send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: storedFilename,
    }),
  );
  return streamToBuffer(res.Body);
}

export async function deleteReceiptObject(storedFilename: string): Promise<void> {
  const config = getS3Config();
  if (!config) {
    const dir = getReceiptsUploadDir();
    await fs.unlink(path.join(dir, storedFilename));
    return;
  }

  await createClient(config).send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: storedFilename,
    }),
  );
}
