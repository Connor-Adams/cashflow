/**
 * Round-trip test for 20261020000001-drop-retired-tables.
 *
 *   1. Build all five tables with their ORIGINAL migrations (plus the capture
 *      expiry column), seed them, then run the user-token fold so user_tokens
 *      holds every legacy token.
 *   2. up() refuses to drop while a legacy token row is missing from
 *      user_tokens, and leaves every table in place.
 *   3. up() drops all five tables; user_tokens is untouched.
 *   4. down() recreates the five tables, empty, with a schema identical to the
 *      one the original migrations produce (columns, indexes, FKs).
 *   5. The fold's down() then runs on top and repopulates the legacy token
 *      tables from user_tokens.
 *   6. fold up + drop up re-run cleanly after the rollback.
 *
 * SQLite in-memory: the migrations only use portable types and DDL.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DataTypes, QueryTypes, Sequelize } from 'sequelize';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
type Migration = { up: (...a: any[]) => Promise<void>; down: (...a: any[]) => Promise<void> };
const originalMigrations: Migration[] = [
  require('../20260522000004-user-capture-tokens.js'),
  require('../20260530000001-create-user-audit-tokens.js'),
  require('../20260602000001-ai-review-runs.js'),
  require('../20260605000020-create-cfo-briefings.js'),
  require('../20260611000000-user-reporting-tokens.js'),
  require('../20260626000001-capture-token-expiry.js'),
];
const fold: Migration = require('../20261019000001-fold-user-token-tables.js');
const drop: Migration = require('../20261020000001-drop-retired-tables.js');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const TOKEN_TABLES = ['user_audit_tokens', 'user_reporting_tokens', 'user_capture_tokens'];
const DROPPED = ['ai_review_runs', 'cfo_briefings', ...TOKEN_TABLES];

let db: Sequelize;
let reference: Sequelize;

async function baseSchema(s: Sequelize): Promise<void> {
  const qi = s.getQueryInterface();
  await qi.createTable('households', { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true } });
  await qi.createTable('users', { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true } });
  for (const m of originalMigrations) await m.up(qi, Sequelize);
}

const tables = async (s: Sequelize) => (await s.getQueryInterface().showAllTables()) as string[];
const count = async (table: string) => {
  const [{ n }] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`, { type: QueryTypes.SELECT });
  return Number(n);
};
const hashes = async (table: string) =>
  (await db.query<{ token_hash: string }>(`SELECT token_hash FROM ${table} ORDER BY token_hash`, { type: QueryTypes.SELECT })).map(
    (r) => r.token_hash,
  );

/** Columns + indexes + FKs, normalised so two DBs can be compared. */
async function schemaOf(s: Sequelize, table: string) {
  const qi = s.getQueryInterface();
  const columns = await qi.describeTable(table);
  const indexes = ((await qi.showIndex(table)) as Array<{ name: string; unique: boolean; fields: Array<{ attribute: string }> }>)
    .filter((i) => !i.name.startsWith('sqlite_autoindex'))
    .map((i) => ({ name: i.name, unique: i.unique, fields: i.fields.map((f) => f.attribute) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fks = ((await qi.getForeignKeyReferencesForTable(table)) as Array<Record<string, unknown>>)
    .map((f) => ({ column: f.columnName, refTable: f.referencedTableName, refColumn: f.referencedColumnName }))
    .sort((a, b) => String(a.column).localeCompare(String(b.column)));
  return { columns, indexes, fks };
}

const hash = (c: string) => c.repeat(64);
const now = new Date('2026-10-01T00:00:00Z');

before(async () => {
  db = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  reference = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  await baseSchema(db);
  await baseSchema(reference);

  const qi = db.getQueryInterface();
  await qi.bulkInsert('households', [{ id: 1 }]);
  await qi.bulkInsert('users', [{ id: 1 }]);
  const review = {
    household_id: 1,
    user_id: 1,
    period_start: '2026-09-01',
    period_end: '2026-09-30',
    currency: 'CAD',
    status: 'completed',
    action_items: '[]',
    created_at: now,
    updated_at: now,
  };
  await qi.bulkInsert('ai_review_runs', [review]);
  await qi.bulkInsert('cfo_briefings', [review]);
  const token = (h: string, label: string) => ({
    user_id: 1,
    token_hash: hash(h),
    label,
    last_used_at: null,
    revoked_at: null,
    created_at: now,
    updated_at: now,
  });
  await qi.bulkInsert('user_audit_tokens', [token('a', 'audit')]);
  await qi.bulkInsert('user_reporting_tokens', [token('b', 'reporting')]);
  await qi.bulkInsert('user_capture_tokens', [
    { ...token('c', 'capture'), expires_at: new Date('2099-01-01T00:00:00Z') },
    { ...token('d', 'capture no expiry'), expires_at: null },
  ]);

  await fold.up(qi, Sequelize);
});

after(async () => {
  await db.close();
  await reference.close();
});

test('up refuses to drop while a legacy token is missing from user_tokens', async () => {
  const qi = db.getQueryInterface();
  await qi.bulkInsert('user_capture_tokens', [
    { user_id: 1, token_hash: hash('z'), label: 'never folded', created_at: now, updated_at: now },
  ]);
  await assert.rejects(() => drop.up(qi, Sequelize), /user_capture_tokens: 1 row\(s\) have no matching token_hash/);
  const after = await tables(db);
  for (const t of DROPPED) assert.ok(after.includes(t), `${t} must survive a refused drop`);
  await db.query(`DELETE FROM user_capture_tokens WHERE token_hash = :h`, { replacements: { h: hash('z') } });
});

test('up drops all five tables and leaves user_tokens intact', async () => {
  await drop.up(db.getQueryInterface(), Sequelize);
  const after = await tables(db);
  for (const t of DROPPED) assert.ok(!after.includes(t), `${t} should be dropped`);
  assert.deepEqual(await hashes('user_tokens'), [hash('a'), hash('b'), hash('c'), hash('d')]);
});

test('down recreates the five tables empty, with the original schema', async () => {
  await drop.down(db.getQueryInterface(), Sequelize);
  for (const t of DROPPED) {
    assert.equal(await count(t), 0, `${t} comes back without data`);
    assert.deepEqual(await schemaOf(db, t), await schemaOf(reference, t), `${t} schema`);
  }
});

test('fold down then repopulates the legacy token tables from user_tokens', async () => {
  await fold.down(db.getQueryInterface(), Sequelize);
  assert.ok(!(await tables(db)).includes('user_tokens'));
  assert.deepEqual(await hashes('user_audit_tokens'), [hash('a')]);
  assert.deepEqual(await hashes('user_reporting_tokens'), [hash('b')]);
  assert.deepEqual(await hashes('user_capture_tokens'), [hash('c'), hash('d')]);
  const expiries = await db.query<{ expires_at: string | null }>(
    'SELECT expires_at FROM user_capture_tokens ORDER BY token_hash',
    { type: QueryTypes.SELECT },
  );
  assert.deepEqual(
    expiries.map((r) => (r.expires_at == null ? null : new Date(r.expires_at).toISOString())),
    ['2099-01-01T00:00:00.000Z', null],
  );
});

test('fold up + drop up re-run cleanly after the rollback', async () => {
  const qi = db.getQueryInterface();
  await fold.up(qi, Sequelize);
  await drop.up(qi, Sequelize);
  const after = await tables(db);
  for (const t of DROPPED) assert.ok(!after.includes(t));
  assert.equal(await count('user_tokens'), 4);
});
