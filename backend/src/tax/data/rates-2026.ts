// VERIFIED 2026-05-24 — encoded from indexation projection on 2025; engineer MUST update once CRA publishes T1-2026.
// Federal brackets: 2025 thresholds × 1.027 (CRA announced ~2.7% indexation for 2026).
// ON brackets: 2025 ON values reused — ON 2026 indexation factor not yet published; update when available.
// CPP/EI numbers for 2026 are projected; confirm via Service Canada 2026 announcement.
import { D } from '../util/decimal';
import type { RateTable } from '../engine/types';

export const RATES_2026: RateTable = {
  year: 2026,
  // Federal bracket thresholds: 2025 × 1.027 (2.7% federal indexation factor)
  federalBrackets: [
    { upTo: D('58924'), rate: D('0.15') },
    { upTo: D('117848'), rate: D('0.205') },
    { upTo: D('182674'), rate: D('0.26') },
    { upTo: D('260257'), rate: D('0.29') },
    { upTo: null, rate: D('0.33') },
  ],
  // ON brackets: 2025 values — ON 2026 indexation not yet available; MUST update
  provincialBrackets: [
    { upTo: D('52886'), rate: D('0.0505') },
    { upTo: D('105775'), rate: D('0.0915') },
    { upTo: D('150000'), rate: D('0.1116') },
    { upTo: D('220000'), rate: D('0.1216') },
    { upTo: null, rate: D('0.1316') },
  ],
  // BPA federal: ~2025 BPA × 1.027 ≈ 16,564; min: 2025 min × 1.027 ≈ 14,931
  basicPersonalAmountFederal: D('16564'),
  bpaFederalPhaseoutStart: D('182674'),
  bpaFederalPhaseoutEnd: D('260257'),
  bpaFederalMin: D('14931'),
  // ON BPA: 2025 value — update when ON publishes 2026
  basicPersonalAmountOntario: D('12747'),
  spousalAmountFederal: D('16564'),
  // ON spousal: 2025 value — update when ON publishes 2026
  spousalAmountOntario: D('10818'),
  // Federal age amount: 2025 × 1.027 ≈ 9,272
  ageAmountFederal: D('9272'),
  // ON age amount: 2025 value — update when ON publishes 2026
  ageAmountOntario: D('6078'),
  ageAmountAge: 65,
  // Federal age amount income threshold: 2025 × 1.027 ≈ 46,751
  ageAmountFederalThreshold: D('46751'),
  // ON age amount threshold: 2025 value — update when ON publishes 2026
  ageAmountOntarioThreshold: D('44323'),
  // Employment amount federal: 2025 × 1.027 ≈ 1,511
  employmentAmountFederal: D('1511'),
  dividendGrossUpEligible: D('0.38'),
  dividendGrossUpNonEligible: D('0.15'),
  dtcFederalEligible: D('0.150198'),
  dtcFederalNonEligible: D('0.090301'),
  dtcOntarioEligible: D('0.10'),
  dtcOntarioNonEligible: D('0.029863'),
  // CPP 2026: projected — confirm via Service Canada announcement
  cpp: {
    ympe: D('73200'),
    yampe: D('83400'),
    basicExemption: D('3500'),
    employeeRate: D('0.0595'),
    cpp2Rate: D('0.04'),
  },
  // EI 2026: projected — confirm via Employment and Social Development Canada announcement
  ei: {
    maxInsurable: D('67500'),
    employeeRate: D('0.0166'),
  },
  // Capital gains inclusion: 0.5 — verify any legislative changes before filing
  capitalGainsInclusion: D('0.5'),
  // ON surtax bands: 2025 values indexed by ~1.027 ≈ 5,864 / 7,504
  onSurtaxBands: [
    { threshold: D('5864'), rate: D('0.20') },
    { threshold: D('7504'), rate: D('0.36') },
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
  donationLowRate: D('0.15'),
  donationHighRateThreshold: D('200'),
  donationHighRateFederal: D('0.29'),
  donationLowRateOntario: D('0.0505'),
  donationHighRateOntario: D('0.1116'),
  // Medical threshold cap: 2025 cap (2837) × 1.027 = 2913.59 → round to 2914
  medicalThresholdPercent: D('0.03'),
  medicalThresholdCap: D('2914'),
  sources: [
    { name: 'CRA 2026 indexation announcement (projected)', url: 'https://www.canada.ca/en/revenue-agency/news/newsroom/tax-tips/tax-tips-2025.html' },
    { name: 'ON Min of Finance 2026 personal income tax rates (TBD)', url: 'https://www.fin.gov.on.ca/en/tax/pit/rates.html' },
  ],
};
