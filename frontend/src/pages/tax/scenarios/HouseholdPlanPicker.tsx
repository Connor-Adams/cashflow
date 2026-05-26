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

type Plan = { id: number; name: string };

interface Props {
  activePlanId: number | null;
  onChange: (planId: number | null) => void;
}

// Validate-and-trim a window.prompt response. Returns null when the user
// cancelled, entered whitespace only, or entered the same value they were
// editing. Lets the callers stay branch-free.
function readPromptName(message: string, current: string | null = null): string | null {
  const raw = window.prompt(message, current ?? undefined);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (current !== null && trimmed === current) return null;
  return trimmed;
}

function reportError(err: unknown): void {
  alert((err as Error).message);
}

export function HouseholdPlanPicker({ activePlanId, onChange }: Props) {
  const { plans, loading, error, create, patch, remove } = useHouseholdPlans();

  const activePlan: Plan | null =
    activePlanId !== null ? plans.find((p) => p.id === activePlanId) ?? null : null;

  async function handleNewPlan() {
    const name = readPromptName('Name the new household plan:');
    if (name === null) return;
    try {
      const plan = await create({ name });
      onChange(plan.id);
    } catch (err: unknown) {
      reportError(err);
    }
  }

  async function handleRename() {
    if (activePlan === null) return;
    const next = readPromptName('Rename plan:', activePlan.name);
    if (next === null) return;
    try {
      await patch(activePlan.id, { name: next });
    } catch (err: unknown) {
      reportError(err);
    }
  }

  async function handleDelete() {
    if (activePlan === null) return;
    if (!window.confirm(`Delete household plan "${activePlan.name}"?`)) return;
    try {
      await remove(activePlan.id);
      onChange(null);
    } catch (err: unknown) {
      reportError(err);
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
      <PlanSelect
        plans={plans}
        activePlanId={activePlanId}
        disabled={loading}
        onChange={handleSelectChange}
      />
      <button onClick={handleNewPlan} disabled={loading}>
        + New
      </button>
      {activePlan !== null && (
        <PlanActions onRename={handleRename} onDelete={handleDelete} />
      )}
      {loading && <span className="muted">Loading…</span>}
      {error && <span className="error">Failed to load plans: {error}</span>}
    </div>
  );
}

interface PlanSelectProps {
  plans: Plan[];
  activePlanId: number | null;
  disabled: boolean;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}

function PlanSelect({ plans, activePlanId, disabled, onChange }: PlanSelectProps) {
  return (
    <select
      id="household-plan-picker"
      value={activePlanId ?? ''}
      onChange={onChange}
      disabled={disabled}
    >
      <option value="">— None —</option>
      {plans.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

interface PlanActionsProps {
  onRename: () => void;
  onDelete: () => void;
}

function PlanActions({ onRename, onDelete }: PlanActionsProps) {
  return (
    <>
      <button onClick={onRename}>Rename</button>
      <button onClick={onDelete}>Delete</button>
    </>
  );
}
