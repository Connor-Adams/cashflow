import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUberKind, uberVendorOverride } from '../src/integrations/parsers/uber';

test('classifyUberKind detects Eats vs ride', () => {
  assert.equal(classifyUberKind('Your Uber Eats order with Pizza Place', 'Total ...'), 'uber_eats');
  assert.equal(classifyUberKind('Your Tuesday morning trip with Uber', 'Thanks for riding'), 'uber');
  assert.equal(classifyUberKind(null, 'Uber Eats receipt body'), 'uber_eats');
});

test('uberVendorOverride only fires for uber.com senders', () => {
  assert.equal(uberVendorOverride('receipts@uber.com', 'Your Uber Eats order', ''), 'uber_eats');
  assert.equal(uberVendorOverride('Uber Receipts <noreply@uber.com>', 'Your trip', 'Thanks for riding'), 'uber');
  assert.equal(uberVendorOverride('no-reply@apple.com', 'Uber Eats', ''), null);
  assert.equal(uberVendorOverride(null, 'x', ''), null);
});
