const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { serviceContentHash, SERVICES } = require('../scripts/service-content-hash.cjs');

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function write(dir, rel, contents) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

// A throwaway repo seeded with every service's input paths, committed once.
function seedRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cf-svc-hash-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  // Stop git from spawning background work (gc --auto, commit-graph,
  // fsmonitor) that keeps writing into .git/objects after a commit returns —
  // that write races teardown's recursive rmSync and throws ENOTEMPTY.
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'core.fsmonitor', 'false');
  git(dir, 'config', 'fetch.writeCommitGraph', 'false');
  git(dir, 'config', 'commitGraph.generationVersion', '0');
  write(dir, 'package.json', '{"name":"root"}\n');
  write(dir, 'yarn.lock', '# lock\n');
  write(dir, 'backend/index.ts', 'export const b = 1;\n');
  write(dir, 'frontend/index.ts', 'export const f = 1;\n');
  write(dir, 'shared/index.ts', 'export const s = 1;\n');
  for (const svc of ['otel-collector', 'loki', 'prometheus', 'grafana', 'tempo']) {
    write(dir, `infra/${svc}/config`, `${svc}\n`);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

function hashAll(dir, ref = 'HEAD') {
  return Object.fromEntries(
    SERVICES.map((s) => [s, serviceContentHash(s, ref, { cwd: dir })]),
  );
}

function commitChange(dir, rel, contents, msg) {
  write(dir, rel, contents);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

function withRepo(fn) {
  const dir = seedRepo();
  try {
    fn(dir);
  } finally {
    // force only swallows ENOENT, not ENOTEMPTY. maxRetries makes rmSync
    // retry (with linear backoff) when a stray git background write recreates
    // a file under .git/objects mid-delete.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('produces a 16-char hex hash for every service', () => {
  withRepo((dir) => {
    for (const svc of SERVICES) {
      const h = serviceContentHash(svc, 'HEAD', { cwd: dir });
      assert.match(h, /^[0-9a-f]{16}$/, `${svc} -> ${h}`);
    }
  });
});

test('is deterministic for the same service and ref', () => {
  withRepo((dir) => {
    assert.equal(
      serviceContentHash('backend', 'HEAD', { cwd: dir }),
      serviceContentHash('backend', 'HEAD', { cwd: dir }),
    );
  });
});

test('distinct services hash differently', () => {
  withRepo((dir) => {
    const all = hashAll(dir);
    const values = Object.values(all);
    assert.equal(new Set(values).size, values.length, 'all service hashes unique');
  });
});

test('changing shared/ rebuilds backend and frontend but not infra', () => {
  withRepo((dir) => {
    const before = hashAll(dir);
    commitChange(dir, 'shared/index.ts', 'export const s = 2;\n', 'touch shared');
    const after = hashAll(dir);
    assert.notEqual(after.backend, before.backend);
    assert.notEqual(after.frontend, before.frontend);
    assert.equal(after.loki, before.loki);
    assert.equal(after.prometheus, before.prometheus);
  });
});

test('changing backend/ rebuilds backend only', () => {
  withRepo((dir) => {
    const before = hashAll(dir);
    commitChange(dir, 'backend/index.ts', 'export const b = 2;\n', 'touch backend');
    const after = hashAll(dir);
    assert.notEqual(after.backend, before.backend);
    assert.equal(after.frontend, before.frontend);
    assert.equal(after.loki, before.loki);
  });
});

test('changing root package.json rebuilds backend and frontend', () => {
  withRepo((dir) => {
    const before = hashAll(dir);
    commitChange(dir, 'package.json', '{"name":"root","v":2}\n', 'touch root manifest');
    const after = hashAll(dir);
    assert.notEqual(after.backend, before.backend);
    assert.notEqual(after.frontend, before.frontend);
    assert.equal(after.tempo, before.tempo);
  });
});

test('changing one infra service does not affect the others', () => {
  withRepo((dir) => {
    const before = hashAll(dir);
    commitChange(dir, 'infra/loki/config', 'loki v2\n', 'touch loki');
    const after = hashAll(dir);
    assert.notEqual(after.loki, before.loki);
    assert.equal(after.prometheus, before.prometheus);
    assert.equal(after.grafana, before.grafana);
    assert.equal(after.backend, before.backend);
  });
});

test('throws on unknown service', () => {
  withRepo((dir) => {
    assert.throws(
      () => serviceContentHash('nope', 'HEAD', { cwd: dir }),
      /unknown service/,
    );
  });
});
