import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inheritedTaxTreatment, type CatTaxNode } from './inheritedTaxTreatment';

function map(nodes: CatTaxNode[]): Map<number, CatTaxNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

test('a category with its own non-none treatment uses it', () => {
  const m = map([{ id: 1, parentId: null, taxTreatment: 'medical_expense' }]);
  assert.equal(inheritedTaxTreatment(m, 1), 'medical_expense');
});

test('a none child inherits the nearest ancestor non-none treatment', () => {
  const m = map([
    { id: 1, parentId: null, taxTreatment: 'medical_expense' }, // Health
    { id: 2, parentId: 1, taxTreatment: 'none' }, // Dentist
    { id: 3, parentId: 2, taxTreatment: 'none' }, // Cleaning
  ]);
  assert.equal(inheritedTaxTreatment(m, 3), 'medical_expense');
});

test("an explicit child treatment overrides the parent's", () => {
  const m = map([
    { id: 1, parentId: null, taxTreatment: 'medical_expense' },
    { id: 2, parentId: 1, taxTreatment: 'donations' },
  ]);
  assert.equal(inheritedTaxTreatment(m, 2), 'donations');
});

test('none everywhere → none', () => {
  const m = map([
    { id: 1, parentId: null, taxTreatment: 'none' },
    { id: 2, parentId: 1, taxTreatment: 'none' },
  ]);
  assert.equal(inheritedTaxTreatment(m, 2), 'none');
});

test('null/unknown id → none', () => {
  const m = map([{ id: 1, parentId: null, taxTreatment: 'salary' }]);
  assert.equal(inheritedTaxTreatment(m, null), 'none');
  assert.equal(inheritedTaxTreatment(m, 999), 'none');
});

test('a parent cycle is guarded (no infinite loop)', () => {
  const m = map([
    { id: 1, parentId: 2, taxTreatment: 'none' },
    { id: 2, parentId: 1, taxTreatment: 'none' },
  ]);
  assert.equal(inheritedTaxTreatment(m, 1), 'none');
});
