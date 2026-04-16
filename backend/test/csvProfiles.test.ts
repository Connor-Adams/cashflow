import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listImportProfiles, profiles } from '../src/import/csvProfiles';

test('listImportProfiles returns distinct profile definitions', () => {
  const list = listImportProfiles();
  assert.ok(list.length >= 2);
  const ids = list.map((x) => x.id);
  assert.ok(ids.includes('generic_simple'));
  assert.ok(ids.includes('generic_amex'));
  assert.ok(
    !ids.includes('amex'),
    'duplicate amex ref should be omitted in favor of generic_amex'
  );
});

test('listImportProfiles entries reference existing profile ids', () => {
  for (const row of listImportProfiles()) {
    assert.ok(profiles[row.id], `missing profile ${row.id}`);
  }
});
