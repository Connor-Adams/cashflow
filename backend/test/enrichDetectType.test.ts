import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDetectTypeStage } from '../src/import/enrichment/detectTypeStage';

test('refund: narrative says refund + positive amount', () => {
  const signals = runDetectTypeStage({
    merchantRaw: 'AMAZON.COM REFUND',
    merchantClean: 'AMAZON.COM REFUND',
    amount: 42.0,
  });
  assert.equal(signals[0].fields.txnType, 'refund');
  assert.equal(signals[0].confidence, 'high');
});

test('transfer: narrative says transfer + opposite signs handled', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'TRANSFER TO CHEQUING',
    merchantClean: 'TRANSFER TO CHEQUING',
    amount: -500,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('payment: narrative says online payment + positive', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ONLINE PAYMENT THANK YOU',
    merchantClean: 'ONLINE PAYMENT THANK YOU',
    amount: 1200,
  });
  assert.equal(out[0].fields.txnType, 'payment');
});

test('fee: narrative says annual fee', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ANNUAL FEE',
    merchantClean: 'ANNUAL FEE',
    amount: -120,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('interest: interest charge narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'INTEREST CHARGE ON PURCHASES',
    merchantClean: 'INTEREST CHARGE ON PURCHASES',
    amount: -15.5,
  });
  assert.equal(out[0].fields.txnType, 'interest');
});

test('reward: cash back / reward narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'CASH BACK REWARD',
    merchantClean: 'CASH BACK REWARD',
    amount: 25,
  });
  assert.equal(out[0].fields.txnType, 'reward');
});

test('purchase: default when nothing else matches and negative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'STARBUCKS',
    merchantClean: 'STARBUCKS',
    amount: -6.5,
  });
  assert.equal(out[0].fields.txnType, 'purchase');
  assert.equal(out[0].confidence, 'medium');
});

test('unknown: positive amount with no narrative cue', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'JOE COFFEE',
    merchantClean: 'JOE COFFEE',
    amount: 100,
  });
  assert.equal(out[0].fields.txnType, 'unknown');
});

// === Wealthsimple narrative patterns ===
// These were added when the bundle importer started routing the same
// descriptions through the regular /upload path. Each test guards against
// regression to the pre-PR-#59 behavior where every negative-amount WS row
// defaulted to 'purchase' and bloated the dashboard totalSpend metric.

test('transfer: pre-authorized debit (AFT_OUT narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Pre-authorized Debit to AMEX BILL PYMT',
    merchantClean: 'Pre-authorized Debit to AMEX BILL PYMT',
    amount: -2959.34,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: pre-authorized credit', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Pre-authorized Credit from EMPLOYER',
    merchantClean: 'Pre-authorized Credit from EMPLOYER',
    amount: 5000,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: cash sent (P2P_SENT narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Cash sent',
    merchantClean: 'Cash sent',
    amount: -2500,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: cash received (P2P_RECEIVED narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Cash received',
    merchantClean: 'Cash received',
    amount: 100,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('income: direct deposit from a non-member payer (ADAMS GREENE, shares surname only)', () => {
  // Was historically 'transfer' (AFT_IN); reclassified to 'income' 2026-06-01.
  // "ADAMS GREENE" shares the "ADAMS" surname with member "Connor Adams" but is
  // not a full member-name match, so it is external income — not a self
  // transfer. Prod merchant_raw is truncated at 35 chars (no usable corp
  // marker), so the discriminator is household-member own-name exclusion.
  const out = runDetectTypeStage({
    merchantRaw: 'Direct deposit from ADAMS GREENE HO',
    merchantClean: 'Direct deposit from ADAMS GREENE HO',
    amount: 207.4,
    ownerNames: ['Connor Adams', 'LingLing'],
  });
  assert.equal(out[0].fields.txnType, 'income');
});

test('fee: subscription fee paid for period', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Subscription fee paid for period 2025-01-01 to 2025-01-31',
    merchantClean: 'Subscription fee paid for period 2025-01-01 to 2025-01-31',
    amount: -10,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('fee: staking reward fee', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Fee paid on DOT-Polkadot staking reward fee',
    merchantClean: 'Fee paid on DOT-Polkadot staking reward fee',
    amount: -0.05,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('investment: bought N shares (BUY narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Bought 0.0666 shares (executed at 2025-04-04)',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: Bought 0.0666 shares (executed at 2025-04-04)',
    amount: -2500,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

test('investment: sold N shares (SELL narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: Sold 187.4063 shares at $40.02 per share (executed at 2025-12-31)',
    amount: 7500.51,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

test('dividend: cash dividend distribution (DIV narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2026-01-05',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: Cash dividend distribution, received on 2026-01-05',
    amount: 146.47,
  });
  assert.equal(out[0].fields.txnType, 'dividend');
});

test('interest: stock lending monthly interest', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Stock lending monthly interest payment',
    merchantClean: 'Stock lending monthly interest payment',
    amount: 0.01,
  });
  assert.equal(out[0].fields.txnType, 'interest');
});

// === Bug-driven additions from 2026-05-23 prod audit ===
// 506 of 1391 prod txns landed as 'unknown'. These tests cover the patterns
// that were missing (crypto staking rewards/fees, stock-lending loan
// termination, WS chequing transfers) plus the dividend sign bug where
// negative-amount cash dividends fell through to 'purchase'.

test('reward: crypto staking rewards earned (negative-amount WS narrative)', () => {
  const out = runDetectTypeStage({
    merchantRaw: '0.0015954570 of DOT rewards earned',
    merchantClean: '0.0015954570 of DOT rewards earned',
    amount: -0.012,
  });
  assert.equal(out[0].fields.txnType, 'reward');
});

test('reward: ETH rewards earned', () => {
  const out = runDetectTypeStage({
    merchantRaw: '0.0000214112 of ETH rewards earned',
    merchantClean: '0.0000214112 of ETH rewards earned',
    amount: -0.08,
  });
  assert.equal(out[0].fields.txnType, 'reward');
});

test('fee: staking reward fee without trailing "fee" (Fee paid on X staking reward:)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Fee paid on DOT-Polkadot staking reward: 0.0005020227',
    merchantClean: 'Fee paid on DOT-Polkadot staking reward: 0.0005020227',
    amount: -0.004,
  });
  assert.equal(out[0].fields.txnType, 'fee');
});

