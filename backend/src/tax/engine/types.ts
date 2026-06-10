import type { Decimal } from '../util/decimal';

export type Currency = 'CAD' | 'USD' | string;

export type SlipBoxes = Record<string, Decimal>;

export type SlipFact = {
  slipId: number;
  slipType: 'T4' | 'T5' | 'T3' | 'T4A' | 'T5008';
  issuer: string;
  boxes: SlipBoxes;
};

export type IncomeItem = {
  source: string;
  amount: Decimal;
  cadAmount: Decimal;
};

export type CapGainEvent = {
  source: string;
  securityId: number;
  proceeds: Decimal;
  acb: Decimal;
  outlays: Decimal;
  date: string;
  superficialLossDenied?: Decimal;
};

export type RrspContrib = {
  source: string;
  amount: Decimal;
  date: string;
};

export type PersonalCarryforwards = {
  netCapitalLoss: Decimal;
  rrspRoom: Decimal;
  nonCapLoss: Decimal;
  instalmentsPaid: Decimal;
  /** Cumulative FHSA contributions across all years (tracks $40k lifetime cap). */
  fhsaLifetimeContributions: Decimal;
};

export type CorpFiscalYear = {
  startDate: string;   // 'YYYY-MM-DD'
  endDate: string;     // 'YYYY-MM-DD'
};

export type CorpDividendPaid = {
  source: string;
  date: string;
  amount: Decimal;
  kind: 'eligible' | 'non_eligible';
};

export type CorpCarryforwards = {
  grip: Decimal;          // General Rate Income Pool balance start of year
  cda: Decimal;           // Capital Dividend Account balance start of year
  erdtoh: Decimal;        // Eligible Refundable Dividend Tax On Hand start of year
  nerdtoh: Decimal;       // Non-Eligible RDTOH start of year
  nonCapLoss: Decimal;
  netCapitalLoss: Decimal;
};

export type CorpTaxYearFacts = {
  fiscalYear: CorpFiscalYear;
  jurisdiction: 'CA-ON';
  activeBusinessIncome: IncomeItem[];   // revenue - expenses, net
  investmentIncome: {
    interest: IncomeItem[];
    eligibleDividends: IncomeItem[];
    nonEligibleDividends: IncomeItem[];
    rentNet: IncomeItem[];
  };
  capitalGainEvents: CapGainEvent[];
  dividendsPaid: CorpDividendPaid[];
  salaryPaid: Decimal;                  // T4 box 14 from corp to owner
  carryforwards: CorpCarryforwards;
  /**
   * P11b: Associated-group AAII total. When present, used in place of per-corp
   * AAII for the SBD grind so all corps in an associated group share the
   * $500k SBD limit / $50k AAII threshold under s.125(5.1).
   * Injected by `computeHouseholdPlan` via `computeGroupAaii` rollup.
   */
  groupAaii?: Decimal;
  /**
   * P11b T6: GRIP designation flowing in from intercorp eligible dividends
   * received this year. Injected by `computeHouseholdPlan` from
   * `intercorpRouter`'s `CorpReceivedDivs.gripBoost`
   * (Σ eligible × ownership%/100 across received transfers). Engine adds this
   * to `gripEnding` in `buildT2`, on top of the existing growth from the corp's
   * own general-rate income.
   */
  openingGripBoost?: Decimal;
};

export type CorpTaxReturn = {
  fiscalYear: CorpFiscalYear;
  lines: TaxLine[];
  totals: {
    activeBusinessIncome: Decimal;
    sbdEligibleIncome: Decimal;   // post-AAII grind
    generalRateIncome: Decimal;
    aii: Decimal;                  // adjusted aggregate investment income
    taxableIncome: Decimal;
    federalTax: Decimal;
    provincialTax: Decimal;
    refundableTaxOnAii: Decimal;
    dividendRefund: Decimal;
    netTaxPayable: Decimal;
    gripEnding: Decimal;
    cdaEnding: Decimal;
    erdtohEnding: Decimal;
    nerdtohEnding: Decimal;
  };
  warnings: string[];
};

