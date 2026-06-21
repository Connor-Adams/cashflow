/**
 * Pure tests for `validateCashflowSettingsPatch` (issue #199).
 *
 * Exercises every branch in the PATCH-body validator without booting the
 * auth + DB stack. The integration test
 * `integration/cashflowSettings.test.ts` covers route wiring + DB writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCashflowSettingsPatch } from './cashflowSettings';

test('empty body is valid (no-op patch)', () => {
  const r = validateCashflowSettingsPatch({});
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.patch, {});
});

test('minimumCashBuffer accepts non-negative number, normalises to 4dp string', () => {
  const r = validateCashflowSettingsPatch({ minimumCashBuffer: 500 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.minimumCashBuffer, '500.0000');
});

test('minimumCashBuffer accepts zero', () => {
  const r = validateCashflowSettingsPatch({ minimumCashBuffer: 0 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.minimumCashBuffer, '0.0000');
});

test('minimumCashBuffer accepts string-number', () => {
  const r = validateCashflowSettingsPatch({ minimumCashBuffer: '123.4567' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.minimumCashBuffer, '123.4567');
});

test('minimumCashBuffer rejects negative number', () => {
  const r = validateCashflowSettingsPatch({ minimumCashBuffer: -1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /non-negative/);
});

test('minimumCashBuffer rejects non-numeric', () => {
  const r = validateCashflowSettingsPatch({ minimumCashBuffer: 'abc' });
  assert.equal(r.ok, false);
});

test('safeToSpendWindowDays accepts integer within range', () => {
  const r = validateCashflowSettingsPatch({ safeToSpendWindowDays: 30 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.safeToSpendWindowDays, 30);
});

test('safeToSpendWindowDays accepts the boundary 1', () => {
  const r = validateCashflowSettingsPatch({ safeToSpendWindowDays: 1 });
  assert.equal(r.ok, true);
});

test('safeToSpendWindowDays accepts the boundary 365', () => {
  const r = validateCashflowSettingsPatch({ safeToSpendWindowDays: 365 });
  assert.equal(r.ok, true);
});

test('safeToSpendWindowDays rejects 0', () => {
  const r = validateCashflowSettingsPatch({ safeToSpendWindowDays: 0 });
  assert.equal(r.ok, false);
});

test('safeToSpendWindowDays rejects > 365', () => {
  const r = validateCashflowSettingsPatch({ safeToSpendWindowDays: 366 });
  assert.equal(r.ok, false);
});

test('safeToSpendWindowDays rejects non-integer', () => {
  const r = validateCashflowSettingsPatch({ safeToSpendWindowDays: 14.5 });
  assert.equal(r.ok, false);
});

test('includeCreditCardBalance accepts boolean true/false', () => {
  const t = validateCashflowSettingsPatch({ includeCreditCardBalance: true });
  const f = validateCashflowSettingsPatch({ includeCreditCardBalance: false });
  assert.equal(t.ok, true);
  if (t.ok) assert.equal(t.patch.includeCreditCardBalance, true);
  assert.equal(f.ok, true);
  if (f.ok) assert.equal(f.patch.includeCreditCardBalance, false);
});

test('includeCreditCardBalance accepts string "true"/"false"', () => {
  const t = validateCashflowSettingsPatch({ includeCreditCardBalance: 'true' });
  const f = validateCashflowSettingsPatch({ includeCreditCardBalance: 'false' });
  assert.equal(t.ok, true);
  if (t.ok) assert.equal(t.patch.includeCreditCardBalance, true);
  assert.equal(f.ok, true);
  if (f.ok) assert.equal(f.patch.includeCreditCardBalance, false);
});

test('includeCreditCardBalance rejects garbage strings', () => {
  const r = validateCashflowSettingsPatch({ includeCreditCardBalance: 'maybe' });
  assert.equal(r.ok, false);
});

test('includeGoalContributions accepts 1/0 numeric truthiness', () => {
  const t = validateCashflowSettingsPatch({ includeGoalContributions: 1 });
  const f = validateCashflowSettingsPatch({ includeGoalContributions: 0 });
  assert.equal(t.ok, true);
  if (t.ok) assert.equal(t.patch.includeGoalContributions, true);
  assert.equal(f.ok, true);
  if (f.ok) assert.equal(f.patch.includeGoalContributions, false);
});

test('combined patch carries all four fields', () => {
  const r = validateCashflowSettingsPatch({
    minimumCashBuffer: 250,
    safeToSpendWindowDays: 21,
    includeCreditCardBalance: false,
    includeGoalContributions: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.patch.minimumCashBuffer, '250.0000');
    assert.equal(r.patch.safeToSpendWindowDays, 21);
    assert.equal(r.patch.includeCreditCardBalance, false);
    assert.equal(r.patch.includeGoalContributions, true);
  }
});

test('unknown fields are ignored (not included in patch)', () => {
  const r = validateCashflowSettingsPatch({
    minimumCashBuffer: 100,
    bogusField: 'ignored',
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.patch.minimumCashBuffer, '100.0000');
    assert.ok(!('bogusField' in r.patch));
  }
});

// --- counterpartyPromotionThreshold (#373) --------------------------------

test('counterpartyPromotionThreshold accepts integer within range', () => {
  const r = validateCashflowSettingsPatch({ counterpartyPromotionThreshold: 5 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.counterpartyPromotionThreshold, 5);
});

test('counterpartyPromotionThreshold accepts the lower boundary 2', () => {
  const r = validateCashflowSettingsPatch({ counterpartyPromotionThreshold: 2 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.counterpartyPromotionThreshold, 2);
});

test('counterpartyPromotionThreshold accepts the upper boundary 50', () => {
  const r = validateCashflowSettingsPatch({ counterpartyPromotionThreshold: 50 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.counterpartyPromotionThreshold, 50);
});

test('counterpartyPromotionThreshold rejects 1 (below minimum)', () => {
  const r = validateCashflowSettingsPatch({ counterpartyPromotionThreshold: 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /counterpartyPromotionThreshold/);
});

test('counterpartyPromotionThreshold rejects 51 (above maximum)', () => {
  const r = validateCashflowSettingsPatch({ counterpartyPromotionThreshold: 51 });
  assert.equal(r.ok, false);
});

test('counterpartyPromotionThreshold rejects non-integer', () => {
  const r = validateCashflowSettingsPatch({ counterpartyPromotionThreshold: 3.5 });
  assert.equal(r.ok, false);
});

test('counterpartyPromotionThreshold rejects non-numeric', () => {
  const r = validateCashflowSettingsPatch({ counterpartyPromotionThreshold: 'three' });
  assert.equal(r.ok, false);
});

// ---------------- #375 excludeNonPartnerInflows -------------------------

test('excludeNonPartnerInflows accepts boolean true/false', () => {
  const t = validateCashflowSettingsPatch({ excludeNonPartnerInflows: true });
  const f = validateCashflowSettingsPatch({ excludeNonPartnerInflows: false });
  assert.equal(t.ok, true);
  if (t.ok) assert.equal(t.patch.excludeNonPartnerInflows, true);
  assert.equal(f.ok, true);
  if (f.ok) assert.equal(f.patch.excludeNonPartnerInflows, false);
});

test('excludeNonPartnerInflows accepts string "true"/"false"', () => {
  const t = validateCashflowSettingsPatch({ excludeNonPartnerInflows: 'true' });
  const f = validateCashflowSettingsPatch({ excludeNonPartnerInflows: 'false' });
  assert.equal(t.ok, true);
  if (t.ok) assert.equal(t.patch.excludeNonPartnerInflows, true);
  assert.equal(f.ok, true);
  if (f.ok) assert.equal(f.patch.excludeNonPartnerInflows, false);
});

test('excludeNonPartnerInflows rejects garbage values', () => {
  const r = validateCashflowSettingsPatch({ excludeNonPartnerInflows: 'sometimes' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /excludeNonPartnerInflows must be boolean/);
});

// ---------------- #654 assumedAnnualReturnRate -------------------------

test('assumedAnnualReturnRate accepts an in-range decimal, normalises to 4dp', () => {
  const r = validateCashflowSettingsPatch({ assumedAnnualReturnRate: 0.07 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.assumedAnnualReturnRate, '0.0700');
});

test('assumedAnnualReturnRate accepts the lower boundary 0', () => {
  const r = validateCashflowSettingsPatch({ assumedAnnualReturnRate: 0 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.assumedAnnualReturnRate, '0.0000');
});

test('assumedAnnualReturnRate accepts the upper boundary 1', () => {
  const r = validateCashflowSettingsPatch({ assumedAnnualReturnRate: 1 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.patch.assumedAnnualReturnRate, '1.0000');
});

test('assumedAnnualReturnRate rejects a value above 1', () => {
  const r = validateCashflowSettingsPatch({ assumedAnnualReturnRate: 1.5 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /assumedAnnualReturnRate/);
});

test('assumedAnnualReturnRate rejects a negative value', () => {
  const r = validateCashflowSettingsPatch({ assumedAnnualReturnRate: -0.01 });
  assert.equal(r.ok, false);
});

test('assumedAnnualReturnRate rejects non-numeric', () => {
  const r = validateCashflowSettingsPatch({ assumedAnnualReturnRate: 'high' });
  assert.equal(r.ok, false);
});
