/**
 * Unit tests for the SimpleFIN client (issue #790): setup-token decode,
 * access-URL parsing/masking, and the account-mapping logic. No DB, no network
 * (claim/discovery exercise stubbed global fetch in the integration suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SimplefinError,
  decodeSetupToken,
  maskAccessUrlHost,
  parseAccessUrl,
} from './client.js';
import { mapDiscoveredAccounts } from './service.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('decodeSetupToken returns the claim URL for a valid https token', () => {
  const claim = 'https://beta-bridge.simplefin.org/simplefin/claim/abc123';
  assert.equal(decodeSetupToken(b64(claim)), claim);
});

test('decodeSetupToken rejects an empty token', () => {
  assert.throws(() => decodeSetupToken(''), (e) => e instanceof SimplefinError && e.code === 'invalid_setup_token');
  assert.throws(() => decodeSetupToken('   '), (e) => e instanceof SimplefinError && e.code === 'invalid_setup_token');
});

test('decodeSetupToken rejects a token that decodes to a non-https URL', () => {
  assert.throws(
    () => decodeSetupToken(b64('http://insecure.example.com/claim')),
    (e) => e instanceof SimplefinError && e.code === 'invalid_setup_token',
  );
});

test('decodeSetupToken rejects a token that decodes to non-URL garbage', () => {
  assert.throws(
    () => decodeSetupToken(b64('not a url at all')),
    (e) => e instanceof SimplefinError && e.code === 'invalid_setup_token',
  );
});

test('parseAccessUrl requires embedded credentials', () => {
  assert.throws(
    () => parseAccessUrl('https://beta-bridge.simplefin.org/accounts'),
    (e) => e instanceof SimplefinError && e.code === 'claim_exchange_failed',
  );
  const ok = parseAccessUrl('https://user:pass@beta-bridge.simplefin.org/simplefin');
  assert.equal(ok.host, 'beta-bridge.simplefin.org');
});

test('maskAccessUrlHost returns only the host, never credentials', () => {
  const host = maskAccessUrlHost('https://user:secret@beta-bridge.simplefin.org/simplefin');
  assert.equal(host, 'beta-bridge.simplefin.org');
  assert.equal(maskAccessUrlHost('garbage'), null);
});

test('mapDiscoveredAccounts links by last-4 of account number', () => {
  const discovered = [{ id: 'ACT-1', name: 'Checking', accountNumber: 'XXXX1234' }];
  const accounts = [
    { id: 10, name: 'My Checking', bankAccountNumber: '****1234' },
    { id: 11, name: 'Savings', bankAccountNumber: '5678' },
  ];
  const { linked, unlinked } = mapDiscoveredAccounts(discovered, accounts);
  assert.equal(linked, 1);
  assert.equal(unlinked.length, 0);
});

test('mapDiscoveredAccounts links by normalized name when no number match', () => {
  const discovered = [{ id: 'ACT-2', name: 'Joint Savings', accountNumber: null }];
  const accounts = [{ id: 20, name: 'joint savings', bankAccountNumber: null }];
  const { linked, unlinked } = mapDiscoveredAccounts(discovered, accounts);
  assert.equal(linked, 1);
  assert.equal(unlinked.length, 0);
});

test('mapDiscoveredAccounts reports unmatched accounts as unlinked', () => {
  const discovered = [{ id: 'ACT-3', name: 'Brokerage ****9999', accountNumber: '9999' }];
  const accounts = [{ id: 30, name: 'Checking', bankAccountNumber: '1111' }];
  const { linked, unlinked } = mapDiscoveredAccounts(discovered, accounts);
  assert.equal(linked, 0);
  assert.deepEqual(unlinked, [{ simplefinId: 'ACT-3', name: 'Brokerage ****9999' }]);
});

test('mapDiscoveredAccounts treats ambiguous (multi) matches as unlinked', () => {
  const discovered = [{ id: 'ACT-4', name: 'Checking', accountNumber: '1234' }];
  const accounts = [
    { id: 40, name: 'Checking A', bankAccountNumber: '1234' },
    { id: 41, name: 'Checking B', bankAccountNumber: '1234' },
  ];
  const { linked, unlinked } = mapDiscoveredAccounts(discovered, accounts);
  assert.equal(linked, 0);
  assert.equal(unlinked.length, 1);
});

test('fetchTransactions surfaces SimpleFIN errors and each account balance-date', async () => {
  const { fetchTransactions } = await import('./client.js');
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(
      JSON.stringify({
        errors: ['Connection to Royal Bank of Canada  may need attention. Broken.'],
        accounts: [
          { id: 'ACT-1', name: 'RBC (6985)', currency: 'CAD', 'balance-date': 1782005423, transactions: [] },
          { id: 'ACT-2', name: 'Cobalt (1005)', currency: 'CAD', transactions: [] },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await fetchTransactions('https://u:p@bridge.example/simplefin', 1700000000);
    assert.ok(requested.endsWith('/accounts?start-date=1700000000'));
    assert.deepEqual(result.errors, ['Connection to Royal Bank of Canada  may need attention. Broken.']);
    assert.equal(result.accounts[0].balanceDate, 1782005423);
    assert.equal(result.accounts[1].balanceDate, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchTransactions tolerates a payload without an errors array', async () => {
  const { fetchTransactions } = await import('./client.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accounts: [] }), { status: 200 })) as unknown as typeof globalThis.fetch;
  try {
    const result = await fetchTransactions('https://u:p@bridge.example/simplefin', 0);
    assert.deepEqual(result.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
