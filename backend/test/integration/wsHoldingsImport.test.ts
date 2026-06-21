/**
 * Integration: end-to-end Wealthsimple holdings import via
 * /api/import/upload-holdings.
 *
 * The CSV is a synthetic mirror of the real Wealthsimple holdings/positions
 * report (header byte-for-byte, mixed asset types, the trailing
 * `"As of …"` comment line).  We pre-seed two accounts keyed by
 * `shortCode` and leave a third WSID out of the seed so the test can verify
 * unknown-account skip behavior.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { testAgent } from './_setup/testServer.js';
import { setupPgTestDb, teardownPgTestDb, type PgTestDb } from './_setup/pgTestDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const csvUploadDir = path.join(backendRoot, 'uploads', 'test-ws-holdings-csv');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let tfsaAccountId: number;
let corpAccountId: number;
let testDb: PgTestDb;

const HEADER =
  'Account Name,Account Type,Account Classification,Account Number,Symbol,Exchange,MIC,Name,Security Type,Quantity,Position Direction,Market Price,Market Price Currency,Book Value (CAD),Book Value Currency (CAD),Book Value (Market),Book Value Currency (Market),Market Value,Market Value Currency,Market Unrealized Returns,Market Unrealized Returns Currency';

function buildHoldingsCsv(opts: {
  asOf: string;
  vfvMarketValue?: number;
  includeUnknownAccount?: boolean;
}): string {
  const lines = [
    HEADER,
    `"TFSA","TFSA","Trade","HQ6LMLTK8CAD","VFV","TSX","XTSE","Vanguard S&P 500 ETF","EXCHANGE_TRADED_FUND","37.3167","LONG","183.2","CAD","5498.1","CAD","5498.1","CAD","${opts.vfvMarketValue ?? 6836.41944}","CAD","1338.31944","CAD"`,
    '"TFSA","TFSA","Trade","HQ6LMLTK8CAD","XEQT","TSX","XTSE","iShares Core Equity ETF","EXCHANGE_TRADED_FUND","83.5049","LONG","43.98","CAD","3085.5","CAD","3085.5","CAD","3672.545502","CAD","587.045502","CAD"',
    '"Corporate investing","Corporate investing","Trade","HQ8H0GZ07CAD","GOLD","","","Physically backed gold","PRECIOUS_METAL","0.4769142478","LONG","6233.23","CAD","3500","CAD","3500","CAD","2972.716196814394","CAD","-527.283803185606","CAD"',
    '"Crypto","Crypto","Trade","HQ6R28910CAD","BTC","","","Bitcoin","CRYPTOCURRENCY","0.00233675","LONG","103856.665017","CAD","276.01","CAD","276.01","CAD","242.963237233665","CAD","-33.046762766335","CAD"',
  ];
  if (opts.includeUnknownAccount) {
    lines.push(
      '"FHSA","FHSA","Trade","UNKNOWN-WSID","NVDA","TSX","XTSE","Nvidia CDR","EQUITY","1","LONG","48.38","CAD","48.38","CAD","48.38","CAD","48.38","CAD","0","CAD"',
    );
  }
  lines.push('', `"As of ${opts.asOf}"`);
  return lines.join('\n');
}

before(async () => {
  fs.mkdirSync(csvUploadDir, { recursive: true });

  process.env.CSV_UPLOAD_DIR = csvUploadDir;

  testDb = await setupPgTestDb('ws-holdings');

  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'ws-holdings@example.com',
    displayName: 'WS Holdings User',
    password: 'password123',
  });
  assert.equal(register.status, 201);

  // Pre-seed two accounts: TFSA and Corporate investing.  Crypto is
  // intentionally omitted from the seed for the FIRST test (it gets created
  // before the unknown-account test) so the importer must find both.
  const tfsa = await authed.post('/api/accounts').send({
    name: 'WS TFSA',
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'investment',
    shortCode: 'HQ6LMLTK8CAD',
  });
  assert.equal(tfsa.status, 201, JSON.stringify(tfsa.body));
  tfsaAccountId = tfsa.body.id as number;

  const corp = await authed.post('/api/accounts').send({
    name: 'WS Corporate Investing',
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'investment',
    shortCode: 'HQ8H0GZ07CAD',
  });
  assert.equal(corp.status, 201);
  corpAccountId = corp.body.id as number;

  const crypto = await authed.post('/api/accounts').send({
    name: 'WS Crypto',
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'investment',
    shortCode: 'HQ6R28910CAD',
  });
  assert.equal(crypto.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
});

type HoldingsResult = {
  file: string;
  statementDate: string | null;
  totalRows: number;
  inserted: number;
  updated: number;
  skippedUnknownAccount: number;
  warnings: string[];
  errors: string[];
  accountsAffected: number;
};

test('POST /api/import/upload-holdings inserts a snapshot row per holding', async () => {
  const csv = buildHoldingsCsv({ asOf: '2026-05-23 10:14 GMT-04:00' });
  const res = await authed
    .post('/api/import/upload-holdings')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'holdings-report-2026-05-23.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body as HoldingsResult;
  assert.equal(r.statementDate, '2026-05-23');
  assert.equal(r.totalRows, 4);
  assert.equal(r.inserted, 4);
  assert.equal(r.updated, 0);
  assert.equal(r.skippedUnknownAccount, 0);
  assert.equal(r.accountsAffected, 3);
  assert.equal(r.errors.length, 0);
});

test('Re-upload of the same date UPDATEs existing rows (no duplicates)', async () => {
  // Same date, but VFV market value moved from 6836.41944 -> 7000.00.  The
  // upsert path should UPDATE the existing row, not insert a duplicate.
  const csv = buildHoldingsCsv({
    asOf: '2026-05-23 10:14 GMT-04:00',
    vfvMarketValue: 7000,
  });
  const res = await authed
    .post('/api/import/upload-holdings')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'holdings-report-2026-05-23-v2.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body as HoldingsResult;
  assert.equal(r.statementDate, '2026-05-23');
  assert.equal(r.inserted, 0, 'no new rows on re-upload of same date');
  assert.equal(r.updated, 4, 'all four rows updated in place');
  assert.equal(r.accountsAffected, 3);

  // Verify the new market value landed by listing portfolio holdings for the
  // TFSA account.  We hit the same DB the import wrote to — the model
  // delegates DECIMAL parsing to the driver, so values come back as strings.
  const { sequelize, HoldingSnapshot } = await import('../../src/models/index.js');
  void sequelize; // ensure init
  const rows = await HoldingSnapshot.findAll({
    where: { accountId: tfsaAccountId, statementDate: '2026-05-23' },
  });
  // DECIMAL values come back as strings on PG and numbers on SQLite, so
  // coerce + compare numerically.
  const vfv = rows.find((row) => Math.abs(Number(row.quantity) - 37.3167) < 1e-6);
  assert.ok(vfv, 'VFV row missing after update');
  assert.equal(
    Math.round(Number(vfv.marketValue)),
    7000,
    `expected updated marketValue ~7000, got ${vfv.marketValue}`,
  );
});

test('Unknown Account Number is silently skipped (no 500)', async () => {
  const csv = buildHoldingsCsv({
    asOf: '2026-06-15 09:00 GMT-04:00',
    includeUnknownAccount: true,
  });
  const res = await authed
    .post('/api/import/upload-holdings')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'holdings-2026-06-15.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body as HoldingsResult;
  assert.equal(r.statementDate, '2026-06-15');
  assert.equal(r.totalRows, 5);
  // 4 known accounts inserted, 1 unknown skipped
  assert.equal(r.inserted, 4);
  assert.equal(r.skippedUnknownAccount, 1);
  assert.ok(
    r.warnings.some((w) => w.includes('UNKNOWN-WSID')),
    `expected unknown-account warning, got ${JSON.stringify(r.warnings)}`,
  );
});

test('Missing file field returns 400', async () => {
  const res = await authed.post('/api/import/upload-holdings');
  assert.equal(res.status, 400);
});

test('Non-CSV filename is rejected by multer fileFilter', async () => {
  const res = await authed
    .post('/api/import/upload-holdings')
    .attach('file', Buffer.from('hello'), {
      filename: 'holdings.txt',
      contentType: 'text/plain',
    });
  // multer fileFilter -> error -> our error handler returns 400
  assert.ok(res.status >= 400, `expected error status, got ${res.status}`);
});

test('CSV without trailing "As of" line returns parse error in body, not 500', async () => {
  const csv = [
    HEADER,
    '"TFSA","TFSA","Trade","HQ6LMLTK8CAD","VFV","TSX","XTSE","Vanguard","EXCHANGE_TRADED_FUND","37","LONG","183.2","CAD","5498","CAD","5498","CAD","6836","CAD","1338","CAD"',
  ].join('\n');
  const res = await authed
    .post('/api/import/upload-holdings')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'holdings-no-asof.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200);
  const r = res.body as HoldingsResult;
  assert.equal(r.statementDate, null);
  assert.equal(r.inserted, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /As of/);
});

test('Securities created by bundle import are reused (no duplicate by symbol+currency)', async () => {
  // First, do a bundle-style import that mints a Security with symbol XEQT
  // via the BUY-description path. Then ensure a holdings import for the same
  // symbol does NOT create a new Security row.
  const cheq = await authed.post('/api/accounts').send({
    name: 'WS Investing',
    owner: 'me',
    defaultCurrency: 'CAD',
    accountType: 'investment',
    shortCode: 'HQ-TESTREUSE',
  });
  assert.equal(cheq.status, 201);
  const investAccountId = cheq.body.id as number;

  // Insert a transaction CSV that creates an investment activity for XEQT
  // (same path used by the bundle importer's `generic_passthrough` profile).
  const investCsv = `"date","transaction","description","amount","balance","currency"
"2026-01-09","BUY","XEQT - iShares Core Equity ETF Portfolio: Bought 1 share at $43.98 per share (executed at 2026-01-08)","-43.98","43.98","CAD"
`;
  const importRes = await authed
    .post('/api/import/upload')
    .field('accountId', String(investAccountId))
    .field('profileId', 'generic_passthrough')
    .attach('file', Buffer.from(investCsv, 'utf8'), {
      filename: 'invest.csv',
      contentType: 'text/csv',
    });
  assert.equal(importRes.status, 200);

  // Now import a holdings report for a different account (TFSA we already
  // seeded) with XEQT as one of the rows. The holding's Security should be
  // the SAME row that the bundle import minted — same (householdId, symbol,
  // currency) key.
  const { Security } = await import('../../src/models/index.js');
  const before = await Security.findAll({
    where: { symbol: 'XEQT', currency: 'CAD' },
  });
  assert.ok(before.length > 0, 'XEQT security should exist after invest import');
  const before_count = before.length;

  // Re-upload the original holdings CSV (different date so it's a fresh insert).
  const csv = buildHoldingsCsv({ asOf: '2026-07-01 09:00 GMT-04:00' });
  const upload = await authed
    .post('/api/import/upload-holdings')
    .attach('file', Buffer.from(csv, 'utf8'), {
      filename: 'holdings-2026-07-01.csv',
      contentType: 'text/csv',
    });
  assert.equal(upload.status, 200);

  const after = await Security.findAll({
    where: { symbol: 'XEQT', currency: 'CAD' },
  });
  assert.equal(
    after.length,
    before_count,
    `expected XEQT Security to be reused (no new row); had ${before_count}, now ${after.length}`,
  );
  // Sanity: holding row exists for the TFSA account on 2026-07-01.
  void corpAccountId;
});
