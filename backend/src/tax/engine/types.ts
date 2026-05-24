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
  selfEmploymentIncome: IncomeItem[];
  selfEmploymentExpenses: IncomeItem[];
  interestIncome: IncomeItem[];
  eligibleDividends: IncomeItem[];
  nonEligibleDividends: IncomeItem[];
  capitalGainEvents: CapGainEvent[];
  rrspContribs: RrspContrib[];
  slips: SlipFact[];
  carryforwards: PersonalCarryforwards;
  spouse?: {
    netIncome: Decimal;
  };
  ageAtYearEnd: number;
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
  onSurtaxBands?: Array<{ threshold: Decimal; rate: Decimal }>;
  ontarioHealthPremium: Array<{ upTo: Decimal | null; flat: Decimal; marginalRate: Decimal }>;
  donationLowRate: Decimal;
  donationHighRateThreshold: Decimal;
  donationHighRateFederal: Decimal;
  donationLowRateOntario: Decimal;
  donationHighRateOntario: Decimal;
  medicalThresholdPercent: Decimal;
  medicalThresholdCap: Decimal;
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
