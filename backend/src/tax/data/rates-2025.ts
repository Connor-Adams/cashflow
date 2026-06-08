// VERIFIED 2026-06-08 — cross-checked against CRA T1-2025 rate schedule,
// Ontario Finance 2025 personal income tax publications, CRA payroll deduction
// tables, and RCGT 2025 tax planning guide tables.
// Bill C-4 middle-class tax cut: lowest federal rate 15% → 14% effective
// 2025-07-01; blended full-year rate for 2025 is 14.5%.
// Capital gains inclusion rate increase (to 66.67%) cancelled by PM Carney
// 2025-03-21; rate remains 50% for all taxpayers with no tiered threshold.
import { D } from '../util/decimal';
import type { RateTable } from '../engine/types';

export const RATES_2025: RateTable = {
  year: 2025,
  federalBrackets: [
    { upTo: D('57375'), rate: D('0.145') },
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
  spousalAmountOntario: D('10823'),
  ageAmountFederal: D('9028'),
  ageAmountOntario: D('6223'),
  ageAmountAge: 65,
  ageAmountFederalThreshold: D('45522'),
  ageAmountOntarioThreshold: D('46330'),
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
    employeeRate: D('0.0164'),
  },
  // Capital gains inclusion rate: proposed increase to 66.67% above $250K was
  // cancelled by PM Carney on 2025-03-21. Rate remains 50% for all taxpayers.
  // The high-rate fields are retained at 50% (no tiered bump) so downstream
  // code that references them still compiles and produces correct results.
  capitalGainsInclusion: D('0.5'),
  capitalGainsInclusionHigh: D('0.5'),
  capitalGainsInclusionThreshold: D('250000'),
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
  donationLowRate: D('0.145'),
  donationHighRateThreshold: D('200'),
  donationHighRateFederal: D('0.29'),
  donationLowRateOntario: D('0.0505'),
  donationHighRateOntario: D('0.1116'),
  medicalThresholdPercent: D('0.03'),
  medicalThresholdCap: D('2834'),
  rrspAnnualLimit: D('32490'),
  fhsaLifetimeLimit: D('40000'),
  // Disability Tax Credit — base amounts × lowest rate = credit value.
  dtcBaseFederal: D('10138'),          // CRA Line 31600, 2025
  dtcSupplementFederal: D('5914'),     // CRA supplement for under 18, 2025
  dtcSupplementThreshold: D('3464'),   // child care/attendant care threshold for supplement reduction
  dtcBaseOntario: D('10298'),          // RCGT ON 2025 table
  // Canada Caregiver Credit L30450 — infirm dependant 18+
  caregiverAmountFederalInfirmAdult: D('8601'),  // CRA 2025
  caregiverThresholdFederal: D('20197'),          // dependant net income reduction threshold, 2025
  // Pension income amount
  pensionIncomeAmountCap: D('2000'),
  pensionIncomeAmountCapOntario: D('1762'),        // RCGT ON 2025 table
  // OAS clawback threshold 2025 — CRA recovery tax schedule
  oasClawbackThreshold: D('93454'),               // CRA 2025 minimum income recovery threshold
  oasClawbackRate: D('0.15'),
  // FHSA annual deduction limit (fixed at $8,000 — not indexed)
  fhsaAnnualLimit: D('8000'),
  amtRate: D('0.205'),
  amtExemption: D('177882'),
  amtCapGainsInclusion: D('1'),
  amtNonRefCreditFraction: D('0.5'),
  amtDtcFraction: D('0.5'),
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
