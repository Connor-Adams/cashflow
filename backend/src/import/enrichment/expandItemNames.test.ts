/**
 * Unit tests for the Costco item-name expansion module (no DB).
 *
 * Locks down the PURE parse function `parseItemNameExpansions`:
 *  - maps itemId -> displayName for matching rows
 *  - clamps confidence into [0,100] and rounds
 *  - drops rows for unknown itemIds
 *  - passthrough: returns displayName=null when the model echoes the raw title
 *    or returns an empty/whitespace string (so the UI falls back to `title`)
 *  - caps displayName length to 512 chars
 * Plus the exported allowlist and the prompt-builder shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPANSION_VENDORS,
  parseItemNameExpansions,
  buildItemNameExpansionMessages,
  ITEM_NAME_EXPANSION_PROMPT_VERSION,
} from './expandItemNames';

test('EXPANSION_VENDORS starts with costco only', () => {
  assert.deepEqual(EXPANSION_VENDORS, ['costco']);
});

test('maps itemId -> displayName and clamps confidence', () => {
  const items = [
    { id: 1, title: 'KS ORG PNT BTR' },
    { id: 2, title: 'ORG BAN' },
  ];
  const json = {
    items: [
      { itemId: 1, displayName: 'Kirkland Signature Organic Peanut Butter', confidence: 91 },
      { itemId: 2, displayName: 'Organic Bananas', confidence: 250 },
    ],
  };
  const out = parseItemNameExpansions(json, items);
  assert.equal(out.length, 2);
  const byId = new Map(out.map((r) => [r.itemId, r]));
  assert.equal(byId.get(1)?.displayName, 'Kirkland Signature Organic Peanut Butter');
  assert.equal(byId.get(1)?.confidence, 91);
  // 250 clamps to 100.
  assert.equal(byId.get(2)?.confidence, 100);
  assert.equal(byId.get(2)?.displayName, 'Organic Bananas');
});

test('rounds and floors confidence into [0,100]', () => {
  const items = [
    { id: 1, title: 'A ABBR' },
    { id: 2, title: 'B ABBR' },
  ];
  const json = {
    items: [
      { itemId: 1, displayName: 'Alpha Abbreviation', confidence: 87.6 },
      { itemId: 2, displayName: 'Beta Abbreviation', confidence: -10 },
    ],
  };
  const byId = new Map(parseItemNameExpansions(json, items).map((r) => [r.itemId, r]));
  assert.equal(byId.get(1)?.confidence, 88);
  assert.equal(byId.get(2)?.confidence, 0);
});

test('passthrough: displayName is null when expansion equals the raw title (after trim/case)', () => {
  const items = [{ id: 1, title: 'Bananas' }];
  const json = { items: [{ itemId: 1, displayName: '  bananas  ', confidence: 80 }] };
  const out = parseItemNameExpansions(json, items);
  assert.equal(out.length, 1);
  assert.equal(out[0].itemId, 1);
  assert.equal(out[0].displayName, null);
});

test('passthrough: displayName is null when the model returns an empty/whitespace string', () => {
  const items = [
    { id: 1, title: 'KS ORG PNT BTR' },
    { id: 2, title: 'WHATEVER' },
  ];
  const json = {
    items: [
      { itemId: 1, displayName: '   ', confidence: 80 },
      { itemId: 2, displayName: '', confidence: 80 },
    ],
  };
  const byId = new Map(parseItemNameExpansions(json, items).map((r) => [r.itemId, r]));
  assert.equal(byId.get(1)?.displayName, null);
  assert.equal(byId.get(2)?.displayName, null);
});

test('drops rows for unknown itemIds', () => {
  const items = [{ id: 1, title: 'KS ORG PNT BTR' }];
  const json = {
    items: [
      { itemId: 1, displayName: 'Kirkland Signature Organic Peanut Butter', confidence: 90 },
      { itemId: 999, displayName: 'Ghost Item', confidence: 90 },
    ],
  };
  const out = parseItemNameExpansions(json, items);
  assert.equal(out.length, 1);
  assert.equal(out[0].itemId, 1);
});

test('caps displayName length to 512 chars', () => {
  const items = [{ id: 1, title: 'KS LONG' }];
  const long = 'X'.repeat(900);
  const json = { items: [{ itemId: 1, displayName: long, confidence: 90 }] };
  const out = parseItemNameExpansions(json, items);
  assert.equal(out.length, 1);
  assert.ok(out[0].displayName != null);
  assert.equal(out[0].displayName?.length, 512);
});

test('tolerates a non-array / malformed items payload', () => {
  const items = [{ id: 1, title: 'KS ORG PNT BTR' }];
  assert.deepEqual(parseItemNameExpansions({}, items), []);
  assert.deepEqual(parseItemNameExpansions({ items: 'nope' } as never, items), []);
  assert.deepEqual(parseItemNameExpansions({ items: [null, 7, 'x'] } as never, items), []);
});

test('buildItemNameExpansionMessages: system + user shape with batch items embedded', () => {
  const messages = buildItemNameExpansionMessages([
    { itemId: 5, title: 'KS ORG PNT BTR', unitPrice: 12.99 },
    { itemId: 6, title: 'BANANAS', unitPrice: null },
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  const system = messages[0].content as string;
  const user = messages[1].content as string;
  // System prompt teaches the Costco abbreviation expansion task.
  assert.match(system, /Kirkland Signature/);
  assert.match(system, /strict JSON/i);
  // User prompt pins the exact output schema and embeds the batch items.
  assert.match(user, /"items"/);
  assert.match(user, /itemId/);
  assert.match(user, /KS ORG PNT BTR/);
  assert.match(user, /BANANAS/);
});

test('prompt version constant is exported and stable', () => {
  assert.equal(ITEM_NAME_EXPANSION_PROMPT_VERSION, 'costco-item-name-expansion-v1');
});
