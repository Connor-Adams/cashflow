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
