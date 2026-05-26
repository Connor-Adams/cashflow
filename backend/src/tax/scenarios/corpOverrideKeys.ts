// backend/src/tax/scenarios/corpOverrideKeys.ts
import { D } from '../util/decimal';
import { registerOverrideKeys } from './overrideKeys';
import type { OverrideKeyDef } from './types';
import type { CorpTaxYearFacts, IncomeItem, CorpDividendPaid } from '../engine/types';

function assertNumber(value: unknown, key: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key}: expected a finite number, got ${typeof value}`);
  }
}

function singletonIncome(source: string, amount: number): IncomeItem {
  const cad = D(String(amount));
  return { source, amount: cad, cadAmount: cad };
}

function replaceActiveIncome(label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    const corp = facts as unknown as CorpTaxYearFacts;
    return { ...corp, activeBusinessIncome: [singletonIncome(`override:${label}`, value)] } as unknown as typeof facts;
  };
}

function replaceInterest(label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    const corp = facts as unknown as CorpTaxYearFacts;
    return {
      ...corp,
      investmentIncome: { ...corp.investmentIncome, interest: [singletonIncome(`override:${label}`, value)] },
    } as unknown as typeof facts;
  };
}

function appendDividendPaid(kind: 'eligible' | 'non_eligible', label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    const corp = facts as unknown as CorpTaxYearFacts;
    const item: CorpDividendPaid = {
      source: `override:${label}`,
      date: corp.fiscalYear.endDate,
      amount: D(String(value)),
      kind,
    };
    return { ...corp, dividendsPaid: [...corp.dividendsPaid, item] } as unknown as typeof facts;
  };
}

const corpKeys: OverrideKeyDef[] = [
  {
    kind: 'corp',
    key: 'corp.activeIncome',
    label: 'Active business income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.activeIncome'),
    apply: replaceActiveIncome('corp.activeIncome'),
  },
  {
    kind: 'corp',
    key: 'corp.passiveInvestmentIncome',
    label: 'Passive investment income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.passiveInvestmentIncome'),
    apply: replaceInterest('corp.passiveInvestmentIncome'),
  },
  {
    kind: 'corp',
    key: 'corp.aaiiTrailing',
    label: 'AAII trailing (for SBD grind)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.aaiiTrailing'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.aaiiTrailing');
      const corp = facts as unknown as CorpTaxYearFacts;
      // Carryforwards do not currently expose aaii. Pass through via a synthetic field — engine should
      // consume corp.aaiiTrailing if present, otherwise compute from prior years. P8a relies on the
      // engine ignoring the field for now; P8b's integration math will read it. Document as a known gap.
      return { ...(corp as unknown as { aaiiTrailing?: ReturnType<typeof D> }), aaiiTrailing: D(String(value)) } as unknown as typeof facts;
    },
  },
  {
    kind: 'corp',
    key: 'corp.dividendsPaidEligible',
    label: 'Eligible dividends paid (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.dividendsPaidEligible'),
    apply: appendDividendPaid('eligible', 'corp.dividendsPaidEligible'),
  },
  {
    kind: 'corp',
    key: 'corp.dividendsPaidNonEligible',
    label: 'Non-eligible dividends paid (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.dividendsPaidNonEligible'),
    apply: appendDividendPaid('non_eligible', 'corp.dividendsPaidNonEligible'),
  },
  {
    kind: 'corp',
    key: 'corp.salaryPaid',
    label: 'Total T4 salary paid (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.salaryPaid'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.salaryPaid');
      const corp = facts as unknown as CorpTaxYearFacts;
      return { ...corp, salaryPaid: D(String(value)) } as unknown as typeof facts;
    },
  },
  {
    kind: 'corp',
    key: 'corp.openingGrip',
    label: 'Opening GRIP (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.openingGrip'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.openingGrip');
      const corp = facts as unknown as CorpTaxYearFacts;
      return {
        ...corp,
        carryforwards: { ...corp.carryforwards, grip: D(String(value)) },
      } as unknown as typeof facts;
    },
  },
  {
    kind: 'corp',
    key: 'corp.openingCda',
    label: 'Opening CDA (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'corp.openingCda'),
    apply: (facts, value) => {
      assertNumber(value, 'corp.openingCda');
      const corp = facts as unknown as CorpTaxYearFacts;
      return {
        ...corp,
        carryforwards: { ...corp.carryforwards, cda: D(String(value)) },
      } as unknown as typeof facts;
    },
  },
];

registerOverrideKeys(corpKeys);
