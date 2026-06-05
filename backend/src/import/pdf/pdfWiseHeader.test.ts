import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PdfLine } from './types';
import {
  parseWiseStatementHeader,
  wiseStatementParser,
} from './wiseStatement';

function mk(text: string, page = 1, y = 0): PdfLine {
  return { page, y, text };
}

test('wiseStatementParser sniff matches Wise Payments Canada Inc. line', () => {
  assert.equal(
    wiseStatementParser.sniff([mk('Wise Payments Canada Inc.')]),
    true,
  );
});

test('wiseStatementParser sniff rejects unrelated lines', () => {
  assert.equal(
    wiseStatementParser.sniff([mk('RBC personal banking statement')]),
    false,
  );
});

test('parseWiseStatementHeader extracts CAD suffix, currency, holder, period', () => {
  // Real Wise PDF places holder + account number on a SHARED line that splits
  // on 2+ spaces; the column-label line above lists the field names.
  const lines: PdfLine[] = [
    mk('Wise Payments Canada Inc.'),
    mk('CAD statement'),
    mk('June 20, 2025 [GMT-04:00] - May 25, 2026 [GMT-04:00]'),
    mk('Generated on: May 26, 2026'),
    mk('Account Holder                        Account number                    Institution number'),
    mk('CDG Labs Inc.                             200116984719                             621'),
    mk('485 Sandmere Place'),
  ];
  const header = parseWiseStatementHeader(lines);
  assert.equal(header.accountSuffix, '4719');
  assert.equal(header.productLabel, 'Wise CAD');
  assert.equal(header.accountType, 'checking');
  assert.equal(header.currency, 'CAD');
  assert.equal(header.accountHolder, 'CDG Labs Inc.');
  assert.equal(header.periodStart, '2025-06-20');
  assert.equal(header.periodEnd, '2026-05-25');
});

test('parseWiseStatementHeader extracts USD suffix + currency from USD statement', () => {
  const lines: PdfLine[] = [
    mk('Wise Payments Canada Inc.'),
    mk('USD statement'),
    mk('June 20, 2025 [GMT-04:00] - May 25, 2026 [GMT-04:00]'),
    mk('Account Holder                        Account number                    Routing number'),
    mk('CDG Labs Inc.                             211862849418                             101019628'),
  ];
  const header = parseWiseStatementHeader(lines);
  assert.equal(header.accountSuffix, '9418');
  assert.equal(header.productLabel, 'Wise USD');
  assert.equal(header.currency, 'USD');
  assert.equal(header.accountHolder, 'CDG Labs Inc.');
});

test('parseWiseStatementHeader handles personal holder (no Inc.) — accountHolder still surfaced', () => {
  const lines: PdfLine[] = [
    mk('Wise Payments Canada Inc.'),
    mk('CAD statement'),
    mk('January 1, 2025 [GMT-04:00] - December 31, 2025 [GMT-04:00]'),
    mk('Account Holder                        Account number                    Institution number'),
    mk('Connor Adams                              200900800700                             621'),
  ];
  const header = parseWiseStatementHeader(lines);
  assert.equal(header.accountHolder, 'Connor Adams');
  assert.equal(header.accountSuffix, '0700');
});

test('parseWiseStatementHeader throws when sniff line absent', () => {
  assert.throws(
    () => parseWiseStatementHeader([mk('USD statement'), mk('Account number'), mk('123')]),
    /not a Wise statement/i,
  );
});

test('parseWiseStatementHeader throws on missing currency line', () => {
  assert.throws(
    () => parseWiseStatementHeader([
      mk('Wise Payments Canada Inc.'),
      mk('Account Holder                       Account number'),
      mk('CDG Labs Inc.                            200116984719'),
    ]),
    /currency/i,
  );
});

test('parseWiseStatementHeader throws on missing period', () => {
  assert.throws(
    () => parseWiseStatementHeader([
      mk('Wise Payments Canada Inc.'),
      mk('CAD statement'),
      mk('Account Holder                       Account number'),
      mk('CDG Labs Inc.                            200116984719'),
    ]),
    /period/i,
  );
});

test('parseWiseStatementHeader throws on missing account number', () => {
  assert.throws(
    () => parseWiseStatementHeader([
      mk('Wise Payments Canada Inc.'),
      mk('CAD statement'),
      mk('June 20, 2025 [GMT-04:00] - May 25, 2026 [GMT-04:00]'),
    ]),
    /account number/i,
  );
});

test('built-in registry includes Wise parser', async () => {
  const mod = await import('./registry');
  mod.clearPdfParsersForTest();
  mod.registerBuiltInPdfParsers();
  const hit = mod.findPdfParser([mk('Wise Payments Canada Inc.')]);
  assert.equal(hit?.id, 'wise_statement');
});
