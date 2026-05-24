import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../../src/ai/chat/systemPrompt';

test('buildSystemPrompt includes date, currency, and contacts', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'CAD',
    contacts: [
      { id: 7, name: 'Alice', currency: 'CAD' },
      { id: 9, name: 'Bob', currency: null },
    ],
  });
  assert.match(out, /Today is 2026-05-24/);
  assert.match(out, /default currency is CAD/);
  assert.match(out, /7:Alice\(CAD\)/);
  assert.match(out, /9:Bob/);
  assert.doesNotMatch(out, /9:Bob\(/);
});

test('buildSystemPrompt handles empty contacts', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'USD',
    contacts: [],
  });
  assert.match(out, /Household contacts: \(none\)/);
});

test('buildSystemPrompt enforces apply-vs-propose contract', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'CAD',
    contacts: [],
  });
  assert.match(out, /You DO NOT apply mutations/);
  assert.match(out, /the user clicks Apply in the UI/);
});

test('buildSystemPrompt lists the patch whitelist', () => {
  const out = buildSystemPrompt({
    todayIso: '2026-05-24',
    defaultCurrency: 'CAD',
    contacts: [],
  });
  for (const field of [
    'split_override',
    'pct_me_override',
    'pct_partner_override',
    'category_override',
    'business_override',
    'notes',
    'review_flag',
  ]) {
    assert.match(out, new RegExp(field));
  }
});
