// frontend/src/pages/tax/OwnerCompPlannerTab.tsx
//
// Thin wrapper around `OwnerCompLeverSurface` (P8b Task 10). The legacy single-
// shot scenario form has been removed in favour of the household-plan-driven
// slider UI. The wrapper's job is to:
//
//   1. Receive the active `planId` from `TaxPage` (lifted state — TaxPage is
//      the single source of truth so `OverviewTab`'s picker and this tab stay
//      in sync without prop-drilling through a context).
//   2. Fetch the household-plan compute bundle so we can derive the corp
//      scenario id, corp entity id, fiscal year, and shareholder ids that the
//      lever surface needs.
//   3. Hand those derived values to `OwnerCompLeverSurface`.
//
// P8b limitations (documented in the plan):
//   - If a plan has multiple corp scenarios linked, we pick the FIRST one. The
//     UI surfaces a note so the user knows the others are ignored on this
//     screen. Future phases (P10/P11) need a corp picker.
//   - `shareholderEntityIds` is derived from the deduped entity ids on the
//     plan's linked personal scenarios. A personal entity with no linked
//     personal scenario won't appear, which matches the integration router's
//     model where personal scenarios are the routing target.
import { useHouseholdPlanCompute } from '../../hooks/useHouseholdPlanCompute';
import { OwnerCompLeverSurface } from './scenarios/OwnerCompLeverSurface';

interface Props {
  activePlanId: number | null;
}

function EmptyState({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2>Owner Comp</h2>
      <p className={tone}>{children}</p>
    </div>
  );
}

export function OwnerCompPlannerTab({ activePlanId }: Props) {
  const planCompute = useHouseholdPlanCompute(activePlanId);

  if (activePlanId === null) {
    return (
      <EmptyState>
        Select a household plan in the Overview tab to start tuning owner
        compensation. Each plan groups one corp + at least one personal
        scenario so the salary-vs-dividend mix can be evaluated as a single
        integrated number.
      </EmptyState>
    );
  }
  if (planCompute.error) {
    return <EmptyState tone="error">Failed to load household plan: {planCompute.error}</EmptyState>;
  }
  if (!planCompute.data) {
    return <EmptyState>Loading household plan…</EmptyState>;
  }

  const { corp, personal } = planCompute.data;

  if (corp.length === 0) {
    return (
      <EmptyState>
        This household plan has no corp scenarios linked. Add a corp scenario
        to the plan (Corp T2 tab → set its household plan) so distributions
        can be routed.
      </EmptyState>
    );
  }

  // Derive shareholder entity ids from the deduped personal scenario entity
  // ids. If the plan has no personal scenarios, the lever surface still
  // renders (it shows its own empty state) so the user can see the corp side.
  const shareholderEntityIds = Array.from(
    new Set(personal.map((p) => p.scenario.entityId)),
  );

  // P8b limitation: a plan can technically link multiple corp scenarios. The
  // lever surface targets a single corp scenario at a time. Pick the first.
  const primaryCorp = corp[0];
  const corpScenarioId = primaryCorp.scenario.id;
  const corpEntityId = primaryCorp.scenario.entityId;
  const fiscalYear = primaryCorp.scenario.year;

  return (
    <div>
      <header style={{ marginBottom: '0.75rem' }}>
        <h2>Owner Comp</h2>
        <p className="muted">
          Active corp scenario:{' '}
          <strong>{primaryCorp.scenario.name}</strong> (FY {fiscalYear}).
          {corp.length > 1 && (
            <>
              {' '}
              Plan links {corp.length} corp scenarios — showing the first.
              Multi-corp planning lands in P10/P11.
            </>
          )}
        </p>
      </header>
      <OwnerCompLeverSurface
        key={`${corpScenarioId}:${activePlanId}`}
        corpScenarioId={corpScenarioId}
        corpEntityId={corpEntityId}
        fiscalYear={fiscalYear}
        planId={activePlanId}
        shareholderEntityIds={shareholderEntityIds}
      />
    </div>
  );
}
