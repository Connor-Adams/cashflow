import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseActivitiesExportRow,
  isActivitiesExportHeaders,
  isAsOfFooterRow,
  type WsActivitiesExportRow,
} from '../src/import/wealthsimpleActivitiesExportParse';

function row(p: Partial<WsActivitiesExportRow>): WsActivitiesExportRow {
  return {
    transaction_date: '',
    settlement_date: '',
    account_id: '',
    account_type: '',
    activity_type: '',
    activity_sub_type: '',
    direction: '',
    symbol: '',
    name: '',
    currency: 'CAD',
    quantity: '',
    unit_price: '',
    commission: '',
    net_cash_amount: '',
    ...p,
  };
}

test('Trade/BUY: maps to buy, fields populated', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-27',
      settlement_date: '2026-04-27',
      account_id: 'HQ6LMLTK8CAD',
      account_type: 'TFSA',
      activity_type: 'Trade',
      activity_sub_type: 'BUY',
      direction: 'LONG',
      symbol: 'DOO',
      name: 'BRP Inc',
      currency: 'CAD',
      quantity: '0.0032',
      unit_price: '77.31',
      commission: '0',
      net_cash_amount: '-0.25',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.accountShortCode, 'HQ6LMLTK8CAD');
  assert.equal(r.activity.activityType, 'buy');
  assert.equal(r.activity.tradeDate, '2026-04-27');
  assert.equal(r.activity.settlementDate, '2026-04-27');
  assert.equal(r.activity.security?.symbol, 'DOO');
  assert.equal(r.activity.security?.name, 'BRP Inc');
  assert.equal(r.activity.quantity, 0.0032);
  assert.equal(r.activity.price, 77.31);
  assert.equal(r.activity.fees, 0);
  assert.equal(r.activity.amount, -0.25);
  assert.equal(r.activity.currency, 'CAD');
});

test('Trade/SELL: maps to sell, quantity absolute (CSV signs SELL qty negative; DB stores positive)', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2026-01-02',
      settlement_date: '2026-01-02',
      account_id: 'HQ6LMLTK8CAD',
      account_type: 'TFSA',
      activity_type: 'Trade',
      activity_sub_type: 'SELL',
      symbol: 'XEQT',
      name: 'iShares Core Equity ETF Portfolio',
      currency: 'CAD',
      quantity: '-187.4063',
      unit_price: '40.02',
      net_cash_amount: '7500.51',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.activityType, 'sell');
  assert.equal(r.activity.quantity, 187.4063, 'SELL qty must be absolute');
  assert.equal(r.activity.amount, 7500.51);
});

test('Dividend: maps to dividend, quantity nulled (CSV qty duplicates amount, DB stores NULL)', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-24',
      account_id: 'HQ6LMLTK8CAD',
      account_type: 'TFSA',
      activity_type: 'Dividend',
      symbol: 'DOO',
      name: 'BRP Inc',
      currency: 'CAD',
      quantity: '0.25',
      net_cash_amount: '0.25',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.activityType, 'dividend');
  assert.equal(r.activity.tradeDate, '2026-04-24');
  assert.equal(r.activity.settlementDate, null);
  assert.equal(r.activity.amount, 0.25);
  assert.equal(r.activity.quantity, null, 'dividend qty must be NULL for cross-source dedup');
});

test('Interest: quantity nulled', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2025-08-01',
      account_id: 'WK56TFH01CAD',
      activity_type: 'Interest',
      currency: 'CAD',
      quantity: '2.04',
      net_cash_amount: '2.04',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.quantity, null);
});

test('Fee: quantity nulled', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2025-09-06',
      account_id: 'HQ4TLFJ02CAD',
      activity_type: 'Fee',
      currency: 'CAD',
      quantity: '-10',
      net_cash_amount: '-10',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.quantity, null);
});

test('CryptoStakingReward: quantity PRESERVED (real coin count, not duplicate of amount)', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-07',
      activity_type: 'CryptoStakingReward',
      symbol: 'DOT',
      currency: 'USD',
      quantity: '0.0005009278',
      net_cash_amount: '0.0006621155',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.quantity, 0.0005009278);
});

test('CryptoStakingReward: maps to staking_reward (NOT dropped)', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-07',
      account_id: 'HQ6R28910CAD',
      account_type: 'Crypto',
      activity_type: 'CryptoStakingReward',
      direction: 'LONG',
      symbol: 'DOT',
      name: 'Polkadot',
      currency: 'USD',
      quantity: '0.0005009278',
      unit_price: '1.3217782139',
      net_cash_amount: '0.0006621155',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.activityType, 'staking_reward');
  assert.equal(r.activity.security?.symbol, 'DOT');
  assert.equal(r.activity.security?.assetType, 'cryptocurrency');
  assert.equal(r.activity.currency, 'USD');
  assert.equal(r.activity.quantity, 0.0005009278);
});

test('Interest on TFSA: maps to interest, no symbol', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2025-08-01',
      account_id: 'HQ6LMLTK8CAD',
      account_type: 'TFSA',
      activity_type: 'Interest',
      currency: 'CAD',
      quantity: '2.04',
      net_cash_amount: '2.04',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.activityType, 'interest');
  assert.equal(r.activity.security, null);
  assert.equal(r.activity.amount, 2.04);
});

test('Interest on Chequing: skipped (cash-side handled by cash statement parser)', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2024-09-01',
      account_id: 'WK3DD9X35CAD',
      account_type: 'Chequing',
      activity_type: 'Interest',
      currency: 'CAD',
      quantity: '6.27',
      net_cash_amount: '6.27',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'skip');
  if (r.kind !== 'skip') return;
  assert.match(r.reason, /cash account/);
});

