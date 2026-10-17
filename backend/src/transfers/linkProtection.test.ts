import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEstablishedLink } from './linkProtection';

const row = (over: Partial<Parameters<typeof isEstablishedLink>[0]> = {}) => ({
  linkedTransactionId: 992,
  transferLinkedAt: null,
  reviewedAt: null,
  ...over,
});

test('no link: nothing to protect', () => {
  assert.equal(isEstablishedLink(row({ linkedTransactionId: null }), true), false);
});

test('a reciprocal pair is established', () => {
  assert.equal(isEstablishedLink(row(), true), true);
});

test('a manually linked row is established even if the partner drifted', () => {
  assert.equal(isEstablishedLink(row({ transferLinkedAt: new Date() }), false), true);
});

test('a reviewed row keeps its link', () => {
  assert.equal(isEstablishedLink(row({ reviewedAt: new Date() }), false), true);
});

test('a one-way automatic link on an unreviewed row may be replaced', () => {
  assert.equal(isEstablishedLink(row(), false), false);
});