export type TaxYearFacts = {
  year: number;
  jurisdiction: 'CA-ON';
  employmentIncome: IncomeItem[];
  /**
   * Plan-scoped salary additions (e.g. household-plan routed ownerComp salary).
   * Unlike `employmentIncome` actuals — which buildT1 IGNORES whenever T4 slips
   * exist (slip-preference dedup) — these are always added on top of L10100.
   */
  employmentIncomeAdditions?: IncomeItem[];
  /** CPP/QPP retirement benefits (L11400). Not pensionable/insurable earnings. */
  cppBenefits?: Decimal;
  /** OAS pension (L11300). Not pensionable/insurable earnings. */
  oasBenefits?: Decimal;
  selfEmploymentIncome: IncomeItem[];
  selfEmploymentExpenses: IncomeItem[];
  interestIncome: IncomeItem[];
  eligibleDividends: IncomeItem[];
  nonEligibleDividends: IncomeItem[];
  capitalGainEvents: CapGainEvent[];
  rrspContribs: RrspContrib[];
  slips: SlipFact[];
  carryforwards: PersonalCarryforwards;
  donations: IncomeItem[];
  fhsaContribs: RrspContrib[]; // reuse shape
  disabilityCredit?: { selfEligible: boolean; transferredFromDependent?: Decimal };
  caregiverDependents?: Array<{ name: string; netIncome: Decimal; eligibleAmount: Decimal }>;
  tuitionFees?: Decimal;
  pensionIncome?: Decimal; // sum of L11500 + L11600 pension lines, before 65 vs 65+ split
  spouse?: {
    netIncome: Decimal;
  };
  /** P10: pension-split synthetic field. Stamped by override key, read by spouseRouter. */
  pensionSplit?: { transferAmount: Decimal };
  ageAtYearEnd: number;
  rentalIncome: IncomeItem[];
  rentalExpenses: IncomeItem[];
  medicalExpenses: IncomeItem[];
};

export type TaxLine = {
  code: string;
  label: string;
  amount: Decimal;
  inputs: { source: string; amount: Decimal }[];
  formula?: string;
};

export type TaxReturn = {
  year: number;
  lines: TaxLine[];
  totals: {
    totalIncome: Decimal;
    netIncome: Decimal;
    taxableIncome: Decimal;
    federalTax: Decimal;
    provincialTax: Decimal;
    cppContrib: Decimal;
    eiPremium: Decimal;
    totalPayable: Decimal;
    refundOrOwing: Decimal;
  };
  warnings: string[];
};

export type Bracket = {
  upTo: Decimal | null;
  rate: Decimal;
};

