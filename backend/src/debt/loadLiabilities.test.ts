/**
 * Unit tests for the shared liability loader + its CAD summarisation.
 *
 * DB-backed (balanceAtDate reads the transaction stream) against the
 * per-process SQLite test DB. FX is dependency-injected so conversion is
 * deterministic without a live Bank of Canada fetch.
 */
import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { FxLookup } from '../networth/unifyToCad';

process.env.DATABASE_PATH = ':memory:';

let models: typeof import('../models');
let mod: typeof import('./loadLiabilities');
let household: { id: number };

// Stub FX: USD→CAD = 1.4, everything else unknown.
const stubFx: FxLookup = async (from, to, asOf) => {
  if (from === to) return { rate: 1, ratedDate: asOf };
  if (from === 'USD' && to === 'CAD') return { rate: 1.4, ratedDate: asOf };
  return null;
};

const AS_OF = '2026-02-01';

before(async () => {
  models = await import('../models');
  await models.sequelize.sync({ force: true });
  mod = await import('./loadLiabilities');
});

after(async () => {
  await models.sequelize.close();
});

beforeEach(async () => {
  await models.LiabilityAccount.destroy({ where: {}, truncate: true });
  await models.Transaction.destroy({ where: {}, truncate: true });
  await models.Account.destroy({ where: {}, truncate: true });
  await models.Household.destroy({ where: {}, truncate: true });
  household = await models.Household.create({ name: 'Debt Test HH' });
});

async function seedAccount(opts: {
  name: string;
  accountType: string;
  defaultCurrency: string;
  closedAt?: string | null;
}) {
  return models.Account.create({
    householdId: household.id,
    owner: 'me',
    visibility: 'shared',
    name: opts.name,
    accountType: opts.accountType,
    defaultCurrency: opts.defaultCurrency,
    shortCode: opts.name.slice(0, 3).toUpperCase(),
    closedAt: opts.closedAt ?? null,
  } as never);
}

async function seedTxn(accountId: number, amount: number, currency: string, date = '2026-01-10') {
  await models.Transaction.create({
    accountId,
    householdId: household.id,
    visibility: 'shared',
    ownershipType: 'me',
    importBatch: 'debt-test',
    date,
    merchantRaw: 'Test',
    merchantClean: 'Test',
    amount: amount.toFixed(4),
    currency,
    txnType: 'purchase',
    sourceRowFingerprint: crypto.randomBytes(16).toString('hex'),
    sourceIdentityFingerprint: crypto.randomBytes(16).toString('hex'),
  } as never);
}

async function seedProfile(accountId: number, minimumPayment: number, interestRate = 20) {
  await models.LiabilityAccount.create({
    accountId,
    householdId: household.id,
    interestRate: interestRate.toFixed(4),
    minimumPayment: minimumPayment.toFixed(4),
    statementBalance: null,
    dueDay: null,
  } as never);
}

test('owedBalance: a foreign-currency leg on a CAD card is FX-converted, not dropped', async () => {
  const card = await seedAccount({ name: 'Visa', accountType: 'credit_card', defaultCurrency: 'CAD' });
  await seedTxn(card.id, -300, 'CAD');
  await seedTxn(card.id, -100, 'USD');
  // Pre-fix: find(defCcy) ?? balances[0] only looked at the CAD bucket → 300.
  const owed = await mod.owedBalance(card, null, AS_OF, stubFx);
  assert.equal(owed.balance, 440);
  assert.equal(owed.balanceSource, 'live');
});

// ---- statement vs live balance ------------------------------------------

test('chooseBalanceSource: no statement balance → live', () => {
  assert.equal(mod.chooseBalanceSource(false, '2026-01-31', '2026-01-10'), 'live');
});

test('chooseBalanceSource: statement on/after the last transaction → statement', () => {
  assert.equal(mod.chooseBalanceSource(true, '2026-01-31', '2026-01-10'), 'statement');
  assert.equal(mod.chooseBalanceSource(true, '2026-01-10', '2026-01-10'), 'statement');
});

