/**
 * Pure tests for the safe-to-spend credit-card reservation (#TBD).
 *
 * `creditCardReservation` decides how much cash safe-to-spend should reserve
 * for one credit card within the spending window. The old behaviour reserved
 * the FULL current running balance (statement + post-statement charges) as if
 * all of it were due immediately. The new rule reserves the *statement balance*
 * — what is actually billed and due — gated by the card's due day, and only
 * falls back to the full balance when no statement data is captured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditCardReservation } from './creditCardReservation';

const WINDOW_START = '2026-06-20';
const WINDOW_END = '2026-07-04';

test('no statement data, no due day: falls back to the full current balance owed', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 10954.04, statementBalance: null, dueDay: null },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 10954.04);
});

test('no statement data, due day inside window: reserves the full current balance', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 10954.04, statementBalance: null, dueDay: 25 },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 10954.04);
});

test('no statement data, due day outside window: reserves nothing (not due this window)', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 10954.04, statementBalance: null, dueDay: 10 },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 0);
});

test('statement balance set, due day inside window: reserves the statement balance', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 10954.04, statementBalance: 8200, dueDay: 25 },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 8200);
});

test('statement balance set, due day outside window: reserves nothing (due next cycle)', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 10954.04, statementBalance: 8200, dueDay: 10 },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 0);
});

test('statement balance set, no due day: reserves the statement balance (cannot gate)', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 10954.04, statementBalance: 8200, dueDay: null },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 8200);
});

test('zero/credit statement balance: reserves nothing', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 0, statementBalance: 0, dueDay: 25 },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 0);
});

test('due day at the window start boundary counts as inside the window', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 500, statementBalance: 500, dueDay: 20 },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 500);
});

test('due day at the window end boundary counts as inside the window', () => {
  const r = creditCardReservation(
    { currentBalanceOwed: 500, statementBalance: 500, dueDay: 4 },
    WINDOW_START,
    WINDOW_END,
  );
  assert.equal(r, 500);
});
