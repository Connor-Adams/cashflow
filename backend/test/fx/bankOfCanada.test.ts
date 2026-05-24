/**
 * Unit tests for bankOfCanada.ts fetcher.
 *
 * The tests that exercise the DB cache (ensureFxRate) use a per-file
 * sqlite path set via DATABASE_PATH *before* any model import, following
 * the pattern established in the integration test suite.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-fx-boc.sqlite');

let FxRate: typeof import('../../src/models/FxRate.js').FxRate;
let fetchBoCRate: typeof import('../../src/fx/bankOfCanada.js').fetchBoCRate;
let ensureFxRate: typeof import('../../src/fx/bankOfCanada.js').ensureFxRate;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      NODE_ENV: 'development',
    },
    stdio: 'pipe',
  });

  // Import AFTER DATABASE_PATH is set so Sequelize picks up the right file.
  const modelsModule = await import('../../src/models/index.js');
  FxRate = modelsModule.FxRate;

  const boCModule = await import('../../src/fx/bankOfCanada.js');
  fetchBoCRate = boCModule.fetchBoCRate;
  ensureFxRate = boCModule.ensureFxRate;
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// fetchBoCRate — pure HTTP tests (no DB)
// ---------------------------------------------------------------------------

test('fetchBoCRate: CAD→CAD short-circuits to rate 1 without network call', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await fetchBoCRate('CAD', 'CAD', '2026-05-22');
    assert.ok(result !== null);
    assert.equal(result.rate, 1);
    assert.equal(result.ratedDate, '2026-05-22');
    assert.equal(fetchCalled, false, 'fetch should not be called for CAD→CAD');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBoCRate: returns rate from BoC observation payload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        observations: [
          { d: '2026-05-20', FXUSDCAD: { v: '1.3650' } },
          { d: '2026-05-21', FXUSDCAD: { v: '1.3700' } },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const result = await fetchBoCRate('USD', 'CAD', '2026-05-22');
    assert.ok(result !== null);
    // Should take the last observation (2026-05-21) as it is most recent.
    assert.equal(result.ratedDate, '2026-05-21');
    assert.equal(result.rate, 1.37);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBoCRate: returns null on HTTP error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('Server Error', { status: 500 })) as typeof fetch;
  try {
    const result = await fetchBoCRate('USD', 'CAD', '2026-05-22');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBoCRate: returns null on network failure (fetch throws)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('Network failure');
  }) as unknown as typeof fetch;
  try {
    const result = await fetchBoCRate('USD', 'CAD', '2026-05-22');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBoCRate: returns null when observations array is empty', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ observations: [] }), { status: 200 })) as typeof fetch;
  try {
    const result = await fetchBoCRate('USD', 'CAD', '2026-05-22');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// ensureFxRate — DB cache tests
// ---------------------------------------------------------------------------

test('ensureFxRate: CAD→CAD short-circuits without DB or HTTP call', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureFxRate('CAD', 'CAD', '2026-05-22');
    assert.ok(result !== null);
    assert.equal(result.rate, 1);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ensureFxRate: cache hit returns DB row without HTTP call', async () => {
  // Seed a cached row.
  await FxRate.create({
    fromCurrency: 'EUR',
    toCurrency: 'CAD',
    ratedDate: '2026-05-21',
    rate: '1.5000',
    source: 'bank_of_canada',
    fetchedAt: new Date(),
  });

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await ensureFxRate('EUR', 'CAD', '2026-05-22');
    assert.ok(result !== null);
    assert.equal(result.rate, 1.5);
    assert.equal(fetchCalled, false, 'fetch should not be called on cache hit');
  } finally {
    globalThis.fetch = originalFetch;
    // Cleanup the seeded row so other tests aren't affected.
    await FxRate.destroy({ where: { fromCurrency: 'EUR', toCurrency: 'CAD' } });
  }
});

test('ensureFxRate: cache miss fetches from BoC and persists row', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        observations: [
          { d: '2026-05-22', FXUSDCAD: { v: '1.3654' } },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const result = await ensureFxRate('USD', 'CAD', '2026-05-22');
    assert.ok(result !== null);
    assert.equal(result.rate, 1.3654);
    assert.equal(result.ratedDate, '2026-05-22');

    // Row should now be persisted.
    const persisted = await FxRate.findOne({
      where: { fromCurrency: 'USD', toCurrency: 'CAD', ratedDate: '2026-05-22' },
    });
    assert.ok(persisted !== null, 'FxRate row should be persisted after cache miss');
    assert.equal(Number(persisted.rate), 1.3654);
  } finally {
    globalThis.fetch = originalFetch;
    await FxRate.destroy({ where: { fromCurrency: 'USD', toCurrency: 'CAD' } });
  }
});

test('ensureFxRate: HTTP failure returns null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('Bad Gateway', { status: 502 })) as typeof fetch;
  try {
    const result = await ensureFxRate('GBP', 'CAD', '2026-05-22');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
