// PROJECTED 2026-09-14 — NOT filing-grade. CRA publishes the real 2027
// indexation factor in ~Nov 2026 and Ontario follows in its own release; an
// engineer MUST replace these numbers once both are out.
//
// Every indexed amount here is the 2026 value × INDEXATION_FACTOR_2027,
// rounded half-up to the nearest dollar (CRA's convention). The factor is an
// assumption, not an announcement — see the constant's comment.
//
// What is NOT indexed (and therefore copied from 2026 verbatim):
//   - tax RATES (federal + ON brackets, corp T2, dividend gross-up/DTC, AMT
//     rate, clawback rates) — these only move by legislation, and none is
//     announced for 2027.
//   - statutorily fixed dollar amounts: CPP basic exemption ($3,500), the
//     federal pension income amount ($2,000), FHSA limits ($8,000/$40,000),
//     the donation first-tier threshold ($200), the capital-gains inclusion
//     threshold ($250,000), and the corp SBD limit / AAII grind threshold.
//   - ON's top two bracket thresholds ($150,000 / $220,000), which Ontario
//     does not index.
//   - the ON health premium bands, which are fixed statutory amounts.
//
// Caveat on CPP/EI/RRSP: YMPE, YAMPE, the EI maximum insurable earnings and
// the RRSP dollar limit track average *wage* growth, not CPI. They are indexed
// by the same factor here as a rough proxy; expect them to be the least
// accurate numbers in this table.
import { D } from '../util/decimal';
import type { RateTable } from '../engine/types';

/**
 * Assumed 2027 indexation factor (2.0%).
 *
 * CRA's factor is derived from the CPI average for the 12 months ending
 * 30 September of the prior year and is announced in November. As of the date
 * this file was written that announcement has not happened, so 2.0% is a
 * placeholder near the Bank of Canada's inflation target. Change this constant
 * (and re-derive every `× factor` amount below) when the real figure lands.
 */
export const INDEXATION_FACTOR_2027 = 1.02;

