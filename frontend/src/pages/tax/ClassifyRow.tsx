import { useState } from 'react';
import { Checkbox } from '@connor-adams/designsystem';
import { patchJson } from '@/lib/api';
import { TaxTreatmentSelect } from '../../components/TaxTreatmentSelect';
import { CORP_OPTIONS, PAYROLL_OPTIONS, type TaxTreatment } from '../../lib/taxTreatment';
import type { QueueLeg } from '../../hooks/useClassificationQueue';
import { fmtCurrency } from './util/format';

interface ClassifyRowProps {
  targetId: number;
  kind: 'corp' | 'payroll';
  primary: QueueLeg;
  counter?: QueueLeg;
  onClassified: (targetId: number, treatment: TaxTreatment) => void;
  selected: boolean;
  onSelectedChange: (next: boolean) => void;
}

export function ClassifyRow({
  targetId,
  kind,
  primary,
  counter,
  onClassified,
  selected,
  onSelectedChange,
}: ClassifyRowProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = kind === 'corp' ? CORP_OPTIONS : PAYROLL_OPTIONS;

  async function choose(next: TaxTreatment | null) {
    if (!next) return;
    setError(null);
    setBusy(true);
    try {
      await patchJson(`/api/transfers/${targetId}/tax-treatment`, { taxTreatmentOverride: next });
      onClassified(targetId, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const flow =
    kind === 'corp' && counter
      ? `${counter.accountName ?? 'Corp'} → ${primary.accountName ?? 'Personal'}`
      : (primary.accountName ?? '');

  return (
    <li className="flex items-center gap-3 py-2">
      <Checkbox
        checked={selected}
        onCheckedChange={onSelectedChange}
        aria-label={`select txn ${targetId}`}
      />
      <span className="w-20 text-sm">{primary.date}</span>
      <span className="w-24 text-right tabular-nums text-sm font-semibold">{fmtCurrency(primary.amount)}</span>
      <span className="flex-1 text-sm">
        <span>{flow}</span>
        {primary.merchantClean && <span> · {primary.merchantClean}</span>}
      </span>
      <TaxTreatmentSelect
        value={null}
        options={options}
        onChange={choose}
        placeholder="Treatment…"
        aria-label={`treatment for txn ${targetId}`}
      />
      {busy && <span className="muted text-xs">Saving…</span>}
      {error && <span className="error text-xs" role="alert">{error}</span>}
    </li>
  );
}
