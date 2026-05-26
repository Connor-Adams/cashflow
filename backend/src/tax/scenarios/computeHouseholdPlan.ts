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
  type PersonalAdditions,
} from './integrationRouter';
import {
  intercorpRouter,
  type CorpReceivedDivs,
  type IntercorpDistribution,
  type IntercorpRouterOutput,
} from './intercorpRouter';
import { resolveCorpScenario } from './resolveCorpScenario';
import { resolveScenario } from './resolveScenario';
import { buildT1 } from '../engine/t1';
import { buildT2 } from '../engine/t2';
import { ratesFor } from '../engine/brackets';
import type { CorpTaxYearFacts } from '../engine/types';

export interface HouseholdPlanComputeResult {
  planId: number;
  corp: Array<{ scenario: Scenario; computed: ComputeCorpScenarioResult }>;
  personal: Array<{ scenario: Scenario; computed: ComputeScenarioResult }>;
  intercorp: IntercorpRouterOutput;
  integration: IntegrationRouterOutput;
}

const OWNER_COMP_RE =
  /^ownerComp\.(\d+)\.(salary|bonus|eligibleDividend|nonEligibleDividend|capitalDividend)$/;
const INTERCORP_RE = /^intercorp\.(\d+)\.(eligible|nonEligible|capital)$/;

type CorpResult = { scenario: Scenario; computed: ComputeCorpScenarioResult };
type PersonalResult = { scenario: Scenario; computed: ComputeScenarioResult };

// Walk a corp scenario's overrides, parse intercorp.<receiverId>.<field>
// keys, return one IntercorpDistribution per receiver. Mirrors
// `ownerCompPlansForCorp` for consistency.
function intercorpDistributionsForCorp(
  scenario: Scenario,
  payerCorpEntityId: number,
  overrides: Record<string, unknown>,
): IntercorpDistribution[] {
  const byReceiver: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(overrides)) {
    const m = k.match(INTERCORP_RE);
    if (!m) continue;
    const receiverId = m[1];
    const field = m[2];
    const numericValue = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(numericValue)) continue;
    byReceiver[receiverId] = {
      ...(byReceiver[receiverId] ?? {}),
      [field]: numericValue,
    };
  }
  return Object.entries(byReceiver).map(([receiverId, fields]) => ({
    payerCorpScenarioId: scenario.id,
    payerCorpEntityId,
    receiverCorpEntityId: Number(receiverId),
    eligible: D(String(fields.eligible ?? '0')),
    nonEligible: D(String(fields.nonEligible ?? '0')),
    capital: D(String(fields.capital ?? '0')),
  }));
}

// Walk a corp scenario's overrides, parse ownerComp.<shareholderId>.<field>
// keys, return one OwnerCompPlan per shareholder. Caller folds them across
// every corp in the plan before handing to the integration router.
function ownerCompPlansForCorp(
  scenario: Scenario,
  overrides: Record<string, unknown>,
): OwnerCompPlan[] {
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
  return Object.entries(byShareholder).map(([shareholderId, fields]) => ({
    corpScenarioId: scenario.id,
    shareholderEntityId: Number(shareholderId),
    salary: D(String(fields.salary ?? '0')),
    bonus: D(String(fields.bonus ?? '0')),
    eligibleDividend: D(String(fields.eligibleDividend ?? '0')),
    nonEligibleDividend: D(String(fields.nonEligibleDividend ?? '0')),
    capitalDividend: D(String(fields.capitalDividend ?? '0')),
  }));
}

// Build the router inputs by walking computed corp results: one
// CorpReturnSummary per corp (for GRIP / CDA caps) and N OwnerCompPlan rows.
function buildRouterInputs(corp: CorpResult[]): {
  ownerCompPlans: OwnerCompPlan[];
  corpReturns: CorpReturnSummary[];
} {
  const ownerCompPlans: OwnerCompPlan[] = [];
  const corpReturns: CorpReturnSummary[] = [];
  for (const { scenario, computed } of corp) {
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
    ownerCompPlans.push(
      ...ownerCompPlansForCorp(scenario, scenario.overrides as Record<string, unknown>),
    );
  }
  return { ownerCompPlans, corpReturns };
}

