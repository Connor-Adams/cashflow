// frontend/src/pages/tax/scenarios/AssumptionsEditor.tsx
//
// Assumptions editor (P9 Task 8). Rendered alongside the OverrideEditor when
// the active scenario's kind is `projection_root`. Two numeric inputs control
// the two assumption knobs currently in the schema:
//
//   - `inflation`        — uniform multiplier applied to projected income lines
//                          when building year+1 facts (see
//                          backend/src/tax/scenarios/projectPersonalFactsFromPrevYear.ts).
//   - `investmentReturn` — not yet consumed by P9's projection engine. Stored
//                          so it's already there when P12 adds retirement /
//                          lifetime modelling. The label hints at this so
//                          users aren't surprised that touching the value
//                          doesn't move any P9 numbers.
//
// Values are stored on the scenario as fractions (e.g. 0.025) but presented in
// the UI as percentages (e.g. 2.5). We multiply by 100 for display, divide by
// 100 on input, and round-trip to 6 decimal places so 2.5 -> 0.025 stays clean
// instead of drifting into 0.024999...
//
// Pure controlled component. The parent owns persistence (debounced PATCH on
// scenario.assumptions) — this editor only fires `onChange` with the next
// assumptions object on each user edit. Clearing an input removes the key from
// the assumptions object (rather than persisting `0`) so the optional shape on
// the backend is preserved.

interface Assumptions {
  inflation?: number;
  investmentReturn?: number;
}

interface Props {
  assumptions: Assumptions;
  onChange: (next: Assumptions) => void;
}

// 6 dp is enough to keep round-trip clean for the two-decimal-place percentages
// we expect in practice (2.5% -> 0.025 -> 2.5%) without accidentally truncating
// a power-user's 0.00125 figure.
function pctToFraction(pct: number): number {
  return Number((pct / 100).toFixed(6));
}

function fractionToPctDisplay(fraction: number | undefined): string {
  if (fraction === undefined) return '';
  // Strip trailing zeros and the decimal point if integer, otherwise leave the
  // user's two-decimal value alone.
  const pct = fraction * 100;
  return Number.isInteger(pct) ? String(pct) : String(Number(pct.toFixed(4)));
}

export function AssumptionsEditor({ assumptions, onChange }: Props) {
  function setField(key: keyof Assumptions, raw: string) {
    const next: Assumptions = { ...assumptions };
    if (raw === '') {
      delete next[key];
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      next[key] = pctToFraction(parsed);
    }
    onChange(next);
  }

  return (
    <section className="rounded-md border bg-card p-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Assumptions</h3>
      <div className="flex flex-col gap-2">
        <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <span className="min-w-[10rem]">Inflation (%)</span>
          <input
            type="number"
            step="0.1"
            value={fractionToPctDisplay(assumptions.inflation)}
            onChange={(e) => setField('inflation', e.target.value)}
            placeholder="0"
            className="w-24 rounded border px-2 py-1 text-sm focus:border-ring focus:outline-none"
          />
          <span className="text-xs text-muted-foreground">
            Applied uniformly to projected income lines for year+1.
          </span>
        </label>

        <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <span className="min-w-[10rem]">Investment return (%)</span>
          <input
            type="number"
            step="0.1"
            value={fractionToPctDisplay(assumptions.investmentReturn)}
            onChange={(e) => setField('investmentReturn', e.target.value)}
            placeholder="0"
            className="w-24 rounded border px-2 py-1 text-sm focus:border-ring focus:outline-none"
          />
          <span className="text-xs text-muted-foreground">
            Stored for future retirement modelling; not yet applied to projections.
          </span>
        </label>
      </div>
    </section>
  );
}
