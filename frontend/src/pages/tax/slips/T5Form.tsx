import type { SlipFormProps } from './types';

const FIELDS: { key: string; label: string }[] = [
  { key: 'box10', label: 'Box 10 — Actual amount of dividends (non-eligible)' },
  { key: 'box11', label: 'Box 11 — Taxable amount of dividends (non-eligible)' },
  { key: 'box12', label: 'Box 12 — Federal dividend tax credit (non-eligible)' },
  { key: 'box13', label: 'Box 13 — Interest from Canadian sources' },
  { key: 'box18', label: 'Box 18 — Capital gains dividends' },
  { key: 'box24', label: 'Box 24 — Actual amount of eligible dividends' },
  { key: 'box25', label: 'Box 25 — Taxable amount of eligible dividends' },
  { key: 'box26', label: 'Box 26 — Federal dividend tax credit (eligible)' },
];

export function T5Form({ issuer, onChange, values }: SlipFormProps) {
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
      <legend>T5 boxes</legend>
      {FIELDS.map(({ key, label }) => (
        <label key={key} style={{ display: 'block' }}>
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
