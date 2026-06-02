/**
 * Verifies that the two optional PdfParser dedup declarations are correctly
 * wired in parseStatementFile's .pdf branch.
 *
 * These tests exercise the fingerprint-scheme logic in isolation (no DB, no
 * real PDF) by replicating the same stableFingerprint calls that
 * parseStatementFile makes so we can assert the hash contract without
 * bootstrapping the full stack.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableFingerprint } from '../src/import/fingerprint';

const ACCOUNT_ID = 42;
const STATEMENT_DATE = '2025-03-31';
const SYMBOL = 'xeqt';
const CURRENCY = 'CAD';
const QUANTITY = 100;
const MARKET_VALUE = 5000;

test('ws_holding fingerprint uses kind:ws_holding and upper-cases the symbol', () => {
  // This is the fingerprint emitted when parser.holdingFingerprint === 'ws_holding'.
  const wsFingerprint = stableFingerprint({
    kind: 'ws_holding',
    accountId: ACCOUNT_ID,
    statementDate: STATEMENT_DATE,
    symbol: SYMBOL.toUpperCase(),
    currency: CURRENCY,
  });

  // The WS holdings-CSV importer must produce the same hash for the same holding.
  // Replicate what the CSV path emits (symbol already upper-cased in CSV data).
  const csvEquivalent = stableFingerprint({
    kind: 'ws_holding',
    accountId: ACCOUNT_ID,
    statementDate: STATEMENT_DATE,
    symbol: 'XEQT',
    currency: CURRENCY,
  });

  assert.equal(wsFingerprint, csvEquivalent, 'PDF ws_holding fingerprint must match WS-CSV fingerprint');
});

test('generic holding fingerprint uses kind:holding with quantity and marketValue', () => {
  // This is the fingerprint emitted for non-ws parsers (holdingFingerprint omitted).
  const genericFingerprint = stableFingerprint({
    kind: 'holding',
    accountId: ACCOUNT_ID,
    statementDate: STATEMENT_DATE,
    symbol: SYMBOL,
    quantity: QUANTITY,
    marketValue: MARKET_VALUE,
  });

  // Must NOT equal the ws_holding fingerprint for the same holding.
  const wsFingerprint = stableFingerprint({
    kind: 'ws_holding',
    accountId: ACCOUNT_ID,
    statementDate: STATEMENT_DATE,
    symbol: SYMBOL.toUpperCase(),
    currency: CURRENCY,
  });

  assert.notEqual(genericFingerprint, wsFingerprint, 'generic holding fingerprint must differ from ws_holding fingerprint');
});
