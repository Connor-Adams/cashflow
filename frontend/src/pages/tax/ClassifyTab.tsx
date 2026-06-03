import { useEffect, useState } from 'react';
import { patchJson } from '@/lib/api';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { useClassificationQueue } from '../../hooks/useClassificationQueue';
import { TREATMENT_LABELS, type TaxTreatment } from '../../lib/taxTreatment';
import { ClassifyRow } from './ClassifyRow';
import { fmtCurrency } from './util/format';

interface ClassifiedEntry {
  targetId: number;
  treatment: TaxTreatment;
  label: string;
}

export function ClassifyTab({ year }: { year: number }) {
  const { entities, error: entitiesError } = useTaxEntities();
  const personalEntity = entities?.find((e) => e.kind === 'personal') ?? null;
  const { data, error, loading, reload } = useClassificationQueue(personalEntity?.id ?? null, year);
  const [classified, setClassified] = useState<ClassifiedEntry[]>([]);
  const [undoInFlight, setUndoInFlight] = useState<Set<number>>(() => new Set());
  useEffect(() => { setClassified([]); }, [year]);

  if (entitiesError) return <p className="error">Failed to load entities: {entitiesError}</p>;
  if (!personalEntity && entities !== null) return <p className="muted">No personal entity for this household.</p>;
  if (loading || data === null) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">Failed to load queue: {error}</p>;

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

  return (
    <div>
      <h2>Classify income — {year}</h2>
      {nothing && <p className="muted">No unclassified income for {year}.</p>}

      {corp.length > 0 && (
        <section>
          <h3>Corp → personal · {corp.length}</h3>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {corp.map((d) => (
              <ClassifyRow
                key={d.personal.id}
                targetId={d.personal.id}
                kind="corp"
                primary={d.personal}
                counter={d.corp}
                onClassified={(id, t) => onClassified(id, t, `${fmtCurrency(d.personal.amount)} → ${TREATMENT_LABELS[t]}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {payroll.length > 0 && (
        <section>
          <h3>Payroll · {payroll.length}</h3>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {payroll.map((p) => (
              <ClassifyRow
                key={p.id}
                targetId={p.id}
                kind="payroll"
                primary={p}
                onClassified={(id, t) => onClassified(id, t, `${fmtCurrency(p.amount)} → ${TREATMENT_LABELS[t]}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {classified.length > 0 && (
        <section>
          <h3>Classified · {classified.length}</h3>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {classified.map((c) => (
              <li key={c.targetId} className="flex items-center gap-3 py-2">
                <span aria-hidden>✓</span>
                <span className="flex-1 text-sm">{c.label}</span>
                <button type="button" className="text-sm underline" onClick={() => void undo(c)} disabled={undoInFlight.has(c.targetId)}>
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
