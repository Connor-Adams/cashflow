/**
 * Unit tests for the pure per-type validation used by
 * POST /api/portfolio/activities (issue #301). Validation is a pure
 * function so it can be exercised without the DB or HTTP layer; the route
 * delegates to it and maps {ok:false} to a 400 with the returned code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateCorporateAction } from '../../src/portfolio/corporateActionValidation';

test('dividend_in_kind requires positive shares', () => {
  assert.deepEqual(
    validateCorporateAction({ activityType: 'dividend_in_kind', quantity: 5 }),
    { ok: true }
  );
  const bad = validateCorporateAction({ activityType: 'dividend_in_kind', quantity: 0 });
  assert.equal(bad.ok, false);
  assert.equal((bad as { code: string }).code, 'DIVIDEND_IN_KIND_REQUIRES_SHARES');
  const missing = validateCorporateAction({ activityType: 'dividend_in_kind' });
  assert.equal(missing.ok, false);
  assert.equal((missing as { code: string }).code, 'DIVIDEND_IN_KIND_REQUIRES_SHARES');
});

test('spin_off requires recipient, positive shares, and allocation in (0, 1]', () => {
  assert.deepEqual(
    validateCorporateAction({
      activityType: 'spin_off',
      recipientSecurityId: 7,
      quantity: 3,
      costBasisAllocationPct: 0.25,
    }),
    { ok: true }
  );
  // allocation of exactly 1 is allowed
  assert.deepEqual(
    validateCorporateAction({
      activityType: 'spin_off',
      recipientSecurityId: 7,
      quantity: 3,
      costBasisAllocationPct: 1,
    }),
    { ok: true }
  );

  const noRecipient = validateCorporateAction({
    activityType: 'spin_off',
    quantity: 3,
    costBasisAllocationPct: 0.25,
  });
  assert.equal((noRecipient as { code: string }).code, 'SPINOFF_REQUIRES_RECIPIENT');

  const noShares = validateCorporateAction({
    activityType: 'spin_off',
    recipientSecurityId: 7,
    costBasisAllocationPct: 0.25,
  });
  assert.equal((noShares as { code: string }).code, 'SPINOFF_REQUIRES_SHARES');

  const lowAlloc = validateCorporateAction({
    activityType: 'spin_off',
    recipientSecurityId: 7,
    quantity: 3,
    costBasisAllocationPct: 0,
  });
  assert.equal((lowAlloc as { code: string }).code, 'SPINOFF_ALLOCATION_OUT_OF_RANGE');

  const highAlloc = validateCorporateAction({
    activityType: 'spin_off',
    recipientSecurityId: 7,
    quantity: 3,
    costBasisAllocationPct: 1.5,
  });
  assert.equal((highAlloc as { code: string }).code, 'SPINOFF_ALLOCATION_OUT_OF_RANGE');
});

test('merger requires recipient and positive shares; cash component optional', () => {
  assert.deepEqual(
    validateCorporateAction({
      activityType: 'merger',
      recipientSecurityId: 9,
      quantity: 4,
    }),
    { ok: true }
  );
  assert.deepEqual(
    validateCorporateAction({
      activityType: 'merger',
      recipientSecurityId: 9,
      quantity: 4,
      cashComponent: 2.5,
    }),
    { ok: true }
  );

  const noRecipient = validateCorporateAction({ activityType: 'merger', quantity: 4 });
  assert.equal((noRecipient as { code: string }).code, 'MERGER_REQUIRES_RECIPIENT');

  const noShares = validateCorporateAction({ activityType: 'merger', recipientSecurityId: 9 });
  assert.equal((noShares as { code: string }).code, 'MERGER_REQUIRES_SHARES');
});

test('return_of_capital requires a positive amount', () => {
  assert.deepEqual(
    validateCorporateAction({ activityType: 'return_of_capital', amount: 100 }),
    { ok: true }
  );
  const zero = validateCorporateAction({ activityType: 'return_of_capital', amount: 0 });
  assert.equal((zero as { code: string }).code, 'ROC_REQUIRES_AMOUNT');
  const missing = validateCorporateAction({ activityType: 'return_of_capital' });
  assert.equal((missing as { code: string }).code, 'ROC_REQUIRES_AMOUNT');
});

test('non-corporate-action types pass through (buy/sell/split/drip/reinvestment)', () => {
  for (const t of ['buy', 'sell', 'split', 'drip', 'reinvestment', 'transfer_in']) {
    assert.deepEqual(
      validateCorporateAction({ activityType: t, quantity: 1, amount: 1 }),
      { ok: true },
      `type ${t} should pass through`
    );
  }
});
