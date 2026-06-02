import { useState } from 'react';
import { patchJson } from '@/lib/api';
import { TaxTreatmentSelect } from '../../components/TaxTreatmentSelect';
import { CORP_OPTIONS, PAYROLL_OPTIONS, type TaxTreatment } from '../../lib/taxTreatment';
import type { QueueLeg } from '../../hooks/useClassificationQueue';
import { fmtCurrency } from './util/format';

interface ClassifiedRowProps {
  targetId: number;
  kind: 'corp' | 'payroll';
  primary: QueueLeg;
  counter?: QueueLeg;
  onChanged: () => void;
}

export function ClassifiedRow({ targetId, kind, primary, counter, onChanged }: ClassifiedRowProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = kind === 'corp' ? CORP_OPTIONS : PAYROLL_OPTIONS;

  async function choose(next: TaxTreatment | null) {
    setError(null);
    setBusy(true);
    try {
      // Reuses the both-legs-correct endpoint: for a linked transfer pair this
      // atomically sets BOTH legs; `null` clears both. targetId is the personal
      // leg for corp pairs, the income txn for payroll.
      await patchJson(`/api/transfers/${targetId}/tax-treatment`, { taxTreatmentOverride: next });
      onChanged();
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
        value={primary.taxTreatmentOverride}
        options={options}
        onChange={choose}
        emptyLabel="Clear (unclassify)"
        aria-label={`treatment for txn ${targetId}`}
      />
      {busy && <span className="muted text-xs">Saving…</span>}
      {error && <span className="error text-xs" role="alert">{error}</span>}
    </li>
  );
}