test('Interest on Save for Business: skipped', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2025-08-01',
      account_id: 'WK56TFH01CAD',
      account_type: 'Save for Business',
      activity_type: 'Interest',
      currency: 'CAD',
      quantity: '2.04',
      net_cash_amount: '2.04',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'skip');
});

test('Fee: maps to fee', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2025-09-06',
      account_id: 'HQ4TLFJ02CAD',
      account_type: 'Non-registered margin',
      activity_type: 'Fee',
      currency: 'CAD',
      quantity: '-10',
      net_cash_amount: '-10',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.activityType, 'fee');
  assert.equal(r.activity.amount, -10);
});

test('SecurityTransfer: maps to transfer', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2025-06-26',
      account_id: 'HQ6R28910CAD',
      account_type: 'Crypto',
      activity_type: 'SecurityTransfer',
      symbol: 'BTC',
      name: 'Bitcoin',
      currency: 'USD',
      quantity: '0.00022274',
      net_cash_amount: '23.8358907458',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.activityType, 'transfer');
  assert.equal(r.activity.security?.symbol, 'BTC');
});

test('Correction/ANOMALY: maps to other', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2024-10-03',
      account_id: 'HQ6R28910CAD',
      account_type: 'Crypto',
      activity_type: 'Correction',
      activity_sub_type: 'ANOMALY',
      symbol: 'ETH',
      name: 'Ethereum',
      currency: '',
      quantity: '-0.029102',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'investment');
  if (r.kind !== 'investment') return;
  assert.equal(r.activity.activityType, 'other');
  assert.equal(r.activity.currency, 'CAD'); // empty falls back to default
});

test('MoneyMovement on Corporate investing: skipped at activity-type level', () => {
  // Corp Investing is NOT a cash account so the account-type gate does NOT
  // fire. The activity-type classifier returns null for MoneyMovement
  // because these flow into the Transaction table via the monthly invest
  // statement (P2P/AFT/CONT TX codes), not InvestmentActivity.
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-24',
      account_id: 'HQ8H0GZ07CAD',
      account_type: 'Corporate investing',
      activity_type: 'MoneyMovement',
      activity_sub_type: 'TRANSFER',
      currency: 'CAD',
      quantity: '-4000',
      net_cash_amount: '-4000',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'skip');
  if (r.kind !== 'skip') return;
  assert.match(r.reason, /cash-side/);
});

test('Any row on Chequing account: skipped at account-type level', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-24',
      account_id: 'WK3DD9X35CAD',
      account_type: 'Chequing',
      activity_type: 'MoneyMovement',
      activity_sub_type: 'P2P',
      currency: 'CAD',
      quantity: '-2500',
      net_cash_amount: '-2500',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'skip');
  if (r.kind !== 'skip') return;
  assert.match(r.reason, /cash account/);
});

test('BonusPayment: skipped', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: '2024-12-19',
      account_id: 'WK3DD9X35CAD',
      account_type: 'Chequing',
      activity_type: 'BonusPayment',
      activity_sub_type: 'CASHBACK',
      currency: 'CAD',
      quantity: '0.08',
      net_cash_amount: '0.08',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'skip');
});

test('Invalid date: skipped with reason', () => {
  const r = parseActivitiesExportRow(
    row({
      transaction_date: 'not-a-date',
      account_id: 'X',
      activity_type: 'Dividend',
    }),
    'CAD',
  );
  assert.equal(r.kind, 'skip');
  if (r.kind !== 'skip') return;
  assert.match(r.reason, /Invalid transaction_date/);
});

test('isActivitiesExportHeaders detects 14-col layout', () => {
  assert.equal(
    isActivitiesExportHeaders([
      'transaction_date',
      'settlement_date',
      'account_id',
      'account_type',
      'activity_type',
      'activity_sub_type',
      'direction',
      'symbol',
      'name',
      'currency',
      'quantity',
      'unit_price',
      'commission',
      'net_cash_amount',
    ]),
    true,
  );
  // Monthly statement headers — different layout, should not match
  assert.equal(
    isActivitiesExportHeaders([
      'date',
      'transaction',
      'description',
      'amount',
      'balance',
      'currency',
    ]),
    false,
  );
});

test('isAsOfFooterRow detects trailing footer', () => {
  assert.equal(
    isAsOfFooterRow(row({ transaction_date: 'As of 2026-05-25 14:38 GMT-04:00' })),
    true,
  );
  assert.equal(
    isAsOfFooterRow(row({ transaction_date: '"As of 2026-05-25"' })),
    true,
  );
  assert.equal(
    isAsOfFooterRow(row({ transaction_date: '2026-05-24' })),
    false,
  );
});

test('Fingerprint is stable for identical input', () => {
  const a = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-27',
      account_id: 'X',
      activity_type: 'Trade',
      activity_sub_type: 'BUY',
      symbol: 'DOO',
      currency: 'CAD',
      quantity: '0.0032',
      net_cash_amount: '-0.25',
    }),
    'CAD',
  );
  const b = parseActivitiesExportRow(
    row({
      transaction_date: '2026-04-27',
      account_id: 'X',
      activity_type: 'Trade',
      activity_sub_type: 'BUY',
      symbol: 'DOO',
      currency: 'CAD',
      quantity: '0.0032',
      net_cash_amount: '-0.25',
    }),
    'CAD',
  );
  assert.equal(a.kind, 'investment');
  assert.equal(b.kind, 'investment');
  if (a.kind !== 'investment' || b.kind !== 'investment') return;
  assert.equal(
    a.activity.sourceRowFingerprint,
    b.activity.sourceRowFingerprint,
  );
});
