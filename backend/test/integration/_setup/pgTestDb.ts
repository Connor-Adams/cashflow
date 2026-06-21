/**
 * Per-test-file Postgres bootstrap for backend integration tests.
 *
 * Each test file calls `setupPgTestDb()` in `before()` with a short name; the
 * helper provisions a uniquely-named Postgres database (using a CREATE
 * DATABASE / DROP DATABASE pair against an admin connection), runs the full
 * Sequelize migration suite against it, and sets `process.env.DATABASE_URL`
 * so the app's lazy `createSequelize()` (see backend/src/db.ts) picks up
 * Postgres on first import.
 *
 * Admin connection URL comes from `TEST_DATABASE_URL`; defaults to
 * postgres://postgres:postgres@localhost:5432/postgres so a stock Postgres
 * service container works out of the box.
 *
 * The directory `_setup/` (leading underscore) keeps this file out of the
 * `*.test.ts` glob used by the test runner.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..', '..');

const ADMIN_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5432/postgres';

export interface PgTestDb {
  databaseUrl: string;
  databaseName: string;
}

function makeDbName(testName: string): string {
  const safe = testName.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 40);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `test_${safe}_${suffix}`;
}

function urlWithDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function setupPgTestDb(testName: string): Promise<PgTestDb> {
  const databaseName = makeDbName(testName);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const databaseUrl = urlWithDb(ADMIN_URL, databaseName);
  process.env.DATABASE_URL = databaseUrl;

  execFileSync('yarn', ['db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  return { databaseUrl, databaseName };
}

export async function teardownPgTestDb(db: PgTestDb): Promise<void> {
  try {
    const mod = await import('../../../src/db.js');
    await mod.sequelize.close();
  } catch {
    /* sequelize may already be closed or never imported */
  }

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${db.databaseName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }

  // Defensive: Node's test runner isolates per-file by default in v22, but
  // unset DATABASE_URL anyway so a misconfigured runner can't bleed Postgres
  // into sibling SQLite-based tests that read it on env.ts module load.
  delete process.env.DATABASE_URL;
}