// Merge an `IncomeItem`-shaped row into one of the personal facts arrays. The
// router emits a single per-source aggregate per addition kind, so we append
// at most one row per call.
async function buildIntegratedPersonalFacts(
  scenario: Scenario,
  additions: PersonalAdditions,
): Promise<Awaited<ReturnType<typeof resolveScenario>>> {
  const baseFacts = await resolveScenario(scenario.id);
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
  return factsPlus;
}

// Personal scenarios with routed additions skip the scenario_returns cache —
// see file-level cache-behavior note. Build T1 directly with the integrated
// facts and synthesize a ComputeScenarioResult around the engine output.
async function computeIntegratedPersonal(
  scenario: Scenario,
  additions: PersonalAdditions,
): Promise<ComputeScenarioResult> {
  const factsPlus = await buildIntegratedPersonalFacts(scenario, additions);
  const engineReturn = buildT1(factsPlus, ratesFor(scenario.year));
  return {
    scenarioId: scenario.id,
    // Sentinel hash — integrated result is plan-scoped, not cached.
    factsHash: 'household-integrated',
    computedAt: new Date().toISOString(),
    lines: JSON.parse(JSON.stringify(engineReturn.lines)) as unknown[],
    totals: JSON.parse(JSON.stringify(engineReturn.totals)) as Record<string, unknown>,
    warnings: engineReturn.warnings,
    cached: false,
  };
}

// Inject intercorpRouter-emitted received-dividend IncomeItems into a corp's
// resolved investmentIncome facts. Capital divs are tax-free pass-through —
// surfaced on `intercorp` output but not added to taxable investment income.
function buildIntercorpCorpFacts(
  baseFacts: CorpTaxYearFacts,
  received: CorpReceivedDivs,
): CorpTaxYearFacts {
  return {
    ...baseFacts,
    investmentIncome: {
      ...baseFacts.investmentIncome,
      eligibleDividends: [
        ...baseFacts.investmentIncome.eligibleDividends,
        ...received.eligibleDividends,
      ],
      nonEligibleDividends: [
        ...baseFacts.investmentIncome.nonEligibleDividends,
        ...received.nonEligibleDividends,
      ],
    },
  };
}

// Corp scenarios that receive intercorp dividends skip the scenario_returns
// cache (same rationale as the personal-integration path — facts depend on
// plan-wide state). Build T2 directly with the merged facts and synthesize a
// ComputeCorpScenarioResult around the engine output.
function computeIntercorpReceiverCorp(
  scenario: Scenario,
  baseFacts: CorpTaxYearFacts,
  received: CorpReceivedDivs,
): ComputeCorpScenarioResult {
  const factsPlus = buildIntercorpCorpFacts(baseFacts, received);
  const engineReturn = buildT2(
    factsPlus,
    ratesFor(Number(factsPlus.fiscalYear.startDate.slice(0, 4))),
  );
  return {
    scenarioId: scenario.id,
    // Sentinel hash — intercorp-integrated result is plan-scoped, not cached.
    factsHash: 'household-intercorp',
    computedAt: new Date().toISOString(),
    lines: JSON.parse(JSON.stringify(engineReturn.lines)) as unknown[],
    totals: JSON.parse(JSON.stringify(engineReturn.totals)) as Record<string, unknown>,
    warnings: engineReturn.warnings,
    cached: false,
  };
}

