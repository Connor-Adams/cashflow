import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePartnerNet } from '../src/routes/summary';

test('computePartnerNet: partner owes me when sumPartner > sumMy', () => {
  const r = computePartnerNet(100, 250);
  assert.equal(r.net, 150);
  assert.equal(r.direction, 'partner_owes_me');
});

test('computePartnerNet: I owe partner when sumPartner < sumMy', () => {
  const r = computePartnerNet(300, 200);
  assert.equal(r.net, -100);
  assert.equal(r.direction, 'i_owe_partner');
});

test('computePartnerNet: even within sub-cent tolerance', () => {
  // Difference of 0.004 — below the 0.005 threshold — counts as even.
  const r = computePartnerNet(100.001, 100.005);
  assert.equal(r.direction, 'even');
});

test('computePartnerNet: exact zero is even', () => {
  const r = computePartnerNet(0, 0);
  assert.equal(r.net, 0);
  assert.equal(r.direction, 'even');
});

test('computePartnerNet: nulls coerce to zero', () => {
  const r = computePartnerNet(null, null);
  assert.equal(r.net, 0);
  assert.equal(r.direction, 'even');
});

test('computePartnerNet: null sumMy treats partner as full debt', () => {
  const r = computePartnerNet(null, 42);
  assert.equal(r.net, 42);
  assert.equal(r.direction, 'partner_owes_me');
});

test('computePartnerNet: just over half a cent flips out of even', () => {
  // 0.006 difference → rounds to 0.01, not even.
  const r = computePartnerNet(0, 0.006);
  assert.equal(r.direction, 'partner_owes_me');
});
