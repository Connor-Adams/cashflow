/**
 * Regression guard for issue #861 — containers must not silently drift back to
 * running as root.
 *
 * Hardening contract:
 *  - backend runner stage drops to the non-root `node` user.
 *  - frontend runner uses the nginx-unprivileged image (non-root nginx master).
 *  - the otel-collector (stateless, no persistent volume) drops to a non-root UID.
 *
 * The four STATEFUL infra images (loki, tempo, prometheus, grafana) are an
 * intentional, documented exception: they persist to Railway volumes that are
 * mounted root-owned, so a non-root UID crashes on startup with `permission
 * denied` (PR #256). This test asserts that the exception stays *documented* —
 * each `USER root` line must carry a rationale comment — rather than forcing a
 * change that would re-break deploys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsx transpiles ESM specifiers to CJS at runtime, which leaves `import.meta.dirname`
// undefined in some setups. `fileURLToPath(import.meta.url)` is portable across both.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function readDockerfile(...segments: string[]): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, ...segments), 'utf8');
}

/** Lines that are an actual `USER` directive (not a comment mentioning USER). */
function userDirectives(dockerfile: string): string[] {
  return dockerfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^USER\s+/.test(line));
}

test('backend Dockerfile: runner drops to the non-root `node` user (#861)', () => {
  const df = readDockerfile('backend', 'Dockerfile');
  const users = userDirectives(df);
  assert.ok(
    users.includes('USER node'),
    `backend/Dockerfile must contain a \`USER node\` directive so the runner is non-root; found USER directives: ${JSON.stringify(users)}`,
  );
  // The last (effective) USER directive must not be root.
  assert.notStrictEqual(
    users.at(-1),
    'USER root',
    'backend/Dockerfile must not end up running as root',
  );
});

test('frontend Dockerfile: runner uses nginx-unprivileged (non-root nginx) (#861)', () => {
  const df = readDockerfile('frontend', 'Dockerfile');
  assert.match(
    df,
    /FROM\s+nginxinc\/nginx-unprivileged/,
    'frontend/Dockerfile runner stage must use nginxinc/nginx-unprivileged so nginx does not run as a root master',
  );
  assert.doesNotMatch(
    df,
    /^FROM\s+nginx:alpine/m,
    'frontend/Dockerfile must not use the root-running nginx:alpine base for its runner',
  );
});

test('otel-collector Dockerfile: stateless collector drops to a non-root UID (#861)', () => {
  const df = readDockerfile('infra', 'otel-collector', 'Dockerfile');
  const users = userDirectives(df);
  assert.ok(users.length > 0, 'infra/otel-collector/Dockerfile must declare a USER directive');
  assert.notStrictEqual(
    users.at(-1),
    'USER root',
    'otel-collector is stateless (no volume) and must not run as root',
  );
  assert.notStrictEqual(
    users.at(-1),
    'USER 0',
    'otel-collector must not run as UID 0 (root)',
  );
});

// The stateful infra images are allowed to stay root, but only with a documented
// reason next to the directive. Verify the exception remains intentional.
for (const svc of ['loki', 'tempo', 'prometheus', 'grafana'] as const) {
  test(`infra/${svc} Dockerfile: any \`USER root\` is documented as the Railway-volume exception (#861)`, () => {
    const df = readDockerfile('infra', svc, 'Dockerfile');
    if (!userDirectives(df).includes('USER root')) {
      // Dropped to non-root entirely — even better, nothing to document.
      return;
    }
    assert.match(
      df,
      /volume/i,
      `infra/${svc}/Dockerfile keeps \`USER root\` but lacks a comment explaining the Railway root-owned-volume constraint; add one (see infra/loki/Dockerfile).`,
    );
  });
}