/**
 * Orchestrator for a HouseholdPlan: loads the plan, partitions linked scenarios
 * by entity kind, runs the intercorp router (cross-corp dividend flow), then
 * computes corp scenarios (corps receiving routed divs build T2 directly with
 * the injected received-div facts; others use the cached path), extracts
 * ownerComp plans from corp overrides, runs the integration router to derive
 * per-shareholder additions, then computes each personal scenario with those
 * additions injected into its facts.
 *
 * Cache behavior — intentional asymmetry vs `computeScenario` / `computeCorpScenario`:
 *  - Corp scenarios that DON'T receive routed intercorp divs go through
 *    `computeCorpScenario`, which uses the `scenario_returns` cache keyed on
 *    (scenarioId, factsHash).
 *  - Corp scenarios that DO receive routed intercorp divs skip the cache and
 *    call `buildT2` directly — the merged facts depend on plan-wide state
 *    (which other corps are linked + their `intercorp.*` overrides) so the
 *    facts hash wouldn't capture it. `computed.cached` is always false; the
 *    `factsHash` sentinel is `'household-intercorp'`.
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
      intercorp: { byReceiverEntityId: {}, warnings: [] },
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

  // 1. Pre-resolve every corp scenario's facts. The intercorp router needs
  //    access to each payer's resolved `intercorp.*` overrides (parsed from
  //    scenario.overrides directly — the overrides map is the source of truth
  //    for distributions, not the resolved facts). We also reuse these
  //    baseFacts when building T2 for receivers, avoiding a re-resolve.
  const corpBaseFactsByScenarioId = new Map<number, CorpTaxYearFacts>();
  await Promise.all(
    corpScenarios.map(async (s) => {
      corpBaseFactsByScenarioId.set(s.id, await resolveCorpScenario(s.id));
    }),
  );

  // 2. Run the intercorp router to emit per-receiver-corp received-div
  //    additions + warnings (receiver-not-in-plan / self-loop). Build the
  //    distribution list by walking each payer corp scenario's overrides for
  //    intercorp.<receiverId>.<field> keys.
  const corpEntityIdsInPlan = new Set<number>(corpScenarios.map((s) => s.entityId));
  const distributions: IntercorpDistribution[] = [];
  for (const s of corpScenarios) {
    distributions.push(
      ...intercorpDistributionsForCorp(
        s,
        s.entityId,
        s.overrides as Record<string, unknown>,
      ),
    );
  }
  const intercorp = intercorpRouter({ distributions, corpEntityIdsInPlan });

  // 3. Compute corp scenarios. Receivers of routed intercorp divs build T2
  //    directly with the merged facts (cache-skipping path). Non-receivers
  //    use the cached `computeCorpScenario` path.
  const corp = await Promise.all(
    corpScenarios.map<Promise<CorpResult>>(async (s) => {
      const received = intercorp.byReceiverEntityId[s.entityId];
      if (received) {
        const baseFacts = corpBaseFactsByScenarioId.get(s.id)!;
        return {
          scenario: s,
          computed: computeIntercorpReceiverCorp(s, baseFacts, received),
        };
      }
      return {
        scenario: s,
        computed: await computeCorpScenario(s.id),
      };
    }),
  );

  // 4. Run the integration router over the corp outputs to derive per-
  //    shareholder additions + GRIP / CDA cap warnings.
  const integration = integrationRouter(buildRouterInputs(corp));

  // 5. Compute personal scenarios. If the integration router emitted additions
  //    for this entity, inject them as IncomeItems and run buildT1 directly
  //    (skipping the scenario_returns cache — see header comment). Otherwise
  //    fall back to the standard cache path via computeScenario.
  const personal: PersonalResult[] = [];
  for (const ps of personalScenarios) {
    const additions = integration.byShareholder[ps.entityId];
    if (!additions) {
      personal.push({ scenario: ps, computed: await computeScenario(ps.id) });
      continue;
    }
    personal.push({
      scenario: ps,
      computed: await computeIntegratedPersonal(ps, additions),
    });
  }

  return { planId, corp, personal, intercorp, integration };
}
