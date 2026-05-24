import type { SlipFormProps } from './types';

const FIELDS: { key: string; label: string }[] = [
  { key: 'box21', label: 'Box 21 — Capital gains' },
  { key: 'box23', label: 'Box 23 — Actual amount of dividends from Canadian corps' },
  { key: 'box26', label: 'Box 26 — Other income' },
  { key: 'box32', label: 'Box 32 — Eligible dividends actual' },
  { key: 'box49', label: 'Box 49 — Eligible dividends taxable' },
  { key: 'box50', label: 'Box 50 — Eligible div tax credit' },
];

export function T3Form({ issuer, onChange, values }: SlipFormProps) {
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
      <legend>T3 boxes</legend>
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
