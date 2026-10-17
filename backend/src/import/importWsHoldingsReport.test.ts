import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

let models: typeof import('../models/index.js');
let importWsHoldingsReport: typeof import('./importWsHoldingsReport.js').importWsHoldingsReport;

before(async () => {
  models = await import('../models/index.js');
  await models.sequelize.sync({ force: true });
  importWsHoldingsReport = (await import('./importWsHoldingsReport.js')).importWsHoldingsReport;
});

beforeEach(async () => {
  await models.sequelize.sync({ force: true });
});

const HEADER = [
  'Account Name', 'Account Type', 'Account Classification', 'Account Number',
  'Symbol', 'Exchange', 'MIC', 'Name', 'Security Type', 'Quantity',
  'Position Direction', 'Market Price', 'Market Price Currency',
  'Book Value (CAD)', 'Book Value Currency (CAD)', 'Book Value (Market)',
  'Book Value Currency (Market)', 'Market Value', 'Market Value Currency',
  'Market Unrealized Returns', 'Market Unrealized Returns Currency',
].join(',');

const VFV = '"Corporate investing","Corporate investing","Trade","HQ8H0GZ07CAD","VFV","TSX","XTSE","Vanguard S&P 500 ETF","EXCHANGE_TRADED_FUND","200.8294","LONG","187.77","CAD","33652.5276","CAD","33652.5276","CAD","37709.7364","CAD","4057.2088","CAD"';
const BTC = '"Crypto","Crypto","Trade","HQ6R28910CAD","BTC","","","Bitcoin","CRYPTOCURRENCY","0.00233675","LONG","106883.84","CAD","276.01","CAD","276.01","CAD","249.8283","CAD","-26.1816","CAD"';
const ORPHAN = '"Margin","Margin","Trade","HQ4TLFJ02CAD","AAPL","","","Apple","EQUITY","1","LONG","300","CAD","300","CAD","300","CAD","300","CAD","0","CAD"';

function csv(rows: string[], asOf = '2026-09-16'): Buffer {
  return Buffer.from([HEADER, ...rows, `"As of ${asOf} 20:42 GMT-04:00"`].join('\n'), 'utf8');
}

async function seedHousehold() {
  const household = await models.Household.create({ name: 'Holdings HH' });
  const mk = (name: string, shortCode: string) =>
    models.Account.create({
      name, householdId: household.id, accountType: 'investment',
      owner: 'me', visibility: 'private', defaultCurrency: 'CAD', shortCode,
    } as never);
  const corp = await mk('WS Corporate Investing', 'HQ8H0GZ07CAD');
  const crypto = await mk('WS Crypto', 'HQ6R28910CAD');
  return { household, corp, crypto };
}

test('one report lands positions on each account it covers', async () => {
  const ctx = await seedHousehold();
  const result = await importWsHoldingsReport({
    buffer: csv([VFV, BTC]),
    fileName: 'holdings-report-2026-09-16.csv',
    householdId: ctx.household.id,
    userId: 1,
  });

  assert.equal(result.statementDate, '2026-09-16');
  assert.deepEqual(result.parseErrors, []);
  assert.deepEqual(
    result.accounts.map((a) => [a.wsid, a.accountId, a.insertedHoldings]),
    [['HQ8H0GZ07CAD', ctx.corp.id, 1], ['HQ6R28910CAD', ctx.crypto.id, 1]],
  );
  assert.equal(await models.HoldingSnapshot.count(), 2);
});

test('re-importing the same report inserts nothing', async () => {
  const ctx = await seedHousehold();
  const args = {
    buffer: csv([VFV, BTC]),
    fileName: 'holdings-report-2026-09-16.csv',
    householdId: ctx.household.id,
    userId: 1,
  };
  await importWsHoldingsReport(args);
  const second = await importWsHoldingsReport({ ...args, buffer: csv([VFV, BTC]) });

  assert.equal(second.accounts.reduce((a, x) => a + x.insertedHoldings, 0), 0);
  assert.equal(await models.HoldingSnapshot.count(), 2, 'still one snapshot per position');
});

test('the next report date adds a snapshot rather than replacing one', async () => {
  const ctx = await seedHousehold();
  const base = { fileName: 'holdings.csv', householdId: ctx.household.id, userId: 1 };
  await importWsHoldingsReport({ ...base, buffer: csv([VFV], '2026-09-16') });
  await importWsHoldingsReport({ ...base, buffer: csv([VFV], '2026-10-16') });

  assert.equal(await models.HoldingSnapshot.count(), 2);
  const dates = (await models.HoldingSnapshot.findAll({ order: [['statementDate', 'ASC']] }))
    .map((h) => String(h.statementDate));
  assert.deepEqual(dates, ['2026-09-16', '2026-10-16']);
});

test('an account the household does not have is reported, never auto-created', async () => {
  const ctx = await seedHousehold();
  const result = await importWsHoldingsReport({
    buffer: csv([VFV, ORPHAN]),
    fileName: 'holdings.csv',
    householdId: ctx.household.id,
    userId: 1,
  });

  const orphan = result.accounts.find((a) => a.wsid === 'HQ4TLFJ02CAD');
  assert.ok(orphan);
  assert.equal(orphan.unmatched, true);
  assert.equal(orphan.accountId, null);
  assert.equal(orphan.insertedHoldings, 0);
  // The accounts that DID match still imported.
  assert.equal(result.accounts.find((a) => a.wsid === 'HQ8H0GZ07CAD')?.insertedHoldings, 1);
  assert.equal(await models.Account.count(), 2, 'no account was created');
});

test('a report with no as-of trailer imports nothing', async () => {
  const ctx = await seedHousehold();
  const result = await importWsHoldingsReport({
    buffer: Buffer.from([HEADER, VFV].join('\n'), 'utf8'),
    fileName: 'holdings.csv',
    householdId: ctx.household.id,
    userId: 1,
  });
  assert.equal(result.statementDate, null);
  assert.deepEqual(result.accounts, []);
  assert.equal(await models.HoldingSnapshot.count(), 0);
});
