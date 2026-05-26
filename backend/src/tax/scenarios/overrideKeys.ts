// backend/src/tax/scenarios/overrideKeys.ts
import { D, type Decimal } from '../util/decimal';
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
    kind: 'personal',
    key: 'income.employment',
    label: 'Employment income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.employment'),
    apply: replaceIncomeArray('employmentIncome', 'income.employment'),
  },
  {
    kind: 'personal',
    key: 'income.eligibleDividends',
    label: 'Eligible dividends (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.eligibleDividends'),
    apply: replaceIncomeArray('eligibleDividends', 'income.eligibleDividends'),
  },
  {
    kind: 'personal',
    key: 'income.nonEligibleDividends',
    label: 'Non-eligible dividends (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.nonEligibleDividends'),
    apply: replaceIncomeArray('nonEligibleDividends', 'income.nonEligibleDividends'),
  },
  {
    kind: 'personal',
    key: 'income.interest',
    label: 'Interest income (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.interest'),
    apply: replaceIncomeArray('interestIncome', 'income.interest'),
  },
  {
    kind: 'personal',
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
    kind: 'personal',
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
    kind: 'personal',
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
    kind: 'personal',
    key: 'deductions.spousalRrspContrib',
    label: 'Spousal RRSP contribution (CAD, contributor side)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'deductions.spousalRrspContrib'),
    apply: (facts, value) => {
      assertNumber(value, 'deductions.spousalRrspContrib');
      // Same engine treatment as regular RRSP contribution.
      // Source tagged so reconciliation can surface the spousal flag separately.
      return {
        ...facts,
        rrspContribs: [
          ...facts.rrspContribs,
          { source: 'override:deductions.spousalRrspContrib', amount: D(String(value)), date: '' },
        ],
      };
    },
  },
  {
    kind: 'personal',
    key: 'income.pensionIncome',
    label: 'Pension income (RRIF, employer pension, etc.) — CAD',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.pensionIncome'),
    apply: (facts, value) => {
      assertNumber(value, 'income.pensionIncome');
      const d = D(String(value));
      return {
        ...facts,
        pensionIncome: (facts.pensionIncome ?? D('0')).plus(d),
        employmentIncome: [
          ...facts.employmentIncome,
          { source: 'override:income.pensionIncome', amount: d, cadAmount: d },
        ],
      };
    },
  },
  {
    kind: 'personal',
    key: 'income.cppRetirement',
    label: 'CPP retirement benefit — CAD',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.cppRetirement'),
    apply: (facts, value) => {
      assertNumber(value, 'income.cppRetirement');
      const d = D(String(value));
      return {
        ...facts,
        employmentIncome: [
          ...facts.employmentIncome,
          { source: 'override:income.cppRetirement', amount: d, cadAmount: d },
        ],
      };
    },
  },
  {
    kind: 'personal',
    key: 'income.oasRetirement',
    label: 'OAS retirement benefit — CAD',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'income.oasRetirement'),
    apply: (facts, value) => {
      assertNumber(value, 'income.oasRetirement');
      const d = D(String(value));
      return {
        ...facts,
        employmentIncome: [
          ...facts.employmentIncome,
          { source: 'override:income.oasRetirement', amount: d, cadAmount: d },
        ],
      };
    },
  },
  {
    kind: 'personal',
    key: 'pensionSplit.transferAmount',
    label: 'Pension income split — amount transferred to spouse (CAD)',
    inputType: 'decimal',
    validate: (v) => assertNumber(v, 'pensionSplit.transferAmount'),
    apply: (facts, value) => {
      assertNumber(value, 'pensionSplit.transferAmount');
      // The split is realised by spouseRouter cross-entity; apply just stamps the
      // amount onto a synthetic field for the router to read.
      return {
        ...facts,
        pensionSplit: { transferAmount: D(String(value)) },
      } as unknown as typeof facts;
    },
  },
  {
    kind: 'personal',
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

/**
 * Dynamic owner-comp override key shape: `ownerComp.<shareholderEntityId>.<field>`.
 * Shareholder IDs are not known at module-load time, so these keys are matched by
 * regex in `getOverrideKey` + `validateOverrideMap` rather than statically registered.
 *
 * Apply stamps onto a structured `ownerComp` map on corp facts:
 *   corp.ownerComp[shareholderId][field] = Decimal
 *
 * The integration router (T4) reads this map to route distributions into personal additions.
 */
const OWNER_COMP_RE =
  /^ownerComp\.(\d+)\.(salary|bonus|eligibleDividend|nonEligibleDividend|capitalDividend)$/;

function ownerCompEntryFor(key: string): OverrideKeyDef | undefined {
  const m = key.match(OWNER_COMP_RE);
  if (!m) return undefined;
  const shareholderId = m[1];
  const field = m[2];
  return {
    kind: 'corp',
    key,
    label: `Owner comp - ${field} (shareholder ${shareholderId})`,
    inputType: 'decimal',
    validate: (v) => assertNumber(v, key),
    apply: (facts, value) => {
      assertNumber(value, key);
      const corp = facts as unknown as Record<string, unknown> & {
        ownerComp?: Record<string, Record<string, Decimal>>;
      };
      const existing = (corp.ownerComp ?? {}) as Record<string, Record<string, Decimal>>;
      const forShareholder: Record<string, Decimal> = { ...(existing[shareholderId] ?? {}) };
      forShareholder[field] = D(String(value));
      const next = {
        ...corp,
        ownerComp: { ...existing, [shareholderId]: forShareholder },
      };
      return next as unknown as typeof facts;
    },
  };
}

/**
 * Dynamic intercorp-distribution override key shape: `intercorp.<receiverCorpEntityId>.<field>`.
 * Receiver corp entity IDs are not known at module-load time, so these keys are matched by
 * regex in `getOverrideKey` + `validateOverrideMap` rather than statically registered.
 *
 * Apply stamps onto a structured `intercorp` map on corp facts:
 *   corp.intercorp[receiverCorpEntityId][field] = Decimal
 *
 * The intercorp router (P11a T2) reads this map to emit per-receiver-corp received-div additions.
 */
const INTERCORP_RE = /^intercorp\.(\d+)\.(eligible|nonEligible|capital|ownershipPercent)$/;

function intercorpEntryFor(key: string): OverrideKeyDef | undefined {
  const m = key.match(INTERCORP_RE);
  if (!m) return undefined;
  const receiverId = m[1];
  const field = m[2];
  const label =
    field === 'ownershipPercent'
      ? `Intercorp - ownership % -> corp ${receiverId} (0..100)`
      : `Intercorp - ${field} dividend -> corp ${receiverId} (CAD)`;
  return {
    kind: 'corp',
    key,
    label,
    inputType: 'decimal',
    validate: (v) => assertNumber(v, key),
    apply: (facts, value) => {
      assertNumber(value, key);
      const corp = facts as unknown as Record<string, unknown> & {
        intercorp?: Record<string, Record<string, Decimal>>;
      };
      const existing = (corp.intercorp ?? {}) as Record<string, Record<string, Decimal>>;
      const forReceiver: Record<string, Decimal> = { ...(existing[receiverId] ?? {}) };
      forReceiver[field] = D(String(value));
      const next = {
        ...corp,
        intercorp: { ...existing, [receiverId]: forReceiver },
      };
      return next as unknown as typeof facts;
    },
  };
}

export function getOverrideKey(key: string): OverrideKeyDef | undefined {
  return indexByKey.get(key) ?? intercorpEntryFor(key) ?? ownerCompEntryFor(key);
}

/** Returns the subset of the registry that applies to a given entity kind. */
export function getOverrideKeysForKind(kind: 'personal' | 'corp'): OverrideKeyDef[] {
  return overrideKeyRegistry.filter((k) => k.kind === kind);
}

/**
 * Validates a complete override map: rejects unknown keys, runs per-key validators,
 * and rejects cross-kind usage (personal key on corp scenario or vice versa).
 * Throws on any failure with a message identifying the offending key.
 */
export function validateOverrideMap(map: OverrideMap, kind: 'personal' | 'corp'): void {
  for (const [key, value] of Object.entries(map)) {
    const entry = getOverrideKey(key);
    if (!entry) {
      // Surface a more helpful error for ownerComp keys that *almost* match the prefix
      // but use a malformed shape — common during hand-editing of overrides.
      if (key.startsWith('ownerComp.')) {
        throw new Error(
          `invalid ownerComp key shape: ${key} (expected ownerComp.<shareholderId>.<field> where field ∈ {salary, bonus, eligibleDividend, nonEligibleDividend, capitalDividend})`,
        );
      }
      // Surface a more helpful error for intercorp keys that *almost* match the prefix
      // but use a malformed shape — common during hand-editing of overrides.
      if (key.startsWith('intercorp.')) {
        throw new Error(
          `invalid intercorp key shape: ${key} (expected intercorp.<receiverCorpEntityId>.<field> where field ∈ {eligible, nonEligible, capital, ownershipPercent})`,
        );
      }
      throw new Error(`unknown override key: ${key}`);
    }
    if (entry.kind !== kind) {
      throw new Error(`override key ${key} is for ${entry.kind} scenarios, not ${kind}`);
    }
    entry.validate(value);
  }
}

/**
 * Register additional override keys at module load time. Used by `corpOverrideKeys.ts`
 * to extend the registry without circular imports.
 */
export function registerOverrideKeys(entries: OverrideKeyDef[]): void {
  for (const e of entries) {
    if (indexByKey.has(e.key)) {
      throw new Error(`override key ${e.key} already registered`);
    }
    overrideKeyRegistry.push(e);
    indexByKey.set(e.key, e);
  }
}

// Self-register corp keys when this module loads (any consumer imports
// overrideKeys.ts, so corp keys are always present). Use require() rather than
// `import` so the call runs AFTER `indexByKey` is initialized — ES `import`
// statements get hoisted to the top of the compiled file and trigger TDZ.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./corpOverrideKeys');
