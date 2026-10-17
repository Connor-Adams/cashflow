/**
 * The four routes by which a transaction acquires a tax treatment.
 *
 * Extracted from `buildPersonalFacts` because the duplicate detector must answer
 * "has this row been classified?" and the obvious shortcut — check
 * `taxTreatmentOverride` — is wrong three ways out of four. A row classified by
 * an inherited category treatment, by the legacy name map, or by a snake_case
 * `finalCategory` keyword has a null override and is still classified. The
 * detector would otherwise report it as untouched and safe to merge away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTaxClassified, resolveTaxTreatment, type TaxTreatmentMaps } from './resolveTaxTreatment';

function maps(over: Partial<TaxTreatmentMaps> = {}): TaxTreatmentMaps {
  return {
    catById: new Map([
      [1, { id: 1, parentId: null, taxTreatment: 'medical_expense' }],
      // Child whose own treatment is 'none' — must inherit the parent's.
      [2, { id: 2, parentId: 1, taxTreatment: 'none' }],
      [3, { id: 3, parentId: null, taxTreatment: 'none' }],
    ]),
    catTreatment: new Map([['Legacy Donations', 'donations']]),
    ...over,
  };
}

const row = (over: Partial<Parameters<typeof resolveTaxTreatment>[0]> = {}) => ({
  taxTreatmentOverride: null, finalCategoryId: null, finalCategory: null, ...over,
});

test('route 1: the per-transaction override wins', () => {
  assert.equal(
    resolveTaxTreatment(row({ taxTreatmentOverride: 'eligible_dividend', finalCategoryId: 1 }), maps()),
    'eligible_dividend',
  );
});

test('route 2: the category treatment applies', () => {
  assert.equal(resolveTaxTreatment(row({ finalCategoryId: 1 }), maps()), 'medical_expense');
});

test('route 2: a none child inherits its parent treatment', () => {
  assert.equal(resolveTaxTreatment(row({ finalCategoryId: 2 }), maps()), 'medical_expense');
});

test('route 3: the legacy name map applies when there is no category id', () => {
  assert.equal(
    resolveTaxTreatment(row({ finalCategory: 'Legacy Donations' }), maps()),
    'donations',
  );
});

test('route 4: a snake_case finalCategory keyword classifies the row', () => {
  // Pre-category data: the string itself is the treatment.
  assert.equal(
    resolveTaxTreatment(row({ finalCategory: 'employment_income' }), maps()),
    'employment_income',
  );
});

test('route 4 does not override a real category treatment', () => {
  // Only consulted when everything else resolved to 'none'.
  assert.equal(
    resolveTaxTreatment(row({ finalCategoryId: 1, finalCategory: 'employment_income' }), maps()),
    'medical_expense',
  );
});

test('a category id resolving to none falls through to the keyword', () => {
  // The keyword is `donations`, plural — `donation` is not in TAX_TREATMENTS and
  // resolves to 'none'. Both cases asserted, because getting this wrong in the
  // detector would silently classify a donation row as untouched.
  assert.equal(
    resolveTaxTreatment(row({ finalCategoryId: 3, finalCategory: 'donations' }), maps()),
    'donations',
  );
  assert.equal(
    resolveTaxTreatment(row({ finalCategoryId: 3, finalCategory: 'donation' }), maps()),
    'none',
  );
});

test('an unclassified row is none', () => {
  assert.equal(resolveTaxTreatment(row({ finalCategory: 'Groceries' }), maps()), 'none');
  assert.equal(isTaxClassified(row({ finalCategory: 'Groceries' }), maps()), false);
});

test('isTaxClassified is true for every route, not just the override', () => {
  // This is the assertion the duplicate detector depends on.
  assert.equal(isTaxClassified(row({ taxTreatmentOverride: 'salary' }), maps()), true);
  assert.equal(isTaxClassified(row({ finalCategoryId: 1 }), maps()), true);
  assert.equal(isTaxClassified(row({ finalCategoryId: 2 }), maps()), true);
  assert.equal(isTaxClassified(row({ finalCategory: 'Legacy Donations' }), maps()), true);
  assert.equal(isTaxClassified(row({ finalCategory: 'employment_income' }), maps()), true);
});
