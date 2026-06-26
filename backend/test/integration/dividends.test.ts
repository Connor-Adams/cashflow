/**
 * Integration tests for dividend payout reconciliation
 * (`backend/src/routes/dividends.ts` + `dividendMatcher.ts`, issue #305).
 *
 * Per-file sqlite + migrate, mirroring portfolioForwardIncome.test.ts. Covers:
 *   - auto-match: single candidate → matched (AC #2); zero / multiple → left
 *     unmatched (AC #3).
 *   - GET /api/dividends?status=unmatched returns past-window unmatched (AC #4).
 *   - GET ?status=matched carries expected/actual + variance flag (AC #10).
 *   - POST /:id/match: own-household 200, cross-household txn → 403 (AC #5).
 *   - POST /:id/unmatch clears the link.
 *   - notifyUnmatchedDividends fires once per row after the grace window (AC #9).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { testAgent } from './_setup/testServer.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..', '..');
const dbPath = path.join(backendRoot, 'data', 'test-dividends.sqlite');

let app: import('express').Express;
let models: typeof import('../../src/models');

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

  const mod = await import('../../src/app.js');
  app = mod.default;
  models = await import('../../src/models');
});

after(() => {
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
  }
});

async function makeHousehold(tag: string) {
  const { seedHousehold } = await import('./portfolioFixtures.js');
  const seeded = await seedHousehold(models, `div-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`);
  const agent = testAgent(app);
  agent.jar.setCookie(`cashflow_session=${seeded.token}; Path=/`);
  return { ...seeded, agent };
}

/** Seed a cash credit transaction on an account. */
async function seedCredit(opts: {
  householdId: number;
  accountId: number;
  date: string;
  amount: number;
  merchant?: string;
  currency?: string;
}): Promise<number> {
  const crypto = await import('crypto');
  const row = await models.Transaction.create({
    accountId: opts.accountId,
    householdId: opts.householdId,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'dividends-test',
    date: opts.date,
    merchantRaw: opts.merchant ?? 'XYZ DIVIDEND',
    merchantClean: opts.merchant ?? 'XYZ DIVIDEND',
    merchantCanonical: null,
    amount: opts.amount.toFixed(4),
    currency: opts.currency ?? 'USD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: null,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: null,
    myShareAmount: String(opts.amount),
    partnerShareAmount: '0',
    businessAmount: '0',
    txnType: 'income',
    autoSource: null,
    autoConfidence: null,
    linkedTransactionId: null,
    transferPurpose: null,
    transferLinkedAt: null,
    isRecurring: false,
    reviewFlag: false,
    reviewedAt: null,
    createdByUserId: null,
  });
  return row.id;
}

test('auto-match links a single candidate credit (AC #2)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('automatch');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'BRK1');
  const sec = await seedSecurity(models, hh.household.id, 'XYZ', 'XYZ Corp', 'stock', 'USD');
  // Hold 100 shares as of well before the payment date.
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  // $1.00/share dividend, payment 5 days ago.
  const payDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 1.0,
    currency: 'USD',
  });
  // One matching credit: $100 on the payment date.
  const txnId = await seedCredit({
    householdId: hh.household.id,
    accountId: acct.id,
    date: payDate,
    amount: 100,
  });

  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  const res = await autoMatchDividends();
  assert.equal(res.autoMatched, 1, JSON.stringify(res));

  const recon = await models.DividendReconciliation.findOne({
    where: { accountId: acct.id },
  });
  assert.ok(recon, 'reconciliation row created');
  assert.equal(recon!.matchedTransactionId, txnId);
  assert.equal(recon!.matchSource, 'auto');
});

test('auto-match leaves unmatched when multiple candidates (AC #3)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('multi');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'BRK2');
  const sec = await seedSecurity(models, hh.household.id, 'MUL', 'Multi Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  const payDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 1.0,
    currency: 'USD',
  });
  // Two near-identical credits → ambiguous → no auto-match.
  await seedCredit({ householdId: hh.household.id, accountId: acct.id, date: payDate, amount: 100 });
  await seedCredit({ householdId: hh.household.id, accountId: acct.id, date: payDate, amount: 99.5 });

  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  const res = await autoMatchDividends();

  const recon = await models.DividendReconciliation.findOne({ where: { accountId: acct.id } });
  assert.ok(recon, 'reconciliation row created even when unmatched');
  assert.equal(recon!.matchedTransactionId, null, JSON.stringify(res));
});

