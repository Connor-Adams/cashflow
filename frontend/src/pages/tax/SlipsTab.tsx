import { useState } from 'react';
import { Button } from '@connor-adams/designsystem'
import { useTaxSlips, type SlipDto } from '../../hooks/useTaxSlips';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { SLIP_FORMS, slipPreview } from './slips/registry';

const SLIP_TYPES: SlipDto['slipType'][] = ['T4', 'T5', 'T3', 'T4A', 'T5008'];

type FormState = {
  slipType: SlipDto['slipType'];
  issuer: string;
  boxValues: Record<string, number | string>;
};

export function SlipsTab({ year }: { year: number }) {
  const { entities } = useTaxEntities();
  const { slips, create, error } = useTaxSlips(year);
  const personal = entities?.find((e) => e.kind === 'personal');

  const [form, setForm] = useState<FormState>({
    slipType: 'T4',
    issuer: '',
    boxValues: {},
  });

  if (!personal) return <p className="muted">No personal entity. Seed one first.</p>;

  const SlipForm = SLIP_FORMS[form.slipType];

  const handleBoxChange = (issuer: string, boxValues: Record<string, number | string>) => {
    setForm((prev) => ({ ...prev, issuer, boxValues }));
  };

  const handleIssuerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, issuer: e.target.value }));
  };

  const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setForm({
      slipType: e.target.value as SlipDto['slipType'],
      issuer: '',
      boxValues: {},
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await create({
      entityId: personal.id,
      year,
      slipType: form.slipType,
      issuer: form.issuer,
      boxValues: form.boxValues,
    });
    setForm({ slipType: 'T4', issuer: '', boxValues: {} });
  };

  return (
    <div>
      <h2>Tax slips ({year})</h2>
      <ul>
        {slips.map((s) => {
          const preview = slipPreview(s.slipType, s.boxValues);
          return (
            <li key={s.id}>
              <strong>{s.slipType}</strong> — {s.issuer}
              {preview && <span className="muted"> — {preview}</span>}
            </li>
          );
        })}
      </ul>
      <form onSubmit={handleSubmit}>
        <label>
          Type
          <select value={form.slipType} onChange={handleTypeChange}>
            {SLIP_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Issuer
          <input value={form.issuer} onChange={handleIssuerChange} />
        </label>
        <SlipForm
          issuer={form.issuer}
          onChange={handleBoxChange}
          values={form.boxValues}
        />
        <Button type="submit">Add slip</Button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