test('chooseBalanceSource: transactions imported after the statement → live', () => {
  assert.equal(mod.chooseBalanceSource(true, '2026-01-10', '2026-01-11'), 'live');
});

test('chooseBalanceSource: no transactions → statement', () => {
  assert.equal(mod.chooseBalanceSource(true, '2026-01-10', null), 'statement');
});

async function seedStatementProfile(
  accountId: number,
  statementBalance: number,
  statementDate: string | null,
) {
  await models.LiabilityAccount.create({
    accountId,
    householdId: household.id,
    interestRate: '20.0000',
    minimumPayment: '25.0000',
    statementBalance: statementBalance.toFixed(4),
    statementDate,
    dueDay: null,
  } as never);
}

test('loadLiabilities: a statement newer than the last import is used', async () => {
  const card = await seedAccount({ name: 'Visa', accountType: 'credit_card', defaultCurrency: 'CAD' });
  await seedTxn(card.id, -300, 'CAD', '2026-01-10');
  await seedStatementProfile(card.id, 500, '2026-01-15');
  const [row] = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  assert.equal(row.balance, 500);
  assert.equal(row.balanceSource, 'statement');
});

test('loadLiabilities: a statement older than the last import falls back to the live balance', async () => {
  const card = await seedAccount({ name: 'Visa', accountType: 'credit_card', defaultCurrency: 'CAD' });
  await seedTxn(card.id, -300, 'CAD', '2026-01-10');
  await seedTxn(card.id, -900, 'CAD', '2026-01-25');
  await seedStatementProfile(card.id, 300, '2026-01-12');
  const [row] = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  assert.equal(row.balance, 1200);
  assert.equal(row.balanceSource, 'live');
  assert.equal(row.balanceCad, 1200);
  // The stale statement figure is still reported as-is for display.
  assert.equal(row.statementBalance, 300);
});

test('loadLiabilities: transactions after asOf do not make the statement stale', async () => {
  const card = await seedAccount({ name: 'Visa', accountType: 'credit_card', defaultCurrency: 'CAD' });
  await seedTxn(card.id, -300, 'CAD', '2026-01-10');
  await seedTxn(card.id, -900, 'CAD', '2026-03-01'); // after AS_OF
  await seedStatementProfile(card.id, 450, '2026-01-15');
  const [row] = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  assert.equal(row.balance, 450);
  assert.equal(row.balanceSource, 'statement');
});

test('loadLiabilities: a manual statement balance with no statement date is dated by when it was saved', async () => {
  const card = await seedAccount({ name: 'Visa', accountType: 'credit_card', defaultCurrency: 'CAD' });
  await seedTxn(card.id, -300, 'CAD', '2026-01-10');
  // Saved "now" (well after the 2026-01-10 import) via the Debt page, which
  // never sets statementDate.
  await seedStatementProfile(card.id, 650, null);
  const today = new Date().toISOString().slice(0, 10);
  const [row] = await mod.loadLiabilities(household.id, today, stubFx);
  assert.equal(row.balance, 650);
  assert.equal(row.balanceSource, 'statement');
});

test('loadLiabilities: closed accounts are excluded', async () => {
  const open = await seedAccount({ name: 'Open', accountType: 'loan', defaultCurrency: 'CAD' });
  const closed = await seedAccount({
    name: 'Closed',
    accountType: 'credit_card',
    defaultCurrency: 'CAD',
    closedAt: '2026-01-20',
  });
  await seedTxn(open.id, -1000, 'CAD');
  await seedTxn(closed.id, -50, 'CAD');
  // A stale statement override on the closed card must not resurrect it.
  await models.LiabilityAccount.create({
    accountId: closed.id,
    householdId: household.id,
    interestRate: '0',
    minimumPayment: '25',
    statementBalance: '50',
    dueDay: null,
  } as never);

  const rows = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  assert.deepEqual(rows.map((r) => r.name), ['Open']);
});

