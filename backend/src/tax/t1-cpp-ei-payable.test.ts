/**
 * TDD test for CPP/EI payable bug fix (issue: employment CPP/EI incorrectly
 * included in L43500 Total payable).
 *
 * On a real CRA T1, line 43500 "Total payable" does NOT include employment
 * CPP/EI — those are remitted via payroll (T4 box 16/18). The only T1 effect
 * of employment CPP/EI is the 15% non-refundable credit already applied at
 * line ~140 (cppEiCreditAmount). Adding them to totalPayable without crediting
 * the withheld amounts overstates refundOrOwing for every taxpayer with
 * employment income.
 *
 * Test case: T4 box14=28514, box22=3775.16 (typical moderate-income T4 return).
 *   cpp = (28514 - 3500) * 0.0595 = 1488.33
 *   ei  = 28514 * 0.0166 = 473.33
 *   cpp + ei = 1961.66 (should NOT appear in totalPayable)
 *
 * Correct totalPayable = federalTax + onTax + onSurtax + ohp + oasRepayment
 *                      = 1412.15 + 714.74 + 0.00 + 300.00 + 0.00
 *                      = 2426.89
 *
 * With withholding of 3775.16, correct refundOrOwing = 2426.89 - 3775.16 = -1348.27 (REFUND)
 * Buggy refundOrOwing = 4388.56 - 3775.16 = +613.40 (wrongly balance owing)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D } from './util/decimal.js';
import { ratesFor } from './engine/brackets.js';
import { buildT1 } from './engine/t1.js';
import type { TaxYearFacts } from './engine/types.js';

test('T1 totalPayable excludes employment CPP/EI (L43500 bug fix)', () => {
  const r = ratesFor(2024);

  // T4 slip: box14 = $28,514 employment income, box22 = $3,775.16 income tax withheld.
  // cpp  = (min(28514, 68500) - 3500) * 0.0595 = 25014 * 0.0595 = 1488.333...
  // ei   = min(28514, 63200) * 0.0166 = 28514 * 0.0166 = 473.3324
  // cpp + ei = 1961.6654 (must NOT be in totalPayable)
  const facts: TaxYearFacts = {
    year: 2024,
    jurisdiction: 'CA-ON',
    employmentIncome: [{ source: 'T4', amount: D('28514'), cadAmount: D('28514') }],
    selfEmploymentIncome: [],
    selfEmploymentExpenses: [],
    interestIncome: [],
    eligibleDividends: [],
    nonEligibleDividends: [],
    capitalGainEvents: [],
    rrspContribs: [],
    fhsaContribs: [],
    donations: [],
    slips: [
      {
        slipId: 1,
        slipType: 'T4',
        issuer: 'Employer',
        boxes: { box14: D('28514'), box22: D('3775.16') },
      },
    ],
    carryforwards: {
      netCapitalLoss: D('0'),
      rrspRoom: D('0'),
      nonCapLoss: D('0'),
      instalmentsPaid: D('0'),
      fhsaLifetimeContributions: D('0'),
    },
    ageAtYearEnd: 40,
    rentalIncome: [],
    rentalExpenses: [],
    medicalExpenses: [],
  };

  const ret = buildT1(facts, r);

  // cppContrib + eiPremium are still reported in totals (needed for credit line
  // and downstream reporting), just not in totalPayable.
  assert.equal(ret.totals.cppContrib.toFixed(2), '1488.33', 'cppContrib should still be computed');
  assert.equal(ret.totals.eiPremium.toFixed(2), '473.33', 'eiPremium should still be computed');

  // totalPayable must equal federalTax + onTax + onSurtax + ohp + oasRepayment only.
  // For this income level: 1412.15 + 714.74 + 0.00 + 300.00 + 0.00 = 2426.89
  const expectedTotalPayable = D('2426.89');
  assert.equal(
    ret.totals.totalPayable.toFixed(2),
    expectedTotalPayable.toFixed(2),
    `totalPayable should be ${expectedTotalPayable.toFixed(2)} (fedTax+onTax+onSurtax+ohp), ` +
    `not include CPP (1488.33) + EI (473.33) = 1961.66`,
  );

  // With $3,775.16 withheld, this taxpayer gets a REFUND (negative refundOrOwing).
  // Buggy engine would return +613.40 (balance owing) — wrong.
  assert.ok(
    ret.totals.refundOrOwing.lessThan(D('0')),
    `refundOrOwing should be negative (refund) when withholding exceeds true tax; ` +
    `got ${ret.totals.refundOrOwing.toFixed(2)}`,
  );
  assert.equal(
    ret.totals.refundOrOwing.toFixed(2),
    '-1348.27',
    'refundOrOwing should be -1348.27 (2426.89 payable minus 3775.16 withheld)',
  );

  // The L43500 line must match the corrected totalPayable.
  const l43500 = ret.lines.find((l) => l.code === 'L43500');
  assert.ok(l43500, 'L43500 line must be present');
  assert.equal(
    l43500!.amount.toFixed(2),
    expectedTotalPayable.toFixed(2),
    'L43500 line amount must equal corrected totalPayable',
  );
});
