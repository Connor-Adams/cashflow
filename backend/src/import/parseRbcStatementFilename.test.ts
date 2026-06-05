import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRbcStatementFilename,
  type ParsedRbcFilename,
} from './parseRbcStatementFilename';

const CASES: Array<{ name: string; expected: ParsedRbcFilename }> = [
  {
    name: 'Chequing Statement-6985 2025-12-02.pdf',
    expected: { accountSuffix: '6985', productHint: 'chequing', periodEnd: '2025-12-02' },
  },
  {
    name: 'Chequing Statement-4660 2025-12-02.pdf',
    expected: { accountSuffix: '4660', productHint: 'chequing', periodEnd: '2025-12-02' },
  },
  {
    name: 'Savings Statement-6993 2025-12-02.pdf',
    expected: { accountSuffix: '6993', productHint: 'savings', periodEnd: '2025-12-02' },
  },
  {
    name: 'NOMI Savings Statement-0358 2025-12-02.pdf',
    expected: { accountSuffix: '0358', productHint: 'nomi_savings', periodEnd: '2025-12-02' },
  },
  {
    name: 'Visa Statement-5234 2025-12-08.pdf',
    expected: { accountSuffix: '5234', productHint: 'visa', periodEnd: '2025-12-08' },
  },
  {
    name: 'Credit Line Statement-0001 2025-12-03.pdf',
    expected: { accountSuffix: '0001', productHint: 'credit_line', periodEnd: '2025-12-03' },
  },
  {
    name: 'TFSA Statement-6430 2025-12-31.pdf',
    expected: { accountSuffix: '6430', productHint: 'tfsa', periodEnd: '2025-12-31' },
  },
  {
    name: 'RDSP Statement-4346 2025-12-31.pdf',
    expected: { accountSuffix: '4346', productHint: 'rdsp', periodEnd: '2025-12-31' },
  },
];

for (const { name, expected } of CASES) {
  test(`parses RBC filename: ${name}`, () => {
    assert.deepEqual(parseRbcStatementFilename(name), expected);
  });
}

test('returns null for non-RBC filenames', () => {
  assert.equal(parseRbcStatementFilename('CIBC Costco Mastercard.pdf'), null);
  assert.equal(parseRbcStatementFilename('Wealthsimple_TFSA_2025-12.csv'), null);
  assert.equal(parseRbcStatementFilename('random.pdf'), null);
});

test('returns null when product is unrecognized', () => {
  assert.equal(
    parseRbcStatementFilename('LineOfCredit Statement-9999 2025-01-01.pdf'),
    null,
  );
});

test('strips directory prefix from the filename', () => {
  assert.deepEqual(
    parseRbcStatementFilename('/Downloads/RDSP Statement-4346 2025-12-31.pdf'),
    { accountSuffix: '4346', productHint: 'rdsp', periodEnd: '2025-12-31' },
  );
});
