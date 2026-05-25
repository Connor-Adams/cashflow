/**
 * Budget tracker tests — exercises ProviderJobLog counting and the daily
 * call budget against a fresh per-file sqlite database.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-av-budget.sqlite');

let ProviderJobLog: typeof import('../../../src/models/ProviderJobLog.js').ProviderJobLog;
let callsUsedToday: typeof import('../../../src/integrations/alphaVantage/budget.js').callsUsedToday;
let checkBudget: typeof import('../../../src/integrations/alphaVantage/budget.js').checkBudget;
let recordCall: typeof import('../../../src/integrations/alphaVantage/budget.js').recordCall;

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  process.env.ALPHA_VANTAGE_API_KEY = 'test-key';

  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development' },
    stdio: 'pipe',
  });

  const modelsModule = await import('../../../src/models/index.js');
  ProviderJobLog = modelsModule.ProviderJobLog;

  const budgetModule = await import('../../../src/integrations/alphaVantage/budget.js');
  callsUsedToday = budgetModule.callsUsedToday;
  checkBudget = budgetModule.checkBudget;
  recordCall = budgetModule.recordCall;
});

beforeEach(async () => {
  await ProviderJobLog.destroy({ where: {} });
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  }
});

function utcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

test('callsUsedToday: only counts ok+not_found within the UTC day', async () => {
  const now = new Date('2026-05-24T10:00:00.000Z');
  const today = utcMidnight('2026-05-24');
  const yesterday = utcMidnight('2026-05-23');

  await recordCall({ function: 'GLOBAL_QUOTE', symbol: 'A', status: 'ok', fetchedAt: today });
  await recordCall({ function: 'GLOBAL_QUOTE', symbol: 'B', status: 'not_found', fetchedAt: today });
  await recordCall({ function: 'GLOBAL_QUOTE', symbol: 'C', status: 'error', fetchedAt: today });
  await recordCall({ function: 'GLOBAL_QUOTE', symbol: 'D', status: 'budget_exceeded', fetchedAt: today });
  await recordCall({ function: 'GLOBAL_QUOTE', symbol: 'E', status: 'ok', fetchedAt: yesterday });

  const used = await callsUsedToday(now);
  assert.equal(used, 2);
});

test('checkBudget: ok=true when under limit, false when at limit', async () => {
  const now = new Date('2026-05-24T12:00:00.000Z');
  const today = utcMidnight('2026-05-24');

  await recordCall({ function: 'GLOBAL_QUOTE', symbol: 'A', status: 'ok', fetchedAt: today });

  const under = await checkBudget(5, now);
  assert.equal(under.ok, true);
  assert.equal(under.used, 1);
  assert.equal(under.limit, 5);
  assert.equal(under.remaining, 4);

  const at = await checkBudget(1, now);
  assert.equal(at.ok, false);
  assert.equal(at.remaining, 0);

  const over = await checkBudget(0, now);
  assert.equal(over.ok, false);
  assert.equal(over.remaining, 0);
});

test('recordCall: persists provider="alpha_vantage" and a default fetchedAt', async () => {
  await recordCall({ function: 'GLOBAL_QUOTE', symbol: 'AAPL', status: 'ok' });
  const row = await ProviderJobLog.findOne({ order: [['id', 'DESC']] });
  assert.ok(row);
  assert.equal(row.provider, 'alpha_vantage');
  assert.equal(row.function, 'GLOBAL_QUOTE');
  assert.equal(row.symbol, 'AAPL');
  assert.equal(row.status, 'ok');
  assert.ok(row.fetchedAt instanceof Date);
});
