/**
 * A projected rate table must not be served as a closed year's return.
 *
 * This is the guard against the exact failure this part of the plan fixes.
 * `rates-2026.ts:1-4` carried an honest header — "encoded from indexation
 * projection… engineer MUST update once CRA publishes" — and the route served it
 * anyway for months. A citation test would have passed. Only a machine-checked
 * field, enforced where the table is chosen, catches it.
 *
 * Deliberately period-based rather than year-based: a corp fiscal year ending
 * 2026-06-30 is closed in 2026, and a personal 2026 year is not.
 *
 * Note the limitation, stated rather than papered over: 2026 does not close until
 * 2026-12-31, so in the window Connor actually works in the refusal branch is
 * dormant and these tests reach it only through a synthetic closed period. The
 * live behaviour for an OPEN year — surfacing a projected table as a gap — is
 * part 3's completeness report, and is tested there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRatesUsable, ProjectedRatesError } from './rateProvenance';
import { RATES_2026 } from '../data/rates-2026';
import { RATES_2027 } from '../data/rates-2027';
import { RATES_2024 } from '../data/rates-2024';

const NOW = new Date('2026-09-29T12:00:00Z');

test('a projected table is refused once the period has closed', () => {
  assert.throws(
    () => assertRatesUsable(RATES_2027, { periodEnd: '2025-12-31', now: NOW }),
    ProjectedRatesError,
  );
});

test('the refusal names the year and the file to fix', () => {
  // A 409 body that says only "unusable" sends the reader nowhere.
  try {
    assertRatesUsable(RATES_2027, { periodEnd: '2025-12-31', now: NOW });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.ok(err instanceof ProjectedRatesError);
    assert.match(err.message, /2027/);
    assert.match(err.message, /rates-2027\.ts/);
  }
});

test('a projected table is allowed while the period is still open', () => {
  // The whole point of a projection: forward-looking scenarios must still run.
  assertRatesUsable(RATES_2027, { periodEnd: '2027-12-31', now: NOW });
});

test('a period ending today is still open', () => {
  // Filing for a year cannot be required before the year has actually ended.
  assertRatesUsable(RATES_2027, { periodEnd: '2026-09-29', now: NOW });
});

test('a period that ended yesterday is closed', () => {
  assert.throws(
    () => assertRatesUsable(RATES_2027, { periodEnd: '2026-09-28', now: NOW }),
    ProjectedRatesError,
  );
});

test('a published table is allowed for a closed period', () => {
  assertRatesUsable(RATES_2026, { periodEnd: '2020-12-31', now: NOW });
});

test('an off-calendar corp year closing mid-2026 is closed in 2026', () => {
  // Year-based logic would call 2026 open and serve a projected table for a
  // fiscal year that has already ended.
  assert.throws(
    () => assertRatesUsable(RATES_2027, { periodEnd: '2026-06-30', now: NOW }),
    ProjectedRatesError,
  );
});

test('the 2024 table, encoded from recall, is refused', () => {
  // Not hypothetical: rates-2024.ts says "from plan recall. NOT cross-checked",
  // and 2024 is filed. Serving it as authoritative is the failure being fixed.
  assert.throws(
    () => assertRatesUsable(RATES_2024, { periodEnd: '2024-12-31', now: NOW }),
    ProjectedRatesError,
  );
});

test('the error carries status 409 so uncaught paths still answer 4xx', () => {
  // The scenario routes have no local rate-error branch; `getErrorStatus` reads
  // `status` off the error, and `getClientErrorMessage` passes 4xx messages
  // through. Without this the T1 tab would get a bare 500.
  const err = new ProjectedRatesError(2024, '2024-12-31');
  assert.equal((err as unknown as { status: number }).status, 409);
});
