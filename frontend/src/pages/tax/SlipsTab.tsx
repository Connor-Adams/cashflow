import { useState } from 'react';
import { useTaxSlips, type SlipDto } from '../../hooks/useTaxSlips';
import { useTaxEntities } from '../../hooks/useTaxEntities';

const SLIP_TYPES: SlipDto['slipType'][] = ['T4', 'T5', 'T3', 'T4A', 'T5008'];

export function SlipsTab({ year }: { year: number }) {
  const { entities } = useTaxEntities();
  const { slips, create, error } = useTaxSlips(year);
  const personal = entities?.find((e) => e.kind === 'personal');
  const [form, setForm] = useState({ slipType: 'T4' as SlipDto['slipType'], issuer: '', boxValues: '{}' });
  if (!personal) return <p className="muted">No personal entity. Seed one first.</p>;
  return (
    <div>
      <h2>Tax slips ({year})</h2>
      <ul>
        {slips.map((s) => (
          <li key={s.id}>
            {s.slipType} — {s.issuer} — {JSON.stringify(s.boxValues)}
          </li>
        ))}
      </ul>
      <form onSubmit={async (e) => {
        e.preventDefault();
        let parsed: Record<string, number | string>;
        try { parsed = JSON.parse(form.boxValues); }
        catch { alert('boxValues must be valid JSON'); return; }
        await create({
          entityId: personal.id,
          year,
          slipType: form.slipType,
          issuer: form.issuer,
          boxValues: parsed,
        });
        setForm({ slipType: 'T4', issuer: '', boxValues: '{}' });
      }}>
        <label>Type
          <select value={form.slipType} onChange={(e) => setForm({ ...form, slipType: e.target.value as SlipDto['slipType'] })}>
            {SLIP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>Issuer <input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} /></label>
        <label>Box values (JSON) <textarea value={form.boxValues} onChange={(e) => setForm({ ...form, boxValues: e.target.value })} /></label>
        <button type="submit">Add slip</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
