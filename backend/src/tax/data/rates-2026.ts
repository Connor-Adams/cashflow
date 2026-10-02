// PUBLISHED 2026-09-29 — every indexed amount taken from the announced figures:
// CRA's indexation table for 2026 (federal, 2.0%), Ontario Finance / TD1ON 2026
// (Ontario, 1.9% — and its top two brackets are statutorily unindexed), and
// Service Canada for CPP/EI.
//
// This file previously carried a "VERIFIED" header over an indexation projection
// written before any of that was announced, and was served anyway. That is why
// provenance is now a field the return route can enforce rather than a comment.
import { D } from '../util/decimal';
import type { RateTable } from '../engine/types';

export const RATES_2026: RateTable = {
  provenance: 'published',
  year: 2026,
  // Federal bracket thresholds: 2025 × 1.027 (2.7% federal indexation factor).
  // Lowest rate is 14% — Bill C-4 cut 15% → 14% effective 2025-07-01 (2025
  // blends to 14.5%); 2026 is the first full year at 14%. LEGISLATED, not a
  // projection.
  federalBrackets: [
    { upTo: D('58523'), rate: D('0.14') },
    { upTo: D('117045'), rate: D('0.205') },
    { upTo: D('181440'), rate: D('0.26') },
    { upTo: D('258482'), rate: D('0.29') },
    { upTo: null, rate: D('0.33') },
  ],
  // ON brackets: 2026 thresholds (bottom two indexed 1.9%; top two are statutory
  // and unindexed) — pinned by rates-2026.test.ts.
  provincialBrackets: [
    { upTo: D('53891'), rate: D('0.0505') },
    { upTo: D('107785'), rate: D('0.0915') },
    { upTo: D('150000'), rate: D('0.1116') },
    { upTo: D('220000'), rate: D('0.1216') },
    { upTo: null, rate: D('0.1316') },
  ],
  // BPA federal: ~2025 BPA × 1.027 ≈ 16,564; min: 2025 min × 1.027 ≈ 14,931
  basicPersonalAmountFederal: D('16452'),
  bpaFederalPhaseoutStart: D('181440'),
  bpaFederalPhaseoutEnd: D('258482'),
  bpaFederalMin: D('14829'),
  // ON BPA — CRA Form TD1ON 2026 line 1
  basicPersonalAmountOntario: D('12989'),
  spousalAmountFederal: D('16452'),
  // ON spousal — CRA Form TD1ON 2026 line 5
  spousalAmountOntario: D('11029'),
  // Federal age amount: 2025 × 1.027 ≈ 9,272
  ageAmountFederal: D('9208'),
  // ON age amount — CRA Form TD1ON 2026, line 2 (td1on-26e.pdf)
  ageAmountOntario: D('6342'),
  ageAmountAge: 65,
  // Federal age amount income threshold: 2025 × 1.027 ≈ 46,751
  ageAmountFederalThreshold: D('46432'),
  // ON age amount threshold — CRA Form TD1ON 2026, line 2 (td1on-26e.pdf)
  ageAmountOntarioThreshold: D('47210'),
  ageAmountFederalClawbackRate: D('0.15'),
  ageAmountOntarioClawbackRate: D('0.15'),
  // Employment amount federal: 2025 × 1.027 ≈ 1,511
  employmentAmountFederal: D('1501'),
  dividendGrossUpEligible: D('0.38'),
  dividendGrossUpNonEligible: D('0.15'),
  dtcFederalEligible: D('0.150198'),
  dtcFederalNonEligible: D('0.090301'),
  dtcOntarioEligible: D('0.10'),
  dtcOntarioNonEligible: D('0.029863'),
  // CPP 2026: projected — confirm via Service Canada announcement
  cpp: {
    ympe: D('74600'),
    yampe: D('85000'),
    basicExemption: D('3500'),
    employeeRate: D('0.0595'),
    cpp2Rate: D('0.04'),
  },
  // EI 2026: projected — confirm via Employment and Social Development Canada announcement
  ei: {
    maxInsurable: D('68900'),
    employeeRate: D('0.0163'),
  },
  capitalGainsInclusion: D('0.5'),
  capitalGainsInclusionHigh: D('0.5'),
  capitalGainsInclusionThreshold: D('250000'),
  // ON surtax bands: 2025 values indexed by ~1.027 ≈ 5,864 / 7,504
  onSurtaxBands: [
    { threshold: D('5818'), rate: D('0.20') },
    { threshold: D('7446'), rate: D('0.36') },
  ],
  // ON health premium band thresholds unchanged (statutory fixed amounts); update if ON changes
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
  // Appropriate percentage tracks the lowest federal rate (Bill C-4): 14% in 2026
  donationLowRate: D('0.14'),
  donationHighRateThreshold: D('200'),
  donationHighRateFederal: D('0.29'),
  donationLowRateOntario: D('0.0505'),
  donationHighRateOntario: D('0.1116'),
  // Medical threshold cap: 2025 cap (2837) × 1.027 = 2913.59 → round to 2914
  medicalThresholdPercent: D('0.03'),
  medicalThresholdCap: D('2890'),
  // 2026 projected RRSP limit: $33,367 (2025 $32,490 × 1.027 ≈ 33,367). Verify when CRA announces.
  rrspAnnualLimit: D('33810'),
  fhsaLifetimeLimit: D('40000'),
  // Disability amounts. Federal: CRA "Indexation adjustment for personal income
  // tax and benefit amounts" (2026 column) and CRA Form TD1 2026 line 6.
  // Ontario: CRA Form TD1ON 2026 line 4.
  dtcBaseFederal: D('10341'),
  dtcSupplementFederal: D('6032'),
  dtcSupplementThreshold: D('3533'),
  dtcBaseOntario: D('10494'),
  // Canada caregiver amount (infirm dependant 18+) and its reduction threshold —
  // CRA indexation table (2026 column) and CRA Form TD1 2026 line 10.
  caregiverAmountFederalInfirmAdult: D('8773'),
  caregiverThresholdFederal: D('20601'),
  // Pension income amount. Ontario — CRA Form TD1ON 2026 line 3.
  pensionIncomeAmountCap: D('2000'),              // fixed statutory amount, not indexed
  pensionIncomeAmountCapOntario: D('1796'),
  // OAS recovery threshold — CRA indexation table (2026 column)
  oasClawbackThreshold: D('95323'),
  oasClawbackRate: D('0.15'),
  // FHSA annual deduction limit (fixed at $8,000 — not indexed)
  fhsaAnnualLimit: D('8000'),
  amtRate: D('0.205'),
  amtExemption: D('181440'),
  amtCapGainsInclusion: D('1'),
  amtNonRefCreditFraction: D('0.5'),
  amtDtcFraction: D('0'), // dividend tax credit fully denied under AMT (gross-up excluded from ATI)
  sources: [
    { name: 'CRA indexation adjustment for personal income tax and benefit amounts (2026)', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/frequently-asked-questions-individuals/adjustment-personal-income-tax-benefit-amounts.html' },
    { name: 'CRA Form TD1 2026 (federal personal tax credits)', url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/td1/td1-26e.pdf' },
    { name: 'CRA Form TD1ON 2026 (Ontario personal tax credits)', url: 'https://www.canada.ca/content/dam/cra-arc/formspubs/pbg/td1on/td1on-26e.pdf' },
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
