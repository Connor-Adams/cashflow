const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDateFlexible } = require('../src/import/parseDateFlexible');

test('parses US Amex MM/dd/yyyy', () => {
  const d = parseDateFlexible('03/15/2025', 'MM/dd/yyyy');
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 15);
});

test('parses CA style dd/MM/yyyy', () => {
  const d = parseDateFlexible('15/03/2025', 'MM/dd/yyyy');
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 15);
});

test('parses ISO yyyy-MM-dd', () => {
  const d = parseDateFlexible('2025-03-15', 'MM/dd/yyyy');
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 15);
});
