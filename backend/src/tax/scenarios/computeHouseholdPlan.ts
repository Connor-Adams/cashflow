// backend/src/tax/scenarios/computeHouseholdPlan.ts
import { Entity, HouseholdPlan, Scenario } from '../../models';
import { D } from '../util/decimal';
import { computeCorpScenario, type ComputeCorpScenarioResult } from './computeCorpScenario';
import { computeScenario, type ComputeScenarioResult } from './computeScenario';
import {
  integrationRouter,
  type OwnerCompPlan,
  type CorpReturnSummary,
  type IntegrationRouterOutput,
} from './integrationRouter';
import { resolveScenario } from './resolveScenario';
import { buildT1 } from '../engine/t1';
import { ratesFor } from '../engine/brackets';

export interface HouseholdPlanComputeResult {
  planId: number;
  corp: Array<{ scenario: Scenario; computed: ComputeCorpScenarioResult }>;
  personal: Array<{ scenario: Scenario; computed: ComputeScenarioResult }>;
  integration: IntegrationRouterOutput;
}

const OWNER_COMP_RE =
  /^ownerComp\.(\d+)\.(salary|bonus|eligibleDividend|nonEligibleDividend|capitalDividend)$/;

/**
 * Orchestrator for a HouseholdPlan: loads the plan, partitions linked scenarios
 * by entity kind, computes corp scenarios (in parallel), extracts ownerComp
 * plans from corp overrides, runs the integration router to derive per-
 * shareholder additions, then computes each personal scenario with those
 * additions injected into its facts.
 *
 * Cache behavior — intentional asymmetry vs `computeScenario` / `computeCorpScenario`:
 *  - Corp scenarios go through `computeCorpScenario`, which uses the
 *    `scenario_returns` cache keyed on (scenarioId, factsHash).
 *  - Personal scenarios with NO routed additions also use the cache via
 *    `computeScenario` (cheap, deterministic on facts).
 *  - Personal scenarios WITH routed additions skip the cache and call
 *    `buildT1` directly because the integrated facts depend on plan-wide
 *    inputs (which corp scenarios are linked + their ownerComp overrides).
 *    Caching that result would require keying on plan_id + every corp scenario
 *    in the plan; P9 may add plan-scoped caching when performance demands it.
 *    Returned `computed.cached` is always false in this branch.
 */
