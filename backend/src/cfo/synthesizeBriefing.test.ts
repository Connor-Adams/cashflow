import test from 'node:test';
import assert from 'node:assert/strict';
import type { CfoBriefingActionItem } from '../models/CfoBriefing';
import { parseSynthesis, synthesizeBriefing } from './synthesizeBriefing';

function item(id: string, title: string): CfoBriefingActionItem {
  return {
    id,
    type: 'anomaly',
    refType: null,
    refId: null,
    severity: 'info',
    title,
    summary: title,
    status: 'open',
  };
}

const items = [item('a', 'A'), item('b', 'B'), item('c', 'C')];

test('reorders items by the returned ranking', () => {
  const out = parseSynthesis(
    { summary: 'Two things need you.', ranking: [{ id: 'c' }, { id: 'a' }] },
    items,
  );
  assert.equal(out.summary, 'Two things need you.');
  assert.deepEqual(out.ordered.map((i) => i.id), ['c', 'a', 'b']);
});

test('drops ranking entries for ids not in the input', () => {
  const out = parseSynthesis(
    { summary: 'x', ranking: [{ id: 'ghost' }, { id: 'b' }] },
    items,
  );
  assert.deepEqual(out.ordered.map((i) => i.id), ['b', 'a', 'c']);
});

test('a duplicated id is used once', () => {
  const out = parseSynthesis(
    { summary: 'x', ranking: [{ id: 'b' }, { id: 'b' }, { id: 'a' }] },
    items,
  );
  assert.deepEqual(out.ordered.map((i) => i.id), ['b', 'a', 'c']);
});

test('a missing or blank summary yields null, not an empty string', () => {
  assert.equal(parseSynthesis({ ranking: [] }, items).summary, null);
  assert.equal(parseSynthesis({ summary: '   ' }, items).summary, null);
  assert.equal(parseSynthesis({ summary: 42 }, items).summary, null);
});

test('a malformed ranking leaves the original order', () => {
  const out = parseSynthesis({ summary: 'x', ranking: 'nope' }, items);
  assert.deepEqual(out.ordered.map((i) => i.id), ['a', 'b', 'c']);
});

test('synthesizeBriefing degrades to nulls when the model throws', async () => {
  const out = await synthesizeBriefing({
    items,
    safeToSpend: null,
    currency: 'CAD',
    openaiJsonImpl: async () => {
      throw new Error('502 Bad Gateway');
    },
  });
  assert.equal(out.summary, null);
  assert.deepEqual(out.ordered.map((i) => i.id), ['a', 'b', 'c']);
});

test('synthesizeBriefing returns the original order for an empty item list', async () => {
  let called = false;
  const out = await synthesizeBriefing({
    items: [],
    safeToSpend: null,
    currency: 'CAD',
    openaiJsonImpl: async () => {
      called = true;
      return {};
    },
  });
  assert.equal(called, false);
  assert.equal(out.summary, null);
  assert.deepEqual(out.ordered, []);
});
