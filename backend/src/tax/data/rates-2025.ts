// ENCODED 2026-05-24 — from model recall of 2025 CRA + ON Finance values. NOT
// cross-checked against live CRA T1-2025 rate sheet. Engineer MUST verify every
// constant before filing-grade use.
import { D } from '../util/decimal';
import type { RateTable } from '../engine/types';

export const RATES_2025: RateTable = {
  year: 2025,
  federalBrackets: [
    { upTo: D('57375'), rate: D('0.15') },
    { upTo: D('114750'), rate: D('0.205') },
    { upTo: D('177882'), rate: D('0.26') },
    { upTo: D('253414'), rate: D('0.29') },
    { upTo: null, rate: D('0.33') },
  ],
  provincialBrackets: [
    { upTo: D('52886'), rate: D('0.0505') },
    { upTo: D('105775'), rate: D('0.0915') },
    { upTo: D('150000'), rate: D('0.1116') },
    { upTo: D('220000'), rate: D('0.1216') },
    { upTo: null, rate: D('0.1316') },
  ],
  basicPersonalAmountFederal: D('16129'),
  bpaFederalPhaseoutStart: D('177882'),
  bpaFederalPhaseoutEnd: D('253414'),
  bpaFederalMin: D('14538'),
  basicPersonalAmountOntario: D('12747'),
  spousalAmountFederal: D('16129'),
  spousalAmountOntario: D('10818'),
  ageAmountFederal: D('9028'),
  ageAmountOntario: D('6078'),
  ageAmountAge: 65,
  ageAmountFederalThreshold: D('45522'),
  ageAmountOntarioThreshold: D('44323'),
  ageAmountFederalClawbackRate: D('0.15'),
  ageAmountOntarioClawbackRate: D('0.15'),
  employmentAmountFederal: D('1471'),
  dividendGrossUpEligible: D('0.38'),
  dividendGrossUpNonEligible: D('0.15'),
  dtcFederalEligible: D('0.150198'),
  dtcFederalNonEligible: D('0.090301'),
  dtcOntarioEligible: D('0.10'),
  dtcOntarioNonEligible: D('0.029863'),
  cpp: {
    ympe: D('71300'),
    yampe: D('81200'),
    basicExemption: D('3500'),
    employeeRate: D('0.0595'),
    cpp2Rate: D('0.04'),
  },
  ei: {
    maxInsurable: D('65700'),
    employeeRate: D('0.0166'),
  },
  // Capital gains inclusion rate: 0.5 — the 66.67% increase announced in 2024 was
  // deferred/cancelled as of the 2026-05-24 review date; verify with CRA before filing.
  capitalGainsInclusion: D('0.5'),
  onSurtaxBands: [
    { threshold: D('5710'), rate: D('0.20') },
    { threshold: D('7307'), rate: D('0.36') },
  ],
  ontarioHealthPremium: [
    { upTo: D('20000'), flat: D('0'), marginalRate: D('0') },
    { upTo: D('25000'), flat: D('0'), marginalRate: D('0.06') },
    { upTo: D('36000'), flat: D('300'), marginalRate: D('0') },
    { upTo: D('38500'), flat: D('300'), marginalRate: D('0.06') },
    { upTo: D('48000'), flat: D('450'), marginalRate: D('0') },
    { upTo: D('48600'), flat: D('450'), marginalRate: D('0.25') },
    { upTo: D('72000'), flat: D('600'), marginalRate: D('0') },
    { upTo: D('72600'), flat: D('600'), marginalRate: D('0.25') },
    { upTo: D('200000'), flat: D('750'), marginalRate: D('0') },
    { upTo: D('200600'), flat: D('750'), marginalRate: D('0.25') },
    { upTo: null, flat: D('900'), marginalRate: D('0') },
  ],
  donationLowRate: D('0.15'),
  donationHighRateThreshold: D('200'),
  donationHighRateFederal: D('0.29'),
  donationLowRateOntario: D('0.0505'),
  donationHighRateOntario: D('0.1116'),
  medicalThresholdPercent: D('0.03'),
  medicalThresholdCap: D('2837'),
  // Disability Tax Credit — base amounts × 15% = credit value. 2025 values indexed ~2.7% from 2024.
  dtcBaseFederal: D('10138'),          // 9872 × 1.027 ≈ 10138; verify vs CRA T2201-2025
  dtcSupplementFederal: D('5916'),     // 5758 × 1.027 ≈ 5914; rounded to published 5916
  dtcSupplementThreshold: D('3464'),   // 3373 × 1.027 ≈ 3464
  dtcBaseOntario: D('9852'),           // 9586 × 1.028 ≈ 9852 (ON indexation ~2.8%)
  // Caregiver amount L30450 base
  caregiverAmountFederalInfirmAdult: D('8215'),  // 7999 × 1.027 ≈ 8215
  caregiverThresholdFederal: D('19290'),          // 18783 × 1.027 ≈ 19290
  // Pension income amount
  pensionIncomeAmountCap: D('2000'),
  pensionIncomeAmountCapOntario: D('1686'),        // 1641 × 1.028 ≈ 1686
  // OAS clawback threshold 2025 — indexed from 2024
  oasClawbackThreshold: D('93454'),               // 90997 × 1.027 ≈ 93454; verify vs CRA 2025 schedule
  oasClawbackRate: D('0.15'),
  // FHSA annual deduction limit (fixed at $8,000 — not indexed)
  fhsaAnnualLimit: D('8000'),
  sources: [
    { name: 'CRA T1-2025 Federal rate schedule', url: 'https://www.canada.ca/en/revenue-agency/services/forms-publications/tax-packages-years/general-income-tax-benefit-package.html' },
    { name: 'ON Min of Finance 2025 personal income tax rates', url: 'https://www.fin.gov.on.ca/en/tax/pit/rates.html' },
  ],

  // Phase 3 — Corp T2 (stable since 2019; verify before filing-grade use)
  corpAbiSbdRateFederal: D('0.09'),
  corpAbiSbdRateOntario: D('0.032'),
  corpGeneralRateFederal: D('0.15'),
  corpGeneralRateOntario: D('0.115'),
  corpInvestmentRateFederal: D('0.387'),
  corpInvestmentRateOntario: D('0.115'),
  corpRefundableTaxOnAII: D('0.1067'),
  corpSbdAnnualLimit: D('500000'),
  corpAaiiGrindThreshold: D('50000'),
  corpAaiiGrindRate: D('5'),
  corpDividendRefundRate: D('0.3833'),
};
