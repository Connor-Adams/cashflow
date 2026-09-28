// Recursively discover every backend unit test file and print the paths,
// one per line, relative to the backend package root.
//
// WHY THIS EXISTS
// ---------------
// `node:test` (driven by `tsx --test`) has no "discover everything except this
// subtree" flag on Node 22.22.3. If you give `tsx --test` *no* file arguments
// it silently falls back to recursive discovery of the whole cwd — which would
// drag in test/integration/**. We verified this: a bare `tsx --test` ran 4353
// tests including the integration tree. So we cannot lean on the runner's
// default discovery; we must hand it an explicit, curated list.
//
// WHY INTEGRATION IS EXCLUDED
// ---------------------------
// Unit tests bind SQLite eagerly via test/setup.ts (per-PID DATABASE_PATH).
// Integration tests (test/integration/**) bind Postgres and must import
// Sequelize models only AFTER DATABASE_URL is set. The Sequelize models
// singleton binds ONE dialect per process, so the two suites cannot share a
// run. Integration is therefore run by its own script (`test:integration`) and
// is deliberately omitted here. Do NOT "simplify" by folding it back in.
//
// CONTRACT (relied on by backend/package.json):
//   - Prints discovered files to stdout, space/newline separated, on success.
//   - If ZERO files are discovered, prints nothing to stdout, logs to stderr,
//     and exits 1. The caller treats a nonzero exit as fatal and MUST NOT fall
//     through to a bare `tsx --test` (which would default-discover everything,
//     re-introducing the integration tree). This is the "silent empty run"
//     guard required by the test setup.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// backend/ package root (this file lives at backend/test/list-unit-tests.mjs)
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(backendRoot, 'src');
const testRoot = path.join(backendRoot, 'test');

// Unit tests are colocated under src/ (foo.test.ts beside foo.ts). Integration
// tests live in test/integration/ (run by `test:integration`) and are outside
// this walk entirely. Kept data-driven in case a src subtree ever needs skipping.
const EXCLUDED_DIRS = new Set();

// Pre-colocation holdovers: ten *.test.ts files still sit directly in test/.
// They are unit tests (SQLite via test/setup.ts, no Postgres) but were in
// NEITHER suite — this walk only covered src/, and `test:integration` globs
// `test/integration/*.test.ts`. They ran nowhere and could have rotted
// unnoticed. Non-recursive on purpose: test/integration/ must stay out, per the
// one-dialect-per-process constraint above. Migrating them beside their source
// under src/ would let this walk go away.
const LEGACY_TEST_DIR_EXCLUDED = new Set(['integration']);

/**
 * @param {string} dir absolute dir to walk
 * @param {string} rel path relative to `dir`'s root
 * @param {string} prefix emitted path prefix ('src' or 'test')
 */
function walk(dir, rel, prefix) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // Skip excluded top-level subtrees (none today).
      if (!rel && EXCLUDED_DIRS.has(entry.name)) continue;
      found.push(...walk(path.join(dir, entry.name), relPath, prefix));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      // Emit paths relative to the backend root (cwd = backend/ when run).
      found.push(`${prefix}/${relPath}`);
    }
  }
  return found;
}

const legacyTopLevel = readdirSync(testRoot, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.test.ts'))
  .filter((e) => !LEGACY_TEST_DIR_EXCLUDED.has(e.name))
  .map((e) => `test/${e.name}`);

const files = [...walk(srcRoot, '', 'src'), ...legacyTopLevel].sort();

if (files.length === 0) {
  process.stderr.write(
    'list-unit-tests: discovered ZERO unit test files under backend/src/ ' +
      'or backend/test/. ' +
      'Refusing to emit an empty list — a bare ' +
      '`tsx --test` would default-discover the whole tree, including ' +
      'integration. Exiting nonzero so the test command aborts.\n',
  );
  process.exit(1);
}

process.stdout.write(files.join('\n') + '\n');
