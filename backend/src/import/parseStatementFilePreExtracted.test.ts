import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequelize, Account, Household } from '../models';

// When preExtractedLines is supplied, parseStatementFile must NOT call extractPdfLines.
// We prove it by passing a non-PDF buffer (extractPdfLines would throw on it) plus
// valid pre-extracted credit-card lines, and asserting a successful parse.
test('parseStatementFile uses preExtractedLines and skips extraction', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const account = await Account.create({
    householdId: hh.id, name: 'WS CC', accountType: 'credit_card', owner: 'me',
    visibility: 'private', defaultCurrency: 'CAD', shortCode: '3338',
  } as never);
  const { parseStatementFile } = await import('./parseStatementFile');
  const lines = [
    { page: 1, y: 9, text: 'Credit card statement' },
    { page: 1, y: 8, text: 'Wealthsimple Apr 15 — May 14, 2026' },
    { page: 1, y: 7, text: '4126 50** **** 3338' },
    { page: 1, y: 6, text: 'Statement date May 15, 2026' },
    { page: 2, y: 5, text: 'TRANS. DATE   POSTED DATE   TYPE   DETAILS   AMOUNT ($CAD)' },
    { page: 2, y: 4, text: 'Apr 16   Apr 17   Purchase   A&W #4655   $10.49' },
  ];
  const preview = await parseStatementFile({
    buffer: Buffer.from('not a real pdf'),
    fileName: 'x.pdf',
    accountId: account.id,
    householdId: hh.id,
    preExtractedLines: lines as never,
  });
  assert.ok(!('ok' in preview && preview.ok === false), 'should not error');
  assert.equal((preview as { transactions: unknown[] }).transactions.length, 1);
});

// parseStatementFile is where the PDF parser learns which account the upload
// targets. Wealthsimple serves brokerage and Cash/Chequing/Save statements from
// one layout, so without that hand-off the WS parser cannot tell a bank account
// from a brokerage account and files its rows as investment activity — which is
// how the 2026-07 chequing statement's cash flow (AMEX pre-authorized debits,
// e-transfers, withdrawals) never reached the ledger.
test('parseStatementFile tells the PDF parser the account type', async () => {
  await sequelize.sync({ force: true });
  const hh = await Household.create({ name: 'H' } as never);
  const account = await Account.create({
    householdId: hh.id, name: 'WS Chequing', accountType: 'checking', owner: 'me',
    visibility: 'private', defaultCurrency: 'CAD', shortCode: 'WK3DD9X35CAD',
  } as never);
  const { parseStatementFile } = await import('./parseStatementFile');
  const lines = [
    { page: 1, y: 9, text: 'ORDER EXECUTION ONLY ACCOUNT' },
    { page: 1, y: 8, text: 'Wealthsimple Investments Inc.' },
    { page: 1, y: 7, text: ' Account No.   Owner   Statement Period' },
    { page: 1, y: 6, text: ' WK3DD9X35CAD   Connor Adams   2026-07-01 - 2026-07-31' },
    { page: 1, y: 5, text: 'Phone: (416) 595-7200 Fax: (647) 245-1002' },
    { page: 1, y: 4, text: ' Chequing Account' },
    { page: 2, y: 3, text: ' Activity - Current period' },
    { page: 2, y: 2, text: ' Date   Transaction   Description   Debit ($)   Credit ($)   Balance ($)' },
    { page: 2, y: 1, text: '2026-07-15   WD   Pre-authorized Debit to AMEX BILL PYMT   $11,922.90   $0.00   $2,410.55' },
  ];
  const preview = await parseStatementFile({
    buffer: Buffer.from('not a real pdf'),
    fileName: 'WK3DD9X35CAD_2026-07_BROKERAGE.pdf',
    accountId: account.id,
    householdId: hh.id,
    preExtractedLines: lines as never,
  });
  assert.ok(!('ok' in preview && preview.ok === false), 'should not error');
  const out = preview as {
    transactions: { amount: number }[];
    investmentActivities?: unknown[];
  };
  assert.equal(out.transactions.length, 1);
  assert.equal(out.transactions[0].amount, -11922.9);
  assert.equal(out.investmentActivities?.length ?? 0, 0);
});
