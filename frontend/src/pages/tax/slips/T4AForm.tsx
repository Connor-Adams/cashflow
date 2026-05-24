import type { SlipFormProps } from './types';

const FIELDS: { key: string; label: string }[] = [
  { key: 'box016', label: 'Box 016 — Pension or superannuation' },
  { key: 'box020', label: 'Box 020 — Self-employed commissions' },
  { key: 'box022', label: 'Box 022 — Income tax deducted' },
  { key: 'box048', label: 'Box 048 — Fees for services' },
];

export function T4AForm({ issuer, onChange, values }: SlipFormProps) {
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
      <legend>T4A boxes</legend>
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
