import type { SlipFormProps } from './types';


const FIELDS: { key: string; label: string }[] = [
  { key: 'box14', label: 'Box 14 — Employment income' },
  { key: 'box16', label: 'Box 16 — CPP contributions' },
  { key: 'box18', label: 'Box 18 — EI premiums' },
  { key: 'box22', label: 'Box 22 — Income tax deducted' },
  { key: 'box24', label: 'Box 24 — EI insurable earnings' },
  { key: 'box26', label: 'Box 26 — CPP pensionable earnings' },
  { key: 'box52', label: 'Box 52 — Pension adjustment (PA)' },
  { key: 'box44', label: 'Box 44 — Union dues' },
  { key: 'box46', label: 'Box 46 — Charitable donations' },
];

export function T4Form({ issuer, onChange, values }: SlipFormProps) {
  const handleField = (key: string, raw: string) => {
    const next: Record<string, number | string> = {};
    for (const f of FIELDS) {
      const existing = values?.[f.key];
      if (f.key === key) {
        if (raw !== '') next[f.key] = Number(raw);
      } else if (existing !== undefined && existing !== '') {
        next[f.key] = existing;
      }
    }
    onChange(issuer, next);
  };

  return (
    <fieldset>
      <legend>T4 boxes</legend>
      {FIELDS.map(({ key, label }) => (
        <label key={key} className="block">
          {label}
          <input
            type="number"
            value={values?.[key] ?? ''}
            onChange={(e) => handleField(key, e.target.value)}
            step="0.01"
          />
        </label>
      ))}
    </fieldset>
  );
}
