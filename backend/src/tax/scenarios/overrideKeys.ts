// backend/src/tax/scenarios/overrideKeys.ts
import { D } from '../util/decimal';
import type { CapGainEvent, IncomeItem, RrspContrib, TaxYearFacts } from '../engine/types';
import type { OverrideKeyDef, OverrideMap } from './types';

function assertNumber(value: unknown, key: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key}: expected a finite number, got ${typeof value}`);
  }
}

function singletonIncome(source: string, amount: number): IncomeItem {
  const cad = D(String(amount));
  return { source, amount: cad, cadAmount: cad };
}

function replaceIncomeArray(arrayName: keyof Pick<
  TaxYearFacts,
  'employmentIncome' | 'eligibleDividends' | 'nonEligibleDividends' | 'interestIncome'
>, label: string): OverrideKeyDef['apply'] {
  return (facts, value) => {
    assertNumber(value, label);
    return { ...facts, [arrayName]: [singletonIncome(`override:${label}`, value)] };
  };
}

function singletonRrsp(source: string, amount: number): RrspContrib {
  return { source, amount: D(String(amount)), date: '' };
}

export const overrideKeyRegistry: OverrideKeyDef[] = [
  {
    key: 'income.employment',
    label: 'Employment income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.employment'),
    apply: replaceIncomeArray('employmentIncome', 'income.employment'),
  },
  {
    key: 'income.eligibleDividends',
    label: 'Eligible dividends (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.eligibleDividends'),
    apply: replaceIncomeArray('eligibleDividends', 'income.eligibleDividends'),
  },
  {
    key: 'income.nonEligibleDividends',
    label: 'Non-eligible dividends (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.nonEligibleDividends'),
    apply: replaceIncomeArray('nonEligibleDividends', 'income.nonEligibleDividends'),
  },
  {
    key: 'income.interest',
    label: 'Interest income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.interest'),
    apply: replaceIncomeArray('interestIncome', 'income.interest'),
  },
  {
    key: 'deductions.rrspContrib',
    label: 'RRSP contribution (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'deductions.rrspContrib'),
    apply: (facts, value) => {
      assertNumber(value, 'deductions.rrspContrib');
      return { ...facts, rrspContribs: [singletonRrsp('override:deductions.rrspContrib', value)] };
    },
  },
  {
    key: 'deductions.fhsaContrib',
    label: 'FHSA contribution (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'deductions.fhsaContrib'),
    apply: (facts, value) => {
      assertNumber(value, 'deductions.fhsaContrib');
      return { ...facts, fhsaContribs: [singletonRrsp('override:deductions.fhsaContrib', value)] };
    },
  },
  {
    key: 'deductions.donations',
    label: 'Donations (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'deductions.donations'),
    apply: (facts, value) => {
      assertNumber(value, 'deductions.donations');
      return { ...facts, donations: [singletonIncome('override:deductions.donations', value)] };
    },
  },
  {
    key: 'capgains.dispositions',
    label: 'Capital gain dispositions',
    inputType: 'array_capgain_dispositions',
    validate: (v) => {
      if (!Array.isArray(v)) throw new Error('capgains.dispositions: expected array');
      for (const d of v) {
        if (typeof d !== 'object' || d === null) throw new Error('capgains.dispositions: each item must be object');
        const row = d as Record<string, unknown>;
        assertNumber(row.proceeds, 'capgains.dispositions[].proceeds');
        assertNumber(row.acb, 'capgains.dispositions[].acb');
        if (typeof row.date !== 'string') throw new Error('capgains.dispositions[].date: expected string');
      }
    },
    apply: (facts, value) => {
      const events: CapGainEvent[] = (value as Array<{ proceeds: number; acb: number; date: string }>).map(
        (row, i) => ({
          source: `override:capgains.dispositions[${i}]`,
          securityId: null as unknown as number, // overrides bypass security linkage
          proceeds: D(String(row.proceeds)),
          acb: D(String(row.acb)),
          outlays: D('0'),
          date: row.date,
        }),
      );
      return { ...facts, capitalGainEvents: [...facts.capitalGainEvents, ...events] };
    },
  },
];

const indexByKey = new Map(overrideKeyRegistry.map((k) => [k.key, k]));

export function getOverrideKey(key: string): OverrideKeyDef | undefined {
  return indexByKey.get(key);
}

/**
 * Validates a complete override map: rejects unknown keys, runs per-key validators.
 * Throws on any failure with a message identifying the offending key.
 */
export function validateOverrideMap(map: OverrideMap): void {
  for (const [key, value] of Object.entries(map)) {
    const entry = indexByKey.get(key);
    if (!entry) throw new Error(`unknown override key: ${key}`);
    entry.validate(value);
  }
}
