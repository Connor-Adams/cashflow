/**
 * Gate for tests that run against Connor's REAL statement / receipt PDFs.
 *
 * Those files are personal financial documents: gitignored under
 * backend/test/fixtures/pdf/ (or living in ~/Downloads), so they never exist in
 * CI. Each such test has a synthetic twin that runs everywhere; the private
 * variant stays as a local regression check against the real layout.
 *
 * In CI (process.env.CI set) the skip is announced on stderr, once per reason,
 * so a CI log never shows these as silently skipped.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

const announced = new Set<string>();

/**
 * `skip` option for a private-fixture test: undefined when every file exists,
 * otherwise a reason string naming the missing files.
 */
export function skipUnlessPrivateFixtures(...paths: string[]): string | undefined {
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length === 0) return undefined;
  const reason =
    `private fixture not present (${missing.map((p) => basename(p)).join(', ')}): ` +
    'real bank documents are never committed; the synthetic twin of this test covers it in CI';
  if (process.env.CI && !announced.has(reason)) {
    announced.add(reason);
    process.stderr.write(`[private-fixture skip] ${reason}\n`);
  }
  return reason;
}
