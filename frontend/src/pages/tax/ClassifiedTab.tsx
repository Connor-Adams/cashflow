import { useTaxEntities } from '../../hooks/useTaxEntities';
import { useClassificationQueue } from '../../hooks/useClassificationQueue';
import { ClassifiedRow } from './ClassifiedRow';

export function ClassifiedTab({ year }: { year: number }) {
  const { entities, error: entitiesError } = useTaxEntities();
  const personalEntity = entities?.find((e) => e.kind === 'personal') ?? null;
  const { data, error, loading, reload } = useClassificationQueue(
    personalEntity?.id ?? null,
    year,
    'classified',
  );

  if (entitiesError) return <p className="error">Failed to load entities: {entitiesError}</p>;
  if (!personalEntity && entities !== null) return <p className="muted">No personal entity for this household.</p>;
  if (loading || data === null) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">Failed to load classified income: {error}</p>;

  const corp = data.corpDistributions;
  const payroll = data.payroll;
  const nothing = corp.length === 0 && payroll.length === 0;

  return (
    <div>
      <h2>Classified income — {year}</h2>
      {nothing && <p className="muted">No classified income for {year}.</p>}

      {corp.length > 0 && (
        <section>
          <h3>Corp → personal · {corp.length}</h3>
          <ul className="flex flex-col divide-y divide-[var(--border)]">
            {corp.map((d) => (
              <ClassifiedRow
                key={d.personal.id}
                targetId={d.personal.id}
                kind="corp"
                primary={d.personal}
                counter={d.corp}
                onChanged={reload}
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
              <ClassifiedRow key={p.id} targetId={p.id} kind="payroll" primary={p} onChanged={reload} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
