import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchVendor } from './linkItemsStage';

test('Uber Eats resolves before Uber (array order)', () => {
  assert.deepEqual(matchVendor('UBER *EATS'), { vendor: 'uber_eats', canonical: 'Uber Eats' });
  assert.deepEqual(matchVendor('UBER EATS TORONTO'), { vendor: 'uber_eats', canonical: 'Uber Eats' });
});

test('Uber ride resolves to uber', () => {
  assert.deepEqual(matchVendor('UBER *TRIP'), { vendor: 'uber', canonical: 'Uber' });
  assert.deepEqual(matchVendor('UBER TRIP HELP.UBER.COM'), { vendor: 'uber', canonical: 'Uber' });
});

test('non-Uber merchants are unaffected', () => {
  assert.deepEqual(matchVendor('AMZN MKTP'), { vendor: 'amazon', canonical: 'Amazon' });
  assert.equal(matchVendor('STARBUCKS'), null);
});
