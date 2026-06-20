import { useState } from 'react';
import { Button } from '@connor-adams/designsystem'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'
import { todayDateInputValue } from '@/lib/dateInput';

interface KeyDef {
  key: string;
  label: string;
  inputType: 'decimal' | 'integer' | 'array_capgain_dispositions';
}

// Mirror of backend `overrideKeyRegistry` (backend/src/tax/scenarios/overrideKeys.ts,
// introduced in T2 / commit d3cc45e). Backend <-> frontend sync is manual for v1 —
// P7 is small enough that the duplication is acceptable. When a new override key is
// added to the backend registry, add the matching entry here.
const KEY_DEFS: KeyDef[] = [
  { key: 'income.employment', label: 'Employment income (CAD)', inputType: 'decimal' },
  { key: 'income.eligibleDividends', label: 'Eligible dividends (CAD)', inputType: 'decimal' },
  { key: 'income.nonEligibleDividends', label: 'Non-eligible dividends (CAD)', inputType: 'decimal' },
  { key: 'income.interest', label: 'Interest income (CAD)', inputType: 'decimal' },
  { key: 'deductions.rrspContrib', label: 'RRSP contribution (CAD)', inputType: 'decimal' },
  { key: 'deductions.fhsaContrib', label: 'FHSA contribution (CAD)', inputType: 'decimal' },
  { key: 'deductions.donations', label: 'Donations (CAD)', inputType: 'decimal' },
  { key: 'deductions.spousalRrspContrib', label: 'Spousal RRSP contribution (CAD, contributor side)', inputType: 'decimal' },
  { key: 'pensionSplit.transferAmount', label: 'Pension income split — transferred to spouse (CAD)', inputType: 'decimal' },
  { key: 'capgains.dispositions', label: 'Capital gain dispositions', inputType: 'array_capgain_dispositions' },
  { key: 'income.pensionIncome', label: 'Pension income (RRIF / employer) — CAD', inputType: 'decimal' },
  { key: 'income.cppRetirement', label: 'CPP retirement benefit — CAD', inputType: 'decimal' },
  { key: 'income.oasRetirement', label: 'OAS retirement benefit — CAD', inputType: 'decimal' },
];

interface Disposition {
  proceeds: number;
  acb: number;
  date: string;
}

interface Props {
  overrides: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function OverrideEditor({ overrides, onChange }: Props) {
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
    if (def.inputType === 'array_capgain_dispositions') {
      setValue(def.key, []);
    } else {
      setValue(def.key, 0);
    }
  }

  return (
    <section>
      <h3>Overrides ({present.length})</h3>
      {present.length === 0 ? (
        <p className="muted">No overrides — using actuals.</p>
      ) : (
        <ul className="m-0 list-none p-0 space-y-2">
          {present.map((k) => {
            const def = KEY_DEFS.find((d) => d.key === k);
            const v = overrides[k];
            return (
              <li key={k}>
                <strong>{def?.label ?? k}</strong>{' '}
                {def?.inputType === 'array_capgain_dispositions' ? (
                  <DispositionArrayEditor
                    value={(v as Disposition[]) ?? []}
                    onChange={(next) => setValue(k, next)}
                  />
                ) : (
                  <input
                    type="number"
                    step="0.01"
                    value={typeof v === 'number' ? v : 0}
                    onChange={(e) => setValue(k, Number(e.target.value))}
                  />
                )}
                <Button variant="ghost" size="sm" onClick={() => removeKey(k)} className="ml-2">×</Button>
              </li>
            );
          })}
        </ul>
      )}
      {available.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <select value={pendingKey} onChange={(e) => setPendingKey(e.target.value)}>
            {available.map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </select>
          <Button variant="secondary" size="sm" onClick={addKey}>+ Add override</Button>
        </div>
      )}
    </section>
  );
}

function DispositionArrayEditor({ value, onChange }: {
  value: Disposition[];
  onChange: (next: Disposition[]) => void;
}) {
  function setRow(i: number, patch: Partial<Disposition>) {
    const next = value.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  }
  function addRow() {
    onChange([...value, { proceeds: 0, acb: 0, date: todayDateInputValue() }]);
  }
  function removeRow(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  return (
    <div className="mt-2 inline-block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Proceeds</TableHead>
            <TableHead>ACB</TableHead>
            <TableHead>Date</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {value.map((row, i) => (
            <TableRow key={i}>
              <TableCell>
                <input
                  type="number"
                  step="0.01"
                  value={row.proceeds}
                  onChange={(e) => setRow(i, { proceeds: Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <input
                  type="number"
                  step="0.01"
                  value={row.acb}
                  onChange={(e) => setRow(i, { acb: Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <input
                  type="date"
                  value={row.date}
                  onChange={(e) => setRow(i, { date: e.target.value })}
                />
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="sm" onClick={() => removeRow(i)}>×</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-1 text-xs text-muted-foreground">
        {value.length > 0
          ? `${value.length} disposition${value.length === 1 ? '' : 's'} · gain = proceeds − ACB for each row`
          : null}
      </p>
      <Button variant="secondary" size="sm" onClick={addRow}>+ Add disposition</Button>
    </div>
  );
}
