// frontend/src/pages/tax/scenarios/RrifMinCalc.tsx
//
// P12 Task 3 helper widget. Pure reference calculator: user types age + RRIF
// balance, we display the CRA prescribed minimum withdrawal percentage and the
// dollar amount. Result is informational only — the user copies it into an
// `income.pensionIncome` override on the relevant projection year.
//
// The percentage table mirrors `backend/src/tax/engine/rrif.ts` (T1 commit
// 0706355). Duplicating the table on the frontend keeps this a leaf component
// with no extra round-trip; the table is small (24 rows + flat 95+) and the
// CRA schedule is stable across years. If/when the table needs to live in one
// place, lift it to a shared `@/shared/tax/rrif.ts` and import from both
// backend and frontend.
//
// Ages < 71 → 0 (no mandatory minimum). Ages 71–94 → fixed schedule. Ages
// 95+ → 20% flat.
import { useState } from 'react';
import { fmtCurrency } from '../util/format';

const RRIF_MIN_TABLE: Readonly<Record<number, number>> = Object.freeze({
  71: 0.0528,
  72: 0.054,
  73: 0.0553,
  74: 0.0567,
  75: 0.0582,
  76: 0.0598,
  77: 0.0617,
  78: 0.0636,
  79: 0.0658,
  80: 0.0682,
  81: 0.0708,
  82: 0.0738,
  83: 0.0771,
  84: 0.0808,
  85: 0.0851,
  86: 0.0899,
  87: 0.0955,
  88: 0.1021,
  89: 0.1099,
  90: 0.1192,
  91: 0.1306,
  92: 0.1449,
  93: 0.1634,
  94: 0.1879,
});

const RRIF_MIN_95_PLUS = 0.2;

function rrifMinPercent(age: number): number {
  if (!Number.isFinite(age)) return 0;
  if (age < 71) return 0;
  if (age >= 95) return RRIF_MIN_95_PLUS;
  const pct = RRIF_MIN_TABLE[Math.floor(age)];
  return pct ?? 0;
}

export function RrifMinCalc() {
  const [age, setAge] = useState<number>(71);
  const [balance, setBalance] = useState<number>(0);

  const pct = rrifMinPercent(age);
  const withdrawal = balance * pct;
  const isMandatory = age >= 71;

  return (
    <div className="rounded-md border bg-card p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Reference only. Type the age you will attain in the projection year and
        the RRIF balance on Jan 1 of that year. Use the result to size your
        <code className="mx-1 rounded bg-muted px-1 text-xs">income.pensionIncome</code>
        override.
      </p>
      <div className="flex flex-col gap-2">
        <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <span className="min-w-[10rem]">Age in year</span>
          <input
            type="number"
            min="0"
            step="1"
            value={Number.isFinite(age) ? age : ''}
            onChange={(e) => setAge(Number(e.target.value))}
            className="w-24 rounded border px-2 py-1 text-sm focus:border-ring focus:outline-none"
          />
        </label>
        <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <span className="min-w-[10rem]">RRIF balance (CAD)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={Number.isFinite(balance) ? balance : ''}
            onChange={(e) => setBalance(Number(e.target.value))}
            className="w-32 rounded border px-2 py-1 text-sm focus:border-ring focus:outline-none"
          />
        </label>
      </div>
      <dl className="mt-3 grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
        <dt className="text-muted-foreground">Minimum %</dt>
        <dd className="font-medium text-foreground">
          {(pct * 100).toFixed(2)}%
          {!isMandatory && (
            <span className="ml-2 text-xs text-muted-foreground">
              (no mandatory minimum below age 71)
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Minimum withdrawal</dt>
        <dd className="font-medium text-foreground">
          {fmtCurrency(withdrawal)}
        </dd>
      </dl>
    </div>
  );
}