test('auto-match leaves unmatched when zero candidates (AC #3)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('zero');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'BRK3');
  const sec = await seedSecurity(models, hh.household.id, 'ZER', 'Zero Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 50,
  });
  const payDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 1.0,
    currency: 'USD',
  });
  // No credit at all.

  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  await autoMatchDividends();

  const recon = await models.DividendReconciliation.findOne({ where: { accountId: acct.id } });
  assert.ok(recon, 'reconciliation row created');
  assert.equal(recon!.matchedTransactionId, null);
});

test('GET ?status=unmatched returns past-window unmatched payouts (AC #4)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('list');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'LST1');
  const sec = await seedSecurity(models, hh.household.id, 'LST', 'List Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 10,
  });
  const payDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 17 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 0.5,
    currency: 'USD',
  });
  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  await autoMatchDividends();

  const res = await hh.agent.get('/api/dividends?status=unmatched&windowMonths=12');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.status, 'unmatched');
  const row = res.body.data.find((d: { symbol: string }) => d.symbol === 'LST');
  assert.ok(row, `expected an LST unmatched row in ${JSON.stringify(res.body.data)}`);
  assert.equal(row.matchedTransactionId, null);
  assert.equal(row.paymentDate, payDate);
});

test('POST /:id/match links own txn; cross-household txn is 403 (AC #5)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('matchA');
  const other = await makeHousehold('matchB');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'MTA');
  const sec = await seedSecurity(models, hh.household.id, 'MAT', 'Match Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  const payDate = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    // Two candidates so auto-match leaves it unmatched, giving us a row to match by hand.
    amount: 1.0,
    currency: 'USD',
  });
  await seedCredit({ householdId: hh.household.id, accountId: acct.id, date: payDate, amount: 100 });
  await seedCredit({ householdId: hh.household.id, accountId: acct.id, date: payDate, amount: 99.5 });
  const ownTxnId = await seedCredit({
    householdId: hh.household.id,
    accountId: acct.id,
    date: payDate,
    amount: 100,
    merchant: 'MAT DIV PAYMENT',
  });

  // Other household's account + transaction.
  const otherAcct = await seedAccount(models, other.household.id, other.user.id, 'Other BRK', 'OTH');
  const otherTxnId = await seedCredit({
    householdId: other.household.id,
    accountId: otherAcct.id,
    date: payDate,
    amount: 100,
  });

  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  await autoMatchDividends();
  const recon = await models.DividendReconciliation.findOne({ where: { accountId: acct.id } });
  assert.ok(recon, 'reconciliation row exists');
  assert.equal(recon!.matchedTransactionId, null, 'left unmatched by auto');

  // Cross-household transaction → 403.
  const forbidden = await hh.agent
    .post(`/api/dividends/${recon!.id}/match`)
    .send({ transactionId: otherTxnId });
  assert.equal(forbidden.status, 403, forbidden.text);

  // Own transaction → 200.
  const ok = await hh.agent
    .post(`/api/dividends/${recon!.id}/match`)
    .send({ transactionId: ownTxnId });
  assert.equal(ok.status, 200, ok.text);
  await recon!.reload();
  assert.equal(recon!.matchedTransactionId, ownTxnId);
  assert.equal(recon!.matchSource, 'manual');

  // Unmatch clears it.
  const cleared = await hh.agent.post(`/api/dividends/${recon!.id}/unmatch`).send({});
  assert.equal(cleared.status, 200, cleared.text);
  await recon!.reload();
  assert.equal(recon!.matchedTransactionId, null);
});

test('POST /:id/match on an already-matched row → 409, first match wins (issue #847)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('match409');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'M409');
  const sec = await seedSecurity(models, hh.household.id, 'M49', 'Race Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  const payDate = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    // Two candidates so auto-match leaves it unmatched, giving us a row to match by hand.
    amount: 1.0,
    currency: 'USD',
  });
  // Two distinct credits, both valid candidates for the same dividend.
  const firstTxnId = await seedCredit({
    householdId: hh.household.id,
    accountId: acct.id,
    date: payDate,
    amount: 100,
    merchant: 'M49 DIV PAYMENT A',
  });
  const secondTxnId = await seedCredit({
    householdId: hh.household.id,
    accountId: acct.id,
    date: payDate,
    amount: 99.5,
    merchant: 'M49 DIV PAYMENT B',
  });

  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  await autoMatchDividends();
  const recon = await models.DividendReconciliation.findOne({ where: { accountId: acct.id } });
  assert.ok(recon, 'reconciliation row exists');
  assert.equal(recon!.matchedTransactionId, null, 'left unmatched by auto');

  // First manual match claims the row.
  const first = await hh.agent
    .post(`/api/dividends/${recon!.id}/match`)
    .send({ transactionId: firstTxnId });
  assert.equal(first.status, 200, first.text);

  // Second manual match to a DIFFERENT txn must NOT clobber the first — it
  // returns 409 Conflict and leaves the original match intact (the loser is
  // rejected loudly, not dropped silently — issue #847).
  const second = await hh.agent
    .post(`/api/dividends/${recon!.id}/match`)
    .send({ transactionId: secondTxnId });
  assert.equal(second.status, 409, second.text);

  await recon!.reload();
  assert.equal(
    recon!.matchedTransactionId,
    firstTxnId,
    'first match wins deterministically; loser did not overwrite',
  );
  assert.equal(recon!.matchSource, 'manual');
});

