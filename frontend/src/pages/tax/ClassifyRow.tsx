import { useState } from 'react';
import { patchJson } from '@/lib/api';
import { TaxTreatmentSelect } from '../../components/TaxTreatmentSelect';
import type { TaxTreatment } from '../../lib/taxTreatment';
import type { QueueLeg } from '../../hooks/useClassificationQueue';
import { fmtCurrency } from './util/format';

const CORP_OPTIONS: TaxTreatment[] = [
  'eligible_dividend',
  'non_eligible_dividend',
  'salary',
  'loan_advance',
  'loan_repayment',
  'not_income',
];
const PAYROLL_OPTIONS: TaxTreatment[] = ['employment_income', 'not_income'];

interface ClassifyRowProps {
  targetId: number;
  kind: 'corp' | 'payroll';
  primary: QueueLeg;
  counter?: QueueLeg;
  onClassified: (targetId: number, treatment: TaxTreatment) => void;
}

export function ClassifyRow({ targetId, kind, primary, counter, onClassified }: ClassifyRowProps) {
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
