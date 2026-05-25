/**
 * Picker tests — verifies stale-first global rotation across distinct held
 * symbols with the min-age floor honored.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-av-picker.sqlite');

let Security: typeof import('../../../src/models/Security.js').Security;
let ProviderJobLog: typeof import('../../../src/models/ProviderJobLog.js').ProviderJobLog;
let pickNext: typeof import('../../../src/integrations/alphaVantage/picker.js').pickNext;

const NOW = new Date('2026-05-24T15:00:00.000Z');

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const modelsModule = await import('../../../src/models/index.js');
  Security = modelsModule.Security;
  ProviderJobLog = modelsModule.ProviderJobLog;

  const pickerModule = await import('../../../src/integrations/alphaVantage/picker.js');
  pickNext = pickerModule.pickNext;
});

beforeEach(async () => {
  await ProviderJobLog.destroy({ where: {} });
  await Security.destroy({ where: {} });
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

function offsetHours(base: Date, hours: number): Date {
  return new Date(base.getTime() - hours * 3600 * 1000);
}

test('pickNext: returns null when no securities exist', async () => {
  const result = await pickNext({ minAgeSeconds: 0, now: NOW });
  assert.equal(result, null);
});

test('pickNext: never-fetched symbol wins over fresh symbol', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await Security.create({ householdId: 1, symbol: 'MSFT', name: 'Microsoft', currency: 'USD', assetType: null });
  await ProviderJobLog.create({
    provider: 'alpha_vantage',
    function: 'GLOBAL_QUOTE',
    symbol: 'AAPL',
    status: 'ok',
    fetchedAt: offsetHours(NOW, 1),
  });

  const result = await pickNext({ minAgeSeconds: 0, now: NOW });
  assert.ok(result);
  assert.equal(result.symbol, 'MSFT');
  assert.equal(result.lastFetchedAt, null);
  assert.equal(result.ageSeconds, Number.POSITIVE_INFINITY);
});

test('pickNext: returns null when every symbol is younger than minAge', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await Security.create({ householdId: 1, symbol: 'MSFT', name: 'Microsoft', currency: 'USD', assetType: null });
  await ProviderJobLog.create({
    provider: 'alpha_vantage',
    function: 'GLOBAL_QUOTE',
    symbol: 'AAPL',
    status: 'ok',
    fetchedAt: offsetHours(NOW, 1),
  });
  await ProviderJobLog.create({
    provider: 'alpha_vantage',
    function: 'GLOBAL_QUOTE',
    symbol: 'MSFT',
    status: 'ok',
    fetchedAt: offsetHours(NOW, 2),
  });

  const result = await pickNext({ minAgeSeconds: 18 * 3600, now: NOW });
  assert.equal(result, null);
});

test('pickNext: picks the symbol with the oldest successful fetch', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await Security.create({ householdId: 1, symbol: 'MSFT', name: 'Microsoft', currency: 'USD', assetType: null });
  await Security.create({ householdId: 1, symbol: 'GOOG', name: 'Google', currency: 'USD', assetType: null });
  await ProviderJobLog.create({
    provider: 'alpha_vantage',
    function: 'GLOBAL_QUOTE',
    symbol: 'AAPL',
    status: 'ok',
    fetchedAt: offsetHours(NOW, 30),
  });
  await ProviderJobLog.create({
    provider: 'alpha_vantage',
    function: 'GLOBAL_QUOTE',
    symbol: 'MSFT',
    status: 'ok',
    fetchedAt: offsetHours(NOW, 20),
  });
  await ProviderJobLog.create({
    provider: 'alpha_vantage',
    function: 'GLOBAL_QUOTE',
    symbol: 'GOOG',
    status: 'ok',
    fetchedAt: offsetHours(NOW, 50),
  });

  const result = await pickNext({ minAgeSeconds: 18 * 3600, now: NOW });
  assert.ok(result);
  assert.equal(result.symbol, 'GOOG');
});

test('pickNext: ignores error-only history (treats symbol as never fetched)', async () => {
  await Security.create({ householdId: 1, symbol: 'XYZ', name: null, currency: 'USD', assetType: null });
  await ProviderJobLog.create({
    provider: 'alpha_vantage',
    function: 'GLOBAL_QUOTE',
    symbol: 'XYZ',
    status: 'error',
    fetchedAt: offsetHours(NOW, 1),
  });

  const result = await pickNext({ minAgeSeconds: 0, now: NOW });
  assert.ok(result);
  assert.equal(result.symbol, 'XYZ');
  assert.equal(result.lastFetchedAt, null);
});

test('pickNext: dedupes the same symbol shared across households', async () => {
  await Security.create({ householdId: 1, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });
  await Security.create({ householdId: 2, symbol: 'AAPL', name: 'Apple', currency: 'USD', assetType: null });

  const result = await pickNext({ minAgeSeconds: 0, now: NOW });
  assert.ok(result);
  assert.equal(result.symbol, 'AAPL');
});
