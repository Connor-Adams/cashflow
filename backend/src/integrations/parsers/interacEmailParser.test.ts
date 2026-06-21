import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInteracEmail } from './interac.js';

const FROM = 'Wealthsimple <catch@payments.interac.ca>';

test('parses a "sent / deposited" notification', () => {
  const r = parseInteracEmail(
    FROM,
    'Interac e-Transfer: Your $5,000.00 transfer to Caelan Iten-McGrath has been successfully deposited.',
    'Hi CONNOR ADAMS, The $5,000.00 (CAD) you sent to Caelan Iten-McGrath has been successfully deposited. Reference Number: C1AWG5BX9Xkd',
  );
  assert.deepEqual(r, { name: 'Caelan Iten-McGrath', amountCents: 500000, direction: 'sent', ref: 'C1AWG5BX9Xkd' });
});

test('dedupes a doubled name token sequence', () => {
  const r = parseInteracEmail(FROM, 'Interac e-Transfer: Your $5,000.00 transfer to FINNSKA INC. FINNSKA INC. has been successfully deposited.', '');
  assert.equal(r?.name, 'FINNSKA INC.');
  assert.equal(r?.amountCents, 500000);
});

test('keeps original casing (no title-casing)', () => {
  const r = parseInteracEmail(FROM, 'Interac e-Transfer: Your $1,791.01 transfer to STEPHEN MASSEUR has been successfully deposited.', '');
  assert.equal(r?.name, 'STEPHEN MASSEUR');
  assert.equal(r?.amountCents, 179101);
});

test('non-interac sender returns null', () => {
  assert.equal(parseInteracEmail('Chexy <concierge@chexy.co>', 'Interac e-Transfer Sent to Jenny Gao $2,850.00', ''), null);
});

test('no parseable amount returns null', () => {
  assert.equal(parseInteracEmail(FROM, 'Interac e-Transfer: reminder', 'no amount here'), null);
});

test('parses the sent form from the body when the subject lacks the name', () => {
  const r = parseInteracEmail(
    FROM,
    'Interac e-Transfer notification',
    'The $120.00 (CAD) you sent to Jane Smith has been successfully deposited. Reference Number: ABC123',
  );
  assert.equal(r?.direction, 'sent');
  assert.equal(r?.name, 'Jane Smith');
  assert.equal(r?.amountCents, 12000);
  assert.equal(r?.ref, 'ABC123');
});
