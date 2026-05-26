/**
 * Shared test helpers for the chat integration tests.
 *
 * Each test file calls `setupChatTestDb()` in `before()` with a legacy
 * sqlite-style basename ("test-integration-X.sqlite"); the helper strips the
 * prefix/suffix to derive a short test name, then provisions a per-file
 * Postgres database via setupPgTestDb. The `dbPath` returned to callers is
 * the Postgres database name — name kept for callsite compatibility.
 *
 * Why not in test/integration/ root: the `*.test.ts` glob in package.json's
 * `test:integration` script would treat any file there as a test. The chat/
 * subdir keeps shared helpers out of that glob.
 */
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from '../_setup/pgTestDb.js';

const activeDbs = new Map<string, PgTestDb>();

export interface ChatTestModels {
  models: typeof import('../../../src/models/index.js');
}

export async function setupChatTestDb(dbBasename: string): Promise<{
  models: typeof import('../../../src/models/index.js');
  dbPath: string;
}> {
  const name = dbBasename.replace(/^test-integration-/, '').replace(/\.sqlite$/, '');
  const pg = await setupPgTestDb(name);
  activeDbs.set(pg.databaseName, pg);
  const models = await import('../../../src/models/index.js');
  return { models, dbPath: pg.databaseName };
}

export async function teardownChatTestDb(
  _models: typeof import('../../../src/models/index.js') | undefined,
  dbPath: string,
): Promise<void> {
  const pg = activeDbs.get(dbPath);
  if (pg) {
    await teardownPgTestDb(pg);
    activeDbs.delete(dbPath);
  }
}
