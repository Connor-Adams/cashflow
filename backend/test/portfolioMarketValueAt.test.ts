import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');
const dbPath = path.join(backendRoot, 'data', 'test-portfolio-mv-at.sqlite');

let models: typeof import('../src/models/index.js');
let mod: typeof import('../src/networth/portfolioMarketValueAt.js');

before(async () => {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  execFileSync('yarn', ['run', 'sequelize-cli', 'db:migrate'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'development', GH_PACKAGES_TOKEN: 'dummy' },
    stdio: 'pipe',
  });
  models = await import('../src/models/index.js');
  mod = await import('../src/networth/portfolioMarketValueAt.js');
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

beforeEach(async () => {
  await models.HoldingSnapshot.destroy({ where: {}, force: true });
  await models.SecurityPrice.destroy({ where: {}, force: true });
  await models.Security.destroy({ where: {}, force: true });
  await models.Account.destroy({ where: {}, force: true });
});

async function seedSecurity(symbol: string, currency = 'CAD') {
  return models.Security.create({
    symbol,
    name: symbol,
    currency,
  } as never);
}
async function seedAccount(name: string) {
  return models.Account.create({
    name,
    owner: 'me',
    accountType: 'investment',
    defaultCurrency: 'CAD',
  } as never);
}
async function seedHolding(accountId: number, securityId: number, date: string, qty: number) {
  await models.HoldingSnapshot.create({
    accountId,
    securityId,
    statementDate: date,
    quantity: String(qty),
    currency: 'CAD',
    sourceRowFingerprint: `${accountId}-${securityId}-${date}-${qty}`,
    importBatch: 'test',
  } as never);
}
async function seedPrice(securityId: number, pricedAt: string, price: number) {
  await models.SecurityPrice.create({
    securityId,
    provider: 'test',
    symbol: 'X',
    pricedAt: new Date(pricedAt),
    price: String(price),
    currency: 'CAD',
    fetchedAt: new Date(pricedAt),
  } as never);
}

test('portfolioMarketValueAt: uses latest holding <= asOf x latest price <= asOf', async () => {
  const acc = await seedAccount('RRSP');
  const sec = await seedSecurity('VFV');
  await seedHolding(acc.id, sec.id, '2026-01-31', 10);
  await seedHolding(acc.id, sec.id, '2026-02-28', 12); // after asOf
  await seedPrice(sec.id, '2026-01-30T16:00:00Z', 100);
  await seedPrice(sec.id, '2026-02-15T16:00:00Z', 110); // after asOf

  const result = await mod.portfolioMarketValueAt('2026-02-10', [acc.id]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].accountId, acc.id);
  assert.equal(result.rows[0].securityId, sec.id);
  assert.equal(result.rows[0].marketValue, 1000);
  assert.equal(result.rows[0].currency, 'CAD');
  assert.deepEqual(result.gaps, []);
});

test('portfolioMarketValueAt: emits price_unavailable gap when no price <= asOf', async () => {
  const acc = await seedAccount('RRSP');
  const sec = await seedSecurity('NEW');
  await seedHolding(acc.id, sec.id, '2026-02-01', 5);
  await seedPrice(sec.id, '2026-03-01T16:00:00Z', 50); // after asOf

  const result = await mod.portfolioMarketValueAt('2026-02-15', [acc.id]);
  assert.deepEqual(result.rows, []);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].reason, 'price_unavailable');
  assert.equal(result.gaps[0].securityId, sec.id);
});

test('portfolioMarketValueAt: missing holding <= asOf is treated as zero position (no gap)', async () => {
  const acc = await seedAccount('RRSP');
  const sec = await seedSecurity('FUTURE');
  await seedHolding(acc.id, sec.id, '2026-04-01', 5); // after asOf
  await seedPrice(sec.id, '2026-02-01T16:00:00Z', 50);

  const result = await mod.portfolioMarketValueAt('2026-03-01', [acc.id]);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.gaps, []);
});

test('portfolioMarketValueAt: only includes holdings for given accountIds', async () => {
  const a1 = await seedAccount('A1');
  const a2 = await seedAccount('A2');
  const sec = await seedSecurity('VFV');
  await seedHolding(a1.id, sec.id, '2026-01-01', 10);
  await seedHolding(a2.id, sec.id, '2026-01-01', 99);
  await seedPrice(sec.id, '2026-01-01T16:00:00Z', 100);

  const result = await mod.portfolioMarketValueAt('2026-02-01', [a1.id]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].accountId, a1.id);
  assert.equal(result.rows[0].marketValue, 1000);
});

test('portfolioMarketValueAt: empty accountIds returns empty result', async () => {
  const result = await mod.portfolioMarketValueAt('2026-02-01', []);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.gaps, []);
});
