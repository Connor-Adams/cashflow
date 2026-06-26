/**
 * Unit tests for the pure audit-log visibility decision logic (#838).
 * The DB-touching context builder is exercised by the integration test;
 * here we lock the row-level keep/drop rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuditRowVisible,
  filterVisibleAuditRows,
  type AuditVisibilityContext,
} from './visibility';

function ctx(overrides: Partial<AuditVisibilityContext> = {}): AuditVisibilityContext {
  return {
    isSuperadmin: false,
    userId: 7,
    visibleTransactionIds: new Set(),
    visibleVaultIds: new Set(),
    existingTransactionIds: new Set(),
    existingVaultIds: new Set(),
    ...overrides,
  };
}

test('non-visibility-scoped entity types always pass (household-shared)', () => {
  for (const entityType of ['rule', 'settlement', 'receipt', 'ai_suggestion', 'import']) {
    assert.equal(
      isAuditRowVisible({ entityType, entityId: 1, actorUserId: 99 }, ctx()),
      true,
      `${entityType} should pass household scope`,
    );
  }
});

test('superadmin sees every row', () => {
  const c = ctx({ isSuperadmin: true });
  assert.equal(
    isAuditRowVisible({ entityType: 'transaction', entityId: 1, actorUserId: 99 }, c),
    true,
  );
});

test('id-less (bulk) transaction rows pass through', () => {
  assert.equal(
    isAuditRowVisible({ entityType: 'transaction', entityId: null, actorUserId: 99 }, ctx()),
    true,
  );
});

test('visible transaction row is kept', () => {
  const c = ctx({
    visibleTransactionIds: new Set([42]),
    existingTransactionIds: new Set([42]),
  });
  assert.equal(
    isAuditRowVisible({ entityType: 'transaction', entityId: 42, actorUserId: 99 }, c),
    true,
  );
});

test('existing-but-not-visible transaction row is dropped (private, not yours)', () => {
  const c = ctx({
    visibleTransactionIds: new Set(),
    existingTransactionIds: new Set([42]),
  });
  assert.equal(
    isAuditRowVisible({ entityType: 'transaction', entityId: 42, actorUserId: 99 }, c),
    false,
  );
});

test('deleted transaction row kept only for the actor', () => {
  const c = ctx(); // 42 neither visible nor existing
  assert.equal(
    isAuditRowVisible({ entityType: 'transaction', entityId: 42, actorUserId: 7 }, c),
    true,
    'actor (userId 7) keeps their own deleted-entity row',
  );
  assert.equal(
    isAuditRowVisible({ entityType: 'transaction', entityId: 42, actorUserId: 99 }, c),
    false,
    'non-actor cannot read a deleted private entity row',
  );
  assert.equal(
    isAuditRowVisible({ entityType: 'transaction', entityId: 42, actorUserId: null }, c),
    false,
    'system row for a vanished entity is not readable by members',
  );
});

test('vault_document rows obey the same gate', () => {
  const visible = ctx({
    visibleVaultIds: new Set([5]),
    existingVaultIds: new Set([5]),
  });
  assert.equal(
    isAuditRowVisible({ entityType: 'vault_document', entityId: 5, actorUserId: 99 }, visible),
    true,
  );
  const hidden = ctx({ existingVaultIds: new Set([5]) });
  assert.equal(
    isAuditRowVisible({ entityType: 'vault_document', entityId: 5, actorUserId: 99 }, hidden),
    false,
  );
});

test('filterVisibleAuditRows drops only the hidden rows, preserves order', () => {
  const c = ctx({
    visibleTransactionIds: new Set([1]),
    existingTransactionIds: new Set([1, 2]),
  });
  const rows = [
    { entityType: 'transaction', entityId: 1, actorUserId: 99, tag: 'a' },
    { entityType: 'transaction', entityId: 2, actorUserId: 99, tag: 'b' }, // private, drop
    { entityType: 'rule', entityId: 3, actorUserId: 99, tag: 'c' },
  ];
  const out = filterVisibleAuditRows(rows, c);
  assert.deepEqual(
    out.map((r) => r.tag),
    ['a', 'c'],
  );
});