export const RATES_2027: RateTable = {
  year: 2027,
  // 2026 thresholds × 1.02. Rates unchanged — 14% lowest rate is Bill C-4,
  // already fully phased in as of 2026.
  federalBrackets: [
    { upTo: D('60102'), rate: D('0.14') },
    { upTo: D('120205'), rate: D('0.205') },
    { upTo: D('186327'), rate: D('0.26') },
    { upTo: D('265462'), rate: D('0.29') },
    { upTo: null, rate: D('0.33') },
  ],
  // ON: lower two thresholds indexed; $150,000 and $220,000 are not indexed by
  // statute and stay put.
  provincialBrackets: [
    { upTo: D('53944'), rate: D('0.0505') },
    { upTo: D('107891'), rate: D('0.0915') },
    { upTo: D('150000'), rate: D('0.1116') },
    { upTo: D('220000'), rate: D('0.1216') },
    { upTo: null, rate: D('0.1316') },
  ],
  basicPersonalAmountFederal: D('16895'), // 16564 × 1.02
  // Phaseout runs between the bottom of the 4th and 5th federal brackets.
  bpaFederalPhaseoutStart: D('186327'),
  bpaFederalPhaseoutEnd: D('265462'),
  bpaFederalMin: D('15230'), // 14931 × 1.02
  basicPersonalAmountOntario: D('13002'), // 12747 × 1.02
  spousalAmountFederal: D('16895'), // tracks the federal BPA
  spousalAmountOntario: D('11034'), // 10818 × 1.02
  ageAmountFederal: D('9457'), // 9272 × 1.02
  ageAmountOntario: D('6200'), // 6078 × 1.02
  ageAmountAge: 65,
  ageAmountFederalThreshold: D('47686'), // 46751 × 1.02
  ageAmountOntarioThreshold: D('45209'), // 44323 × 1.02
  ageAmountFederalClawbackRate: D('0.15'),
  ageAmountOntarioClawbackRate: D('0.15'),
  employmentAmountFederal: D('1541'), // 1511 × 1.02
  dividendGrossUpEligible: D('0.38'),
  dividendGrossUpNonEligible: D('0.15'),
  dtcFederalEligible: D('0.150198'),
  dtcFederalNonEligible: D('0.090301'),
  dtcOntarioEligible: D('0.10'),
  dtcOntarioNonEligible: D('0.029863'),
  // CPP: wage-indexed in reality; CPI factor used as a proxy. Rates are the
  // legislated steady-state (base 5.95% + CPP2 4.00%).
  cpp: {
    ympe: D('74664'), // 73200 × 1.02 — PROXY
    yampe: D('85068'), // 83400 × 1.02 — PROXY
    basicExemption: D('3500'), // fixed by statute
    employeeRate: D('0.0595'),
    cpp2Rate: D('0.04'),
  },
  // EI: MIE is wage-indexed; rate is set annually by the EI Commission and is
  // carried forward from 2026 for want of an announcement.
  ei: {
    maxInsurable: D('68850'), // 67500 × 1.02 — PROXY
    employeeRate: D('0.0166'),
  },
  capitalGainsInclusion: D('0.5'),
  capitalGainsInclusionHigh: D('0.666667'),
  capitalGainsInclusionThreshold: D('250000'), // fixed
  onSurtaxBands: [
    { threshold: D('5981'), rate: D('0.20') }, // 5864 × 1.02
    { threshold: D('7654'), rate: D('0.36') }, // 7504 × 1.02
  ],
  // ON health premium bands are fixed statutory amounts — copied verbatim.
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
  donationLowRate: D('0.14'), // appropriate percentage = lowest federal rate
  donationHighRateThreshold: D('200'), // fixed
  donationHighRateFederal: D('0.29'),
  donationLowRateOntario: D('0.0505'),
  donationHighRateOntario: D('0.1116'),
  medicalThresholdPercent: D('0.03'),
  medicalThresholdCap: D('2972'), // 2914 × 1.02
  rrspAnnualLimit: D('34034'), // 33367 × 1.02 — PROXY (wage-indexed in reality)
  fhsaLifetimeLimit: D('40000'), // fixed
  dtcBaseFederal: D('10620'), // 10412 × 1.02
  dtcSupplementFederal: D('6197'), // 6075 × 1.02
  dtcSupplementThreshold: D('3629'), // 3558 × 1.02
  dtcBaseOntario: D('10049'), // 9852 × 1.02
  caregiverAmountFederalInfirmAdult: D('8606'), // 8437 × 1.02
  caregiverThresholdFederal: D('20207'), // 19811 × 1.02
  pensionIncomeAmountCap: D('2000'), // fixed by statute, never indexed
  pensionIncomeAmountCapOntario: D('1720'), // 1686 × 1.02
  oasClawbackThreshold: D('97897'), // 95977 × 1.02
  oasClawbackRate: D('0.15'),
  fhsaAnnualLimit: D('8000'), // fixed
  amtRate: D('0.205'),
  amtExemption: D('186327'), // bottom of the 4th federal bracket
  amtCapGainsInclusion: D('1'),
  amtNonRefCreditFraction: D('0.5'),
  amtDtcFraction: D('0'),
  sources: [
    { name: 'CRA indexation announcement — 2027 NOT YET PUBLISHED (values projected)', url: 'https://www.canada.ca/en/revenue-agency/services/tax/individuals/frequently-asked-questions-individuals/adjustment-personal-income-tax-benefit-amounts.html' },
    { name: 'ON Min of Finance personal income tax rates — 2027 TBD', url: 'https://www.fin.gov.on.ca/en/tax/pit/rates.html' },
  ],

  // Corp T2 — stable since 2019, no 2027 change announced.
  corpAbiSbdRateFederal: D('0.09'),
  corpAbiSbdRateOntario: D('0.032'),
  corpGeneralRateFederal: D('0.15'),
  corpGeneralRateOntario: D('0.115'),
  corpInvestmentRateFederal: D('0.387'),
  corpInvestmentRateOntario: D('0.115'),
  corpRefundableTaxOnAII: D('0.1067'),
  corpSbdAnnualLimit: D('500000'), // fixed
  corpAaiiGrindThreshold: D('50000'), // fixed
  corpAaiiGrindRate: D('5'),
  corpDividendRefundRate: D('0.3833'),
};
