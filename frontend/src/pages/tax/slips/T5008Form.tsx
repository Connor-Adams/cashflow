import type { SlipFormProps } from './types';

type FieldDef =
  | { key: string; label: string; type: 'number' }
  | { key: string; label: string; type: 'date' }
  | { key: string; label: string; type: 'text' };

const FIELDS: FieldDef[] = [
  { key: 'box14', label: 'Box 14 — Date of settlement (YYYY-MM-DD)', type: 'date' },
  { key: 'box16', label: 'Box 16 — Quantity of securities', type: 'number' },
  { key: 'box17', label: 'Box 17 — Identification of securities', type: 'text' },
  { key: 'box20', label: 'Box 20 — Cost or book value', type: 'number' },
  { key: 'box21', label: 'Box 21 — Proceeds of disposition', type: 'number' },
];

export function T5008Form({ issuer, onChange, values }: SlipFormProps) {
  const handleField = (key: string, raw: string, fieldType: FieldDef['type']) => {
    const next: Record<string, number | string> = {};
    for (const f of FIELDS) {
      const existing = values?.[f.key];
      if (f.key === key) {
        if (raw !== '') {
          next[f.key] = fieldType === 'number' ? Number(raw) : raw;
        }
      } else if (existing !== undefined && existing !== '') {
        next[f.key] = existing;
      }
    }
    onChange(issuer, next);
  };

  return (
    <fieldset>
      <legend>T5008 boxes</legend>
      {FIELDS.map((f) => (
        <label key={f.key} className="block">
          {f.label}
          <input
            type={f.type}
            value={values?.[f.key] ?? ''}
            onChange={(e) => handleField(f.key, e.target.value, f.type)}
            {...(f.type === 'number' ? { step: '0.01' } : {})}
          />
        </label>
      ))}
    </fieldset>
  );
}
