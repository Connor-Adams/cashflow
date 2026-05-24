// ENCODED 2026-05-24 — from plan recall. NOT cross-checked against CRA T1-2024
// federal rate schedule or ON Min of Finance 2024 rate card. Engineer MUST
// verify every constant against the URLs in `sources` below before filing-grade use.
import { D } from '../util/decimal';
import type { RateTable } from '../engine/types';

export const RATES_2024: RateTable = {
  year: 2024,
  federalBrackets: [
    { upTo: D('55867'), rate: D('0.15') },
    { upTo: D('111733'), rate: D('0.205') },
    { upTo: D('173205'), rate: D('0.26') },
    { upTo: D('246752'), rate: D('0.29') },
    { upTo: null, rate: D('0.33') },
  ],
  provincialBrackets: [
    { upTo: D('51446'), rate: D('0.0505') },
    { upTo: D('102894'), rate: D('0.0915') },
    { upTo: D('150000'), rate: D('0.1116') },
    { upTo: D('220000'), rate: D('0.1216') },
    { upTo: null, rate: D('0.1316') },
  ],
  basicPersonalAmountFederal: D('15705'),
  bpaFederalPhaseoutStart: D('173205'),
  bpaFederalPhaseoutEnd: D('246752'),
  bpaFederalMin: D('14156'),
  basicPersonalAmountOntario: D('12399'),
  spousalAmountFederal: D('15705'),
  spousalAmountOntario: D('10527'),
  ageAmountFederal: D('8790'),
  ageAmountOntario: D('5916'),
  ageAmountAge: 65,
  ageAmountFederalThreshold: D('44325'),
  ageAmountOntarioThreshold: D('43127'),
  ageAmountFederalClawbackRate: D('0.15'),
  ageAmountOntarioClawbackRate: D('0.15'),
  employmentAmountFederal: D('1433'),
  dividendGrossUpEligible: D('0.38'),
  dividendGrossUpNonEligible: D('0.15'),
  dtcFederalEligible: D('0.150198'),
  dtcFederalNonEligible: D('0.090301'),
  dtcOntarioEligible: D('0.10'),
  dtcOntarioNonEligible: D('0.029863'),
  cpp: {
    ympe: D('68500'),
    yampe: D('73200'),
    basicExemption: D('3500'),
    employeeRate: D('0.0595'),
    cpp2Rate: D('0.04'),
  },
  ei: {
    maxInsurable: D('63200'),
    employeeRate: D('0.0166'),
  },
  capitalGainsInclusion: D('0.5'),
  onSurtaxBands: [
    { threshold: D('5554'), rate: D('0.20') },
    { threshold: D('7108'), rate: D('0.36') },
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
  medicalThresholdCap: D('2759'),
  // Disability Tax Credit — base amounts × 15% = credit value. 2024 CRA T2201.
  dtcBaseFederal: D('9872'),
  dtcSupplementFederal: D('5758'),   // under-18 supplement
  dtcSupplementThreshold: D('3373'), // child care & attendant expense reduction threshold
  dtcBaseOntario: D('9586'),
  // Caregiver amount L30450 base (infirm adult dependant)
  caregiverAmountFederalInfirmAdult: D('7999'),
  caregiverThresholdFederal: D('18783'), // net income threshold for reduction
  // Pension income amount
  pensionIncomeAmountCap: D('2000'),
  pensionIncomeAmountCapOntario: D('1641'),
  // OAS clawback (social benefits repayment) L23500
  oasClawbackThreshold: D('90997'),
  oasClawbackRate: D('0.15'),
  // FHSA annual deduction limit
  fhsaAnnualLimit: D('8000'),
  sources: [
    { name: 'CRA T1-2024 Federal rate schedule', url: 'https://www.canada.ca/en/revenue-agency/services/forms-publications/tax-packages-years/general-income-tax-benefit-package.html' },
    { name: 'ON Min of Finance 2024 personal income tax rates', url: 'https://www.fin.gov.on.ca/en/tax/pit/rates.html' },
  ],
};
