import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Account, HoldingSnapshot, Household, InvestmentActivity, Security, sequelize } from '../models';
import { BackfillAborted } from '../transfers/backfillHalfLinkedCsvTransfers';
import { deletePhantomDividends, scanPhantomDividends } from './repairPhantomDividends';

let HH: number;
let SEC: number;
let seq = 0;

beforeEach(async () => {
  await sequelize.sync({ force: true });
  HH = (await Household.create({ name: 'T' })).id;
  SEC = (await Security.create({
    householdId: HH, symbol: 'XEQT', name: 'XEQT', assetType: 'EQUITY', currency: 'CAD',
  } as never)).id;
});

async function account(name: string, closedAt: string | null = null): Promise<number> {
  return (await Account.create({
    householdId: HH, name, owner: 'me', accountType: 'investment', currency: 'CAD', closedAt,
  } as never)).id;
}

async function holding(accountId: number, statementDate: string, quantity: string, securityId = SEC) {
  seq += 1;
  await HoldingSnapshot.create({
    accountId, householdId: HH, securityId, statementDate, quantity,
    price: null, marketValue: null, costBasis: null, unrealizedGainLoss: null, currency: 'CAD',
    sourceReference: 'seed', sourceRowFingerprint: `h${seq}`, importBatch: 'seed',
  } as never);
}

async function activity(accountId: number, activityType: string, tradeDate: string, opts: {
  quantity?: string; amount?: string; importBatch?: string;
} = {}): Promise<number> {
  seq += 1;
  return (await InvestmentActivity.create({
    accountId, householdId: HH, securityId: SEC, activityType, tradeDate, settlementDate: null,
    description: activityType, quantity: opts.quantity ?? null, price: null, amount: opts.amount ?? null,
    fees: null, splitRatio: null, currency: 'CAD', sourceReference: 'seed', sourceRowFingerprint: `a${seq}`,
    importBatch: opts.importBatch ?? 'seed',
  } as never)).id;
}

const synthetic = (accountId: number, exDate: string, amount: string) =>
  activity(accountId, 'dividend', exDate, { amount, importBatch: 'alpha_vantage:dividends' });

test('scan flags closed-account and sold-out synthetic rows, keeps held and broker rows', async () => {
  const closed = await account('Individual Margin', '2024-12-19');
  const sold = await account('Individual FHSA');
  const open = await account('TFSA');

  await holding(closed, '2024-11-29', '8');
  const closedRow = await synthetic(closed, '2025-03-26', '0.7265');
  const preCloseRow = await synthetic(closed, '2024-12-02', '0.70');

  await holding(sold, '2025-07-31', '117');
  await activity(sold, 'sell', '2025-08-14', { quantity: '117' });
  const soldRow = await synthetic(sold, '2025-09-24', '11.8062');
  const brokerRow = await activity(sold, 'dividend', '2025-09-30', { amount: '11.80' });

  await holding(open, '2025-08-29', '77');
  const heldRow = await synthetic(open, '2025-09-24', '7.77');

  const due = await scanPhantomDividends();
  assert.deepEqual(
    due.map((d) => [d.id, d.reason]),
    [[closedRow, 'closed_account'], [soldRow, 'sold_before_ex_date']],
  );
  const flagged = new Set(due.map((d) => d.id));
  for (const kept of [preCloseRow, brokerRow, heldRow]) assert.ok(!flagged.has(kept));
});

test('delete removes exactly the planned rows and leaves the rest', async () => {
  const closed = await account('Individual Margin', '2024-12-19');
  const open = await account('TFSA');
  await holding(closed, '2024-11-29', '8');
  await holding(open, '2025-08-29', '77');
  await synthetic(closed, '2025-03-26', '0.7265');
  await synthetic(closed, '2025-06-25', '2.1554');
  const heldRow = await synthetic(open, '2025-09-24', '7.77');

  const { deleted } = await deletePhantomDividends({ expect: 2 });
  assert.equal(deleted, 2);
  const left = await InvestmentActivity.findAll({ where: { importBatch: 'alpha_vantage:dividends' } });
  assert.deepEqual(left.map((r) => r.id), [heldRow]);
  assert.equal((await scanPhantomDividends()).length, 0);
});

test('delete aborts and writes nothing on an expect mismatch', async () => {
  const closed = await account('Individual Margin', '2024-12-19');
  await holding(closed, '2024-11-29', '8');
  await synthetic(closed, '2025-03-26', '0.7265');

  await assert.rejects(() => deletePhantomDividends({ expect: 5 }), BackfillAborted);
  assert.equal(await InvestmentActivity.count({ where: { importBatch: 'alpha_vantage:dividends' } }), 1);
});
