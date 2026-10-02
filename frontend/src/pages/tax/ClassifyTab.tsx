import { useCallback, useEffect, useState } from 'react';
import { Button } from '@connor-adams/designsystem'
import { patchJson } from '@/lib/api';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { useClassificationQueue, type QueueLeg } from '../../hooks/useClassificationQueue';
import { CORP_OPTIONS, PAYROLL_OPTIONS, TREATMENT_LABELS, type TaxTreatment } from '../../lib/taxTreatment';
import { BulkClassifyBar } from './BulkClassifyBar';
import { ClassifyRow } from './ClassifyRow';
import { fmtCurrency } from './util/format';

interface ClassifiedEntry {
  targetId: number;
  treatment: TaxTreatment;
  label: string;
}

/**
 * Selection state for one queue section. Kept per-section because the valid
 * treatments differ (a corp draw can never be employment income), so one
 * cross-section selection would have no coherent treatment list to apply.
 */
function useSelection(resetKey: unknown) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  // A different year is a different queue, so a carried-over selection would
  // apply a treatment to rows the user can no longer see.
  useEffect(() => { setSelected(new Set()); }, [resetKey]);
  const toggle = useCallback((id: number, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const setAll = useCallback((ids: number[], on: boolean) => {
    setSelected(on ? new Set(ids) : new Set());
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  return { selected, toggle, setAll, clear };
}

export function ClassifyTab({ year }: { year: number }) {
  const { entities, error: entitiesError } = useTaxEntities();
  const personalEntity = entities?.find((e) => e.kind === 'personal') ?? null;
  const { data, error, loading, reload } = useClassificationQueue(personalEntity?.id ?? null, year);
  const [classified, setClassified] = useState<ClassifiedEntry[]>([]);
  const [undoInFlight, setUndoInFlight] = useState<Set<number>>(() => new Set());
  const corpSel = useSelection(year);
  const payrollSel = useSelection(year);
  useEffect(() => { setClassified([]); }, [year]);

  if (entitiesError) return <p className="error">Failed to load entities: {entitiesError}</p>;
  if (!personalEntity && entities !== null) return <p className="muted">No personal entity for this household.</p>;
  // Error before loading: a failed fetch leaves data null, which read as loading forever.
  if (error) return <p className="error">Failed to load queue: {error}</p>;
  if (loading || data === null) return <p className="muted">Loading…</p>;

  function onClassified(targetId: number, treatment: TaxTreatment, label: string) {
    setClassified((prev) => [{ targetId, treatment, label }, ...prev]);
  }
  async function undo(entry: ClassifiedEntry) {
    if (undoInFlight.has(entry.targetId)) return;
    setUndoInFlight((prev) => new Set(prev).add(entry.targetId));
    try {
      await patchJson(`/api/transfers/${entry.targetId}/tax-treatment`, { taxTreatmentOverride: null });
      setClassified((prev) => prev.filter((c) => c.targetId !== entry.targetId));
      reload();
    } finally {
      setUndoInFlight((prev) => {
        const next = new Set(prev);
        next.delete(entry.targetId);
        return next;
      });
    }
  }

  const doneIds = new Set(classified.map((c) => c.targetId));
  const corp = data.corpDistributions.filter((d) => !doneIds.has(d.personal.id));
  const payroll = data.payroll.filter((p) => !doneIds.has(p.id));
  const nothing = corp.length === 0 && payroll.length === 0 && classified.length === 0;

  const corpIds = corp.map((d) => d.personal.id);
  const payrollIds = payroll.map((p) => p.id);

  /**
   * Moves the rows the bulk endpoint just wrote into the Classified list from
   * its response. No reload(): a refetch mid-batch would re-derive the whole
   * queue and throw away the user's place in it.
   */
  function applyBulkResult(rows: QueueLeg[], targetIds: Set<number>, clear: () => void) {
    const entries: ClassifiedEntry[] = [];
    for (const row of rows) {
      if (!targetIds.has(row.id) || row.taxTreatmentOverride == null) continue;
      entries.push({
        targetId: row.id,
        treatment: row.taxTreatmentOverride,
        label: `${fmtCurrency(row.amount)} → ${TREATMENT_LABELS[row.taxTreatmentOverride]}`,
      });
    }
    if (entries.length > 0) setClassified((prev) => [...entries, ...prev]);
    clear();
  }

  return (
    <div>
      <h2>Classify income — {year}</h2>
      {nothing && <p className="muted">No unclassified income for {year}.</p>}

      {corp.length > 0 && (
        <section>
          <h3>Corp → personal · {corp.length}</h3>
          <BulkClassifyBar
            ids={corpIds}
            selected={corpIds.filter((id) => corpSel.selected.has(id))}
            options={CORP_OPTIONS}
            label="corp draws"
            onToggleAll={(on) => corpSel.setAll(corpIds, on)}
            onApplied={(rows) => applyBulkResult(rows, new Set(corpIds), corpSel.clear)}
          />
          <ul className="flex flex-col divide-y divide-border">
            {corp.map((d) => (
              <ClassifyRow
                key={d.personal.id}
                targetId={d.personal.id}
                kind="corp"
                primary={d.personal}
                counter={d.corp}
                selected={corpSel.selected.has(d.personal.id)}
                onSelectedChange={(on) => corpSel.toggle(d.personal.id, on)}
                onClassified={(id, t) => onClassified(id, t, `${fmtCurrency(d.personal.amount)} → ${TREATMENT_LABELS[t]}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {payroll.length > 0 && (
        <section>
          <h3>Payroll · {payroll.length}</h3>
          <BulkClassifyBar
            ids={payrollIds}
            selected={payrollIds.filter((id) => payrollSel.selected.has(id))}
            options={PAYROLL_OPTIONS}
            label="payroll deposits"
            onToggleAll={(on) => payrollSel.setAll(payrollIds, on)}
            onApplied={(rows) => applyBulkResult(rows, new Set(payrollIds), payrollSel.clear)}
          />
          <ul className="flex flex-col divide-y divide-border">
            {payroll.map((p) => (
              <ClassifyRow
                key={p.id}
                targetId={p.id}
                kind="payroll"
                primary={p}
                selected={payrollSel.selected.has(p.id)}
                onSelectedChange={(on) => payrollSel.toggle(p.id, on)}
                onClassified={(id, t) => onClassified(id, t, `${fmtCurrency(p.amount)} → ${TREATMENT_LABELS[t]}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {classified.length > 0 && (
        <section>
          <h3>Classified · {classified.length}</h3>
          <ul className="flex flex-col divide-y divide-border">
            {classified.map((c) => (
              <li key={c.targetId} className="flex items-center gap-3 py-2">
                <span aria-hidden>✓</span>
                <span className="flex-1 text-sm">{c.label}</span>
                <Button type="button" variant="link" size="sm" onClick={() => void undo(c)} disabled={undoInFlight.has(c.targetId)}>
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
