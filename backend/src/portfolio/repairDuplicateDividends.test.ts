import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Account, HoldingSnapshot, Household, InvestmentActivity, Security, SecurityDividend, sequelize } from '../models';
import { BackfillAborted } from '../transfers/backfillHalfLinkedCsvTransfers';
import { removeDuplicateDividends, scanDuplicateDividends } from './repairDuplicateDividends';

let HH: number;
let SEC: number;
let seq = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'T' })).id;
  SEC = (await Security.create({
    householdId: HH, symbol: 'VEQT', name: 'VEQT', assetType: 'EQUITY', currency: 'CAD',
  } as never)).id;
});

async function account(name: string, closedAt: string | null = null): Promise<number> {
  return (await Account.create({
    householdId: HH, name, owner: 'me', accountType: 'investment', currency: 'CAD', closedAt,
  } as never)).id;
}

async function holding(accountId: number, statementDate: string, quantity: string) {
  seq += 1;
  await HoldingSnapshot.create({
    accountId, householdId: HH, securityId: SEC, statementDate, quantity,
    price: null, marketValue: null, costBasis: null, unrealizedGainLoss: null, currency: 'CAD',
    sourceReference: 'seed', sourceRowFingerprint: `h${seq}`, importBatch: 'seed',
  } as never);
}

async function event(exDividendDate: string, amount: string) {
  await SecurityDividend.create({
    securityId: SEC, exDividendDate, declarationDate: null, recordDate: null, paymentDate: null,
    amount, currency: 'CAD', source: 'yahoo', fetchedAt: new Date(),
  } as never);
}

async function activity(accountId: number, activityType: string, tradeDate: string, opts: {
  amount?: string; securityId?: number | null; importBatch?: string;
} = {}): Promise<number> {
  seq += 1;
  return (await InvestmentActivity.create({
    accountId, householdId: HH, securityId: opts.securityId === undefined ? SEC : opts.securityId,
    activityType, tradeDate, settlementDate: null, description: activityType, quantity: null, price: null,
    amount: opts.amount ?? null, fees: null, splitRatio: null, currency: 'CAD', sourceReference: 'seed',
    sourceRowFingerprint: `a${seq}`, importBatch: opts.importBatch ?? 'seed',
  } as never)).id;
}

const synthetic = (accountId: number, exDate: string, amount: string) =>
  activity(accountId, 'dividend', exDate, { amount, importBatch: 'alpha_vantage:dividends' });

test('scan pairs synthetic rows with pay-date broker dividends and security-less distributions', async () => {
  const ws = await account('Wealthsimple TFSA');
  const fhsa = await account('Individual FHSA');
  await event('2024-12-30', '0.7166');
  await event('2025-03-26', '0.10');
  await holding(ws, '2024-11-29', '20');
  await holding(fhsa, '2024-11-29', '195');
  await holding(fhsa, '2025-02-28', '195');

  // Broker dividend on the pay date, 8 days after the ex-date.
  const wsRow = await synthetic(ws, '2024-12-30', '14.3320');
  const wsBroker = await activity(ws, 'dividend', '2025-01-07', { amount: '14.33' });
  // Statement import: 'other', no security, 139.10 for the 139.737 expected.
  const fhsaRow = await synthetic(fhsa, '2024-12-30', '139.7370');
  const fhsaBroker = await activity(fhsa, 'other', '2025-01-07', { amount: '139.10', securityId: null });
  // No broker record of the March payout: the synthetic row is the only one.
  const keptRow = await synthetic(fhsa, '2025-03-26', '19.5000');

  const due = await scanDuplicateDividends();
  assert.deepEqual(
    due.map((d) => [d.id, d.broker.id, d.broker.match]),
    [[wsRow, wsBroker, 'dividend'], [fhsaRow, fhsaBroker, 'security_less']],
  );
  assert.ok(!due.some((d) => d.id === keptRow));
});

test('scan leaves phantom rows to the phantom repair and never pairs one broker row twice', async () => {
  const closed = await account('Individual Margin', '2024-12-19');
  const open = await account('TFSA');
  await event('2024-12-30', '0.7166');
  await holding(closed, '2024-11-29', '60');
  await holding(open, '2024-11-29', '60');

  // Closed before the ex-date: phantom, whatever the broker shows.
  await synthetic(closed, '2024-12-30', '42.9960');
  await activity(closed, 'other', '2025-01-07', { amount: '42.99', securityId: null });
  // Two synthetic rows for the same payout, one broker row.
  const first = await synthetic(open, '2024-12-30', '42.9960');
  const second = await activity(open, 'dividend', '2024-12-31', {
    amount: '42.9960', importBatch: 'alpha_vantage:dividends',
  });
  const broker = await activity(open, 'other', '2025-01-07', { amount: '42.99', securityId: null });

  const due = await scanDuplicateDividends();
  assert.deepEqual(due.map((d) => [d.id, d.broker.id]), [[first, broker]]);
  assert.ok(!due.some((d) => d.id === second));
});

test('remove deletes the synthetic rows and retypes the security-less broker row', async () => {
  const ws = await account('Wealthsimple TFSA');
  const fhsa = await account('Individual FHSA');
  await event('2024-12-30', '0.7166');
  await holding(ws, '2024-11-29', '20');
  await holding(fhsa, '2024-11-29', '195');
  await synthetic(ws, '2024-12-30', '14.3320');
  const wsBroker = await activity(ws, 'dividend', '2025-01-07', { amount: '14.33' });
  await synthetic(fhsa, '2024-12-30', '139.7370');
  const fhsaBroker = await activity(fhsa, 'other', '2025-01-07', { amount: '139.10', securityId: null });

  const { removed } = await removeDuplicateDividends({ expect: 2 });
  assert.equal(removed, 2);
  assert.equal(await InvestmentActivity.count({ where: { importBatch: 'alpha_vantage:dividends' } }), 0);
  const retyped = await InvestmentActivity.findByPk(fhsaBroker);
  assert.equal(retyped?.activityType, 'dividend');
  assert.equal(retyped?.securityId, SEC);
  assert.equal(String(retyped?.tradeDate).slice(0, 10), '2025-01-07');
  assert.equal(Number(retyped?.amount), 139.1);
  const untouched = await InvestmentActivity.findByPk(wsBroker);
  assert.equal(untouched?.activityType, 'dividend');
  assert.equal((await scanDuplicateDividends()).length, 0);
});

test('remove aborts and writes nothing on an expect mismatch', async () => {
  const fhsa = await account('Individual FHSA');
  await event('2024-12-30', '0.7166');
  await holding(fhsa, '2024-11-29', '195');
  await synthetic(fhsa, '2024-12-30', '139.7370');
  const broker = await activity(fhsa, 'other', '2025-01-07', { amount: '139.10', securityId: null });

  await assert.rejects(() => removeDuplicateDividends({ expect: 5 }), BackfillAborted);
  assert.equal(await InvestmentActivity.count({ where: { importBatch: 'alpha_vantage:dividends' } }), 1);
  assert.equal((await InvestmentActivity.findByPk(broker))?.activityType, 'other');
});
