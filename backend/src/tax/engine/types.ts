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
  rrspAnnualLimit: Decimal;
  fhsaLifetimeLimit: Decimal;
  sources: { name: string; url: string }[];
};
