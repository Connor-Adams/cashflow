// backend/src/tax/scenarios/types.ts
import type { TaxYearFacts } from '../engine/types';

export type ScenarioKind = 'baseline' | 'fork' | 'projection_root';

/** Sparse map of override key → raw JSON-serialisable value. */
export type OverrideMap = Record<string, unknown>;

export type AssumptionsMap = Record<string, unknown>;

/** Mutator: receives the current facts struct, returns a new one with the override applied. */
export type OverrideApplier = (facts: TaxYearFacts, value: unknown) => TaxYearFacts;

/** Registry entry describing one valid override key. */
export interface OverrideKeyDef {
  /** Which entity kind this override applies to. Personal scenarios reject corp keys and vice versa. */
  kind: 'personal' | 'corp';
  /** Dotted key, e.g. "income.employment". */
  key: string;
  /** Human-readable label for UI. */
  label: string;
  /** Runtime check that `value` matches expected shape; throws on mismatch. */
  validate: (value: unknown) => void;
  /** Applies the override to a facts struct. Pure: returns new facts, does not mutate. */
  apply: OverrideApplier;
  /** Optional UI input hint for the editor (number, decimal, array, etc.). */
  inputType: 'decimal' | 'integer' | 'array_capgain_dispositions';
}
