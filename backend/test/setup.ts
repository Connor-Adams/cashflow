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
 *
 * ## NODE_ENV
 *
 * This module is also where `NODE_ENV=test` gets set, and it is the only place
 * that can do it correctly. Eleven flags in `config/env.ts` gate on
 * `nodeEnv === 'test'` to keep schedulers and background passes off during
 * tests, and `config/env.ts` resolves them ONCE at module load. Setting the
 * variable in a test file's body is too late — ESM evaluates every import
 * before the importing module's first statement, so `config/env.ts` has already
 * captured `'development'` by then and every one of those guards is decorative.
 * `--import ./test/setup.ts` runs before any test module is even linked, which
 * is early enough.
 *
 * Until this line existed those eleven guards had never once engaged in a unit
 * test run. The one that mattered was `interestAllocationEnabled`: the
 * mark-dirty coordinator armed a real five-second timer in every worker that
 * committed a statement or retagged a loan, and hung `backend-test-shard (3)`
 * for four hours on a slow runner.
 *
 * A test that needs the non-test behaviour sets `NODE_ENV` itself (several do,
 * and several spawn a child with `NODE_ENV=development` for exactly this).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Respect an explicit value — `NODE_ENV=production yarn test` should still mean
// production — but default every unit-test worker to 'test'.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

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
