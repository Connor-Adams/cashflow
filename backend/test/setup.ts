/**
 * Test-setup module. Loaded by `tsx --import` before any test file evaluates.
 *
 * Gives each test worker process its own SQLite database file, keyed by PID,
 * so parallel test files (Node 22's default `--experimental-test-isolation=process`)
 * don't race on a shared on-disk DB. Without this, multiple test files calling
 * `sequelize.sync({ force: true })` would drop tables out from under each other
 * mid-query and surface as `SQLITE_ERROR: no such table: <x>` failures.
 *
 * Setting DATABASE_PATH here (before db.ts loads) is the only way to influence
 * the per-process storage choice without conditionally branching db.ts on
 * NODE_ENV.
 *
 * The temp file is best-effort cleaned up on process exit. If cleanup misses
 * (crash, OOM), the OS reaps the file from `os.tmpdir()` eventually.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DATABASE_URL) {
  const file = path.join(os.tmpdir(), `cashflow-test-${process.pid}.sqlite`);
  process.env.DATABASE_PATH = file;

  const cleanup = () => {
    try {
      fs.unlinkSync(file);
    } catch {
      // file may not exist (already cleaned, or sqlite never created it) — ignore
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}
