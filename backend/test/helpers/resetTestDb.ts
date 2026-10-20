/**
 * Per-test database reset that is equivalent to `sequelize.sync({ force: true })`
 * — every table exists and is empty, autoincrement counters restart at 1 — but
 * pays for the schema build only ONCE per test process.
 *
 * WHY: `sync({ force: true })` drops and recreates all ~96 models' tables plus
 * their indexes: ~540 DDL statements, each its own autocommitted SQLite
 * transaction with its own journal file create/fsync/unlink. Measured at
 * ~130ms of a ~150ms test on an idle laptop, and it is pure syscall/IO time, so
 * it degrades badly when other test workers contend for the disk (14 concurrent
 * copies of buildPersonalFacts.test.ts: 7s → 25s each). Calling it in
 * `beforeEach` multiplies that by the test count.
 *
 * WHAT IT DOES INSTEAD: the first call per Sequelize instance runs the real
 * `sync({ force: true })`. Later calls delete every row from every table and
 * clear `sqlite_sequence`, all inside ONE transaction (one commit, one fsync),
 * with foreign keys off so delete order does not matter.
 *
 * It falls back to a full `sync({ force: true })` when:
 * - the dialect is not SQLite (Postgres runs keep the original behaviour);
 * - a model was registered after the last sync (its table may not exist yet);
 * - the wipe itself fails for any reason (e.g. a test dropped a table).
 *
 * Do not use it in a file whose tests ALTER the schema (add/drop columns or
 * indexes): a row wipe does not undo DDL. Those files should keep calling
 * `sync({ force: true })` directly.
 */
import type { Sequelize } from 'sequelize';

const syncedModelCount = new WeakMap<Sequelize, number>();

async function fullSync(sequelize: Sequelize): Promise<void> {
  await sequelize.sync({ force: true });
  syncedModelCount.set(sequelize, Object.keys(sequelize.models).length);
}

async function wipeSqliteRows(sequelize: Sequelize): Promise<void> {
  const rows = (await sequelize.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    { type: 'SELECT' } as never,
  )) as Array<{ name: string }>;
  const hasSequence = ((await sequelize.query(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
    { type: 'SELECT' } as never,
  )) as unknown[]).length > 0;

  const deletes = rows.map(({ name }) => `DELETE FROM "${name.replace(/"/g, '""')}";`);
  if (hasSequence) deletes.push('DELETE FROM sqlite_sequence;');

  // One multi-statement exec on Sequelize's default SQLite connection — the
  // same connection every non-transactional query uses — so ~100 DELETEs cost
  // one native call instead of ~100 round trips through the query layer.
  // PRAGMA foreign_keys cannot change inside a transaction, so it is toggled
  // around BEGIN/COMMIT.
  const db = (await (sequelize as unknown as {
    connectionManager: { getConnection: (o: object) => Promise<SqliteDb> };
  }).connectionManager.getConnection({})) as SqliteDb;
  const exec = (sql: string) =>
    new Promise<void>((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve())));

  await exec('PRAGMA foreign_keys = OFF;');
  try {
    await exec(`BEGIN;\n${deletes.join('\n')}\nCOMMIT;`);
  } catch (err) {
    await exec('ROLLBACK;').catch(() => undefined);
    throw err;
  } finally {
    await exec('PRAGMA foreign_keys = ON;');
  }
}

type SqliteDb = { exec: (sql: string, cb: (err: Error | null) => void) => void };

export async function resetTestDb(sequelize: Sequelize): Promise<void> {
  const synced = syncedModelCount.get(sequelize);
  if (
    sequelize.getDialect() !== 'sqlite'
    || synced === undefined
    || synced !== Object.keys(sequelize.models).length
  ) {
    await fullSync(sequelize);
    return;
  }
  try {
    await wipeSqliteRows(sequelize);
  } catch {
    await fullSync(sequelize);
  }
}
