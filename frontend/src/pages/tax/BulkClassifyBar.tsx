import { useState } from 'react';
import { Button, Checkbox } from '@connor-adams/designsystem';
import { postJson } from '@/lib/api';
import { TaxTreatmentSelect } from '../../components/TaxTreatmentSelect';
import type { TaxTreatment } from '../../lib/taxTreatment';
import type { QueueLeg } from '../../hooks/useClassificationQueue';

interface BulkClassifyResponse {
  updated: QueueLeg[];
}

interface BulkClassifyBarProps {
  /** Every selectable target id in this section — the universe select-all covers. */
  ids: number[];
  selected: number[];
  /** Treatments valid for this section's kind (corp draws vs payroll). */
  options: TaxTreatment[];
  /** Section name, used for the accessible names of the controls. */
  label: string;
  onToggleAll: (on: boolean) => void;
  onApplied: (rows: QueueLeg[]) => void;
}

/**
 * Select-all + treatment picker + Apply for one queue section.
 *
 * Owns its own request the way ClassifyRow does, and posts the whole selection
 * in ONE call: the queue is worked in batches, and N per-row requests can
 * half-apply, leaving a corp draw tagged on the personal side only.
 */
export function BulkClassifyBar({
  ids,
  selected,
  options,
  label,
  onToggleAll,
  onApplied,
}: BulkClassifyBarProps) {
  const [treatment, setTreatment] = useState<TaxTreatment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = ids.length > 0 && selected.length === ids.length;
  const someSelected = selected.length > 0 && !allSelected;

  async function apply() {
    if (selected.length === 0 || treatment === null || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await postJson<BulkClassifyResponse>('/api/tax/classification-queue/bulk', {
        ids: selected,
        taxTreatmentOverride: treatment,
      });
      onApplied(res.updated ?? []);
      setTreatment(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <Checkbox
        checked={allSelected}
        indeterminate={someSelected}
        onCheckedChange={onToggleAll}
        aria-label={`select all ${label}`}
      />
      <span className="text-sm">
        {selected.length > 0 ? `${selected.length} selected` : 'Select rows to classify together'}
      </span>
      <TaxTreatmentSelect
        value={treatment}
        options={options}
        onChange={setTreatment}
        placeholder="Treatment…"
        aria-label={`bulk treatment for ${label}`}
      />
      <Button
        type="button"
        size="sm"
        onClick={() => void apply()}
        disabled={busy || selected.length === 0 || treatment === null}
      >
        {busy ? 'Applying…' : `Apply to ${selected.length}`}
      </Button>
      {error && (
        <span className="error text-xs" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