test('GET ?status=upcoming returns a future-dated dividend (AC #555-1)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('upcoming');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'UPC1');
  const sec = await seedSecurity(models, hh.household.id, 'UPC', 'Upcoming Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  // Payment 7 days from now → inside the 30-day horizon.
  const payDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 1.0,
    currency: 'USD',
  });

  const res = await hh.agent.get('/api/dividends?status=upcoming');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.status, 'upcoming');
  const row = res.body.data.find((d: { symbol: string }) => d.symbol === 'UPC');
  assert.ok(row, `expected an UPC upcoming row in ${JSON.stringify(res.body.data)}`);
  assert.equal(row.paymentDate, payDate);
});

test('GET ?status=upcoming includes NULL payment_date via ex-date fallback (AC #555-2)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('upcoming-null');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'UPC2');
  const sec = await seedSecurity(models, hh.household.id, 'NPD', 'No Pay Date Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 50,
  });
  // No payment_date (mirrors all 121 prod rows). Future ex-date → should still surface.
  const exDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: exDate,
    paymentDate: null,
    amount: 0.75,
    currency: 'USD',
  });

  const res = await hh.agent.get('/api/dividends?status=upcoming');
  assert.equal(res.status, 200, res.text);
  const row = res.body.data.find((d: { symbol: string }) => d.symbol === 'NPD');
  assert.ok(row, `expected an NPD upcoming row despite NULL payment_date in ${JSON.stringify(res.body.data)}`);
  assert.equal(row.paymentDate, null);
  assert.equal(row.exDividendDate, exDate);
});

test('GET ?status=upcoming excludes past-dated dividends (AC #555-3)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('upcoming-past');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'UPC3');
  const sec = await seedSecurity(models, hh.household.id, 'PST', 'Past Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 30,
  });
  // Both ex-date and payment-date in the past → must not appear.
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    paymentDate: new Date(Date.now() - 23 * 86400000).toISOString().slice(0, 10),
    amount: 0.5,
    currency: 'USD',
  });
  // NULL payment_date with a past ex-date → must not appear via fallback either.
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
    paymentDate: null,
    amount: 0.4,
    currency: 'USD',
  });

  const res = await hh.agent.get('/api/dividends?status=upcoming');
  assert.equal(res.status, 200, res.text);
  const row = res.body.data.find((d: { symbol: string }) => d.symbol === 'PST');
  assert.equal(row, undefined, `PST should be excluded but found ${JSON.stringify(row)}`);
});

test('auto-run does not clobber a concurrent manual match (issue #844 Bug A)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('clobber');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'CLB');
  const sec = await seedSecurity(models, hh.household.id, 'CLB', 'Clobber Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  const payDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 1.0,
    currency: 'USD',
  });
  // The credit the user deliberately matched by hand (kept alive throughout).
  const manualTxnId = await seedCredit({
    householdId: hh.household.id,
    accountId: acct.id,
    date: payDate,
    amount: 100,
    merchant: 'CLB DIV MANUAL',
  });

  // First pass creates the reconciliation row. With a single viable candidate
  // it WOULD auto-match, but we want the row present and unclaimed so we can
  // simulate a manual match landing first — so seed a second ambiguous credit
  // for this pass, then remove it before the racing pass.
  const ambiguousTxnId = await seedCredit({
    householdId: hh.household.id,
    accountId: acct.id,
    date: payDate,
    amount: 99.6,
  });
  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  await autoMatchDividends();
  const recon = await models.DividendReconciliation.findOne({ where: { accountId: acct.id } });
  assert.ok(recon, 'reconciliation row exists');
  assert.equal(recon!.matchedTransactionId, null, 'left unmatched (ambiguous) by first pass');

  // Simulate the user's deliberate manual match landing.
  await recon!.update({
    matchedTransactionId: manualTxnId,
    matchedAt: new Date(),
    matchSource: 'manual',
  });

  // Drop the ambiguous credit so the racing auto-run now sees EXACTLY ONE
  // viable candidate (the manual txn) and WANTS to (re)match it as 'auto'.
  // The state-conditional `WHERE matchedTransactionId IS NULL` must refuse,
  // preserving the user's manual match and matchSource.
  await models.Transaction.destroy({ where: { id: ambiguousTxnId } });
  const res = await autoMatchDividends();

  await recon!.reload();
  assert.equal(
    recon!.matchedTransactionId,
    manualTxnId,
    'manual match must survive the auto-run',
  );
  assert.equal(recon!.matchSource, 'manual', 'matchSource must stay manual');
  assert.equal(res.autoMatched, 0, 'no-op update must not count as an auto-match');
});