test('investment: stock-lending loan terminated', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'DOO - BRP Inc: Loan of 3.0000 shares terminated (executed at 2025-10-10)',
    merchantClean: 'DOO - BRP Inc: Loan of 3.0000 shares terminated (executed at 2025-10-10)',
    amount: 0,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

test('investment: stock-lending loan created (counterpart of terminated)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: Loan of 2.0000 shares created (executed at 2026-01-21)',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: Loan of 2.0000 shares created (executed at 2026-01-21)',
    amount: 0,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

test('transfer: WS chequing "From chequing account"', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'From chequing account',
    merchantClean: 'From chequing account',
    amount: 500,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: bare "Deposit" narrative + positive amount', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Deposit',
    merchantClean: 'Deposit',
    amount: 200,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('dividend: negative-amount cash dividend distribution (WS sign bug)', () => {
  // Regression for 2026-05-23 finding: ~20 VFV/XEQT/DOO "Cash dividend
  // distribution" rows imported with negative amount fell through to
  // 'purchase' because the rule required positive sign. The literal phrase
  // is unambiguous; sign should not gate it.
  const out = runDetectTypeStage({
    merchantRaw: 'VFV - Vanguard S&P 500 Index ETF: Cash dividend distribution, received on 2025-10-07',
    merchantClean: 'VFV - Vanguard S&P 500 Index ETF: Cash dividend distribution, received on 2025-10-07',
    amount: -42.17,
  });
  assert.equal(out[0].fields.txnType, 'dividend');
});

test('investment: WS active "Shares on loan" state record', () => {
  // Distinct from "Loan of X shares terminated/created" — this is the
  // ongoing-state ledger entry while shares are out on loan.
  const out = runDetectTypeStage({
    merchantRaw: 'XEQT - iShares Core Equity ETF Portfolio: 2.0000 Shares on loan (executed at 2025-09-10)',
    merchantClean: 'XEQT - iShares Core Equity ETF Portfolio: 2.0000 Shares on loan (executed at 2025-09-10)',
    amount: 0,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

test('investment: WS "Staked X of TOKEN" crypto staking initiation', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Staked 0.0544286100 of ETH-Ethereum',
    merchantClean: 'Staked 0.0544286100 of ETH-Ethereum',
    amount: 0,
  });
  assert.equal(out[0].fields.txnType, 'investment');
});

// === Income detection (2026-06-01) ===
// Employer payroll / external direct deposits must classify as 'income', not
// 'transfer'. The hard part: prod merchant_raw is truncated at 35 chars, so
// "Direct deposit from ADAMS GREENE HO" (income) and "Direct deposit from ADAMS
// CONNOR DO" (a self-deposit from the account owner's own name) are both
// marker-less name strings. The discriminator is own-name exclusion against the
// household members' names — money via the direct-deposit/payroll rail from
// someone who is NOT you is income; from your own name it is a self transfer.

const HH_MEMBERS = ['Connor Adams', 'LingLing'];

test('income: direct deposit from an external company (CDG LABS INC)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Direct deposit from CDG LABS INC',
    merchantClean: 'Direct deposit from CDG LABS INC',
    amount: 10726.4,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'income');
  assert.equal(out[0].confidence, 'high');
});

test('transfer: direct deposit from the account owner\'s own name is a self-deposit, not income', () => {
  // "ADAMS CONNOR" is member "Connor Adams" surname-first — a full member-name
  // match — so it stays a transfer even though it rides the direct-deposit rail.
  const out = runDetectTypeStage({
    merchantRaw: 'Direct deposit from ADAMS CONNOR DO',
    merchantClean: 'Direct deposit from ADAMS CONNOR DO',
    amount: 3977.31,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('income: explicit payroll narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'PAYROLL DEPOSIT',
    merchantClean: 'PAYROLL DEPOSIT',
    amount: 3200,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'income');
});

test('income: explicit salary narrative', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'ACME CORP SALARY',
    merchantClean: 'ACME CORP SALARY',
    amount: 4100,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'income');
});

test('income: direct deposit is income even without owner names (default external)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Direct deposit from CDG LABS INC',
    merchantClean: 'Direct deposit from CDG LABS INC',
    amount: 10726.4,
  });
  assert.equal(out[0].fields.txnType, 'income');
});

