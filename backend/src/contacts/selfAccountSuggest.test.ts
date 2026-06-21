import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, suggestSelfContacts, type SuggestableContact } from './selfAccountSuggest.js';

// ── tokenize ────────────────────────────────────────────────────────────────

test('tokenize: lowercases and splits on non-alphanumeric, drops short tokens', () => {
  assert.deepEqual(tokenize('Connor Adams RBC'), ['connor', 'adams', 'rbc']);
  assert.deepEqual(tokenize('John S.'), ['john']); // 's' is 1 char, dropped
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('a b'), []); // all < 3 chars
  assert.deepEqual(tokenize('RBC Day-to-Day Banking'), ['rbc', 'day', 'day', 'banking']);
});

// ── suggestSelfContacts ──────────────────────────────────────────────────────

const makeContact = (
  id: number,
  name: string,
  isSelf = false,
): SuggestableContact => ({ id, name, normalizedName: name.toLowerCase(), isSelf });

test('suggests a contact whose name tokens overlap userNameTokens', () => {
  const contacts: SuggestableContact[] = [
    makeContact(1, 'Connor Adams RBC'),
    makeContact(2, 'Caelan'),
  ];
  const suggestions = suggestSelfContacts(contacts, ['connor', 'adams'], []);
  // "Connor Adams RBC" has 'connor' and 'adams' matching user tokens
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].id, 1);
  assert.match(suggestions[0].reason, /matches your name/);
  assert.match(suggestions[0].reason, /connor/);
  assert.match(suggestions[0].reason, /adams/);
});

test('does NOT suggest a contact with no token overlap', () => {
  const contacts: SuggestableContact[] = [makeContact(2, 'Caelan')];
  const suggestions = suggestSelfContacts(contacts, ['connor', 'adams'], []);
  assert.equal(suggestions.length, 0);
});

test('skips contacts already marked isSelf', () => {
  const contacts: SuggestableContact[] = [
    makeContact(1, 'Connor Adams RBC', true), // already confirmed
  ];
  const suggestions = suggestSelfContacts(contacts, ['connor', 'adams'], []);
  assert.equal(suggestions.length, 0, 'already-isSelf contacts must be excluded');
});

test('suggests via accountNameTokens when name does not overlap user tokens', () => {
  const contacts: SuggestableContact[] = [makeContact(3, 'Savings Account RBC')];
  const suggestions = suggestSelfContacts(contacts, ['connor'], ['savings', 'account', 'rbc']);
  // 'savings', 'account', 'rbc' all match account tokens
  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0].reason, /matches account name/);
});

test('reason mentions both name and account when both match', () => {
  const contacts: SuggestableContact[] = [makeContact(4, 'Connor RBC Savings')];
  const suggestions = suggestSelfContacts(
    contacts,
    ['connor', 'adams'],
    ['rbc', 'savings'],
  );
  assert.equal(suggestions.length, 1);
  // reason must mention both match categories
  assert.match(suggestions[0].reason, /matches your name/);
  assert.match(suggestions[0].reason, /matches account name/);
});

test('tokens shorter than 3 chars in userNameTokens are ignored', () => {
  const contacts: SuggestableContact[] = [makeContact(5, 'Mr Adams')];
  // 'mr' is 2 chars; only 'adams' qualifies
  const suggestions = suggestSelfContacts(contacts, ['mr', 'adams'], []);
  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0].reason, /adams/);
  assert.doesNotMatch(suggestions[0].reason, /\bmr\b/);
});

test('empty contacts list returns empty suggestions', () => {
  const suggestions = suggestSelfContacts([], ['connor', 'adams'], ['rbc']);
  assert.equal(suggestions.length, 0);
});