test('overlapping auto-runs do not abort the pass (issue #844 Bug B)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('race');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'RCE');
  const sec = await seedSecurity(models, hh.household.id, 'RCE', 'Race Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  const payDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 1.0,
    currency: 'USD',
  });
  // A later dividend in the same pass — proves the pass continues past a race.
  const sec2 = await seedSecurity(models, hh.household.id, 'RC2', 'Race2 Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec2.id,
    statementDate: '2026-01-01',
    quantity: 100,
  });
  await seedDividend(models, {
    securityId: sec2.id,
    exDividendDate: new Date(Date.now() - 11 * 86400000).toISOString().slice(0, 10),
    paymentDate: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10),
    amount: 1.0,
    currency: 'USD',
  });

  const { autoMatchDividends } = await import('../../src/portfolio/dividendMatcher.js');
  // First pass creates the reconciliation rows for both dividends.
  await autoMatchDividends();
  const after1 = await models.DividendReconciliation.findAll({ where: { accountId: acct.id } });
  assert.equal(after1.length, 2, `expected 2 rows after first pass, got ${after1.length}`);

  // A second pass re-encounters the existing (dividend, account) pairs. With
  // the OLD `findOne`-then-`create` code, a row that another pass had already
  // inserted would make `.create()` throw SequelizeUniqueConstraintError and
  // abort the whole run. With `findOrCreate` the pass resolves cleanly and
  // re-processes every pair without throwing (issue #844, Bug B).
  await assert.doesNotReject(autoMatchDividends(), 'second pass must not throw a unique violation');

  // Still exactly one row per (dividend, account) for THIS account — no
  // duplicate inserts, and both dividends still have their row (nothing was
  // skipped by an aborted pass).
  const after2 = await models.DividendReconciliation.findAll({ where: { accountId: acct.id } });
  assert.equal(after2.length, 2, `expected 2 rows after second pass, got ${after2.length}`);
  const divIds = new Set(after2.map((r) => r.securityDividendId));
  assert.equal(divIds.size, 2, 'both dividends got a reconciliation row');
});

test('notifyUnmatchedDividends fires once per row after grace window (AC #9)', async () => {
  const { seedAccount, seedSecurity, seedHolding, seedDividend } = await import(
    './portfolioFixtures.js'
  );
  const hh = await makeHousehold('notify');
  const acct = await seedAccount(models, hh.household.id, hh.user.id, 'Brokerage', 'NTF');
  const sec = await seedSecurity(models, hh.household.id, 'NTF', 'Notify Corp', 'stock', 'USD');
  await seedHolding(models, {
    accountId: acct.id,
    householdId: hh.household.id,
    securityId: sec.id,
    statementDate: '2026-01-01',
    quantity: 20,
  });
  // Payment 10 days ago, no transaction → unmatched past the 7-day grace.
  const payDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  await seedDividend(models, {
    securityId: sec.id,
    exDividendDate: new Date(Date.now() - 17 * 86400000).toISOString().slice(0, 10),
    paymentDate: payDate,
    amount: 0.25,
    currency: 'USD',
  });

  const { autoMatchDividends, notifyUnmatchedDividends } = await import(
    '../../src/portfolio/dividendMatcher.js'
  );
  await autoMatchDividends();

  const first = await notifyUnmatchedDividends();
  assert.ok(first.notificationsSent >= 1, JSON.stringify(first));

  // Exactly one dividend.unmatched notification for this user.
  const notifs = await models.Notification.findAll({
    where: { userId: hh.user.id, type: 'dividend.unmatched' },
  });
  assert.equal(notifs.length, 1, `expected one notification, got ${notifs.length}`);

  // Second run is a no-op (dedup).
  const second = await notifyUnmatchedDividends();
  const notifs2 = await models.Notification.findAll({
    where: { userId: hh.user.id, type: 'dividend.unmatched' },
  });
  assert.equal(notifs2.length, 1, 'still exactly one after second run');
  assert.equal(second.notificationsSent, 0, 'second run sends nothing');
});
