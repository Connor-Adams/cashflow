import { useState } from 'react';

interface KeyDef {
  key: string;
  label: string;
  inputType: 'decimal' | 'integer';
}

// Mirror of backend corp override registry (backend/src/tax/scenarios/corpOverrideKeys.ts,
// introduced in P8a T2 / commit a397ba7). Backend <-> frontend sync is manual for v1 —
// P8b will move both registries to `shared/`. When a new corp override key is added to
// the backend registry, add the matching entry here.
const KEY_DEFS: KeyDef[] = [
  { key: 'corp.activeIncome', label: 'Active business income (CAD)', inputType: 'decimal' },
  { key: 'corp.passiveInvestmentIncome', label: 'Passive investment income (CAD)', inputType: 'decimal' },
  { key: 'corp.aaiiTrailing', label: 'AAII trailing (for SBD grind)', inputType: 'decimal' },
  { key: 'corp.dividendsPaidEligible', label: 'Eligible dividends paid (CAD)', inputType: 'decimal' },
  { key: 'corp.dividendsPaidNonEligible', label: 'Non-eligible dividends paid (CAD)', inputType: 'decimal' },
  { key: 'corp.salaryPaid', label: 'Total T4 salary paid (CAD)', inputType: 'decimal' },
  { key: 'corp.openingGrip', label: 'Opening GRIP (CAD)', inputType: 'decimal' },
  { key: 'corp.openingCda', label: 'Opening CDA (CAD)', inputType: 'decimal' },
];

interface Props {
  overrides: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function CorpOverrideEditor({ overrides, onChange }: Props) {
  const [pendingKey, setPendingKey] = useState<string>(KEY_DEFS[0].key);
  const present = Object.keys(overrides);
  const available = KEY_DEFS.filter((d) => !present.includes(d.key));

  function setValue(key: string, value: unknown) {
    onChange({ ...overrides, [key]: value });
  }
  function removeKey(key: string) {
    const next = { ...overrides };
    delete next[key];
    onChange(next);
  }
  function addKey() {
    const def = KEY_DEFS.find((d) => d.key === pendingKey);
    if (!def) return;
    setValue(def.key, 0);
  }

  return (
    <section>
      <h3>Overrides ({present.length})</h3>
      {present.length === 0 ? (
        <p className="muted">No overrides — using actuals.</p>
      ) : (
        <ul>
          {present.map((k) => {
            const def = KEY_DEFS.find((d) => d.key === k);
            const v = overrides[k];
            return (
              <li key={k} style={{ marginBottom: '0.5rem' }}>
                <strong>{def?.label ?? k}</strong>{' '}
                <input
                  type="number"
                  step="0.01"
                  value={typeof v === 'number' ? v : 0}
                  onChange={(e) => setValue(k, Number(e.target.value))}
                />
                <button onClick={() => removeKey(k)} style={{ marginLeft: '0.5rem' }}>×</button>
              </li>
            );
          })}
        </ul>
      )}
      {available.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <select value={pendingKey} onChange={(e) => setPendingKey(e.target.value)}>
            {available.map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </select>
          <button onClick={addKey} style={{ marginLeft: '0.5rem' }}>+ Add override</button>
        </div>
      )}
    </section>
  );
}
