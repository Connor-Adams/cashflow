/**
 * Regression guard for issue #370 and related Tempo storage drift.
 *
 * Tempo's grafana/tempo image has its executable at `/tempo`, so the storage
 * config MUST live under `/var/tempo` (or another non-`/tempo` path) — otherwise
 * mounting a Railway/Docker volume at `/tempo` would shadow the binary. This
 * was the original bug that PR #359 (commit f25ffdfd) fixed by relocating
 * paths from `/tempo` to `/var/tempo`.
 *
 * If the on-disk paths drift back to `/tempo`, the next deploy would either
 * crash the container (binary shadowed) or, if the mount path mismatched,
 * silently write blocks to ephemeral FS — losing every trace on every restart.
 *
 * This test reads infra/tempo/config.yaml directly and asserts the WAL and
 * local trace paths both live under /var/tempo, matching the Railway volume
 * mount that the docs prescribe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsx transpiles ESM specifiers to CJS at runtime, which leaves `import.meta.dirname`
// undefined in some setups. `fileURLToPath(import.meta.url)` is portable across both.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPO_CONFIG_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'infra',
  'tempo',
  'config.yaml',
);

function loadTempoConfig(): string {
  return fs.readFileSync(TEMPO_CONFIG_PATH, 'utf8');
}

/** Extract a scalar value from a simple key:value YAML line. Tolerates indentation and inline comments. */
function extractPath(yaml: string, key: string): string | null {
  // Match `<key>: <value>` where value is the rest of the line (trimmed, comment stripped).
  // Tempo config is hand-written and non-nested at the lines we care about, so a regex is fine.
  const re = new RegExp(`^\\s*${key}:\\s*([^#\\n]+?)\\s*(?:#.*)?$`, 'm');
  const m = yaml.match(re);
  return m ? m[1].trim() : null;
}

test('infra/tempo/config.yaml: WAL path lives under /var/tempo (issue #370 regression guard)', () => {
  const yaml = loadTempoConfig();
  const walPath = extractPath(yaml, 'path');
  assert.ok(walPath, 'expected a `path:` key under storage.trace.wal');
  // The first `path:` in the file is the WAL one (storage.trace.wal.path),
  // since it appears before storage.trace.local.path.
  assert.ok(
    walPath!.startsWith('/var/tempo'),
    `WAL path ${walPath} must start with /var/tempo so it lands on the Railway tempo-volume mounted at /var/tempo (NOT /tempo, which would shadow the grafana/tempo binary).`,
  );
});

test('infra/tempo/config.yaml: local trace path lives under /var/tempo (issue #370 regression guard)', () => {
  const yaml = loadTempoConfig();
  // Pull all `path:` values; we need the second occurrence (storage.trace.local.path).
  const matches = [...yaml.matchAll(/^\s*path:\s*([^#\n]+?)\s*(?:#.*)?$/gm)].map((m) =>
    m[1].trim(),
  );
  assert.ok(
    matches.length >= 2,
    `expected at least two \`path:\` entries in tempo config, found ${matches.length}`,
  );
  const localPath = matches[1];
  assert.ok(
    localPath.startsWith('/var/tempo'),
    `local trace path ${localPath} must start with /var/tempo so it lands on the Railway tempo-volume mounted at /var/tempo (NOT /tempo, which would shadow the grafana/tempo binary).`,
  );
});

test('infra/tempo/config.yaml: no storage path resolves to bare /tempo (binary collision guard)', () => {
  const yaml = loadTempoConfig();
  // Any `/tempo` not followed by another path segment would collide with the binary.
  // Permit `/var/tempo/...` but reject standalone `/tempo` and `/tempo/...` in path-like contexts.
  const offendingLines = yaml
    .split('\n')
    .map((line, idx) => ({ line, lineNo: idx + 1 }))
    .filter(({ line }) => {
      // Only inspect lines containing a `path:` directive.
      if (!/^\s*path:/.test(line)) return false;
      // Strip the key + comments; check the value.
      const value = line.replace(/^\s*path:\s*/, '').replace(/#.*$/, '').trim();
      // Reject if it starts with `/tempo` but NOT `/var/tempo`.
      return value === '/tempo' || /^\/tempo(\/|$)/.test(value);
    });
  assert.equal(
    offendingLines.length,
    0,
    `Found path(s) at bare /tempo which would shadow the grafana/tempo binary: ${JSON.stringify(
      offendingLines,
    )}`,
  );
});
