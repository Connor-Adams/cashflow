// frontend/src/pages/tax/scenarios/HouseholdPlanPicker.tsx
//
// HouseholdPlan picker (P8b Task 8). Single-row chip-style picker that lets the
// user select an active plan, create a new one, rename, or delete the active
// plan. State is fully controlled — the parent owns `activePlanId` and is
// notified via `onChange`. Mutations go through `useHouseholdPlans` (T7).
//
// UX choices (per the plan):
//  - New plan prompts for a name; on success the new plan becomes active.
//  - Rename + Delete are only rendered when a plan is active.
//  - Rename uses window.prompt; Delete confirms via window.confirm. Good enough
//    for v1; future iterations can swap in a modal if the rough edges bite.
//  - On delete, we clear activePlanId so the parent doesn't dangle a stale id.
import { useHouseholdPlans } from '@/hooks/useHouseholdPlans';

interface Props {
  activePlanId: number | null;
  onChange: (planId: number | null) => void;
}

export function HouseholdPlanPicker({ activePlanId, onChange }: Props) {
  const { plans, loading, error, create, patch, remove } = useHouseholdPlans();

  const activePlan =
    activePlanId !== null ? plans.find((p) => p.id === activePlanId) ?? null : null;

  async function handleNewPlan() {
    const name = window.prompt('Name the new household plan:');
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed === '') return;
    try {
      const plan = await create({ name: trimmed });
      onChange(plan.id);
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  }

  async function handleRename() {
    if (activePlan === null) return;
    const next = window.prompt('Rename plan:', activePlan.name);
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === activePlan.name) return;
    try {
      await patch(activePlan.id, { name: trimmed });
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  }

  async function handleDelete() {
    if (activePlan === null) return;
    if (!window.confirm(`Delete household plan "${activePlan.name}"?`)) return;
    try {
      await remove(activePlan.id);
      onChange(null);
    } catch (err: unknown) {
      alert((err as Error).message);
    }
  }

  function handleSelectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    onChange(value === '' ? null : Number(value));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="household-plan-picker">
        <strong>Household plan:</strong>
      </label>
      <select
        id="household-plan-picker"
        value={activePlanId ?? ''}
        onChange={handleSelectChange}
        disabled={loading}
      >
        <option value="">— None —</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button onClick={handleNewPlan} disabled={loading}>
        + New
      </button>
      {activePlan !== null && (
        <>
          <button onClick={handleRename}>Rename</button>
          <button onClick={handleDelete}>Delete</button>
        </>
      )}
      {loading && <span className="muted">Loading…</span>}
      {error && <span className="error">Failed to load plans: {error}</span>}
    </div>
  );
}
