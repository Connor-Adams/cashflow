/**
 * Integration: end-to-end Wealthsimple bundle import via /api/import/upload-bundle.
 *
 * Uses synthetic CSVs (not real bundle files) so the test is hermetic and
 * doesn't depend on personal data. The synthetic CSVs match the real
 * Wealthsimple monthly-statement format byte-for-byte: header, TX codes,
 * description-string idioms (BUY/SELL/DIV with executed-at/received-on),
 * crypto staking zero-value rows, and credit-card layout.
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
const csvUploadDir = path.join(backendRoot, 'uploads', 'test-ws-bundle-csv');
const receiptsUploadDir = path.join(backendRoot, 'uploads', 'test-ws-bundle-receipts');

let app: import('express').Express;
let authed: ReturnType<typeof request.agent>;
let testDb: PgTestDb;

before(async () => {
  fs.mkdirSync(csvUploadDir, { recursive: true });
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
  fs.mkdirSync(receiptsUploadDir, { recursive: true });

  process.env.CSV_UPLOAD_DIR = csvUploadDir;
  process.env.RECEIPTS_UPLOAD_DIR = receiptsUploadDir;

  testDb = await setupPgTestDb('ws-bundle');

  const mod = await import('../../src/app.js');
  app = mod.default;
  authed = testAgent(app);
  const register = await authed.post('/api/auth/register').send({
    email: 'ws-bundle@example.com',
    displayName: 'WS Bundle User',
    password: 'password123',
  });
  assert.equal(register.status, 201);
});

after(async () => {
  await teardownPgTestDb(testDb);
  fs.rmSync(receiptsUploadDir, { recursive: true, force: true });
});

const CHEQUING_CSV = `"date","transaction","description","amount","balance","currency"
"2025-01-02","AFT_IN","Direct deposit from ADAMS GREENE HO","207.4","13160.89","CAD"
"2025-01-07","TRFOUT","Transfer out","-30.0","13130.89","CAD"
`;

const CORPORATE_INVESTING_CSV = `"date","transaction","description","amount","balance","currency"
"2026-01-02","SELL","XEQT - iShares Core Equity ETF Portfolio: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)","7500.51","7500.52","CAD"
"2026-01-05","DIV","XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2026-01-05, record date of 2025-12-30","146.47","15146.99","CAD"
"2026-01-15","FPLINT","Stock lending monthly interest payment","0.01","0.02","CAD"
`;

const CRYPTO_CSV = `"date","transaction","description","amount","balance","currency"
"2025-01-01","FEE","Fee paid on DOT-Polkadot staking reward: 0.0006219861","0.0","0.0","CAD"
"2025-01-01","CRYPTORWD","0.0020732867 of DOT rewards earned","0.0","0.0","DOT"
"2025-01-02","FEE","Fee paid on DOT-Polkadot staking reward: 0.0006111670","0.0","0.0","CAD"
"2025-01-02","CRYPTORWD","0.0020372232 of DOT rewards earned","0.0","0.0","DOT"
`;

const CREDIT_CARD_CSV = `"transaction_date","post_date","type","details","amount","currency"
"2025-12-06","2025-12-06","Purchase","KFC/TB STONE RD","11.97","CAD"
"2025-12-06","2025-12-07","Purchase","NOFRILLS DOMENICS","22.01","CAD"
"2025-12-12","2025-12-12","Monthly fee","","10.0","CAD"
`;

type BundleResult = {
  file: string;
  wsid: string | null;
  accountId: number | null;
  accountName: string | null;
  accountCreated: boolean;
  inserted: number;
  insertedTransactions: number;
  insertedInvestmentActivities: number;
  skippedDuplicates: number;
  rowErrors: number;
  warnings: string[];
  error?: string;
};

test('POST /api/import/upload-bundle: auto-creates accounts and routes 4 files', async () => {
  const res = await authed
    .post('/api/import/upload-bundle')
    .attach('files', Buffer.from(CHEQUING_CSV, 'utf8'), {
      filename: 'Chequing-2025-01-01-monthly-statement-transactions-WK3DD9X35CAD.csv',
      contentType: 'text/csv',
    })
    .attach('files', Buffer.from(CORPORATE_INVESTING_CSV, 'utf8'), {
      filename:
        'Corporate-investing-2026-01-01-monthly-statement-transactions-HQ8H0GZ07CAD.csv',
      contentType: 'text/csv',
    })
    .attach('files', Buffer.from(CRYPTO_CSV, 'utf8'), {
      filename: 'Crypto-2025-01-01-monthly-statement-transactions-HQ6R28910CAD.csv',
      contentType: 'text/csv',
    })
    .attach('files', Buffer.from(CREDIT_CARD_CSV, 'utf8'), {
      filename:
        'Wealthsimple-credit-card-2025-12-01-credit-card-statement-transactions-ca-credit-card-oaa9hcx83A.csv',
      contentType: 'text/csv',
    });

  assert.equal(res.status, 200, `body=${JSON.stringify(res.body)}`);
  const results = res.body.results as BundleResult[];
  assert.equal(results.length, 4);

  const cheq = results.find((r) => r.file.startsWith('Chequing'))!;
  assert.equal(cheq.wsid, 'WK3DD9X35CAD');
  assert.equal(cheq.accountName, 'Wealthsimple Chequing');
  assert.equal(cheq.accountCreated, true);
  assert.ok(cheq.insertedTransactions >= 2, `expected >=2 chequing txns, got ${cheq.insertedTransactions}`);

  const corp = results.find((r) => r.file.startsWith('Corporate-investing'))!;
  assert.equal(corp.wsid, 'HQ8H0GZ07CAD');
  assert.equal(corp.accountName, 'Wealthsimple Corporate Investing');
  assert.equal(corp.accountCreated, true);
  assert.ok(
    corp.insertedInvestmentActivities >= 3,
    `expected >=3 invest activities, got ${corp.insertedInvestmentActivities}`,
  );
  assert.ok(
    corp.insertedTransactions >= 3,
    `expected >=3 invest txns, got ${corp.insertedTransactions}`,
  );

  const crypto = results.find((r) => r.file.startsWith('Crypto'))!;
  assert.equal(crypto.accountName, 'Wealthsimple Crypto');
  // 2 zero-value non-CAD (DOT) rows should be filtered
  assert.ok(
    crypto.warnings.some((w) => /Filtered \d+ zero-value non-CAD/.test(w)),
    `expected zero-value warning in ${JSON.stringify(crypto.warnings)}`,
  );

  const cc = results.find((r) => r.file.startsWith('Wealthsimple-credit-card'))!;
  assert.equal(cc.wsid, 'oaa9hcx83A');
  assert.equal(cc.accountName, 'Wealthsimple Credit Card');
  assert.ok(cc.insertedTransactions >= 1, `expected >=1 cc txn, got ${cc.insertedTransactions}`);
});

test('Corporate investing: transactions get autoBusiness=true', async () => {
  const txns = await authed.get('/api/transactions').query({ pageSize: 200 });
  assert.equal(txns.status, 200);
  const corpTxns = (
    txns.body.data as Array<{ autoBusiness?: boolean; merchantClean?: string; accountId?: number }>
  ).filter((row) => row.merchantClean && row.merchantClean.startsWith('XEQT'));
  assert.ok(
    corpTxns.length > 0,
    `expected corporate-investing XEQT txns in ${JSON.stringify(txns.body.data.slice(0, 4))}`,
  );
  for (const row of corpTxns) {
    assert.equal(row.autoBusiness, true, `expected autoBusiness=true on ${JSON.stringify(row)}`);
  }
});

test('Re-upload of the same bundle file is treated as duplicates', async () => {
  const res = await authed
    .post('/api/import/upload-bundle')
    .attach('files', Buffer.from(CHEQUING_CSV, 'utf8'), {
      filename: 'Chequing-2025-01-01-monthly-statement-transactions-WK3DD9X35CAD.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200);
  const result = res.body.results[0] as BundleResult;
  // accountCreated must be false now — it exists from the first upload
  assert.equal(result.accountCreated, false);
  assert.equal(result.wsid, 'WK3DD9X35CAD');
  // content-hash dedupe in commitStatementImport short-circuits inserts
  assert.equal(result.insertedTransactions, 0);
  assert.ok(result.skippedDuplicates >= 2, `expected skippedDuplicates >=2, got ${result.skippedDuplicates}`);
});

test('Unrecognized filename returns per-file error, not 500', async () => {
  const res = await authed
    .post('/api/import/upload-bundle')
    .attach('files', Buffer.from('Date,Description,Amount\n2025-01-01,X,1.00\n', 'utf8'), {
      filename: 'Amex_2025_01.csv',
      contentType: 'text/csv',
    });
  assert.equal(res.status, 200);
  const result = res.body.results[0] as BundleResult;
  assert.equal(result.error, 'unrecognized Wealthsimple filename');
  assert.equal(result.accountId, null);
});

test('Missing files field returns 400', async () => {
  const res = await authed.post('/api/import/upload-bundle');
  assert.equal(res.status, 400);
});