export type RateTable = {
  year: number;
  federalBrackets: Bracket[];
  provincialBrackets: Bracket[];
  basicPersonalAmountFederal: Decimal;
  bpaFederalPhaseoutStart: Decimal;
  bpaFederalPhaseoutEnd: Decimal;
  bpaFederalMin: Decimal;
  basicPersonalAmountOntario: Decimal;
  spousalAmountFederal: Decimal;
  spousalAmountOntario: Decimal;
  ageAmountFederal: Decimal;
  ageAmountOntario: Decimal;
  ageAmountAge: number;
  ageAmountFederalThreshold: Decimal;
  ageAmountOntarioThreshold: Decimal;
  ageAmountFederalClawbackRate: Decimal;
  ageAmountOntarioClawbackRate: Decimal;
  employmentAmountFederal: Decimal;
  dividendGrossUpEligible: Decimal;
  dividendGrossUpNonEligible: Decimal;
  dtcFederalEligible: Decimal;
  dtcFederalNonEligible: Decimal;
  dtcOntarioEligible: Decimal;
  dtcOntarioNonEligible: Decimal;
  cpp: {
    ympe: Decimal;
    yampe: Decimal;
    basicExemption: Decimal;
    employeeRate: Decimal;
    cpp2Rate: Decimal;
  };
  ei: {
    maxInsurable: Decimal;
    employeeRate: Decimal;
  };
  capitalGainsInclusion: Decimal;
  capitalGainsInclusionHigh?: Decimal;
  capitalGainsInclusionThreshold?: Decimal;
  onSurtaxBands?: Array<{ threshold: Decimal; rate: Decimal }>;
  ontarioHealthPremium: Array<{ upTo: Decimal | null; flat: Decimal; marginalRate: Decimal }>;
  donationLowRate: Decimal;
  donationHighRateThreshold: Decimal;
  donationHighRateFederal: Decimal;
  donationLowRateOntario: Decimal;
  donationHighRateOntario: Decimal;
  medicalThresholdPercent: Decimal;
  medicalThresholdCap: Decimal;
  rrspAnnualLimit: Decimal;
  fhsaLifetimeLimit: Decimal;
  dtcBaseFederal: Decimal;            // 2024: $9,872
  dtcSupplementFederal: Decimal;      // for under-18 dependents: $5,758 (2024)
  dtcSupplementThreshold: Decimal;    // child care exp threshold ($3,373 in 2024)
  dtcBaseOntario: Decimal;            // 2024: $9,586
  caregiverAmountFederalInfirmAdult: Decimal; // L30450 base
  caregiverThresholdFederal: Decimal;          // reduction threshold ($18,783 in 2024)
  pensionIncomeAmountCap: Decimal;             // $2,000 federal
  pensionIncomeAmountCapOntario: Decimal;      // $1,641 ON 2024
  oasClawbackThreshold: Decimal;               // $90,997 (2024)
  oasClawbackRate: Decimal;                    // 0.15
  fhsaAnnualLimit: Decimal;                    // $8,000
  amtRate: Decimal;
  amtExemption: Decimal;
  amtCapGainsInclusion: Decimal;
  amtNonRefCreditFraction: Decimal;
  amtDtcFraction: Decimal;
  sources: { name: string; url: string }[];

  // Phase 3 — Corp T2

  corpAbiSbdRateFederal: Decimal;       // 9% federal SBD rate
  corpAbiSbdRateOntario: Decimal;       // 3.2% ON SBD rate
  corpGeneralRateFederal: Decimal;      // 15% federal general
  corpGeneralRateOntario: Decimal;      // 11.5% ON general
  corpInvestmentRateFederal: Decimal;   // 38.67% federal investment (incl. refundable)
  corpInvestmentRateOntario: Decimal;   // 11.5% ON
  corpRefundableTaxOnAII: Decimal;      // 10.67% refundable portion of investment income tax
  corpSbdAnnualLimit: Decimal;          // $500,000
  corpAaiiGrindThreshold: Decimal;      // $50,000
  corpAaiiGrindRate: Decimal;           // $5 SBD lost per $1 AAII above threshold
  corpDividendRefundRate: Decimal;      // 38.33% (RDTOH refund cap per dividend $)
};

// ---------------------------------------------------------------------------
// Phase 5 — Scenario engine (owner-comp optimizer)
// ---------------------------------------------------------------------------

export type OwnerComp = {
  salary: Decimal;                  // gross T4 box 14 from corp to owner
  eligibleDividends: Decimal;       // gross actual eligible dividends declared
  nonEligibleDividends: Decimal;    // gross actual non-eligible dividends declared
};

export type ScenarioInput = {
  year: number;
  jurisdiction: 'CA-ON';
  // Base personal facts (employment income from non-corp sources, investment income, etc.)
  // OwnerComp.salary will be ADDED to facts.employmentIncome before T1 compute.
  personalFactsBase: Omit<TaxYearFacts, 'employmentIncome' | 'eligibleDividends' | 'nonEligibleDividends'> & {
    employmentIncomeBase: IncomeItem[];
    eligibleDividendsBase: IncomeItem[];
    nonEligibleDividendsBase: IncomeItem[];
  };
  // Base corp facts (ABI, AAII inputs).
  // OwnerComp.salary will be ADDED to corp salaryPaid (deductible expense reducing ABI).
  // OwnerComp.dividends* will be ADDED to corp dividendsPaid (eligible/non).
  corpFactsBase: CorpTaxYearFacts;
  ownerComp: OwnerComp;
};

export type ScenarioResult = {
  ownerComp: OwnerComp;
  corpReturn: CorpTaxReturn;
  personalReturn: TaxReturn;
  combinedTotals: {
    corpNetTaxPayable: Decimal;
    personalTotalPayable: Decimal;
    personalAfterTaxIncome: Decimal;  // simplified: personalReturn.totals.totalIncome - personalReturn.totals.totalPayable
    householdTotalTax: Decimal;       // corpNetTaxPayable + personalTotalPayable
    effectiveRate: Decimal;           // householdTotalTax / (ABI + investment income before any draws)
  };
};
