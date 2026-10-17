import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  callsRemoveColumnDirectly,
  MIGRATIONS_WITH_LEGACY_REMOVE_COLUMN,
} from './noUnsafeRemoveColumn.helper';

test('the scan flags a migration that calls removeColumn on a queryInterface', () => {
  assert.equal(
    callsRemoveColumnDirectly("await queryInterface.removeColumn('accounts', 'notes');"),
    true,
  );
  // Same bug with a shorter variable name must not slip through.
  assert.equal(callsRemoveColumnDirectly("await qi.removeColumn('accounts', 'notes');"), true);
  assert.equal(
    callsRemoveColumnDirectly("await dropColumn(queryInterface, 'accounts', 'notes');"),
    false,
  );
});

test('no migration outside the legacy ledger calls removeColumn', () => {
  const dir = path.join(__dirname, '..');
  const offenders = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => callsRemoveColumnDirectly(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter((f) => !MIGRATIONS_WITH_LEGACY_REMOVE_COLUMN.includes(f))
    .sort();
  assert.deepEqual(
    offenders,
    [],
    'These migrations call queryInterface.removeColumn, which corrupts the SQLite ' +
      'schema. Use dropColumn() from helpers/sqliteDropColumn instead.',
  );
});

test('the legacy ledger has no stale entries', () => {
  const dir = path.join(__dirname, '..');
  const stale = MIGRATIONS_WITH_LEGACY_REMOVE_COLUMN.filter((f) => {
    const p = path.join(dir, f);
    return !fs.existsSync(p) || !callsRemoveColumnDirectly(fs.readFileSync(p, 'utf8'));
  });
  assert.deepEqual(
    stale,
    [],
    'These ledger entries no longer call queryInterface.removeColumn (or no longer ' +
      'exist). Delete their lines from MIGRATIONS_WITH_LEGACY_REMOVE_COLUMN.',
  );
});
