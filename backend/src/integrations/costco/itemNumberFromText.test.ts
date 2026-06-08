import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemNumberFromText } from './itemNumberFromText';

test('extracts item number after "Item" label', () => {
  assert.equal(itemNumberFromText('Kirkland Peanut Butter Item 1011242 | Costco'), '1011242');
  assert.equal(itemNumberFromText('... Item #1011242 ...'), '1011242');
  assert.equal(itemNumberFromText('Item No. 1011242'), '1011242');
  assert.equal(itemNumberFromText('item:1011242'), '1011242');
});

test('returns null when no item-number pattern present', () => {
  assert.equal(itemNumberFromText('Kirkland Peanut Butter | Costco'), null);
  assert.equal(itemNumberFromText(''), null);
  assert.equal(itemNumberFromText('Pack of 1011242 calories'), null);
});

test('first labeled match wins', () => {
  assert.equal(itemNumberFromText('Item 1011242 ... Item 9999999'), '1011242');
});
