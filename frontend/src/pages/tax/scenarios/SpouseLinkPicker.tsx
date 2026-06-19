// frontend/src/pages/tax/scenarios/SpouseLinkPicker.tsx
//
// P10 Task 6: tiny UI to manage the `spouseEntityId` self-FK on a personal
// tax entity. Lives near entity management on OverviewTab.
//
// Two visual modes driven by `entity.spouseEntityId`:
//  - null  → render `<select>` of candidate personal entities + "Link as spouse"
//  - set   → render "Spouse: <name>" + "Unlink"
//
// Parent owns the data (passes `entity` + `candidateEntities` in). After every
// successful mutation we call `onChange()` so the parent re-fetches and feeds
// us the next snapshot — keeps this component fully presentational beyond the
// in-flight request state owned by `useSetSpouseLink`.
import { useState } from 'react';
import { Button } from '@cashflow/ui';
import { useSetSpouseLink } from '@/hooks/useSetSpouseLink';

interface Props {
  entity: { id: number; legalName: string; spouseEntityId: number | null };
  candidateEntities: Array<{ id: number; legalName: string; kind: string }>;
  onChange: () => void;
}

export function SpouseLinkPicker({ entity, candidateEntities, onChange }: Props) {
  const { setSpouse, unsetSpouse, loading, error } = useSetSpouseLink(entity.id);

  // Only personal entities other than this one can be a candidate spouse.
  const candidates = candidateEntities.filter(
    (c) => c.kind === 'personal' && c.id !== entity.id,
  );

  const [pendingSpouseId, setPendingSpouseId] = useState<number | ''>(
    candidates[0]?.id ?? '',
  );

  async function handleLink() {
    if (pendingSpouseId === '') return;
    try {
      await setSpouse(pendingSpouseId);
      onChange();
    } catch {
      // hook already surfaced the message via `error`
    }
  }

  async function handleUnlink() {
    try {
      await unsetSpouse();
      onChange();
    } catch {
      // hook already surfaced the message via `error`
    }
  }

  if (entity.spouseEntityId !== null) {
    const spouse = candidateEntities.find((c) => c.id === entity.spouseEntityId);
    const spouseLabel = spouse?.legalName ?? `Entity #${entity.spouseEntityId}`;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span>
          <strong>Spouse:</strong> {spouseLabel}
        </span>
        <Button variant="ghost" size="sm" onClick={handleUnlink} disabled={loading}>
          Unlink
        </Button>
        {error && <span className="error">{error}</span>}
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="muted">
          No other personal entities available to link as spouse.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`spouse-link-picker-${entity.id}`}>
        <strong>Link spouse:</strong>
      </label>
      <select
        id={`spouse-link-picker-${entity.id}`}
        value={pendingSpouseId}
        onChange={(e) =>
          setPendingSpouseId(e.target.value === '' ? '' : Number(e.target.value))
        }
        disabled={loading}
      >
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.legalName}
          </option>
        ))}
      </select>
      <Button variant="secondary" size="sm" onClick={handleLink} disabled={loading || pendingSpouseId === ''}>
        Link as spouse
      </Button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
