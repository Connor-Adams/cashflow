import { createHash } from 'node:crypto';
import { sequelize } from '../db';
import { logger } from '../observability/logger';

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

function hashName(name: string): bigint {
  // Stable 64-bit signed int from sha256(name). Postgres advisory locks take
  // a bigint key.
  const digest = createHash('sha256').update(name).digest();
  const view = new DataView(digest.buffer, digest.byteOffset, 8);
  return view.getBigInt64(0, false);
}

// Consumed by pgLock.test.ts via dynamic import; fallow's static resolver can't follow it.
// fallow-ignore-next-line unused-export
export function hashJobNameForTest(name: string): bigint {
  return hashName(name);
}

function isPostgres(): boolean {
  return sequelize.getDialect() === 'postgres';
}

export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  if (!isPostgres()) {
    const value = await fn();
    return { acquired: true, value };
  }
  const key = hashName(name).toString();
  let acquired = false;
  try {
    const [rows] = (await sequelize.query(
      'SELECT pg_try_advisory_lock(CAST(? AS bigint)) AS locked',
      { replacements: [key] },
    )) as [Array<{ locked: boolean }>, unknown];
    acquired = Boolean(rows[0]?.locked);
  } catch (err) {
    logger.error({ err, name }, 'job_lock_query_failed');
    return { acquired: false };
  }
  if (!acquired) return { acquired: false };
  try {
    const value = await fn();
    return { acquired: true, value };
  } finally {
    try {
      await sequelize.query('SELECT pg_advisory_unlock(CAST(? AS bigint))', {
        replacements: [key],
      });
    } catch (err) {
      logger.error({ err, name }, 'job_lock_release_failed');
    }
  }
}