test('transfer: negative-amount direct deposit is not income (positive-only guard)', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Direct deposit from CDG LABS INC',
    merchantClean: 'Direct deposit from CDG LABS INC',
    amount: -10726.4,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: direct deposit from an own-account word stays transfer', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Direct deposit from chequing account',
    merchantClean: 'Direct deposit from chequing account',
    amount: 500,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('transfer: Interac e-Transfer Received is a transfer, not income', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Interac e-Transfer® Received',
    merchantClean: 'Interac e-Transfer Received',
    amount: 1500,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
});

test('unknown: positive investment "Contribution" is not income', () => {
  const out = runDetectTypeStage({
    merchantRaw: 'Contribution (executed at 2025-12-18)',
    merchantClean: 'Contribution (executed at 2025-12-18)',
    amount: 9000,
    ownerNames: HH_MEMBERS,
  });
  assert.equal(out[0].fields.txnType, 'unknown');
});

// === RBC internal-transfer patterns (2026-06-01) ===
// RBC business statements describe internal transfers with narratives that do
// NOT match the existing "transfer to/from/in/out" regex, so they fell through
// to 'purchase'. These tests pin the targeted patterns added for Fix 1.

test('transfer: RBC "Online transfer sent" is a transfer (not a purchase)', () => {
  // RBC chequing → WS: "Online transfer sent - 6113 Connor Adams"
  const out = runDetectTypeStage({
    merchantRaw: 'Online transfer sent - 6113 Connor Adams',
    merchantClean: 'Online transfer sent - 6113 Connor Adams',
    amount: -7000,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
  assert.equal(out[0].confidence, 'high');
});

test('transfer: RBC "Investment WS Investments" (Wealthsimple funding) is a transfer', () => {
  // RBC → Wealthsimple investment funding: unambiguously internal money movement.
  const out = runDetectTypeStage({
    merchantRaw: 'Investment WS Investments',
    merchantClean: 'Investment WS Investments',
    amount: -7000,
  });
  assert.equal(out[0].fields.txnType, 'transfer');
  assert.equal(out[0].confidence, 'high');
});

test('NOT transfer: "Misc Payment CDG LABS INC" stays non-transfer (income-eligible)', () => {
  // Corporate revenue inflow must NOT be classified as transfer.
  // Mis-tagging it would exclude it from income reporting.
  const out = runDetectTypeStage({
    merchantRaw: 'Misc Payment CDG LABS INC',
    merchantClean: 'Misc Payment CDG LABS INC',
    amount: 5000,
    ownerNames: HH_MEMBERS,
  });
  assert.notEqual(out[0].fields.txnType, 'transfer');
});

test('purchase: a normal coffee purchase still classifies as purchase', () => {
  // Regression guard: adding RBC patterns must not affect the purchase fallback.
  const out = runDetectTypeStage({
    merchantRaw: 'TIM HORTONS #1234',
    merchantClean: 'Tim Hortons',
    amount: -3.75,
  });
  assert.equal(out[0].fields.txnType, 'purchase');
});
