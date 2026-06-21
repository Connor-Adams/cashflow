import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATES_2026 } from './rates-2026';

// Bill C-4 (Royal Assent 2025-06-26) cut the lowest federal personal rate from
// 15% to 14% effective 2025-07-01. 2025 blends to 14.5%; 2026 is the first
// full year at 14%. The credit "appropriate percentage" (ITA s.248(1)) drops
// with it, so credits valued at the lowest rate use 14% too.
test('2026 lowest federal bracket rate is 14% (Bill C-4, first full year)', () => {
  assert.equal(RATES_2026.federalBrackets[0].rate.toString(), '0.14');
});

test('2026 appropriate percentage (donationLowRate) is 14%', () => {
  assert.equal(RATES_2026.donationLowRate.toString(), '0.14');
});