test('loadLiabilities: an account closing after asOf is still included', async () => {
  const acct = await seedAccount({
    name: 'Closing',
    accountType: 'loan',
    defaultCurrency: 'CAD',
    closedAt: '2026-06-01',
  });
  await seedTxn(acct.id, -1000, 'CAD');
  const rows = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  assert.deepEqual(rows.map((r) => r.name), ['Closing']);
});

test('loadLiabilities: rows carry CAD-converted balance + minimum payment', async () => {
  const usdCard = await seedAccount({ name: 'USD Card', accountType: 'credit_card', defaultCurrency: 'USD' });
  await seedTxn(usdCard.id, -2000, 'USD');
  await seedProfile(usdCard.id, 60);

  const [row] = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  assert.equal(row.currency, 'USD');
  assert.equal(row.balance, 2000);
  assert.equal(row.balanceCad, 2800);
  assert.equal(row.minimumPaymentCad, 84);
});

test('summarizeLiabilities: USD 2,000 card + CAD 10,000 loan totals in CAD, not "CA$12,000"', async () => {
  const usdCard = await seedAccount({ name: 'USD Card', accountType: 'credit_card', defaultCurrency: 'USD' });
  const loan = await seedAccount({ name: 'Loan', accountType: 'loan', defaultCurrency: 'CAD' });
  await seedTxn(usdCard.id, -2000, 'USD');
  await seedTxn(loan.id, -10000, 'CAD');
  await seedProfile(usdCard.id, 50);
  await seedProfile(loan.id, 200, 6);

  const rows = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  const summary = mod.summarizeLiabilities(rows);
  assert.equal(summary.currency, 'CAD');
  assert.equal(summary.totalOwed, 12800);
  assert.equal(summary.totalMinimumPayment, 270);
  assert.deepEqual(summary.unconvertedCurrencies, []);
});

test('summarizeLiabilities: a currency with no FX rate is excluded from the CAD total and flagged', async () => {
  const eurLoan = await seedAccount({ name: 'EUR Loan', accountType: 'loan', defaultCurrency: 'EUR' });
  const loan = await seedAccount({ name: 'Loan', accountType: 'loan', defaultCurrency: 'CAD' });
  await seedTxn(eurLoan.id, -500, 'EUR');
  await seedTxn(loan.id, -1000, 'CAD');

  const rows = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  const eurRow = rows.find((r) => r.currency === 'EUR');
  assert.equal(eurRow?.balanceCad, null);
  const summary = mod.summarizeLiabilities(rows);
  assert.equal(summary.totalOwed, 1000);
  assert.deepEqual(summary.unconvertedCurrencies, ['EUR']);
});

test('toCadDebtInputs: the payoff engine sees CAD amounts, never mixed currencies', async () => {
  const usdCard = await seedAccount({ name: 'USD Card', accountType: 'credit_card', defaultCurrency: 'USD' });
  const loan = await seedAccount({ name: 'Loan', accountType: 'loan', defaultCurrency: 'CAD' });
  const eurLoan = await seedAccount({ name: 'EUR Loan', accountType: 'loan', defaultCurrency: 'EUR' });
  await seedTxn(usdCard.id, -2000, 'USD');
  await seedTxn(loan.id, -10000, 'CAD');
  await seedTxn(eurLoan.id, -500, 'EUR');
  await seedProfile(usdCard.id, 50);

  const rows = await mod.loadLiabilities(household.id, AS_OF, stubFx);
  const inputs = mod.toCadDebtInputs(rows);
  const byName = new Map(inputs.map((d) => [d.name, d]));
  assert.equal(byName.get('USD Card')?.balance, 2800);
  assert.equal(byName.get('USD Card')?.minimumPayment, 70);
  assert.equal(byName.get('Loan')?.balance, 10000);
  // No FX → cannot be ordered against CAD debts; left out rather than mixed in.
  assert.equal(byName.has('EUR Loan'), false);
  // Native inputs (surplus hub scopes by currency itself) stay native.
  const native = mod.toDebtInputs(rows.filter((r) => r.currency === 'USD'));
  assert.equal(native[0].balance, 2000);
});
