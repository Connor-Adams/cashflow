import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-balance-at-date.sqlite');

let models: typeof import('../models/index.js');
let balanceAtDateMod: typeof import('./balanceAtDate.js');

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
  models = await import('../models/index.js');
  balanceAtDateMod = await import('./balanceAtDate.js');
});

after(async () => {
  await models?.sequelize.close();
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
});

beforeEach(async () => {
  // Clean tables between tests
  await models.Transaction.destroy({ where: {}, force: true });
  await models.Account.destroy({ where: {}, force: true });
});

async function seedAccount(opts: {
  defaultCurrency?: string;
  openingBalance?: number;
  openingBalanceDate?: string | null;
  accountType?: string;
}) {
  return models.Account.create({
    name: 'Test',
    owner: 'me',
    accountType: opts.accountType ?? 'checking',
    defaultCurrency: opts.defaultCurrency ?? 'CAD',
    openingBalance: String(opts.openingBalance ?? 0),
    openingBalanceDate: opts.openingBalanceDate ?? null,
  } as never);
}

let fingerprintCounter = 0;
async function seedTxn(accountId: number, date: string, amount: number, currency = 'CAD') {
  fingerprintCounter += 1;
  const fp = `bad-${accountId}-${date}-${amount}-${fingerprintCounter}-${Math.random()}`;
  await models.Transaction.create({
    accountId,
    date,
    amount: String(amount),
    currency,
    merchantRaw: 't',
    merchantClean: 't',
    importBatch: 'test',
    sourceRowFingerprint: fp,
    sourceIdentityFingerprint: fp,
  } as never);
}

test('balanceAtDate: sums openingBalance + txns <= asOf in defaultCurrency', async () => {
  const acc = await seedAccount({ openingBalance: 1000 });
  await seedTxn(acc.id, '2026-01-01', -100);
  await seedTxn(acc.id, '2026-02-01', 200);
  await seedTxn(acc.id, '2026-03-01', -50);
  const result = await balanceAtDateMod.balanceAtDate(acc, '2026-02-15');
  assert.deepEqual(result, [{ currency: 'CAD', amount: 1100 }]);
});

test('balanceAtDate: excludes txns <= openingBalanceDate', async () => {
  const acc = await seedAccount({ openingBalance: 500, openingBalanceDate: '2026-01-31' });
  await seedTxn(acc.id, '2026-01-15', -999);
  await seedTxn(acc.id, '2026-02-15', 100);
  const result = await balanceAtDateMod.balanceAtDate(acc, '2026-03-01');
  assert.deepEqual(result, [{ currency: 'CAD', amount: 600 }]);
});

test('balanceAtDate: multi-currency groups separately; opening goes to defaultCurrency', async () => {
  const acc = await seedAccount({ defaultCurrency: 'CAD', openingBalance: 1000 });
  await seedTxn(acc.id, '2026-01-01', 200, 'USD');
  await seedTxn(acc.id, '2026-01-02', -50, 'CAD');
  const result = await balanceAtDateMod.balanceAtDate(acc, '2026-02-01');
  const sorted = [...result].sort((a, b) => a.currency.localeCompare(b.currency));
  assert.deepEqual(sorted, [
    { currency: 'CAD', amount: 950 },
    { currency: 'USD', amount: 200 },
  ]);
});

test('balanceAtDate: returns zero-amount default-currency row when no txns and no opening', async () => {
  const acc = await seedAccount({});
  const result = await balanceAtDateMod.balanceAtDate(acc, '2026-02-01');
  assert.deepEqual(result, [{ currency: 'CAD', amount: 0 }]);
});

test('balanceAtDate: derives backward when asOf precedes openingBalanceDate', async () => {
  // Anchor: $10,000 as of 2026-04-01 set over already-imported history.
  // Balance at 2026-01-31 = 10000 − sum(txns in (2026-01-31, 2026-04-01])
  //                       = 10000 − (−3000 − 2000) = 15000.
  const acc = await seedAccount({ openingBalance: 10000, openingBalanceDate: '2026-04-01' });
  await seedTxn(acc.id, '2026-01-10', -500); // on/before asOf: outside the backward window
  await seedTxn(acc.id, '2026-02-15', -3000);
  await seedTxn(acc.id, '2026-03-10', -2000);
  await seedTxn(acc.id, '2026-04-15', 700); // after the anchor: outside the window
  const result = await balanceAtDateMod.balanceAtDate(acc, '2026-01-31');
  assert.deepEqual(result, [{ currency: 'CAD', amount: 15000 }]);
});

test('balanceAtDate: asOf equal to openingBalanceDate returns the anchor balance', async () => {
  const acc = await seedAccount({ openingBalance: 500, openingBalanceDate: '2026-01-31' });
  await seedTxn(acc.id, '2026-01-15', -999);
  await seedTxn(acc.id, '2026-02-15', 100);
  const result = await balanceAtDateMod.balanceAtDate(acc, '2026-01-31');
  assert.deepEqual(result, [{ currency: 'CAD', amount: 500 }]);
});

test('balanceAtDate: backward derivation negates non-default-currency txns in the window', async () => {
  // The anchor implies a 0 balance for non-default currencies at the anchor
  // date (same assumption the forward path makes), so deriving backward a
  // USD inflow inside the window yields a negative USD balance at asOf.
  const acc = await seedAccount({ defaultCurrency: 'CAD', openingBalance: 1000, openingBalanceDate: '2026-03-01' });
  await seedTxn(acc.id, '2026-02-10', 200, 'USD');
  const result = await balanceAtDateMod.balanceAtDate(acc, '2026-01-31');
  const sorted = [...result].sort((a, b) => a.currency.localeCompare(b.currency));
  assert.deepEqual(sorted, [
    { currency: 'CAD', amount: 1000 },
    { currency: 'USD', amount: -200 },
  ]);
});
