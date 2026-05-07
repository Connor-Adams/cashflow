import crypto from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(crypto.scrypt);
const KEY_LEN = 64;
const PASSWORD_PARAMS = 'scrypt:N=16384,r=8,p=1,keyLen=64';

export async function hashPassword(password: string): Promise<{
  hash: string;
  salt: string;
  params: string;
}> {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return {
    hash: key.toString('base64url'),
    salt,
    params: PASSWORD_PARAMS,
  };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string
): Promise<boolean> {
  const key = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length !== key.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