export async function computeHouseholdPlan(
  planId: number,
): Promise<HouseholdPlanComputeResult> {
  const plan = await HouseholdPlan.findByPk(planId);
  if (!plan) throw new Error(`household plan id=${planId} not found`);

  const scenarios = await Scenario.findAll({ where: { householdPlanId: planId } });
  if (scenarios.length === 0) {
    return {
      planId,
      corp: [],
      personal: [],
      integration: { byShareholder: {}, warnings: [] },
    };
  }

  // Partition by entity kind. Single Entity query covers all linked scenarios.
  const entityIds = Array.from(new Set(scenarios.map((s) => s.entityId)));
  const entities = await Entity.findAll({ where: { id: entityIds } });
  const entityKindById = new Map(entities.map((e) => [e.id, e.kind]));
  const corpScenarios = scenarios.filter((s) => entityKindById.get(s.entityId) === 'corp');
  const personalScenarios = scenarios.filter(
    (s) => entityKindById.get(s.entityId) === 'personal',
  );

  // 1. Compute corp scenarios in parallel — independent of each other.
  const corp = await Promise.all(
    corpScenarios.map(async (s) => ({
      scenario: s,
      computed: await computeCorpScenario(s.id),
    })),
  );

  // 2. Extract ownerComp plans + corp summaries for the router. Walk each
  //    corp scenario's overrides, parse ownerComp.<id>.<field> keys, group
  //    by shareholderId into OwnerCompPlan rows. Pull gripEnding / cdaEnding
  //    out of the computed totals for the GRIP / CDA cap warnings.
  const ownerCompPlans: OwnerCompPlan[] = [];
  const corpReturns: CorpReturnSummary[] = [];
  for (const { scenario, computed } of corp) {
    const overrides = scenario.overrides as Record<string, unknown>;
    const totals = computed.totals as Record<string, unknown>;
    corpReturns.push({
      corpScenarioId: scenario.id,
      gripEnding: D(String(totals.gripEnding ?? '0')),
      cdaEnding: D(String(totals.cdaEnding ?? '0')),
      // Engine doesn't expose retained earnings as a totals field; router doesn't
      // enforce against it for v1. Placeholder D('0') is intentional — flagged in
      // the plan's "risks / out of scope" section.
      retainedEarningsAfter: D('0'),
    });

    const byShareholder: Record<string, Record<string, number>> = {};
    for (const [k, v] of Object.entries(overrides)) {
      const m = k.match(OWNER_COMP_RE);
      if (!m) continue;
      const shareholderId = m[1];
      const field = m[2];
      const numericValue = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(numericValue)) continue;
      byShareholder[shareholderId] = {
        ...(byShareholder[shareholderId] ?? {}),
        [field]: numericValue,
      };
    }
    for (const [shareholderId, fields] of Object.entries(byShareholder)) {
      ownerCompPlans.push({
        corpScenarioId: scenario.id,
        shareholderEntityId: Number(shareholderId),
        salary: D(String(fields.salary ?? '0')),
        bonus: D(String(fields.bonus ?? '0')),
        eligibleDividend: D(String(fields.eligibleDividend ?? '0')),
        nonEligibleDividend: D(String(fields.nonEligibleDividend ?? '0')),
        capitalDividend: D(String(fields.capitalDividend ?? '0')),
      });
    }
  }

  const integration = integrationRouter({ corpReturns, ownerCompPlans });

  // 3. Compute personal scenarios. If the integration router emitted additions
  //    for this entity, inject them as IncomeItems and run buildT1 directly
  //    (skipping the scenario_returns cache — see header comment). Otherwise
  //    fall back to the standard cache path via computeScenario.
  const personal: Array<{ scenario: Scenario; computed: ComputeScenarioResult }> = [];
  for (const ps of personalScenarios) {
    const additions = integration.byShareholder[ps.entityId];
    if (!additions) {
      personal.push({ scenario: ps, computed: await computeScenario(ps.id) });
      continue;
    }

    const baseFacts = await resolveScenario(ps.id);
    const factsPlus = { ...baseFacts };
    if (additions.employmentIncome.greaterThan(0)) {
      factsPlus.employmentIncome = [
        ...factsPlus.employmentIncome,
        {
          source: 'integration:routed-salary',
          amount: additions.employmentIncome,
          cadAmount: additions.employmentIncome,
        },
      ];
    }
    if (additions.eligibleDividends.greaterThan(0)) {
      factsPlus.eligibleDividends = [
        ...factsPlus.eligibleDividends,
        {
          source: 'integration:routed-eligible-div',
          amount: additions.eligibleDividends,
          cadAmount: additions.eligibleDividends,
        },
      ];
    }
    if (additions.nonEligibleDividends.greaterThan(0)) {
      factsPlus.nonEligibleDividends = [
        ...factsPlus.nonEligibleDividends,
        {
          source: 'integration:routed-non-eligible-div',
          amount: additions.nonEligibleDividends,
          cadAmount: additions.nonEligibleDividends,
        },
      ];
    }
    // Note: capitalDividendsReceived are tax-free pass-through — surface on the
    // integration output but do not inject into T1 (no taxable line).

    const engineReturn = buildT1(factsPlus, ratesFor(ps.year));
    personal.push({
      scenario: ps,
      computed: {
        scenarioId: ps.id,
        // Sentinel hash — integrated result is plan-scoped, not cached.
        factsHash: 'household-integrated',
        computedAt: new Date().toISOString(),
        lines: JSON.parse(JSON.stringify(engineReturn.lines)) as unknown[],
        totals: JSON.parse(JSON.stringify(engineReturn.totals)) as Record<string, unknown>,
        warnings: engineReturn.warnings,
        cached: false,
      },
    });
  }

  return { planId, corp, personal, integration };
}
